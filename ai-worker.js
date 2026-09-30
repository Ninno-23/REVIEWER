"use strict";

const HF_RUNTIME = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0";
const HIGH_MODEL = "onnx-community/Qwen3-4B-ONNX";
const DESKTOP_MODEL = "onnx-community/Qwen3-1.7B-ONNX";
const MOBILE_MODEL = "onnx-community/Qwen3-0.6B-ONNX";
let MODEL = MOBILE_MODEL;
let runtime = null;
let pipe = null;
let loading = null;
let cancelled = false;
let activeRequest = 0;

function post(type, data = {}) { self.postMessage({ type, ...data }); }
function cleanText(value) {
  return String(value ?? "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\|thinking\|>[\s\S]*?<\|\/thinking\|>/gi, "")
    .replace(/^\s*```(?:markdown|md|text)?/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}
function isAndroid() { return /Android/i.test(self.navigator?.userAgent || ""); }
function deviceMemory() { return Number(self.navigator?.deviceMemory || 0); }
function cores() { return Number(self.navigator?.hardwareConcurrency || 0); }
function deviceProfile() {
  const android = isAndroid();
  const memory = deviceMemory();
  const cpu = cores();
  const gpu = !!self.navigator?.gpu;
  const conservative = android && ((memory && memory <= 4) || (cpu && cpu <= 4));
  return { android, memory, cpu, gpu, conservative };
}
function modelForProfile(p) {
  // 4B is only attempted on hardware with enough RAM and a GPU path; otherwise use the much lighter 1.7B.
  if (!p.conservative && p.gpu && p.memory >= 12) return HIGH_MODEL;
  return p.conservative ? MOBILE_MODEL : DESKTOP_MODEL;
}
function devicePreference() {
  const p = deviceProfile();
  // Android WebGPU is preferred only when the browser exposes it. Low-memory phones
  // still get a CPU/WASM path instead of risking a GPU allocation failure.
  return p.gpu && !p.conservative ? "webgpu" : "wasm";
}
function dtypeFor(device, attempt=0) {
  // q4 is the safer mobile WebGPU format; q4f16 is attempted only on capable devices.
  if (device === "webgpu") return MODEL === HIGH_MODEL ? "q4f16" : (attempt === 0 ? "q4" : "q4f16");
  return "q4";
}

async function getRuntime() {
  if (runtime) return runtime;
  if (loading) return loading;
  loading = (async () => {
    const mod = await import(HF_RUNTIME);
    if (mod.env) {
      mod.env.useBrowserCache = true;
      mod.env.allowRemoteModels = true;
      mod.env.allowLocalModels = false;
    }
    runtime = mod;
    return mod;
  })().finally(() => { loading = null; });
  return loading;
}

async function ensurePipeline() {
  if (pipe) return pipe;
  const mod = await getRuntime();
  const preferred = devicePreference();
  const profile = deviceProfile();
  MODEL = modelForProfile(profile);
  post("device", { android: profile.android, memory: profile.memory, cpu: profile.cpu, gpu: profile.gpu, conservative: profile.conservative });
  const tryLoad = async (device, attempt=0) => {
    post("status", { message: `Loading offline Study Engine (${device === "webgpu" ? "mobile GPU" : "CPU/WASM"})…` });
    return mod.pipeline("text-generation", MODEL, {
      device,
      dtype: dtypeFor(device, attempt),
      progress_callback: (info) => {
        if (info?.status === "progress") {
          post("progress", {
            message: typeof info.progress === "number"
              ? `Offline Study Engine download ${Math.round(info.progress)}%…`
              : `Downloading offline Study Engine…`,
            progress: typeof info.progress === "number" ? info.progress : null
          });
        } else if (info?.status) {
          post("status", { message: String(info.status) });
        }
      }
    });
  };
  try {
    pipe = await tryLoad(preferred, 0);
  } catch (firstError) {
    if (MODEL === HIGH_MODEL) {
      try { MODEL = DESKTOP_MODEL; post("status", {message:"Offline 4B model unavailable; switching to the lighter offline fallback…"}); pipe = await tryLoad(preferred, 0); } catch {}
    }
    if (!pipe && preferred === "webgpu") {
      try {
        post("status", { message: "Mobile GPU format was unavailable; trying a compatible GPU format…" });
        pipe = await tryLoad("webgpu", 1);
      } catch {
        post("status", { message: "GPU path unavailable; switching to CPU/WASM fallback…" });
        pipe = await tryLoad("wasm", 0);
      }
    } else {
      throw firstError;
    }
  }
  const actualDevice = preferred === "webgpu" && pipe ? "webgpu" : "wasm";
  post("ready", { capability:"offline-study-engine", model: MODEL, device: actualDevice, android: profile.android, conservative: profile.conservative });
  return pipe;
}

function sourceChunks(source, maxChars = 4200, maxChunks = 18) {
  const raw=String(source||"").replace(/\r/g,"").trim(); if(!raw)return [];
  // Preserve explicit page boundaries whenever extraction supplied them.
  const pages=raw.split(/(?=\n?---\s*\n|\bPAGE\s+\d+\b)/i).map(x=>x.trim()).filter(Boolean);
  const pieces=[];
  for(let pageIndex=0;pageIndex<pages.length && pieces.length<maxChunks;pageIndex++){
    const page=pages[pageIndex];
    const blocks=page.split(/\n{2,}/).map(x=>x.trim()).filter(Boolean);
    let current=`SOURCE PAGE ${pageIndex+1}:\n`;
    for(const block of blocks){
      if((current.length+block.length+2)<=maxChars){ current+=(current.endsWith("\n")?"":"\n\n")+block; }
      else { if(current.trim().length>18)pieces.push(current.slice(0,maxChars)); current=`SOURCE PAGE ${pageIndex+1}:\n${block}`; if(pieces.length>=maxChunks)break; }
    }
    if(pieces.length<maxChunks && current.trim().length>18)pieces.push(current.slice(0,maxChars));
  }
  return pieces.slice(0,maxChunks);
}

function evidenceRank(query, chunk){
  const q=new Set(cleanText(query).toLowerCase().split(/[^a-z0-9α-ωΑ-ΩμΩΔ]+/).filter(w=>w.length>=3));
  const t=new Set(cleanText(chunk).toLowerCase().split(/[^a-z0-9α-ωΑ-ΩμΩΔ]+/).filter(w=>w.length>=3));
  if(!q.size||!t.size)return 0; let hit=0; for(const w of q)if(t.has(w))hit++;
  const phrase=cleanText(chunk).toLowerCase().includes(cleanText(query).toLowerCase())?0.6:0;
  return hit/Math.sqrt(q.size*t.size)+phrase;
}

function parseGenerated(result) {
  const generated = result?.[0]?.generated_text;
  if (Array.isArray(generated)) {
    const last = generated.at(-1);
    return cleanText(last?.content || last?.text || "");
  }
  return cleanText(generated || "");
}

async function generate(messages, options = {}, requestId = 0) {
  const generator = await ensurePipeline();
  if (cancelled || requestId !== activeRequest) throw new Error("AI task cancelled.");
  const mod = runtime || await getRuntime();
  let streamed = "";
  const streamer = mod.TextStreamer
    ? new mod.TextStreamer(generator.tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: token => {
          if (cancelled || requestId !== activeRequest) return;
          streamed += token;
          post("token", { requestId, text: token });
        }
      })
    : undefined;
  const result = await generator(messages, {
    max_new_tokens: options.max_new_tokens || (deviceProfile().android ? 224 : 420),
    do_sample: false,
    repetition_penalty: 1.08,
    return_full_text: false,
    streamer
  });
  if (cancelled || requestId !== activeRequest) throw new Error("AI task cancelled.");
  return cleanText(streamed || parseGenerated(result));
}

function groundingScore(output, source, terms = []) {
  const words = text => new Set(cleanText(text).toLowerCase().split(/[^a-z0-9'-]+/).filter(w => w.length >= 5));
  const a = words(output), b = words(source);
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  const overlap = b.size ? Math.min(1, shared / Math.max(18, Math.min(150, b.size * 0.18))) : 0;
  const hits = terms.filter(t => output.toLowerCase().includes(String(t).toLowerCase())).length;
  const termScore = terms.length ? Math.min(1, hits / Math.min(8, terms.length)) : 0;
  const caveat = /not in the source|not enough information|source does not/i.test(output) ? .08 : 0;
  return Math.round(Math.min(1, overlap * .76 + termScore * .24 + caveat) * 100);
}

function overlapScore(query, text) {
  const q = new Set(cleanText(query).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4));
  const t = new Set(cleanText(text).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4));
  if (!q.size || !t.size) return 0;
  let hit = 0; for (const w of q) if (t.has(w)) hit++;
  return hit / Math.max(1, q.size);
}

async function verifyAndRepair(text, source, requestId, contextLabel="answer") {
  const score = groundingScore(text, source, []);
  if (score >= 52) return text;
  post("status", { message: `Verifying ${contextLabel} against the source…` });
  const sourceView = sourceChunks(source, 3600, 8).join("\n\n");
  const repaired = await generate([
    { role: "system", content: "You are a strict academic fact checker. Rewrite DRAFT using ONLY VERIFIED SOURCE. Remove unsupported claims. Preserve correct details. If evidence is insufficient, say so. Never invent citations, page numbers, formulas, names, or numbers. Keep source locators such as SOURCE PAGE or SOURCE SECTION when useful." },
    { role: "user", content: `VERIFIED SOURCE:\n${sourceView}\n\nDRAFT:\n${text}\n\nReturn only the corrected answer.` }
  ], { max_new_tokens: contextLabel === "reviewer" ? 340 : 300 }, requestId);
  return repaired || text;
}

async function runReviewer(msg) {
  const source = String(msg.source || "").slice(0, 52000);
  const profile = String(msg.profile || "");
  const chunks = sourceChunks(source, 4200, 18);
  const summaries = [];

  for (let i = 0; i < chunks.length; i++) {
    if (cancelled) throw new Error("AI task cancelled.");
    post("status", { message: `Reading source section ${i + 1} of ${chunks.length}…` });
    const chunkSummary = await generate([
      { role: "system", content: "You are a meticulous academic evidence extractor. Summarize ONLY facts present in SOURCE SECTION. Preserve definitions, formulas, dates, names, sequences, examples, exceptions, and relationships. Do not add outside facts." },
      { role: "user", content: `Create a compact evidence record for this SOURCE SECTION. Keep unique details even if they appear late in the document.\n\nSOURCE SECTION:\n${chunks[i]}` }
    ], { max_new_tokens: 180 }, msg.requestId);
    summaries.push(`SECTION ${i + 1}:\n${chunkSummary}`);
  }

  post("status", { message: "Synthesizing the complete reviewer…" });
  const finalPrompt = `Rewrite the VERIFIED evidence into a coherent, student-friendly study reviewer. You are an editor, not a fact generator. Use ONLY the evidence below.

Return exactly these sections:
BIG PICTURE:
CORE IDEAS:
HOW IT WORKS:
WHAT TO MEMORIZE:
COMMON CONFUSIONS:
EXAM CRAM:
PERSONAL FOCUS:

Rules:
- Do not invent facts or citations.
- Every factual statement must be traceable to the evidence pack or source excerpts.
- Never use model memory as evidence.
- If source excerpts conflict, report the conflict rather than silently choosing one.
- Preserve SOURCE PAGE / SOURCE SECTION locators when they are present and useful.
- If evidence is missing, write "Not stated in the provided material." instead of guessing.
- Keep formulas, names, definitions, dates, sequences, and relationships faithful to the evidence.
- Do not silently merge contradictory statements; flag the conflict.
- Prefer clear explanations over sentence copying.
- Personal Focus should prioritize weak concepts from the learner profile but still use only supported material.

LEARNER PROFILE:
${profile}

EVIDENCE PACK:
${summaries.join("\n\n")}

SOURCE EXCERPTS:
${source.slice(0, 14000)}`;
  let text = await generate([
    { role: "system", content: "You are a source-grounded study tutor. Accuracy is more important than creativity. If evidence is insufficient, say so." },
    { role: "user", content: finalPrompt }
  ], { max_new_tokens: 420 }, msg.requestId);
  text = await verifyAndRepair(text, source, msg.requestId, "reviewer");
  return { text, score: groundingScore(text, source, msg.terms || []) };
}

async function runAsk(msg) {
  const source = String(msg.source || "").slice(0, 52000);
  const history = Array.isArray(msg.history) ? msg.history.slice(-12) : [];
  const hasSource = !!source.trim();
  const chunks = hasSource ? sourceChunks(source, 4200, 14) : [];
  const ranked = chunks.map((chunk,index)=>({chunk,index,score:evidenceRank(msg.question||"",chunk)}))
    .sort((a,b)=>b.score-a.score||a.index-b.index)
    .slice(0,Math.min(8,chunks.length));
  const evidence = ranked.map((x,i)=>`EVIDENCE ${i+1} [SOURCE SECTION ${x.index+1}]\n${x.chunk}`).join("\n\n");

  // ChatGPT-style system prompt: natural, helpful, multi-turn aware
  const system =
    "You are StudyVault AI — a sharp, friendly study companion like a top tutor in a chat app. " +
    "Write naturally in clear paragraphs or short bullets when helpful. Match the student's language. " +
    "Be direct: answer first, then briefly explain why. Ask one short follow-up question only when it helps learning. " +
    "Remember the conversation history and refer back when useful. " +
    "When STUDY MATERIAL is provided, treat it as the authority for class-specific facts — never invent formulas, numbers, names, or page numbers. " +
    "If the material does not contain the answer, say so honestly and teach from general curriculum knowledge, labeling it clearly. " +
    "For writing help (essays, letters, paragraphs, summaries), give concrete structure and a short example. " +
    "Never dump a wall of text. Prefer 2–6 tight sentences or clean bullets. No hidden chain-of-thought.";

  const messages = [{ role: "system", content: system }];
  for (const h of history) {
    if (!h || !h.text) continue;
    messages.push({
      role: h.role === "tutor" || h.role === "assistant" ? "assistant" : "user",
      content: String(h.text).slice(0, 1600)
    });
  }

  let userBlock = `STUDENT:\n${msg.question}`;
  if (hasSource) {
    userBlock += `\n\nRELEVANT STUDY MATERIAL:\n${evidence || "(no highly relevant excerpt — use full-source caution)"}`;
    userBlock += `\n\nSource is loaded. Prefer it for class facts. If missing, say so and teach the general idea.`;
  } else {
    userBlock += `\n\nNo PDF is open. Answer from curriculum knowledge (English writing, STEM, electronics, study skills) in a natural tutoring style.`;
  }
  if (msg.profile) userBlock += `\n\nLEARNER HINTS:\n${String(msg.profile).slice(0, 800)}`;
  messages.push({ role: "user", content: userBlock });

  let text = await generate(messages, {
    max_new_tokens: deviceProfile().android ? 280 : 480
  }, msg.requestId);

  // Only hard-verify when we actually had source evidence
  if (hasSource && evidence) {
    text = await verifyAndRepair(text, evidence || source, msg.requestId, "answer");
  }
  const score = hasSource ? groundingScore(text, evidence || source, msg.terms || []) : 78;
  return { text, score };
}

let loadAbort = null;

self.onmessage = async event => {
  const msg = event.data || {};
  if (msg.type === "cancel") {
    cancelled = true;
    activeRequest = 0;
    try { loadAbort?.abort?.(); } catch {}
    loadAbort = null;
    // Drop in-flight pipeline reference so a later load starts clean
    loading = null;
    post("cancelled");
    return;
  }
  if (msg.type === "load") {
    cancelled = false;
    loadAbort = typeof AbortController !== "undefined" ? new AbortController() : null;
    try {
      await ensurePipeline();
      if (cancelled) post("cancelled");
    } catch (error) {
      if (!cancelled) post("error", { message: error?.message || String(error) });
    }
    return;
  }
  if (msg.type !== "task") return;
  activeRequest = Number(msg.requestId || Date.now());
  cancelled = false;
  try {
    const result = msg.task === "reviewer" ? await runReviewer(msg) : await runAsk(msg);
    if (cancelled || Number(msg.requestId) !== activeRequest) {
      post("cancelled");
      return;
    }
    post("done", { requestId: msg.requestId, text: result.text, groundingScore: result.score, model: MODEL, device: self.navigator?.gpu ? "webgpu" : "wasm" });
  } catch (error) {
    if (!cancelled) post("error", { requestId: msg.requestId, message: error?.message || String(error) });
  }
};
