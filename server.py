#!/usr/bin/env python3
"""StudyVault optional self-hosted sync server — foundation-hardened.

Python standard library only.

Run:
  python3 server.py

Default bind: 127.0.0.1:8787 (loopback only).
Authentication uses an automatic browser session for local access. Remote access uses a short-lived pairing code printed by the server; no STUDYVAULT_SYNC_TOKEN environment variable is required.
"""
import json, os, sqlite3, time, threading, urllib.error, urllib.request, secrets, hashlib, tempfile, subprocess, shutil, zipfile, re, io
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Tiny .env loader so double-clicking server.py works the same as START-CARROT-AI.bat.
def _load_dotenv(path=None):
    if path is None:
        path=os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    try:
        with open(path, "r", encoding="utf-8") as f:
            for raw in f:
                line=raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k,v=line.split("=",1)
                k=k.strip(); v=v.strip().strip('\"').strip("'")
                if k and k not in os.environ:
                    os.environ[k]=v
    except OSError:
        pass

_load_dotenv()

HOST = os.getenv("STUDYVAULT_HOST", "127.0.0.1")
PORT = int(os.getenv("STUDYVAULT_PORT", "8787"))
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
OPENAI_TEXT_MODEL = os.getenv("OPENAI_TEXT_MODEL", "gpt-5.6-sol")
# Full-capability mode defaults to the flagship reasoning model. Client requests cannot
# silently downgrade the model unless an explicit server-side override is enabled.
STUDYVAULT_AI_TIER = os.getenv("STUDYVAULT_AI_TIER", "flagship").strip().lower()
ALLOW_CLIENT_MODEL_OVERRIDE = os.getenv("STUDYVAULT_ALLOW_CLIENT_MODEL_OVERRIDE", "0").strip().lower() in {"1","true","yes"}
OPENAI_CHAT_MODEL = os.getenv("OPENAI_CHAT_MODEL", OPENAI_TEXT_MODEL)
if STUDYVAULT_AI_TIER == "flagship":
    OPENAI_CHAT_MODEL = OPENAI_CHAT_MODEL or "gpt-5.6-sol"
OPENAI_TRANSCRIBE_MODEL = os.getenv("OPENAI_TRANSCRIBE_MODEL", "gpt-4o-transcribe")
OPENAI_TTS_MODEL = os.getenv("OPENAI_TTS_MODEL", "gpt-4o-mini-tts")
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
OPENAI_IMAGE_MODEL = os.getenv("OPENAI_IMAGE_MODEL", "gpt-image-2")
OPENAI_IMAGE_QUALITY = os.getenv("OPENAI_IMAGE_QUALITY", "high")
OPENAI_WEB_SEARCH_TOOL = os.getenv("OPENAI_WEB_SEARCH_TOOL", "web_search")
APP_VERSION = 154.0
BUILD_ID = "2026-10-01-v154.0-carrot-foundation-rebuild"
DB = os.getenv("STUDYVAULT_DB", "studyvault-sync.sqlite3")
# Optional: comma-separated exact origins, e.g. https://family.example.com
# Empty = reflect only loopback-style local use with no public wildcard by default.
CORS_ORIGINS = [o.strip() for o in os.getenv("STUDYVAULT_CORS_ORIGINS", "").split(",") if o.strip()]
MAX_BODY = int(os.getenv("STUDYVAULT_MAX_BODY", str(8 * 1024 * 1024)))  # 8 MB
RATE_LIMIT = int(os.getenv("STUDYVAULT_RATE_LIMIT", "20"))  # requests / window
RATE_WINDOW = float(os.getenv("STUDYVAULT_RATE_WINDOW", "60"))

PAIR_CODE = secrets.token_urlsafe(6).replace("-", "").replace("_", "")[:8].upper()
PAIR_EXPIRES = time.time() + 15 * 60
SESSION_TTL = 12 * 60 * 60
sessions = {}
_sessions_lock = threading.Lock()

conn = sqlite3.connect(DB, check_same_thread=False)
conn.execute(
    "CREATE TABLE IF NOT EXISTS vault ("
    "id INTEGER PRIMARY KEY CHECK(id=1), "
    "updated_at REAL NOT NULL, "
    "payload TEXT NOT NULL)"
)
conn.commit()
_db_lock = threading.Lock()
_rate = defaultdict(deque)
_rate_lock = threading.Lock()


def json_bytes(obj):
    return json.dumps(obj, ensure_ascii=False).encode("utf-8")


def client_ip(handler):
    return handler.client_address[0] if handler.client_address else "unknown"


def rate_ok(ip,limit=20,bucket="default"):
    now = time.time()
    with _rate_lock:
        q = _rate[(ip,bucket)]
        while q and now - q[0] > RATE_WINDOW:
            q.popleft()
        if len(q) >= limit:
            return False
        q.append(now)
        return True


