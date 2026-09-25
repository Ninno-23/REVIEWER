
(() => {
"use strict";

const APP_VERSION = 4;
const DB_NAME = "studyvault-v4";
const DB_VERSION = 1;
const DOC_STORE = "documents";
const META_STORE = "meta";
const SETTINGS_KEY = "settings";
const CDN_PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const CDN_PDF_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

let pdfEnginePromise = null;
let noteSaveToken = 0;

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const clamp = (n,min,max) => Math.max(min,Math.min(max,n));
const esc = v => String(v ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
const normalize = v => String(v ?? "").replace(/\u00a0/g," ").replace(/[ \t]+/g," ").replace(/\n{3,}/g,"\n\n").trim();
const wordCount = v => normalize(v) ? normalize(v).split(/\s+/).length : 0;
const debounce = (fn, ms=350) => { let t; return (...args) => { clearTimeout(t); t=setTimeout(()=>fn(...args),ms); }; };

const STOP = new Set(("a an and are as at be because been before being between but by can could did do does for from had has have he her here hers him his how i if in into is it its itself just may me might more most my no not of on one or our ours out over same she should so some than that the their theirs them themselves then there these they this those through to too under up us was we were what when where which while who whom why will with would you your yours about after again against all also among another any anything around become below both during each either enough even every example few first following further given going having however important later least little many maybe much must never often other otherwise perhaps rather since such very want without within yet" ).split(/\s+/));

let state = {
  settings: { theme:"dark", pinHash:"", pinSalt:"", pinIterations:120000 },
  documents: [],
  activeDocId: null
};
let deferredInstall = null;

function toast(message,type=""){
  const el=$("#toast");
  if(!el)return;
  el.textContent=message;
  el.className=`toast${type?` ${type}`:""}`;
  requestAnimationFrame(()=>el.classList.add("show"));
  clearTimeout(toast.timer);
  toast.timer=setTimeout(()=>el.classList.remove("show"),3200);
}
function activateSection(id){
  $$(".section").forEach(s=>s.classList.toggle("active",s.id===id));
  $$('[data-section]').forEach(b=>b.classList.toggle("active",b.dataset.section===id));
  window.scrollTo({top:0,behavior:"smooth"});
}
function activeDoc(){return state.documents.find(d=>d.id===state.activeDocId)||null;}

function setEngineStatus(text){const el=$("#engineStatus");if(el)el.textContent=`PDF engine: ${text}`;}
function loadPdfEngine(){
  if(window.pdfjsLib){
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = CDN_PDF_WORKER;
    setEngineStatus("ready");
    return Promise.resolve(true);
  }
  if(pdfEnginePromise)return pdfEnginePromise;
  setEngineStatus("loading…");
  pdfEnginePromise = new Promise(resolve=>{
    const script=document.createElement("script");
    script.src=CDN_PDFJS;
    script.async=true;
    let done=false;
    const finish=ok=>{
      if(done)return;
      done=true;
      clearTimeout(timer);
      if(ok&&window.pdfjsLib){window.pdfjsLib.GlobalWorkerOptions.workerSrc=CDN_PDF_WORKER;setEngineStatus("ready");resolve(true);}
      else {setEngineStatus("unavailable — connect to the internet to process PDFs");resolve(false);}
    };
    script.onload=()=>finish(true);
    script.onerror=()=>finish(false);
    document.head.appendChild(script);
    const timer=setTimeout(()=>finish(false),10000);
  });
  return pdfEnginePromise;
}

function openDB(){
  return new Promise((resolve,reject)=>{
    const r=indexedDB.open(DB_NAME,DB_VERSION);
    r.onupgradeneeded=()=>{
      const db=r.result;
      if(!db.objectStoreNames.contains(DOC_STORE))db.createObjectStore(DOC_STORE,{keyPath:"id"});
      if(!db.objectStoreNames.contains(META_STORE))db.createObjectStore(META_STORE);
    };
    r.onsuccess=()=>resolve(r.result);
    r.onerror=()=>reject(r.error);
  });
}
async function dbPut(store,keyOrValue,value){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(store,"readwrite");
    const os=tx.objectStore(store);
    if(value===undefined)os.put(keyOrValue);else os.put(value,keyOrValue);
    tx.oncomplete=()=>{db.close();resolve();};
    tx.onerror=()=>{db.close();reject(tx.error);};
  });
}
async function dbGet(store,key){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(store,"readonly");
    const r=tx.objectStore(store).get(key);
    r.onsuccess=()=>resolve(r.result);
    r.onerror=()=>reject(r.error);
    tx.oncomplete=()=>db.close();
  });
}
async function dbGetAll(store){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(store,"readonly");
    const r=tx.objectStore(store).getAll();
    r.onsuccess=()=>resolve(r.result||[]);
    r.onerror=()=>reject(r.error);
    tx.oncomplete=()=>db.close();
  });
}
async function dbDelete(store,key){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(store,"readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete=()=>{db.close();resolve();};
    tx.onerror=()=>{db.close();reject(tx.error);};
  });
}
async function dbClear(){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction([DOC_STORE,META_STORE],"readwrite");
    tx.objectStore(DOC_STORE).clear();tx.objectStore(META_STORE).clear();
    tx.oncomplete=()=>{db.close();resolve();};
    tx.onerror=()=>{db.close();reject(tx.error);};
  });
}
async function saveDoc(doc){doc.updatedAt=now();await dbPut(DOC_STORE,doc);}
async function saveMeta(){await dbPut(META_STORE,SETTINGS_KEY,{...state.settings,activeDocId:state.activeDocId,version:APP_VERSION});}

