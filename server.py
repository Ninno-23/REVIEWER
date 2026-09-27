#!/usr/bin/env python3
"""StudyVault optional self-hosted sync server — foundation-hardened.

Python standard library only.

Run (recommended):
  STUDYVAULT_SYNC_TOKEN="$(openssl rand -hex 32)" python3 server.py

Default bind: 127.0.0.1:8787 (loopback only).
Do not expose publicly without HTTPS and a long random token.
"""
import json, os, sqlite3, time, threading
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.getenv("STUDYVAULT_HOST", "127.0.0.1")
PORT = int(os.getenv("STUDYVAULT_PORT", "8787"))
TOKEN = os.getenv("STUDYVAULT_SYNC_TOKEN", "")
DB = os.getenv("STUDYVAULT_DB", "studyvault-sync.sqlite3")
# Optional: comma-separated exact origins, e.g. https://family.example.com
# Empty = reflect only loopback-style local use with no public wildcard by default.
CORS_ORIGINS = [o.strip() for o in os.getenv("STUDYVAULT_CORS_ORIGINS", "").split(",") if o.strip()]
MAX_BODY = int(os.getenv("STUDYVAULT_MAX_BODY", str(8 * 1024 * 1024)))  # 8 MB
RATE_LIMIT = int(os.getenv("STUDYVAULT_RATE_LIMIT", "30"))  # requests / window
RATE_WINDOW = float(os.getenv("STUDYVAULT_RATE_WINDOW", "60"))

if not TOKEN or TOKEN in ("change-me", "changeme", "secret", "password"):
    raise SystemExit(
        "Refusing to start: set a strong STUDYVAULT_SYNC_TOKEN "
        "(at least 16 random characters). Example:\n"
        '  STUDYVAULT_SYNC_TOKEN="$(openssl rand -hex 32)" python3 server.py'
    )
if len(TOKEN) < 16:
    raise SystemExit("Refusing to start: STUDYVAULT_SYNC_TOKEN must be at least 16 characters.")

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


def rate_ok(ip):
    now = time.time()
    with _rate_lock:
        q = _rate[ip]
        while q and now - q[0] > RATE_WINDOW:
            q.popleft()
        if len(q) >= RATE_LIMIT:
            return False
        q.append(now)
        return True


class Handler(BaseHTTPRequestHandler):
    server_version = "StudyVaultSync/18"

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
        origin = self.cors_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
            self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")

    def send_json(self, code, obj):
        body = json_bytes(obj)
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.security_headers()
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        auth = self.headers.get("Authorization", "")
        expected = "Bearer " + TOKEN
        # Constant-time-ish compare for equal lengths
        if len(auth) != len(expected):
            return False
        result = 0
        for a, b in zip(auth.encode("utf-8"), expected.encode("utf-8")):
            result |= a ^ b
        return result == 0

    def guard(self):
        ip = client_ip(self)
        if not rate_ok(ip):
            self.send_json(429, {"ok": False, "error": "rate_limited"})
            return False
        return True

    def do_OPTIONS(self):
        if not self.guard():
            return
        self.send_response(204)
        self.security_headers()
        self.end_headers()

    def do_GET(self):
        if not self.guard():
            return
        if self.path == "/api/health":
            return self.send_json(
                200,
                {
                    "ok": True,
                    "service": "StudyVault Sync",
                    "version": 18,
                    "time": time.time(),
                    "bind": f"{HOST}:{PORT}",
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


print(f"StudyVault Sync listening on http://{HOST}:{PORT}")
print("Token is set (hidden). CORS origins:", CORS_ORIGINS or "(local-only echo)")
print("Keep this server on trusted networks only; use HTTPS in front if remote.")
ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