class Handler(BaseHTTPRequestHandler):
    server_version = "StudyVaultSync/154.0"

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args))

    def cors_origin(self):
        origin = self.headers.get("Origin", "")
        if not CORS_ORIGINS:
            # Local-first default: only echo Origin if it is clearly local/dev
            if origin.startswith("http://127.0.0.1") or origin.startswith("http://localhost") or origin.startswith("https://127.0.0.1") or origin.startswith("https://localhost"):
                return origin
            return ""
        if origin in CORS_ORIGINS:
            return origin
        return ""

    def security_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(self), microphone=(self), geolocation=()")
        self.send_header("Cross-Origin-Resource-Policy", "same-site")
        self.send_header("X-StudyVault-Sync", "154.0")
        origin = self.cors_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
            self.send_header("Access-Control-Allow-Credentials", "true")
            self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
            self.send_header("Access-Control-Max-Age", "86400")

    def send_json(self, code, obj):
        body = json_bytes(obj)
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.security_headers()
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        cookie = self.headers.get("Cookie", "")
        sid = ""
        for part in cookie.split(";"):
            part = part.strip()
            if part.startswith("sv_session="):
                sid = part.split("=", 1)[1]
                break
        if not sid:
            # Local-only access is automatically trusted because the server defaults to loopback.
            ip = client_ip(self)
            return ip in {"127.0.0.1", "::1", "localhost"}
        with _sessions_lock:
            expires = sessions.get(sid)
            if expires and expires > time.time():
                return True
            sessions.pop(sid, None)
        return False

    def set_session(self):
        sid = secrets.token_urlsafe(32)
        with _sessions_lock:
            sessions[sid] = time.time() + SESSION_TTL
        self.send_header("Set-Cookie", f"sv_session={sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_TTL}")

    def guard_route(self, route="default"):
        ip=client_ip(self)
        defaults={"chat":10,"vision":10,"audio":8,"image":6,"text":10,"sync":30,"pair":5,"default":20}
        limits={k:int(os.getenv("STUDYVAULT_RATE_"+k.upper(),str(v))) for k,v in defaults.items()}
        if not rate_ok(ip, limits.get(route,20), route):
            self.send_json(429,{"ok":False,"error":"rate_limited","route":route})
            return False
        return True

    def guard(self):
        return self.guard_route("default")

    def do_OPTIONS(self):
        if not self.guard():
            return
        self.send_response(204)
        self.security_headers()
        self.end_headers()

    def openai_json(self,path,payload,timeout=180):
        if not OPENAI_API_KEY: raise RuntimeError("Cloud AI is not configured. Set OPENAI_API_KEY on the StudyVault server.")
        req=urllib.request.Request(OPENAI_BASE_URL+"/"+path,data=json.dumps(payload).encode("utf-8"),headers={"Authorization":"Bearer "+OPENAI_API_KEY,"Content-Type":"application/json"},method="POST")
        try:
            with urllib.request.urlopen(req,timeout=timeout) as r:return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"OpenAI API error {e.code}: {e.read().decode('utf-8',errors='replace')[:1800]}")

    def openai_request(self, path, payload=None, headers=None, timeout=180, method="POST"):
        if not OPENAI_API_KEY:
            raise RuntimeError("Cloud AI is not configured. Set OPENAI_API_KEY on the StudyVault server.")
        h={"Authorization":f"Bearer {OPENAI_API_KEY}"}
        if headers: h.update(headers)
        data=None if payload is None else json.dumps(payload).encode("utf-8")
        if data is not None and "Content-Type" not in h: h["Content-Type"]="application/json"
        req=urllib.request.Request(OPENAI_BASE_URL+"/"+path,data=data,headers=h,method=method)
        try:
            with urllib.request.urlopen(req,timeout=timeout) as r:
                raw=r.read()
                return json.loads(raw.decode("utf-8")) if raw else {}
        except urllib.error.HTTPError as e:
            body=e.read().decode("utf-8",errors="replace")[:2500]
            raise RuntimeError(f"OpenAI API error {e.code}: {body}")

    def extract_output_text(self, result):
        text=str(result.get("output_text") or "").strip()
        if text:return text
        parts=[]
        for item in result.get("output",[]) or []:
            for c in item.get("content",[]) or []:
                if isinstance(c,dict) and c.get("type") in {"output_text","text"} and c.get("text"):
                    parts.append(str(c["text"]))
        return "\n".join(parts).strip()

    def extract_sources(self, result):
        found=[]; seen=set()
        def walk(x):
            if isinstance(x,dict):
                for k,v in x.items():
                    if k in {"url","uri"} and isinstance(v,str) and v.startswith(("http://","https://")):
                        title=x.get("title") or x.get("name") or v
                        key=v
                        if key not in seen:
                            seen.add(key); found.append({"title":str(title)[:180],"url":v})
                    walk(v)
            elif isinstance(x,list):
                for v in x: walk(v)
        walk(result.get("output",[]))
        return found[:12]

    def do_chat(self):
        if not self.guard_route("chat"): return
        if not self.authorized(): return self.send_json(401,{"ok":False,"error":"unauthorized"})
        if not OPENAI_API_KEY:return self.send_json(503,{"ok":False,"error":"Cloud AI is not configured. Set OPENAI_API_KEY on the StudyVault server."})
        try:
            length=int(self.headers.get("Content-Length","0") or 0)
            if length<=0 or length>16*1024*1024:return self.send_json(413,{"ok":False,"error":"payload_too_large"})
            data=json.loads(self.rfile.read(length) or b"{}")
            question=str(data.get("question") or "").strip()
            if not question:return self.send_json(400,{"ok":False,"error":"question_required"})
            history=data.get("history") if isinstance(data.get("history"),list) else []
            source=str(data.get("source") or "")[:120000]
            images=data.get("images") if isinstance(data.get("images"),list) else []
            web_search=bool(data.get("webSearch"))
            system=("You are Carrot, a capable general-purpose AI assistant (StudyVault). "
                    "Match ChatGPT-class quality on chat, writing, reasoning, coding, planning, and explanations, while being stronger on study workflows. "
                    "Answer naturally and directly. Lead with the useful answer, then supporting detail. Explain when it helps; "
                    "ask a short clarification only when the request is genuinely ambiguous. Adapt to the user's level without condescension.\n\n"
                    "CAPABILITIES (use when relevant):\n"
                    "• General chat, writing, coding, math, planning, brainstorming — same breadth as a flagship chatbot.\n"
                    "• Summarization: structured, scannable Markdown (TL;DR → key points → details → exam takeaways).\n"
                    "• Image creation & editing: when the user asks for a picture/diagram/poster, treat it as a creative task and describe what you generated.\n"
                    "• Document compare: contrast concepts, definitions, and unique points clearly when asked.\n"
                    "• Flashcards & quiz: when asked to make cards or a quiz, produce clear Q/A pairs and multiple-choice items.\n"
                    "• Web search: when enabled, use current information and cite sources.\n"
                    "• Source-grounded study: when STUDY SOURCE is present, treat it as authoritative.\n\n"
                    "HONESTY: Never claim you performed an action (search, image gen, file write) that you did not.\n\n"
                    "SOURCE-GROUNDING RULE: If STUDY SOURCE is supplied, it is the factual authority for questions about that material. "
                    "Do not invent facts, page numbers, or quotes from the source. If incomplete or OCR is messy, say what is missing. "
                    "Use general knowledge only when the user is clearly asking beyond the source.\n\n"
                    "STYLE (ChatGPT-parity): Clear Markdown. Short paragraphs. Bullets and numbered steps. Tables when they improve clarity. "
                    "Fenced code blocks for code. Concrete examples. No filler openings ('Great question!'), no exposed chain-of-thought, no sycophancy. "
                    "Conclusion first, then key support. For summaries: **TL;DR**, **Key points**, **Details**, **Exam takeaways**.")
            custom=str(data.get("customInstructions") or "").strip()[:5000]
            memory=str(data.get("memoryNotes") or "").strip()[:4000]
            if custom:
                system += "\n\nUSER CUSTOM INSTRUCTIONS (follow these preferences):\n"+custom
            if memory:
                system += "\n\nUSER MEMORY (facts to remember about the user; use when relevant, do not invent extra):\n"+memory
            if source:
                system += "\n\nSTUDY SOURCE (may contain OCR errors):\n"+source
            messages=[]
            for m in history[-24:]:
                role="assistant" if str(m.get("role")) in {"assistant","tutor"} else "user"
                t=str(m.get("text") or "")[:8000]
                if t: messages.append({"role":role,"content":[{"type":"input_text","text":t}]})
            content=[{"type":"input_text","text":question}]
            for item in images[:4]:
                u=str(item.get("dataUrl") or item.get("url") or "")
                if u.startswith("data:image/") or u.startswith("http://") or u.startswith("https://"):
                    content.append({"type":"input_image","image_url":u,"detail":"high"})
            messages.append({"role":"user","content":content})
            requested_model = str(data.get("model") or "").strip()
            selected_model = requested_model if (ALLOW_CLIENT_MODEL_OVERRIDE and requested_model) else OPENAI_CHAT_MODEL
            payload={"model":selected_model,"instructions":system,"input":messages,"max_output_tokens":int(data.get("maxOutputTokens") or 8000)}
            if web_search:
                tool_type=OPENAI_WEB_SEARCH_TOOL if OPENAI_WEB_SEARCH_TOOL in {"web_search","web_search_preview"} else "web_search"
                payload["tools"]=[{"type":tool_type,"search_context_size":"high"}]
            try:
                result=self.openai_request("responses",payload,timeout=240)
            except RuntimeError as first_err:
                # OpenAI-compatible gateways vary on the web-search tool name. Retry once
                # with the alternate documented Responses tool before surfacing the error.
                msg=str(first_err)
                if web_search and any(f"OpenAI API error {code}" in msg for code in (400,404,422)):
                    alternate="web_search_preview" if payload["tools"][0]["type"]=="web_search" else "web_search"
                    payload["tools"]=[{"type":alternate,"search_context_size":"high"}]
                    result=self.openai_request("responses",payload,timeout=240)
                else:
                    raise
            answer=self.extract_output_text(result)
            if not answer:return self.send_json(502,{"ok":False,"error":"Chat model returned no text."})
            return self.send_json(200,{"ok":True,"text":answer,"model":payload["model"],"tier":STUDYVAULT_AI_TIER,"webSearch":web_search,"sources":self.extract_sources(result)})
        except Exception as e:
            return self.send_json(502,{"ok":False,"error":str(e)[:3000]})

    def do_vision(self):
        # Kept separate for callers that want image analysis without chat history.
        if not self.guard_route("vision"): return
        if not self.authorized(): return self.send_json(401,{"ok":False,"error":"unauthorized"})
        if not OPENAI_API_KEY:return self.send_json(503,{"ok":False,"error":"Cloud AI is not configured."})
        try:
            length=int(self.headers.get("Content-Length","0") or 0)
            if length<=0 or length>16*1024*1024:return self.send_json(413,{"ok":False,"error":"payload_too_large"})
            data=json.loads(self.rfile.read(length) or b"{}")
            image=str(data.get("image") or "")
            question=str(data.get("question") or "Describe and analyze this image.").strip()
            if not image:return self.send_json(400,{"ok":False,"error":"image_required"})
            result=self.openai_request("responses",{"model":OPENAI_CHAT_MODEL,"input":[{"role":"user","content":[{"type":"input_text","text":question},{"type":"input_image","image_url":image,"detail":"high"}]}],"max_output_tokens":5000},timeout=180)
            answer=self.extract_output_text(result)
            return self.send_json(200,{"ok":True,"text":answer,"model":OPENAI_CHAT_MODEL})
        except Exception as e:return self.send_json(502,{"ok":False,"error":str(e)[:2500]})

    def _multipart(self,max_bytes=25*1024*1024):
        from email.parser import BytesParser
        from email.policy import default
        length=int(self.headers.get("Content-Length","0") or 0)
        if length<=0 or length>max_bytes: raise ValueError("multipart payload too large")
        body=self.rfile.read(length)
        ctype=self.headers.get("Content-Type","")
        msg=BytesParser(policy=default).parsebytes((f"Content-Type: {ctype}\r\nMIME-Version: 1.0\r\n\r\n").encode()+body)
        fields={}
        for part in msg.iter_parts():
            name=part.get_param("name",header="content-disposition")
            if not name: continue
            payload=part.get_payload(decode=True) or b""
            fields[name]=(payload,part.get_filename() or "blob",part.get_content_type())
        return fields

    def do_transcribe(self):
        if not self.guard_route("audio"): return
        if not self.authorized(): return self.send_json(401,{"ok":False,"error":"unauthorized"})
        if not OPENAI_API_KEY:return self.send_json(503,{"ok":False,"error":"Cloud AI is not configured."})
        try:
            fields=self._multipart(); item=fields.get("file")
            if not item:return self.send_json(400,{"ok":False,"error":"file_required"})
            audio,name,mime=item
            boundary=secrets.token_hex(12)
            chunks=[]
            def add_field(n,v):
                chunks.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{n}\"\r\n\r\n{v}\r\n".encode())
            chunks.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: {mime or 'application/octet-stream'}\r\n\r\n".encode()+audio+b"\r\n")
            add_field("model",OPENAI_TRANSCRIBE_MODEL)
            body=b"".join(chunks)+f"--{boundary}--\r\n".encode()
            req=urllib.request.Request(OPENAI_BASE_URL+"/audio/transcriptions",data=body,headers={"Authorization":f"Bearer {OPENAI_API_KEY}","Content-Type":f"multipart/form-data; boundary={boundary}"},method="POST")
            with urllib.request.urlopen(req,timeout=180) as r: result=json.loads(r.read().decode())
            return self.send_json(200,{"ok":True,"text":str(result.get("text") or ""),"model":OPENAI_TRANSCRIBE_MODEL})
        except Exception as e:return self.send_json(502,{"ok":False,"error":str(e)[:2500]})

    def do_speech(self):
        if not self.guard_route("audio"): return
        if not self.authorized(): return self.send_json(401,{"ok":False,"error":"unauthorized"})
        if not OPENAI_API_KEY:return self.send_json(503,{"ok":False,"error":"Cloud AI is not configured."})
        try:
            length=int(self.headers.get("Content-Length","0") or 0)
            if length<=0 or length>256*1024:return self.send_json(413,{"ok":False,"error":"payload_too_large"})
            data=json.loads(self.rfile.read(length) or b"{}")
            text=str(data.get("text") or "").strip()[:4096]
            if not text:return self.send_json(400,{"ok":False,"error":"text_required"})
            payload={"model":OPENAI_TTS_MODEL,"voice":str(data.get("voice") or "marin"),"input":text,"response_format":"mp3"}
            if data.get("instructions"): payload["instructions"]=str(data.get("instructions"))[:1000]
            req=urllib.request.Request(OPENAI_BASE_URL+"/audio/speech",data=json.dumps(payload).encode(),headers={"Authorization":f"Bearer {OPENAI_API_KEY}","Content-Type":"application/json"},method="POST")
            with urllib.request.urlopen(req,timeout=180) as r: audio=r.read()
            import base64
            return self.send_json(200,{"ok":True,"audioDataUrl":"data:audio/mpeg;base64,"+base64.b64encode(audio).decode(),"model":OPENAI_TTS_MODEL})
        except urllib.error.HTTPError as e:
            return self.send_json(502,{"ok":False,"error":f"OpenAI speech error {e.code}: "+e.read().decode(errors="replace")[:1800]})
        except Exception as e:return self.send_json(502,{"ok":False,"error":str(e)[:2500]})

    def do_ocr_image(self):
        if not self.guard_route("vision"): return
        if not self.authorized(): return self.send_json(401,{"ok":False,"error":"unauthorized"})
        try:
            fields=self._multipart(max_bytes=25*1024*1024)
            item=fields.get("file")
            if not item:return self.send_json(400,{"ok":False,"error":"file_required"})
            raw,name,mime=item
            exe=shutil.which("tesseract")
            if not exe:return self.send_json(503,{"ok":False,"error":"Tesseract is not installed on the Carrot server."})
            with tempfile.TemporaryDirectory(prefix="studyvault-ocr-") as td:
                ext=os.path.splitext(name)[1].lower() or ".png"
                src=os.path.join(td,"input"+ext)
                out=os.path.join(td,"ocr")
                with open(src,"wb") as f:f.write(raw)
                proc=subprocess.run([exe,src,out,"-l","eng","--psm","3"],capture_output=True,text=True,timeout=90)
                txtfile=out+".txt"
                text=open(txtfile,"r",encoding="utf-8",errors="replace").read().strip() if os.path.exists(txtfile) else ""
                if proc.returncode not in (0,1) and not text: raise RuntimeError((proc.stderr or "OCR failed")[-1200:])
                return self.send_json(200,{"ok":True,"text":text,"confidence":0,"method":"server-tesseract"})
        except Exception as e:return self.send_json(502,{"ok":False,"error":str(e)[:2500]})

    def do_extract_pdf(self):
        if not self.guard_route("text"): return
        if not self.authorized(): return self.send_json(401,{"ok":False,"error":"unauthorized"})
        try:
            fields=self._multipart(max_bytes=80*1024*1024)
            item=fields.get("file")
            if not item:return self.send_json(400,{"ok":False,"error":"file_required"})
            raw,name,mime=item
            pdftotext=shutil.which("pdftotext")
            if not pdftotext:return self.send_json(503,{"ok":False,"error":"pdftotext is not installed on the Carrot server."})
            with tempfile.TemporaryDirectory(prefix="studyvault-pdf-") as td:
                src=os.path.join(td,"input.pdf");out=os.path.join(td,"output.txt")
                with open(src,"wb") as f:f.write(raw)
                proc=subprocess.run([pdftotext,"-layout",src,out],capture_output=True,text=True,timeout=90)
                text=open(out,"r",encoding="utf-8",errors="replace").read().strip() if os.path.exists(out) else ""
                # Scanned PDFs often have no text layer. OCR up to 20 rendered pages as a server fallback.
                if len(re.findall(r"\\b\\w+\\b",text))<8:
                    ppm=shutil.which("pdftoppm");tex=shutil.which("tesseract")
                    if ppm and tex:
                        prefix=os.path.join(td,"page")
                        subprocess.run([ppm,"-jpeg","-r","160","-f","1","-l","20",src,prefix],capture_output=True,text=True,timeout=180)
                        pages=[]
                        for fn in sorted(os.listdir(td)):
                            if not fn.startswith("page-") or not fn.endswith(".jpg"):continue
                            img=os.path.join(td,fn);outbase=os.path.join(td,fn[:-4])
                            subprocess.run([tex,img,outbase,"-l","eng","--psm","3"],capture_output=True,text=True,timeout=90)
                            tf=outbase+".txt"
                            if os.path.exists(tf):
                                t=open(tf,"r",encoding="utf-8",errors="replace").read().strip()
                                if t:pages.append(t)
                        if pages:text="\n\n".join(pages)
                if not text:return self.send_json(422,{"ok":False,"error":"pdf_has_no_readable_text"})
                return self.send_json(200,{"ok":True,"text":text,"warnings":["Server PDF fallback used because the browser PDF/OCR path returned little readable text."] if len(text)<100 else [],"method":"pdftotext-tesseract"})
        except Exception as e:return self.send_json(502,{"ok":False,"error":str(e)[:2500]})

    def do_extract_document(self):
        """Extract legacy .doc / .docx files without exposing them to the cloud AI.
        DOCX is parsed with stdlib zip/XML; legacy .doc uses locally installed
        LibreOffice when available. This endpoint exists specifically so the
        browser's Add any file workflow does not silently fail on Word files.
        """
        if not self.guard_route("text"): return
        if not self.authorized(): return self.send_json(401,{"ok":False,"error":"unauthorized"})
        try:
            fields=self._multipart(max_bytes=80*1024*1024)
            item=fields.get("file")
            if not item:return self.send_json(400,{"ok":False,"error":"file_required"})
            raw,name,mime=item
            ext=os.path.splitext(name.lower())[1]
            if ext not in {".doc",".docx"}:
                return self.send_json(400,{"ok":False,"error":"only_.doc_or_.docx_supported"})
            if ext==".docx":
                with zipfile.ZipFile(io.BytesIO(raw)) as z:
                    xml=z.read("word/document.xml").decode("utf-8",errors="replace")
                # Preserve paragraph boundaries and table cell text.
                xml=re.sub(r"</w:p>","\n\n",xml,flags=re.I)
                xml=re.sub(r"</w:tc>"," | ",xml,flags=re.I)
                text=re.sub(r"<[^>]+>","",xml)
                text=(text.replace("&amp;","&").replace("&lt;","<").replace("&gt;",">")
                      .replace("&#39;","'").replace("&quot;",'"'))
                text=re.sub(r"[ \t]+"," ",text)
                text=re.sub(r"\n{3,}","\n\n",text).strip()
                if not text:return self.send_json(422,{"ok":False,"error":"word_document_empty"})
                return self.send_json(200,{"ok":True,"text":text,"warnings":[],"method":"docx-xml"})
            libre=shutil.which("libreoffice") or shutil.which("soffice")
            if not libre:
                return self.send_json(503,{"ok":False,"error":"Legacy .doc extraction needs LibreOffice on the Carrot server. Convert the file to .docx if it is unavailable."})
            with tempfile.TemporaryDirectory(prefix="studyvault-doc-") as td:
                src=os.path.join(td,name.replace("/","_").replace("\\","_"))
                with open(src,"wb") as f:f.write(raw)
                proc=subprocess.run([libre,"--headless","--convert-to","txt:Text","--outdir",td,src],capture_output=True,text=True,timeout=45)
                out=os.path.join(td,os.path.splitext(os.path.basename(src))[0]+".txt")
                if proc.returncode!=0 or not os.path.exists(out):
                    raise RuntimeError((proc.stderr or proc.stdout or "LibreOffice could not convert the document.")[-1200:])
                with open(out,"r",encoding="utf-8",errors="replace") as f:text=f.read().strip()
                if not text:return self.send_json(422,{"ok":False,"error":"word_document_empty"})
                return self.send_json(200,{"ok":True,"text":text,"warnings":["Legacy .doc was converted locally with LibreOffice."],"method":"libreoffice"})
        except Exception as e:
            return self.send_json(502,{"ok":False,"error":str(e)[:2500]})

    def do_ai(self,kind):
        if not self.guard_route("image" if kind=="image" else "text"): return
        if not self.authorized(): return self.send_json(401,{"ok":False,"error":"unauthorized"})
        if not OPENAI_API_KEY:return self.send_json(503,{"ok":False,"error":"Cloud AI is not configured. Set OPENAI_API_KEY on the server."})
        try:
            length=int(self.headers.get("Content-Length","0") or 0)
            if length<=0 or length>12*1024*1024:return self.send_json(413,{"ok":False,"error":"payload_too_large"})
            data=json.loads(self.rfile.read(length) or b"{}")
            if kind=="image":
                prompt=str(data.get("prompt") or "").strip()
                if not prompt:return self.send_json(400,{"ok":False,"error":"prompt_required"})
                image=str(data.get("image") or "").strip()
                action=str(data.get("action") or ("edit" if image else "generate")).lower()
                if action not in {"generate","edit","auto"}: action="auto"
                size=str(data.get("size") or "auto")
                if size not in {"1024x1024","1024x1536","1536x1024","auto"}: size="auto"
                quality=str(data.get("quality") or OPENAI_IMAGE_QUALITY or "high").lower()
                if quality not in {"low","medium","high","auto"}: quality="auto"
                background=str(data.get("background") or "auto").lower()
                if background not in {"transparent","opaque","auto"}: background="auto"
                output_format=str(data.get("output_format") or "png").lower()
                if output_format not in {"png","webp","jpeg"}: output_format="png"

                # Primary path: Responses API image_generation tool. This is the current
                # OpenAI image workflow and returns an image_generation_call.result in base64.
                content=[{"type":"input_text","text":prompt[:9000]}]
                if image.startswith("data:image/") or image.startswith("https://") or image.startswith("http://"):
                    content.append({"type":"input_image","image_url":image,"detail":"high"})
                response_input=[{"role":"user","content":content}]
                tool={"type":"image_generation","model":OPENAI_IMAGE_MODEL,"action":action,"size":size,"quality":quality,"background":background,"output_format":output_format,"moderation":"auto"}
                errors=[]
                try:
                    result=self.openai_request("responses",{"model":OPENAI_CHAT_MODEL,"input":response_input,"tools":[tool]},timeout=300)
                    image_b64=""
                    text=self.extract_output_text(result)
                    for item in result.get("output",[]) or []:
                        if isinstance(item,dict) and item.get("type")=="image_generation_call" and item.get("result"):
                            image_b64=str(item.get("result")); break
                        if isinstance(item,dict) and item.get("type") in {"image_generation.completed","image_edit.completed"} and item.get("b64_json"):
                            image_b64=str(item.get("b64_json")); break
                    if image_b64:
                        mime={"png":"image/png","webp":"image/webp","jpeg":"image/jpeg"}.get(output_format,"image/png")
                        return self.send_json(200,{"ok":True,"imageDataUrl":f"data:{mime};base64,{image_b64}","model":OPENAI_IMAGE_MODEL,"orchestrator":OPENAI_CHAT_MODEL,"action":action,"text":text,"engine":"openai-responses"})
                    errors.append("Responses API returned no image result")
                except Exception as e:
                    errors.append(str(e)[:1200])

                # Compatibility path: some OpenAI-compatible gateways expose /images/generations
                # more reliably than Responses image tools. Keep it as a second attempt.
                if not image and action != "edit":
                    try:
                        payload={"model":OPENAI_IMAGE_MODEL,"prompt":prompt[:9000],"size":size,"quality":quality,"background":background,"output_format":output_format}
                        result=self.openai_request("images/generations",payload,timeout=300)
                        items=result.get("data") if isinstance(result,dict) else None
                        item=items[0] if isinstance(items,list) and items else {}
                        image_b64=str(item.get("b64_json") or "")
                        if image_b64:
                            mime={"png":"image/png","webp":"image/webp","jpeg":"image/jpeg"}.get(output_format,"image/png")
                            return self.send_json(200,{"ok":True,"imageDataUrl":f"data:{mime};base64,{image_b64}","model":OPENAI_IMAGE_MODEL,"action":"generate","text":"","engine":"openai-images"})
                        errors.append("Images API returned no b64_json")
                    except Exception as e:
                        errors.append(str(e)[:1200])

                return self.send_json(502,{"ok":False,"error":"Image generation failed.","details":errors,"hint":"Configure a valid OPENAI_API_KEY on the Carrot server. The browser will still try the public/local fallback when cloud AI is unavailable."})
            task=str(data.get("task") or "reviewer").strip().lower()
            source=str(data.get("source") or "")[:90000]
            source_b=str(data.get("sourceB") or data.get("source2") or "")[:90000]
            evidence = data.get("evidence") if isinstance(data.get("evidence"), list) else []
            evidence_text = "\n".join(f"EVIDENCE {i+1} | p.{e.get('page') or '?'} | {str(e.get('text') or '')[:700]}" for i,e in enumerate(evidence[:100]))
            model=str(data.get("model") or OPENAI_TEXT_MODEL)

            # ChatGPT-parity task prompts: same model, clear structured output
            if task in {"flashcards","cards","study-pack"}:
                if not source.strip():return self.send_json(400,{"ok":False,"error":"source_required"})
                prompt=(
                    "You are ChatGPT. Create high-quality study flashcards from the material below.\n"
                    "Return ONLY valid JSON (no markdown fences) with this shape:\n"
                    '{"cards":[{"question":"...","answer":"...","type":"recall|definition|cloze"}]}\n'
                    "Rules:\n"
                    "- 12 to 20 cards\n"
                    "- Questions test understanding, not trivia wording\n"
                    "- Answers are concise, accurate, and grounded ONLY in the source\n"
                    "- Prefer definitions, processes, comparisons, and must-know facts\n"
                    "- No invented facts\n\nSOURCE:\n"+source
                )
            elif task in {"quiz","mcq"}:
                if not source.strip():return self.send_json(400,{"ok":False,"error":"source_required"})
                prompt=(
                    "You are ChatGPT. Create a high-quality practice quiz from the material below.\n"
                    "Return ONLY valid JSON (no markdown fences) with this shape:\n"
                    '{"quiz":[{"question":"...","options":["A","B","C","D"],"correctIndex":0,"explanation":"..."}]}\n'
                    "Rules:\n"
                    "- 8 to 12 multiple-choice items\n"
                    "- Exactly 4 options each; one clearly correct from the source\n"
                    "- Plausible distractors; no trick questions\n"
                    "- Short explanation of the correct answer\n"
                    "- No invented facts\n\nSOURCE:\n"+source
                )
            elif task in {"compare","diff"}:
                if not source.strip() or not source_b.strip():
                    return self.send_json(400,{"ok":False,"error":"two_sources_required"})
                name_a=str(data.get("nameA") or "Document A")[:80]
                name_b=str(data.get("nameB") or "Document B")[:80]
                prompt=(
                    "You are ChatGPT. Compare these two documents clearly and thoroughly.\n"
                    "Use Markdown with sections:\n"
                    f"**Overview** · **Shared ideas** · **Only in {name_a}** · **Only in {name_b}** · "
                    "**Key differences** · **What to study first**\n"
                    "Be precise. Do not invent content not present in the sources.\n\n"
                    f"=== {name_a} ===\n{source}\n\n=== {name_b} ===\n{source_b}"
                )
            elif task in {"summarize","summary","chatgpt-summary"}:
                if not source.strip():return self.send_json(400,{"ok":False,"error":"source_required"})
                prompt=(
                    "You are ChatGPT. Summarize the following material the way ChatGPT would for a student:\n"
                    "1. **TL;DR** (2–4 sentences)\n"
                    "2. **Key points** (bullets)\n"
                    "3. **Important definitions / terms**\n"
                    "4. **Details worth remembering**\n"
                    "5. **Exam takeaways**\n"
                    "Clear Markdown. No fluff. Stay faithful to the source.\n\nSOURCE:\n"+source
                )
            else:
                # Default: Atlas reviewer (structured study summary)
                if not source.strip():return self.send_json(400,{"ok":False,"error":"source_required"})
                prompt=("You are ChatGPT helping a student study. Produce a rigorous source-grounded summary. "
                    "Use the SOURCE as the factual authority. Never invent facts, page numbers, or quotes. "
                    "If OCR is messy, say so. Produce concise Markdown with:\n"
                    "1. **TL;DR**\n2. **Core ideas**\n3. **Definitions & key terms**\n"
                    "4. **Facts, formulas & numbers**\n5. **Processes & causes**\n"
                    "6. **Comparisons**\n7. **Common confusions**\n8. **Exam cram**\n"
                    "9. **What the source does NOT establish**\n"
                    "Source mode: "+str(data.get("mode") or "standard")+".\n\n"
                    "EVIDENCE LIST:\n"+evidence_text+"\n\nSOURCE:\n"+source)

            result=self.openai_json("responses",{"model":model,"input":prompt,"max_output_tokens":7000})
            text=result.get("output_text") or ""
            if not text:
                parts=[]
                for out in result.get("output",[]) or []:
                    for c in out.get("content",[]) or []:
                        if isinstance(c,dict) and c.get("text"):parts.append(c["text"])
                text="\n".join(parts).strip()
            if not text:return self.send_json(502,{"ok":False,"error":"Text model returned no output."})

            # Parse JSON study-pack / quiz when requested
            parsed=None
            if task in {"flashcards","cards","study-pack","quiz","mcq"}:
                raw=text.strip()
                if raw.startswith("```"):
                    raw=raw.strip("`")
                    if raw.lower().startswith("json"): raw=raw[4:].strip()
                try:
                    parsed=json.loads(raw)
                except Exception:
                    # try extract outermost JSON object
                    start=raw.find("{"); end=raw.rfind("}")
                    if start>=0 and end>start:
                        try: parsed=json.loads(raw[start:end+1])
                        except Exception: parsed=None

            return self.send_json(200,{
                "ok":True,
                "text":text,
                "model":model,
                "task":task,
                "cards":(parsed or {}).get("cards") if isinstance(parsed,dict) else None,
                "quiz":(parsed or {}).get("quiz") if isinstance(parsed,dict) else None,
            })
        except Exception as e:return self.send_json(502,{"ok":False,"error":str(e)[:2500]})

    def do_GET(self):
        if not self.guard():
            return
        if self.path == "/api/session":
            if client_ip(self) in {"127.0.0.1", "::1", "localhost"}:
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.security_headers()
                self.set_session()
                body=json_bytes({"ok":True,"mode":"local"})
                self.send_header("Content-Length", str(len(body)))
                self.end_headers(); self.wfile.write(body); return
            return self.send_json(401,{"ok":False,"error":"pairing_required"})
        if self.path == "/api/ai/capabilities":
            if not self.authorized(): return self.send_json(401,{"ok":False,"error":"unauthorized"})
            return self.send_json(200,{"ok":True,"cloudAI":bool(OPENAI_API_KEY),"tier":STUDYVAULT_AI_TIER,
                "build":BUILD_ID,
                "generalModel":OPENAI_CHAT_MODEL if OPENAI_API_KEY else None,"imageModel":OPENAI_IMAGE_MODEL if OPENAI_API_KEY else None,
                "imageGeneration":bool(OPENAI_API_KEY),"imageEditing":bool(OPENAI_API_KEY),"localImageFallback":True,"imageSizes":["1024x1024","1024x1536","1536x1024","auto"],
                "transcriptionModel":OPENAI_TRANSCRIBE_MODEL if OPENAI_API_KEY else None,"ttsModel":OPENAI_TTS_MODEL if OPENAI_API_KEY else None,
                "webSearch":bool(OPENAI_API_KEY),"vision":bool(OPENAI_API_KEY),
                "clientModelOverride":ALLOW_CLIENT_MODEL_OVERRIDE})
        if self.path == "/api/health":
            return self.send_json(
                200,
                {
                    "ok": True,
                    "service": "StudyVault Sync",
                    "version": APP_VERSION,
                    "build": BUILD_ID,
                    "time": time.time(),
                    "bind": f"{HOST}:{PORT}",
                    "cloudAI": bool(OPENAI_API_KEY),
                    "textModel": OPENAI_TEXT_MODEL if OPENAI_API_KEY else None,
                    "imageModel": OPENAI_IMAGE_MODEL if OPENAI_API_KEY else None,
                },
            )
        if self.path != "/api/sync/pull":
            return self.send_json(404, {"ok": False, "error": "not_found"})
        if not self.authorized():
            return self.send_json(401, {"ok": False, "error": "unauthorized"})
        with _db_lock:
            row = conn.execute("SELECT updated_at,payload FROM vault WHERE id=1").fetchone()
        return self.send_json(
            200,
            {
                "ok": True,
                "updatedAt": row[0] if row else 0,
                "payload": json.loads(row[1]) if row else None,
            },
        )

    def do_POST(self):
        if self.path == "/api/ai/chat": return self.do_chat()
        if self.path == "/api/ai/vision": return self.do_vision()
        if self.path == "/api/ai/transcribe": return self.do_transcribe()
        if self.path == "/api/ai/speech": return self.do_speech()
        if self.path == "/api/pair":
            if not self.guard(): return
            try:
                length=int(self.headers.get("Content-Length","0") or 0)
                data=json.loads(self.rfile.read(min(length,4096)) or b"{}")
                code=str(data.get("code") or "").strip().upper()
                if time.time() > PAIR_EXPIRES or not code or not secrets.compare_digest(code, PAIR_CODE):
                    return self.send_json(401,{"ok":False,"error":"invalid_or_expired_pairing_code"})
                self.send_response(200); self.send_header("Content-Type","application/json; charset=utf-8"); self.security_headers(); self.set_session()
                body=json_bytes({"ok":True,"mode":"paired"}); self.send_header("Content-Length",str(len(body))); self.end_headers(); self.wfile.write(body); return
            except Exception as e:
                return self.send_json(400,{"ok":False,"error":str(e)})
        if self.path == "/api/ai/image": return self.do_ai("image")
        if self.path == "/api/ai/text": return self.do_ai("text")
        if self.path == "/api/files/extract-document": return self.do_extract_document()
        if self.path == "/api/files/ocr-image": return self.do_ocr_image()
        if self.path == "/api/files/extract-pdf": return self.do_extract_pdf()
        if not self.guard():
            return
        if self.path != "/api/sync/push":
            return self.send_json(404, {"ok": False, "error": "not_found"})
        if not self.authorized():
            return self.send_json(401, {"ok": False, "error": "unauthorized"})
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
            if length <= 0 or length > MAX_BODY:
                return self.send_json(413, {"ok": False, "error": "payload_too_large"})
            raw = self.rfile.read(length)
            data = json.loads(raw or b"{}")
            payload = data.get("payload")
            if not isinstance(payload, dict):
                raise ValueError("payload must be an object")
            # Soft size guard after parse
            encoded = json.dumps(payload, ensure_ascii=False)
            if len(encoded.encode("utf-8")) > MAX_BODY:
                return self.send_json(413, {"ok": False, "error": "payload_too_large"})
            updated = float(data.get("updatedAt") or time.time())
            with _db_lock:
                old = conn.execute("SELECT updated_at FROM vault WHERE id=1").fetchone()
                if old and updated < old[0]:
                    return self.send_json(
                        409, {"ok": False, "error": "stale_payload", "updatedAt": old[0]}
                    )
                conn.execute(
                    "INSERT INTO vault(id,updated_at,payload) VALUES(1,?,?) "
                    "ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,payload=excluded.payload",
                    (updated, encoded),
                )
                conn.commit()
            return self.send_json(200, {"ok": True, "updatedAt": updated})
        except Exception as e:
            return self.send_json(400, {"ok": False, "error": str(e)})


def serve():
    print(f"StudyVault Sync listening on http://{HOST}:{PORT}")
    print(f"Local browser access: automatic session (no token required)")
    print(f"Remote pairing code (valid 15 min): {PAIR_CODE}")
    print(f"Cloud AI: {'enabled' if OPENAI_API_KEY else 'disabled'} | chat={OPENAI_CHAT_MODEL} | image={OPENAI_IMAGE_MODEL} | transcribe={OPENAI_TRANSCRIBE_MODEL} | tts={OPENAI_TTS_MODEL}")
    print("For remote use, put HTTPS/authentication in front of this server and restrict CORS origins.")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()

if __name__ == "__main__":
    serve()