async function derivePin(pin,salt,iterations=120000){
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(pin),"PBKDF2",false,["deriveBits"]);
  const bits=await crypto.subtle.deriveBits({name:"PBKDF2",salt,iterations,hash:"SHA-256"},key,256);
  return Array.from(new Uint8Array(bits),b=>b.toString(16).padStart(2,"0")).join("");
}
function bytesToB64(bytes){let s="";for(const b of bytes)s+=String.fromCharCode(b);return btoa(s);}
function b64ToBytes(s){const bin=atob(s);return Uint8Array.from(bin,c=>c.charCodeAt(0));}
async function setPin(){
  const a=$("#pinA").value.trim(),b=$("#pinB").value.trim();
  if(a.length<4)return toast("PIN must contain at least 4 characters.","error");
  if(a!==b)return toast("PINs do not match.","error");
  const salt=crypto.getRandomValues(new Uint8Array(16));
  state.settings.pinSalt=bytesToB64(salt);
  state.settings.pinIterations=120000;
  state.settings.pinHash=await derivePin(a,salt,state.settings.pinIterations);
  await saveMeta();closePin();toast("PIN protection enabled.","success");
}
async function verifyPin(pin){
  if(!state.settings.pinHash||!state.settings.pinSalt)return false;
  const hash=await derivePin(pin,b64ToBytes(state.settings.pinSalt),state.settings.pinIterations||120000);
  return hash===state.settings.pinHash;
}
async function removePin(){
  if(!state.settings.pinHash)return toast("No PIN is enabled.");
  if(!confirm("Remove the StudyVault PIN?"))return;
  state.settings.pinHash="";state.settings.pinSalt="";await saveMeta();closePin();toast("PIN removed.","success");
}
function openPin(){$("#pinModal").classList.add("open");}
function closePin(){$("#pinModal").classList.remove("open");$("#pinA").value="";$("#pinB").value="";}
function lockApp(){
  if(!state.settings.pinHash)return toast("Set a PIN first in Settings.","error");
  $("#lock").classList.add("open");$("#unlockPin").value="";$("#unlockMsg").textContent="";setTimeout(()=>$("#unlockPin").focus(),30);
}
async function unlockApp(){
  const p=$("#unlockPin").value.trim();if(!p)return $("#unlockMsg").textContent="Enter your PIN.";
  const ok=await verifyPin(p);
  if(ok){$("#lock").classList.remove("open");$("#unlockPin").value="";toast("Unlocked.","success");}
  else $("#unlockMsg").textContent="Incorrect PIN.";
}

function tokenize(text){return normalize(text).toLowerCase().replace(/[^a-z0-9\s'-]/g," ").split(/\s+/).filter(Boolean);}
function stableId(prefix,text){
  let h=2166136261;
  for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619);}
  return `${prefix}-${(h>>>0).toString(16)}`;
}
function similarity(a,b){
  const A=new Set(tokenize(a)),B=new Set(tokenize(b));let common=0;
  for(const x of A)if(B.has(x))common++;
  const union=new Set([...A,...B]).size;return union?common/union:0;
}

function extractSentences(text,min=28){
  const cleaned=normalize(text);
  if(!cleaned)return [];
  const raw=[];
  for(const part of cleaned.split(/\n+/)){
    const line=part.trim();
    if(!line)continue;
    const pieces=line.match(/[^.!?;]+(?:[.!?]+|;|$)/g)||[line];
    for(const p of pieces){const s=normalize(p);if(s.length>=min)raw.push(s);}
  }
  const seen=new Set();
  return raw.filter(s=>{const k=s.toLowerCase();if(seen.has(k))return false;seen.add(k);return true;});
}

function extractTerms(text){
  const toks=tokenize(text);const uni=new Map(),bi=new Map(),tri=new Map();
  for(const w of toks){
    if(w.length<4||w.length>28||STOP.has(w)||/^\d+$/.test(w))continue;
    uni.set(w,(uni.get(w)||0)+1);
  }
  for(let i=0;i<toks.length-1;i++){
    const a=toks[i],b=toks[i+1];
    if(a.length>=4&&b.length>=4&&!STOP.has(a)&&!STOP.has(b)){
      const k=`${a} ${b}`;bi.set(k,(bi.get(k)||0)+1);
      if(i<toks.length-2){const c=toks[i+2];if(c.length>=4&&!STOP.has(c)){const t=`${a} ${b} ${c}`;tri.set(t,(tri.get(t)||0)+1)}}
    }
  }
  const ranked=[...uni.entries()].map(([term,freq])=>({term,freq,score:freq+(freq>=3?1.4:0)+(freq>=7?1.3:0)+(term.includes("-")?1:0)})).sort((a,b)=>b.score-a.score);
  const phrases=[...bi.entries()].filter(([,f])=>f>=2).map(([term,freq])=>({term,freq,score:freq*2.6})).sort((a,b)=>b.score-a.score);
  const triples=[...tri.entries()].filter(([,f])=>f>=2).map(([term,freq])=>({term,freq,score:freq*3.2})).sort((a,b)=>b.score-a.score);
  const out=[];
  for(const item of [...triples,...phrases,...ranked]){
    const term=item.term;
    if(out.some(x=>x.toLowerCase()===term.toLowerCase()))continue;
    if(out.some(x=>similarity(x,term)>.82))continue;
    out.push(term);
    if(out.length>=32)break;
  }
  return out;
}

function detectDefinitions(sentences,terms){
  const patterns=[/\b(.+?)\s+(?:is|are|means|refers to|defined as|known as|is called|can be defined as)\b/i,/\b(.+?)\s*:\s*(.+)/i];
  const defs=[];
  for(const s of sentences){
    if(defs.length>=16)break;
    if(patterns[0].test(s)||patterns[1].test(s)){
      const low=s.toLowerCase();
      const term=terms.find(t=>low.includes(t.toLowerCase()));
      if(term&&!defs.some(d=>d.term.toLowerCase()===term.toLowerCase()))defs.push({term,definition:s});
    }
  }
  return defs;
}

function sentenceScore(s,terms){
  const l=s.toLowerCase();let score=0;
  for(const t of terms.slice(0,22))if(l.includes(t.toLowerCase()))score+=2;
  if(/\b(is|are|means|refers to|defined as|known as|is called|consists of)\b/i.test(s))score+=6;
  if(/\b(function|purpose|process|used|example|important|include|includes|types|steps|characteristics|advantages|disadvantages|difference|cause|effect|result)\b/i.test(s))score+=3;
  if(/\b(first|second|third|finally|therefore|because|however|for example|such as)\b/i.test(s))score+=2;
  if(/\d/.test(s))score+=1;
  if(s.length>=55&&s.length<=280)score+=2;
  if(s.length>360)score-=2;
  return score;
}

function pickDiverse(sentences,terms,count){
  const ranked=sentences.map((s,i)=>({s,i,score:sentenceScore(s,terms)})).sort((a,b)=>b.score-a.score);
  const chosen=[];
  for(const x of ranked){
    if(chosen.some(y=>similarity(y.s,x.s)>.62))continue;
    chosen.push(x);
    if(chosen.length>=count)break;
  }
  return chosen.sort((a,b)=>a.i-b.i);
}

function contextForTerm(term,units){
  const l=term.toLowerCase();
  const hits=units.filter(u=>u.text.toLowerCase().includes(l)).sort((a,b)=>sentenceScore(b.text,[term])-sentenceScore(a.text,[term]));
  return hits[0]||null;
}
function bestDefinition(term,units){
  const direct=units.filter(u=>u.text.toLowerCase().includes(term.toLowerCase())).sort((a,b)=>{
    const cue=x=>/\b(is|are|means|refers to|defined as|known as|is called|consists of)\b/i.test(x.text)?4:0;
    return (cue(b)+b.text.length*.001)-(cue(a)+a.text.length*.001);
  })[0];
  return direct||null;
}

function buildReviewer(doc){
  const units=doc.units||doc.pageTexts.flatMap(p=>extractSentences(p.text).map(text=>({page:p.page,text})));
  const sentences=units.map(u=>u.text).filter(Boolean);
  const terms=doc.terms;
  const defs=detectDefinitions(sentences,terms).map(d=>{const u=units.find(x=>x.text===d.definition);return {...d,page:u?.page||null};});
  const picked=pickDiverse(sentences,terms,22).map(x=>{const u=units.find(u=>u.text===x.s);return {text:x.s,page:u?.page||null};});
  const overview=pickDiverse(sentences,terms,5).map(x=>x.s).join(" ");
  const pages=[];
  for(const p of doc.pageTexts){
    const ps=p.text?extractSentences(p.text,24):[];
    if(!ps.length)continue;
    const top=pickDiverse(ps,terms,1)[0]?.s||ps[0];
    pages.push({page:p.page,text:top});
    if(pages.length>=30)break;
  }
  const questions=[];
  for(const d of defs.slice(0,8))questions.push(`What is ${d.term}, and how does the material define or explain it?`);
  for(const k of picked.slice(0,6))questions.push(`What is the main point of the statement on page ${k.page||"?"}?`);
  return {
    overview: overview || normalize(doc.rawText).slice(0,700),
    strategy: defs.length>=5 ? "Memorize the definitions first, then explain the key processes in your own words, then answer the study questions without looking back." : "Start with the key terms and high-scoring key points. Use the page numbers to revisit weak areas, then practice with the flashcards and quiz.",
    definitions: defs.slice(0,16),
    keyPoints: picked,
    pages,
    questions: questions.slice(0,14)
  };
}

function makeFlashcards(doc){
  const units=doc.units||[];const cards=[];const seen=new Set();
  const add=(type,question,answer,term,page)=>{
    const cleanQ=normalize(question),cleanA=normalize(answer);
    if(!cleanQ||!cleanA)return;
    const id=stableId("fc",`${doc.id}|${type}|${term||""}|${cleanQ}|${cleanA}`);
    if(seen.has(id))return;
    seen.add(id);cards.push({id,type,term:term||"",question:cleanQ,answer:cleanA,page:page||null});
  };
  const definitions=detectDefinitions(units.map(u=>u.text),doc.terms);
  for(const d of definitions){
    const u=units.find(x=>x.text===d.definition);
    add("definition",`What is "${d.term}"?`,d.definition,d.term,u?.page);
    if(cards.length>=18)break;
  }
  for(const term of doc.terms){
    const u=contextForTerm(term,units);if(!u)continue;
    const text=u.text;
    const escaped=term.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
    const re=new RegExp(`\\b${escaped}\\b`,"i");
    if(re.test(text)&&text.length>=45){
      const cloze=text.replace(re,"_____" );
      add("cloze",`Complete the statement: ${cloze}`,term,term,u.page);
    }
    add("explain",`Explain "${term}" using the information from the PDF.`,text,term,u.page);
    if(cards.length>=32)break;
  }
  for(const u of units){
    if(cards.length>=40)break;
    if(u.text.length<60)continue;
    add("main-idea","What is the main idea of this passage?",u.text,"",u.page);
  }
  return cards.slice(0,40);
}

function shuffle(arr){const a=[...arr];for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
function makeQuiz(doc){
  const units=doc.units||[];const defs=doc.reviewerData?.definitions||[];const terms=doc.terms||[];const quiz=[];const seen=new Set();
  const make=(question,context,correct,options,page,type)=>{
    const key=`${question}|${correct}|${page}`;if(seen.has(key))return;seen.add(key);
    const opts=shuffle([...new Set(options)]).slice(0,4);if(!opts.includes(correct))opts.unshift(correct);
    if(opts.length<2)return;
    quiz.push({id:stableId("q",`${doc.id}|${key}`),question,context,options:opts,correctIndex:opts.indexOf(correct),page,type});
  };
  for(const d of defs){
    const wrong=shuffle(terms.filter(t=>t.toLowerCase()!==d.term.toLowerCase())).slice(0,3);
    make(`Which concept is best described by this definition?`,d.definition,d.term,[d.term,...wrong],d.page,"definition");
    if(quiz.length>=10)break;
  }
  for(const term of terms){
    const u=contextForTerm(term,units);if(!u)continue;
    const wrong=shuffle(terms.filter(t=>t!==term)).slice(0,3);
    make(`Which term best completes the statement below?`,u.text,term,[term,...wrong],u.page,"concept");
    if(quiz.length>=18)break;
  }
  if(quiz.length<20){
    const candidates=pickDiverse(units.map(x=>x.text),terms,24);
    for(const picked of candidates){
      if(quiz.length>=20)break;
      const source=units.find(x=>x.text===picked.s);
      if(!source||source.text.length<70)continue;
      const wrongContexts=shuffle(units.filter(x=>x.text!==source.text&&x.text.length>=60).map(x=>x.text)).slice(0,3);
      make(`Which passage best matches the key idea being tested?`,source.text,source.text,[source.text,...wrongContexts],source.page,"passage");
    }
  }
  return quiz.slice(0,20);
}

async function extractPdf(file,progress){
  const ready=await loadPdfEngine();
  if(!ready)throw new Error("PDF.js could not be loaded. Connect to the internet once and try again.");
  const buffer=await file.arrayBuffer();
  const pdf=await window.pdfjsLib.getDocument({data:buffer}).promise;
  const pageTexts=[];const units=[];
  for(let pageNumber=1;pageNumber<=pdf.numPages;pageNumber++){
    const page=await pdf.getPage(pageNumber);const content=await page.getTextContent();
    const items=content.items.filter(x=>typeof x.str==="string"&&x.str.trim());
    items.sort((a,b)=>{const ay=a.transform?.[5]||0,by=b.transform?.[5]||0;if(Math.abs(by-ay)>3)return by-ay;return (a.transform?.[4]||0)-(b.transform?.[4]||0)});
    const lines=[];let current="";let lastY=null;
    for(const item of items){
      const y=item.transform?.[5]||0;
      if(lastY!==null&&Math.abs(y-lastY)>3){if(current.trim())lines.push(current.trim());current="";}
      current+=`${current?" ":""}${item.str.trim()}`;lastY=y;
    }
    if(current.trim())lines.push(current.trim());
    const text=normalize(lines.join("\n"));
    pageTexts.push({page:pageNumber,text});
    for(const s of extractSentences(text,24))units.push({page:pageNumber,text:s});
    progress?.(pageNumber,pdf.numPages);
  }
  return {pageCount:pdf.numPages,pageTexts,units,rawText:pageTexts.map(p=>`Page ${p.page}\n${p.text}`).join("\n\n")};
}

function normalizeDoc(raw){
  const d={...raw};
  d.id=d.id||uid();
  d.fileName=String(d.fileName||"Untitled PDF");
  d.pageCount=Number(d.pageCount)||0;
  d.pageTexts=Array.isArray(d.pageTexts)?d.pageTexts:[];
  d.rawText=String(d.rawText||d.pageTexts.map(p=>p.text||"").join("\n\n"));
  d.units=Array.isArray(d.units)?d.units:d.pageTexts.flatMap(p=>extractSentences(p.text||"").map(text=>({page:p.page,text})));
  d.terms=Array.isArray(d.terms)&&d.terms.length?d.terms:extractTerms(d.rawText);
  d.reviewerData=d.reviewerData||buildReviewer(d);
  d.reviewerText=d.reviewerText||buildReviewerText(d);
  d.flashcards=Array.isArray(d.flashcards)&&d.flashcards.length?d.flashcards:makeFlashcards(d);
  d.flashcards=d.flashcards.map((c,i)=>({...c,id:c.id||stableId("fc",`${d.id}|${i}|${c.question||""}|${c.answer||""}`)}));
  d.currentCard=clamp(Number(d.currentCard)||0,0,Math.max(0,d.flashcards.length-1));
  d.knownCardIds=Array.isArray(d.knownCardIds)?d.knownCardIds.filter(id=>d.flashcards.some(c=>c.id===id)):[];
  d.quiz=Array.isArray(d.quiz)&&d.quiz.length?d.quiz:makeQuiz(d);
  d.quiz=d.quiz.map((q,i)=>{const options=Array.isArray(q.options)?q.options:[];const ci=Number.isInteger(q.correctIndex)?q.correctIndex:options.indexOf(q.correct);return {...q,id:q.id||stableId("q",`${d.id}|${i}|${q.question||""}`),options,correctIndex:clamp(ci>=0?ci:0,0,Math.max(0,options.length-1)),correct:options[ci>=0?ci:0]||q.correct||""};});
  d.quizHistory=Array.isArray(d.quizHistory)?d.quizHistory:[];
  d.quizScore=Number.isFinite(d.quizScore)?d.quizScore:null;
  d.notesTitle=String(d.notesTitle||"Study Notes");
  d.notesHtml=safeNoteHtml(d.notesHtml||plainToHtml(String(d.notes||"")));
  d.notes=stripHtml(d.notesHtml);
  d.notesUpdatedAt=d.notesUpdatedAt||"";
  d.createdAt=d.createdAt||now();d.updatedAt=d.updatedAt||now();
  return d;
}
function plainToHtml(text){return normalize(text).split(/\n\n+/).map(p=>`<p>${esc(p).replace(/\n/g,"<br>")}</p>`).join("")||"<p></p>";}
function stripHtml(html){const box=document.createElement("div");box.innerHTML=html||"";return normalize(box.innerText||box.textContent||"");}
function safeNoteHtml(html){return String(html||"").replace(/<script[\s\S]*?<\/script>/gi,"").replace(/ on\w+\s*=\s*(['"]).*?\1/gi,"");}
function buildReviewerText(doc){
  const r=doc.reviewerData||buildReviewer(doc);
  return [
    `STUDY REVIEWER\n${doc.fileName}`,
    `AT A GLANCE\n${r.overview}`,
    `STUDY STRATEGY\n${r.strategy}`,
    `KEY TERMS\n${doc.terms.map((t,i)=>`${i+1}. ${t}`).join("\n")}`,
    `DEFINITIONS & EXPLANATIONS\n${r.definitions.map(d=>`${d.term}: ${d.definition}${d.page?` (Page ${d.page})`:""}`).join("\n\n")||"No clean definitions detected; use the context cards below."}`,
    `KEY POINTS\n${r.keyPoints.map((k,i)=>`${i+1}. ${k.text}${k.page?` (Page ${k.page})`:""}`).join("\n\n")}`,
    `STUDY QUESTIONS\n${r.questions.map((q,i)=>`${i+1}. ${q}`).join("\n")}`,
    `PAGE HIGHLIGHTS\n${r.pages.map(p=>`Page ${p.page}: ${p.text}`).join("\n\n")}`
  ].join("\n\n");
}
function regenerateDoc(doc,resetProgress=false){
  doc.terms=extractTerms(doc.rawText);doc.reviewerData=buildReviewer(doc);doc.reviewerText=buildReviewerText(doc);doc.flashcards=makeFlashcards(doc);doc.quiz=makeQuiz(doc);doc.currentCard=0;
  if(resetProgress){doc.knownCardIds=[];doc.quizScore=null;}
}

function renderLibrary(){
  const box=$("#library");
  if(!state.documents.length)return box.innerHTML='<div class="empty">Your PDFs will appear here.</div>';
  box.innerHTML=state.documents.map(d=>`<div class="doc ${d.id===state.activeDocId?'active':''}"><div class="doc-icon">📘</div><div class="doc-main"><div class="doc-name">${esc(d.fileName)}</div><div class="doc-meta">${d.pageCount} pages • ${wordCount(d.rawText).toLocaleString()} words • ${d.terms.length} terms</div></div><div class="doc-actions"><button class="btn small secondary" data-open="${esc(d.id)}">Open</button><button class="btn small danger" data-delete="${esc(d.id)}">Delete</button></div></div>`).join('');
  box.querySelectorAll('[data-open]').forEach(b=>b.onclick=async()=>{state.activeDocId=b.dataset.open;await saveMeta();renderAll();activateSection('dashboard');});
  box.querySelectorAll('[data-delete]').forEach(b=>b.onclick=async()=>{const d=state.documents.find(x=>x.id===b.dataset.delete);if(!d)return;if(!confirm(`Delete ${d.fileName}?`))return;await dbDelete(DOC_STORE,d.id);state.documents=state.documents.filter(x=>x.id!==d.id);state.activeDocId=state.documents[0]?.id||null;await saveMeta();renderAll();toast('Document deleted.','success');});
}
function renderStats(){
  const docs=state.documents;$("#stats").classList.toggle('hidden',!docs.length);
  $("#statDocs").textContent=docs.length;
  $("#statPages").textContent=docs.reduce((a,d)=>a+d.pageCount,0).toLocaleString();
  $("#statWords").textContent=docs.reduce((a,d)=>a+wordCount(d.rawText),0).toLocaleString();
  $("#statTerms").textContent=activeDoc()?.terms.length||0;
  $("#statFlash").textContent=activeDoc()?.flashcards.length||0;
  $("#statQuiz").textContent=activeDoc()?.quiz.length||0;
  $("#navFlash").textContent=activeDoc()?.flashcards.length||0;
  $("#navQuiz").textContent=activeDoc()?.quiz.length||0;
}
function renderActivePanel(){
  const d=activeDoc(),box=$("#activeDocPanel");
  if(!d){box.innerHTML='<div class="empty">Add a PDF to start studying.</div>';return;}
  const known=d.knownCardIds.length,total=d.flashcards.length,progress=total?Math.round(known/total*100):0;
  box.innerHTML=`<div class="doc" style="margin-bottom:12px"><div class="doc-icon">📘</div><div class="doc-main"><div class="doc-name">${esc(d.fileName)}</div><div class="doc-meta">${d.pageCount} pages • ${wordCount(d.rawText).toLocaleString()} words • Updated ${new Date(d.updatedAt).toLocaleString()}</div></div></div><p class="muted" style="line-height:1.65">${esc(d.reviewerData?.overview||'')}</p><div style="margin-top:14px"><div style="display:flex;justify-content:space-between;gap:10px;font-size:.75rem;color:var(--muted)"><span>Flashcard progress</span><span>${known}/${total} (${progress}%)</span></div><div class="progress-track" style="margin-top:6px"><div class="progress-bar" style="width:${progress}%"></div></div></div><div class="row" style="margin-top:14px"><button class="btn primary small" data-go="reviewer">Reviewer</button><button class="btn secondary small" data-go="flashcards">Flashcards</button><button class="btn secondary small" data-go="quiz">Quiz</button><button id="regenDocBtn" class="btn warning small">Regenerate</button></div>`;
  box.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>activateSection(b.dataset.go));
  $("#regenDocBtn").onclick=async()=>{regenerateDoc(d,true);await saveDoc(d);renderAll();toast('Reviewer, flashcards, and quiz regenerated.','success');};
}
function renderTerms(){const c=$("#reviewerTerms"),terms=activeDoc()?.terms||[];c.innerHTML=terms.length?terms.map(t=>`<span class="term">${esc(t)}</span>`).join(''):'<div class="empty">No terms detected.</div>';}
function renderReviewer(){
  const d=activeDoc(),r=d?.reviewerData;
  $("#reviewerOverview").textContent=r?.overview||'Select a document.';
  $("#reviewerStrategy").textContent=r?.strategy||'Upload a PDF to create a study strategy.';
  renderTerms();
  const defs=$("#reviewerDefinitions");defs.innerHTML=r?.definitions?.length?r.definitions.map(x=>`<div class="definition-card"><strong>${esc(x.term)}</strong><span>${esc(x.definition)}${x.page?` <span class="tiny">Page ${x.page}</span>`:''}</span></div>`).join(''):'<div class="empty">No clean definition sentences were detected. The flashcards will fall back to contextual explanations.</div>';
  const points=$("#reviewerKeyPoints");points.innerHTML=r?.keyPoints?.length?r.keyPoints.map(x=>`<li>${esc(x.text)}${x.page?`<span class="meta">Page ${x.page}</span>`:''}</li>`).join(''):'<li class="empty">No key points yet.</li>';
  const qs=$("#reviewerQuestions");qs.innerHTML=r?.questions?.length?r.questions.map(q=>`<div class="study-question">${esc(q)}</div>`).join(''):'<div class="empty">No study questions yet.</div>';
  const pages=$("#reviewerPages");pages.innerHTML=r?.pages?.length?r.pages.map(p=>`<li><strong>Page ${p.page}</strong><div style="margin-top:5px">${esc(p.text)}</div></li>`).join(''):'<li class="empty">No page highlights.</li>';
}
function renderFlash(){
  const d=activeDoc();
  if(!d||!d.flashcards.length){$("#flashPosition").textContent='Select a document.';$("#flashQuestion").textContent='Your flashcards will appear here.';$("#flashAnswer").classList.add('hidden');$("#flashStatus").textContent='NOT STARTED';$("#flashKnown").textContent='Unmarked';return;}
  d.currentCard=clamp(d.currentCard||0,0,d.flashcards.length-1);
  const c=d.flashcards[d.currentCard],known=d.knownCardIds.includes(c.id);
  $("#flashPosition").textContent=`Card ${d.currentCard+1} of ${d.flashcards.length}${c.page?` • Page ${c.page}`:''}`;
  $("#flashStatus").textContent=`${String(c.type).toUpperCase()} • CARD ${d.currentCard+1}`;
  $("#flashKnown").textContent=known?'✓ Known':'Unmarked';
  $("#flashQuestion").textContent=c.question;$("#flashAnswer").textContent=c.answer;$("#flashAnswer").classList.add('hidden');$("#knowFlash").disabled=known;
}
function renderQuiz(){
  const d=activeDoc(),ctn=$("#quizContainer");
  if(!d||!d.quiz.length){ctn.innerHTML='<div class="card empty">Add a PDF to build a quiz.</div>';$("#quizResult").classList.add('hidden');renderQuizHistory(d);return;}
  ctn.innerHTML=d.quiz.map((q,i)=>`<article class="quiz-item" data-q="${i}"><p class="q">${i+1}. ${esc(q.question)}</p><div class="context">${esc(q.context)}${q.page?` <span class="tiny">Page ${q.page}</span>`:''}</div>${q.options.map((o,j)=>`<label class="option"><input type="radio" name="q-${i}" value="${j}"><span>${esc(o)}</span></label>`).join('')}</article>`).join('');
  if(d.quizScore===null)$("#quizResult").classList.add('hidden');
  renderQuizHistory(d);
}
function renderQuizHistory(d){
  const h=$("#quizHistory");
  if(!d?.quizHistory?.length){h.innerHTML='<div class="empty">No attempts yet.</div>';return;}
  h.innerHTML=d.quizHistory.slice().reverse().slice(0,15).map(x=>`<div class="history-item"><span>${new Date(x.at).toLocaleString()}</span><strong>${x.score}/${x.total} (${x.percent}%)</strong></div>`).join('');
}
function renderDashboard(){renderStats();renderLibrary();renderActivePanel();$("#libraryStatus").textContent=state.documents.length?`${state.documents.length} PDF${state.documents.length===1?'':'s'} stored locally.`:'No PDF loaded yet.';}
function renderNotes(){
  const d=activeDoc(), editor=$("#notesEditor"),title=$("#notesTitle");
  editor.contentEditable=!!d;editor.innerHTML=d?.notesHtml||'<p></p>';title.value=d?.notesTitle||'';title.disabled=!d;$("#notesDocLabel").textContent=d?`Notes for ${d.fileName}`:'Notes are stored per document.';$("#noteDocumentHint").textContent=d?d.fileName:'Select a PDF to begin.';$("#noteWordCount").textContent=`${wordCount(stripHtml(editor.innerHTML))} words`;$("#noteUpdatedAt").textContent=d?.notesUpdatedAt?`Saved ${new Date(d.notesUpdatedAt).toLocaleTimeString()}`:'Not saved yet';
}
function renderAll(){renderDashboard();renderReviewer();renderFlash();renderQuiz();renderNotes();applyTheme();}

function escapeRegExp(text){return String(text).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
function highlight(text,q){const safe=esc(text);if(!q)return safe;const e=escapeRegExp(q);return safe.replace(new RegExp(`(${e})`,'gi'),'<mark>$1</mark>');}
function searchActive(q){
  const d=activeDoc(),box=$("#searchResults");
  if(!d)return box.innerHTML='<div class="empty">Select a document first.</div>';
  q=q.trim();if(!q)return box.innerHTML='<div class="empty">Type a search term.</div>';
  const low=q.toLowerCase(),matches=[];
  for(const p of d.pageTexts){
    const t=p.text||"",l=t.toLowerCase();let idx=l.indexOf(low);
    while(idx>=0&&matches.length<80){const start=Math.max(0,idx-120),end=Math.min(t.length,idx+q.length+200);matches.push({page:p.page,snippet:t.slice(start,end),before:start?'…':'',after:end<t.length?'…':''});idx=l.indexOf(low,idx+Math.max(1,q.length));}
  }
  if(!matches.length)return box.innerHTML='<div class="empty">No match found.</div>';
  box.innerHTML=matches.map(m=>`<div class="result"><span class="page">Page ${m.page}</span><div>${m.before}${highlight(m.snippet,q)}${m.after}</div></div>`).join('');
}

function selectNoteCommand(cmd,value){
  const editor=$("#notesEditor");editor.focus();
  if(cmd==="formatBlock")document.execCommand(cmd,false,`<${value}>`);else document.execCommand(cmd,false,null);
  scheduleNoteSave();
}
function insertAtCursor(html){
  const editor=$("#notesEditor");editor.focus();
  document.execCommand('insertHTML',false,html);scheduleNoteSave();
}
function scheduleNoteSave(){
  const d=activeDoc();if(!d)return;
  const token=++noteSaveToken;$("#noteSaveStatus").textContent='Saving…';
  setTimeout(async()=>{
    if(token!==noteSaveToken)return;
    const doc=state.documents.find(x=>x.id===d.id);if(!doc)return;
    doc.notesTitle=$("#notesTitle").value.trim()||'Study Notes';
    doc.notesHtml=safeNoteHtml($("#notesEditor").innerHTML||'<p></p>');
    doc.notes=stripHtml(doc.notesHtml);doc.notesUpdatedAt=now();await saveDoc(doc);
    if(activeDoc()?.id===doc.id){$("#noteSaveStatus").textContent='Saved';$("#noteWordCount").textContent=`${wordCount(doc.notes)} words`;$("#noteUpdatedAt").textContent=`Saved ${new Date(doc.notesUpdatedAt).toLocaleTimeString()}`;}
  },500);
}
function exportNotes(){
  const d=activeDoc();if(!d)return toast('Select a document first.','error');
  const txt=`${d.notesTitle}\n\n${d.notes}\n`;
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([txt],{type:'text/plain;charset=utf-8'}));a.download=`${d.fileName.replace(/\.pdf$/i,'')}-notes.txt`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),500);toast('Notes exported.','success');
}

async function copyReviewer(){const d=activeDoc();if(!d)return toast('Select a document first.','error');try{await navigator.clipboard.writeText(d.reviewerText);toast('Reviewer copied.','success')}catch{toast('Clipboard access was blocked.','error')}}
function downloadText(filename,text){const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),500);}
function downloadReviewer(){const d=activeDoc();if(!d)return toast('Select a document first.','error');downloadText(`${d.fileName.replace(/\.pdf$/i,'')}-reviewer.txt`,d.reviewerText);toast('Reviewer downloaded.','success')}

async function submitQuiz(){
  const d=activeDoc();if(!d)return toast('Select a document first.','error');
  let score=0;
  d.quiz.forEach((q,i)=>{const item=document.querySelector(`[data-q="${i}"]`),picked=document.querySelector(`input[name="q-${i}"]:checked`);if(!item)return;item.classList.remove('correct','wrong');if(picked&&Number(picked.value)===q.correctIndex){score++;item.classList.add('correct')}else item.classList.add('wrong');});
  d.quizScore=score;d.quizHistory=d.quizHistory||[];const percent=d.quiz.length?Math.round(score/d.quiz.length*100):0;d.quizHistory.push({at:now(),score,total:d.quiz.length,percent});await saveDoc(d);
  $("#quizResult").classList.remove('hidden');$("#quizResult").innerHTML=`<div class="score">${percent}%</div><p>You scored <strong>${score}/${d.quiz.length}</strong>.</p><p class="muted">Use the page numbers on missed questions to review the exact material before trying a new quiz.</p>`;renderQuizHistory(d);toast(`Quiz completed: ${score}/${d.quiz.length}.`,'success');
}
async function newQuiz(){const d=activeDoc();if(!d)return toast('Select a document first.','error');d.quiz=makeQuiz(d);d.quizScore=null;await saveDoc(d);renderQuiz();renderStats();toast('New quiz generated.','success');}
async function moveFlash(delta){const d=activeDoc();if(!d?.flashcards.length)return;d.currentCard=(d.currentCard+delta+d.flashcards.length)%d.flashcards.length;await saveDoc(d);renderFlash();renderDashboard();}
async function markKnown(known){const d=activeDoc();if(!d?.flashcards.length)return;const id=d.flashcards[d.currentCard].id;if(known&&!d.knownCardIds.includes(id))d.knownCardIds.push(id);if(!known)d.knownCardIds=d.knownCardIds.filter(x=>x!==id);await saveDoc(d);renderFlash();renderDashboard();}

function applyTheme(){document.body.classList.toggle('light',state.settings.theme==='light');}
async function setTheme(theme){state.settings.theme=theme==='light'?'light':'dark';await saveMeta();applyTheme();toast(`${state.settings.theme==='light'?'Light':'Dark'} mode enabled.`,'success');}

function exportBackup(){
  const payload={app:'StudyVault',version:APP_VERSION,exportedAt:now(),settings:{theme:state.settings.theme},documents:state.documents};
  downloadText(`studyvault-backup-${new Date().toISOString().slice(0,10)}.json`,JSON.stringify(payload,null,2));toast('Backup exported.','success');
}
async function importBackup(){
  const file=$("#backupInput").files[0];if(!file)return toast('Choose a JSON backup first.','error');
  try{
    const data=JSON.parse(await file.text());if(data.app!=='StudyVault')throw new Error('Invalid StudyVault backup.');
    const incoming=Array.isArray(data.documents)?data.documents:(data.data?.fileName?[data.data]:null);if(!incoming)throw new Error('No StudyVault documents found in this backup.');
    for(const raw of incoming){const d=normalizeDoc(raw);await dbPut(DOC_STORE,d);}
    state.documents=(await dbGetAll(DOC_STORE)).map(normalizeDoc);state.activeDocId=state.documents[0]?.id||null;state.settings.theme=data.settings?.theme==='light'?'light':'dark';await saveMeta();$("#importModal").classList.remove('open');$("#backupInput").value='';renderAll();toast('Backup imported.','success');
  }catch(e){console.error(e);toast(e.message||'Import failed.','error');}
}
async function resetAll(){if(!confirm('Delete ALL StudyVault data from this browser? This removes every document, note, quiz history, and PIN.'))return;await dbClear();location.reload();}

async function processFiles(files){
  const list=[...files].filter(Boolean);if(!list.length)return;
  for(const file of list){
    if(file.type!=='application/pdf'){toast(`${file.name}: not a PDF.`,'error');continue;}
    $("#upload").innerHTML=`<div class="loading"><span class="spinner"></span><span id="processStatus">Reading ${esc(file.name)}…</span></div>`;
    try{
      const extracted=await extractPdf(file,(page,total)=>{$("#processStatus").textContent=`Reading ${file.name} — page ${page} of ${total}…`;});
      if(wordCount(extracted.rawText)<20)throw new Error('This PDF has little or no selectable text. Image-only/scanned PDFs need OCR.');
      const doc={id:uid(),fileName:file.name,pageCount:extracted.pageCount,pageTexts:extracted.pageTexts,units:extracted.units,rawText:extracted.rawText,terms:extractTerms(extracted.rawText),reviewerData:null,reviewerText:'',flashcards:[],currentCard:0,knownCardIds:[],notesTitle:'Study Notes',notesHtml:'<p></p>',notes:'',notesUpdatedAt:'',quiz:[],quizScore:null,quizHistory:[],createdAt:now(),updatedAt:now()};
      doc.reviewerData=buildReviewer(doc);doc.reviewerText=buildReviewerText(doc);doc.flashcards=makeFlashcards(doc);doc.quiz=makeQuiz(doc);
      state.documents.unshift(doc);state.activeDocId=doc.id;await dbPut(DOC_STORE,doc);await saveMeta();renderAll();activateSection('dashboard');toast(`${file.name} added successfully.`,'success');
    }catch(e){console.error(e);toast(`${file.name}: ${e.message||'Could not process PDF.'}`,'error');}
  }
  $("#upload").innerHTML='<div><div class="upload-icon">📄</div><h3>Drop PDF files here</h3><p>You can add several PDFs. Each document gets its own reviewer, flashcards, quiz history, and notes.</p><label for="pdfInput" class="btn primary">Choose PDF files</label></div>';
}

function setupDrop(){
  const u=$("#upload");
  ['dragenter','dragover'].forEach(ev=>u.addEventListener(ev,e=>{e.preventDefault();u.classList.add('drag')}));
  ['dragleave','drop'].forEach(ev=>u.addEventListener(ev,e=>{e.preventDefault();u.classList.remove('drag')}));
  u.addEventListener('drop',e=>processFiles(e.dataTransfer.files));
}
function setupInstall(){
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstall=e;$("#installBtn").disabled=false;});
  $("#installBtn").onclick=async()=>{if(!deferredInstall)return toast('Use your browser menu to install the app after it becomes installable.');await deferredInstall.prompt();deferredInstall=null;};
}
function bind(){
  $("#pdfInput").addEventListener('change',e=>{processFiles(e.target.files);e.target.value='';});
  $$('[data-section]').forEach(b=>b.addEventListener('click',()=>activateSection(b.dataset.section)));
  $("#openReviewer").onclick=()=>activateSection('reviewer');
  $("#copyReviewer").onclick=copyReviewer;$("#downloadReviewer").onclick=downloadReviewer;$("#regenerateReviewer").onclick=async()=>{const d=activeDoc();if(!d)return toast('Select a document first.','error');regenerateDoc(d,true);await saveDoc(d);renderAll();toast('Reviewer, flashcards, and quiz regenerated.','success');};
  $("#prevFlash").onclick=()=>moveFlash(-1);$("#nextFlash").onclick=()=>moveFlash(1);$("#showFlashAnswer").onclick=()=>activeDoc()&&$("#flashAnswer").classList.remove('hidden');$("#knowFlash").onclick=()=>markKnown(true);$("#reviewFlash").onclick=()=>markKnown(false);
  $("#submitQuiz").onclick=submitQuiz;$("#newQuiz").onclick=newQuiz;
  $("#searchInput").addEventListener('input',debounce(e=>searchActive(e.target.value),180));
  $("#notesEditor").addEventListener('input',()=>{const d=activeDoc();if(!d)return;$("#noteWordCount").textContent=`${wordCount(stripHtml($("#notesEditor").innerHTML))} words`;scheduleNoteSave();});
  $("#notesTitle").addEventListener('input',scheduleNoteSave);
  $$('[data-note-cmd]').forEach(b=>b.onclick=()=>selectNoteCommand(b.dataset.noteCmd,b.dataset.noteValue));
  $("#insertChecklist").onclick=()=>insertAtCursor('<p>☐ </p>');
  $("#insertDefinitionNote").onclick=()=>insertAtCursor('<blockquote><strong>Definition:</strong> Write the concept and its meaning here.</blockquote>');
  $("#insertQuestionNote").onclick=()=>insertAtCursor('<blockquote><strong>Exam question:</strong> </blockquote>');
  $("#exportNotesBtn").onclick=exportNotes;
  $("#clearNotesBtn").onclick=async()=>{const d=activeDoc();if(!d)return;if(!confirm('Clear the notes for this document?'))return;d.notesTitle='Study Notes';d.notesHtml='<p></p>';d.notes='';d.notesUpdatedAt=now();await saveDoc(d);renderNotes();toast('Notes cleared.','success');};
  $("#themeBtn").onclick=()=>setTheme(state.settings.theme==='dark'?'light':'dark');$("#darkMode").onclick=()=>setTheme('dark');$("#lightMode").onclick=()=>setTheme('light');
  $("#lockBtn").onclick=lockApp;$("#settingsLock").onclick=lockApp;$("#pinSettings").onclick=openPin;$("#savePin").onclick=setPin;$("#removePin").onclick=removePin;$("#closePin").onclick=closePin;$("#unlockBtn").onclick=unlockApp;$("#unlockPin").addEventListener('keydown',e=>{if(e.key==='Enter')unlockApp();});
  $("#resetBtn").onclick=resetAll;$("#exportBtn").onclick=exportBackup;$("#openImport").onclick=()=>$("#importModal").classList.add('open');$("#closeImport").onclick=()=>$("#importModal").classList.remove('open');$("#importBackup").onclick=importBackup;
  $("#pinModal").addEventListener('click',e=>{if(e.target.id==='pinModal')closePin();});$("#importModal").addEventListener('click',e=>{if(e.target.id==='importModal')$("#importModal").classList.remove('open');});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){closePin();$("#importModal").classList.remove('open');}if(e.target.matches('input,textarea,select,[contenteditable="true"]'))return;if($("#flashcards").classList.contains('active')){if(e.key==='ArrowRight')moveFlash(1);if(e.key==='ArrowLeft')moveFlash(-1);if(e.key===' ')e.preventDefault(),$("#showFlashAnswer").click();}});
}

async function load(){
  try{
    const meta=await dbGet(META_STORE,SETTINGS_KEY);
    if(meta){state.settings={...state.settings,...meta};state.activeDocId=meta.activeDocId||null;}
    state.documents=(await dbGetAll(DOC_STORE)).map(normalizeDoc);
    for(const d of state.documents)await dbPut(DOC_STORE,d);
    if(!state.activeDocId)state.activeDocId=state.documents[0]?.id||null;
    await saveMeta();renderAll();setupDrop();setupInstall();
    if(state.settings.pinHash)lockApp();
  }catch(e){console.error(e);toast('StudyVault could not initialize IndexedDB.','error');}
}

bind();
loadPdfEngine();
if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./service-worker.js').catch(err=>console.warn('Service worker registration failed:',err)));
load();
})();
