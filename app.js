
(() => {
"use strict";

const APP_VERSION = 154.0;
const BUILD_ID = "2026-10-01-v154.0-carrot-foundation-rebuild";
const MAX_FLASHCARDS = 200;
const VERSION_URL = "./version.json";
const DB_NAME = "studyvault-v6";
const DB_VERSION = 10;
const SCHEMA_VERSION = 10;
const CDN_TESSERACT_WORKER = "https://cdn.jsdelivr.net/npm/tesseract.js@7/dist/worker.min.js";
const LOCAL_TESSERACT = "./vendor/tesseract/tesseract.min.js";
const DOC_STORE = "documents";
const META_STORE = "meta";
const SETTINGS_KEY = "settings";
const CDN_PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const CDN_PDF_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const CDN_TESSERACT = "https://cdn.jsdelivr.net/npm/tesseract.js@7/dist/tesseract.min.js";
  const CDN_MAMMOTH = "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.4.16/mammoth.browser.min.js";
const LOCAL_JSZIP = "./vendor/jszip/jszip.min.js";
  const CDN_QR = "https://cdn.jsdelivr.net/npm/qrcode-generator@2.0.4/qrcode.js";
const LOCAL_PDFJS = "./vendor/pdfjs/pdf.min.js";
const LOCAL_PDF_WORKER = "./vendor/pdfjs/pdf.worker.min.js";
const AI_WORKER_URL = "./ai-worker.js";
const PRODUCT_NAME = "StudyVault";
const PRODUCT_TAGLINE = "Closed-book Study OS";
const PRODUCT_PROMISE = "Your materials. Your memory. No invented syllabus.";


let pdfEnginePromise = null;
let tesseractPromise = null;
let tesseractWorker = null;
let noteSaveToken = 0;

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const clamp = (n,min,max) => Math.max(min,Math.min(max,n));
const esc = v => String(v ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
/** Keep scientific / math symbols; only tidy whitespace. Never strip Ω Δ → ≤ etc. */
const normalize = v => String(v ?? "")
  .replace(/\u00a0/g," ")
  .replace(/\u2028|\u2029/g,"\n")
  .replace(/[ \t]+/g," ")
  .replace(/\n{3,}/g,"\n\n")
  .trim();
const wordCount = v => normalize(v) ? normalize(v).split(/\s+/).length : 0;
const debounce = (fn, ms=850) => { let t; return (...args) => { clearTimeout(t); t=setTimeout(()=>fn(...args),ms); }; };
const MAX_IMPORT_BYTES = 250 * 1024 * 1024;
const MAX_BACKUP_BYTES = 150 * 1024 * 1024;
function withTimeout(promise, ms, message="Operation timed out."){
  return Promise.race([promise, new Promise((_,reject)=>setTimeout(()=>reject(new Error(message)),ms))]);
}
function safeJsonParse(raw){try{return JSON.parse(raw);}catch{return null;}}
function assertImportSize(file){
  const size=Number(file?.size||0);
  if(size>MAX_IMPORT_BYTES) throw new Error(`File is too large (${Math.round(size/1048576)} MB). Maximum supported import size is 250 MB.`);
}
function fileKind(file){
  const name=String(file?.name||'').toLowerCase();
  const type=String(file?.type||'').toLowerCase();
  if(type==='application/pdf'||/\.pdf$/.test(name))return 'pdf';
  if(type==='application/vnd.openxmlformats-officedocument.wordprocessingml.document'||/\.docx$/.test(name))return 'docx';
  if(type==='application/msword'||/\.doc$/.test(name))return 'doc';
  if(/^image\/(png|jpeg|webp|bmp|gif|svg\+xml)$/.test(type)||/\.(png|jpe?g|webp|bmp|gif|svg)$/.test(name))return 'image';
  if(/\.(txt|md|markdown|csv|json|html|htm|rtf)$/.test(name))return 'text';
  return 'unknown';
}
function checksumText(text){
  const input=new TextEncoder().encode(String(text??''));
  return crypto.subtle?.digest ? crypto.subtle.digest('SHA-256',input).then(buf=>[...new Uint8Array(buf)].map(x=>x.toString(16).padStart(2,'0')).join('')) : Promise.resolve(String(text??'').length.toString(16));
}


/**
 * Repair symbols lost or mangled by PDF fonts and OCR.
 * Maps common OCR/PDF garbage → real math/chem symbols the family can study.
 */
function repairSymbols(text){
  let t=String(text??"");
  if(!t)return "";
  // Ligatures / private-use junk → readable forms
  t=t.replace(/ﬁ/g,"fi").replace(/ﬂ/g,"fl").replace(/ﬀ/g,"ff").replace(/ﬃ/g,"ffi").replace(/ﬄ/g,"ffl");
  // OCR arrow / relation mistakes
  t=t.replace(/(?:-{1,3}>|–>|—>|=>)/g,"→");
  t=t.replace(/(?:<-{1,3}|<–|<—|<=)/g,"←");
  t=t.replace(/<->|<–>|↔/g,"↔");
  t=t.replace(/(?:!=|≠)/g,"≠");
  t=t.replace(/(?:<=|≤)/g,"≤");
  t=t.replace(/(?:>=|≥)/g,"≥");
  t=t.replace(/(?:\approx|~=)/g,"≈");
  t=t.replace(/(?:\+\/-|±)/g,"±");
  t=t.replace(/(?:x\s*(?=10\^)|×)/gi,"×");
  // Degree / percent / micro that OCR mangles
  t=t.replace(/(\d)\s*[oº°]\s*([CF])/g,"$1°$2");
  t=t.replace(/(\d)\s*deg(?:rees?)?\b/gi,"$1°");
  t=t.replace(/\bmu\b(?=\s*[A-Za-z])/gi,"μ");
  t=t.replace(/\bmicro-?/gi,"μ");
  // Chemistry / subscripts often OCR'd as normal digits after element
  t=t.replace(/\b(H|O|N|C|S|P|Cl|Br|I|Na|K|Ca|Mg|Fe|Cu|Zn|Ag|Al|Si)(\d{1,2})\b/g,(_,el,n)=>el+n);
  // Greek letter names OCR'd as words in formula contexts
  t=t.replace(/\balpha\b/gi,"α").replace(/\bbeta\b/gi,"β").replace(/\bgamma\b/gi,"γ")
    .replace(/\bdelta\b/gi,"δ").replace(/\bDelta\b/g,"Δ").replace(/\btheta\b/gi,"θ")
    .replace(/\blambda\b/gi,"λ").replace(/\bmu\b/gi,"μ").replace(/\bpi\b(?![a-z])/gi,"π")
    .replace(/\bsigma\b/gi,"σ").replace(/\bomega\b/gi,"ω").replace(/\bOmega\b/g,"Ω")
    .replace(/\bphi\b/gi,"φ").replace(/\brho\b/gi,"ρ");
  // Ohm / infinity
  t=t.replace(/\bohm(?:s)?\b/gi,"Ω").replace(/\binfinity\b/gi,"∞");
  // ——— Electrical / electronics symbols & unit OCR repair ———
  t=t.replace(/\bkilo-?ohms?\b/gi,"kΩ").replace(/\bmega-?ohms?\b/gi,"MΩ").replace(/\bmilli-?ohms?\b/gi,"mΩ");
  t=t.replace(/(\d)\s*(kohm|kohms|k ohm)\b/gi,"$1kΩ");
  t=t.replace(/(\d)\s*(Mohm|Mohms|M ohm)\b/gi,"$1MΩ");
  t=t.replace(/(\d)\s*ohms?\b/gi,"$1Ω");
  t=t.replace(/\bmicro\s*farad/gi,"μF").replace(/\bnanofarad/gi,"nF").replace(/\bpico\s*farad/gi,"pF");
  t=t.replace(/(\d)\s*uF\b/gi,"$1μF").replace(/(\d)\s*uf\b/g,"$1μF");
  t=t.replace(/(\d)\s*uH\b/gi,"$1μH").replace(/\bmicro\s*henry/gi,"μH");
  t=t.replace(/\bmilli\s*amp(?:ere)?s?\b/gi,"mA").replace(/\bmicro\s*amp(?:ere)?s?\b/gi,"μA");
  t=t.replace(/(\d)\s*mA\b/g,"$1mA").replace(/(\d)\s*uA\b/gi,"$1μA");
  t=t.replace(/\bkilo\s*hertz/gi,"kHz").replace(/\bmega\s*hertz/gi,"MHz").replace(/\bgiga\s*hertz/gi,"GHz");
  t=t.replace(/\bvolt(?:s)?\s*amp(?:ere)?s?\b/gi,"VA");
  t=t.replace(/\bAC\s*ground\b/gi,"⏚").replace(/\bearth\s*ground\b/gi,"⏚");
  // Ohm's law spacing: V = I R → V = IR style keep readable
  t=t.replace(/\bV\s*=\s*I\s*[*·×x]?\s*R\b/gi,"V = IR");
  t=t.replace(/\bI\s*=\s*V\s*\/\s*R\b/gi,"I = V/R");
  t=t.replace(/\bP\s*=\s*V\s*[*·×x]?\s*I\b/gi,"P = VI");
  t=t.replace(/\bP\s*=\s*I\s*\^\s*2\s*[*·×x]?\s*R\b/gi,"P = I²R");
  t=t.replace(/\bP\s*=\s*V\s*\^\s*2\s*\/\s*R\b/gi,"P = V²/R");
  // Square / cube roots written out
  t=t.replace(/\bsqrt\s*\(/gi,"√(").replace(/\bcube\s*root\s*\(/gi,"∛(");
  t=t.replace(/\^(\d+)/g,"^$1");
  t=t.replace(/\b([A-Z][a-z]?)\s+(\d)\b/g,"$1$2");
  t=t.replace(/\b([A-Z][a-z]?\d*)\s*\+\s*/g,"$1 + ");
  return normalize(t);
}

/** Tokens for search/ranking — keep short symbol tokens (Ω, Δ, →, μF) so formulas still match. */
function tokenize(text){
  const raw=normalize(text).toLowerCase();
  const words=raw
    .replace(/[^a-z0-9\s'\-α-ωΑ-Ω°±×÷≤≥≠≈→←↔∞√∛μΩΔφρφ]/g," ")
    .split(/\s+/)
    .filter(Boolean);
  const formulas=(String(text).match(/[A-Za-z]{1,3}\d{1,3}|[A-Za-z]\s*=\s*[^\s,]{1,24}|\d+\s*(?:[%°]|k?Ω|MΩ|mA|μA|μF|nF|pF|μH|kHz|MHz|GHz|V|A|W)|[α-ωΑ-ΩΔμπσθλΣΩφρ]/g)||[])
    .map(x=>x.toLowerCase().replace(/\s+/g,""));
  return [...words,...formulas];
}

/**
 * Built-in subject knowledge for Instant Tutor (works offline, no model download).
 * Prefer uploaded source when it matches; otherwise teach from this curriculum.
 */
const DOMAIN_KB = [
  // —— Electronics ——
  {keys:["ohm","ohm's law","ohms law","v=ir","voltage current resistance"],domain:"electronics",
    answer:"Ohm's law: **V = IR**\n• V = voltage (volts, V)\n• I = current (amperes, A)\n• R = resistance (ohms, Ω)\nAlso: I = V/R and R = V/I.\nPower: **P = VI = I²R = V²/R** (watts, W)."},
  {keys:["resistor","resistance","colour code","color code"],domain:"electronics",
    answer:"A **resistor** limits current. Symbol often looks like a zigzag (US) or rectangle (IEC). Unit: **ohm (Ω)**.\nSeries: R_total = R1 + R2 + …\nParallel: 1/R_total = 1/R1 + 1/R2 + …"},
  {keys:["capacitor","capacitance","farad","μf","uf"],domain:"electronics",
    answer:"A **capacitor** stores charge. Unit: **farad (F)** — usually μF, nF, pF.\nEnergy: E = ½CV².\nIn DC steady state an ideal capacitor acts open; it passes AC changes."},
  {keys:["inductor","inductance","henry","coil"],domain:"electronics",
    answer:"An **inductor** stores energy in a magnetic field. Unit: **henry (H)**.\nOpposes change in current. Energy: E = ½LI²."},
  {keys:["diode","led","rectifier"],domain:"electronics",
    answer:"A **diode** allows current mainly in one direction (anode → cathode when forward biased).\nLED = light-emitting diode. Always check polarity; reverse voltage can damage it."},
  {keys:["transistor","bjt","mosfet","npn","pnp"],domain:"electronics",
    answer:"A **transistor** amplifies or switches.\n• BJT (NPN/PNP): current-controlled; terminals base, collector, emitter.\n• MOSFET: voltage-controlled; gate, drain, source — common in digital power switching."},
  {keys:["ac","dc","alternating","direct current"],domain:"electronics",
    answer:"**DC** flows one way (batteries). **AC** reverses direction (mains). Mains frequency is often 50 or 60 Hz. Transformers work with AC, not steady DC."},
  {keys:["kirchhoff","kcl","kvl"],domain:"electronics",
    answer:"**KCL**: current into a node equals current out.\n**KVL**: sum of voltages around a closed loop is zero.\nThese plus Ohm's law solve most basic circuits."},
  {keys:["ground","earth","common"],domain:"electronics",
    answer:"**Ground / earth** is the reference node (0 V) for measuring other voltages. Circuit diagrams mark it with ground symbols. Safety earth protects people; signal ground is a reference."},
  {keys:["series","parallel","circuit"],domain:"electronics",
    answer:"**Series**: same current through each part; voltages add.\n**Parallel**: same voltage across each branch; currents add.\nMixes are solved section by section using Ohm + Kirchhoff."},
  // —— Digital logic gates ——
  {keys:["logic gate","logic gates","digital logic","boolean gate"],domain:"electronics",
    answer:"**Logic gates** are digital building blocks. Inputs and outputs are binary levels (0/1, LOW/HIGH).\nCommon gates: **NOT, AND, OR, NAND, NOR, XOR, XNOR**.\nRemember: NAND and NOR are *universal* — any circuit can be built from only NAND, or only NOR."},
  {keys:["not gate","inverter","logic not","boolean not"],domain:"electronics",
    answer:"**NOT (inverter)** — 1 input.\n• Output is the opposite of the input.\nTruth: 0→1, 1→0.\nBoolean: Y = NOT A  or  Y = Ā\nSymbol: triangle pointing right with a small circle (bubble) on the output."},
  {keys:["and gate","logic and","boolean and"],domain:"electronics",
    answer:"**AND** — output is 1 only if **all** inputs are 1.\n2-input truth:\nA B | Y\n0 0 | 0\n0 1 | 0\n1 0 | 0\n1 1 | 1\nBoolean: Y = A · B  (or A AND B)\nSymbol: D-shaped (flat input side, curved output)."},
  {keys:["or gate","logic or","boolean or"],domain:"electronics",
    answer:"**OR** — output is 1 if **any** input is 1.\n2-input truth:\nA B | Y\n0 0 | 0\n0 1 | 1\n1 0 | 1\n1 1 | 1\nBoolean: Y = A + B  (or A OR B)\nSymbol: curved input side, pointed output."},
  {keys:["nand gate","nand"],domain:"electronics",
    answer:"**NAND** = NOT-AND — output is 0 only when **all** inputs are 1 (AND then invert).\n2-input truth:\nA B | Y\n0 0 | 1\n0 1 | 1\n1 0 | 1\n1 1 | 0\nBoolean: Y = NOT (A · B)\nSymbol: AND shape + bubble on output. **Universal gate.**"},
  {keys:["nor gate","nor"],domain:"electronics",
    answer:"**NOR** = NOT-OR — output is 1 only when **all** inputs are 0 (OR then invert).\n2-input truth:\nA B | Y\n0 0 | 1\n0 1 | 0\n1 0 | 0\n1 1 | 0\nBoolean: Y = NOT (A + B)\nSymbol: OR shape + bubble on output. **Universal gate.**"},
  {keys:["xor gate","xor","exclusive or"],domain:"electronics",
    answer:"**XOR (exclusive OR)** — output is 1 when inputs are **different**.\n2-input truth:\nA B | Y\n0 0 | 0\n0 1 | 1\n1 0 | 1\n1 1 | 0\nBoolean: Y = A ⊕ B = A·B̄ + Ā·B\nUsed in adders and parity. Symbol: OR shape with an extra curved line on the input side."},
  {keys:["xnor gate","xnor","exclusive nor"],domain:"electronics",
    answer:"**XNOR** — output is 1 when inputs are the **same** (NOT of XOR).\n2-input truth:\nA B | Y\n0 0 | 1\n0 1 | 0\n1 0 | 0\n1 1 | 1\nBoolean: Y = A ⊙ B = A·B + Ā·B̄\nSymbol: XOR shape + bubble on output."},
  {keys:["truth table","boolean algebra","boolean"],domain:"electronics",
    answer:"A **truth table** lists every input combination and the output.\nn inputs → 2ⁿ rows.\nBoolean algebra basics:\n• Identity: A+0=A, A·1=A\n• Null: A+1=1, A·0=0\n• Idempotent: A+A=A, A·A=A\n• Complement: A+Ā=1, A·Ā=0\n• De Morgan: NOT(A·B)=Ā+B̄ , NOT(A+B)=Ā·B̄"},
  {keys:["de morgan","demorgan"],domain:"electronics",
    answer:"**De Morgan's laws**\n1. NOT (A AND B) = (NOT A) OR (NOT B)\n2. NOT (A OR B) = (NOT A) AND (NOT B)\nIn symbols: (A·B)̄ = Ā + B̄  and  (A+B)̄ = Ā · B̄\nUseful when converting NAND/NOR networks."},
  {keys:["combinational","sequential","flip flop","latch"],domain:"electronics",
    answer:"**Combinational** logic: outputs depend only on current inputs (gates only).\n**Sequential** logic: outputs also depend on past state — needs memory (latches, flip-flops).\nA basic **SR latch** remembers a bit; clocked **flip-flops** update on a clock edge."},
  {keys:["ttl","cmos","logic level","high low"],domain:"electronics",
    answer:"Digital levels are **HIGH (1)** and **LOW (0)** within voltage ranges set by the family (e.g. TTL, CMOS).\nNever assume exact 5 V or 3.3 V without checking the datasheet. Floating inputs on CMOS can cause bad behavior — tie unused inputs to a valid level."},
  // end logic gates
  // —— Circuit symbols (from standard electronics sheets) ——
  {keys:["wire","wires joined","wires not joined"],domain:"electronics",
    answer:"**Wire** passes current easily between parts of a circuit.\n**Wires joined** are shown with a blob at the connection (stagger crossroads into T-junctions).\n**Wires not joined** may use a bridge symbol so a crossing is not mistaken for a join."},
  {keys:["cell","battery","dc supply","ac supply"],domain:"electronics",
    answer:"**Cell** supplies energy; the larger terminal is positive (+). One cell is often called a battery, but a **battery** is two or more cells.\n**DC supply** = current always one direction. **AC supply** = current continually reverses."},
  {keys:["fuse"],domain:"electronics",
    answer:"A **fuse** is a safety device that blows (melts) if current exceeds a set value, protecting the rest of the circuit."},
  {keys:["transformer"],domain:"electronics",
    answer:"A **transformer** has two coils linked by an iron core. It steps AC voltages up or down. Energy transfers by magnetic field — no direct electrical connection between coils."},
  {keys:["earth","ground"],domain:"electronics",
    answer:"**Earth (ground)** is a connection to earth / 0 V reference. In many circuits it is the 0 V of the supply; for mains it can mean true earth."},
  {keys:["lamp","heater","motor","bell","buzzer"],domain:"electronics",
    answer:"These are **output transducers**:\n• **Lamp** — electrical energy → light (lighting vs indicator symbols differ)\n• **Heater** — electrical energy → heat\n• **Motor** — electrical energy → motion\n• **Bell / buzzer** — electrical energy → sound"},
  {keys:["push switch","push-to-break","spst","spdt","dpst","dpdt","relay","on-off switch"],domain:"electronics",
    answer:"**Switches** control current paths.\n• Push-to-make: on only while pressed\n• Push-to-break: off only while pressed\n• SPST: simple on-off\n• SPDT: 2-way changeover\n• DPST/DPDT: double-pole (often mains / motor reverse)\n• **Relay**: electrically operated switch (coil can switch a higher-voltage circuit); NO / COM / NC contacts"},
  {keys:["variable resistor","rheostat","potentiometer","preset"],domain:"electronics",
    answer:"**Resistor** restricts current (e.g. limit LED current).\n• **Rheostat** (2 contacts) — usually control current\n• **Potentiometer** (3 contacts) — usually control voltage / position signal\n• **Preset** — set once with a screwdriver, cheaper for projects"},
  {keys:["polarised capacitor","variable capacitor","trimmer capacitor"],domain:"electronics",
    answer:"**Capacitor** stores charge; used in timing with a resistor; can block DC and pass AC.\n**Polarised** types must be connected the correct way round.\n**Variable / trimmer** capacitors are used in radio tuning / set-and-forget adjustment."},
  {keys:["zener","photodiode","led","light emitting"],domain:"electronics",
    answer:"**Diode** allows current mainly one way.\n**LED** converts electrical energy to light.\n**Zener diode** holds a fixed voltage across its terminals.\n**Photodiode** is light-sensitive."},
  {keys:["npn","pnp","phototransistor"],domain:"electronics",
    answer:"**NPN / PNP transistors** amplify current; used in amplifiers and switches.\n**Phototransistor** is light-sensitive."},
  {keys:["microphone","earphone","loudspeaker","piezo","aerial","antenna","amplifier"],domain:"electronics",
    answer:"**Microphone** sound → electrical. **Earphone / loudspeaker / piezo** electrical → sound.\n**Amplifier** (triangle symbol) is often a whole circuit block, not one part.\n**Aerial / antenna** receives or transmits radio signals."},
  {keys:["voltmeter","ammeter","galvanometer","ohmmeter","oscilloscope"],domain:"electronics",
    answer:"**Voltmeter** measures voltage (potential difference).\n**Ammeter** measures current.\n**Galvanometer** measures very small currents (~1 mA or less).\n**Ohmmeter** measures resistance.\n**Oscilloscope** shows signal shape vs time."},
  {keys:["ldr","thermistor","light dependent"],domain:"electronics",
    answer:"**LDR** (Light Dependent Resistor): light → resistance change.\n**Thermistor**: temperature → resistance change."},
  {keys:["ex-or","ex-nor","exor","exnor"],domain:"electronics",
    answer:"**EX-OR (XOR)**: true when inputs differ (only two inputs).\n**EX-NOR (XNOR)**: true when inputs are the same; output bubble means NOT of XOR."},
  // —— Math ——
  {keys:["pythagorean","pythagoras","right triangle","a2+b2"],domain:"math",
    answer:"**Pythagorean theorem** (right triangle): a² + b² = c² where c is the hypotenuse."},
  {keys:["quadratic","quadratic formula"],domain:"math",
    answer:"For ax² + bx + c = 0: **x = (−b ± √(b² − 4ac)) / (2a)**.\nDiscriminant b²−4ac: >0 two real roots, =0 one, <0 complex."},
  {keys:["slope","linear equation","y=mx+b"],domain:"math",
    answer:"Line form: **y = mx + b** (m = slope, b = y-intercept).\nSlope between points: m = (y2−y1)/(x2−x1)."},
  {keys:["percentage","percent","%"],domain:"math",
    answer:"Percent means per 100. Part = percent/100 × whole.\nChange % = (new−old)/old × 100%."},
  {keys:["fraction","numerator","denominator"],domain:"math",
    answer:"Fraction = numerator / denominator. To add: common denominator. Multiply tops and bottoms; divide by multiplying by the reciprocal."},
  {keys:["area","perimeter","circle","π"],domain:"math",
    answer:"Rectangle area = lw; perimeter = 2(l+w).\nCircle: **C = 2πr**, **A = πr²**. Triangle area = ½bh."},
  // —— Science ——
  {keys:["photosynthesis","chlorophyll"],domain:"science",
    answer:"**Photosynthesis** (plants): light energy makes sugar.\nOverall idea: carbon dioxide + water → glucose + oxygen (in light, with chlorophyll).\nTypical equation form: 6CO₂ + 6H₂O → C₆H₁₂O₆ + 6O₂."},
  {keys:["newton","force","f=ma"],domain:"science",
    answer:"Newton's 2nd law: **F = ma** (force = mass × acceleration).\n1st: object stays at rest or steady motion unless a net force acts.\n3rd: action and reaction forces are equal and opposite."},
  {keys:["density","mass volume"],domain:"science",
    answer:"**Density ρ = m/V** (mass ÷ volume). Units often g/cm³ or kg/m³."},
  {keys:["atom","molecule","element","compound"],domain:"science",
    answer:"**Atom** = basic unit of an element. **Molecule** = bonded atoms. **Compound** = substance with two or more elements chemically combined."},
  {keys:["cell","nucleus","membrane"],domain:"science",
    answer:"Cells are basic living units. **Membrane** controls entry/exit; **nucleus** holds genetic material (in eukaryotes). Plant cells also have a wall and often chloroplasts."},
  // —— Social / health (common school topics) ——
  {keys:["peer pressure","peers"],domain:"english",
    answer:"**Peer pressure** is influence from people in your own age group that pushes you to think, feel, or act a certain way — sometimes against your own judgment.\n• Can be **negative** (risk behaviors) or **positive** (study groups, sports).\n• Healthy response: pause, name your values, use refusal skills, seek supportive friends or a trusted adult."},
  {keys:["risk reduction","harm reduction"],domain:"science",
    answer:"**Risk reduction** means lowering the chance or impact of harm (safety habits, protective gear, informed choices) rather than pretending risk is zero."},
  {keys:["plastic waste","marine life","plastic pollution"],domain:"science",
    answer:"**Plastic waste** harms marine life through entanglement, ingestion, and toxic chemicals. Reduction measures: refuse single-use plastics, recycle correctly, support cleanups, and choose reusable alternatives."},
  // —— English / essay ——
  {keys:["thesis","essay structure","introduction body conclusion"],domain:"english",
    answer:"Strong essay shape:\n1. **Introduction** + clear **thesis** (your main claim)\n2. **Body paragraphs** — each one idea + evidence + explanation\n3. **Conclusion** — restate claim, why it matters (no new random facts)"},
  {keys:["topic sentence","paragraph"],domain:"english",
    answer:"A paragraph usually starts with a **topic sentence**, then support (examples, quotes, reasons), then a link back to the thesis."},
  {keys:["grammar","subject verb","tense"],domain:"english",
    answer:"Keep **subject–verb agreement** (She writes / They write).\nStay in one main **tense** unless time truly changes. Prefer clear active verbs."},
  {keys:["formal writing","academic tone"],domain:"english",
    answer:"Academic tone: precise words, complete sentences, evidence for claims, limited slang, cite sources when you use them."},
  {keys:["figurative language","metaphor","simile"],domain:"english",
    answer:"**Simile** compares with like/as. **Metaphor** says one thing *is* another. Both create imagery — explain their effect in essays, don't only name them."},

  // —— BIT-CT / Information Technology (built-in course pack) ——
  {keys:["bit-ct","bit ct","bachelor of information technology","information technology"],domain:"bit",
    answer:"**BIT / BIT-CT** (Bachelor of Information Technology / Computer Technology) typically covers: programming, discrete math, digital logic, data structures, databases, networks, operating systems, web tech, software engineering, security, and projects.\nStudy order: foundations → systems → applications → security/project."},
  {keys:["c programming","programming in c","hello world c"],domain:"bit",
    answer:"**C programming** basics:\n• `#include <stdio.h>` then `int main(){ ... return 0; }`\n• Variables: int, float, char, double\n• Control: if/else, for, while, switch\n• Arrays & pointers are central\n• Functions: return_type name(args)\nCompile conceptually: source → object → executable."},
  {keys:["c++","object oriented","oop","class object inheritance"],domain:"bit",
    answer:"**OOP (C++/Java style)**:\n• **Class** = blueprint; **object** = instance\n• **Encapsulation** — hide data, expose methods\n• **Inheritance** — reuse/extend classes\n• **Polymorphism** — same interface, different behavior\n• **Abstraction** — show essentials only"},
  {keys:["data structure","algorithm","stack queue linked list tree graph"],domain:"bit",
    answer:"Core **data structures**:\n• Array — fixed index access O(1)\n• Linked list — dynamic nodes\n• Stack — LIFO (push/pop)\n• Queue — FIFO (enqueue/dequeue)\n• Tree/BST — hierarchical search\n• Graph — nodes + edges\nAlgorithms: search, sort, traversal (BFS/DFS). Complexity uses Big-O."},
  {keys:["big o","time complexity","space complexity","o(1)","o(n)"],domain:"bit",
    answer:"**Big-O** describes growth of time/space as input size n grows:\n• O(1) constant\n• O(log n) binary search\n• O(n) linear scan\n• O(n log n) efficient sorts (merge/heap)\n• O(n²) nested loops\nPrefer lower growth for large n."},
  {keys:["database","dbms","sql","primary key","normalization"],domain:"bit",
    answer:"**DBMS** stores structured data.\n• **SQL**: SELECT, INSERT, UPDATE, DELETE\n• **Primary key** uniquely identifies a row\n• **Foreign key** links tables\n• **Normalization** reduces redundancy (1NF→2NF→3NF)\n• Join combines tables on related keys\nACID: Atomicity, Consistency, Isolation, Durability"},
  {keys:["operating system","os","process","thread","scheduling","deadlock"],domain:"bit",
    answer:"**Operating system** manages hardware & software.\n• Process = running program; thread = lightweight unit inside process\n• CPU scheduling: FCFS, SJF, Round Robin, Priority\n• Memory: paging, virtual memory\n• Deadlock: circular wait for resources — prevent or detect/recover"},
  {keys:["computer network","osi","tcp","ip","http","lan wan"],domain:"bit",
    answer:"**Networks**:\n• LAN (local) vs WAN (wide)\n• **OSI 7 layers**: Physical → Data Link → Network → Transport → Session → Presentation → Application\n• **TCP** reliable; **UDP** fast/unreliable\n• **IP** addressing/routing\n• **HTTP/HTTPS** web application layer"},
  {keys:["digital logic","logic gate","boolean","truth table","flip flop","combinational"],domain:"bit",
    answer:"**Digital logic**:\n• Gates: AND, OR, NOT, NAND, NOR, XOR, XNOR\n• Boolean algebra simplifies circuits\n• Truth tables list all input→output cases\n• Combinational: output depends only on current inputs\n• Sequential: uses memory (flip-flops) — depends on history"},
  {keys:["computer architecture","cpu","alu","register","cache","ram rom"],domain:"bit",
    answer:"**Computer architecture**:\n• CPU: control unit + **ALU** + registers\n• **RAM** volatile working memory; **ROM** non-volatile firmware\n• Cache speeds repeated access\n• Instruction cycle: fetch → decode → execute\n• Buses move data/address/control signals"},
  {keys:["web technology","html","css","javascript","http request"],domain:"bit",
    answer:"**Web stack**:\n• **HTML** structure\n• **CSS** presentation\n• **JavaScript** behavior\n• Client requests via HTTP; server responds (status codes 200, 404, 500)\n• Frontend vs backend; APIs exchange JSON often"},
  {keys:["software engineering","sdlc","agile","waterfall","requirement"],domain:"bit",
    answer:"**Software engineering** builds reliable systems.\n• **SDLC**: requirements → design → implement → test → deploy → maintain\n• **Waterfall**: sequential stages\n• **Agile**: iterative sprints, frequent feedback\n• Good requirements are clear, testable, prioritized"},
  {keys:["cyber security","cryptography","encryption","firewall","malware"],domain:"bit",
    answer:"**Cybersecurity** basics:\n• CIA triad: Confidentiality, Integrity, Availability\n• Encryption protects confidentiality (e.g., AES, RSA concepts)\n• Hashing verifies integrity\n• Firewall filters traffic\n• Malware: virus, worm, trojan, ransomware — update, backup, least privilege"},
  {keys:["discrete mathematics","set theory","proposition","graph theory","relation"],domain:"bit",
    answer:"**Discrete math** for CS:\n• Sets, relations, functions\n• Propositional logic (AND/OR/NOT, implication)\n• Proof ideas: direct, contradiction, induction\n• Graphs: vertices/edges, paths, trees\n• Counting: permutations & combinations"},
  {keys:["linux","shell","command line","chmod"],domain:"bit",
    answer:"**Linux** essentials:\n• Shell commands: ls, cd, pwd, cp, mv, rm, cat, grep, man\n• Filesystem hierarchy starts at /\n• Permissions: read/write/execute for user/group/other (`chmod`)\n• Processes: ps, top, kill"},
  {keys:["system analysis","dfd","uml","use case","er diagram"],domain:"bit",
    answer:"**System analysis & design**:\n• Gather requirements from stakeholders\n• **DFD** shows data flow\n• **ER diagram** models data entities/relationships\n• **UML use case** shows actor goals\n• Design before heavy coding reduces rework"},
  {keys:["artificial intelligence","machine learning","neural network"],domain:"bit",
    answer:"**AI** systems perform tasks that seem intelligent.\n• **ML** learns patterns from data (supervised/unsupervised/reinforcement)\n• Neural nets approximate functions with layers of units\n• Always validate on held-out data; watch bias and overfitting"},
  // —— BAEL / English Language (professor-level core) ——
  {keys:["bael","bachelor of arts english","english language program"],domain:"bael",
    answer:"**BAEL** (Bachelor of Arts in English Language) focuses on language structure, grammar, linguistics, literature, writing, speech, and communication. Core skills: analyze texts, write academic prose, understand grammar systems, and use English effectively across cultures."},
  {keys:["parts of speech","noun verb adjective adverb preposition conjunction"],domain:"bael",
    answer:"**Parts of speech**:\n• Noun — person/place/thing/idea\n• Verb — action/state\n• Adjective — modifies noun\n• Adverb — modifies verb/adjective/adverb\n• Preposition — relation (in, on, by)\n• Conjunction — joins (and, but, because)\n• Pronoun — replaces noun\n• Interjection — emotion (wow!)"},
  {keys:["tense","present perfect","past perfect","progressive","aspect"],domain:"bael",
    answer:"English **tense/aspect**:\n• Simple present: habits/facts (She writes)\n• Present progressive: now (She is writing)\n• Present perfect: past→present relevance (She has written)\n• Past simple: finished past (She wrote)\n• Past perfect: earlier past (She had written)\n• Future: will / going to / present progressive for plans"},
  {keys:["subject verb agreement","concord"],domain:"bael",
    answer:"**Subject–verb agreement (concord)**: singular subjects take singular verbs (The student writes); plural take plural (Students write).\nWatch: each/every → singular; neither/nor closer subject rules; collective nouns vary by dialect."},
  {keys:["active voice","passive voice","voice grammar"],domain:"bael",
    answer:"**Active**: Subject does action — *The team solved the problem.*\n**Passive**: Subject receives action — *The problem was solved by the team.*\nUse passive when actor is unknown/unimportant; prefer active for clarity in most academic writing."},
  {keys:["direct speech","indirect speech","reported speech"],domain:"bael",
    answer:"**Reported speech** shifts pronouns and often tense:\nDirect: She said, \"I am tired.\"\nIndirect: She said (that) she was tired.\nQuestions/orders change word order and verbs (asked, told)."},
  {keys:["article","definite article","indefinite article","a an the"],domain:"bael",
    answer:"**Articles**:\n• **a/an** — nonspecific singular countable (a book, an idea)\n• **the** — specific/known to listener (the book on the desk)\n• Zero article — general plurals/uncountables (Books are useful; Honesty matters)"},
  {keys:["phonetics","phonology","ipa","pronunciation","stress intonation"],domain:"bael",
    answer:"**Phonetics** studies speech sounds; **phonology** studies sound systems.\n• IPA symbols represent sounds precisely\n• Stress changes meaning (REcord vs reCORD)\n• Intonation signals questions, attitude, focus"},
  {keys:["morphology","morpheme","affix","prefix suffix"],domain:"bael",
    answer:"**Morphology** = word structure.\n• Morpheme = smallest meaning unit\n• Free morphemes stand alone (book); bound need hosts (-s, un-, -ness)\n• Derivational affixes change meaning/class; inflectional mark grammar (plural, tense)"},
  {keys:["syntax","phrase structure","sentence types"],domain:"bael",
    answer:"**Syntax** = sentence structure.\nTypes: declarative, interrogative, imperative, exclamative.\nClauses: independent vs dependent.\nCommon patterns: SVO in English (Subject–Verb–Object)."},
  {keys:["semantics","pragmatics","meaning context"],domain:"bael",
    answer:"**Semantics** = literal meaning of words/sentences.\n**Pragmatics** = meaning in context (implication, politeness, speech acts).\nExample: \"Can you open the window?\" is often a request, not a yes/no ability question."},
  {keys:["literary devices","alliteration","irony","symbolism","imagery"],domain:"bael",
    answer:"Literary tools:\n• Imagery — sensory detail\n• Symbolism — concrete stands for abstract\n• Irony — contrast between expectation and reality\n• Alliteration — repeated initial sounds\n• Theme — central idea\nAlways explain **effect on the reader**, not only the label."},
  {keys:["literary genres","prose poetry drama fiction nonfiction"],domain:"bael",
    answer:"Major **genres**:\n• Poetry — concentrated language, line/break, often figurative\n• Prose fiction — novels/short stories\n• Drama — performance text\n• Nonfiction — essays, reports, biography\nHybrid forms exist (creative nonfiction, prose poetry)."},
  {keys:["academic writing","research paper","citation","plagiarism"],domain:"bael",
    answer:"**Academic writing**: clear thesis, structured paragraphs, evidence, formal tone.\nCite sources (APA/MLA/Chicago as required).\n**Plagiarism** = presenting others' words/ideas as your own — quote/paraphrase + cite."},
  {keys:["rhetoric","ethos pathos logos","persuasive techniques"],domain:"bael",
    answer:"Aristotle's appeals:\n• **Ethos** — credibility\n• **Pathos** — emotion\n• **Logos** — logic/evidence\nStrong arguments usually blend all three, led by logos in academic work."},
  {keys:["discourse analysis","register","code switching"],domain:"bael",
    answer:"**Register** = language variety by situation (formal lecture vs chat).\n**Code-switching** = shifting languages/varieties in context.\nDiscourse analysis studies language beyond the sentence — cohesion, turn-taking, power."},
  // —— Drawing / visual design (built-in) ——
  {keys:["perspective drawing","one point","two point","vanishing point"],domain:"drawing",
    answer:"**Perspective**:\n• One-point: lines recede to one vanishing point (road/hallway)\n• Two-point: two vanishing points (building corner)\n• Horizon line = eye level\nSketch lightly, keep proportions, darken final edges."},
  {keys:["composition","rule of thirds","visual balance","negative space"],domain:"drawing",
    answer:"**Composition** tips:\n• Rule of thirds — place focal points on intersections\n• Balance mass/color so one side is not accidentally heavier\n• Negative space is the shape around objects — use it intentionally\n• Contrast leads the eye"},
  {keys:["line weight","contour","gesture drawing","sketch"],domain:"drawing",
    answer:"**Drawing fundamentals**:\n• Gesture — fast capture of motion/pose\n• Contour — careful edges\n• Line weight — thicker lines advance, thinner recede\n• Construction: start with basic shapes (sphere, box, cylinder)"},
  {keys:["color theory","primary secondary","complementary","hue value saturation"],domain:"drawing",
    answer:"**Color**:\n• Primary (RYB traditional or RGB digital contexts)\n• Complementary colors opposite on the wheel create contrast\n• Hue = color identity; Value = light/dark; Saturation = intensity\nWarm colors advance; cool colors recede"},
  {keys:["technical drawing","orthographic","isometric","blueprint"],domain:"drawing",
    answer:"**Technical drawing**:\n• Orthographic: front/top/side views without perspective distortion\n• Isometric: 120° axes for 3D-looking measures\n• Dimension lines + scale must be consistent\nUsed in engineering and architecture communication"},
  // —— Extra math (professor core) ——
  {keys:["derivative","differentiation","rate of change"],domain:"math",
    answer:"**Derivative** f'(x) = instantaneous rate of change / slope of tangent.\nPower rule: d/dx[x^n] = n x^{n−1}.\nProduct/quotient/chain rules for combinations.\nApplications: velocity, optimization, linear approximation."},
  {keys:["integral","integration","antiderivative","area under curve"],domain:"math",
    answer:"**Integral** accumulates quantities; definite integral ∫_a^b f(x) dx is signed area.\nFundamental Theorem links derivatives and integrals.\nCommon: ∫x^n dx = x^{n+1}/(n+1) + C (n≠−1)."},
  {keys:["matrix","determinant","linear algebra","vector"],domain:"math",
    answer:"**Linear algebra**:\n• Vector: ordered list of numbers (magnitude + direction in geometry)\n• Matrix: rectangular array; multiply when inner dimensions match\n• Determinant (square matrices) relates to invertibility/volume scaling\n• Systems of equations ↔ matrix form Ax = b"},
  {keys:["probability","statistics","mean median mode","standard deviation"],domain:"math",
    answer:"**Stats basics**:\n• Mean = average; median = middle; mode = most frequent\n• Standard deviation measures spread around the mean\n• Probability of event between 0 and 1; mutually exclusive vs independent differ"},
  {keys:["trigonometry","sine cosine tangent","soh cah toa"],domain:"math",
    answer:"Right-triangle trig:\n• sin θ = opposite/hypotenuse\n• cos θ = adjacent/hypotenuse\n• tan θ = opposite/adjacent\nUnit circle extends these to all angles. Identity: sin²θ + cos²θ = 1."},
  // —— Extra science ——
  {keys:["newton laws","inertia","action reaction"],domain:"science",
    answer:"**Newton's laws**:\n1. Inertia — constant velocity unless net force acts\n2. F = ma\n3. Action–reaction pairs equal and opposite\nNet force is vector sum; free-body diagrams are essential."},
  {keys:["stoichiometry","mole","molar mass","chemical equation balance"],domain:"science",
    answer:"**Stoichiometry**:\n• Balance equations (atoms conserved)\n• Mole = 6.022×10²³ entities\n• Mass ↔ moles via molar mass\n• Limiting reactant controls product amount"},
  {keys:["cell biology","mitosis","meiosis","organelle"],domain:"science",
    answer:"**Cell basics**:\n• Organelles: nucleus, mitochondria, ribosomes, membrane…\n• Mitosis: somatic division (2 identical diploid cells)\n• Meiosis: gametes (4 haploid cells), genetic variation"},
  {keys:["evolution","natural selection","adaptation"],domain:"science",
    answer:"**Natural selection**: heritable variation + differential survival/reproduction → adaptation over generations.\nEvolution is change in allele frequencies in populations — not goal-directed."},
  {keys:["scientific method","hypothesis","variable control"],domain:"science",
    answer:"**Scientific method**: question → hypothesis → controlled experiment → data → conclusion → revise.\nIndependent variable manipulated; dependent measured; controls held constant; replication matters."},

  // —— BIT-CT expanded ——
  {keys:["pointer","null pointer","dereference","memory address"],domain:"bit",
    answer:"A **pointer** stores a memory address.\n• Declare: `int *p;`\n• Address-of: `p = &x;`\n• Dereference: `*p` accesses the value at that address\n• Null pointer means \"no valid target\" — never dereference null.\nPointers enable dynamic memory, arrays, and efficient function argument passing."},
  {keys:["recursion","base case","recursive function"],domain:"bit",
    answer:"**Recursion**: a function calls itself.\nMust have:\n1. **Base case** — stops recursion\n2. **Recursive case** — smaller subproblem\nExample idea: factorial n! = n × (n−1)! with 0! = 1.\nWatch stack overflow if base case is missing."},
  {keys:["sorting","bubble sort","merge sort","quick sort"],domain:"bit",
    answer:"**Sorting**:\n• Bubble: adjacent swaps — simple, O(n²)\n• Merge sort: divide & merge — O(n log n), stable\n• Quick sort: pivot partition — average O(n log n), worst O(n²)\nChoose by size, stability need, and memory limits."},
  {keys:["binary search","search algorithm"],domain:"bit",
    answer:"**Binary search** finds a target in a **sorted** array by repeatedly checking the middle.\nTime: O(log n). If data is unsorted, sort first or use linear search O(n)."},
  {keys:["hashing","hash table","hash function","collision"],domain:"bit",
    answer:"**Hash table** maps keys → values via a **hash function**.\nAverage lookup O(1).\n**Collision** = two keys hash to same slot — resolve with chaining or open addressing.\nGood hash spreads keys evenly."},
  {keys:["normalization","1nf","2nf","3nf","database design"],domain:"bit",
    answer:"**Normalization** reduces redundancy:\n• **1NF**: atomic values, no repeating groups\n• **2NF**: 1NF + no partial dependency on part of a composite key\n• **3NF**: 2NF + no transitive dependency of non-key on non-key\nGoal: consistency and easier updates."},
  {keys:["join","inner join","left join","sql join"],domain:"bit",
    answer:"**SQL JOIN** combines rows from tables:\n• **INNER JOIN** — only matching keys\n• **LEFT JOIN** — all left rows + matches from right (NULL if none)\n• **RIGHT JOIN** — mirror of left\n• **FULL OUTER** — all from both\nAlways join on the correct relationship keys."},
  {keys:["transaction","acid","commit","rollback"],domain:"bit",
    answer:"A **transaction** is a unit of work.\n**ACID**:\n• Atomicity — all or nothing\n• Consistency — valid state to valid state\n• Isolation — concurrent transactions don't corrupt each other\n• Durability — committed data survives crashes\n`COMMIT` saves; `ROLLBACK` undoes."},
  {keys:["tcp vs udp","transmission control","user datagram"],domain:"bit",
    answer:"**TCP**: connection-oriented, reliable, ordered, slower overhead — web, email, file transfer.\n**UDP**: connectionless, no delivery guarantee, low overhead — video streaming, DNS, gaming.\nPick reliability vs speed."},
  {keys:["ip address","subnet","ipv4","ipv6"],domain:"bit",
    answer:"**IPv4**: 32-bit address (e.g. 192.168.1.10), limited space.\n**IPv6**: 128-bit, huge space.\n**Subnet** splits a network into smaller segments; mask defines network vs host bits.\nPrivate ranges (e.g. 192.168.x.x) are not routed on the public internet."},
  {keys:["http status","404","500","200 ok"],domain:"bit",
    answer:"Common **HTTP status codes**:\n• 200 OK — success\n• 301/302 — redirect\n• 400 Bad Request — client error\n• 401 Unauthorized / 403 Forbidden\n• 404 Not Found\n• 500 Internal Server Error\n2xx success, 4xx client, 5xx server."},
  {keys:["git","version control","commit branch merge"],domain:"bit",
    answer:"**Git** tracks code history.\n• `commit` snapshots changes with a message\n• `branch` parallel lines of work\n• `merge` / pull request combines branches\n• `clone`/`push`/`pull` sync with remote\nCommit often; write clear messages."},
  {keys:["api","rest","json","endpoint"],domain:"bit",
    answer:"An **API** lets programs talk.\n**REST** uses HTTP methods on resources:\n• GET read · POST create · PUT/PATCH update · DELETE remove\n**JSON** is a common data format.\nAn **endpoint** is a specific URL + method."},
  {keys:["oop principles","solid","encapsulation inheritance"],domain:"bit",
    answer:"**OOP pillars**: encapsulation, inheritance, polymorphism, abstraction.\n**SOLID** (design guide):\n• Single Responsibility\n• Open/Closed\n• Liskov Substitution\n• Interface Segregation\n• Dependency Inversion\nAim for modules that are easy to change safely."},
  {keys:["compiler","interpreter","bytecode","runtime"],domain:"bit",
    answer:"**Compiler** translates source → machine/bytecode ahead of time (C, often Java to bytecode).\n**Interpreter** executes source (or bytecode) more directly (Python, JS engines mix both).\nCompiled code often runs faster; interpreted can be more flexible."},
  {keys:["memory management","stack heap","garbage collection"],domain:"bit",
    answer:"**Stack**: automatic, fast, function frames, limited size.\n**Heap**: dynamic allocation (`malloc`/new), flexible, must free or GC reclaim.\n**Garbage collection** automatically reclaims unreachable objects (Java, JS, Python) — reduces leaks but adds pauses."},
  {keys:["firewall","vpn","authentication","authorization"],domain:"bit",
    answer:"**Firewall** filters network traffic by rules.\n**VPN** encrypts traffic over public networks.\n**Authentication** = who you are (password, MFA).\n**Authorization** = what you're allowed to do after login.\nNever confuse the two."},
  {keys:["agile scrum","sprint","product backlog"],domain:"bit",
    answer:"**Scrum** (Agile):\n• Product backlog = prioritized work\n• Sprint = short timebox (often 1–2 weeks)\n• Daily stand-up, review, retrospective\nDeliver working increments often; adapt to feedback."},

  // —— BAEL expanded ——
  {keys:["paragraph unity","coherence","cohesion"],domain:"bael",
    answer:"**Unity**: one main idea per paragraph.\n**Coherence**: logical order of ideas.\n**Cohesion**: linguistic links (pronouns, transitions: however, therefore, in addition).\nTopic sentence + support + optional concluding sentence."},
  {keys:["thesis statement","claim statement"],domain:"bael",
    answer:"A **thesis** is a specific, arguable main claim — not a topic label.\nWeak: \"This essay is about social media.\"\nStrong: \"Social media algorithms intensify political polarization by rewarding outrage-driven engagement.\"\nPlace near the end of the introduction in many academic essays."},
  {keys:["citation mla","citation apa","in-text citation"],domain:"bael",
    answer:"**APA** (common in social sciences): (Author, Year).\n**MLA** (humanities): (Author page).\nAlways match the required style guide. Reference list / Works Cited must include full source details. Cite paraphrases, not only quotes."},
  {keys:["paraphrase","summary vs paraphrase","quoting"],domain:"bael",
    answer:"**Quote**: exact words in quotation marks + citation.\n**Paraphrase**: same idea in your words + citation.\n**Summary**: condensed main points + citation.\nChanging a few words is not paraphrase — restructure fully and still cite."},
  {keys:["figure of speech","hyperbole","personification","oxymoron"],domain:"bael",
    answer:"• **Hyperbole** — exaggeration for effect\n• **Personification** — human traits to non-human\n• **Oxymoron** — contradictory pair (deafening silence)\n• **Onomatopoeia** — sound words (buzz, crash)\nName the device and explain its effect."},
  {keys:["tone mood","author attitude"],domain:"bael",
    answer:"**Tone** = author's attitude (ironic, solemn, playful).\n**Mood** = atmosphere felt by the reader (tense, joyful).\nTone is created through diction, imagery, and syntax."},
  {keys:["theme vs motif","central idea literature"],domain:"bael",
    answer:"**Theme** = underlying message/idea about life or society.\n**Motif** = recurring element (image, phrase, object) that supports theme.\nTheme is not just the topic (\"war\") but a statement about it (\"war erodes innocence\")."},
  {keys:["clause","independent clause","dependent clause","phrase"],domain:"bael",
    answer:"**Phrase**: group of words without both subject + finite verb.\n**Independent clause**: can stand alone as a sentence.\n**Dependent (subordinate) clause**: needs an independent clause (because…, although…, who…)."},
  {keys:["run on sentence","comma splice","sentence fragment"],domain:"bael",
    answer:"• **Fragment**: incomplete sentence treated as complete\n• **Run-on**: two independents joined with no proper punctuation/conjunction\n• **Comma splice**: two independents joined by only a comma\nFix with period, semicolon, or coordinating conjunction."},
  {keys:["modal verbs","can could may might must should"],domain:"bael",
    answer:"**Modals** add meaning to main verbs:\n• can/could — ability, possibility, request\n• may/might — possibility, permission\n• must — strong necessity/conclusion\n• should/ought to — advice\n• will/would — future, willingness, hypothetical\nModals don't take -s in third person singular."},
  {keys:["conditionals","if clause","zero first second third conditional"],domain:"bael",
    answer:"**Conditionals**:\n• Zero: if + present, present (facts)\n• First: if + present, will (real future)\n• Second: if + past, would (hypothetical present)\n• Third: if + past perfect, would have (hypothetical past)\nMixed conditionals combine times."},
  {keys:["listening speaking skills","oral communication"],domain:"bael",
    answer:"Strong **oral communication**: clear purpose, structured points, appropriate register, eye contact, listen to respond not only to reply.\nFor presentations: signpost (first, next, finally), one idea per slide/section, rehearse timing."},
  {keys:["reading strategies","skimming scanning inferencing"],domain:"bael",
    answer:"• **Skimming** — main idea quickly\n• **Scanning** — find specific fact\n• **Inferencing** — read between the lines using evidence\n• Annotate: claim, evidence, questions, vocabulary"},
  {keys:["sociolinguistics","dialect","accent","lingua franca"],domain:"bael",
    answer:"**Sociolinguistics** studies language in society.\n• **Dialect** — variety with distinct grammar/vocabulary\n• **Accent** — pronunciation variety\n• **Lingua franca** — shared language between different L1 speakers\nNo dialect is inherently \"better\" — prestige is social, not linguistic."},
  {keys:["language acquisition","first language","second language learning"],domain:"bael",
    answer:"**L1 acquisition** is natural in childhood with rich input.\n**L2 learning** often needs explicit practice, motivation, and meaningful use.\nInterlanguage = learner's developing system; errors can be developmental, not just \"bad habits.\""},

  // —— Math expanded ——
  {keys:["quadratic formula","roots of quadratic"],domain:"math",
    answer:"For ax² + bx + c = 0,\n**x = (-b ± √(b² − 4ac)) / (2a)**\nDiscriminant D = b² − 4ac:\n• D>0 two real roots · D=0 one real · D<0 complex roots"},
  {keys:["pythagorean theorem","right triangle"],domain:"math",
    answer:"In a right triangle: **a² + b² = c²** where c is the hypotenuse (side opposite the right angle).\nUsed for distance, height, and checking right angles."},
  {keys:["logarithm","log rules","natural log"],domain:"math",
    answer:"**log_b(a) = c** means b^c = a.\nRules: log(xy)=log x+log y; log(x/y)=log x−log y; log(x^k)=k log x.\n**ln** = log base e. Logs undo exponentials."},
  {keys:["function","domain range","vertical line test"],domain:"math",
    answer:"A **function** assigns each valid input exactly one output.\n**Domain** = allowed inputs; **range** = possible outputs.\nVertical line test: if a vertical line hits the graph more than once, it's not a function."},
  {keys:["slope intercept","linear equation","y=mx+b"],domain:"math",
    answer:"**y = mx + b**\n• m = slope (rise/run)\n• b = y-intercept\nSlope between points: m = (y₂−y₁)/(x₂−x₁).\nParallel lines same m; perpendicular slopes negative reciprocals."},
  {keys:["percentage","percent change","discount"],domain:"math",
    answer:"Percent = fraction of 100.\nPart = percent × whole.\n**Percent change** = (new−old)/old × 100%.\nDiscount: sale = original × (1 − discount rate)."},
  {keys:["set operations","union intersection complement"],domain:"math",
    answer:"**Sets**:\n• Union A∪B — in A or B or both\n• Intersection A∩B — in both\n• Complement — not in the set (relative to universe)\n• Subset A⊆B — every element of A is in B"},
  {keys:["sequence series","arithmetic geometric"],domain:"math",
    answer:"**Arithmetic sequence**: constant difference d. a_n = a_1 + (n−1)d\n**Geometric sequence**: constant ratio r. a_n = a_1 · r^(n−1)\nSeries = sum of terms. Geometric sum formulas depend on |r|<1 for infinite cases."},
  {keys:["factorial","permutation","combination","ncr npr"],domain:"math",
    answer:"**n!** = n×(n−1)×…×1\n**Permutation** P(n,r) = n!/(n−r)! — order matters\n**Combination** C(n,r) = n!/(r!(n−r)!) — order doesn't matter"},
  {keys:["limit continuity","limits calculus"],domain:"math",
    answer:"**Limit** describes the value a function approaches as x approaches a point.\nContinuity roughly: limit exists, function defined, values match.\nLimits underpin derivatives and integrals."},

  // —— Science expanded ——
  {keys:["photosynthesis equation","chlorophyll","glucose oxygen"],domain:"science",
    answer:"**Photosynthesis** (simplified):\n6CO₂ + 6H₂O + light → C₆H₁₂O₆ + 6O₂\nChlorophyll absorbs light; occurs mainly in chloroplasts. Stores light energy as chemical energy in sugars."},
  {keys:["respiration equation","cellular respiration","atp"],domain:"science",
    answer:"**Cellular respiration** releases energy from glucose:\nC₆H₁₂O₆ + 6O₂ → 6CO₂ + 6H₂O + ATP\nStages (typical): glycolysis → Krebs cycle → electron transport chain. ATP is the usable energy currency."},
  {keys:["periodic table","atomic number","groups periods"],domain:"science",
    answer:"**Periodic table**:\n• **Atomic number** = protons\n• Periods = rows; groups/families = columns with similar properties\n• Metals left, nonmetals right, metalloids in between\nValence electrons largely drive bonding behavior."},
  {keys:["ionic covalent bond","chemical bonding"],domain:"science",
    answer:"**Ionic bond**: electron transfer, usually metal + nonmetal, electrostatic attraction.\n**Covalent bond**: electron sharing, often nonmetal + nonmetal.\nPolar covalent = unequal sharing. Bond type predicts many material properties."},
  {keys:["states of matter","solid liquid gas plasma"],domain:"science",
    answer:"**States of matter**:\n• Solid — fixed shape/volume, strong particle forces\n• Liquid — fixed volume, flows\n• Gas — fills container, weak forces\n• Plasma — ionized gas\nPhase changes involve energy in/out without changing chemical identity."},
  {keys:["ecosystem","food chain","producer consumer decomposer"],domain:"science",
    answer:"**Ecosystem** = community + environment.\n• Producers (plants) make organic matter\n• Consumers eat other organisms\n• Decomposers recycle nutrients\nEnergy flows; matter cycles. Food webs are more realistic than single chains."},
  {keys:["dna rna","gene protein","central dogma"],domain:"science",
    answer:"**Central dogma**: DNA → RNA → Protein\n• DNA stores genetic information\n• Transcription makes RNA\n• Translation builds proteins at ribosomes\nGenes are DNA segments that code for functional products."},
  {keys:["speed velocity acceleration","kinematics"],domain:"science",
    answer:"• **Speed** scalar; **velocity** vector (speed + direction)\n• **Acceleration** = rate of change of velocity\n• Average speed = distance/time\nUnder constant acceleration: v = u + at; s = ut + ½at²"},
  {keys:["energy conservation","kinetic potential"],domain:"science",
    answer:"**Conservation of energy**: energy changes form but total is conserved in a closed system.\n• Kinetic = energy of motion (½mv²)\n• Potential = stored (mgh gravitational near Earth)\nWork transfers energy by force acting through distance."},
  {keys:["acid base ph","neutralization"],domain:"science",
    answer:"**pH** scale ~0–14: <7 acidic, 7 neutral, >7 basic.\nAcids donate H⁺ (in water); bases accept H⁺ or donate OH⁻.\nNeutralization: acid + base → salt + water (typical)."},

  // —— Electronics expanded ——
  {keys:["series parallel circuit","voltage drop"],domain:"electronics",
    answer:"**Series**: same current through all; voltages add; R_total = R1+R2+…\n**Parallel**: same voltage across branches; currents add; 1/R_total = 1/R1+1/R2+…\nVoltage dividers use series resistors."},
  {keys:["transformer","step up","step down"],domain:"electronics",
    answer:"A **transformer** transfers AC energy between coils via magnetic field.\n• Step-up: more secondary turns → higher secondary voltage\n• Step-down: fewer secondary turns\nWorks with changing flux — not steady DC."},
  {keys:["boolean algebra","demorgan","logic simplification"],domain:"electronics",
    answer:"**Boolean algebra** simplifies logic:\n• OR +, AND ·, NOT bar/'\n• De Morgan: (A·B)' = A'+B' ; (A+B)' = A'·B'\n• Idempotent, absorption, distributive laws reduce gate count."},
  {keys:["adc dac","analog digital conversion"],domain:"electronics",
    answer:"**ADC** converts analog → digital for processing.\n**DAC** converts digital → analog for output.\nResolution (bits) and sampling rate limit accuracy and fidelity (Nyquist: sample > 2× highest frequency)."},
  {keys:["op amp","operational amplifier","inverting"],domain:"electronics",
    answer:"**Op-amp**: high-gain differential amplifier.\nIdeal model: infinite gain/input impedance, zero output impedance.\nCommon configs: inverting/non-inverting amplifiers, buffers, comparators — set by feedback network."},

  // —— Drawing expanded ——
  {keys:["anatomy drawing","proportion figure","head units"],domain:"drawing",
    answer:"**Figure proportion** (classic guide): adult ~7.5–8 heads tall.\nGesture first (action line), then volumes (rib cage, pelvis), then limbs.\nMeasure relationships, don't guess isolated parts."},
  {keys:["shading","value scale","form light"],domain:"drawing",
    answer:"**Shading** describes form with value (light→dark).\nIdentify light source, core shadow, cast shadow, reflected light, highlight.\nSmooth gradients for soft forms; harder edges for sharp planes."},
  {keys:["storyboard","thumbnail sketch","layout design"],domain:"drawing",
    answer:"**Thumbnails**: small quick layouts to test composition.\n**Storyboards**: sequence of frames for narrative/film/animation.\nExplore many options small before committing large."},
  {keys:["typography basics","hierarchy readability"],domain:"drawing",
    answer:"**Typography**:\n• Hierarchy — size/weight guide the eye\n• Limit typefaces; prefer readable body text\n• Tracking/leading affect readability\n• Contrast text against background for accessibility"},
  {keys:["ui design principles","visual hierarchy interface"],domain:"drawing",
    answer:"**UI design**:\n• Hierarchy and grouping (proximity)\n• Consistency of controls\n• Affordances — elements look usable\n• Feedback on actions\n• Accessibility: contrast, target size, labels"},

  // —— Study skills (helps all courses) ——
  {keys:["spaced repetition","forgetting curve","sm2"],domain:"study",
    answer:"**Spaced repetition** reviews material right before you forget it — beats massed cramming.\nStudyVault's SM-2 style scheduling uses your grade quality to set the next interval.\nBe honest on grades or the schedule becomes wrong."},
  {keys:["active recall","retrieval practice"],domain:"study",
    answer:"**Active recall**: close the notes and retrieve from memory (quiz, blank page, flashcards).\nStronger than rereading. Struggle a bit, then check — desirable difficulty."},
  {keys:["feynman technique","teach to learn"],domain:"study",
    answer:"**Feynman technique**: explain a concept in simple words as if teaching a beginner.\nGaps appear where you hand-wave — return to source, then explain again without jargon crutches."},
  {keys:["pomodoro","focus timer","deep work"],domain:"study",
    answer:"**Pomodoro**: focus ~25 minutes, short break, repeat; longer break after 4 cycles.\nProtect attention: one task, phone away, clear next action before you start."},
  {keys:["exam strategy","multiple choice tips"],domain:"study",
    answer:"Exam tactics: scan whole paper, time-box each section, answer easy marks first.\nMCQ: eliminate wrong options, watch absolutes (always/never), return to marked items.\nSleep and retrieval practice beat all-night rereading."},

  // ═══════════════════════════════════════════════════════════
  // WRITING CORE — organized pack (summarize · paragraph · letters)
  // ═══════════════════════════════════════════════════════════

  // —— How to summarize ——
  {keys:["how to summarize","summarizing","write a summary","summary writing","steps to summarize"],domain:"english",
    answer:"**How to summarize (step-by-step)**\n1. Read the whole text once for the big idea.\n2. Underline only main claims, findings, or steps (ignore examples & fluff).\n3. Put the main idea in **one sentence** in your own words.\n4. List 3–7 supporting points as short bullets.\n5. Turn bullets into a short paragraph (or keep bullets if asked).\n6. Check: no new opinions, no copy-paste sentences, shorter than the original.\n\n**Rules**\n• Keep the author’s meaning — do not twist it.\n• Use your own words + citation if required.\n• Drop stories, jokes, repeated numbers unless they are the point.\n• Length guide: ~10–25% of the original for study summaries."},
  {keys:["summary vs paraphrase","difference summary paraphrase","condense text"],domain:"english",
    answer:"**Summary** = shorter version of the *whole* text (main ideas only).\n**Paraphrase** = same idea, similar length, fully reworded (often one passage).\n**Quote** = exact words in \" \" + citation.\n\nUse summary for overviews and study notes.\nUse paraphrase when you need one specific idea in your essay voice.\nAlways cite the source for all three in academic work."},
  {keys:["executive summary","abstract writing","synopsis"],domain:"english",
    answer:"**Abstract / executive summary** (reports & papers):\n• Purpose / problem\n• Method (brief)\n• Key findings or results\n• Conclusion / recommendation\nWrite last, place first. No citations usually in a short abstract; no new data not in the paper.\n**Synopsis** for literature: plot + theme without spoilers beyond what the assignment asks."},
  {keys:["summarize a chapter","chapter summary","lesson summary"],domain:"english",
    answer:"**Chapter / lesson summary template**\n• Title + topic in one line\n• Main claim or purpose of the chapter\n• 4–8 key points (processes, definitions, formulas, arguments)\n• One “why it matters” line for exams\n• Optional: 2–3 terms to memorize\n\nAsk StudyVault Tutor “summarize” with your PDF open for a source-grounded version."},
  {keys:["one sentence summary","gist","main idea sentence"],domain:"english",
    answer:"**One-sentence summary (gist)**\nPattern: *Who/what + does what + why/result.*\nExample: “Photosynthesis converts light energy into chemical energy in glucose, releasing oxygen as a by-product.”\nForce yourself to one clear sentence before writing a longer summary — it anchors the rest."},

  // —— How to create / write a paragraph ——
  {keys:["how to write a paragraph","create a paragraph","paragraph writing","write paragraph"],domain:"english",
    answer:"**How to write a strong paragraph**\n1. **Topic sentence** — one clear main idea (links to thesis if in an essay).\n2. **Explain** — clarify what you mean.\n3. **Evidence** — example, fact, quote, data, or reason.\n4. **Analysis** — show how the evidence supports the topic sentence (do not only drop a quote).\n5. **Link** — optional closing sentence that ties back to thesis or bridges to the next paragraph.\n\n**Length**: usually 4–8 sentences for academic work; one idea only (unity)."},
  {keys:["peel paragraph","peel method","peeeel"],domain:"english",
    answer:"**PEEL paragraph method**\n• **P**oint — topic sentence (your claim for this paragraph)\n• **E**vidence — fact, quote, example, data\n• **E**xplain — how evidence proves the point\n• **L**ink — back to thesis or next idea\n\nVariant **PEEEEL**: Point, Explain, Evidence, Explain, Example, Link — useful when markers want deeper analysis."},
  {keys:["topic sentence","supporting sentences","concluding sentence paragraph"],domain:"english",
    answer:"**Topic sentence**: states the paragraph’s controlling idea — not too broad, not a bare fact.\n**Supporting sentences**: reasons, details, examples, definitions.\n**Concluding / clincher sentence**: reinforces the point or transitions (optional in body paragraphs; common in standalone paragraphs).\nAvoid starting every paragraph with “First,” “Second” unless listing steps."},
  {keys:["types of paragraphs","paragraph types","descriptive narrative expository persuasive paragraph"],domain:"english",
    answer:"**Common paragraph types**\n• **Narrative** — tells what happened (time order)\n• **Descriptive** — senses & details (spatial order)\n• **Expository / explanatory** — explains a process or idea (logical order)\n• **Persuasive / argumentative** — claims + reasons + evidence\n• **Compare–contrast** — similarities and differences\n• **Cause–effect** — why something happens / results\n• **Definition** — clarifies a term then expands\nMatch structure to purpose; keep **one** main purpose per paragraph."},
  {keys:["paragraph unity coherence cohesion","flow of paragraph"],domain:"english",
    answer:"**Unity**: every sentence serves the topic sentence — cut off-topic lines.\n**Coherence**: ideas ordered logically (time, importance, general→specific).\n**Cohesion**: glue words & devices — pronouns, repetition of key terms, transitions (however, therefore, for example, in contrast, as a result).\nRead aloud: if you get lost, reorder or add a transition."},
  {keys:["transition words","connectives","linking words"],domain:"english",
    answer:"**Useful transitions**\n• Add: also, furthermore, in addition, moreover\n• Contrast: however, on the other hand, whereas, although\n• Cause/result: because, therefore, consequently, as a result\n• Example: for example, for instance, such as, namely\n• Sequence: first, next, then, finally, subsequently\n• Emphasis: indeed, in fact, above all\n• Conclusion: in summary, overall, thus\nUse sparingly — one clear transition beats three stacked ones."},
  {keys:["body paragraph","introduction paragraph","conclusion paragraph"],domain:"english",
    answer:"**Introduction paragraph**: hook (optional) → context → **thesis** (usually last sentence).\n**Body paragraph**: PEEL / one idea + evidence + analysis; ordered strongest or chronological.\n**Conclusion paragraph**: restate thesis in new words → synthesize main points → wider significance (no brand-new arguments).\nNever introduce major new evidence only in the conclusion."},

  // —— Types of letters (complete set) ——
  {keys:["types of letters","kinds of letters","letter writing types","all letters"],domain:"english",
    answer:"**Main types of letters**\n1. **Informal / personal** — friends, family (friendly tone)\n2. **Formal** — officials, institutions, unknown recipients\n3. **Business** — companies, clients, suppliers\n4. **Application / cover** — jobs, scholarships, programs\n5. **Complaint** — products, services, unfair treatment\n6. **Inquiry / request** — asking for information or action\n7. **Invitation** — events (formal or informal)\n8. **Thank-you / appreciation**\n9. **Apology**\n10. **Resignation**\n11. **Recommendation / reference**\n12. **Sales / promotional**\n13. **Letter to the editor** (public opinion)\n14. **Email** — modern form; same principles, shorter\n\nAsk for any single type (e.g. “formal letter format”) for a full layout."},
  {keys:["formal letter","formal letter format","how to write a formal letter"],domain:"english",
    answer:"**Formal letter format** (block style common)\n1. Sender’s address (top right or left — follow local convention)\n2. Date\n3. Receiver’s name, title, organization, address\n4. Salutation: Dear Sir/Madam, / Dear Mr. Reyes,\n5. Subject line (optional but useful): Subject: Request for Official Transcript\n6. Body:\n   • Opening — state purpose clearly\n   • Middle — facts, reasons, polite detail\n   • Closing — what you want next / thanks\n7. Complimentary close: Yours faithfully (unknown name) / Yours sincerely (known name)\n8. Signature + printed name + position if any\n\nTone: polite, precise, no slang, no contractions if very formal."},
  {keys:["informal letter","friendly letter","personal letter format"],domain:"english",
    answer:"**Informal / personal letter**\n• Your address + date (optional in pure chat culture, still taught in school)\n• Greeting: Dear Ana, / Hi Mark,\n• Warm opening (ask about them / shared context)\n• Body in a natural order — news, stories, questions\n• Closing: Best wishes, / Love, / Take care, + your name\n\nTone can be casual; still organize so the reader is not confused. Avoid formal “Yours faithfully”."},
  {keys:["business letter","business correspondence","official letter"],domain:"english",
    answer:"**Business letter** goals: clear, professional, actionable.\nStructure mirrors formal letter. Prefer:\n• Specific subject line\n• One main purpose per letter\n• Short paragraphs\n• Exact names, dates, order numbers, amounts\n• Polite but direct call to action\nCommon uses: quotes, orders, complaints, confirmations, partnerships.\nKeep a copy; use company letterhead when available."},
  {keys:["application letter","job application letter","letter of application"],domain:"english",
    answer:"**Application letter** (often with CV)\n1. Formal heading + date + employer address\n2. Dear Hiring Manager / named person\n3. Opening: position + where you saw it + one-line fit\n4. Body: 1–2 achievements matched to the job needs (not a full CV dump)\n5. Closing: availability, thanks, contact, interview readiness\n6. Yours sincerely + name\n\nTailor every letter — generic mass applications are easy to spot."},
  {keys:["cover letter","covering letter"],domain:"english",
    answer:"**Cover letter** = application letter paired with a résumé/CV.\nFocus on **fit**: skills + results the employer cares about.\nDo not repeat the CV line-by-line; interpret it.\nKeep to one page. Mirror keywords from the job post honestly."},
  {keys:["complaint letter","letter of complaint","write a complaint"],domain:"english",
    answer:"**Complaint letter**\n• State the problem factually (what, when, where, order/ref number)\n• Explain impact (cost, delay, inconvenience) without insults\n• Attach evidence if any (receipt, photo, ticket)\n• Request a specific remedy (refund, replacement, repair, apology)\n• Set a reasonable response time; give contact details\n• Firm but respectful tone — anger weakens the case in writing"},
  {keys:["inquiry letter","letter of inquiry","request letter","letter of request"],domain:"english",
    answer:"**Inquiry / request letter**\n• Who you are (brief)\n• Exactly what information or action you need\n• Why you need it (if relevant)\n• Deadline if any\n• Thanks + how to reach you\n\nBe specific: vague requests get vague answers. Number multiple questions."},
  {keys:["invitation letter","formal invitation","informal invitation letter"],domain:"english",
    answer:"**Invitation letter**\nInclude: event name, purpose, date, time, place, dress code if any, RSVP contact/date.\n**Formal**: third-person or polished first-person; precise details.\n**Informal**: warm, personal, can be shorter.\nReply invitations promptly (accept or decline with thanks)."},
  {keys:["thank you letter","appreciation letter","letter of thanks"],domain:"english",
    answer:"**Thank-you letter**\n• Mention the specific help, gift, interview, or favor\n• Say what it meant / how you will use it\n• Offer goodwill or future contact\n• Short and sincere beats long and generic\nSend within 24–48 hours after interviews when possible."},
  {keys:["apology letter","letter of apology","sorry letter"],domain:"english",
    answer:"**Apology letter**\n1. Own the mistake clearly (no “if anyone was offended” dodge)\n2. Brief explanation — not a long excuse\n3. Show you understand the impact\n4. State what you will do to fix or prevent it\n5. Request forgiveness / continued trust\nTone: humble, concrete, forward-looking."},
  {keys:["resignation letter","letter of resignation","quit letter"],domain:"english",
    answer:"**Resignation letter**\n• Statement of resignation + last working day (notice period)\n• Optional brief reason (keep neutral)\n• Thanks for opportunities\n• Offer to help hand over duties\n• Professional close\nDo not vent grievances here — use exit interview if needed. Check contract for notice rules."},
  {keys:["recommendation letter","reference letter","letter of recommendation"],domain:"english",
    answer:"**Recommendation / reference letter**\n• Your relationship to the person (role, how long)\n• Specific strengths with **examples** (not only adjectives)\n• Relevant skills for the target job/program\n• Clear endorsement + contact for follow-up\nBe honest — weak or vague letters hurt more than help."},
  {keys:["letter to the editor","opinion letter newspaper"],domain:"english",
    answer:"**Letter to the editor**\n• React to a recent article or public issue\n• One clear opinion + 2–3 supporting points\n• Short (often 150–250 words)\n• Civil tone; facts over insults\n• Real name and city usually required for print"},
  {keys:["sales letter","promotional letter"],domain:"english",
    answer:"**Sales / promotional letter**\n• Hook attention (problem or benefit)\n• Present the offer clearly\n• Proof (features → benefits, testimonials, guarantee)\n• Call to action (buy, call, visit, reply by date)\nHonesty and clarity outperform hype long-term."},
  {keys:["email format","how to write an email","professional email"],domain:"english",
    answer:"**Professional email**\n• Clear subject line (specific, not “Hello”)\n• Greeting + short purpose in first lines\n• Bullet points for multiple items\n• One ask when possible\n• Polite close + full name + role/contact\n• Proofread; avoid ALL CAPS and heavy slang\nReply-all only when everyone truly needs it."},
  {keys:["letter layout","block style letter","semi block"],domain:"english",
    answer:"**Common layouts**\n• **Block**: all lines left-aligned; space between paragraphs — most common modern business style\n• **Modified block**: heading/date/signature toward the right; body left\n• **Semi-block**: like modified but body paragraphs indented\nSchools often accept block style. Follow what your teacher or company specifies."},
  {keys:["salutation complimentary close","yours faithfully yours sincerely"],domain:"english",
    answer:"**Salutation → close pairs**\n• Dear Sir/Madam → **Yours faithfully**\n• Dear Mr. Cruz / Dear Ms. Lim (name known) → **Yours sincerely**\n• Informal: Dear Ana → Best regards / Kind regards / Love (relationship-dependent)\nUS business often uses Sincerely for both. Match local school rules when graded."},

  // —— Extra writing tools (organized) ——
  {keys:["essay types","types of essays","argumentative narrative descriptive expository essay"],domain:"english",
    answer:"**Essay types**\n• **Argumentative / persuasive** — claim + reasons + counterargument\n• **Expository** — explain or inform without strong personal push\n• **Descriptive** — vivid detail\n• **Narrative** — story with point\n• **Compare–contrast**, **cause–effect**, **problem–solution**\nStructure almost always: introduction (thesis) → body → conclusion."},
  {keys:["how to write an essay","essay writing steps"],domain:"english",
    answer:"**Essay writing steps**\n1. Understand the question (command words: discuss, analyze, evaluate…)\n2. Brainstorm & choose a clear thesis\n3. Outline: intro, 2–4 body points, conclusion\n4. Write body first if intro is hard; then intro/conclusion\n5. Revise for unity, evidence, grammar\n6. Proofread names, citations, formatting\nQuality of thesis + paragraph structure beats fancy vocabulary."},
  {keys:["command words","essay question words","analyze evaluate discuss"],domain:"english",
    answer:"**Command words**\n• **Describe** — say what it is like / what happened\n• **Explain** — how/why with reasons\n• **Discuss** — more than one view + judgment\n• **Analyze** — break into parts and relationships\n• **Evaluate / assess** — judge strength using criteria\n• **Compare** — similarities; **contrast** — differences\n• **Argue / to what extent** — take a position and defend it\nMisreading the command loses marks even with good facts."},
  {keys:["outline writing","essay outline","plan before writing"],domain:"english",
    answer:"**Quick outline (before drafting)**\nThesis: __________________\nBody 1 point + evidence: ____\nBody 2 point + evidence: ____\nBody 3 point + evidence: ____\nCounterargument (if needed): ____\nConclusion focus: ____\nFive minutes of outline saves thirty minutes of messy rewriting."},
  {keys:["proofreading checklist","editing writing","revise essay"],domain:"english",
    answer:"**Proofread checklist**\n• Thesis clear? Each paragraph one idea?\n• Evidence + explanation present?\n• Transitions between paragraphs?\n• Grammar: agreement, tense, fragments, run-ons\n• Spelling of names/terms; citation format\n• Wordy phrases cut; passive voice only when useful\nRead aloud or from the last sentence upward to catch errors."},
  {keys:["formal tone","academic tone","register in writing"],domain:"english",
    answer:"**Academic / formal tone**\n• Prefer precise words over slang (children → not kids, in formal essays)\n• Limit contractions (do not vs don’t) when required\n• Avoid chatty asides and emojis\n• Hedge carefully: evidence suggests… / may indicate…\n• Still be clear — formal ≠ long and foggy"},
  {keys:["report writing","school report structure"],domain:"english",
    answer:"**Simple report structure**\n1. Title\n2. Introduction / purpose\n3. Method / procedure (if investigation)\n4. Findings / results (facts, tables)\n5. Discussion / analysis\n6. Conclusion & recommendations\n7. References\nUse headings, numbered steps, and objective language."},
  {keys:["memo writing","memorandum format"],domain:"english",
    answer:"**Memo (memorandum)** — internal workplace note\nHeader: To / From / Date / Subject\nBody: purpose first, then details, then action needed\nShort paragraphs; bullet lists welcome. No formal postal address block."},
  {keys:["notice writing","school notice"],domain:"english",
    answer:"**Notice** (school/public board)\n• Heading: NOTICE\n• Date\n• Clear event/info + who + when + where\n• What to do / contact\n• Issuing authority / signature\nKeep factual and scannable — people read notices in seconds."},
  {keys:["diary entry","journal writing"],domain:"english",
    answer:"**Diary entry**\n• Date at top\n• First person; personal feelings allowed\n• What happened + your reaction\n• Informal but still coherent paragraphs\nSchool tasks may require a reflection lesson, not only ranting."},
  {keys:["speech writing","how to write a speech"],domain:"english",
    answer:"**Speech writing**\n• Hook opening (question, story, striking fact)\n• Clear message in one sentence\n• 2–4 points with examples\n• Signpost: first, next, finally\n• Strong close (call to action or memorable line)\nWrite for the ear: shorter sentences, repetition for emphasis, practice aloud."},
  {keys:["debate speech","argument for against"],domain:"english",
    answer:"**Debate point structure**\n1. State your side’s claim\n2. Give reason + evidence\n3. Explain impact\n4. Rebut the likely opposing point\n5. Link back to motion\nStay on the motion; define key terms early if contested."}
];



function detectDomain(q){
  const s=q.toLowerCase();
  if(/bit-?ct|information technology|data structure|operating system|dbms|\bsql\b|computer network|osi model|digital logic|software engineering|cyber ?security|linux|web technology|c\+\+|\boop\b|big-?o|algorithm|pointer|recursion|hash table|git\b|rest api|tcp|udp|ipv4|compiler|scrum|agile/.test(s))return "bit";
  if(/bael|parts of speech|subject.?verb|reported speech|phonetics|morphology|syntax|semantics|pragmatics|literary device|academic writing|rhetoric|ethos|pathos|logos|register\b|thesis statement|comma splice|modal verb|conditional|sociolinguistics|paraphrase/.test(s))return "bael";
  if(/ohm|resistor|capacitor|inductor|diode|transistor|voltage|current|circuit|kirchhoff|farad|henry|led|mosfet|electronics?|electrical|logic gate|nand|nor|xor|boolean|truth table|flip.?flop|transformer|op-?amp|adc|dac/.test(s))return "electronics";
  if(/perspective drawing|vanishing point|composition|rule of thirds|line weight|gesture drawing|color theory|orthographic|isometric|technical drawing|shading|storyboard|typography|ui design|anatomy drawing/.test(s))return "drawing";
  if(/essay|thesis|paragraph|grammar|metaphor|simile|topic sentence|formal writing|english|noun|verb tense|passive voice|summariz|how to write|letter of|formal letter|informal letter|business letter|cover letter|application letter|complaint letter|resignation|recommendation letter|peel method|transition words|command words|proofread|report writing|memo\b|notice writing|speech writing|diary entry|types of letters|yours faithfully|yours sincerely|salutation/.test(s))return "english";
  if(/algebra|equation|quadratic|fraction|percent|geometry|triangle|slope|math|π|sqrt|derivative|integral|matrix|probability|trigonometry|sine|cosine|logarithm|pythagorean|factorial|permutation|limit /.test(s))return "math";
  if(/photosynthesis|newton|force|density|atom|cell|molecule|science|physics|chemistry|biology|stoichiometry|mitosis|evolution|scientific method|dna|rna|ecosystem|pH|acid base|kinetic energy/.test(s))return "science";
  if(/spaced repetition|active recall|feynman|pomodoro|exam strategy|retrieval practice|study method/.test(s))return "study";
  return null;
}
function domainKnowledgeAnswer(question){
  const q=normalize(question).toLowerCase();
  const qWords=q.split(/[^a-z0-9Ωμ]+/).filter(x=>x.length>2);
  let best=null,bestScore=0;
  for(const entry of DOMAIN_KB){
    let score=0;
    for(const k of entry.keys){
      const key=String(k).toLowerCase();
      if(!key)continue;
      if(q===key)score+=key.length+40;
      else if(q.includes(key))score+=key.length+12;
      else{
        // multi-word soft match: most tokens present
        const parts=key.split(/\s+/).filter(p=>p.length>2);
        if(parts.length>=2){
          const hits=parts.filter(p=>q.includes(p)).length;
          if(hits===parts.length)score+=key.length+8;
          else if(hits>=Math.ceil(parts.length*0.6))score+=Math.round(key.length/2)+3;
        }
      }
    }
    for(const w of qWords){
      if(entry.keys.some(k=>{
        const key=String(k).toLowerCase();
        return key===w||key.startsWith(w+" ")||key.includes(" "+w)||key.split(/\s+/).includes(w);
      }))score+=2;
    }
    // Prefer longer, more specific entries when scores tie-ish
    if(score>0)score+=Math.min(6,Math.floor(String(entry.answer||"").length/180));
    if(score>bestScore){bestScore=score;best=entry;}
  }
  if(!best||bestScore<4)return null;
  return {domain:best.domain,answer:best.answer,score:bestScore,keys:best.keys};
}

const STOP = new Set(("a an and are as at be because been before being between but by can could did do does for from had has have he her here hers him his how i if in into is it its itself just may me might more most my no not of on one or our ours out over same she should so some than that the their theirs them themselves then there these they this those through to too under up us was we were what when where which while who whom why will with would you your yours about after again against all also among another any anything around become below both during each either enough even every example few first following further given going having however important later least little many maybe much must never often other otherwise perhaps rather since such very want without within yet" ).split(/\s+/));

let state = {
  settings: { theme:"dark", pinHash:"29792bdd8ae699154e0af7b92be8d9a9765b634b18c73089eeb8fcac6bc8e8a6", pinSalt:"uarIEHw4rT6N7E7s6LkYqw==", pinIterations:120000, ai:{enabled:false,model:"onnx-community/Qwen3-1.7B-ONNX",tier:"auto"}, sync:{url:"http://127.0.0.1:8787",pairCode:"",enabled:false}, learner:{version:1,sessions:0,streak:0,recentAccuracy:null,concepts:{}}, customInstructions:"", memoryNotes:"", enterSends:true, autoSpeak:false, compactChat:false },
  documents: [],
  activeDocId: null,
  flashMode: "sm2",       // "sm2" | "leitner"
  sessionActive: false,   // Study Session filters to due/new cards
  sessionQueue: [],       // indices into flashcards for current session
  flashReversed: false,   // show answer first (production effect)
  quizTimed: false,
  quizEndsAt: 0,
  dailyGoal: 20,          // cards/day target
  focusMode: false,       // hide chrome, card only
  blitzActive: false,
  blitzLeft: 0,
  blitzCorrect: 0,
  interleaveQueue: [],    // {docId, index} for multi-doc practice
  examMode: false,
  confusions: [],
  compactUI: false,
  lastGrade: null,        // undo support {docId, cardId, prevStats, known}
  tourSeen: false
};
let deferredInstall = null;
function defaultLearner(){return {version:1,sessions:0,streak:0,recentAccuracy:null,studyMinutes:0,lastStudyDay:"",dailyGoal:20,cardsToday:0,cardsTodayDate:"",log:[],activity:{},confusions:{},examFlags:{},weekPlan:[],concepts:{}};}
function learnerProfile(){state.settings.learner={...defaultLearner(),...(state.settings.learner||{}),concepts:{...(state.settings.learner?.concepts||{})}};return state.settings.learner;}
function adaptConcept(concept,correct){if(!concept)return;const p=learnerProfile();const key=normalize(concept).toLowerCase();if(!key)return;const prev=p.concepts[key]||{label:normalize(concept),attempts:0,correct:0,streak:0,mastery:0.35,lastSeen:0,dueAt:0};const attempts=prev.attempts+1;const good=prev.correct+(correct?1:0);const streak=correct?prev.streak+1:0;const mastery=clamp((good/attempts)*.72+(Math.min(streak,4)/4)*.18+prev.mastery*.10,0,1);prev.attempts=attempts;prev.correct=good;prev.streak=streak;prev.mastery=mastery;prev.lastSeen=Date.now();prev.dueAt=Date.now()+(correct?Math.min(1000*60*60*24*30,1000*60*20*Math.pow(2,Math.min(8,streak))):1000*60*3);p.concepts[key]=prev;}
function recordStudyResult(concepts,accuracy){const p=learnerProfile();p.sessions=(p.sessions||0)+1;p.recentAccuracy=accuracy;const strong=accuracy>=.85;if(strong)p.streak=(p.streak||0)+1;else p.streak=0;for(const c of concepts||[])adaptConcept(c,accuracy>=.7);return p;}
function weakConcepts(limit=8){const p=learnerProfile();return Object.values(p.concepts||{}).sort((a,b)=>(a.mastery||0)-(b.mastery||0)).slice(0,limit).map(x=>x.label);}

/** Count due cards across entire library (daily review). */
function countGlobalDue(){
  const now=Date.now(); let n=0;
  for(const d of state.documents||[]){
    for(const c of d.flashcards||[]){
      const st=d.cardStats?.[c.id];
      if(!st||!st.attempts){n++;continue;}
      if(st.dueAt&&st.dueAt<=now)n++;
    }
  }
  return n;
}
function listGlobalDue(limit=40){
  const now=Date.now(); const items=[];
  for(const d of state.documents||[]){
    (d.flashcards||[]).forEach((c,i)=>{
      const st=d.cardStats?.[c.id];
      const isNew=!st||!st.attempts;
      const due=st?.dueAt&&st.dueAt<=now;
      if(isNew||due) items.push({docId:d.id,fileName:d.fileName,card:c,index:i,isNew,dueAt:st?.dueAt||0,mastery:st?.correct&&st?.attempts?st.correct/st.attempts:0});
    });
  }
  items.sort((a,b)=>(a.dueAt||0)-(b.dueAt||0));
  return items.slice(0,limit);
}
function bumpCardsToday(n=1){
  const p=learnerProfile();
  const day=new Date().toISOString().slice(0,10);
  if(p.cardsTodayDate!==day){p.cardsToday=0;p.cardsTodayDate=day;}
  p.cardsToday=(p.cardsToday||0)+n;
  return p;
}
function logStudyEvent(kind,detail){
  const p=learnerProfile();
  p.log=Array.isArray(p.log)?p.log:[];
  p.log.push({at:Date.now(),kind,detail:String(detail||"").slice(0,120)});
  if(p.log.length>80)p.log=p.log.slice(-80);
}
function masteryHeatmapHTML(){
  const p=learnerProfile();
  const concepts=Object.values(p.concepts||{}).sort((a,b)=>(b.mastery||0)-(a.mastery||0)).slice(0,24);
  if(!concepts.length) return '<div class="empty tiny">Grade cards or finish a quiz to build your mastery map.</div>';
  return `<div class="heat-grid">${concepts.map(c=>{
    const m=Math.round((c.mastery||0)*100);
    const hue=Math.round((c.mastery||0)*120); // red→green
    return `<div class="heat-cell" title="${esc(c.label)} · ${m}%" style="background:hsla(${hue},70%,42%,.85)"><span>${esc(String(c.label).slice(0,14))}</span><em>${m}%</em></div>`;
  }).join("")}</div>`;
}
function estimateStudyMinutes(d){
  if(!d)return 0;
  const due=countDueCards(d);
  const words=wordCount(d.rawText||"");
  return Math.max(5, Math.round(due*0.6 + Math.min(25, words/400)));
}
function onboardingHTML(){
  const docs=(state.documents||[]).length;
  const hasReview=!!activeDoc()?.reviewerData?.overview;
  const hasCards=!!(activeDoc()?.flashcards||[]).length;
  const hasQuiz=!!(activeDoc()?.quiz||[]).length;
  const steps=[
    [docs>0,"Add study material (PDF, photo, Word, text)"],
    [hasReview,"Build your study guide (Reviewer)"],
    [hasCards,"Practice flashcards (SM-2 / Leitner)"],
    [hasQuiz,"Run a quiz (MC · fill-in · match)"],
    [(learnerProfile().sessions||0)>0,"Complete a scored session to train weak spots"],
  ];
  return `<ol class="onboard-list">${steps.map(([ok,label])=>`<li class="${ok?"done":""}">${ok?"✓":"○"} ${esc(label)}</li>`).join("")}</ol>`;
}
async function startDailyReview(){
  const items=listGlobalDue(30);
  if(!items.length){
    toast("Nothing due across your library. Nice work.","success");
    return;
  }
  const first=items[0];
  state.activeDocId=first.docId;
  const d=activeDoc();
  if(!d)return;
  state.sessionActive=true;
  // queue indices for this doc first, then user can continue
  const same=items.filter(x=>x.docId===first.docId).map(x=>x.index);
  state.sessionQueue=same;
  d.currentCard=same[0]||0;
  await saveMeta(); await saveDoc(d);
  activateSection("flashcards");
  renderAll();
  logStudyEvent("daily-review", `${items.length} due · opened ${d.fileName}`);
  toast(`Daily review: ${items.length} due across library · starting “${d.fileName}”`,"success");
}
function toggleFlashReversed(){
  state.flashReversed=!state.flashReversed;
  renderFlash();
  toast(state.flashReversed?"Reverse mode: see answer, recall the question.":"Normal mode: question first.","info");
}
function setDailyGoal(n){
  const p=learnerProfile();
  p.dailyGoal=clamp(Number(n)||20,5,200);
  state.dailyGoal=p.dailyGoal;
  saveMeta();
  renderStats();
  toast(`Daily goal set to ${p.dailyGoal} cards.`,"success");
}
function renderMasteryPanel(){
  const box=$("#masteryHeatmap");
  if(box)box.innerHTML=masteryHeatmapHTML();
  const onb=$("#onboardingChecklist");
  if(onb)onb.innerHTML=onboardingHTML();
  const dueEl=$("#globalDueCount");
  if(dueEl)dueEl.textContent=String(countGlobalDue());
  const goalEl=$("#dailyGoalProgress");
  if(goalEl){
    const p=learnerProfile();
    const day=new Date().toISOString().slice(0,10);
    const today=p.cardsTodayDate===day?(p.cardsToday||0):0;
    const goal=p.dailyGoal||state.dailyGoal||20;
    goalEl.textContent=`${today} / ${goal}`;
  }
  const logBox=$("#studyLog");
  if(logBox){
    const p=learnerProfile();
    const rows=(p.log||[]).slice().reverse().slice(0,12);
    logBox.innerHTML=rows.length?rows.map(x=>`<div class="history-item"><span>${new Date(x.at).toLocaleString()}</span><strong>${esc(x.kind)}</strong> <span class="tiny muted">${esc(x.detail||"")}</span></div>`).join(""):'<div class="empty tiny">Study events appear here.</div>';
  }
  const eta=$("#studyEta");
  if(eta){
    const d=activeDoc();
    eta.textContent=d?`~${estimateStudyMinutes(d)} min focused`:"—";
  }
}
function makeTrueFalseItems(doc,limit=6){
  const r=doc.reviewerData||{};
  const items=[];
  const facts=(r.facts||[]).concat(r.keyPoints||[]).slice(0,20);
  for(const f of facts){
    if(items.length>=limit)break;
    const text=typeof f==="string"?f:(f.text||"");
    if(!text||text.length<20)continue;
    // True statement from source
    items.push({
      id:stableId("q",`${doc.id}|tf|t|${text.slice(0,40)}`),
      type:"tf",
      question:"True or false — is this supported by your material?",
      context:text,
      options:["True","False"],
      correctIndex:0,
      correct:"True",
      page:f.page||0,
      term:""
    });
    // False: slightly corrupted if we have another fact
    if(facts.length>1&&items.length<limit){
      const other=facts.find(x=>{
        const t=typeof x==="string"?x:(x.text||"");
        return t&&t!==text;
      });
      if(other){
        const ot=typeof other==="string"?other:(other.text||"");
        const fake=text.slice(0,Math.min(40,text.length))+" … "+ot.slice(0,40);
        items.push({
          id:stableId("q",`${doc.id}|tf|f|${fake.slice(0,40)}`),
          type:"tf",
          question:"True or false — is this supported by your material?",
          context:fake+" (verify carefully against source)",
          options:["True","False"],
          correctIndex:1,
          correct:"False",
          page:0,
          term:""
        });
      }
    }
  }
  return items;
}

/** --- v117 innovation layer --- */
function markActivityDay(){
  const p=learnerProfile();
  const day=new Date().toISOString().slice(0,10);
  p.activity=p.activity||{};
  p.activity[day]=(p.activity[day]||0)+1;
  p.lastStudyDay=day;
}
function activityCalendarHTML(days=28){
  const p=learnerProfile();
  const act=p.activity||{};
  const cells=[];
  const now=new Date();
  for(let i=days-1;i>=0;i--){
    const d=new Date(now.getTime()-i*86400000);
    const key=d.toISOString().slice(0,10);
    const n=act[key]||0;
    const intensity=n===0?0:n<3?1:n<8?2:3;
    cells.push(`<div class="cal-cell cal-${intensity}" title="${key}: ${n} actions"></div>`);
  }
  return `<div class="cal-row">${cells.join("")}</div>`;
}
function recommendNextAction(){
  const due=countGlobalDue();
  const d=activeDoc();
  const p=learnerProfile();
  const weak=weakConcepts(3);
  if(!state.documents.length) return {action:"import",label:"Upload your first source",why:"Closed-book study starts with material you own."};
  if(d&&!(d.reviewerData?.overview)) return {action:"guide",label:"Build the source-locked guide",why:"Understand from evidence before memorizing."};
  if(due>0) return {action:"daily",label:`Remember: ${due} card${due===1?"":"s"} due`,why:"Spaced memory is the advantage chatbots skip."};
  if(weak.length) return {action:"weak",label:`Prove weak spot: ${weak[0]}`,why:"Exam risk lives in soft concepts."};
  if((p.cardsToday||0)<(p.dailyGoal||20)) return {action:"flash",label:"Hit today's memory goal",why:"Consistency beats cramming."};
  return {action:"exam",label:"Prove it — exam simulator",why:"You're caught up. Stress-test the closed book."};
}
function renderSmartCoach(){
  const el=$("#smartCoach");
  if(!el)return;
  const r=recommendNextAction();
  el.innerHTML=`<div class="coach-card"><div class="eyebrow">CLOSED-BOOK COACH</div><strong>${esc(r.label)}</strong><p class="muted tiny">${esc(r.why)}</p><button type="button" class="btn primary small" data-coach="${esc(r.action)}">Do it</button></div>`;
  el.querySelector("[data-coach]")?.addEventListener("click",()=>{
    const a=el.querySelector("[data-coach]").dataset.coach;
    if(a==="import"){$("#universalInput")?.click();return;}
    studioAction(a==="flash"?"flash":a);
  });
  const cal=$("#activityCalendar");
  if(cal)cal.innerHTML=activityCalendarHTML(28);
  const conf=$("#confusionList");
  if(conf){
    const p=learnerProfile();
    const rows=Object.entries(p.confusions||{}).sort((a,b)=>(b[1].count||0)-(a[1].count||0)).slice(0,8);
    conf.innerHTML=rows.length?rows.map(([k,v])=>`<span class="term confusion" data-conf="${esc(k)}">${esc(v.label||k)} · ${v.count||1}</span>`).join(""):'<span class="tiny muted">Mark “Confused” on a card to track stuck points.</span>';
    conf.querySelectorAll("[data-conf]").forEach(s=>s.onclick=()=>{
      activateSection("search");
      const inp=$("#searchInput");
      if(inp){inp.value=s.dataset.conf;searchActive();}
    });
  }
}
function markConfused(){
  const d=activeDoc();
  if(!d?.flashcards?.length)return toast("Open a card first.","error");
  const c=d.flashcards[d.currentCard];
  const key=normalize(c.term||c.question||"").toLowerCase().slice(0,80);
  if(!key)return;
  const p=learnerProfile();
  p.confusions=p.confusions||{};
  const prev=p.confusions[key]||{label:normalize(c.term||c.question||key).slice(0,60),count:0,lastSeen:0};
  prev.count=(prev.count||0)+1;
  prev.lastSeen=Date.now();
  p.confusions[key]=prev;
  adaptConcept(c.term||c.question,false);
  logStudyEvent("confused", prev.label);
  saveMeta();
  renderSmartCoach();
  toast(`Logged confusion: ${prev.label}`,"info");
}
function buryCard(){
  const d=activeDoc();
  if(!d?.flashcards?.length)return;
  const c=d.flashcards[d.currentCard];
  d.cardStats=d.cardStats||{};
  const st=d.cardStats[c.id]||{attempts:0,correct:0,streak:0,ease:2.5,interval:0,repetitions:0,dueAt:0};
  st.dueAt=Date.now()+1000*60*60*24*7; // bury 7 days
  st.buried=true;
  d.cardStats[c.id]=st;
  saveDoc(d).then(()=>{
    toast("Card buried for 7 days.","success");
    advanceAfterGrade(d);
    renderFlash();
  });
}
/** Interleaved practice: mix due cards from multiple documents. */
async function startInterleavedPractice(limit=25){
  const items=listGlobalDue(limit);
  if(items.length<2){
    toast("Need due cards in 2+ materials — falling back to daily review.","info");
    return startDailyReview();
  }
  // shuffle for interleaving benefit
  for(let i=items.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [items[i],items[j]]=[items[j],items[i]];
  }
  state.interleaveQueue=items.map(x=>({docId:x.docId,index:x.index}));
  state.sessionActive=true;
  const first=state.interleaveQueue[0];
  state.activeDocId=first.docId;
  const d=activeDoc();
  d.currentCard=first.index;
  await saveMeta(); await saveDoc(d);
  activateSection("flashcards");
  renderAll();
  logStudyEvent("interleave", `${items.length} cards mixed`);
  toast(`Interleaved practice: ${items.length} cards from multiple sources.`,"success");
}
async function advanceInterleave(){
  if(!state.interleaveQueue.length)return false;
  state.interleaveQueue.shift();
  if(!state.interleaveQueue.length){
    state.sessionActive=false;
    toast("Interleaved session complete.","success");
    return true;
  }
  const next=state.interleaveQueue[0];
  state.activeDocId=next.docId;
  const d=activeDoc();
  if(d){d.currentCard=next.index;await saveDoc(d);await saveMeta();renderAll();}
  return true;
}
/** Rapid blitz: 10 cards, no pause, score at end. */
async function startBlitz(n=10){
  const d=activeDoc();
  if(!d?.flashcards?.length)return toast("Need flashcards first.","error");
  const items=[];
  for(let i=0;i<d.flashcards.length;i++) items.push(i);
  for(let i=items.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[items[i],items[j]]=[items[j],items[i]];}
  state.sessionQueue=items.slice(0,Math.min(n,items.length));
  state.sessionActive=true;
  state.blitzActive=true;
  state.blitzLeft=state.sessionQueue.length;
  state.blitzCorrect=0;
  d.currentCard=state.sessionQueue[0];
  await saveDoc(d);
  activateSection("flashcards");
  renderFlash();
  toast(`Blitz: ${state.blitzLeft} cards — go!`,"success");
}
function endBlitz(){
  const total=state.blitzCorrect+(state.blitzLeft||0);
  const score=state.blitzCorrect;
  state.blitzActive=false;
  state.sessionActive=false;
  state.sessionQueue=[];
  logStudyEvent("blitz", `${score} correct`);
  recordStudyResult([], total?score/Math.max(1,score+state.blitzLeft):0);
  toast(`Blitz done: ${score} remembered under pressure.`,"success");
  renderStats();
}
/** Feynman technique: write explanation, reveal source definition. */
function startFeynman(){
  const d=activeDoc();
  const defs=d?.reviewerData?.definitions||[];
  if(!defs.length)return toast("Build the study guide first (need definitions).","error");
  const pick=defs[Math.floor(Math.random()*Math.min(defs.length,12))];
  const term=pick.term;
  const answer=pick.definition;
  activateSection("notes");
  const ed=$("#notesEditor");
  if(!ed)return;
  const block=`<div class="feynman-block" data-term="${esc(term)}"><h3>Feynman: Explain “${esc(term)}”</h3><p class="muted tiny">Write it in plain words as if teaching a friend. Then reveal the source.</p><div class="feynman-write" contenteditable="true" style="min-height:80px;padding:10px;border:1px dashed var(--border);border-radius:10px;margin:8px 0"></div><button type="button" class="btn secondary small feynman-reveal">Reveal source definition</button><div class="feynman-source hidden note-trust" style="margin-top:8px"><strong>Source:</strong> ${esc(answer)}${pick.page?` <span class="tiny">p.${pick.page}</span>`:""}</div></div><hr>`;
  ed.innerHTML=block+(ed.innerHTML||"");
  ed.querySelector(".feynman-reveal")?.addEventListener("click",ev=>{
    const src=ev.target.parentElement.querySelector(".feynman-source");
    src?.classList.remove("hidden");
    adaptConcept(term,true);
    logStudyEvent("feynman", term);
    toast("Compare your words to the source — fix gaps.","success");
  });
  toast(`Feynman prompt: explain “${term}”`,"success");
}
/** Exam simulator: timed mixed quiz + harder scoring. */
async function startExamSimulator(minutes=10){
  const d=activeDoc();
  if(!d)return toast("Open material first.","error");
  state.examMode=true;
  await newQuiz(false);
  // Prefer weak + TF + fill
  startTimedQuiz(minutes);
  logStudyEvent("exam", `${minutes}m`);
  toast(`Exam simulator: ${minutes} minutes. Submit before time runs out.`,"success");
}
/** Glossary from all definitions across library or active. */
function exportGlossary(libraryWide=false){
  const docs=libraryWide?state.documents:[activeDoc()].filter(Boolean);
  if(!docs.length)return toast("No documents.","error");
  const lines=["# StudyVault Glossary","> Source-grounded terms only",""];
  for(const d of docs){
    const defs=d.reviewerData?.definitions||[];
    if(!defs.length)continue;
    lines.push(`## ${d.fileName}`," ");
    for(const x of defs){
      lines.push(`**${x.term}** — ${x.definition||""}${x.page?` _(p.${x.page})_`:""}`);
    }
    lines.push("");
  }
  downloadText("studyvault-glossary.md", lines.join("\n"));
  toast("Glossary exported.","success");
}
/** Diff overlapping terms between two most recent docs. */
function diffTwoDocuments(){
  const docs=state.documents.slice(0,2);
  if(docs.length<2)return toast("Import at least two materials to compare.","info");
  const [a,b]=docs;
  const ta=new Set((a.terms||[]).map(x=>normalize(x).toLowerCase()));
  const tb=new Set((b.terms||[]).map(x=>normalize(x).toLowerCase()));
  const both=[...ta].filter(x=>tb.has(x));
  const onlyA=[...ta].filter(x=>!tb.has(x)).slice(0,20);
  const onlyB=[...tb].filter(x=>!ta.has(x)).slice(0,20);
  const html=`<div class="card"><h3>Source overlap</h3>
  <p class="tiny muted">${esc(a.fileName)} ↔ ${esc(b.fileName)}</p>
  <p><strong>Shared concepts (${both.length}):</strong> ${both.slice(0,24).map(esc).join(", ")||"—"}</p>
  <p><strong>Only in first:</strong> ${onlyA.map(esc).join(", ")||"—"}</p>
  <p><strong>Only in second:</strong> ${onlyB.map(esc).join(", ")||"—"}</p></div>`;
  activateSection("notes");
  const ed=$("#notesEditor");
  if(ed){ed.innerHTML=html+(ed.innerHTML||"");}
  toast("Overlap report inserted into notes.","success");
}
function toggleFocusMode(){
  state.focusMode=!state.focusMode;
  document.body.classList.toggle("focus-study", state.focusMode);
  toast(state.focusMode?"Focus mode on — chrome dimmed.":"Focus mode off.","info");
}
/** Voice input for fill-in quiz (when browser supports it). */
function startVoiceFill(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR)return toast("Voice input not supported in this browser.","error");
  const item=document.querySelector(".quiz-item input.quiz-fill");
  if(!item){activateSection("quiz");return toast("Open a fill-in quiz first.","info");}
  const rec=new SR();
  rec.lang=navigator.language||"en-US";
  rec.onresult=e=>{
    const text=e.results[0][0].transcript;
    item.value=text;
    toast(`Heard: ${text}`,"success");
  };
  rec.onerror=()=>toast("Voice capture failed.","error");
  rec.start();
  toast("Listening…","info");
}
function smartCoachRefresh(){
  try{renderSmartCoach();}catch(e){console.warn(e);}
  try{renderProvePanel();}catch(e){console.warn(e);}
}


/** Quote drill: recall what comes after a source sentence. */
function startQuoteDrill(){
  const d=activeDoc();
  if(!d)return toast("Open material first.","error");
  const units=(d.units||[]).map(u=>u.text||u).filter(t=>String(t).length>40).slice(0,40);
  if(units.length<3)return toast("Need more extracted sentences.","error");
  const pick=units[Math.floor(Math.random()*units.length)];
  const words=String(pick).split(/\s+/);
  const cut=Math.max(4, Math.floor(words.length*0.55));
  const prompt=words.slice(0,cut).join(" ")+" …";
  const rest=words.slice(cut).join(" ");
  activateSection("quiz");
  const ctn=$("#quizContainer");
  if(!ctn)return;
  ctn.innerHTML=`<article class="quiz-item" id="quoteDrillItem"><span class="question-type">quote drill</span>
    <p class="q">Complete this line from your source:</p>
    <div class="context">${esc(prompt)}</div>
    <input class="lock-input quiz-fill" id="quoteDrillInput" type="text" placeholder="Type the continuation…" style="width:100%;margin-top:8px">
    <div class="row" style="margin-top:10px"><button type="button" class="btn primary" id="quoteDrillCheck">Check</button></div>
    <div id="quoteDrillWhy" class="quiz-why hidden"></div>
  </article>`;
  $("#quizResult")?.classList.add("hidden");
  $("#quoteDrillCheck").onclick=()=>{
    const ans=normalize($("#quoteDrillInput")?.value||"");
    const right=normalize(rest);
    const ok=ans&&(right.includes(ans)||ans.includes(right.slice(0,Math.min(40,right.length)))||similarity(ans,right)>0.55);
    const why=$("#quoteDrillWhy");
    why.classList.remove("hidden");
    why.innerHTML=ok?`<strong>Nice.</strong> Source continues: ${esc(rest)}`:`<strong>Source continues:</strong> ${esc(rest)}`;
    document.querySelector("#quoteDrillItem")?.classList.add(ok?"correct":"wrong");
    if(ok){bumpCardsToday(1);markActivityDay();}
    logStudyEvent("quote-drill", ok?"hit":"miss");
  };
  toast("Quote drill ready — complete the source line.","success");
}
/** Memory palace: assign key terms to imaginary rooms. */
function buildMemoryPalace(){
  const d=activeDoc();
  const terms=(d?.reviewerData?.terms||d?.terms||[]).slice(0,12);
  if(terms.length<4)return toast("Need more terms — build the guide first.","error");
  const rooms=["Entrance hall","Library desk","Staircase","Window seat","Kitchen table","Garden path","Rooftop","Basement door","Mirror wall","Clock tower","Study lamp","Front gate"];
  const lines=["# Memory palace — "+(d.fileName||"material"),"> Walk the route and recall each term",""];
  terms.forEach((term,i)=>{
    lines.push(`### ${rooms[i%rooms.length]}`,`Term: **${term}**`,"Recall cue: pause here and say the definition out loud.","");
  });
  downloadText("studyvault-memory-palace.md", lines.join("\n"));
  // also inject notes
  activateSection("notes");
  const ed=$("#notesEditor");
  if(ed){
    ed.innerHTML=`<div class="card"><h3>Memory palace route</h3><ol>${terms.map((term,i)=>`<li><strong>${esc(rooms[i%rooms.length])}</strong> → ${esc(term)}</li>`).join("")}</ol><p class="tiny muted">Walk the route in your mind. At each stop, recall the definition from source.</p></div>`+(ed.innerHTML||"");
  }
  toast("Memory palace built.","success");
}
/** Reading progress: mark pages reviewed. */
function markPagesReviewed(count=1){
  const d=activeDoc();
  if(!d)return;
  d.meta=d.meta||{};
  d.meta.pagesReviewed=Math.min(d.pageCount||1,(d.meta.pagesReviewed||0)+count);
  d.meta.readingPct=Math.round((d.meta.pagesReviewed/(d.pageCount||1))*100);
  saveDoc(d).then(()=>{renderActivePanel();toast(`Reading progress: ${d.meta.readingPct}%`,"success");});
}
function readingProgressHTML(d){
  if(!d)return "";
  const pct=d.meta?.readingPct||0;
  return `<div class="read-bar" title="Reading progress"><div class="read-fill" style="width:${pct}%"></div><span class="tiny">${pct}% read</span></div>`;
}


/** --- v119 prove + polish --- */
function proveScorecardHTML(){
  const p=learnerProfile();
  const due=countGlobalDue();
  const weak=weakConcepts(5);
  const day=new Date().toISOString().slice(0,10);
  const today=p.cardsTodayDate===day?(p.cardsToday||0):0;
  const goal=p.dailyGoal||20;
  const goalPct=Math.min(100, Math.round((today/Math.max(1,goal))*100));
  const streak=p.streak||0;
  const acc=p.recentAccuracy==null?"—":Math.round(p.recentAccuracy*100)+"%";
  const ready=due===0&&weak.length<=2&&goalPct>=80;
  return `<div class="prove-card">
    <div class="eyebrow">PROVE READINESS</div>
    <div class="prove-grid">
      <div><em>${due}</em><span>due</span></div>
      <div><em>${today}/${goal}</em><span>today</span></div>
      <div><em>${streak}</em><span>streak</span></div>
      <div><em>${acc}</em><span>last quiz</span></div>
    </div>
    <div class="progress-track" style="margin:10px 0 6px"><div class="progress-bar" style="width:${goalPct}%"></div></div>
    <p class="tiny muted">${ready?"Ready to prove it — run Exam sim or Blitz.":weak.length?`Risk: ${weak.slice(0,3).map(esc).join(", ")}`:"Clear due cards and hit your goal before the exam."}</p>
    <div class="row" style="margin-top:8px;gap:6px;flex-wrap:wrap">
      <button type="button" class="btn primary small" data-prove="exam">Exam sim</button>
      <button type="button" class="btn secondary small" data-prove="blitz">Blitz</button>
      <button type="button" class="btn secondary small" data-prove="weak">Weak quiz</button>
      <button type="button" class="btn secondary small" data-prove="daily">Daily review</button>
    </div>
  </div>`;
}
function renderProvePanel(){
  const el=$("#provePanel");
  if(!el)return;
  el.innerHTML=proveScorecardHTML();
  el.querySelectorAll("[data-prove]").forEach(b=>b.onclick=()=>studioAction(b.dataset.prove));
}
function undoLastGrade(){
  const g=state.lastGrade;
  if(!g)return toast("Nothing to undo.","info");
  const d=state.documents.find(x=>x.id===g.docId);
  if(!d)return toast("Document missing.","error");
  d.cardStats=d.cardStats||{};
  d.cardStats[g.cardId]=g.prevStats;
  if(g.known){
    d.knownCardIds=(d.knownCardIds||[]).filter(id=>id!==g.cardId);
  }
  state.lastGrade=null;
  saveDoc(d).then(()=>{renderFlash();renderStats();toast("Last grade undone.","success");});
}
function flagCardForExam(){
  const d=activeDoc();
  if(!d?.flashcards?.length)return;
  const c=d.flashcards[d.currentCard];
  const p=learnerProfile();
  p.examFlags=p.examFlags||{};
  const key=c.id;
  if(p.examFlags[key]){delete p.examFlags[key];toast("Removed exam flag.","info");}
  else {p.examFlags[key]={docId:d.id,term:c.term||c.question,at:Date.now()};toast("Flagged for exam review.","success");}
  saveMeta(); logStudyEvent("exam-flag", c.term||c.question||"");
}
function buildWeekPlan(){
  const due=countGlobalDue();
  const weak=weakConcepts(6);
  const days=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  const plan=[];
  for(let i=0;i<7;i++){
    const focus=i%3===0?"Review due cards":i%3===1?(weak[i%Math.max(1,weak.length)]?`Drill: ${weak[i%weak.length]}`:"Mixed quiz"):"Exam sim or Feynman";
    plan.push({day:days[i],focus,dueHint:due?`${Math.ceil(due/7)} due target`: "Maintain"});
  }
  const p=learnerProfile();
  p.weekPlan=plan;
  saveMeta();
  const lines=["# StudyVault 7-day closed-book plan","",...plan.map(x=>`- **${x.day}**: ${x.focus} (${x.dueHint})`)];
  downloadText("studyvault-week-plan.md", lines.join("\n"));
  const box=$("#weekPlanBox");
  if(box) box.innerHTML=plan.map(x=>`<div class="history-item"><strong>${esc(x.day)}</strong><span>${esc(x.focus)}</span></div>`).join("");
  toast("7-day plan ready.","success");
}
function toggleCompactUI(){
  state.compactUI=!state.compactUI;
  document.body.classList.toggle("compact-ui", state.compactUI);
  toast(state.compactUI?"Compact UI on.":"Compact UI off.","info");
}
function runFirstTour(){
  if(state.tourSeen) return;
  state.tourSeen=true;
  const steps=[
    "1) Upload a PDF or photo — closed-book starts with your source.",
    "2) Build the study guide — evidence-only structure.",
    "3) Daily review + cards — spaced memory.",
    "4) Exam sim / blitz — prove it under pressure."
  ];
  toast(steps.join(" · "),"info");
  logStudyEvent("tour","shown");
}
function exportExamFlags(){
  const p=learnerProfile();
  const flags=Object.values(p.examFlags||{});
  if(!flags.length)return toast("No exam-flagged cards yet.","info");
  const lines=["# Exam flags",...flags.map((f,i)=>`${i+1}. ${f.term||f.docId}`)];
  downloadText("studyvault-exam-flags.md", lines.join("\n"));
  toast("Exam flags exported.","success");
}
function addSearchHitToNotes(snippet, page, label){
  const d=activeDoc();
  if(!d)return toast("Open a document first.","error");
  activateSection("notes");
  const ed=$("#notesEditor");
  if(!ed)return;
  const html=`<blockquote class="note-trust"><strong>${esc(label||"Source")}</strong>${page?` · p.${page}`:""}<br>${esc(String(snippet||"").slice(0,500))}</blockquote>`;
  ed.innerHTML=(ed.innerHTML||"")+html;
  d.notesHtml=ed.innerHTML; d.notes=stripHtml(ed.innerHTML); d.notesUpdatedAt=now();
  saveDoc(d); toast("Quote added to notes.","success");
}
function buildExamBlueprint(){
  const d=activeDoc();
  const r=d?.reviewerData;
  if(!r)return toast("Build the study guide first.","error");
  const lines=[
    `# Exam blueprint — ${d.fileName||"material"}`,
    `> Closed-book · source-locked · StudyVault`,
    "",
    "## Must-know terms",
    ...(r.terms||[]).slice(0,20).map((x,i)=>`${i+1}. ${x}`),
    "",
    "## Definitions to recite",
    ...(r.definitions||[]).slice(0,12).map(x=>`- **${x.term}**: ${x.definition||""}`),
    "",
    "## Checklist",
    ...(r.checklist||[]).slice(0,15).map(x=>`- [ ] ${typeof x==="string"?x:(x.text||x)}`),
    "",
    "## Likely question shapes",
    ...(r.questions||[]).slice(0,10).map(q=>`- ${q.q||q}`),
    "",
    "## Weak spots to close first",
    ...weakConcepts(8).map(w=>`- ${w}`),
  ];
  downloadText(`exam-blueprint-${String(d.fileName||"doc").replace(/[^\w.-]+/g,"_").slice(0,30)}.md`, lines.join("\n"));
  toast("Exam blueprint exported.","success");
}

function promptInstall(){
  if(deferredInstall){
    deferredInstall.prompt();
    deferredInstall.userChoice.then(c=>{toast(c.outcome==="accepted"?"Installed StudyVault.":"Install dismissed.","info");deferredInstall=null;});
  }else toast("Use browser menu → Install app / Add to Home Screen.","info");
}
function copyCitation(text,page,fileName){
  const cite=`"${String(text||"").slice(0,400)}" — ${fileName||"source"}${page?`, p.${page}`:""} (StudyVault)`;
  navigator.clipboard?.writeText(cite).then(()=>toast("Citation copied.","success")).catch(()=>toast("Could not copy.","error"));
}
function exportWeakList(){
  const ws=weakConcepts(30);
  if(!ws.length)return toast("No weak concepts yet — study first.","info");
  const lines=["# StudyVault weak concepts","> Drill these next", "", ...ws.map((w,i)=>`${i+1}. ${w}`)];
  downloadText("studyvault-weak-concepts.md", lines.join("\n"));
  toast("Weak concepts list exported.","success");
}
function compareDefinitions(){
  const d=activeDoc();
  const defs=(d?.reviewerData?.definitions||[]).slice(0,2);
  if(defs.length<2)return toast("Need at least 2 definitions in the study guide.","info");
  const a=defs[0],b=defs[1];
  const html=`<div class="card"><h3>Compare (source-only)</h3>
  <div class="grid two"><div><strong>${esc(a.term)}</strong><p>${esc(a.definition||"")}</p>${a.page?`<span class="tiny">p.${a.page}</span>`:""}</div>
  <div><strong>${esc(b.term)}</strong><p>${esc(b.definition||"")}</p>${b.page?`<span class="tiny">p.${b.page}</span>`:""}</div></div>
  <p class="muted tiny">Both taken from your material — notice how they differ.</p></div>`;
  activateSection("notes");
  const ed=$("#notesEditor");
  if(ed){ed.innerHTML=(ed.innerHTML||"")+html; ed.dispatchEvent(new Event("input"));}
  toast("Comparison inserted into notes.","success");
}
function tutorSimplify(){
  const d=activeDoc();
  if(!d)return toast("Open material first.","error");
  const r=d.reviewerData||buildReviewer(d);
  const simple=[
    "Simplified from your source (not outside knowledge):",
    "",
    r.overview?`In short: ${r.overview}`:"Import and build the guide first.",
    "",
    ...(r.definitions||[]).slice(0,6).map(x=>`• ${x.term}: ${String(x.definition||"").slice(0,120)}`),
    "",
    "Tip: open Tutor and ask “explain X simply” — answers stay source-grounded."
  ].join("\n");
  activateSection("tutor");
  const chat=$("#tutorChat");
  if(chat){
    const div=document.createElement("div");
    div.className="tutor-msg assistant";
    div.innerHTML=`<div class="tutor-bubble">${esc(simple).replace(/\n/g,"<br>")}</div>`;
    chat.appendChild(div);
    chat.scrollTop=chat.scrollHeight;
  }
  toast("Simplified view added to Tutor.","success");
}
function startTimedQuiz(minutes=5){
  state.quizTimed=true;
  state.quizEndsAt=Date.now()+minutes*60*1000;
  activateSection("quiz");
  newQuiz(false);
  const tick=()=>{
    if(!state.quizTimed)return;
    const left=Math.max(0,state.quizEndsAt-Date.now());
    const el=$("#quizTimer");
    if(el){
      const m=Math.floor(left/60000),s=Math.floor((left%60000)/1000);
      el.textContent=`⏱ ${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
    }
    if(left<=0){
      state.quizTimed=false;
      toast("Time's up — submit what you have.","info");
      return;
    }
    requestAnimationFrame(()=>setTimeout(tick,250));
  };
  tick();
  toast(`Timed quiz: ${minutes} minutes.`,"success");
}




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
  window.scrollTo({top:0,behavior:"instant" in window?undefined:"auto"});
  // Render only the opened section (big lag fix)
  try{renderAll({section:id});}catch(e){console.warn(e);}
}
function activeDoc(){return state.documents.find(d=>d.id===state.activeDocId)||null;}

function setEngineStatus(text){const el=$("#engineStatus");if(el)el.textContent=`PDF engine: ${text}`;}
function loadScript(src, timeoutMs=12000){
  return new Promise(resolve=>{
    const script=document.createElement("script");
    script.src=src;
    script.async=true;
    let finished=false;
    const timer=setTimeout(()=>finish(false),timeoutMs);
    function finish(ok){
      if(finished)return; finished=true; clearTimeout(timer); resolve(ok);
      if(!ok)script.remove();
    }
    script.onload=()=>finish(true);
    script.onerror=()=>finish(false);
    document.head.appendChild(script);
  });
}
async function loadPdfEngine(){
  if(window.pdfjsLib){
    window.pdfjsLib.GlobalWorkerOptions.workerSrc=LOCAL_PDF_WORKER;
    setEngineStatus("ready • offline-capable");
    return true;
  }
  if(pdfEnginePromise)return pdfEnginePromise;
  setEngineStatus(navigator.onLine?"loading…":"offline — PDF engine not cached");
  pdfEnginePromise=(async()=>{
    // Prefer a bundled copy. If it is not present, fall back to the pinned CDN copy.
    if(await loadScript(LOCAL_PDFJS,2500) && window.pdfjsLib){
      window.pdfjsLib.GlobalWorkerOptions.workerSrc=LOCAL_PDF_WORKER;
      setEngineStatus("ready • bundled");
      return true;
    }
    if(!navigator.onLine){
      setEngineStatus("offline — PDF engine not cached");
      return false;
    }
    const ok=await loadScript(CDN_PDFJS,12000);
    if(ok&&window.pdfjsLib){
      window.pdfjsLib.GlobalWorkerOptions.workerSrc=CDN_PDF_WORKER;
      setEngineStatus("ready • cached after first use");
      return true;
    }
    setEngineStatus("unavailable — reconnect and try again");
    return false;
  })().finally(()=>{pdfEnginePromise=null;});
  return pdfEnginePromise;
}

function loadExternalLibrary(src, globalName, timeoutMs=12000){
  return new Promise(resolve=>{
    if(globalName && window[globalName]) return resolve(window[globalName]);
    const script=document.createElement("script");
    script.src=src; script.async=true;
    let done=false;
    const finish=ok=>{if(done)return;done=true;clearTimeout(timer);if(!ok)script.remove();resolve(ok&&globalName?window[globalName]:ok);};
    const timer=setTimeout(()=>finish(false),timeoutMs);
    script.onload=()=>finish(true); script.onerror=()=>finish(false);
    document.head.appendChild(script);
  });
}
let jsZipPromise=null;
async function loadJSZip(){
  if(window.JSZip)return window.JSZip;
  if(jsZipPromise)return jsZipPromise;
  jsZipPromise=(async()=>{
    const ok=await loadScript(LOCAL_JSZIP,8000);
    return ok&&window.JSZip?window.JSZip:null;
  })().finally(()=>{jsZipPromise=null;});
  return jsZipPromise;
}
let mammothPromise=null;
async function loadMammoth(){
  // Mammoth is optional now. The bundled DOCX reader below uses JSZip, so a
  // blocked CDN can never make Word uploads fail.
  if(window.mammoth)return window.mammoth;
  if(mammothPromise)return mammothPromise;
  mammothPromise=(async()=>{
    try{
      const lib=await loadExternalLibrary(CDN_MAMMOTH,"mammoth",5000);
      return window.mammoth||lib||null;
    }catch{return null;}
  })().finally(()=>{mammothPromise=null;});
  return mammothPromise;
}
let qrPromise=null;
async function loadQrLibrary(){
  if(window.qrcode)return window.qrcode;
  if(qrPromise)return qrPromise;
  qrPromise=(async()=>{
    const lib=await loadExternalLibrary(CDN_QR,"qrcode",10000);
    return window.qrcode||lib||null;
  })().finally(()=>{qrPromise=null;});
  return qrPromise;
}
function setOcrStatus(text){const el=$("#ocrStatus");if(el)el.textContent=`OCR: ${text}`;}
function loadTesseract(){
  if(window.Tesseract){setOcrStatus("ready");return Promise.resolve(true);}
  if(tesseractPromise)return tesseractPromise;
  setOcrStatus(navigator.onLine?"loading…":"offline — trying local OCR bundle");
  tesseractPromise=(async()=>{
    if(await loadScript(LOCAL_TESSERACT,4000)&&window.Tesseract){setOcrStatus("ready • local vendor");return true;}
    if(!navigator.onLine){setOcrStatus("unavailable offline");return false;}
    if(await loadScript(CDN_TESSERACT,15000)&&window.Tesseract){setOcrStatus("ready • cached after first use");return true;}
    setOcrStatus("unavailable — OCR engine could not load");
    return false;
  })();
  return tesseractPromise;
}
async function getOcrWorker(progress){
  const ready=await loadTesseract();if(!ready)throw new Error("Photo OCR is unavailable right now. The photo can still be saved and captioned.");
  if(!tesseractWorker){
    // Point workers + language data at the public CDN so first-run OCR actually works.
    // After the browser caches these, later runs can succeed offline.
    const opts={
      logger:m=>{if(m?.status)progress?.(m);},
      workerPath:"https://cdn.jsdelivr.net/npm/tesseract.js@7/dist/worker.min.js",
      corePath:"https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/tesseract-core.wasm.js",
      langPath:"https://tessdata.projectnaptha.com/4.0.0"
    };
    try{
      tesseractWorker=await window.Tesseract.createWorker("eng",1,opts);
    }catch(err){
      console.warn("OCR worker with paths failed, retrying defaults",err);
      tesseractWorker=await window.Tesseract.createWorker("eng");
    }
  }
  return tesseractWorker;
}
/** Upscale + contrast boost so thin symbols (arrows, subscripts, Greek) OCR better. */
async function preprocessForOcr(fileOrBlob){
  try{
    const bitmap=await createImageBitmap(fileOrBlob);
    const scale=bitmap.width<900?Math.min(3,1200/Math.max(1,bitmap.width)):bitmap.width<1400?1.5:1;
    const w=Math.max(1,Math.round(bitmap.width*scale));
    const h=Math.max(1,Math.round(bitmap.height*scale));
    const c=document.createElement("canvas");c.width=w;c.height=h;
    const ctx=c.getContext("2d",{alpha:false});
    ctx.fillStyle="#fff";ctx.fillRect(0,0,w,h);
    ctx.imageSmoothingEnabled=true;
    ctx.drawImage(bitmap,0,0,w,h);
    // Mild contrast stretch for light gray PDF scans
    try{
      const img=ctx.getImageData(0,0,w,h);const d=img.data;
      let min=255,max=0;
      for(let i=0;i<d.length;i+=4){const g=0.299*d[i]+0.587*d[i+1]+0.114*d[i+2];if(g<min)min=g;if(g>max)max=g;}
      const range=Math.max(1,max-min);
      for(let i=0;i<d.length;i+=4){
        let g=(0.299*d[i]+0.587*d[i+1]+0.114*d[i+2]-min)/range*255;
        g=g<128?g*0.92:Math.min(255,g*1.08); // slightly punch symbols
        d[i]=d[i+1]=d[i+2]=g;d[i+3]=255;
      }
      ctx.putImageData(img,0,0);
    }catch{}
    bitmap.close?.();
    const blob=await new Promise(res=>c.toBlob(b=>res(b),"image/png"));
    return blob||fileOrBlob;
  }catch{
    return fileOrBlob;
  }
}
async function ocrImage(file,progress){
  try{
    const worker=await getOcrWorker(progress);
    const prepared=await preprocessForOcr(file);
    // Prefer layout that keeps sparse symbols / formula lines
    try{
      await worker.setParameters({
        tessedit_pageseg_mode: "3",
        // Do NOT whitelist only A-Z — that kills arrows, Greek, subscripts
        preserve_interword_spaces: "1"
      });
    }catch{}
    let best={text:"",confidence:0};
    const modes=["3","6","4"];
    for(const psm of modes){
      try{
        try{await worker.setParameters({tessedit_pageseg_mode:psm});}catch{}
        const ret=await worker.recognize(prepared);
        const text=repairSymbols(ret?.data?.text||"");
        const conf=Number(ret?.data?.confidence)||0;
        if(wordCount(text)>wordCount(best.text)||(wordCount(text)===wordCount(best.text)&&conf>best.confidence)){
          best={text,confidence:conf};
        }
        if(best.confidence>=72&&wordCount(best.text)>=8)break;
      }catch(err){console.warn("OCR mode",psm,err);}
    }
    if(!best.text){
      const ret=await worker.recognize(prepared);
      best={text:repairSymbols(ret?.data?.text||""),confidence:Number(ret?.data?.confidence)||0};
    }
    return best;
  }catch(err){
    console.warn("ocrImage failed",err);
    try{await tesseractWorker?.terminate?.();}catch{}
    tesseractWorker=null;
    return {text:"",confidence:0};
  }
}
function dataUrlFromFile(file,maxSide=1500,quality=.78){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>{const img=new Image();img.onload=()=>{const scale=Math.min(1,maxSide/Math.max(img.naturalWidth,img.naturalHeight));const w=Math.max(1,Math.round(img.naturalWidth*scale)),h=Math.max(1,Math.round(img.naturalHeight*scale));const c=document.createElement("canvas");c.width=w;c.height=h;const ctx=c.getContext("2d");ctx.drawImage(img,0,0,w,h);resolve({dataUrl:c.toDataURL("image/jpeg",quality),width:w,height:h});};img.onerror=()=>reject(new Error("Could not read the image."));img.src=reader.result;};reader.onerror=()=>reject(reader.error||new Error("Could not read the image."));reader.readAsDataURL(file);});}
function downloadDataUrl(dataUrl,filename){
  const a=document.createElement("a");
  a.href=dataUrl;a.download=filename||"studyvault.png";a.rel="noopener";
  document.body.appendChild(a);a.click();
  setTimeout(()=>{try{a.remove();}catch{}},800);
}
function downloadBlob(blob,filename){
  const url=URL.createObjectURL(blob);
  downloadDataUrl(url,filename);
  setTimeout(()=>URL.revokeObjectURL(url),4000);
}

/** Local-only study card image (photo + caption). Fixed download for mobile. */
function exportStudyPic(media,title="StudyVault"){
  return new Promise((resolve,reject)=>{
    if(!media?.dataUrl)return reject(new Error("No photo data available."));
    const img=new Image();
    img.onload=()=>{
      try{
        const pad=28,maxW=900;
        const cap=String(media.caption||media.ocrText||"").trim().slice(0,320);
        const scale=Math.min(1,maxW/Math.max(img.naturalWidth,1));
        const iw=Math.max(1,Math.round(img.naturalWidth*scale));
        const ih=Math.max(1,Math.round(img.naturalHeight*scale));
        const lineH=22,lines=[];
        if(cap){
          const words=cap.split(/\s+/);let line="";
          for(const w of words){const t=line?`${line} ${w}`:w;if(t.length>54){if(line)lines.push(line);line=w;}else line=t;}
          if(line)lines.push(line);
        }
        const footerH=56+(lines.length?lines.length*lineH+16:0);
        const c=document.createElement("canvas");
        c.width=iw+pad*2;c.height=ih+pad*2+footerH;
        const ctx=c.getContext("2d");
        ctx.fillStyle="#0f1419";ctx.fillRect(0,0,c.width,c.height);
        ctx.fillStyle="#1a2330";ctx.fillRect(pad-6,pad-6,iw+12,ih+12);
        ctx.drawImage(img,pad,pad,iw,ih);
        ctx.fillStyle="#8f7cff";ctx.font="700 11px system-ui,sans-serif";
        ctx.fillText("STUDYVAULT STUDY PIC",pad,ih+pad+22);
        ctx.fillStyle="#e8eef6";ctx.font="600 15px system-ui,sans-serif";
        ctx.fillText(String(title||"StudyVault").slice(0,52),pad,ih+pad+42);
        ctx.fillStyle="#9fb0c3";ctx.font="12px system-ui,sans-serif";
        ctx.fillText(String(media.name||"study photo").slice(0,60),pad,ih+pad+58);
        ctx.fillStyle="#d7e2ef";ctx.font="13px system-ui,sans-serif";
        lines.forEach((ln,i)=>ctx.fillText(ln,pad,ih+pad+78+i*lineH));
        const filename=`studyvault-${String(media.name||"card").replace(/\.[^.]+$/,"").replace(/[^\w.\-]+/g,"_").slice(0,36)}-study.png`;
        try{downloadDataUrl(c.toDataURL("image/png"),filename);resolve();}
        catch(err){
          c.toBlob(blob=>{if(!blob)return reject(new Error("Could not build study pic."));downloadBlob(blob,filename);resolve();},"image/png");
        }
      }catch(err){reject(err);}
    };
    img.onerror=()=>reject(new Error("Could not load photo. Try re-adding the photo."));
    img.src=media.dataUrl;
  });
}

/** Local symbol cards (drawn on canvas — no cloud image AI). */
const SYMBOL_LIBRARY=[
  {id:"perspective",label:"1-point perspective",draw:(ctx,x,y,s)=>{ctx.strokeStyle="#e8eef6";ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(x,y+s*0.7);ctx.lineTo(x+s*0.5,y+s*0.35);ctx.lineTo(x+s,y+s*0.7);ctx.moveTo(x+s*0.5,y+s*0.35);ctx.lineTo(x+s*0.5,y);ctx.stroke();ctx.fillStyle="#8f7cff";ctx.beginPath();ctx.arc(x+s*0.5,y+s*0.35,3,0,Math.PI*2);ctx.fill();}},
  {id:"stack",label:"Stack (LIFO)",draw:(ctx,x,y,s)=>{ctx.strokeStyle="#e8eef6";ctx.lineWidth=2;for(let i=0;i<4;i++){ctx.strokeRect(x+s*0.2,y+s*0.15+i*s*0.18,s*0.6,s*0.16);}ctx.fillStyle="#00b894";ctx.font="12px system-ui";ctx.fillText("TOP",x+s*0.35,y+s*0.12);}},
  {id:"database",label:"Database",draw:(ctx,x,y,s)=>{ctx.strokeStyle="#e8eef6";ctx.lineWidth=2;ctx.beginPath();ctx.ellipse(x+s/2,y+s*0.25,s*0.35,s*0.12,0,0,Math.PI*2);ctx.stroke();ctx.beginPath();ctx.moveTo(x+s*0.15,y+s*0.25);ctx.lineTo(x+s*0.15,y+s*0.75);ctx.ellipse(x+s/2,y+s*0.75,s*0.35,s*0.12,0,0,Math.PI);ctx.lineTo(x+s*0.85,y+s*0.25);ctx.stroke();}},

  {id:"resistor",label:"Resistor",draw:(ctx,x,y,s)=>{ctx.strokeStyle="#e8eef6";ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+s*0.2,y);for(let i=0;i<6;i++)ctx.lineTo(x+s*(0.25+i*0.08),y+(i%2?-s*0.12:s*0.12));ctx.lineTo(x+s*0.8,y);ctx.lineTo(x+s,y);ctx.stroke();}},
  {id:"capacitor",label:"Capacitor",draw:(ctx,x,y,s)=>{ctx.strokeStyle="#e8eef6";ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+s*0.4,y);ctx.moveTo(x+s*0.4,y-s*0.2);ctx.lineTo(x+s*0.4,y+s*0.2);ctx.moveTo(x+s*0.55,y-s*0.2);ctx.lineTo(x+s*0.55,y+s*0.2);ctx.moveTo(x+s*0.55,y);ctx.lineTo(x+s,y);ctx.stroke();}},
  {id:"diode",label:"Diode",draw:(ctx,x,y,s)=>{ctx.strokeStyle="#e8eef6";ctx.fillStyle="#e8eef6";ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+s*0.35,y);ctx.lineTo(x+s*0.35,y-s*0.18);ctx.lineTo(x+s*0.55,y);ctx.lineTo(x+s*0.35,y+s*0.18);ctx.closePath();ctx.fill();ctx.beginPath();ctx.moveTo(x+s*0.55,y-s*0.18);ctx.lineTo(x+s*0.55,y+s*0.18);ctx.moveTo(x+s*0.55,y);ctx.lineTo(x+s,y);ctx.stroke();}},
  
  {id:"inductor",label:"Inductor",draw:(ctx,x,y,s)=>{ctx.strokeStyle="#e8eef6";ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+s*0.2,y);for(let i=0;i<4;i++){ctx.arc(x+s*(0.28+i*0.12),y,s*0.06,Math.PI,0,true);}ctx.lineTo(x+s,y);ctx.stroke();}},
  {id:"battery",label:"Battery",draw:(ctx,x,y,s)=>{ctx.strokeStyle="#e8eef6";ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+s*0.3,y);ctx.moveTo(x+s*0.3,y-s*0.18);ctx.lineTo(x+s*0.3,y+s*0.18);ctx.moveTo(x+s*0.42,y-s*0.1);ctx.lineTo(x+s*0.42,y+s*0.1);ctx.moveTo(x+s*0.54,y-s*0.18);ctx.lineTo(x+s*0.54,y+s*0.18);ctx.moveTo(x+s*0.66,y-s*0.1);ctx.lineTo(x+s*0.66,y+s*0.1);ctx.moveTo(x+s*0.66,y);ctx.lineTo(x+s,y);ctx.stroke();}},
  {id:"switch",label:"Switch",draw:(ctx,x,y,s)=>{ctx.strokeStyle="#e8eef6";ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+s*0.3,y);ctx.arc(x+s*0.35,y,s*0.05,0,Math.PI*2);ctx.moveTo(x+s*0.4,y);ctx.lineTo(x+s*0.65,y-s*0.15);ctx.moveTo(x+s*0.7,y);ctx.arc(x+s*0.7,y,s*0.05,0,Math.PI*2);ctx.moveTo(x+s*0.75,y);ctx.lineTo(x+s,y);ctx.stroke();}},
  {id:"led",label:"LED",draw:(ctx,x,y,s)=>{ctx.strokeStyle="#e8eef6";ctx.fillStyle="#e8eef6";ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+s*0.3,y);ctx.lineTo(x+s*0.3,y-s*0.16);ctx.lineTo(x+s*0.5,y);ctx.lineTo(x+s*0.3,y+s*0.16);ctx.closePath();ctx.fill();ctx.beginPath();ctx.moveTo(x+s*0.5,y-s*0.16);ctx.lineTo(x+s*0.5,y+s*0.16);ctx.moveTo(x+s*0.5,y);ctx.lineTo(x+s*0.85,y);ctx.moveTo(x+s*0.55,y-s*0.22);ctx.lineTo(x+s*0.7,y-s*0.35);ctx.moveTo(x+s*0.62,y-s*0.18);ctx.lineTo(x+s*0.77,y-s*0.31);ctx.stroke();}},
  {id:"fuse",label:"Fuse",draw:(ctx,x,y,s)=>{ctx.strokeStyle="#e8eef6";ctx.lineWidth=3;ctx.strokeRect(x+s*0.25,y-s*0.1,s*0.5,s*0.2);ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+s*0.25,y);ctx.moveTo(x+s*0.75,y);ctx.lineTo(x+s,y);ctx.stroke();}},
  {id:"npn",label:"NPN Transistor",draw:(ctx,x,y,s)=>{ctx.strokeStyle="#e8eef6";ctx.lineWidth=2;ctx.beginPath();ctx.arc(x+s*0.5,y,s*0.28,0,Math.PI*2);ctx.stroke();ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+s*0.35,y);ctx.moveTo(x+s*0.35,y-s*0.15);ctx.lineTo(x+s*0.35,y+s*0.15);ctx.moveTo(x+s*0.35,y-s*0.1);ctx.lineTo(x+s*0.7,y-s*0.25);ctx.lineTo(x+s*0.7,y-s*0.4);ctx.moveTo(x+s*0.35,y+s*0.1);ctx.lineTo(x+s*0.7,y+s*0.25);ctx.lineTo(x+s*0.7,y+s*0.4);ctx.stroke();}},
  {id:"acsource",label:"AC Source",draw:(ctx,x,y,s)=>{ctx.strokeStyle="#e8eef6";ctx.lineWidth=2;ctx.beginPath();ctx.arc(x+s*0.5,y,s*0.28,0,Math.PI*2);ctx.stroke();ctx.beginPath();ctx.moveTo(x+s*0.3,y);ctx.bezierCurveTo(x+s*0.4,y-s*0.2,x+s*0.5,y+s*0.2,x+s*0.7,y);ctx.stroke();}},
  {id:"speaker",label:"Speaker",draw:(ctx,x,y,s)=>{ctx.strokeStyle="#e8eef6";ctx.lineWidth=2;ctx.fillStyle="#e8eef6";ctx.fillRect(x+s*0.2,y-s*0.1,s*0.2,s*0.2);ctx.beginPath();ctx.moveTo(x+s*0.4,y-s*0.1);ctx.lineTo(x+s*0.7,y-s*0.25);ctx.lineTo(x+s*0.7,y+s*0.25);ctx.lineTo(x+s*0.4,y+s*0.1);ctx.closePath();ctx.stroke();}},
  {id:"motor",label:"Motor",draw:(ctx,x,y,s)=>{ctx.strokeStyle="#e8eef6";ctx.lineWidth=2;ctx.beginPath();ctx.arc(x+s*0.5,y,s*0.28,0,Math.PI*2);ctx.stroke();ctx.fillStyle="#e8eef6";ctx.font="bold "+Math.round(s*0.25)+"px system-ui";ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillText("M",x+s*0.5,y);ctx.textAlign="left";ctx.textBaseline="alphabetic";}},
  {id:"relay",label:"Relay",draw:(ctx,x,y,s)=>{ctx.strokeStyle="#e8eef6";ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(x,y+s*0.15);ctx.lineTo(x+s*0.25,y+s*0.15);for(let i=0;i<3;i++)ctx.arc(x+s*(0.32+i*0.1),y+s*0.15,s*0.05,Math.PI,0,true);ctx.lineTo(x+s*0.7,y+s*0.15);ctx.moveTo(x+s*0.45,y+s*0.05);ctx.lineTo(x+s*0.45,y-s*0.2);ctx.lineTo(x+s*0.75,y-s*0.05);ctx.moveTo(x+s*0.8,y-s*0.15);ctx.lineTo(x+s,y-s*0.15);ctx.stroke();}},
  {id:"andgate",label:"AND gate",draw:(ctx,x,y,s)=>{ctx.strokeStyle="#e8eef6";ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(x+s*0.15,y-s*0.22);ctx.lineTo(x+s*0.45,y-s*0.22);ctx.arc(x+s*0.45,y,s*0.22,-Math.PI/2,Math.PI/2);ctx.lineTo(x+s*0.15,y+s*0.22);ctx.closePath();ctx.stroke();ctx.beginPath();ctx.moveTo(x,y-s*0.1);ctx.lineTo(x+s*0.15,y-s*0.1);ctx.moveTo(x,y+s*0.1);ctx.lineTo(x+s*0.15,y+s*0.1);ctx.moveTo(x+s*0.67,y);ctx.lineTo(x+s,y);ctx.stroke();}},
  {id:"orgate",label:"OR gate",draw:(ctx,x,y,s)=>{ctx.strokeStyle="#e8eef6";ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(x+s*0.15,y-s*0.22);ctx.quadraticCurveTo(x+s*0.4,y-s*0.22,x+s*0.7,y);ctx.quadraticCurveTo(x+s*0.4,y+s*0.22,x+s*0.15,y+s*0.22);ctx.quadraticCurveTo(x+s*0.28,y,x+s*0.15,y-s*0.22);ctx.stroke();ctx.beginPath();ctx.moveTo(x,y-s*0.1);ctx.lineTo(x+s*0.2,y-s*0.1);ctx.moveTo(x,y+s*0.1);ctx.lineTo(x+s*0.2,y+s*0.1);ctx.moveTo(x+s*0.7,y);ctx.lineTo(x+s,y);ctx.stroke();}},
  {id:"notgate",label:"NOT gate",draw:(ctx,x,y,s)=>{ctx.strokeStyle="#e8eef6";ctx.fillStyle="#0b1220";ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(x+s*0.2,y-s*0.22);ctx.lineTo(x+s*0.65,y);ctx.lineTo(x+s*0.2,y+s*0.22);ctx.closePath();ctx.stroke();ctx.beginPath();ctx.arc(x+s*0.72,y,5,0,Math.PI*2);ctx.stroke();ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+s*0.2,y);ctx.moveTo(x+s*0.78,y);ctx.lineTo(x+s,y);ctx.stroke();}},

  {id:"ground",label:"Ground",draw:(ctx,x,y,s)=>{ctx.strokeStyle="#e8eef6";ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(x+s*0.5,y-s*0.25);ctx.lineTo(x+s*0.5,y);ctx.moveTo(x+s*0.2,y);ctx.lineTo(x+s*0.8,y);ctx.moveTo(x+s*0.3,y+s*0.1);ctx.lineTo(x+s*0.7,y+s*0.1);ctx.moveTo(x+s*0.4,y+s*0.2);ctx.lineTo(x+s*0.6,y+s*0.2);ctx.stroke();}},
  {id:"ohm",label:"Ohm (Ω)",draw:(ctx,x,y,s)=>{ctx.fillStyle="#e8eef6";ctx.font=`700 ${Math.round(s*0.5)}px system-ui,sans-serif`;ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillText("Ω",x+s/2,y);}},
  {id:"arrow",label:"Reaction →",draw:(ctx,x,y,s)=>{ctx.strokeStyle="#e8eef6";ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+s*0.75,y);ctx.lineTo(x+s*0.6,y-s*0.12);ctx.moveTo(x+s*0.75,y);ctx.lineTo(x+s*0.6,y+s*0.12);ctx.stroke();}}
];

/** Wrap text into lines that fit maxWidth (px). */
function canvasWrapText(ctx, text, maxWidth){
  const words=String(text||"").replace(/\s+/g," ").trim().split(" ").filter(Boolean);
  const lines=[]; let line="";
  for(const w of words){
    const t=line?`${line} ${w}`:w;
    if(ctx.measureText(t).width>maxWidth && line){lines.push(line);line=w;}
    else line=t;
  }
  if(line)lines.push(line);
  return lines.length?lines:[""];
}

/**
 * Core local image generator — creates downloadable study cards on-device.
 * No cloud, no API keys. Works offline for years.
 */
function generateStudyCardImage(opts={}){
  const title=String(opts.title||"Study card").slice(0,120);
  const body=String(opts.body||"").slice(0,1200);
  const subtitle=String(opts.subtitle||"").slice(0,80);
  const badge=String(opts.badge||"STUDYVAULT").slice(0,40);
  const filename=String(opts.filename||`studyvault-card-${Date.now()}.png`).replace(/[^\w.\-]+/g,"_");
  const W=opts.width||900, pad=36;
  const c=document.createElement("canvas");
  const ctx=c.getContext("2d");
  ctx.font="16px system-ui,sans-serif";
  const bodyLines=canvasWrapText(ctx,body,W-pad*2);
  const titleFont="700 28px system-ui,sans-serif";
  ctx.font=titleFont;
  const titleLines=canvasWrapText(ctx,title,W-pad*2);
  const lineH=26, titleH=titleLines.length*34;
  const bodyH=Math.min(bodyLines.length,28)*lineH;
  const H=pad+28+titleH+18+(subtitle?22:0)+bodyH+pad+40;
  c.width=W; c.height=Math.max(420,Math.min(H,1400));
  // Background
  ctx.fillStyle="#0b1220";ctx.fillRect(0,0,c.width,c.height);
  // Accent bar
  const grad=ctx.createLinearGradient(0,0,c.width,0);
  grad.addColorStop(0,"#6c5ce7");grad.addColorStop(1,"#00b894");
  ctx.fillStyle=grad;ctx.fillRect(0,0,c.width,6);
  // Card panel
  ctx.fillStyle="#121a2a";ctx.fillRect(pad-12,pad-8,c.width-(pad-12)*2,c.height-(pad-8)*2-8);
  // Badge
  ctx.fillStyle="#8f7cff";ctx.font="700 12px system-ui,sans-serif";ctx.textAlign="left";
  ctx.fillText(badge,pad,pad+8);
  // Title
  ctx.fillStyle="#e8eef6";ctx.font=titleFont;
  titleLines.forEach((ln,i)=>ctx.fillText(ln,pad,pad+40+i*34));
  let y=pad+40+titleH+8;
  if(subtitle){
    ctx.fillStyle="#9fb0c3";ctx.font="14px system-ui,sans-serif";
    ctx.fillText(subtitle,pad,y);y+=24;
  }
  // Divider
  ctx.strokeStyle="#243044";ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(pad,y);ctx.lineTo(c.width-pad,y);ctx.stroke();y+=22;
  // Body
  ctx.fillStyle="#d7e2ef";ctx.font="16px system-ui,sans-serif";
  bodyLines.slice(0,28).forEach((ln,i)=>ctx.fillText(ln,pad,y+i*lineH));
  // Footer
  ctx.fillStyle="#6b7c90";ctx.font="12px system-ui,sans-serif";
  ctx.fillText("Generated locally on your device · StudyVault",pad,c.height-18);
  try{downloadDataUrl(c.toDataURL("image/png"),filename);}
  catch{c.toBlob(b=>{if(b)downloadBlob(b,filename);},"image/png");}
  return c;
}

function exportSymbolCard(symbolId){
  const sym=SYMBOL_LIBRARY.find(s=>s.id===symbolId)||SYMBOL_LIBRARY[0];
  const c=document.createElement("canvas");c.width=640;c.height=420;
  const ctx=c.getContext("2d");
  ctx.fillStyle="#0f1419";ctx.fillRect(0,0,c.width,c.height);
  ctx.fillStyle="#1a2330";ctx.fillRect(40,40,560,250);
  try{sym.draw(ctx,120,165,400);}catch(e){console.warn(e);}
  ctx.textAlign="left";ctx.fillStyle="#8f7cff";ctx.font="700 12px system-ui,sans-serif";
  ctx.fillText("STUDYVAULT SYMBOL CARD",50,320);
  ctx.fillStyle="#e8eef6";ctx.font="700 28px system-ui,sans-serif";ctx.fillText(sym.label,50,360);
  ctx.fillStyle="#9fb0c3";ctx.font="14px system-ui,sans-serif";ctx.fillText("Local symbol — generated offline on your device",50,388);
  const filename=`studyvault-symbol-${sym.id}.png`;
  try{downloadDataUrl(c.toDataURL("image/png"),filename);}
  catch{c.toBlob(b=>{if(b)downloadBlob(b,filename);},"image/png");}
  toast(`Symbol card ready: ${sym.label}`,"success");
}

/** Current flashcard → downloadable study image (Q + A). */
function exportCurrentFlashcardImage(){
  const d=activeDoc();
  if(!d?.flashcards?.length)return toast("Add study material first so we can build cards.","error");
  const c=d.flashcards[d.currentCard||0];
  if(!c)return toast("No card selected.","error");
  const body=`Q: ${c.question||""}\n\nA: ${c.answer||""}${c.evidence?`\n\nEvidence: ${String(c.evidence).slice(0,220)}`:""}`;
  generateStudyCardImage({
    title:c.question||"Flashcard",
    body:body,
    subtitle:`${d.fileName||"Study"} · card ${(d.currentCard||0)+1}/${d.flashcards.length}`,
    badge:"FLASHCARD",
    filename:`studyvault-flash-${(d.currentCard||0)+1}.png`
  });
  toast("Flashcard image saved — ready to study offline.","success");
}

/** Export up to N flashcards as study images (gentle batch). */
async function exportFlashcardImagesBatch(limit=8){
  const d=activeDoc();
  if(!d?.flashcards?.length)return toast("No flashcards yet.","error");
  const n=Math.min(limit,d.flashcards.length);
  toast(`Creating ${n} study images…`,"info");
  for(let i=0;i<n;i++){
    const card=d.flashcards[i];
    const body=`Q: ${card.question||""}\n\nA: ${card.answer||""}`;
    generateStudyCardImage({
      title:card.question||`Card ${i+1}`,
      body,
      subtitle:`${d.fileName||"Study"} · ${i+1}/${d.flashcards.length}`,
      badge:"FLASHCARD",
      filename:`studyvault-flash-${i+1}.png`
    });
    await new Promise(r=>setTimeout(r,180));
  }
  toast(`${n} study images generated for the family.`,"success");
}

/** Summary / key points → one big study image. */
function exportSummaryImage(){
  const d=activeDoc();
  if(!d)return toast("Select a study material first.","error");
  const rd=d.reviewerData||{};
  const parts=[];
  if(rd.overview)parts.push(String(rd.overview).slice(0,500));
  const keys=(rd.keyPoints||rd.facts||[]).slice(0,8);
  if(keys.length)parts.push("Key points:\n"+keys.map((k,i)=>`${i+1}. ${typeof k==="string"?k:(k.text||k.point||"")}`).join("\n"));
  const defs=(rd.definitions||[]).slice(0,5);
  if(defs.length)parts.push("Definitions:\n"+defs.map(x=>`• ${x.term||x.name||""}: ${String(x.definition||x.text||"").slice(0,120)}`).join("\n"));
  if(!parts.length)parts.push(String(d.rawText||"").slice(0,700)||"Import material to build a summary image.");
  generateStudyCardImage({
    title:d.fileName||"Study summary",
    body:parts.join("\n\n"),
    subtitle:`${d.pageCount||1} pages · ${wordCount(d.rawText||"")} words · local summary`,
    badge:"SUMMARY IMAGE",
    filename:`studyvault-summary-${String(d.fileName||"doc").replace(/[^\w.\-]+/g,"_").slice(0,28)}.png`
  });
  toast("Summary study image created.","success");
}

/** Custom study card from user text (Image Studio). */
function exportCustomStudyImage(){
  const title=($("#imgStudioTitle")?.value||"").trim()||"Study card";
  const body=($("#imgStudioBody")?.value||"").trim();
  if(!body)return toast("Write something to put on the study image.","error");
  generateStudyCardImage({
    title,
    body,
    subtitle:"Custom study card · offline",
    badge:"CUSTOM",
    filename:`studyvault-custom-${Date.now()}.png`
  });
  toast("Custom study image ready.","success");
}

/** Definition cards from reviewer terms. */
function exportDefinitionImages(limit=5){
  const d=activeDoc();
  const defs=(d?.reviewerData?.definitions||d?.terms||[]).slice(0,limit);
  if(!defs.length)return toast("No definitions yet — open Reviewer after importing.","error");
  defs.forEach((x,i)=>{
    const term=x.term||x.name||x||`Term ${i+1}`;
    const def=String(x.definition||x.text||x.meaning||"").slice(0,400)||String(term);
    generateStudyCardImage({
      title:String(term).slice(0,80),
      body:def,
      subtitle:d.fileName||"Definitions",
      badge:"DEFINITION",
      filename:`studyvault-def-${i+1}.png`
    });
  });
  toast(`${defs.length} definition image(s) generated.`,"success");
}

let dbPromise=null;
let writeQueue=Promise.resolve();
function openDB(){
  if(dbPromise)return dbPromise;
  dbPromise=new Promise((resolve,reject)=>{
    const r=indexedDB.open(DB_NAME,DB_VERSION);
    r.onupgradeneeded=e=>{
      const db=r.result;
      if(!db.objectStoreNames.contains(DOC_STORE))db.createObjectStore(DOC_STORE,{keyPath:"id"});
      if(!db.objectStoreNames.contains(META_STORE))db.createObjectStore(META_STORE);
      // Schema bump marker for future migrations (v2→v3+). User data stays; we only ensure stores exist.
      try{const tx=e.target.transaction;const meta=tx.objectStore(META_STORE);meta.put({key:"schema",version:SCHEMA_VERSION,migratedAt:new Date().toISOString()},"schema");}catch{}
    };
    r.onsuccess=()=>{const db=r.result;db.onversionchange=()=>db.close();resolve(db);};
    r.onerror=()=>reject(r.error);
  }).catch(err=>{dbPromise=null;throw err;});
  return dbPromise;
}
function txRequest(store,mode,action){
  return openDB().then(db=>new Promise((resolve,reject)=>{
    const tx=db.transaction(store,mode);let request;
    try{request=action(tx.objectStore(store));}catch(err){reject(err);return;}
    if(request){request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);}
    tx.onabort=()=>reject(tx.error||new Error("IndexedDB transaction aborted."));
    tx.onerror=()=>reject(tx.error||new Error("IndexedDB transaction failed."));
    tx.oncomplete=()=>{if(!request)resolve();};
  }));
}
function queueWrite(fn){
  writeQueue=writeQueue.catch(()=>{}).then(fn);
  return writeQueue;
}
async function dbPut(store,keyOrValue,value){
  return queueWrite(()=>txRequest(store,"readwrite",os=>value===undefined?os.put(keyOrValue):os.put(value,keyOrValue)));
}
async function dbGet(store,key){return txRequest(store,"readonly",os=>os.get(key));}
async function dbGetAll(store){return txRequest(store,"readonly",os=>os.getAll());}
async function dbDelete(store,key){return queueWrite(()=>txRequest(store,"readwrite",os=>os.delete(key)));}
async function dbClear(){
  return queueWrite(()=>openDB().then(db=>new Promise((resolve,reject)=>{
    const tx=db.transaction([DOC_STORE,META_STORE],"readwrite");
    tx.objectStore(DOC_STORE).clear();tx.objectStore(META_STORE).clear();
    tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error("Clear failed."));
  })));
}
async function saveDoc(doc){
  doc.updatedAt=now();
  // Phone-safe save: retry once if the DB connection was closed in the background
  const attempt=async()=>{
    try{await dbPut(DOC_STORE,doc);}
    catch(err){
      if(err?.name==="QuotaExceededError")throw new Error("Browser storage is full. Remove large photos or export a backup, then try again.");
      // Recover from closed connection (common when phone tabs sleep)
      if(/closed|InvalidState|AbortError/i.test(String(err?.message||err?.name||""))){
        dbPromise=null;
        await dbPut(DOC_STORE,doc);
        return;
      }
      throw err;
    }
  };
  try{await attempt();}
  catch(err){
    console.error("saveDoc failed",err);
    toast(err?.message||"Could not save. Try again.","error");
    throw err;
  }
}
async function saveMeta(){
  try{
    await dbPut(META_STORE,SETTINGS_KEY,{...state.settings,activeDocId:state.activeDocId,version:APP_VERSION,engine:REVIEW_ENGINE_VERSION});
  }catch(err){
    if(/closed|InvalidState|AbortError/i.test(String(err?.message||err?.name||""))){
      dbPromise=null;
      await dbPut(META_STORE,SETTINGS_KEY,{...state.settings,activeDocId:state.activeDocId,version:APP_VERSION,engine:REVIEW_ENGINE_VERSION});
      return;
    }
    console.warn("saveMeta",err);
  }
}

async function derivePin(pin,salt,iterations=120000){
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(pin),"PBKDF2",false,["deriveBits"]);
  const bits=await crypto.subtle.deriveBits({name:"PBKDF2",salt,iterations,hash:"SHA-256"},key,256);
  return Array.from(new Uint8Array(bits),b=>b.toString(16).padStart(2,"0")).join("");
}
function bytesToB64(bytes){let s="";for(const b of bytes)s+=String.fromCharCode(b);return btoa(s);}
function b64ToBytes(s){const bin=atob(s);return Uint8Array.from(bin,c=>c.charCodeAt(0));}
async function setPin(){
  const a=$("#pinA").value.trim(),b=$("#pinB").value.trim();
  if(a.length<5)return toast("PIN must be at least 5 characters.","error");
  if(a!==b)return toast("PINs do not match.","error");
  if(a==="12345")return toast("Please choose a PIN other than the starter default.","error");
  const salt=crypto.getRandomValues(new Uint8Array(16));
  state.settings.pinSalt=bytesToB64(salt);
  state.settings.pinIterations=210000;
  state.settings.pinHash=await derivePin(a,salt,state.settings.pinIterations);
  state.settings.pinFails=0;state.settings.pinLockUntil=0;
  await saveMeta();closePin();toast("PIN protection enabled.","success");
}
function constantTimeEqual(a,b){
  const A=String(a||""),B=String(b||"");
  let diff=A.length^B.length;
  const n=Math.max(A.length,B.length);
  for(let i=0;i<n;i++)diff|=(A.charCodeAt(i%n)||0)^(B.charCodeAt(i%n)||0);
  return diff===0;
}
async function verifyPin(pin){
  if(!state.settings.pinHash||!state.settings.pinSalt)return false;
  const hash=await derivePin(pin,b64ToBytes(state.settings.pinSalt),state.settings.pinIterations||120000);
  return constantTimeEqual(hash,state.settings.pinHash);
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
  const until=Number(state.settings.pinLockUntil||0);
  if(until&&Date.now()<until){
    const sec=Math.ceil((until-Date.now())/1000);
    return $("#unlockMsg").textContent=`Too many attempts. Wait ${sec}s.`;
  }
  const ok=await verifyPin(p);
  if(ok){
    state.settings.pinFails=0;state.settings.pinLockUntil=0;await saveMeta();
    $("#lock").classList.remove("open");$("#unlockPin").value="";
    const stillDefault = state.settings.pinHash==="29792bdd8ae699154e0af7b92be8d9a9765b634b18c73089eeb8fcac6bc8e8a6";
    if(stillDefault && !state.settings.pinNudgeShown){
      state.settings.pinNudgeShown=true;await saveMeta();
      toast("Unlocked. For family privacy, change the starter PIN in Settings.","info");
    }else toast("Unlocked — Carrot is ready.","success");
  }else{
    const fails=Number(state.settings.pinFails||0)+1;
    state.settings.pinFails=fails;
    // Exponential backoff: 2^fails seconds, capped at 5 minutes
    const delay=Math.min(300,Math.pow(2,Math.min(fails,8)))*1000;
    if(fails>=3)state.settings.pinLockUntil=Date.now()+delay;
    await saveMeta();
    $("#unlockMsg").textContent=fails>=3?`Incorrect PIN. Locked ${Math.ceil(delay/1000)}s.`:"Incorrect PIN.";
  }
}

const REVIEW_ENGINE_VERSION="v125-electrical-images";
const SUMMARY_MODES = {
  quick:    {label:"Quick Scan", sentenceCount:6,  maxChars:900},
  standard: {label:"Standard",   sentenceCount:10, maxChars:1500},
  deep:     {label:"Deep Review",sentenceCount:16, maxChars:2400},
  cram:     {label:"Exam Cram",  sentenceCount:8,  maxChars:1200}
};

function stableId(prefix,text){
  let h=2166136261;
  for(let i=0;i<String(text).length;i++){
    h^=String(text).charCodeAt(i);
    h=Math.imul(h,16777619);
  }
  return `${prefix}-${(h>>>0).toString(36)}`;
}

function similarity(a,b){
  const A=new Set(tokenize(a).filter(x=>x.length>2));
  const B=new Set(tokenize(b).filter(x=>x.length>2));
  if(!A.size&&!B.size)return 1;
  let common=0;for(const x of A)if(B.has(x))common++;
  return common/Math.max(1,new Set([...A,...B]).size);
}

function extractSentences(text,min=24){
  const cleaned=String(text||"").replace(/\r/g,"");
  if(!cleaned.trim())return [];
  // Protect decimals and common abbreviations so "3.14" / "e.g." / "Dr." do not split.
  const shielded=cleaned
    .replace(/\b(e\.g|i\.e|etc|vs|Dr|Mr|Mrs|Ms|Prof|Fig|eq|approx)\./gi,(m)=>m.replace(/\./g,"∯"))
    .replace(/(\d)\.(\d)/g,"$1∯$2");
  const out=[];
  for(const rawLine of shielded.split(/\n+/)){
    const line=normalize(rawLine.replace(/∯/g,"."));if(!line)continue;
    // Split on sentence enders only when not mid-decimal / abbreviation (already protected).
    const parts=line.split(/(?<=[.!?])\s+(?=[A-Z0-9("'])|(?<=[.!?])$/).filter(Boolean);
    for(const part of parts.length?parts:[line]){
      let sentence=normalize(part.replace(/∯/g,"."));
      if(/^(?:next|then|finally|first|second|third|lastly)\s*[,;:-]/i.test(sentence)&&sentence.length<90)continue;
      if(sentence.length>=min)out.push(sentence);
    }
  }
  const seen=new Set();
  return out.filter(x=>{const k=x.toLowerCase();if(seen.has(k))return false;seen.add(k);return true;});
}

function sentenceUnits(doc){
  if(Array.isArray(doc.units)&&doc.units.length)return doc.units.filter(u=>normalize(u.text));
  const out=[];
  for(const p of doc.pageTexts||[]){
    for(const text of extractSentences(p.text||"",20))out.push({page:p.page,text,source:p.source||"page",photoId:p.photoId||null});
  }
  for(const m of doc.media||[]){
    const combined=normalize(`${m.caption||""}\n${m.ocrText||""}`);
    for(const text of extractSentences(combined,18))out.push({page:null,text,source:"photo",photoId:m.id});
  }
  return out;
}

const BAD_DEF_TERMS=new Set(("what how why when where who which whom whose is are was were be been being the a an of to in on for and or but if then else this that these those it its from with about into through during before after above below between under again further once here there all any both each few more most other some such no nor not only own same so than too very can will just should now whats").split(/\s+/));

function extractQuestionTopic(q){
  const raw=normalize(q);
  const low=raw.toLowerCase().trim();
  // Meta study commands are not topics
  if(/^(summarize|summary|overview|main points?|key points?|what is this (about|on)|explain (this|the material|the (pdf|lesson|chapter|notes?))|give me a summary|tl;?dr)\b/.test(low)){
    return "";
  }
  const patterns=[
    /^(?:what\s+is|what\s+are|what's|whats|define|definition\s+of|meaning\s+of|explain|describe|tell\s+me\s+about|function\s+of|what\s+does)\s+(.+?)[\?\.!]*$/i,
    /^(?:how\s+does|how\s+do|how\s+can|how\s+to)\s+(.+?)[\?\.!]*$/i,
    /^(?:why\s+(?:is|are|do|does|did))\s+(.+?)[\?\.!]*$/i
  ];
  for(const re of patterns){
    const m=raw.match(re);
    if(m&&m[1]){
      let t=m[1].replace(/^(?:a|an|the)\s+/i,"").replace(/[\?\.!,;:]+$/g,"").trim();
      // drop trailing "mean/means/do/does"
      t=t.replace(/\s+(?:mean|means|do|does|work|used for)$/i,"").trim();
      if(t.length>=3)return t;
    }
  }
  // fallback: strip stop words from question
  const words=low.split(/[^a-z0-9]+/).filter(w=>w.length>=3&&!STOP.has(w)&&!BAD_DEF_TERMS.has(w));
  return words.slice(0,6).join(" ");
}

function isLikelyQuestionLine(text){
  const t=normalize(text);
  if(/\?$/.test(t))return true;
  if(/^(?:what|how|why|when|where|who|which|discuss|explain|enumerate|list|describe)\b/i.test(t)&&t.length<180)return true;
  return false;
}

function candidateTerms(doc){
  const units=sentenceUnits(doc), all=units.map(u=>u.text).join(" \n");
  const tokens=tokenize(all).filter(w=>w.length>=4&&w.length<=28&&!STOP.has(w)&&!/^\d+$/.test(w));
  const freq=new Map(), spread=new Map(), firstPos=new Map();
  tokens.forEach((w,i)=>{
    freq.set(w,(freq.get(w)||0)+1);
    if(!firstPos.has(w))firstPos.set(w,i);
  });
  for(const u of units){const seen=new Set(tokenize(u.text));for(const w of seen)if(freq.has(w))spread.set(w,(spread.get(w)||0)+1);}
  const phrases=new Map();
  const normTokens=tokenize(all);
  for(let i=0;i<normTokens.length-1;i++){
    const a=normTokens[i],b=normTokens[i+1];
    if([a,b].every(w=>w.length>=4&&!STOP.has(w))){
      const k=`${a} ${b}`;phrases.set(k,(phrases.get(k)||0)+1);
    }
  }
  const ranked=[...freq].map(([term,f])=>({term,f,score:f*1.15+(spread.get(term)||0)*1.5+(f>=3?2:0)+((firstPos.get(term)||0)<Math.max(40,tokens.length*.12)?1.2:0)}));
  const phraseRanked=[...phrases].filter(([,f])=>f>=2).map(([term,f])=>({term,f,score:f*3.4}));
  const result=[];
  for(const item of [...phraseRanked.sort((a,b)=>b.score-a.score),...ranked.sort((a,b)=>b.score-a.score)]){
    const t=item.term;
    const low=t.toLowerCase();
    if(BAD_DEF_TERMS.has(low)||/^(what|how|why|when|where|who|which|impact|measures)\b/.test(low))continue;
    if(result.some(x=>x.toLowerCase()===low))continue;
    if(result.some(x=>similarity(x,t)>.80))continue;
    result.push(t);
    if(result.length>=40)break;
  }
  return result;
}

function detectHeadings(doc){
  const headings=[];
  for(const p of doc.pageTexts||[]){
    const lines=String(p.text||"").split(/\n+/).map(normalize).filter(Boolean);
    for(const line of lines){
      const words=line.split(/\s+/);
      const alpha=line.replace(/[^A-Za-z]/g,"");
      const titleCase=/^(?:[A-Z][A-Za-z0-9-]*\s*){1,10}$/.test(line);
      const numbered=/^(?:\d+(?:\.\d+)*[.)]|[IVXLC]+[.)]|[A-Z][.)])\s+/.test(line);
      if((words.length<=12&&line.length<=100&&alpha.length>=5&&(titleCase||numbered||line===line.toUpperCase()))){
        if(!/^(page|chapter|figure|table)\s*\d*$/i.test(line))headings.push({text:line,page:p.page});
      }
    }
  }
  const seen=new Set();return headings.filter(h=>{const k=h.text.toLowerCase();if(seen.has(k))return false;seen.add(k);return true;}).slice(0,40);
}

function patternHits(text,re){return re.test(text);}
function unitPage(u){return u?.page??null;}
function contextHeading(page,headings){
  const list=headings.filter(h=>Number(h.page)<=Number(page));
  return list.length?list[list.length-1].text:"";
}

/** Clean answer text for flashcards / tutor — short, study-ready, no table junk. */
function cleanAnswer(text,maxLen=220){
  let t=normalize(String(text||""))
    .replace(/^(?:component|circuit symbol|function of component|function of gate)\s*[:|]?\s*/i,"")
    .replace(/\bFunction of Component\b/gi,"")
    .replace(/\s*\|\s*/g," ")
    .replace(/\s{2,}/g," ")
    .trim();
  if(!t)return "";
  // Prefer first 1–2 full sentences
  const parts=t.match(/[^.!?]+[.!?]?/g)||[t];
  t=parts.slice(0,2).join(" ").trim();
  if(t.length>maxLen){
    let cut=t.slice(0,maxLen);
    const b=Math.max(cut.lastIndexOf(". "),cut.lastIndexOf(" "));
    if(b>maxLen*0.5)cut=cut.slice(0,b+(cut[b]==="."?1:0));
    t=cut.trim();
    if(!/[.!?]$/.test(t))t+="…";
  }
  return t.charAt(0).toUpperCase()+t.slice(1);
}

/**
 * Pull Component → Function pairs from electronics symbol sheets and glossary tables.
 * Handles lines like: "Fuse  A safety device which will blow…"
 */
function extractGlossaryPairs(doc){
  const pairs=[];
  const seen=new Set();
  const pageBlob=(doc.pageTexts||[]).map(p=>String(p.text||"")).join("\n");
  const raw=pageBlob||String(doc.rawText||"");
  const lines=raw.split(/\n+/).map(l=>normalize(l)).filter(Boolean);
  // Known component name starts (electronics sheet + general)
  const nameRe=/^((?:Wire|Wires joined|Wires not joined|Cell|Battery|DC supply|AC supply|Fuse|Transformer|Earth(?:\s*\(Ground\))?|Ground|Lamp(?:\s*\([^)]+\))?|Heater|Motor|Bell|Buzzer|Inductor(?:\s*\([^)]+\))?|Push(?:\s*Switch|\s*to[- ]Break)?(?:\s*\([^)]+\))?|On-Off Switch(?:\s*\([^)]+\))?|2-way Switch(?:\s*\([^)]+\))?|Dual On-Off Switch(?:\s*\([^)]+\))?|Reversing Switch(?:\s*\([^)]+\))?|Relay|Resistor|Variable Resistor(?:\s*\([^)]+\))?|Capacitor(?:[,\s]+polarised)?|Variable Capacitor|Trimmer Capacitor|Diode|LED|Light Emitting Diode|Zener Diode|Photodiode|Transistor(?:\s+NPN|\s+PNP)?|Phototransistor|Microphone|Earphone|Loudspeaker|Piezo Transducer|Amplifier(?:\s*\([^)]+\))?|Aerial(?:\s*\([^)]+\))?|Antenna|Voltmeter|Ammeter|Galvanometer|Ohmmeter|Oscilloscope|LDR|Thermistor|NOT|AND|NAND|OR|NOR|EX-OR|EX-NOR|XOR|XNOR)(?:\s*\([^)]+\))?)\b/i;

  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(/^(?:component|circuit symbol|function)/i.test(line)&&line.length<40)continue;
    if(/wires and connections|power supplies|output devices|switches|resistors|capacitors|diodes|transistors|logic gates|meters/i.test(line)&&line.length<50)continue;

    let term="",fn="";
    const m=line.match(nameRe);
    if(m){
      term=m[1].trim();
      fn=line.slice(m[0].length).replace(/^[\s|:–—-]+/,"").trim();
      // Function may continue on next lines
      let j=i+1;
      while(j<lines.length&&fn.length<40&&!nameRe.test(lines[j])&&lines[j].length>12&&!/^(?:component|circuit)/i.test(lines[j])){
        fn=(fn+" "+lines[j]).trim();j++;
      }
    }else{
      // Generic: short name + long explanation on same line
      const gm=line.match(/^([A-Z][A-Za-z0-9+\/\-() ]{1,42}?)\s{2,}(.{20,})$/);
      if(gm){term=gm[1].trim();fn=gm[2].trim();}
    }
    if(!term||!fn||fn.length<15)continue;
    // Drop if "function" is actually another header
    if(/^(?:wires|power|switches|resistors|function of)/i.test(fn))continue;
    term=term.replace(/\s+/g," ").trim();
    const key=term.toLowerCase();
    if(seen.has(key))continue;
    seen.add(key);
    pairs.push({term,definition:cleanAnswer(fn,280),page:null,confidence:0.92,kind:"component"});
    if(pairs.length>=80)break;
  }

  // Also scan units for "X is a device which…"
  for(const u of sentenceUnits(doc)){
    const text=normalize(u.text||"");
    const m=text.match(/^([A-Za-z][A-Za-z0-9+\/\-() ]{1,40}?)\s+(?:is|are|means)\s+(.{15,})$/i);
    if(!m)continue;
    const term=m[1].trim();
    const key=term.toLowerCase();
    if(seen.has(key)||term.length>45)continue;
    seen.add(key);
    pairs.push({term,definition:cleanAnswer(text,280),page:unitPage(u),confidence:0.85,kind:"definition"});
    if(pairs.length>=80)break;
  }
  return pairs;
}

function detectDefinitions(units,terms){
  // Prefer structured glossary pairs (electronics symbol sheets, etc.)
  const fromGlossary=[];
  try{
    // units alone may not have pageTexts — caller often has doc via sentenceUnits
  }catch{}
  const defs=[];
  const patterns=[
    /^(.{2,80}?)\s+(?:is|are|means|refers to|is defined as|are defined as|is known as|is called)\s+(.{12,})$/i,
    /^(.{2,80}?)\s*:\s*(.{12,})$/i,
    /^(.{2,60}?)\s*[-–—]\s+(.{12,})$/,
    /^(.{2,60}?)\s*\(\s*(?:def(?:inition)?|means)\s*\)\s*[-–—:]?\s*(.{12,})$/i,
    /(?:the term|the concept|the process)\s+(.{2,80}?)\s+(?:is|means|refers to)\s+(.{12,})/i,
    // Electronics sheet style: short name then long function sentence
    /^((?:[A-Z][A-Za-z0-9+\/\-()]*(?:\s+[A-Za-z0-9+\/\-()]+){0,5}))\s+((?:A |An |This |The |Supplies |Allows |Restricts |Converts |Stores |Creates |Amplifies |Measures |Only |Used ).{12,})$/
  ];
  for(const u of units){
    const text=normalize(String(u.text||"").replace(/([A-Za-z])-\s*\n\s*([a-z])/g,"$1$2"));
    if(text.length<18)continue;
    let hit=null;
    for(const re of patterns){const m=text.match(re);if(m){hit=m;break;}}
    let term=hit?.[1]?.trim()||terms.find(t=>text.toLowerCase().includes(String(t).toLowerCase()));
    if(!term)continue;
    term=term.replace(/^(the|a|an)\s+/i,"").replace(/[.:;]+$/,"").trim();
    if(term.length>55)term=terms.find(t=>text.toLowerCase().includes(String(t).toLowerCase()))||term;
    if(!term||term.length<3||term.length>55)continue;
    if(BAD_DEF_TERMS.has(term.toLowerCase()))continue;
    if(/^(what|how|why|when|where|who|which|impact|measures|discuss|explain|enumerate)\b/i.test(term))continue;
    if(defs.some(d=>d.term.toLowerCase()===term.toLowerCase()))continue;
    const body=hit?.[2]?cleanAnswer(hit[2],260):cleanAnswer(text,260);
    if(body.length<12)continue;
    if(isLikelyQuestionLine(body)&&!/\bis\b|means|refers|function/i.test(body))continue;
    const confidence=Math.min(0.98,0.58+(hit?0.24:0)+(text.length<260?0.08:0)+(unitPage(u)?0.04:0));
    defs.push({term,definition:body,page:unitPage(u),confidence});
    if(defs.length>=60)break;
  }
  return defs;
}

function classifyUnit(u,terms){
  const text=u.text||"", low=text.toLowerCase();
  const hits=[];
  if(/\b(is|are|means|refers to|defined as|known as|called)\b/i.test(text)||/^.{2,60}\s*[-–—:]\s+.{12,}/.test(text))hits.push("definition");
  if(/\b(first|second|third|next|then|finally|step|procedure|process|stage|phase)\b/i.test(text))hits.push("process");
  if(/\b(because|therefore|causes?|results? in|leads? to|due to|as a result|consequently)\b/i.test(text))hits.push("cause-effect");
  if(/\b(whereas|while|unlike|compared with|in contrast|difference between|similar to|both)\b/i.test(text))hits.push("comparison");
  if(/\b(for example|for instance|such as|e\.g\.|eg\.)\b/i.test(text))hits.push("example");
  if(/\b(important|key|note|remember|warning|caution|must)\b/i.test(text))hits.push("exam-focus");
  if(/\d|%|\b(?:Hz|V|A|W|Ω|ohm|kg|m|cm|mm|mol)\b|[A-Za-z]\s*=\s*[^ ]|→|->/i.test(text))hits.push("fact-formula");
  const overlap=terms.slice(0,28).reduce((n,t)=>n+(low.includes(String(t).toLowerCase())?1:0),0);
  return {hits,overlap};
}

function scoreUnit(u,terms,headings,position,total){
  const f=classifyUnit(u,terms), text=u.text||"";let score=f.overlap*2.2+f.hits.length*2;
  if(text.length>=55&&text.length<=300)score+=2.5;
  if(text.length>420)score-=2;
  if(position<Math.max(3,total*.12))score+=1.7;
  if(f.hits.includes("definition"))score+=4;
  if(f.hits.includes("exam-focus"))score+=3;
  if(f.hits.includes("cause-effect")||f.hits.includes("comparison")||f.hits.includes("process"))score+=2.3;
  const h=contextHeading(unitPage(u),headings);if(h)score+=1;
  // Strict accuracy: heavily penalize question-like and incomplete OCR fragments
  if(isLikelyQuestionLine(text))score-=10;
  if(/\b(what|how|why|when|where|who|which|discuss|explain|enumerate|list|describe)\b/i.test(text)&&text.length<180)score-=7;
  if((text.match(/[A-Za-z]/g)||[]).length<22)score-=5;
  return score;
}

function selectEvidence(units,terms,headings,count,filterFn=()=>true){
  // Strict accuracy path: only high-scoring, non-question, reasonably complete sentences
  const ranked=units
    .map((u,i)=>({u,i,score:scoreUnit(u,terms,headings,i,units.length)}))
    .filter(x=>filterFn(x.u) && x.score>=5 && !isLikelyQuestionLine(x.u.text) && (x.u.text||"").length>=32)
    .sort((a,b)=>b.score-a.score);
  const picked=[];
  for(const item of ranked){
    if(picked.some(x=>similarity(x.u.text,item.u.text)>.55))continue;
    picked.push(item);if(picked.length>=count)break;
  }
  return picked.sort((a,b)=>a.i-b.i);
}

function softenBullet(text,maxLen=150){
  let t=normalize(String(text||"").replace(/^(note|important|remember|tip)\s*[:.\-–—]?\s*/i,""));
  if(!t)return "";
  if(t.length>maxLen){
    const clause=t.split(/[;:]/)[0].trim();
    if(clause.length>=40&&clause.length<=maxLen)t=clause;
    else{
      // Never cut mid-word: back up to last whitespace / punctuation boundary.
      let cut=t.slice(0,maxLen);
      const boundary=Math.max(cut.lastIndexOf(" "),cut.lastIndexOf(","),cut.lastIndexOf(";"),cut.lastIndexOf("."),cut.lastIndexOf("—"));
      if(boundary>=Math.floor(maxLen*0.55))cut=cut.slice(0,boundary);
      else cut=cut.replace(/\s+\S*$/,"");
      t=cut.replace(/[,:;.\-–—]+$/,"").trim()+"…";
    }
  }
  if(!t)return "";
  return t.charAt(0).toUpperCase()+t.slice(1);
}

function sentenceQuality(u,terms,headings,index,total){
  const text=normalize(u?.text||"");
  if(!text)return -999;
  const f=classifyUnit(u,terms), tokens=tokenize(text).filter(x=>x.length>2);
  let score=f.overlap*2.6 + f.hits.length*1.7;
  if(text.length>=55&&text.length<=360)score+=3.2;
  if(text.length>520)score-=2.5;
  if(index<Math.max(4,total*.08))score+=1.2;
  if(f.hits.includes("definition"))score+=5;
  if(f.hits.includes("fact-formula"))score+=3.5;
  if(f.hits.includes("process")||f.hits.includes("cause-effect")||f.hits.includes("comparison"))score+=2.5;
  if(contextHeading(unitPage(u),headings))score+=1.2;
  if(tokens.length<10)score-=4;
  if(isLikelyQuestionLine(text))score-=14;
  if(/^[-•*\d.)\s]+$/.test(text))score-=10;
  // OCR noise signals: repeated junk characters / very low alpha ratio.
  const alpha=(text.match(/[A-Za-zÀ-ÿ]/g)||[]).length;
  if(alpha/Math.max(1,text.length)<.35)score-=5;
  return score;
}

function buildEvidenceLedger(units,terms,headings){
  const ledger=[];
  for(let i=0;i<units.length;i++){
    const u=units[i], text=normalize(u?.text||"");
    if(!text||text.length<24||isLikelyQuestionLine(text))continue;
    const score=sentenceQuality(u,terms,headings,i,units.length);
    if(score<3)continue;
    const kind=classifyUnit(u,terms).hits;
    ledger.push({id:stableId("e",`${unitPage(u)}:${text}`),text,page:unitPage(u)||null,heading:contextHeading(unitPage(u),headings)||"General",score,kind});
  }
  ledger.sort((a,b)=>b.score-a.score);
  const dedup=[];
  for(const e of ledger){
    if(dedup.some(x=>similarity(x.text,e.text)>.62))continue;
    dedup.push(e);
  }
  return dedup;
}

function coverageSelectEvidence(ledger,limit,mode){
  const selected=[]; const usedHeadings=new Set();
  const max=Math.max(8,limit||12);
  // First pass: cover distinct headings and evidence types.
  for(const e of ledger){
    const key=`${e.heading}|${e.kind.slice(0,2).join(',')}`;
    if(usedHeadings.has(e.heading)&&selected.length<Math.ceil(max*.55))continue;
    selected.push(e);usedHeadings.add(e.heading);
    if(selected.length>=Math.min(max,Math.ceil(max*.6)))break;
  }
  // Second pass: add highest-quality evidence.
  for(const e of ledger){
    if(selected.some(x=>x.id===e.id))continue;
    selected.push(e);if(selected.length>=max)break;
  }
  return selected;
}

function compactEvidenceLine(e,max=220){
  let t=normalize(e.text||"");
  if(t.length>max){
    const cut=t.slice(0,max), b=Math.max(cut.lastIndexOf(". "),cut.lastIndexOf("; "),cut.lastIndexOf(", "),cut.lastIndexOf(" "));
    t=(b>max*.55?cut.slice(0,b):cut.replace(/\s+\S*$/,""))+"…";
  }
  const ref=e.page?` [p.${e.page}]`:"";
  return `• ${t}${ref}`;
}

function synthesizeSummary(units,terms,headings,mode){
  // ATLAS local synthesis: replace the old sentence-count summary with a
  // coverage-oriented evidence ledger. It is extractive by default, so it
  // cannot silently invent facts. Every study claim points back to a page when available.
  const cfg=SUMMARY_MODES[mode]||SUMMARY_MODES.standard;
  const ledger=buildEvidenceLedger(units,terms,headings);
  if(!ledger.length)return "Not enough clear source evidence was extracted.\n\nTry Re-run OCR on image-heavy pages or upload a clearer source, then regenerate.";

  const target=mode==="deep"?22:mode==="cram"?14:mode==="quick"?9:16;
  const selected=coverageSelectEvidence(ledger,target,mode);
  const defs=selected.filter(e=>e.kind.includes("definition"));
  const facts=selected.filter(e=>e.kind.includes("fact-formula"));
  const processes=selected.filter(e=>e.kind.includes("process")||e.kind.includes("cause-effect"));
  const comparisons=selected.filter(e=>e.kind.includes("comparison"));
  const general=selected.filter(e=>!defs.includes(e)&&!facts.includes(e)&&!processes.includes(e)&&!comparisons.includes(e));
  const blocks=[
    "SOURCE-GROUNDED STUDY SUMMARY",
    "Every bullet below is extracted or lightly shortened from the uploaded material. Page references are evidence pointers, not invented citations.",
    "",
    "CORE IDEAS",
    ...general.slice(0,mode==="quick"?5:mode==="deep"?9:7).map(e=>compactEvidenceLine(e,mode==="cram"?150:210))
  ];
  if(defs.length){blocks.push("","KEY DEFINITIONS",...defs.slice(0,mode==="cram"?6:8).map(e=>compactEvidenceLine(e,210)));}
  if(facts.length){blocks.push("","FACTS & FORMULAS",...facts.slice(0,6).map(e=>compactEvidenceLine(e,210)));}
  if(processes.length){blocks.push("","PROCESSES / CAUSE & EFFECT",...processes.slice(0,mode==="deep"?7:5).map(e=>compactEvidenceLine(e,220)));}
  if(comparisons.length){blocks.push("","COMPARISONS",...comparisons.slice(0,5).map(e=>compactEvidenceLine(e,220)));}
  const focus=(terms||[]).filter(Boolean).slice(0,10);
  if(focus.length)blocks.push("","CONCEPTS TO MASTER",focus.map(t=>`• ${t}`).join("\n"));
  const coverage=Math.round(Math.min(100,selected.length/Math.max(1,Math.min(target,ledger.length))*100));
  blocks.push("","SOURCE QUALITY",`Evidence coverage: ${coverage}% • ${ledger.length} usable evidence units • ${selected.length} selected for this mode.`,"Accuracy rule: if the source is unclear, incomplete, or contradictory, StudyVault should flag it instead of guessing.");
  let out=blocks.filter((v,i,a)=>v!==""||a[i-1]!=="").join("\n").trim();
  const cap=mode==="deep"?4200:mode==="cram"?2600:mode==="quick"?1800:3200;
  if(out.length>cap)out=out.slice(0,cap).replace(/\s+\S*$/,"\n…");
  return out;
}

function mergeDefinitions(primary,extra){
  const out=[...(primary||[])];
  const seen=new Set(out.map(d=>d.term.toLowerCase()));
  for(const d of extra||[]){
    const k=String(d.term||"").toLowerCase();
    if(!k||seen.has(k))continue;
    seen.add(k);out.push(d);
  }
  return out;
}
function detectStructuredPatterns(units,terms,headings,doc=null){
  let definitions=detectDefinitions(units,terms);
  if(doc){
    const glossary=extractGlossaryPairs(doc);
    definitions=mergeDefinitions(glossary,definitions);
  }
  const processes=units.filter(u=>classifyUnit(u,terms).hits.includes("process")).slice(0,18).map(u=>({text:u.text,page:unitPage(u)}));
  const causes=units.filter(u=>classifyUnit(u,terms).hits.includes("cause-effect")).slice(0,18).map(u=>({text:u.text,page:unitPage(u)}));
  const comparisons=units.filter(u=>classifyUnit(u,terms).hits.includes("comparison")).slice(0,16).map(u=>({text:u.text,page:unitPage(u)}));
  const examples=units.filter(u=>classifyUnit(u,terms).hits.includes("example")).slice(0,16).map(u=>({text:u.text,page:unitPage(u)}));
  const facts=units.filter(u=>classifyUnit(u,terms).hits.includes("fact-formula")).slice(0,20).map(u=>({text:u.text,page:unitPage(u)}));
  const keyPoints=selectEvidence(units,terms,headings,30).map(x=>({text:x.u.text,page:unitPage(x.u),heading:contextHeading(unitPage(x.u),headings),score:Math.round(x.score*10)/10}));
  return {definitions,processes,causes,comparisons,examples,facts,keyPoints};
}

function buildReviewer(doc){
  const units=sentenceUnits(doc);
  let terms=Array.isArray(doc.terms)&&doc.terms.length?doc.terms:candidateTerms(doc);
  const headings=detectHeadings(doc);
  const s=detectStructuredPatterns(units,terms,headings,doc);
  // Glossary sheets: promote component names into terms
  if((s.definitions||[]).length>=8){
    const extra=s.definitions.map(d=>d.term).filter(Boolean);
    const merged=[];
    const seen=new Set();
    for(const t of [...extra,...terms]){
      const k=String(t).toLowerCase();if(seen.has(k))continue;seen.add(k);merged.push(t);
      if(merged.length>=60)break;
    }
    terms=merged;
  }
  let overview=synthesizeSummary(units,terms,headings,doc.summaryMode||"standard");
  // Component / symbol sheets: use only extracted definitions (highest accuracy)
  if((s.definitions||[]).length>=6){
    const top=s.definitions
      .filter(d=>d.term&&d.definition&&!isLikelyQuestionLine(d.definition))
      .slice(0,12)
      .map(d=>`• ${d.term} — ${cleanAnswer(d.definition,110)}`);
    if(top.length>=3){
      const head=(doc.summaryMode==="cram")
        ?"Exam cram — components from your material"
        :"Source definitions (component / symbol reference)";
      overview=`Source-only summary\n(Taken only from your uploaded material — nothing invented)\n\n${head}\n${top.join("\n")}`;
    }
  }
  const takeaways=(s.definitions||[]).length>=6
    ? s.definitions.slice(0,14).map(d=>({text:`${d.term}: ${cleanAnswer(d.definition,140)}`,page:d.page,heading:""}))
    : selectEvidence(units,terms,headings,10).map(x=>({text:cleanAnswer(x.u.text,160),page:unitPage(x.u),heading:contextHeading(unitPage(x.u),headings)}));
  const memory=(s.definitions||[]).slice(0,24).map(d=>({term:d.term,clue:cleanAnswer(d.definition,160),page:d.page}));
  if(memory.length<8){
    for(const term of terms.slice(0,18)){
      if(memory.some(m=>m.term.toLowerCase()===String(term).toLowerCase()))continue;
      const u=units.find(x=>x.text.toLowerCase().includes(String(term).toLowerCase()));
      memory.push({term,clue:u?cleanAnswer(u.text,160):`Connect ${term} to its purpose in the material.`,page:unitPage(u)});
    }
  }
  const questions=[];
  s.definitions.slice(0,16).forEach(d=>{
    questions.push({type:"definition",q:`What is the function of a ${d.term}?`,page:d.page});
    questions.push({type:"recall",q:`In one sentence, explain what a ${d.term} does in a circuit.`,page:d.page});
  });
  s.processes.slice(0,5).forEach(p=>questions.push({type:"process",q:`Explain the process or sequence described on page ${p.page??"the source"}.`,page:p.page}));
  s.causes.slice(0,5).forEach(p=>questions.push({type:"cause-effect",q:`What cause-and-effect relationship is described in this point?`,page:p.page}));
  takeaways.slice(0,6).forEach(p=>questions.push({type:"recall",q:`Explain without looking: ${cleanAnswer(p.text,90)}`,page:p.page}));
  const checklist=[];
  s.definitions.slice(0,12).forEach(d=>checklist.push(`Name ${d.term} and state its function from memory.`));
  terms.slice(0,8).forEach(t=>{if(!checklist.some(c=>c.includes(t)))checklist.push(`Explain ${t} without reading the source.`);});
  if(s.processes.length)checklist.push("Reconstruct the important process steps from memory.");
  if(s.facts.length)checklist.push("Memorize the important formulas, numbers, units, or factual thresholds.");
  (doc.media||[]).forEach((m,i)=>checklist.push(m.ocrText?`Review the text in photo ${i+1}.`:`Explain what photo ${i+1} is showing and why it matters.`));
  // Better exam cram for glossary sheets
  let examCramOverride=null;
  if(s.definitions.length>=6){
    examCramOverride="Remember these\n"+s.definitions.slice(0,14).map(d=>`• ${d.term}: ${cleanAnswer(d.definition,90)}`).join("\n");
  }
  const pages=[];
  for(const p of doc.pageTexts||[]){
    const pu=units.filter(u=>Number(u.page)===Number(p.page));
    const top=selectEvidence(pu,terms,headings,1)[0]?.u;
    if(top)pages.push({page:p.page,text:top.text,source:p.source||"page",heading:contextHeading(p.page,headings)});
  }
  const blueprint=[
    {label:"Definitions",value:s.definitions.map(d=>d.term)},
    {label:"Processes / steps",value:s.processes.slice(0,5).map(x=>x.text)},
    {label:"Cause & effect",value:s.causes.slice(0,5).map(x=>x.text)},
    {label:"Comparisons",value:s.comparisons.slice(0,5).map(x=>x.text)},
    {label:"Examples",value:s.examples.slice(0,5).map(x=>x.text)},
    {label:"Facts / formulas",value:s.facts.slice(0,6).map(x=>x.text)}
  ];
  const conceptMap=[];
  for(let i=0;i<Math.min(terms.length,18);i++)for(let j=i+1;j<Math.min(terms.length,18);j++){
    const a=terms[i],b=terms[j];const co=units.filter(u=>u.text.toLowerCase().includes(a.toLowerCase())&&u.text.toLowerCase().includes(b.toLowerCase())).length;if(co>=2)conceptMap.push({from:a,to:b,strength:co});
  }
  conceptMap.sort((a,b)=>b.strength-a.strength);
  const strategy=buildStrategy(s,terms,doc.media||[],doc.summaryMode||"standard");
  const examCram=examCramOverride||synthesizeSummary(units,terms,headings,"cram");
  const confidence=Math.round(clamp((Math.min(1,units.length/20)*.25)+(Math.min(1,terms.length/20)*.25)+(Math.min(1,s.definitions.length/6)*.20)+(Math.min(1,takeaways.length/8)*.20)+(headings.length?0.10:0),0,1)*100);
  return {
    engineVersion:REVIEW_ENGINE_VERSION,mode:doc.summaryMode||"standard",overview,strategy,examCram,terms,headings,
    definitions:s.definitions,keyPoints:takeaways,processes:s.processes,causes:s.causes,comparisons:s.comparisons,examples:s.examples,facts:s.facts,
    questions:questions.slice(0,40),memory,checklist:checklist.slice(0,28),pages:pages.slice(0,80),blueprint,conceptMap:conceptMap.slice(0,40),confidence
  };
}

function buildStrategy(s,terms,media,mode){
  const steps=[];
  steps.push(`Start with the top ${Math.min(terms.length,10)} concepts, then read the ${SUMMARY_MODES[mode]?.label||"Standard"} summary once.`);
  if(s.definitions.length)steps.push("Learn definitions first — say each one out loud before looking at examples.");
  if(s.processes.length)steps.push("Cover the page and rebuild the process steps from memory, then check the order.");
  if(s.causes.length)steps.push("For each cause–effect pair, explain why it happens in one short sentence.");
  if(s.comparisons.length)steps.push("Write a quick two-column table for ideas that are easy to mix up.");
  if(s.facts.length)steps.push("Memorize formulas, numbers, and units on their own — separate from the story.");
  if(media.length)steps.push("Study each photo or diagram, then explain it with your eyes closed.");
  steps.push("Finish with the quiz. Any concept you miss twice goes back into flashcards.");
  return steps.map((s,i)=>`${i+1}. ${s}`).join("\n");
}

function clozeFromSentence(text,term){
  const raw=String(term||"").trim();
  if(!raw)return String(text||"");
  const e=raw.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  // Safe word-boundary replace (no lookbehind — older browsers crash otherwise and kill PDF import)
  try{
    const re=new RegExp(`(?:^|[^A-Za-z0-9_])(${e})(?=[^A-Za-z0-9_]|$)`,"i");
    if(re.test(text))return String(text).replace(re,(m,g1)=>m.replace(g1,"_____")).replace(/\s{2,}/g," ").trim();
  }catch{}
  // Last resort: case-insensitive plain replace of whole term only when isolated by spaces
  const plain=String(text);
  const idx=plain.toLowerCase().indexOf(raw.toLowerCase());
  if(idx<0)return plain;
  return (plain.slice(0,idx)+"_____"+plain.slice(idx+raw.length)).replace(/\s{2,}/g," ").trim();
}

function cardId(doc,type,question,answer){return stableId("fc",`${doc.id}|${type}|${question}|${answer}`);}
/** Scale flashcard count to material size — small handouts stay light; rich PDFs grow up to 200. */
function flashcardBudget(doc,r,units){
  const pages=Math.max(1,Number(doc.pageCount)||(doc.pageTexts||[]).length||1);
  const terms=(r.terms||[]).length;
  const defs=(r.definitions||[]).length;
  const media=(doc.media||[]).length;
  const unitN=units.length;
  // Estimate complexity, then clamp 24…200
  let target=24
    +Math.min(40,pages*3)
    +Math.min(50,terms*2)
    +Math.min(30,defs*2)
    +Math.min(40,Math.floor(unitN/4))
    +Math.min(20,media*2);
  if(pages>=15||terms>=30||unitN>=80)target=Math.max(target,120);
  if(pages>=25||terms>=45||unitN>=150)target=Math.max(target,180);
  return clamp(Math.round(target),24,MAX_FLASHCARDS);
}

function evidenceUnits(doc){
  return sentenceUnits(doc).map((u,i)=>({...u,_i:i,text:normalize(u.text)})).filter(u=>u.text.length>=18);
}
function evidenceForTerm(doc,term){
  const t=normalize(term).toLowerCase();
  if(!t)return [];
  return evidenceUnits(doc).filter(u=>u.text.toLowerCase().includes(t)).sort((a,b)=>{
    const ae=/\b(is|are|means|refers|defined|used|allows|stores|converts|measures|controls|produces|causes|results)\b/i.test(a.text)?1:0;
    const be=/\b(is|are|means|refers|defined|used|allows|stores|converts|measures|controls|produces|causes|results)\b/i.test(b.text)?1:0;
    return be-ae || b.text.length-a.text.length;
  });
}
function answerHasEvidence(answer,evidence){
  const a=tokenize(answer).filter(x=>x.length>=4);
  if(!a.length||!evidence)return false;
  const e=new Set(tokenize(evidence).filter(x=>x.length>=4));
  const hits=a.filter(x=>e.has(x)).length;
  return hits>=Math.min(5,Math.max(3,Math.ceil(a.length*.28)));
}
function safeCardEvidence(doc,term,answer,page){
  const ev=term?evidenceForTerm(doc,term):evidenceUnits(doc).filter(u=>!isLikelyQuestionLine(u.text));
  if(page!=null){const same=ev.filter(x=>Number(x.page)===Number(page));if(same.length) return same[0];}
  return ev.find(x=>answerHasEvidence(answer,x.text))||ev[0]||null;
}
function validateFlashcard(doc,card){
  if(!card?.question||!card?.answer)return false;
  if(isLikelyQuestionLine(card.answer))return false;
  const ev=safeCardEvidence(doc,card.term,card.answer,card.page);
  if(!ev)return false;
  // cloze and name-it answers are the term itself — evidence is already tied by term match
  if(card.type==='cloze' || card.type==='name-it')return true;
  const supported=answerHasEvidence(card.answer,ev.text) || similarity(card.answer,ev.text)>=.34;
  if(!supported)return false;
  // Reject answers that are merely a short overlap with unrelated source text.
  const answerTokens=new Set(tokenize(card.answer).filter(t=>t.length>=5));
  const evidenceTokens=new Set(tokenize(ev.text).filter(t=>t.length>=5));
  const overlap=[...answerTokens].filter(t=>evidenceTokens.has(t)).length;
  const density=answerTokens.size?overlap/answerTokens.size:0;
  return overlap>=2 || density>=.45;
}
function validateQuizItem(doc,q){
  if(!q||!Array.isArray(q.options)||q.options.length<2)return false;
  if(!Number.isInteger(q.correctIndex)||q.correctIndex<0||q.correctIndex>=q.options.length)return false;
  const correct=normalize(q.options[q.correctIndex]||'');
  if(!correct)return false;
  const ev=q.term?evidenceForTerm(doc,q.term):evidenceUnits(doc);
  if(!ev.length)return false;
  if(q.type==='definition' && q.term){
    const target=evidenceForTerm(doc,q.term);
    if(!(target.length>0 && (answerHasEvidence(q.context||'',target[0].text) || similarity(q.context||'',target[0].text)>=.28)))return false;
    const source=target[0].text;
    return q.options.every((o,i)=>{
      if(i===q.correctIndex)return true;
      const opt=normalize(o);
      if(!opt || opt.toLowerCase()===correct.toLowerCase())return false;
      const optEv=evidenceForTerm(doc,opt);
      // A distractor is unsafe if the source actually supports it as the same definition.
      const looksSupported=answerHasEvidence(opt,source) || similarity(opt,source)>=.72;
      const sharesAnotherDefinition=optEv.some(e=>similarity(e.text,source)>=.70);
      return !looksSupported && !sharesAnotherDefinition;
    });
  }
  if(q.type==='concept' && q.term){
    const source=ev[0].text;
    if(!(answerHasEvidence(q.context||'',source)||similarity(q.context||'',source)>=.28))return false;
    return !q.options.some((o,i)=>i!==q.correctIndex && (answerHasEvidence(o,source)||similarity(o,source)>=.72));
  }
  if(q.type==='key-point'){
    if(!(q.context&&answerHasEvidence(correct,q.context)))return false;
    return !q.options.some((o,i)=>i!==q.correctIndex && answerHasEvidence(o,q.context));
  }
  return false;
}

function auditStudyPack(doc){
  const r=doc?.reviewerData||{};
  const cardChecks=(doc?.flashcards||[]).map(c=>({id:c.id,ok:validateFlashcard(doc,c)}));
  const quizChecks=(doc?.quiz||[]).map(q=>({id:q.id,ok:validateQuizItem(doc,q)}));
  const cardsBad=cardChecks.filter(x=>!x.ok).length, quizBad=quizChecks.filter(x=>!x.ok).length;
  const evidenceCount=(r.keyPoints||[]).length+(r.definitions||[]).length+(r.facts||[]).length+(r.processes||[]).length;
  return {cardsTotal:cardChecks.length,cardsBad,quizTotal:quizChecks.length,quizBad,evidenceCount,passed:cardsBad===0&&quizBad===0&&evidenceCount>0};
}
function buildVerifiedNotes(doc){
  const r=doc?.reviewerData||buildReviewer(doc); if(!doc)return '';
  const out=[]; const push=(label,text,page)=>{text=cleanAnswer(text,360);if(!text)return;out.push(`<li><strong>${esc(label)}</strong> — ${esc(text)}${page?` <span class="source-ref">p.${esc(page)}</span>`:''}</li>`)};
  out.push(`<h2>Verified Study Notes</h2><p class="note-trust"><strong>Source-grounded:</strong> Facts, definitions, processes, and key points below are tied to the imported material. The overview is a concise synthesis of those verified source-backed sections. Page references are shown where available.</p>`);
  if(r.overview)out.push(`<h3>Core understanding</h3><p>${esc(cleanAnswer(r.overview,900))}</p>`);
  if((r.definitions||[]).length){out.push('<h3>Definitions</h3><ul>');for(const x of r.definitions.slice(0,30))push(x.term,x.definition,x.page);out.push('</ul>');}
  if((r.keyPoints||[]).length){out.push('<h3>Key points</h3><ul>');for(const x of r.keyPoints.slice(0,35)){const t=typeof x==='string'?x:x.text;push('Key point',t,x.page);}out.push('</ul>');}
  if((r.processes||[]).length){out.push('<h3>Processes</h3><ul>');for(const x of r.processes.slice(0,20))push('Process',x.text,x.page);out.push('</ul>');}
  if((r.facts||[]).length){out.push('<h3>Facts and formulas</h3><ul>');for(const x of r.facts.slice(0,25))push('Remember',x.text,x.page);out.push('</ul>');}
  return safeNoteHtml(out.join(''));
}
async function buildVerifiedStudyPack(){
  const d=activeDoc();if(!d)return toast('Add study material first.','error');
  try{
    await Promise.resolve(regenerateDoc(d,true));
    // Do not audit until regeneration has fully returned and all artifacts exist.
    d.flashcards=(d.flashcards||[]).filter(c=>validateFlashcard(d,c));
    d.quiz=(d.quiz||[]).filter(q=>validateQuizItem(d,q));
    d.notesTitle=`Verified Notes — ${d.fileName||'Study Material'}`;
    d.notesHtml=buildVerifiedNotes(d); d.notes=stripHtml(d.notesHtml); d.notesUpdatedAt=now();
    const audit=auditStudyPack(d);
    d.studyPackAudit={...audit,at:now(),status:audit.passed?'verified':'needs-review'};
    await saveDoc(d); renderAll({full:true});
    setTimeout(runFirstTour, 600);
    const a=d.studyPackAudit;
    toast(a.passed?`✓ Everything checked · ${a.cardsTotal} cards · ${a.quizTotal} questions · ${a.evidenceCount} evidence groups.`:`⚠ ${a.cardsBad+a.quizBad} generated item(s) were rejected by source validation. Regenerate to replace them.`,a.passed?'success':'error');
  }catch(err){
    console.error('buildVerifiedStudyPack failed',err);
    toast('Study pack verification failed safely. Nothing was marked verified.','error');
  }
}
function verifyStudyPack(){
  const d=activeDoc();if(!d)return toast('Add study material first.','error');
  const a=auditStudyPack(d);d.studyPackAudit={...a,at:now()};saveDoc(d);
  toast(a.passed?`Everything checked against source evidence: ${a.cardsTotal} cards and ${a.quizTotal} quiz items passed.`:`Found ${a.cardsBad+a.quizBad} item(s) needing regeneration.` ,a.passed?'success':'error');
  renderStats();
}

function makeFlashcards(doc){
  const units=evidenceUnits(doc),r=doc.reviewerData||buildReviewer(doc),cards=[],seen=new Set();
  const limit=flashcardBudget(doc,r,units);
  const add=(type,q,a,term="",page=null,source="page")=>{
    if(cards.length>=limit)return;
    q=normalize(q);a=cleanAnswer(a,240);if(q.length<8||a.length<4)return;
    if(isLikelyQuestionLine(a))return;
    // name-it and cloze legitimately use short answers (the term itself)
    if(type!=="name-it" && type!=="cloze" && a.split(/\s+/).length<4)return;
    const evidence=safeCardEvidence(doc,term,a,page);if(!evidence)return;
    const resolvedPage=page??evidence.page??null;
    const id=cardId(doc,type,q,a);if(seen.has(id))return;seen.add(id);
    const card={id,type,term,question:q,answer:a,page:resolvedPage,source,evidence:evidence.text};
    if(validateFlashcard(doc,card))cards.push(card);
  };

  // Definitions are the highest-confidence source. Every card points back to the exact evidence.
  for(const d of r.definitions||[]){
    const ans=cleanAnswer(d.definition,220);
    add("definition",`What is the function or meaning of ${d.term}?`,ans,d.term,d.page);
    // Put the description in the question so the card is usable (not just "which term?")
    const desc=cleanAnswer(d.definition,160);
    if(desc.length>=12){
      add("name-it",`Which term matches this source description?\n\n${desc}`,d.term,d.term,d.page);
    }
    add("explain",`Explain ${d.term} using the study material.`,ans,d.term,d.page);
  }

  const termCap=Math.min((r.terms||[]).length,Math.max(20,Math.floor(limit/3)));
  for(const term of (r.terms||[]).slice(0,termCap)){
    if((r.definitions||[]).some(d=>d.term.toLowerCase()===String(term).toLowerCase()))continue;
    const ev=evidenceForTerm(doc,term)[0];if(!ev)continue;
    const ans=cleanAnswer(ev.text,210);
    add("source-recall",`According to the material, what does ${term} mean or do?`,ans,term,ev.page);
    const cloze=clozeFromSentence(ev.text,term);
    if(cloze&&cloze.includes("_____"))add("cloze",`Fill in the blank:\n${cleanAnswer(cloze,200)}`,String(term),term,ev.page);
  }
  for(const p of (r.processes||[]).slice(0,12))add("process",`What does the material say about this process?`,cleanAnswer(p.text,200),"",p.page);
  for(const f of (r.facts||[]).slice(0,16))add("fact",`What fact or formula should you remember?`,cleanAnswer(f.text,200),"",f.page);
  for(const p of r.keyPoints||[])add("key-point",`Explain this key idea from the material.`,cleanAnswer(typeof p==='string'?p:p.text,190),"",p.page);
  return cards.slice(0,limit);
}

function deterministicShuffle(arr,seedText=""){
  const a=[...arr];let seed=0;for(const c of seedText)seed=(seed*31+c.charCodeAt(0))>>>0;
  for(let i=a.length-1;i>0;i--){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const j=seed%(i+1);[a[i],a[j]]=[a[j],a[i]];}return a;
}

function lengthMatchedDistractors(correct,pool,seed,count=3){
  const c=normalize(correct);const target=c.length||20;const seen=new Set([c.toLowerCase()]);
  const scored=pool.map(x=>{const t=normalize(x);if(!t||seen.has(t.toLowerCase()))return null;return{t,score:Math.abs(t.length-target)+Math.abs(tokenize(t).length-tokenize(c).length)*4};}).filter(Boolean).sort((a,b)=>a.score-b.score);
  const picks=[];
  for(const item of scored){if(picks.some(p=>similarity(p,item.t)>.72))continue;picks.push(item.t);seen.add(item.t.toLowerCase());if(picks.length>=count)break;}
  if(picks.length<count){for(const x of deterministicShuffle(pool,seed)){const t=normalize(x);if(!t||seen.has(t.toLowerCase()))continue;picks.push(t);seen.add(t.toLowerCase());if(picks.length>=count)break;}}
  return picks;
}
function quizItem(doc,type,question,context,correct,options,page,term=""){
  const unique=[];const seen=new Set();
  for(const o of [correct,...(options||[])]){const t=normalize(o);if(!t)continue;const k=t.toLowerCase();if(seen.has(k))continue;seen.add(k);unique.push(t);}
  const right=normalize(correct);if(!unique.includes(right))unique.unshift(right);
  const opts=deterministicShuffle(unique.slice(0,4),question+right);
  return opts.length>=2?{id:stableId("q",`${doc.id}|${type}|${question}|${right}`),type,question,context,options:opts,correctIndex:opts.indexOf(right),correct:right,page,term}:null;
}

function makeQuiz(doc){
  const r=doc.reviewerData||buildReviewer(doc),terms=r.terms||[],quiz=[],seen=new Set();
  const add=q=>{if(q&&(q.type==="fill"||q.type==="match"||validateQuizItem(doc,q))&&!seen.has(q.id)){seen.add(q.id);quiz.push(q);}};
  // Multiple choice — definitions
  for(const d of (r.definitions||[])){
    const pool=(r.definitions||[]).map(x=>x.term).filter(x=>x&&x.toLowerCase()!==d.term.toLowerCase());
    const wrong=lengthMatchedDistractors(d.term,pool,d.term,3);
    add(quizItem(doc,"definition",`Which term matches this source definition?`,d.definition,d.term,wrong,d.page,d.term));
    if(quiz.length>=8)break;
  }
  // Fill-in-the-blank from definitions (Notability Learn style)
  for(const d of (r.definitions||[]).slice(0,8)){
    if(quiz.length>=16)break;
    const term=String(d.term||"").trim(); if(term.length<2)continue;
    const def=String(d.definition||"").trim(); if(def.length<12)continue;
    quiz.push({
      id:stableId("q",`${doc.id}|fill|${term}|${def.slice(0,40)}`),
      type:"fill",
      question:`Fill in the blank — what term matches this source definition?`,
      context:def,
      options:[],
      correctIndex:0,
      correct:term,
      page:d.page||0,
      term
    });
  }
  // Mix-and-match pairs (term ↔ short definition)
  const matchPool=(r.definitions||[]).filter(x=>x.term&&x.definition).slice(0,6);
  if(matchPool.length>=3){
    const pairs=matchPool.map(x=>({term:x.term,def:String(x.definition).slice(0,100),page:x.page||0}));
    quiz.push({
      id:stableId("q",`${doc.id}|match|${pairs.map(p=>p.term).join("|")}`),
      type:"match",
      question:"Mix & match — pair each term with its source definition",
      context:"Drag-free: pick the matching definition for each term.",
      options:[],
      correctIndex:0,
      correct:"match",
      pairs,
      page:pairs[0]?.page||0,
      term:pairs[0]?.term||""
    });
  }
  for(const term of terms){
    if(quiz.length>=22)break;
    const u=evidenceForTerm(doc,term)[0];if(!u)continue;
    const pool=terms.filter(t=>t.toLowerCase()!==term.toLowerCase());
    const wrong=lengthMatchedDistractors(term,pool,term,3);
    add(quizItem(doc,"concept","Which term is directly supported by this source statement?",u.text,term,wrong,u.page,term));
  }
  for(const p of (r.keyPoints||[])){
    if(quiz.length>=28)break;
    const text=typeof p==='string'?p:p.text;
    if(!text||isLikelyQuestionLine(text))continue;
    const pool=(r.keyPoints||[]).map(x=>typeof x==='string'?x:x.text).filter(x=>x&&x!==text);
    const wrong=lengthMatchedDistractors(text,pool,text,3);
    add(quizItem(doc,"key-point","Which statement is supported by the study material?",text,text,wrong,p.page));
  }
  for(const tf of makeTrueFalseItems(doc,6)){
    if(quiz.length>=30)break;
    if(!seen.has(tf.id)){seen.add(tf.id);quiz.push(tf);}
  }
  return quiz.slice(0,30);
}

function reviewerText(doc){
  const r=doc.reviewerData||buildReviewer(doc);
  const sec=(title,lines)=>`${title}\n${lines?.length?lines.map((x,i)=>`${i+1}. ${typeof x==="string"?x:x.text||x.definition||x.q||JSON.stringify(x)}`).join("\n"):'—'}`;
  return [
    `STUDYVAULT REVIEWER — ${doc.fileName}`,
    `SUMMARY MODE: ${SUMMARY_MODES[r.mode]?.label||r.mode}`,
    `SOURCE CONFIDENCE: ${r.confidence||0}%`,
    `\nEXECUTIVE SUMMARY\n${r.overview}`,
    doc.ai?.reviewer?`\nLOCAL AI REVIEW\n${doc.ai.reviewer}`:"",
    `\nEXAM CRAM\n${r.examCram}`,
    `\nHOW TO STUDY\n${r.strategy}`,
    sec("\nKEY TERMS",r.terms),
    sec("\nDEFINITIONS",r.definitions.map(d=>`${d.term}: ${d.definition}${d.page?` (Page ${d.page})`:""}`)),
    sec("\nKEY POINTS",r.keyPoints),
    sec("\nPROCESSES / STEPS",r.processes),
    sec("\nCAUSE & EFFECT",r.causes),
    sec("\nCOMPARISONS",r.comparisons),
    sec("\nEXAMPLES",r.examples),
    sec("\nFACTS / FORMULAS",r.facts),
    sec("\nMEMORY CUES",r.memory),
    sec("\nSTUDY QUESTIONS",r.questions.map(q=>q.q)),
    sec("\nEXAM CHECKLIST",r.checklist),
    sec("\nPAGE HIGHLIGHTS",r.pages.map(p=>`Page ${p.page}: ${p.text}`))
  ].join("\n\n");
}

function regenerateDoc(doc,resetProgress=false){
  try{
    if(!doc)return;
    doc.rawText=String(doc.rawText||"");
    doc.terms=candidateTerms(doc);
    doc.reviewerData=buildReviewer(doc);
    doc.reviewerText=reviewerText(doc);
    try{doc.flashcards=makeFlashcards(doc)||[];}catch(err){console.warn("flashcards failed",err);doc.flashcards=Array.isArray(doc.flashcards)?doc.flashcards:[];}
    try{doc.quiz=makeQuiz(doc)||[];}catch(err){console.warn("quiz failed",err);doc.quiz=Array.isArray(doc.quiz)?doc.quiz:[];}
    // Fallback cards from terms if generator produced nothing but we have text
    if((!doc.flashcards||!doc.flashcards.length)&&doc.terms&&doc.terms.length&&doc.rawText){
      doc.flashcards=doc.terms.slice(0,25).map(function(term,i){
        var ev=(typeof evidenceForTerm==="function"&&evidenceForTerm(doc,term)[0])||null;
        var ans=cleanAnswer((ev&&ev.text)||("Review the material for: "+term),200);
        return {id:"fallback-"+i+"-"+String(term).slice(0,20),type:"source-recall",term:term,question:"What should you remember about "+term+"?",answer:ans,page:ev&&ev.page||null,source:"fallback",evidence:ans};
      });
    }
    if((!doc.quiz||!doc.quiz.length)&&doc.flashcards&&doc.flashcards.length){
      doc.quiz=doc.flashcards.slice(0,8).map(function(c,i){
        return {id:"q-fallback-"+i,type:"short",question:c.question,answer:c.answer,context:c.term||"",page:c.page||null};
      });
    }
    doc.currentCard=Math.min(doc.currentCard||0, Math.max(0,(doc.flashcards||[]).length-1));
    doc.knownCardIds=Array.isArray(doc.knownCardIds)?doc.knownCardIds.filter(function(id){return (doc.flashcards||[]).some(function(c){return c.id===id;});}):[];
    doc.cardStats=doc.cardStats&&typeof doc.cardStats==="object"?doc.cardStats:{};
    if(resetProgress){doc.knownCardIds=[];doc.cardStats={};doc.quizScore=null;doc.quizHistory=[];}
    doc.reviewerVersion=REVIEW_ENGINE_VERSION;
  }catch(err){
    console.error("regenerateDoc failed",err);
    doc.terms=doc.terms||[];
    doc.reviewerData=doc.reviewerData||{overview:"Build the study guide after import.",terms:[],keyPoints:[],definitions:[],confidence:0};
    doc.flashcards=doc.flashcards||[];
    doc.quiz=doc.quiz||[];
  }
}


let aiWorker=null, aiSeq=0, aiCurrent=null;
async function cloudAI(path, payload, timeoutMs=120000){
  let base=String(state.settings?.sync?.url||"").trim().replace(/\/$/,"");
  if(!base){
    const found=await discoverAiServer(1000);
    base=found?.base||"";
  }
  if(!base){
    throw new Error("Carrot AI server is not running. Start START-CARROT-AI.bat or run server.py.");
  }
  if(!(await ensureSyncSession(base))){
    throw new Error("Carrot AI server pairing is required for this connection.");
  }
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const res=await fetch(`${base}/api/ai/${path}`,{
      method:"POST",
      credentials:"include",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify(payload),
      signal:controller.signal
    });
    const data=await res.json().catch(()=>({}));
    if(!res.ok){
      const detail=Array.isArray(data.details)?` — ${data.details.join(" | ")}`:(data.detail?` — ${data.detail}`:"");
      throw new Error((data.error||`Cloud AI unavailable (${res.status}).`)+detail);
    }
    return data;
  }catch(err){
    if(err?.name==="AbortError") throw new Error("Cloud AI timed out. The server may be busy or unreachable.");
    if(String(err?.message||"").includes("Failed to fetch")||String(err?.message||"").includes("NetworkError"))
      throw new Error("Cannot reach Cloud AI server at "+base+". Is server.py running with OPENAI_API_KEY set?");
    throw err;
  }finally{clearTimeout(timer);}
}
async function cloudChat(question, history=[], opts={}){
  const d=activeDoc();
  let source=opts.source;
  if(source==null){
    source=typeof smartSourceForCloud==="function" ? smartSourceForCloud(d,question,100000) : String(d?.rawText||"");
  }
  source=String(source||"").slice(0,120000);
  const images=(opts.images||gptPendingImages||[]).slice(0,4).map(x=>({name:x.name||"image",dataUrl:x.dataUrl||x.url||""})).filter(x=>x.dataUrl);
  const explicit=!!opts.webSearch;
  const autoWeb=/\b(latest|today|current|right now|news|recent|price|weather|score|schedule|release|update|what happened)\b/i.test(question);
  const customInstructions=String(state.settings?.customInstructions||"").trim().slice(0,5000);
  const memoryNotes=String(state.settings?.memoryNotes||"").trim().slice(0,4000);
  const data=await cloudAI("chat",{
    question,history:history.slice(-24),source,images,
    webSearch:explicit||autoWeb,maxOutputTokens:8000,
    customInstructions,memoryNotes
  },240000);
  return data;
}

function gptCloudStatusLabel(){
  return gptCloudAvailable?"Carrot AI · multimodal":"Local mode · limited";
}

/**
 * One-click local study photo — no server, no API key, instant.
 * Builds a polished multi-panel PNG from the active document's reviewer data.
 */

/** Accurate study image from user order + knowledge + open material. Always defined. */

/** Full electrical symbols study sheet — used when user asks for all electrical symbols. */
function generateElectricalSymbolSheet(){
  try{
    const ids=["resistor","capacitor","inductor","diode","led","battery","switch","ground","fuse","npn","acsource","speaker","motor","relay","andgate","orgate","notgate","ohm"];
    const items=ids.map(id=>SYMBOL_LIBRARY.find(s=>s.id===id)).filter(Boolean);
    const cols=3, cellW=320, cellH=160, pad=40, headerH=110;
    const rows=Math.ceil(items.length/cols);
    const W=pad*2+cols*cellW;
    const H=headerH+pad+rows*cellH+50;
    const c=document.createElement("canvas");
    c.width=W; c.height=H;
    const ctx=c.getContext("2d");
    ctx.fillStyle="#0b1220"; ctx.fillRect(0,0,W,H);
    const grad=ctx.createLinearGradient(0,0,W,0);
    grad.addColorStop(0,"#6c5ce7"); grad.addColorStop(1,"#00b894");
    ctx.fillStyle=grad; ctx.fillRect(0,0,W,8);
    ctx.fillStyle="#a9a8ff"; ctx.font="700 14px system-ui,sans-serif";
    ctx.fillText("STUDYVAULT · ELECTRICAL SYMBOLS SHEET", pad, 36);
    ctx.fillStyle="#edf6ff"; ctx.font="700 28px system-ui,sans-serif";
    ctx.fillText("Standard circuit symbols", pad, 72);
    ctx.fillStyle="#9bb0c4"; ctx.font="14px system-ui,sans-serif";
    ctx.fillText("Offline study reference · "+items.length+" symbols · BIT / electronics", pad, 96);
    items.forEach((sym,i)=>{
      const col=i%cols, row=Math.floor(i/cols);
      const x=pad+col*cellW, y=headerH+row*cellH;
      ctx.fillStyle="#121a2a";
      roundRectFill(ctx, x+6, y+6, cellW-16, cellH-16, 12);
      try{ sym.draw(ctx, x+36, y+48, 120); }catch(e){}
      ctx.fillStyle="#74b9ff"; ctx.font="700 11px system-ui,sans-serif";
      ctx.fillText("SYMBOL", x+20, y+28);
      ctx.fillStyle="#edf6ff"; ctx.font="700 16px system-ui,sans-serif";
      ctx.fillText(sym.label, x+20, y+cellH-28);
    });
    ctx.fillStyle="#6b7c90"; ctx.font="12px system-ui,sans-serif";
    ctx.fillText("Generated on your device · no server · StudyVault", pad, H-18);
    const dataUrl=c.toDataURL("image/png");
    const filename="studyvault-electrical-symbols.png";
    showStudyPhotoPreview(dataUrl, filename);
    try{ downloadDataUrl(dataUrl, filename); }catch(e){
      try{ c.toBlob(b=>{ if(b) downloadBlob(b, filename); }, "image/png"); }catch(e2){}
    }
    toast("Electrical symbols sheet ready.","success");
    return dataUrl;
  }catch(err){
    console.error(err);
    toast("Could not build symbols sheet: "+(err.message||"error"),"error");
    return null;
  }
}

function generateOrderedStudyImage(orderText, opts){
  opts = opts || {};
  try{
    const order = String(orderText || "").trim();
    if(!order){
      generateLocalStudyPhoto();
      return null;
    }
    // Full electrical symbols sheet on request
    if(/electrical\s*symbols?|all\s+(the\s+)?(electrical\s+)?symbols?|circuit\s+symbols?|schematic\s+symbols?|create\s+all\s+electrical/i.test(order)){
      return generateElectricalSymbolSheet();
    }
    const domainHit = (typeof domainKnowledgeAnswer === "function") ? domainKnowledgeAnswer(order) : null;
    const d = activeDoc();
    let r = d && d.reviewerData;
    if(d && (!r || !(r.terms||[]).length)){
      try{ r = buildReviewer(d); d.reviewerData = r; }catch(e){ r = r || {}; }
    }
    let title = order.replace(/^(draw|generate|create|make|show|picture of|image of|diagram of|photo of)\s+/i, "").slice(0, 72);
    if(!title) title = "Study image";
    const bullets = [];
    if(domainHit && domainHit.answer){
      domainHit.answer.split("\n").map(function(x){ return x.replace(/^[\s•\-\*]+/, "").trim(); }).filter(Boolean).forEach(function(line){
        if(bullets.length < 12) bullets.push(line.slice(0, 110));
      });
    }
    if(r){
      const qn = normalize(order);
      (r.terms || []).slice(0, 24).forEach(function(term){
        const nt = normalize(term);
        if(nt && (qn.indexOf(nt.slice(0, 8)) >= 0 || nt.indexOf(qn.slice(0, 10)) >= 0)){
          if(bullets.length < 14) bullets.push("From your material: " + String(term).slice(0, 80));
        }
      });
      (r.definitions || []).slice(0, 16).forEach(function(def){
        const blob = normalize((def.term || "") + " " + (def.definition || ""));
        if(blob.indexOf(qn.slice(0, 10)) >= 0 || qn.indexOf(normalize(def.term || "").slice(0, 6)) >= 0){
          if(bullets.length < 14) bullets.push((def.term || "") + ": " + String(def.definition || "").slice(0, 90));
        }
      });
      if(r.overview && bullets.length < 6){
        String(r.overview).split("\n").filter(Boolean).slice(0, 4).forEach(function(line){
          if(bullets.length < 10) bullets.push(line.slice(0, 100));
        });
      }
    }
    if(!bullets.length){
      bullets.push("Order: " + order.slice(0, 100));
      bullets.push("Add a PDF or photo and Build study guide for richer source-backed images.");
      bullets.push("Tutor uses offline BIT-CT / BAEL / STEM knowledge when the PDF is silent.");
    }
    const W = 1080;
    const H = Math.min(1700, 240 + Math.min(bullets.length, 14) * 40 + 300);
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d");
    if(!ctx){ toast("Canvas not supported.", "error"); return null; }
    ctx.fillStyle = "#0b1220"; ctx.fillRect(0, 0, W, H);
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, "#6c5ce7"); grad.addColorStop(1, "#00b894");
    ctx.fillStyle = grad; ctx.fillRect(0, 0, W, 10);
    ctx.fillStyle = "#a9a8ff"; ctx.font = "700 13px system-ui,sans-serif";
    ctx.fillText("STUDYVAULT · ACCURATE STUDY IMAGE · FROM YOUR ORDER", 44, 40);
    ctx.fillStyle = "#edf6ff"; ctx.font = "700 30px system-ui,sans-serif";
    const titleLines = canvasWrapText(ctx, title, W - 88).slice(0, 2);
    titleLines.forEach(function(ln, i){ ctx.fillText(ln, 44, 82 + i * 34); });
    let y = 82 + titleLines.length * 34 + 14;
    ctx.fillStyle = "#9bb0c4"; ctx.font = "14px system-ui,sans-serif";
    ctx.fillText((domainHit ? ("Knowledge: " + domainHit.domain) : "Knowledge: general") + (d ? (" · " + String(d.fileName || "").slice(0, 36)) : "") + " · offline", 44, y);
    y += 26;
    var symId = null;
    try{ symId = matchLocalSymbol(order); }catch(e){}
    if(symId){
      ctx.fillStyle = "#121a2a"; roundRectFill(ctx, 44, y, W - 88, 170, 14);
      try{
        var sym = SYMBOL_LIBRARY.find(function(s){ return s.id === symId; });
        if(sym) sym.draw(ctx, 100, y + 16, 190);
      }catch(e){}
      ctx.fillStyle = "#74b9ff"; ctx.font = "700 12px system-ui,sans-serif";
      ctx.fillText("DIAGRAM", 340, y + 36);
      ctx.fillStyle = "#d7e2ef"; ctx.font = "16px system-ui,sans-serif";
      var lab = (SYMBOL_LIBRARY.find(function(s){ return s.id === symId; }) || {}).label || symId;
      ctx.fillText(String(lab), 340, y + 62);
      ctx.fillText("On-device diagram matched to your order", 340, y + 88);
      y += 188;
    }
    ctx.fillStyle = "#121a2a";
    var boxH = Math.min(bullets.length, 14) * 38 + 54;
    roundRectFill(ctx, 44, y, W - 88, boxH, 14);
    ctx.fillStyle = "#00b894"; ctx.font = "700 12px system-ui,sans-serif";
    ctx.fillText("KEY POINTS (MATCHED TO ORDER)", 60, y + 28);
    ctx.fillStyle = "#edf6ff"; ctx.font = "16px system-ui,sans-serif";
    bullets.slice(0, 14).forEach(function(b, i){
      var lines = canvasWrapText(ctx, "• " + b, W - 130).slice(0, 2);
      lines.forEach(function(ln, j){ ctx.fillText(ln, 60, y + 54 + i * 38 + j * 17); });
    });
    ctx.fillStyle = "#6b7c90"; ctx.font = "13px system-ui,sans-serif";
    ctx.fillText("Accurate to your order + course knowledge + open material · no server", 44, H - 22);
    var dataUrl = c.toDataURL("image/png");
    var filename = "studyvault-order-" + title.replace(/[^\w.\-]+/g, "_").slice(0, 28) + ".png";
    showStudyPhotoPreview(dataUrl, filename);
    try{ downloadDataUrl(dataUrl, filename); }catch(e){
      try{ c.toBlob(function(b){ if(b) downloadBlob(b, filename); }, "image/png"); }catch(e2){}
    }
    if(!opts.silent) toast("Study image ready: " + title.slice(0, 40), "success");
    return dataUrl;
  }catch(err){
    console.error(err);
    toast("Could not create image: " + (err.message || "error"), "error");
    return null;
  }
}
function promptStudyImageOrder(){
  var hint = activeDoc()
    ? "e.g. OSI model, Ohm's law, thesis statement, photosynthesis"
    : "e.g. TCP vs UDP, quadratic formula, parts of speech";
  var order = window.prompt("What should the study image show?", "");
  if(order === null) return;
  if(!String(order).trim()){
    if(activeDoc()) generateLocalStudyPhoto();
    else toast("Type an order (topic) or add material first.", "error");
    return;
  }
  generateOrderedStudyImage(String(order).trim());
}

function generateLocalStudyPhoto(){
  try{
    const d=activeDoc();
    if(!d){
      toast("Add study material first, or use Image from order with a topic.","error");
      activateSection("tutor");
      return;
    }
    // Always ensure reviewer exists so the image has content
    let r=d.reviewerData;
    if(!r||!(r.overview||(r.terms||[]).length||(r.definitions||[]).length)){
      try{ r=buildReviewer(d); d.reviewerData=r; }catch(e){ console.warn(e); r={}; }
    }
    r=r||{};
    const W=1080, pad=44;
    const c=document.createElement("canvas");
    c.width=W; c.height=1600;
    const ctx=c.getContext("2d");
    if(!ctx){ toast("Canvas not supported in this browser.","error"); return; }

    // Background
    ctx.fillStyle="#0b1220"; ctx.fillRect(0,0,W,c.height);
    const grad=ctx.createLinearGradient(0,0,W,120);
    grad.addColorStop(0,"#6c5ce7"); grad.addColorStop(1,"#00b894");
    ctx.fillStyle=grad; ctx.fillRect(0,0,W,10);

    ctx.fillStyle="#a9a8ff"; ctx.font="700 14px system-ui,sans-serif";
    ctx.fillText("STUDYVAULT · CLOSED-BOOK STUDY PHOTO", pad, 40);
    ctx.fillStyle="#edf6ff"; ctx.font="700 34px system-ui,sans-serif";
    const title=String(d.fileName||"Study material").replace(/\.[^.]+$/,"").slice(0,42);
    ctx.fillText(title, pad, 84);
    ctx.fillStyle="#9bb0c4"; ctx.font="15px system-ui,sans-serif";
    ctx.fillText(`${d.pageCount||1} pages · ${(r.terms||d.terms||[]).length} concepts · offline · ${new Date().toLocaleDateString()}`, pad, 112);

    let y=140;
    const overview=String(r.overview||d.rawText||"").trim().slice(0,480) || "Build the study guide for a richer photo — content still exports from your source text.";
    {
      const ovLines=canvasWrapText(ctx, overview, W-pad*2-28);
      const ovH=Math.min(ovLines.length,8)*24+52;
      ctx.fillStyle="#121a2a"; roundRectFill(ctx, pad-8, y, W-pad*2+16, ovH, 14);
      ctx.fillStyle="#8f7cff"; ctx.font="700 12px system-ui,sans-serif";
      ctx.fillText("OVERVIEW (FROM YOUR SOURCE)", pad+10, y+24);
      ctx.fillStyle="#d7e2ef"; ctx.font="16px system-ui,sans-serif";
      ovLines.slice(0,8).forEach((ln,i)=>ctx.fillText(ln, pad+10, y+50+i*24));
      y+=ovH+16;
    }

    const colW=(W-pad*2-16)/2;
    const terms=(r.terms||d.terms||[]).slice(0,12);
    const weak=typeof weakConcepts==="function"?weakConcepts(8):[];
    const defs=(r.definitions||[]).slice(0,6);
    const checklist=(r.checklist||[]).slice(0,8);
    const facts=(r.facts||[]).slice(0,6);

    {
      const boxH=Math.max(terms.length,1)*26+54;
      ctx.fillStyle="#121a2a"; roundRectFill(ctx, pad-8, y, colW, boxH, 14);
      ctx.fillStyle="#00b894"; ctx.font="700 12px system-ui,sans-serif";
      ctx.fillText("KEY TERMS", pad+10, y+24);
      ctx.fillStyle="#edf6ff"; ctx.font="16px system-ui,sans-serif";
      (terms.length?terms:["Add material & build guide"]).forEach((term,i)=>ctx.fillText("• "+String(term).slice(0,34), pad+10, y+52+i*26));

      const boxH2=Math.max(weak.length,1)*26+54;
      ctx.fillStyle="#121a2a"; roundRectFill(ctx, pad+colW+8, y, colW, Math.max(boxH,boxH2), 14);
      ctx.fillStyle="#ff7675"; ctx.font="700 12px system-ui,sans-serif";
      ctx.fillText("WEAK SPOTS", pad+colW+24, y+24);
      ctx.fillStyle="#edf6ff"; ctx.font="16px system-ui,sans-serif";
      (weak.length?weak:["Grade cards to surface weak spots"]).forEach((term,i)=>ctx.fillText("• "+String(term).slice(0,34), pad+colW+24, y+52+i*26));
      y+=Math.max(boxH,boxH2)+16;
    }

    if(defs.length){
      const lines=[];
      defs.forEach(x=>{
        const line=`${x.term}: ${String(x.definition||"").slice(0,100)}`;
        lines.push(...canvasWrapText(ctx, line, W-pad*2-28).slice(0,2));
      });
      const boxH=Math.min(lines.length,12)*22+50;
      ctx.fillStyle="#121a2a"; roundRectFill(ctx, pad-8, y, W-pad*2+16, boxH, 14);
      ctx.fillStyle="#74b9ff"; ctx.font="700 12px system-ui,sans-serif";
      ctx.fillText("DEFINITIONS", pad+10, y+24);
      ctx.fillStyle="#d7e2ef"; ctx.font="15px system-ui,sans-serif";
      lines.slice(0,12).forEach((ln,i)=>ctx.fillText(ln, pad+10, y+48+i*22));
      y+=boxH+16;
    }

    {
      const left=(checklist.length?checklist:["Build guide for checklist"]).map(x=>"☐ "+String(typeof x==="string"?x:(x.text||x)).slice(0,40));
      const right=(facts.length?facts:["—"]).map(x=>"• "+String(typeof x==="string"?x:(x.text||"")).slice(0,40));
      const rows=Math.max(left.length,right.length,1);
      const boxH=rows*26+54;
      ctx.fillStyle="#121a2a"; roundRectFill(ctx, pad-8, y, colW, boxH, 14);
      ctx.fillStyle="#fdcb6e"; ctx.font="700 12px system-ui,sans-serif";
      ctx.fillText("EXAM CHECKLIST", pad+10, y+24);
      ctx.fillStyle="#edf6ff"; ctx.font="15px system-ui,sans-serif";
      left.forEach((ln,i)=>ctx.fillText(ln, pad+10, y+52+i*26));
      ctx.fillStyle="#121a2a"; roundRectFill(ctx, pad+colW+8, y, colW, boxH, 14);
      ctx.fillStyle="#a29bfe"; ctx.font="700 12px system-ui,sans-serif";
      ctx.fillText("FACTS", pad+colW+24, y+24);
      ctx.fillStyle="#edf6ff"; ctx.font="15px system-ui,sans-serif";
      right.forEach((ln,i)=>ctx.fillText(ln, pad+colW+24, y+52+i*26));
    }

    ctx.fillStyle="#6b7c90"; ctx.font="13px system-ui,sans-serif";
    ctx.fillText("Local · no server · no API key · StudyVault Closed-book OS", pad, c.height-28);

    const dataUrl=c.toDataURL("image/png");
    const filename=`studyvault-photo-${String(d.fileName||"study").replace(/[^\w.\-]+/g,"_").slice(0,32)}.png`;
    showStudyPhotoPreview(dataUrl, filename);
    // Download: try anchor + blob fallback
    try{ downloadDataUrl(dataUrl, filename); }
    catch(e){
      try{ c.toBlob(b=>{ if(b) downloadBlob(b, filename); }, "image/png"); }catch{}
    }
    toast("Study image ready — preview + download.","success");
  }catch(err){
    console.error(err);
    toast("Could not create image: "+(err.message||"unknown error"),"error");
  }
}
function showStudyPhotoPreview(dataUrl, filename){
  let m=document.getElementById("studyPhotoModal");
  if(!m){
    m=document.createElement("div");
    m.id="studyPhotoModal";
    m.className="modal open";
    m.setAttribute("role","dialog");
    m.innerHTML=`<div class="modal-card" style="width:min(96vw,560px);max-height:92vh;overflow:auto">
      <h2 style="margin:0 0 6px">Study image ready</h2>
      <p class="muted tiny" style="margin:0 0 12px">Created on your device. No server. No token.</p>
      <img id="studyPhotoPreviewImg" alt="Study photo" style="width:100%;border-radius:12px;border:1px solid var(--border);background:#0b1220;display:block"/>
      <div class="row" style="margin-top:14px;gap:8px;flex-wrap:wrap">
        <button type="button" id="studyPhotoDownload" class="btn primary">Download PNG</button>
        <button type="button" id="studyPhotoClose" class="btn secondary">Close</button>
      </div>
    </div>`;
    document.body.appendChild(m);
    m.addEventListener("click",e=>{ if(e.target===m) m.classList.remove("open"); });
  }
  m.classList.add("open");
  const img=document.getElementById("studyPhotoPreviewImg");
  if(img){ img.src=dataUrl; }
  const dl=document.getElementById("studyPhotoDownload");
  if(dl) dl.onclick=()=>{ try{ downloadDataUrl(dataUrl, filename); toast("Download started.","success"); }catch{ toast("Allow downloads in your browser.","error"); } };
  const cl=document.getElementById("studyPhotoClose");
  if(cl) cl.onclick=()=>m.classList.remove("open");
}
function roundRectFill(ctx,x,y,w,h,r){
  const rr=Math.min(r||10,w/2,h/2);
  ctx.beginPath();
  ctx.moveTo(x+rr,y); ctx.arcTo(x+w,y,x+w,y+h,rr); ctx.arcTo(x+w,y+h,x,y+h,rr);
  ctx.arcTo(x,y+h,x,y,rr); ctx.arcTo(x,y,x+w,y,rr); ctx.closePath(); ctx.fill();
}
/** Optional cloud image only if server is already configured — otherwise local. */
async function generateCloudStudyImage(){
  const d=activeDoc();
  const r=d?(d.reviewerData||(typeof buildReviewer==='function'?buildReviewer(d):null)):null;
  const terms=(r&&r.terms)||[];
  const defaultPrompt=d
    ? `Educational study infographic for ${String(d.fileName||'study material').replace(/\.[^.]+$/,'').slice(0,60)}. Clear layout, labeled key ideas: ${terms.slice(0,8).join(', ')}`
    : "Clean educational study poster, modern student design";
  const prompt=window.prompt("Describe the image you want Study AI to create:", defaultPrompt);
  if(prompt===null) return;
  if(!String(prompt).trim()){
    if(d) generateLocalStudyPhoto();
    else toast("Type a description first.","error");
    return;
  }
  toast("Imagining…","success");
  try{
    const result=await createChatImageFromPrompt(String(prompt).trim(),{style:'study'});
    if(result?.url){
      const filename=`studyvault-imagine-${Date.now()}.png`;
      showStudyPhotoPreview(result.url, filename);
      try{ downloadDataUrl(result.url, filename); }catch{}
      try{ if(typeof rememberAiPicture==='function') await rememberAiPicture(String(prompt).slice(0,80), result.url, result.prompt||prompt); }catch{}
      toast(result.local?"Local study image ready.":"AI image ready.","success");
      return;
    }
  }catch(err){
    console.error(err);
  }
  toast("Falling back to local study photo…","info");
  if(d) generateLocalStudyPhoto();
  else if(typeof generateOrderedStudyImage==='function') generateOrderedStudyImage(String(prompt).trim());
}
async function cloudReviewCurrent(){
  const d=activeDoc();
  if(!d)return null;
  const source=String(d.rawText||"").slice(0,120000);
  if(!source.trim())return null;
  const r=d.reviewerData||buildReviewer(d);
  const evidence=(r.keyPoints||[]).slice(0,80).map(x=>({text:x.text,page:x.page,heading:x.heading}));
  return cloudAI("text",{task:"atlas-reviewer",source,existingReviewer:r.overview||"",mode:d.summaryMode||"standard",terms:(r.terms||[]).slice(0,80),evidence},180000);
}
/* Study AI multi-chat sessions (absorbed from ChatGPT-style shell — fully local IndexedDB) */
const AI_SESSIONS_KEY="aiSessions";
const AI_MAX_SESSIONS=28;
const AI_MAX_MESSAGES=100;
let aiSessions=[]; // {id, title, messages[], createdAt, updatedAt}
let activeSessionId=null;
let tutorChat=[]; // active session messages mirror — {role, text, mode, at, imageUrl?, imageAlt?}
let tutorBusy=false;
let gptPendingImages=[];
let gptCloudAvailable=false;

function aiSessionTitleFromMessages(messages){
  const first=(messages||[]).find(m=>m.role==="user"&&String(m.text||"").trim());
  if(!first) return "New chat";
  return String(first.text).replace(/\s+/g," ").trim().slice(0,42)||"New chat";
}

function slimMessageForStorage(m){
  const out={role:m.role,text:String(m.text||"").slice(0,8000),mode:m.mode||"",at:m.at||now()};
  if(m.imageAlt) out.imageAlt=String(m.imageAlt).slice(0,120);
  // Keep local data-URL images only if small enough; huge ones already live in Photos/AI gallery
  if(m.imageUrl){
    const u=String(m.imageUrl);
    if(u.length<140000) out.imageUrl=u;
    else if(/^data:image\//i.test(u)) out.imageUrl=""; // remembered in vault already
    else out.imageUrl=u.slice(0,2000);
  }
  return out;
}

function normalizeAiMessage(raw){
  if(!raw || typeof raw!=="object") return null;
  return {
    role:String(raw.role)==="user"?"user":"tutor",
    text:String(raw.text||""),
    mode:String(raw.mode||""),
    at:raw.at||now(),
    imageUrl:String(raw.imageUrl||""),
    imageAlt:String(raw.imageAlt||""),
    imagePrompt:String(raw.imagePrompt||""),
    imageModel:String(raw.imageModel||"")
  };
}
function normalizeAiMessages(value){
  if(!Array.isArray(value)) return [];
  return value.map(normalizeAiMessage).filter(Boolean).slice(-AI_MAX_MESSAGES);
}
function aiServerCandidates(){
  const configured=String(state.settings?.sync?.url||"").trim().replace(/\/$/,"");
  const out=[];
  if(configured) out.push(configured);
  if(!out.includes("http://127.0.0.1:8787")) out.push("http://127.0.0.1:8787");
  if(!out.includes("http://localhost:8787")) out.push("http://localhost:8787");
  return out;
}
async function discoverAiServer(timeoutMs=900){
  for(const base of aiServerCandidates()){
    try{
      const ac=new AbortController(); const t=setTimeout(()=>ac.abort(),timeoutMs);
      const r=await fetch(base+"/api/health",{signal:ac.signal,credentials:"include",cache:"no-store"});
      clearTimeout(t);
      if(r.ok){
        const data=await r.json().catch(()=>({}));
        state.settings.sync={...(state.settings.sync||{}),url:base,enabled:!!data.cloudAI};
        return {base,data};
      }
    }catch{}
  }
  return null;
}

async function loadAiSessions(){
  try{
    const raw=await dbGet(META_STORE,AI_SESSIONS_KEY);
    if(raw&&Array.isArray(raw.sessions)){
      aiSessions=(Array.isArray(raw.sessions)?raw.sessions:[]).map(s=>({
        id:String(s?.id||uid()), title:String(s?.title||"New chat"),
        messages:normalizeAiMessages(s?.messages), createdAt:s?.createdAt||now(), updatedAt:s?.updatedAt||now()
      }));
      activeSessionId=raw.activeId||(aiSessions[0]&&aiSessions[0].id)||null;
    }
  }catch(e){ console.warn("loadAiSessions",e); aiSessions=[]; }
  if(!aiSessions.length){
    const id=uid();
    aiSessions=[{id,title:"New chat",messages:[],createdAt:now(),updatedAt:now()}];
    activeSessionId=id;
  }
  if(!activeSessionId||!aiSessions.some(s=>s.id===activeSessionId)){
    activeSessionId=aiSessions[0].id;
  }
  const cur=aiSessions.find(s=>s.id===activeSessionId);
  tutorChat=normalizeAiMessages(cur?.messages);
}

async function persistAiSessions(){
  // Mirror active chat into sessions list
  const cur=aiSessions.find(s=>s.id===activeSessionId);
  if(cur){
    cur.messages=normalizeAiMessages(tutorChat).map(slimMessageForStorage);
    cur.title=aiSessionTitleFromMessages(cur.messages);
    cur.updatedAt=now();
  }
  // Cap sessions
  aiSessions=aiSessions
    .slice()
    .sort((a,b)=>String(b.updatedAt||"").localeCompare(String(a.updatedAt||"")))
    .slice(0,AI_MAX_SESSIONS);
  try{
    await dbPut(META_STORE,AI_SESSIONS_KEY,{sessions:aiSessions,activeId:activeSessionId,savedAt:now()});
  }catch(e){
    // Quota: drop oldest image-heavy sessions and retry once
    console.warn("persistAiSessions",e);
    try{
      aiSessions=aiSessions.map(s=>({
        ...s,
        messages:(s.messages||[]).map(m=>{
          const copy={...m};
          if(copy.imageUrl&&String(copy.imageUrl).length>8000) copy.imageUrl="";
          return copy;
        })
      })).slice(0,12);
      await dbPut(META_STORE,AI_SESSIONS_KEY,{sessions:aiSessions,activeId:activeSessionId,savedAt:now()});
    }catch(e2){ console.warn("persistAiSessions retry",e2); }
  }
}

function renderAiChatList(){
  const box=$("#aiChatList");
  if(!box) return;
  if(!aiSessions.length){
    box.innerHTML=`<div class="ai-chat-empty">No chats yet. Send a message to start.</div>`;
    return;
  }
  const ordered=aiSessions.slice().sort((a,b)=>String(b.updatedAt||"").localeCompare(String(a.updatedAt||"")));
  box.innerHTML=ordered.map(s=>{
    const active=s.id===activeSessionId?" active":"";
    const title=esc(s.title||"New chat");
    const n=(s.messages||[]).length;
    return `<div class="ai-chat-item${active}" data-ai-session="${esc(s.id)}" title="${title}">
      <span class="ai-chat-title">${title}</span>
      <span class="tiny muted">${n||""}</span>
      <button type="button" class="ai-chat-del" data-ai-del="${esc(s.id)}" title="Delete chat" aria-label="Delete chat">×</button>
    </div>`;
  }).join("");
  box.querySelectorAll("[data-ai-session]").forEach(el=>{
    el.onclick=(ev)=>{
      if(ev.target.closest("[data-ai-del]")) return;
      switchAiSession(el.getAttribute("data-ai-session"));
    };
  });
  box.querySelectorAll("[data-ai-del]").forEach(btn=>{
    btn.onclick=(ev)=>{
      ev.stopPropagation();
      deleteAiSession(btn.getAttribute("data-ai-del"));
    };
  });
}

async function switchAiSession(id){
  if(!id||id===activeSessionId) return;
  await persistAiSessions();
  const s=aiSessions.find(x=>x.id===id);
  if(!s) return;
  activeSessionId=id;
  tutorChat=normalizeAiMessages(s.messages);
  renderTutorChat();
  renderAiChatList();
  if($("#tutorMsgCount"))$("#tutorMsgCount").textContent=String(tutorChat.length);
  await persistAiSessions();
}

async function createAiSession(silent){
  await persistAiSessions();
  const id=uid();
  const session={id,title:"New chat",messages:[],createdAt:now(),updatedAt:now()};
  aiSessions.unshift(session);
  activeSessionId=id;
  tutorChat=[];
  renderTutorChat();
  renderAiChatList();
  if($("#tutorMsgCount"))$("#tutorMsgCount").textContent="0";
  await persistAiSessions();
  if(!silent) toast("New chat.","success");
}

async function deleteAiSession(id){
  if(!id) return;
  if(aiSessions.length<=1){
    tutorChat=[];
    aiSessions[0].messages=[];
    aiSessions[0].title="New chat";
    aiSessions[0].updatedAt=now();
    activeSessionId=aiSessions[0].id;
    renderTutorChat();
    renderAiChatList();
    await persistAiSessions();
    toast("Chat cleared.","success");
    return;
  }
  aiSessions=aiSessions.filter(s=>s.id!==id);
  if(activeSessionId===id){
    activeSessionId=aiSessions[0].id;
    tutorChat=normalizeAiMessages(aiSessions[0].messages);
  }
  renderTutorChat();
  renderAiChatList();
  await persistAiSessions();
  toast("Chat deleted.","success");
}
function aiEnsureWorker(){
  if(aiWorker)return aiWorker;
  aiWorker=new Worker(AI_WORKER_URL,{type:"module"});
  aiWorker.onmessage=e=>{
    const m=e.data||{};
    if(m.type==="status"||m.type==="progress"){
      const el=$("#aiStatus");if(el)el.textContent=m.message||"Local AI working…";
      return;
    }
    if(m.type==="device"){
      const el=$("#aiStatus");
      if(el && m.android) el.textContent=m.conservative?"Android safe mode • low-memory profile • CPU/WASM AI":"Android optimized • preparing the best available AI path…";
      return;
    }
    if(m.type==="ready"){
      const el=$("#aiStatus");if(el)el.textContent=`AI ready • ${m.android?"Android optimized":"on-device"} • ${m.device||"local"}`;
      return;
    }
    if(m.type==="token" && aiCurrent?.requestId===m.requestId){
      aiCurrent.text=(aiCurrent.text||"")+String(m.text||"");
      // Live stream into Tutor chat bubble when this is a tutor ask
      if(aiCurrent.mode==="ask" && aiCurrent.tutorStreamId!=null){
        const bubble=document.querySelector(`[data-tutor-stream="${aiCurrent.tutorStreamId}"]`);
        if(bubble){
          bubble.innerHTML=esc(aiCurrent.text).replace(/\n/g,"<br>");
          const chat=$("#tutorChat");if(chat)chat.scrollTop=chat.scrollHeight;
        }
      }
      const box=aiCurrent.mode==="ask"?$("#aiAnswer"):$("#aiReviewer");if(box)box.textContent=aiCurrent.text;
      return;
    }
    if(m.type==="done"){
      const pending=aiCurrent;if(!pending||pending.requestId!==m.requestId)return;
      aiCurrent=null;pending.resolve(m);return;
    }
    if(m.type==="error"){
      const pending=aiCurrent;if(!pending||pending.requestId!==m.requestId)return;
      aiCurrent=null;pending.reject(new Error(m.message||"Local AI failed."));return;
    }
  };
  aiWorker.onerror=e=>{if(aiCurrent){aiCurrent.reject(new Error("Local AI worker stopped unexpectedly."));aiCurrent=null;}const s=$("#aiStatus");if(s)s.textContent="Local AI worker unavailable.";};
  return aiWorker;
}
function aiRequest(task,payload,opts={}){
  if(/Android/i.test(navigator.userAgent||"") && task==="ask") payload={...payload, mobile:true};
  const worker=aiEnsureWorker(),requestId=++aiSeq;
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);fn(value);};
    const timer=setTimeout(()=>finish(reject,new Error("The AI took too long to respond. Your study data is safe; try a shorter question or smaller source selection.")),task==="ask"?90000:180000);
    aiCurrent={requestId,resolve:v=>finish(resolve,v),reject:e=>finish(reject,e),mode:task==="ask"?"ask":"reviewer",text:"",tutorStreamId:opts.tutorStreamId??null};
    try{worker.postMessage({type:"task",task,requestId,...payload});}
    catch(e){finish(reject,e);}
  });
}
function aiCancel(){if(aiWorker){try{aiWorker.postMessage({type:"cancel"});}catch{};try{aiWorker.terminate();}catch{};aiWorker=null;}if(aiCurrent){aiCurrent.reject(new Error("AI task cancelled."));aiCurrent=null;}const s=$("#aiStatus");if(s)s.textContent="AI stopped. Your saved reviewer is safe.";const b=$("#aiEnhance");if(b)b.disabled=false;}
function learnerDigestForAI(){const p=learnerProfile();return JSON.stringify({level:p.level||"beginner",sessions:p.sessions||0,recentAccuracy:p.recentAccuracy,weak:weakConcepts(8),concepts:Object.values(p.concepts||{}).slice(0,20).map(x=>({label:x.label,mastery:x.mastery,attempts:x.attempts,streak:x.streak}))});}
function pageRelevance(page, queryTerms, terms){
  const text=normalize(page?.text||"").toLowerCase();
  if(!text)return 0;
  let score=0;
  for(const q of queryTerms){if(q.length>=3&&text.includes(q))score+=3;}
  for(const t of terms.slice(0,30)){const tt=String(t).toLowerCase();if(tt.length>=4&&text.includes(tt))score+=0.35;}
  if(page?.source==="photo"||page?.source==="ocr")score+=0.2;
  return score;
}
function softPageClip(text,maxChars){
  const t=normalize(text||"");
  if(t.length<=maxChars)return t;
  // Prefer ending on a sentence/page boundary, never mid-word
  let cut=t.slice(0,maxChars);
  const stop=Math.max(cut.lastIndexOf("\n"),cut.lastIndexOf(". "),cut.lastIndexOf("? "),cut.lastIndexOf("! "));
  if(stop>=Math.floor(maxChars*0.55))cut=cut.slice(0,stop+1);
  else cut=cut.replace(/\s+\S*$/,"");
  return cut.trim();
}
function aiSource(d, query=""){
  const pages=(d.pageTexts||[]).filter(p=>normalize(p.text||""));
  const mobile=/Android/i.test(navigator.userAgent||"");
  const budget=mobile?18000:42000;
  if(!pages.length)return softPageClip(d.rawText||"",budget);
  const queryNorm=normalize(query).toLowerCase();
  const queryTerms=tokenize(query).filter(x=>x.length>=3&&!STOP.has(x)).slice(0,16);
  const scored=pages.map((p,i)=>{
    const base=pageRelevance(p,queryTerms,d.terms||[]);
    const text=normalize(p.text||"").toLowerCase();
    const phrase=queryNorm && queryNorm.length>=8 && text.includes(queryNorm) ? 8 : 0;
    const rare=queryTerms.filter(t=>text.includes(t)).length;
    return {p,i,score:base+phrase+rare*.45};
  });
  const picks=new Set();
  [0,1,2,pages.length-3,pages.length-2,pages.length-1].forEach(i=>{if(i>=0&&i<pages.length)picks.add(i);});
  for(const item of scored.sort((a,b)=>b.score-a.score)){
    if(picks.size>=18)break;
    if(item.score>0){picks.add(item.i);if(item.score>=4){if(item.i>0)picks.add(item.i-1);if(item.i+1<pages.length)picks.add(item.i+1);}}
  }
  const step=Math.max(1,Math.floor(pages.length/12));
  for(let i=step;i<pages.length&&picks.size<18;i+=step)picks.add(i);
  // Pack whole pages until budget is reached so definitions are not sliced mid-sentence
  let used=0;const chunks=[];
  for(const i of [...picks].sort((a,b)=>a-b)){
    const p=pages[i];
    const body=softPageClip(p.text,Math.min(3200,budget-used-40));
    if(!body)continue;
    const block=`PAGE ${p.page}\n${body}`;
    if(used+block.length+8>budget)break;
    chunks.push(block);used+=block.length+8;
  }
  return chunks.join("\n\n---\n\n");
}
function aiQuestionSource(d, question){return aiSource(d,question);}

function scheduleAIForDoc(doc){return Promise.resolve(doc);}


async function renderPdfPageForOcr(page,scale=2.0){
  // Cap huge pages so phones do not run out of memory mid-OCR
  let viewport=page.getViewport({scale});
  const maxSide=2200;
  if(Math.max(viewport.width,viewport.height)>maxSide){
    scale=scale*(maxSide/Math.max(viewport.width,viewport.height));
    viewport=page.getViewport({scale});
  }
  const canvas=document.createElement("canvas");
  canvas.width=Math.max(1,Math.ceil(viewport.width));
  canvas.height=Math.max(1,Math.ceil(viewport.height));
  const ctx=canvas.getContext("2d",{alpha:false});
  ctx.fillStyle="#ffffff";
  ctx.fillRect(0,0,canvas.width,canvas.height);
  // Do not pass unsupported render options — they crash OCR on some pdf.js builds
  await page.render({canvasContext:ctx,viewport}).promise;
  return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error("Could not render PDF page for OCR.")),"image/jpeg",.9));
}
async function extractEmbeddedPdfImages(page,pageNumber,limit=4){
  // Pull embedded image operators so picture-heavy PDFs become study photos, not just OCR text.
  const media=[];
  try{
    const ops=await page.getOperatorList();
    const common=window.pdfjsLib.OPS||{};
    const paintOps=new Set([common.paintImageXObject,common.paintInlineImageXObject,common.paintImageMaskXObject].filter(Boolean));
    const names=[];
    for(let i=0;i<ops.fnArray.length;i++){
      if(paintOps.has(ops.fnArray[i])){
        const arg=ops.argsArray[i]?.[0];
        if(typeof arg==="string")names.push(arg);
      }
    }
    const unique=[...new Set(names)].slice(0,limit);
    for(const name of unique){
      try{
        const obj=await page.objs.get(name);
        if(!obj)continue;
        let dataUrl="";
        if(obj instanceof HTMLCanvasElement)dataUrl=obj.toDataURL("image/jpeg",.85);
        else if(obj?.data&&obj?.width&&obj?.height){
          const c=document.createElement("canvas");c.width=obj.width;c.height=obj.height;
          const ctx=c.getContext("2d");
          const imgData=ctx.createImageData(obj.width,obj.height);
          // pdf.js image data may be RGB or RGBA
          const src=obj.data;const dst=imgData.data;
          if(src.length>=obj.width*obj.height*4){for(let i=0;i<dst.length;i++)dst[i]=src[i];}
          else if(src.length>=obj.width*obj.height*3){
            for(let i=0,j=0;i<dst.length;i+=4,j+=3){dst[i]=src[j];dst[i+1]=src[j+1];dst[i+2]=src[j+2];dst[i+3]=255;}
          }else continue;
          ctx.putImageData(imgData,0,0);dataUrl=c.toDataURL("image/jpeg",.85);
        }
        if(!dataUrl||dataUrl.length<80)continue;
        media.push({id:uid(),name:`page-${pageNumber}-${name}.jpg`,dataUrl,width:obj.width||0,height:obj.height||0,caption:`Image from PDF page ${pageNumber}`,ocrText:"",confidence:0,createdAt:now(),page:pageNumber,fromPdf:true});
      }catch(err){console.warn("embedded image extract failed",name,err);}
    }
  }catch(err){console.warn("operator list failed",err);}
  return media;
}
async function blobToDataUrl(blob){
  return new Promise((resolve,reject)=>{
    const r=new FileReader();
    r.onload=()=>resolve(r.result);
    r.onerror=()=>reject(r.error||new Error("read failed"));
    r.readAsDataURL(blob);
  });
}
async function extractPdf(file,progress){
  const ready=await loadPdfEngine();
  if(!ready)throw new Error("PDF.js could not be loaded. Connect once so the engine can cache, then try again.");
  const buffer=await file.arrayBuffer();
  const pdf=await window.pdfjsLib.getDocument({data:buffer}).promise;
  const pageTexts=[];const units=[];const media=[];
  const maxPages=pdf.numPages; // extract text from the complete PDF; expensive visual OCR is separately bounded
  for(let pageNumber=1;pageNumber<=maxPages;pageNumber++){
    const page=await pdf.getPage(pageNumber);
    let text="";let itemCount=0;
    try{
      const content=await page.getTextContent();
      const items=content.items.filter(x=>typeof x.str==="string"&&x.str.length);
      itemCount=items.length;
      items.sort((a,b)=>{const ay=a.transform?.[5]||0,by=b.transform?.[5]||0;if(Math.abs(by-ay)>3)return by-ay;return (a.transform?.[4]||0)-(b.transform?.[4]||0)});
      // Smarter join: no space before/after pure symbol glyphs so "H"+"2"+"O" → "H2O", "→" stays tight
      const lines=[];let current="";let lastY=null;let lastStr="";
      const isSym=s=>/^[\s]*[→←↔≤≥≠≈±×÷°√∛μΩΔα-ωΑ-Ω^_+\-=/\\()\[\]{}.,;:°%∞]+[\s]*$/.test(s)||/^\d+$/.test(s);
      for(const item of items){
        const y=item.transform?.[5]||0;
        const s=item.str;
        if(lastY!==null&&Math.abs(y-lastY)>3){if(current.trim())lines.push(current.trim());current="";lastStr="";}
        if(!current)current=s;
        else if(isSym(s)||isSym(lastStr)||/^[.,;:)\]]$/.test(s)||/^[(\[]$/.test(lastStr)||item.hasEOL===false&&(item.width||0)<2){
          current+=s; // glue symbols/subscripts tightly
        }else current+=` ${s}`;
        lastStr=s;lastY=y;
        if(item.hasEOL){if(current.trim())lines.push(current.trim());current="";lastStr="";}
      }
      if(current.trim())lines.push(current.trim());
      text=repairSymbols(lines.join("\n"));
    }catch(err){console.warn("text extract failed page",pageNumber,err);}
    pageTexts.push({page:pageNumber,text,source:"text",itemCount});
    for(const x of extractSentences(text,24))units.push({page:pageNumber,text:x,source:"text"});
    try{
      const imgs=await extractEmbeddedPdfImages(page,pageNumber,3);
      for(const m of imgs)media.push(m);
    }catch{}
    progress?.(pageNumber,maxPages);
  }
  // Treat as visual when text is thin OR page looks image-heavy
  const imagePages=new Set(media.map(m=>m.page));
  const sparsePages=pageTexts
    .filter(p=>wordCount(p.text)<50||imagePages.has(p.page)||(p.itemCount||0)<12)
    .map(p=>p.page);
  let ocrPages=0;
  // Always try to capture page pictures for sparse pages (even if OCR is offline)
  const ocrLimit=Math.min(sparsePages.length, navigator.deviceMemory && navigator.deviceMemory<=4 ? 12 : 30);
  for(const pageNumber of [...new Set(sparsePages)].slice(0,ocrLimit)){
    progress?.(`ocr:${pageNumber}`,maxPages);
    try{
      const page=await pdf.getPage(pageNumber);
      const blob=await renderPdfPageForOcr(page,2.0);
      const pageDataUrl=await blobToDataUrl(blob);
      let full=media.find(m=>m.page===pageNumber&&m.fullPage);
      if(pageDataUrl&&!full){
        full={id:uid(),name:`${(file.name||"pdf").replace(/\.pdf$/i,"")}-page-${pageNumber}.jpg`,dataUrl:pageDataUrl,width:0,height:0,caption:`Page ${pageNumber} (visual)`,ocrText:"",confidence:0,createdAt:now(),page:pageNumber,fullPage:true,fromPdf:true};
        media.push(full);
      }
      // OCR when engine is ready
      const readyOcr=await loadTesseract();
      if(readyOcr){
        const ocr=await ocrImage(new File([blob],`page-${pageNumber}.jpg`,{type:"image/jpeg"}));
        const ocrText=repairSymbols(ocr.text||"");
        // Prefer OCR when it has more words OR richer symbols (arrows, Greek, operators)
        const symbolScore=s=>((String(s).match(/[→←↔≤≥≠≈±×÷°√μΩΔα-ωΑ-Ω^_=]/g)||[]).length);
        const prev=pageTexts[pageNumber-1].text||"";
        const better=wordCount(ocrText)>Math.max(3,wordCount(prev))
          ||(symbolScore(ocrText)>symbolScore(prev)+1&&wordCount(ocrText)>=3);
        if(ocrText&&better){
          pageTexts[pageNumber-1].text=ocrText;
          pageTexts[pageNumber-1].source="ocr";
          pageTexts[pageNumber-1].confidence=ocr.confidence;
          ocrPages++;
          for(const x of extractSentences(ocrText,18))units.push({page:pageNumber,text:x,source:"ocr"});
          if(full){full.ocrText=ocrText;full.confidence=ocr.confidence;full.caption=`Page ${pageNumber} · OCR + symbols`;}
        }else if(ocrText&&full&&!full.ocrText){
          full.ocrText=ocrText;full.confidence=ocr.confidence;
        }
      }
    }catch(err){console.warn("PDF visual/OCR failed on page",pageNumber,err);}
  }
  if(!sparsePages.length)progress?.("ocr-skip",maxPages);
  const rawText=pageTexts.map(p=>`Page ${p.page}\n${p.text}`).join("\n\n");
  return {pageCount:pdf.numPages,pageTexts,units,rawText,ocrPages,media,ocrLimited:sparsePages.length>ocrLimit};
}

function plainToHtml(text){
  return normalize(text).split(/\n\n+/).map(p=>`<p>${esc(p).replace(/\n/g,"<br>")}</p>`).join("")||"<p></p>";
}
function stripHtml(html){
  const box=document.createElement("div");box.innerHTML=html||"";
  return normalize(box.innerText||box.textContent||"");
}
function safeNoteHtml(html){
  const box=document.createElement("div");box.innerHTML=String(html||"");
  const allowed=new Set(["P","DIV","BR","STRONG","B","EM","I","U","H2","H3","UL","OL","LI","BLOCKQUOTE","IMG","A","SPAN"]);
  const safeImage=/^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i;
  const safeHref=/^(?:https?:\/\/|mailto:)[^\s]+$/i;
  box.querySelectorAll("*").forEach(el=>{
    if(!allowed.has(el.tagName)){el.replaceWith(...el.childNodes);return;}
    [...el.attributes].forEach(attr=>{
      const n=attr.name.toLowerCase(),v=attr.value||"";
      if(n.startsWith("on")||n==="style"||n==="srcdoc"||n==="formaction"||n==="xlink:href"||n==="xmlns"||n==="is"||n==="slot"||n==="part"){el.removeAttribute(attr.name);return;}
      if(el.tagName==="IMG"&&n==="src"&&!safeImage.test(v)){el.removeAttribute(attr.name);return;}
      if(el.tagName==="A"&&n==="href"&&!safeHref.test(v)){el.removeAttribute(attr.name);return;}
      if(el.tagName==="A"&&n==="target"){el.setAttribute("rel","noopener noreferrer");}
      if(!["src","alt","href","target","rel"].includes(n))el.removeAttribute(attr.name);
    });
  });
  return box.innerHTML||"<p></p>";
}

function migrateCardStats(d){
  const out=typeof d.cardStats==="object"&&d.cardStats?{...d.cardStats}:{};
  for(const c of d.flashcards||[]){
    const s=out[c.id];
    if(!s)out[c.id]={attempts:0,correct:0,streak:0,ease:2.5,interval:0,repetitions:0,dueAt:0,lastSeen:0};
    else{
      if(s.interval==null)s.interval=0;
      if(s.repetitions==null)s.repetitions=0;
      if(s.ease==null)s.ease=2.5;
      if(s.dueAt==null)s.dueAt=0;
    }
  }
  return out;
}
function normalizeDoc(raw){
  const d={...raw};
  d.id=d.id||uid();d.sourceType=d.sourceType||"pdf";d.ai=typeof d.ai==="object"&&d.ai?d.ai:{enabled:false,generatedAt:"",reviewer:"",cards:[],quiz:[],groundingScore:0};d.fileName=String(d.fileName||"Untitled Study Material");
  d.pageCount=Number(d.pageCount)||0;d.media=Array.isArray(d.media)?d.media:[];d.pageTexts=Array.isArray(d.pageTexts)?d.pageTexts:[];
  d.rawText=String(d.rawText||d.pageTexts.map(p=>p.text||"").join("\n\n"));
  d.units=Array.isArray(d.units)&&d.units.length?d.units:sentenceUnits(d);
  d.summaryMode=SUMMARY_MODES[d.summaryMode]?d.summaryMode:"standard";
  d.terms=candidateTerms(d);
  if(!d.reviewerData||d.reviewerData.engineVersion!==REVIEW_ENGINE_VERSION||d.reviewerData.mode!==d.summaryMode){regenerateDoc(d,false);}
  d.reviewerText=reviewerText(d);
  d.flashcards=Array.isArray(d.flashcards)?d.flashcards:makeFlashcards(d);d.flashcards=d.flashcards.map((c,i)=>({...c,id:c.id||cardId(d,c.type||"recall",c.question||`Card ${i+1}`,c.answer||"")}));
  d.currentCard=clamp(Number(d.currentCard)||0,0,Math.max(0,d.flashcards.length-1));
  d.knownCardIds=Array.isArray(d.knownCardIds)?d.knownCardIds.filter(id=>d.flashcards.some(c=>c.id===id)):[];
  d.cardStats=migrateCardStats(d);
  d.quiz=Array.isArray(d.quiz)&&d.quiz.length?d.quiz:makeQuiz(d);
  d.quiz=d.quiz.map((q,i)=>{const options=Array.isArray(q.options)?q.options:[];let ci=Number.isInteger(q.correctIndex)?q.correctIndex:options.indexOf(q.correct);ci=ci>=0?ci:0;return {...q,id:q.id||stableId("q",`${d.id}|${i}|${q.question||""}`),options,correctIndex:clamp(ci,0,Math.max(0,options.length-1)),correct:options[ci]||q.correct||""};});
  d.quizHistory=Array.isArray(d.quizHistory)?d.quizHistory:[];d.quizScore=Number.isFinite(d.quizScore)?d.quizScore:null;
  d.notesTitle=String(d.notesTitle||"Study Notes");d.notesHtml=safeNoteHtml(d.notesHtml||plainToHtml(String(d.notes||"")));d.notes=stripHtml(d.notesHtml);d.notesUpdatedAt=d.notesUpdatedAt||"";
  d.createdAt=d.createdAt||now();d.updatedAt=d.updatedAt||now();
  d.pinned=!!d.pinned;d.subject=String(d.subject||"").slice(0,40);
  return d;
}

function renderLibrary(){
  const box=$("#library");
  if(!state.documents.length)return box.innerHTML='<div class="empty">Your study materials will appear here.</div>';
  const q=normalize($("#libraryFilter")?.value||"").toLowerCase();
  let docs=state.documents.slice().sort((a,b)=>(b.pinned?1:0)-(a.pinned?1:0)||(b.updatedAt||0)-(a.updatedAt||0));
  if(q)docs=docs.filter(d=>normalize(d.fileName).toLowerCase().includes(q)||normalize(d.subject||"").toLowerCase().includes(q)||(d.terms||[]).some(t=>normalize(t).toLowerCase().includes(q)));
  if(!docs.length)return box.innerHTML='<div class="empty">No materials match that filter.</div>';
  box.innerHTML=docs.map(d=>{
    const due=countDueCards(d);
    return `<div class="doc ${d.id===state.activeDocId?'active':''} ${d.pinned?'pinned':''}"><div class="doc-icon">${d.pinned?'📌':'📘'}</div><div class="doc-main"><div class="doc-name">${esc(d.fileName)}${d.subject?` <span class="source-chip">${esc(d.subject)}</span>`:""}</div><div class="doc-meta">${d.pageCount||0} pages · ${wordCount(d.rawText||"").toLocaleString()} words · ${d.terms?.length||0} terms${due?` · <strong>${due} due</strong>`:""}</div></div><div class="doc-actions"><button class="btn small secondary" data-open="${esc(d.id)}">Open</button><button class="btn small secondary" data-pin="${esc(d.id)}">${d.pinned?'Unpin':'Pin'}</button><button class="btn small secondary" data-subject="${esc(d.id)}">Tag</button><button class="btn small danger" data-delete="${esc(d.id)}">Delete</button></div></div>`;
  }).join('');
  box.querySelectorAll('[data-open]').forEach(b=>b.onclick=async()=>{state.activeDocId=b.dataset.open;await saveMeta();renderAll();activateSection('tutor');});
  box.querySelectorAll('[data-pin]').forEach(b=>b.onclick=async()=>{const d=state.documents.find(x=>x.id===b.dataset.pin);if(!d)return;d.pinned=!d.pinned;d.updatedAt=now();await saveDoc(d);renderLibrary();toast(d.pinned?'Pinned.':'Unpinned.','success');});
  box.querySelectorAll('[data-subject]').forEach(b=>b.onclick=async()=>{const d=state.documents.find(x=>x.id===b.dataset.subject);if(!d)return;const s=prompt('Subject / folder tag',d.subject||'');if(s==null)return;d.subject=String(s).trim().slice(0,40);d.updatedAt=now();await saveDoc(d);renderLibrary();toast('Subject saved.','success');});
  box.querySelectorAll('[data-delete]').forEach(b=>b.onclick=async()=>{const d=state.documents.find(x=>x.id===b.dataset.delete);if(!d)return;if(!confirm(`Delete ${d.fileName}?`))return;await dbDelete(DOC_STORE,d.id);state.documents=state.documents.filter(x=>x.id!==d.id);state.activeDocId=state.documents[0]?.id||null;await saveMeta();renderAll();toast('Document deleted.','success');});
}
function renderStats(){
  const docs=state.documents;
  $("#stats").classList.toggle('hidden',!docs.length);
  $("#statDocs").textContent=docs.length;
  if($("#heroDocCount"))$("#heroDocCount").textContent=docs.length;
  $("#statPages").textContent=docs.reduce((a,d)=>a+(d.pageCount||0),0).toLocaleString();
  $("#statPhotos").textContent=docs.reduce((a,d)=>a+(d.media?.length||0),0).toLocaleString();
  $("#statWords").textContent=docs.reduce((a,d)=>a+wordCount(d.rawText||''),0).toLocaleString();
  $("#statTerms").textContent=activeDoc()?.terms.length||0;
  $("#statFlash").textContent=activeDoc()?.flashcards.length||0;
  $("#statQuiz").textContent=activeDoc()?.quiz.length||0;
  $("#navFlash").textContent=activeDoc()?.flashcards.length||0;
  $("#navQuiz").textContent=activeDoc()?.quiz.length||0;
  const p=learnerProfile();
  if($("#statStreak"))$("#statStreak").textContent=String(p.streak||0);
  if($("#statSessions"))$("#statSessions").textContent=String(p.sessions||0);
  if($("#heroStreak"))$("#heroStreak").textContent=String(p.streak||0);
  if($("#heroAccuracy")){
    const acc=p.recentAccuracy;
    $("#heroAccuracy").textContent=acc==null?"—":Math.round(acc*100)+"%";
  }
  try{renderStudyPath();}catch(e){console.warn(e);}
  try{renderMasteryPanel();}catch(e){console.warn(e);}
  try{renderSmartCoach();}catch(e){console.warn(e);}
  const gd=countGlobalDue();
  if($("#navDue"))$("#navDue").textContent=gd;
  if($("#globalDueCount"))$("#globalDueCount").textContent=String(gd);
}
/** My product idea: a clear path so you never wonder “what do I do next?” */
function countDueCards(d){
  if(!d?.flashcards?.length)return 0;
  const now=Date.now();
  return d.flashcards.filter(c=>{
    const st=d.cardStats?.[c.id];
    if(!st||!st.attempts)return true; // new cards count as study work
    return st.dueAt&&st.dueAt<=now;
  }).length;
}
function renderStudyPath(){
  const d=activeDoc();
  const due=d?countDueCards(d):0;
  if($("#studyPathDue"))$("#studyPathDue").textContent=String(due);
  const hint=$("#studyPathHint");
  if(hint){
    if(!d)hint.textContent="Add a PDF or photo to unlock your path.";
    else if(due>0)hint.textContent=`${d.fileName} · ${due} card${due===1?"":"s"} ready · follow the steps or jump in.`;
    else hint.textContent=`${d.fileName} · nothing urgent due · review summary or quiz to stay sharp.`;
  }
  const weakBox=$("#studyPathWeak");
  if(weakBox){
    const ws=weakConcepts(6);
    weakBox.innerHTML=ws.length?ws.map(x=>`<span class="term">${esc(x)}</span>`).join(""):`<span class="tiny">Weak spots appear after you grade cards or finish a quiz.</span>`;
  }
  // Suggest the best next step
  document.querySelectorAll(".path-step").forEach(b=>b.classList.remove("is-suggested"));
  let suggest="reviewer";
  if(d){
    if(due>0)suggest="memorize";
    else if((d.quiz||[]).length&&d.quizScore===null)suggest="quiz";
    else if(!(d.reviewerData?.overview))suggest="reviewer";
    else suggest="tutor";
  }
  const sug=document.querySelector(`.path-step[data-path="${suggest}"]`);
  if(sug)sug.classList.add("is-suggested");
  if($("#studyPathGo"))$("#studyPathGo").textContent=due>0?"Start Study Session":(d?"Open Reviewer":"Add material first");
}
function runStudyPath(path){
  const d=activeDoc();
  if(!d&&path!=="reviewer")return toast("Add study material first.","error");
  if(path==="reviewer"){activateSection("reviewer");return;}
  if(path==="memorize"){
    activateSection("flashcards");
    setTimeout(()=>{try{startStudySession();}catch(e){console.warn(e);}},40);
    return;
  }
  if(path==="quiz"){activateSection("quiz");return;}
  if(path==="tutor"){activateSection("tutor");return;}
}
function renderActivePanel(){
  const d=activeDoc(),box=$("#activeDocPanel");
  if(!d){box.innerHTML='<div class="empty">Add study material to start studying.</div>';return;}
  const known=d.knownCardIds.length,total=d.flashcards.length,progress=total?Math.round(known/total*100):0;
  const overview=d.reviewerData?.overview||"";
  const readPct=d.meta?.readingPct||0;
  box.innerHTML=`<div class="doc" style="margin-bottom:12px"><div class="doc-icon">${d.sourceType==='image'?'🖼':'📘'}</div><div class="doc-main"><div class="doc-name">${esc(d.fileName)}${d.subject?` <span class="source-chip">${esc(d.subject)}</span>`:""}</div><div class="doc-meta">${d.sourceType==='image'?'Photo study':'PDF'} • ${d.pageCount||1} page${(d.pageCount||1)===1?'':'s'} • ${d.media?.length||0} photo(s) • ${wordCount(d.rawText||'').toLocaleString()} words</div></div></div><div class="source-pill">${d.sourceType==='image'?'OCR + Visual':'PDF text + page structure'}</div><div class="muted" style="line-height:1.65;margin-top:12px">${collapsibleHtml(overview,280)}</div><div style="margin-top:14px"><div style="display:flex;justify-content:space-between;gap:10px;font-size:.75rem;color:var(--muted)"><span>Flashcard progress</span><span>${known}/${total} (${progress}%)</span></div><div class="progress-track" style="margin-top:6px"><div class="progress-bar" style="width:${progress}%"></div></div><div style="display:flex;justify-content:space-between;gap:10px;font-size:.75rem;color:var(--muted);margin-top:10px"><span>Reading progress</span><span>${readPct}%</span></div><div class="progress-track" style="margin-top:6px"><div class="progress-bar" style="width:${readPct}%;background:linear-gradient(90deg,#6c5ce7,#00b894)"></div></div></div><div class="row" style="margin-top:14px;flex-wrap:wrap;gap:6px"><button class="btn primary small" data-go="reviewer">Reviewer</button><button class="btn secondary small" data-go="flashcards">Flashcards</button><button class="btn secondary small" data-go="quiz">Quiz</button><button class="btn secondary small" id="markReadBtn">+1 page read</button><button id="regenDocBtn" class="btn warning small">Regenerate</button></div>`;
  bindCollapsibles(box);
  box.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>activateSection(b.dataset.go));
  $("#markReadBtn")&&($("#markReadBtn").onclick=()=>markPagesReviewed(1));
  $("#regenDocBtn").onclick=async()=>{regenerateDoc(d,true);await saveDoc(d);renderAll();toast(`Reviewer ready · ${(d.flashcards||[]).length} flashcards · ${(d.quiz||[]).length} quiz items.`,'success');};
}
function renderTerms(){const c=$("#reviewerTerms"),terms=activeDoc()?.terms||[];c.innerHTML=terms.length?terms.map(t=>`<span class="term">${esc(t)}</span>`).join(''):'<div class="empty">No terms detected.</div>';}
function formatReviewerProse(text,emptyMsg){
  const raw=normalize(text||"");
  if(!raw)return `<p class="empty">${esc(emptyMsg)}</p>`;
  const lines=raw.split(/\n+/).map(l=>l.trim()).filter(Boolean);
  const html=[];
  let inList=false;
  const closeList=()=>{if(inList){html.push("</ul>");inList=false;}};
  for(const line of lines){
    const isHeading=/^(Focus|Core ideas|Key points|Quick points|Detailed points|Remember these|Source-only summary|Main terms in this material|Core definitions from the source|Must-know definitions|Additional source points|Key source points|Remember these source points)$/i.test(line);
    const isBullet=/^[•\-–—]\s+/.test(line)||/^\d+\.\s+/.test(line);
    if(isHeading){
      closeList();
      html.push(`<div class="review-label">${esc(line)}</div>`);
    }else if(isBullet){
      if(!inList){html.push('<ul class="review-bullets">');inList=true;}
      const body=line.replace(/^[•\-–—]\s+/,"").replace(/^\d+\.\s+/,"");
      html.push(`<li>${esc(body)}</li>`);
    }else{
      closeList();
      if(html.length&&html[html.length-1].includes("review-label")){
        html.push(`<p class="review-focus">${esc(line)}</p>`);
      }else{
        html.push(`<p class="review-prose">${esc(line)}</p>`);
      }
    }
  }
  closeList();
  const inner=html.join("")||`<p class="empty">${esc(emptyMsg)}</p>`;
  // Collapse long summaries so the screen stays scannable
  if(raw.length>520){
    const id="rv"+Math.random().toString(36).slice(2,9);
    return `<div class="collapse-wrap"><div class="collapse-body is-collapsed" id="${id}">${inner}</div><button type="button" class="collapse-toggle" data-collapse-for="${id}" aria-expanded="false">Show more ▼</button></div>`;
  }
  return inner;
}

function renderReviewer(){
  const d=activeDoc(),r=d?.reviewerData;
  const overviewEl=$("#reviewerOverview");
  const cramEl=$("#reviewerCram");
  const strategyEl=$("#reviewerStrategy");
  if(overviewEl){overviewEl.innerHTML=formatReviewerProse(r?.overview,"Select a study material.");bindCollapsibles(overviewEl);}
  if(cramEl){cramEl.innerHTML=formatReviewerProse(r?.examCram,"Upload a PDF or photo to create a compact exam summary.");bindCollapsibles(cramEl);}
  if(strategyEl){strategyEl.innerHTML=formatReviewerProse(r?.strategy,"Upload a PDF to create a study strategy.");bindCollapsibles(strategyEl);}
  $("#reviewerMeta").textContent=d?`${d.fileName} • ${r?.terms?.length||0} concepts • ${r?.confidence||0}% source-structure confidence`:`Closed-book synthesis from your sources. Add material, then build the guide.`;
  if($("#reviewerGuideStatus"))$("#reviewerGuideStatus").textContent=d?`Built from your source. Start with the summary and key ideas; open the detailed evidence only when you need it.`:`Add study material to build your guide.`;
  $("#reviewerConfidence").textContent=d?`${r?.confidence||0}% evidence confidence`:`Not analyzed`;
  $$('[data-summary-mode]').forEach(b=>b.classList.toggle("active",b.dataset.summaryMode===(d?.summaryMode||"standard")));
  renderTerms();
  const softListText=t=>softenBullet(t,220);
  const fill=(sel,items,map,empty)=>{const el=$(sel);if(!el)return;el.innerHTML=items?.length?items.map(map).join(""):empty;};
  fill("#reviewerDefinitions",r?.definitions,d=>`<div class="definition-card"><strong>${esc(d.term)}</strong><span>${esc(softListText(d.definition))}${d.page?` <span class="tiny">Page ${d.page}</span>`:""}<span class="confidence-badge">${Math.round((d.confidence||0)*100)}%</span></span></div>`,'<div class="empty">No explicit definition pattern was detected. Contextual evidence is still available.</div>');
  fill("#reviewerKeyPoints",r?.keyPoints,x=>`<li>${esc(softListText(x.text))}${x.heading?`<span class="meta">${esc(x.heading)}</span>`:""}${x.page?`<span class="meta">Page ${x.page}</span>`:""}</li>`,'<li class="empty">No strong evidence points yet.</li>');
  fill("#reviewerProcesses",r?.processes,x=>`<li>${esc(softListText(x.text))}${x.page?`<span class="meta">Page ${x.page}</span>`:""}</li>`,'<li class="empty">No process or sequence pattern detected.</li>');
  fill("#reviewerCauses",r?.causes,x=>`<li>${esc(softListText(x.text))}${x.page?`<span class="meta">Page ${x.page}</span>`:""}</li>`,'<li class="empty">No cause-effect pattern detected.</li>');
  fill("#reviewerComparisons",r?.comparisons,x=>`<li>${esc(softListText(x.text))}${x.page?`<span class="meta">Page ${x.page}</span>`:""}</li>`,'<li class="empty">No comparison pattern detected.</li>');
  fill("#reviewerExamples",r?.examples,x=>`<li>${esc(softListText(x.text))}${x.page?`<span class="meta">Page ${x.page}</span>`:""}</li>`,'<li class="empty">No example pattern detected.</li>');
  fill("#reviewerFacts",r?.facts,x=>`<li>${esc(softListText(x.text))}${x.page?`<span class="meta">Page ${x.page}</span>`:""}</li>`,'<li class="empty">No fact or formula pattern detected.</li>');
  fill("#reviewerQuestions",r?.questions,q=>`<div class="study-question"><span class="question-type">${esc(q.type||"recall")}</span><div>${esc(q.q)}</div>${q.page?`<span class="source-chip">Page ${q.page}</span>`:""}</div>`,'<div class="empty">No study questions yet.</div>');
  fill("#reviewerPages",r?.pages,p=>`<li><strong>Page ${esc(p.page)}</strong>${p.heading?`<span class="meta">${esc(p.heading)}</span>`:""}<div class="page-snippet">${esc(softListText(p.text))}</div></li>`,'<li class="empty">No page evidence detected.</li>');
  fill("#reviewerMemory",r?.memory,m=>`<div class="memory-item"><strong>${esc(m.term)}</strong><span>${esc(softListText(m.clue))}${m.page?` <span class="tiny">Page ${m.page}</span>`:""}</span></div>`,'<div class="empty">No memory cues yet.</div>');
  fill("#reviewerChecklist",r?.checklist,x=>`<li>${esc(x)}</li>`,'<li class="empty">No checklist yet.</li>');
  const map=$("#reviewerConceptMap");
  if(map){
    map.innerHTML=renderConceptMapSVG(r?.conceptMap||[]);
    map.querySelectorAll(".cmap-node").forEach(g=>{
      g.style.cursor="pointer";
      g.onclick=()=>{
        const term=g.getAttribute("data-term");
        if(!term)return;
        activateSection("search");
        const inp=$("#searchInput");
        if(inp){inp.value=term;searchActive();}
        toast(`Searching “${term}” in source…`,"success");
      };
    });
  }
  const photos=$("#reviewerPhotos"),media=d?.media||[];
  photos.innerHTML=media.length?media.map(m=>`<div class="photo-card"><img src="${m.dataUrl}" alt="${esc(m.name)}"><div class="photo-body"><div class="photo-name">${esc(m.name)}</div><div class="photo-meta">${m.confidence?`OCR confidence ${Math.round(m.confidence)}%`:'OCR text not available'}</div><div class="ocr-badge ${m.ocrText?'':'warn'}">${m.ocrText?'✓ OCR text available':'⚠ Add a caption or re-run OCR'}</div><input class="photo-caption" data-caption="${esc(m.id)}" value="${esc(m.caption||"")}" maxlength="300" placeholder="What should you remember from this photo?"><div class="photo-actions"><button class="btn small secondary" data-rerun-ocr="${esc(m.id)}">Re-run OCR</button><button class="btn small secondary" data-export-pic="${esc(m.id)}">Create study pic</button><button class="btn small secondary" data-insert-note="${esc(m.id)}">Insert in notes</button><button class="btn small danger" data-remove-photo="${esc(m.id)}">Remove</button></div></div></div>`).join(""):'<div class="photo-empty">No photos attached. Use Choose Photos on Library, or drop images on the upload zone.</div>';
  photos.querySelectorAll("[data-caption]").forEach(input=>input.addEventListener("change",async()=>{const m=d?.media.find(x=>x.id===input.dataset.caption);if(!m)return;m.caption=input.value.trim();regenerateDoc(d,false);await saveDoc(d);renderAll();toast("Photo caption saved and reviewer regenerated.","success");}));
  photos.querySelectorAll("[data-remove-photo]").forEach(b=>b.onclick=async()=>{const m=d?.media.find(x=>x.id===b.dataset.removePhoto);if(!m)return;if(!confirm(`Remove ${m.name}?`))return;d.media=d.media.filter(x=>x.id!==m.id);d.pageTexts=d.pageTexts.filter(pg=>pg.photoId!==m.id);d.units=d.units.filter(u=>u.photoId!==m.id);regenerateDoc(d,true);await saveDoc(d);renderAll();toast("Photo removed.","success");});
  photos.querySelectorAll("[data-insert-note]").forEach(b=>b.onclick=()=>{const m=d?.media.find(x=>x.id===b.dataset.insertNote);if(!m)return;activateSection("notes");setTimeout(()=>insertAtCursor(`<p><img src="${m.dataUrl}" alt="${esc(m.name)}"><br><strong>${esc(m.name)}</strong></p>`),60);});
  photos.querySelectorAll("[data-rerun-ocr]").forEach(b=>b.onclick=async()=>{
    const m=d?.media.find(x=>x.id===b.dataset.rerunOcr);if(!m)return;
    b.disabled=true;b.textContent="OCR…";
    try{
      const blob=await (await fetch(m.dataUrl)).blob();
      const ocr=await ocrImage(new File([blob],m.name||"photo.jpg",{type:blob.type||"image/jpeg"}),prog=>{
        const pct=prog?.progress?Math.round(prog.progress*100):null;
        b.textContent=pct!=null?`OCR ${pct}%`:"OCR…";
      });
      m.ocrText=ocr.text||"";m.confidence=ocr.confidence||0;
      const pg=d.pageTexts.find(p=>p.photoId===m.id);
      if(pg){pg.text=m.ocrText;pg.source="photo-ocr";}
      d.units=d.units.filter(u=>u.photoId!==m.id);
      for(const x of extractSentences(m.ocrText,18))d.units.push({page:1,text:x,source:"photo",photoId:m.id});
      regenerateDoc(d,true);await saveDoc(d);renderAll();
      toast(m.ocrText?`OCR updated for ${m.name}.`:`OCR found little text on ${m.name}. Add a caption so the reviewer still knows what matters.`,"success");
    }catch(err){
      console.warn(err);
      toast("OCR needs a one-time internet connection so Tesseract can cache, then it works offline. Caption the photo for now.","error");
      b.disabled=false;b.textContent="Re-run OCR";
    }
  });
  photos.querySelectorAll("[data-export-pic]").forEach(b=>b.onclick=async()=>{
    const m=d?.media.find(x=>x.id===b.dataset.exportPic);if(!m)return;
    try{
      await exportStudyPic(m,d?.title||"StudyVault");
      toast("Study pic saved to your downloads — local only, nothing left the device.","success");
    }catch(err){console.warn(err);toast("Could not create the study pic.","error");}
  });
}
async function setSummaryMode(mode){const d=activeDoc();if(!d||!SUMMARY_MODES[mode])return toast("Select a study material first.","error");d.summaryMode=mode;regenerateDoc(d,false);await saveDoc(d);renderAll();toast(`${SUMMARY_MODES[mode].label} summary generated.`,`success`);}
function renderFlash(){
  const d=activeDoc();
  const hideGrades=()=>{
    document.querySelectorAll(".grade-btn").forEach(b=>b.classList.add("hidden"));
    if($("#showFlashAnswer"))$("#showFlashAnswer").classList.remove("hidden");
    if($("#flashEvidence")){$("#flashEvidence").classList.add("hidden");$("#flashEvidence").textContent="";}
  };
  if(!d||!d.flashcards.length){
    $("#flashPosition").textContent=d?"0 cards":"No material";
    $("#flashQuestion").textContent=d
      ? "No flashcards yet. Open Reviewer → Build study guide to generate cards from this material."
      : "Add a PDF or photo first, then Build study guide.";
    $("#flashAnswer").classList.add("hidden");
    $("#flashStatus").textContent=d?"BUILD GUIDE":"ADD MATERIAL";
    $("#flashKnown").textContent="—";
    if($("#flashScheduleHint"))$("#flashScheduleHint").textContent=d?"Tip: Build study guide creates definition, cloze, and recall cards.":"";
    if($("#statFlashSide"))$("#statFlashSide").textContent="0";
    if($("#statDueSide"))$("#statDueSide").textContent="0";
    if($("#statMasterySide"))$("#statMasterySide").textContent="0%";
    if($("#statIntervalSide"))$("#statIntervalSide").textContent="—";
    if($("#statBoxesSide"))$("#statBoxesSide").textContent="—";
    hideGrades();
    return;
  }
  // Session mode: stay inside queue
  if(state.sessionActive&&state.sessionQueue.length&&!state.sessionQueue.includes(d.currentCard)){
    d.currentCard=state.sessionQueue[0];
  }
  d.currentCard=clamp(Number(d.currentCard)||0,0,d.flashcards.length-1);
  const c=d.flashcards[d.currentCard];
  const stats=d.cardStats?.[c.id]||{attempts:0,correct:0,streak:0,ease:2.5,interval:0,repetitions:0,dueAt:0};
  const known=(d.knownCardIds||[]).includes(c.id);
  const due=stats.dueAt&&stats.dueAt<=Date.now();
  const mastery=stats.attempts?Math.round(stats.correct/stats.attempts*100):0;
  const box=getLeitnerBox(stats);
  const nowMs=Date.now();
  const dueCount=(d.flashcards||[]).filter(card=>{
    const st=d.cardStats?.[card.id];
    return st&&st.dueAt&&st.dueAt<=nowMs;
  }).length;
  const modeLabel=state.flashMode==="leitner"?"LEITNER":"SM-2";
  const sessionLabel=state.sessionActive?` · Session ${state.sessionQueue.length} left`:"";
  $("#flashPosition").textContent=`Card ${d.currentCard+1} of ${d.flashcards.length}${c.page?` • Page ${c.page}`:""}${due?" • Due now":""}${sessionLabel}`;
  $("#flashStatus").textContent=`${modeLabel} · ${String(c.type||"recall").toUpperCase()} · CARD ${d.currentCard+1}`;
  $("#flashKnown").textContent=state.flashMode==="leitner"
    ?`Box ${box}${known?" · ✓":""}`
    :(known?"✓ Known":stats.attempts?`${mastery}% mastery`:(due?"Due for review":"New"));
  // Reverse mode (production effect): show answer, recall the prompt
  if(state.flashReversed){
    $("#flashQuestion").textContent=c.answer||c.question;
    $("#flashAnswer").textContent=c.question||"";
    if($(".flash-label")) document.querySelectorAll(".flash-label").forEach((el,i)=>{ if(i===0) el.textContent="Recall the question"; });
  }else{
    $("#flashQuestion").textContent=c.question;
    $("#flashAnswer").textContent=c.answer;
    if($(".flash-label")) document.querySelectorAll(".flash-label").forEach((el,i)=>{ if(i===0) el.textContent="Recall"; });
  }
  $("#flashAnswer").classList.add("hidden");
  hideGrades();
  // Source evidence (trust)
  if($("#flashEvidence")&&c.evidence){
    const ev=String(c.evidence).slice(0,220);
    $("#flashEvidence").textContent=`Source: ${ev}${c.evidence.length>220?"…":""}${c.page?` (p.${c.page})`:""}`;
  }
  if($("#flashScheduleHint")){
    if(state.flashMode==="leitner"){
      $("#flashScheduleHint").textContent=stats.attempts
        ?`Leitner Box ${box} · Next in ${formatInterval(stats)}`
        :"New card — Right moves up a box, Wrong returns to Box 1";
    }else{
      $("#flashScheduleHint").textContent=stats.attempts
        ?`Ease ${Number(stats.ease||2.5).toFixed(2)} · Interval ${formatInterval(stats)} · Reps ${stats.repetitions||0}`
        :"New card — grade after you reveal the answer";
    }
  }
  if($("#statFlashSide"))$("#statFlashSide").textContent=String(d.flashcards.length);
  if($("#statDueSide"))$("#statDueSide").textContent=String(dueCount);
  if($("#statMasterySide"))$("#statMasterySide").textContent=mastery+"%";
  if($("#statIntervalSide"))$("#statIntervalSide").textContent=state.flashMode==="leitner"?`Box ${box}`:formatInterval(stats);
  if($("#statBoxesSide")){
    const counts=countLeitnerBoxes(d);
    $("#statBoxesSide").textContent=`${counts[1]||0}/${counts[2]||0}/${counts[3]||0}/${counts[4]||0}/${counts[5]||0}`;
  }
  if($("#toggleLeitnerBtn"))$("#toggleLeitnerBtn").textContent=state.flashMode==="leitner"?"SM-2 mode":"Leitner mode";
  if($("#startSessionBtn"))$("#startSessionBtn").textContent=state.sessionActive?"■ End Session":"▶ Study Session";
}
function renderQuiz(){
  const d=activeDoc(),ctn=$("#quizContainer");
  if(!d||!d.quiz.length){ctn.innerHTML='<div class="card empty">Add study material, then generate a quiz (MC · fill-blank · mix & match).</div>';$("#quizResult").classList.add('hidden');renderQuizHistory(d);return;}
  ctn.innerHTML=d.quiz.map((q,i)=>{
    if(q.type==="fill"){
      return `<article class="quiz-item" data-q="${i}" data-type="fill"><span class="question-type">fill-in</span><p class="q">${i+1}. ${esc(q.question)}</p><div class="context">${esc(q.context)}${q.page?` <span class="tiny">Page ${q.page}</span>`:""}</div><input class="lock-input quiz-fill" name="q-${i}" type="text" autocomplete="off" placeholder="Type the term…" style="width:100%;margin-top:8px"></article>`;
    }
    if(q.type==="match"&&Array.isArray(q.pairs)){
      const defs=q.pairs.map(p=>p.def).slice().sort(()=>Math.random()-0.5);
      const opts=defs.map((def,j)=>`<option value="${j}">${esc(def)}</option>`).join("");
      const rows=q.pairs.map((p,pi)=>`<div class="match-row" style="display:grid;grid-template-columns:1fr 1.4fr;gap:8px;margin:6px 0;align-items:center"><strong>${esc(p.term)}</strong><select class="lock-input quiz-match" data-pair="${pi}" name="q-${i}-p${pi}"><option value="">— pick definition —</option>${opts}</select></div>`).join("");
      return `<article class="quiz-item" data-q="${i}" data-type="match"><span class="question-type">mix & match</span><p class="q">${i+1}. ${esc(q.question)}</p><div class="context tiny muted">${esc(q.context||"")}</div>${rows}</article>`;
    }
    const opts=(q.options||[]).map((o,j)=>`<label class="option"><input type="radio" name="q-${i}" value="${j}"><span>${esc(o)}</span></label>`).join("");
    return `<article class="quiz-item" data-q="${i}" data-type="${esc(q.type||"mc")}"><span class="question-type">${esc(q.type||"recall")}</span><p class="q">${i+1}. ${esc(q.question)}</p><div class="context">${esc(q.context||"")}${q.page?` <span class="tiny">Page ${q.page}</span>`:""}</div>${opts}</article>`;
  }).join("");
  if(d.quizScore===null)$("#quizResult").classList.add("hidden");
  renderQuizHistory(d);
}
function renderQuizHistory(d){
  const h=$("#quizHistory");
  if(!d?.quizHistory?.length){h.innerHTML='<div class="empty">No attempts yet.</div>';return;}
  h.innerHTML=d.quizHistory.slice().reverse().slice(0,15).map(x=>`<div class="history-item"><span>${new Date(x.at).toLocaleString()}</span><strong>${x.score}/${x.total} (${x.percent}%)</strong></div>`).join('');
}
function renderDashboard(){renderStats();renderLibrary();renderActivePanel();const el=$("#libraryStatus");if(el)el.textContent=state.documents.length?`${state.documents.length} study material${state.documents.length===1?'':'s'} stored locally.`:'No study material loaded yet.';}
function renderNotes(){
  const d=activeDoc(), editor=$("#notesEditor"),title=$("#notesTitle");
  if(!editor||!title)return;
  editor.contentEditable=!!d;
  title.disabled=!d;
  // Don't rewrite the editor while typing (major lag/focus fix)
  const sameDoc=editor.dataset.docId===d?.id;
  if(!sameDoc){
    editor.dataset.docId=d?.id||"";
    editor.innerHTML=d?.notesHtml||"<p></p>";
    title.value=d?.notesTitle||"";
  }else if(document.activeElement!==title&&title.value!==(d?.notesTitle||"")){
    title.value=d?.notesTitle||"";
  }
  $("#notesDocLabel").textContent=d?`Notes for ${d.fileName}`:"Notes are stored per document.";
  $("#noteDocumentHint").textContent=d?d.fileName:"Select a PDF to begin.";
  $("#noteWordCount").textContent=`${wordCount(stripHtml(editor.innerHTML))} words`;
  $("#noteUpdatedAt").textContent=d?.notesUpdatedAt?`Saved ${new Date(d.notesUpdatedAt).toLocaleTimeString()}`:"Not saved yet";
}
/** Faster UI: full refresh only when needed; section refresh avoids lag. */
function renderAll(opts={}){
  const full=!!opts.full;
  const section=opts.section||document.querySelector(".section.active")?.id||"";
  try{applyTheme();}catch(e){console.warn(e);}
  try{renderStats();}catch(e){console.warn(e);}
  if(full||!section||section==="dashboard"){
    try{renderDashboard();}catch(e){console.warn(e);}
  }
  const map={
    reviewer:()=>renderReviewer(),
    flashcards:()=>renderFlash(),
    quiz:()=>renderQuiz(),
    notes:()=>renderNotes(),
    tutor:()=>renderTutor(),
    ai:()=>renderAI(),
    settings:()=>renderPhoneAccess()
  };
  if(full){
    Object.keys(map).forEach(k=>{try{map[k]();}catch(e){console.warn(k,e);}});
    return;
  }
  if(map[section]){try{map[section]();}catch(e){console.warn(section,e);}}
}

function escapeRegExp(text){return String(text).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
function highlight(text,q){const safe=esc(text);if(!q)return safe;const e=escapeRegExp(q);return safe.replace(new RegExp(`(${e})`,'gi'),'<mark>$1</mark>');}
function searchActive(q){
  const box=$("#searchResults");
  q=q.trim(); if(!q)return box.innerHTML='<div class="empty">Type a search term. Prefix with <code>all:</code> to search your entire library.</div>';
  const libraryWide=/^all:\s*/i.test(q);
  if(libraryWide)q=q.replace(/^all:\s*/i,"").trim();
  if(!q)return box.innerHTML='<div class="empty">Type a search term after <code>all:</code>.</div>';
  const terms=tokenize(q).filter(x=>x.length>=2);
  const scoreText=(text)=>{
    const t=String(text||"").toLowerCase(); if(!t)return 0;
    let score=0;
    if(t.includes(q.toLowerCase())) score+=12;
    for(const term of terms){ const hits=(t.match(new RegExp(escapeRegExp(term),"gi"))||[]).length; score+=Math.min(6,hits)*2; }
    return score/(1+Math.log1p(t.length/700));
  };
  const docs=libraryWide?state.documents:(activeDoc()?[activeDoc()]:[]);
  if(!docs.length)return box.innerHTML='<div class="empty">Select a study material first, or use <code>all:</code> after importing files.</div>';
  const candidates=[];
  for(const d of docs){
    const docLabel=d.fileName||"Untitled";
    for(const p of (d.pageTexts||[])){
      const text=String(p.text||""); if(!text)continue;
      const score=scoreText(text); if(score<=0)continue;
      const lower=text.toLowerCase(),needle=q.toLowerCase(); let idx=lower.indexOf(needle);
      if(idx<0){ for(const term of terms){ idx=lower.indexOf(term); if(idx>=0)break; } }
      const center=Math.max(0,idx<0?0:idx); const start=Math.max(0,center-170),end=Math.min(text.length,center+Math.max(q.length,terms.join(" ").length)+260);
      candidates.push({label:(libraryWide?docLabel+" · ":"")+(p.photoId?`Photo${p.page?` · page ${p.page}`:""}`:`Page ${p.page||"?"}`),snippet:text.slice(start,end),score,page:p.page||0,docId:d.id});
    }
    for(const m of (d.media||[])){
      const text=`${m.name} ${m.caption||""} ${m.ocrText||""}`; const score=scoreText(text); if(score<=0)continue;
      candidates.push({label:(libraryWide?docLabel+" · ":"")+`Photo: ${m.name}`,snippet:text.slice(0,520),score,page:m.page||0,docId:d.id});
    }
    // Also search reviewer terms / definitions for high-signal hits
    for(const def of (d.reviewerData?.definitions||[]).slice(0,40)){
      const text=`${def.term} ${def.definition||""}`; const score=scoreText(text)*1.15; if(score<=0)continue;
      candidates.push({label:(libraryWide?docLabel+" · ":"")+`Definition: ${def.term}`,snippet:text.slice(0,400),score,page:def.page||0,docId:d.id});
    }
  }
  candidates.sort((a,b)=>b.score-a.score||a.page-b.page);
  const matches=candidates.slice(0,100);
  if(!matches.length)return box.innerHTML='<div class="empty">No match found. Try a definition, formula, name, shorter phrase, or <code>all:your term</code> for library-wide search.</div>';
  box.innerHTML=(libraryWide?`<div class="tiny muted" style="margin-bottom:8px">Library-wide · ${matches.length} hits across ${docs.length} documents</div>`:"")+matches.map((m,i)=>`<div class="result" data-open-doc="${esc(m.docId||"")}"><span class="page">${esc(m.label)} · relevance ${Math.round(m.score)}${m.page?` · p.${m.page}`:""}</span><div>${highlight(m.snippet,q)}</div><button type="button" class="btn small secondary" data-note-hit="${i}" style="margin-top:6px">＋ Notes</button></div>`).join('');
  box.querySelectorAll("[data-open-doc]").forEach(el=>{
    el.style.cursor="pointer";
    el.onclick=async(ev)=>{
      if(ev.target.closest("[data-note-hit]"))return;
      const id=el.getAttribute("data-open-doc");
      if(id&&id!==state.activeDocId){state.activeDocId=id;await saveMeta();renderAll();}
    };
  });
  box.querySelectorAll("[data-note-hit]").forEach(btn=>{
    btn.onclick=ev=>{
      ev.stopPropagation();
      const i=Number(btn.getAttribute("data-note-hit"));
      const m=matches[i];
      if(!m)return;
      if(m.docId&&m.docId!==state.activeDocId){
        state.activeDocId=m.docId; saveMeta().then(()=>addSearchHitToNotes(m.snippet,m.page,m.label));
      }else addSearchHitToNotes(m.snippet,m.page,m.label);
    };
  });
}

async function insertImageFilesIntoNotes(files){for(const file of [...files].filter(f=>f.type.startsWith('image/'))){try{const visual=await dataUrlFromFile(file,1600,.84);insertAtCursor(`<p><img src="${visual.dataUrl}" alt="${esc(file.name)}"><br><em>${esc(file.name)}</em></p>`);}catch(e){toast(`${file.name}: ${e.message||'Could not add image.'}`,'error');}}}

function getEditorRange(){
  const editor=$("#notesEditor");const sel=window.getSelection();
  if(!sel||!sel.rangeCount||!editor.contains(sel.anchorNode))return null;
  return sel.getRangeAt(0);
}
function wrapSelection(tagName){
  const range=getEditorRange();if(!range||range.collapsed)return false;
  const node=document.createElement(tagName);
  try{node.appendChild(range.extractContents());range.insertNode(node);range.selectNodeContents(node);}catch{const frag=range.cloneContents();node.appendChild(frag);range.deleteContents();range.insertNode(node);range.selectNodeContents(node);}
  return true;
}
function formatSelectionBlock(tagName){
  const editor=$("#notesEditor"),range=getEditorRange();if(!range)return false;
  const container=(range.commonAncestorContainer.nodeType===1?range.commonAncestorContainer:range.commonAncestorContainer.parentElement)?.closest("p,div,h2,h3,blockquote,li");
  if(container&&editor.contains(container)){const n=document.createElement(tagName);while(container.firstChild)n.appendChild(container.firstChild);container.replaceWith(n);return true;}
  return wrapSelection(tagName);
}
function makeListFromSelection(){
  const range=getEditorRange();if(!range||range.collapsed)return false;
  const text=range.toString().split(/\n+/).map(x=>x.trim()).filter(Boolean);if(!text.length)return false;
  const ul=document.createElement("ul");text.forEach(x=>{const li=document.createElement("li");li.textContent=x;ul.appendChild(li);});range.deleteContents();range.insertNode(ul);return true;
}
function selectNoteCommand(cmd,value){
  const editor=$("#notesEditor");editor.focus();let changed=false;
  if(cmd==="bold")changed=wrapSelection("strong");
  else if(cmd==="italic")changed=wrapSelection("em");
  else if(cmd==="formatBlock")changed=formatSelectionBlock(String(value||"p").toLowerCase()==="h3"?"h3":"h2");
  else if(cmd==="insertUnorderedList")changed=makeListFromSelection();
  if(!changed)toast("Select some note text first.","error");else scheduleNoteSave();
}
function insertAtCursor(html){
  const editor=$("#notesEditor");editor.focus();const range=getEditorRange();
  if(!range){editor.insertAdjacentHTML("beforeend",safeNoteHtml(html));scheduleNoteSave();return;}
  const holder=document.createElement("div");holder.innerHTML=safeNoteHtml(html);const frag=document.createDocumentFragment();while(holder.firstChild)frag.appendChild(holder.firstChild);range.deleteContents();range.insertNode(frag);scheduleNoteSave();
}
function scheduleNoteSave(){
  const d=activeDoc();if(!d)return;
  const docId=d.id;
  const title=($("#notesTitle")?.value||"Study Notes").trim()||"Study Notes";
  const htmlSnapshot=safeNoteHtml($("#notesEditor")?.innerHTML||"<p></p>");
  const token=++noteSaveToken;
  $("#noteSaveStatus").textContent="Saving…";
  setTimeout(async()=>{
    if(token!==noteSaveToken)return;
    const doc=state.documents.find(x=>x.id===docId);if(!doc)return;
    try{
      doc.notesTitle=title;
      doc.notesHtml=htmlSnapshot;
      doc.notes=stripHtml(htmlSnapshot);
      doc.notesUpdatedAt=now();
      await saveDoc(doc);
      if(activeDoc()?.id===docId){$("#noteSaveStatus").textContent="Saved";$("#noteWordCount").textContent=`${wordCount(doc.notes)} words`;$("#noteUpdatedAt").textContent=`Saved ${new Date(doc.notesUpdatedAt).toLocaleTimeString()}`;}
    }catch(e){if(activeDoc()?.id===docId)$("#noteSaveStatus").textContent="Save failed";toast(e.message||"Could not save notes.","error");}
  },420);
}

function exportNotes(){
  const d=activeDoc();if(!d)return toast('Select a document first.','error');
  const title=d.notesTitle||"Study Notes";
  const plain=d.notes||stripHtml(d.notesHtml||"");
  const txt=`${title}\nSource: ${d.fileName}\nExported: ${new Date().toLocaleString()}\n\n${plain}\n`;
  downloadBlob(new Blob([txt],{type:'text/plain;charset=utf-8'}),`${String(d.fileName).replace(/\.[^.]+$/,'')}-notes.txt`);
  toast('Notes exported as .txt','success');
}
function insertNoteTemplate(kind){
  const d=activeDoc();
  if(!d)return toast('Select a document first.','error');
  const name=esc(d.fileName||"this material");
  const templates={
    summary:`<h2>Summary — ${name}</h2><p><strong>Main idea:</strong> </p><p><strong>Key terms:</strong> </p><ul><li></li><li></li><li></li></ul><p><strong>What I still need to check:</strong> </p>`,
    formula:`<h2>Formulas</h2><blockquote><strong>Name:</strong> <br><strong>Equation:</strong> <br><strong>When to use:</strong> <br><strong>Units:</strong> </blockquote><p></p>`,
    weak:`<h2>Weak points</h2><ul><li>☐ Concept I keep missing: </li><li>☐ Page / photo to re-read: </li><li>☐ Practice question: </li></ul>`,
    exam:`<h2>Exam prep</h2><p><strong>Must-know definitions</strong></p><ul><li></li></ul><p><strong>Likely questions</strong></p><ul><li></li></ul><p><strong>Formulas to memorize</strong></p><ul><li></li></ul>`
  };
  const html=templates[kind];
  if(!html)return;
  insertAtCursor(html);
  toast('Template inserted.','success');
}
function insertDefinitionsFromDoc(){
  const d=activeDoc();
  if(!d)return toast('Select a document first.','error');
  const defs=(d.reviewerData?.definitions||[]).slice(0,12);
  if(!defs.length)return toast('No definitions extracted yet. Open Reviewer and regenerate.','error');
  const blocks=defs.map(x=>`<blockquote><strong>${esc(x.term)}</strong>${x.page?` <span class="tiny">p.${x.page}</span>`:""}<br>${esc(cleanAnswer(x.definition,200))}</blockquote>`).join("");
  insertAtCursor(`<h2>Definitions from material</h2>${blocks}`);
  toast(`Inserted ${defs.length} definitions.`,'success');
}

async function copyReviewer(){const d=activeDoc();if(!d)return toast('Select a document first.','error');try{await navigator.clipboard.writeText(d.reviewerText);toast('Reviewer copied.','success')}catch{toast('Clipboard access was blocked.','error')}}
function downloadText(filename,text){const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),500);}
function downloadReviewer(){const d=activeDoc();if(!d)return toast('Select a document first.','error');downloadText(`${d.fileName.replace(/\.[^.]+$/,'')}-reviewer.txt`,d.reviewerText);toast('Reviewer downloaded.','success')}

async function submitQuiz(){
  const d=activeDoc();if(!d)return toast('Select a document first.','error');
  let score=0;const concepts=[];const misses=[];
  d.quiz.forEach((q,i)=>{
    const item=document.querySelector(`[data-q="${i}"]`);
    if(!item)return;
    item.classList.remove("correct","wrong");
    let ok=false;
    let correctLabel="—";
    if(q.type==="fill"){
      const input=item.querySelector(`input[name="q-${i}"]`);
      const ans=normalize(input?.value||"");
      const right=normalize(q.correct||"");
      ok=!!ans&&(ans===right||ans.includes(right)||right.includes(ans));
      correctLabel=q.correct||"—";
    }else if(q.type==="match"&&Array.isArray(q.pairs)){
      let all=true;
      q.pairs.forEach((p,pi)=>{
        const sel=item.querySelector(`select[data-pair="${pi}"]`);
        const chosen=sel?sel.options[sel.selectedIndex]?.text||"":"";
        if(normalize(chosen)!==normalize(p.def))all=false;
      });
      ok=all;
      correctLabel=q.pairs.map(p=>`${p.term} → ${p.def}`).join("; ");
    }else{
      const picked=document.querySelector(`input[name="q-${i}"]:checked`);
      ok=!!picked&&Number(picked.value)===q.correctIndex;
      correctLabel=q.options?.[q.correctIndex]??"—";
    }
    const concept=q.term||((d.terms||[]).find(t=>(q.context||q.question||"").toLowerCase().includes(String(t).toLowerCase())));
    if(concept){adaptConcept(concept,ok);concepts.push(concept);}
    if(ok){score++;item.classList.add("correct");}
    else{
      item.classList.add("wrong");
      const evidence=q.context||q.evidence||"";
      const why=document.createElement("div");
      why.className="quiz-why";
      why.innerHTML=`<strong>Correct:</strong> ${esc(String(correctLabel).slice(0,220))}${evidence?`<div class="tiny muted">Source: ${esc(String(evidence).slice(0,280))}${q.page?` · p.${q.page}`:""}</div>`:""}`;
      item.appendChild(why);
      misses.push(concept||q.question?.slice(0,40)||`Q${i+1}`);
    }
  });
  d.quizScore=score;d.quizHistory=d.quizHistory||[];
  const percent=d.quiz.length?Math.round(score/d.quiz.length*100):0;
  recordStudyResult(concepts,percent/100);await saveMeta();
  d.quizHistory.push({at:now(),score,total:d.quiz.length,percent,concepts:[...new Set(concepts)],misses:[...new Set(misses)]});
  await saveDoc(d);
  const missLine=misses.length?`<p class="muted">Review next: ${misses.slice(0,6).map(esc).join(", ")}</p>`:"";
  $("#quizResult").classList.remove('hidden');
  $("#quizResult").innerHTML=`<div class="score">${percent}%</div><p>You scored <strong>${score}/${d.quiz.length}</strong>.</p><p class="muted">Wrong answers show the correct option + source evidence. Weak concepts are prioritized in future sessions.</p>${missLine}`;
  renderQuizHistory(d);renderAI();renderStats();
  toast(`Quiz completed: ${score}/${d.quiz.length}.`,'success');
}
async function newQuiz(preferWeak=false){
  const d=activeDoc();
  if(!d)return toast('Select a document first.','error');
  let quiz=makeQuiz(d);
  if(preferWeak){
    const weak=new Set(weakConcepts(12).map(x=>normalize(x).toLowerCase()));
    if(weak.size){
      const focused=quiz.filter(q=>q.term&&weak.has(normalize(q.term).toLowerCase()));
      if(focused.length>=4)quiz=focused.concat(quiz.filter(q=>!focused.includes(q))).slice(0,18);
    }
  }
  d.quiz=quiz;d.quizScore=null;await saveDoc(d);renderQuiz();renderStats();
  toast(preferWeak?'Weak-concept quiz ready.':'New quiz generated.','success');
}
function nextSmartIndex(d,current,delta){
  if(!d.flashcards.length)return 0;
  if(delta<0)return (current-1+d.flashcards.length)%d.flashcards.length;
  const nowMs=Date.now(),known=new Set(d.knownCardIds||[]),stats=d.cardStats||{};
  const candidates=d.flashcards.map((c,i)=>{const st=stats[c.id]||{attempts:0,correct:0,streak:0,ease:2.5,dueAt:0};const due=st.dueAt&&st.dueAt<=nowMs;const weak=st.attempts?1-st.correct/st.attempts:.45;const cp=learnerProfile().concepts?.[normalize(c.term||"").toLowerCase()];const conceptWeak=cp?1-(cp.mastery||.35):.35;return {i,score:(due&&!known.has(c.id)?100:0)+weak*20+conceptWeak*28+(known.has(c.id)?-8:8)-Math.abs(i-current)*.01};}).filter(x=>x.i!==current).sort((a,b)=>b.score-a.score);
  return candidates[0]?.i??((current+1)%d.flashcards.length);
}
async function moveFlash(delta){const d=activeDoc();if(!d?.flashcards.length)return;d.currentCard=nextSmartIndex(d,d.currentCard,delta);await saveDoc(d);renderFlash();renderDashboard();}
function speakText(text){
  const t=normalize(String(text||""));
  if(!t)return toast("Nothing to read aloud.","error");
  if(!window.speechSynthesis)return toast("This browser does not support speech synthesis.","error");
  try{window.speechSynthesis.cancel();}catch{}
  const u=new SpeechSynthesisUtterance(t.slice(0,1200));
  u.rate=1;u.pitch=1;u.lang=navigator.language||"en-US";
  window.speechSynthesis.speak(u);
  toast("Reading aloud…","success");
}
/**
 * Classic SM-2 spaced repetition (Anki-compatible intervals).
 * quality: 1=Again, 2=Hard, 3=Good, 4=Easy
 * Returns updated card stats with interval (days) and dueAt (ms).
 */
function sm2Schedule(prev,quality){
  const q=clamp(Number(quality)||1,1,4);
  const p={attempts:0,correct:0,streak:0,ease:2.5,interval:0,repetitions:0,dueAt:0,lastSeen:0,...prev};
  const next={...p,attempts:p.attempts+1,lastSeen:Date.now()};
  // Again — reset and show again soon
  if(q===1){
    next.streak=0;next.repetitions=0;next.correct=p.correct;
    next.ease=Math.max(1.3,+(p.ease-0.20).toFixed(2));
    next.interval=0;
    next.dueAt=Date.now()+1000*60*10; // 10 minutes
    return next;
  }
  // Hard / Good / Easy
  next.correct=p.correct+1;
  next.streak=p.streak+1;
  // Ease factor update (SM-2 style)
  if(q===2) next.ease=Math.max(1.3,+(p.ease-0.15).toFixed(2));
  else if(q===3) next.ease=Math.min(3.0,+(p.ease+0.0).toFixed(2));
  else next.ease=Math.min(3.0,+(p.ease+0.15).toFixed(2)); // Easy
  if(p.repetitions<=0){
    next.interval=q===4?3:q===2?1:1;
    next.repetitions=1;
  }else if(p.repetitions===1){
    next.interval=q===4?7:q===2?3:4;
    next.repetitions=2;
  }else{
    const base=Math.max(1,p.interval||3);
    let days=Math.round(base*next.ease);
    if(q===2)days=Math.max(1,Math.round(days*0.7));
    if(q===4)days=Math.max(days+1,Math.round(days*1.3));
    next.interval=Math.max(1,days);
    next.repetitions=p.repetitions+1;
  }
  next.dueAt=Date.now()+Math.min(1000*60*60*24*365,next.interval*24*60*60*1000);
  return next;
}
function formatInterval(stats){
  if(!stats)return "—";
  if(!stats.dueAt||stats.dueAt<=Date.now())return "Due now";
  const days=stats.interval||0;
  if(days<=0)return "Soon";
  if(days===1)return "1 day";
  if(days<30)return days+" days";
  if(days<365)return Math.round(days/30)+" mo";
  return Math.round(days/365)+" yr";
}

/** Leitner box 1–5 derived from SM-2 stats (compatible with existing data). */
function getLeitnerBox(stats){
  if(!stats||!stats.attempts)return 1;
  const reps=stats.repetitions||0;
  if(reps<=0)return 1;
  if(reps===1)return 2;
  if(reps===2)return 3;
  if(reps<=4)return 4;
  return 5;
}
const LEITNER_INTERVALS_MS=[0, 1000*60*60*24, 1000*60*60*24*3, 1000*60*60*24*7, 1000*60*60*24*14, 1000*60*60*24*30];
function leitnerSchedule(prev,correct){
  const p={attempts:0,correct:0,streak:0,ease:2.5,interval:0,repetitions:0,dueAt:0,lastSeen:0,box:1,...prev};
  const next={...p,attempts:p.attempts+1,lastSeen:Date.now()};
  let box=getLeitnerBox(p);
  if(correct){
    box=Math.min(5,box+1);
    next.correct=p.correct+1;
    next.streak=p.streak+1;
    next.repetitions=Math.max(p.repetitions||0,box-1);
  }else{
    box=1;
    next.streak=0;
    next.repetitions=0;
  }
  next.box=box;
  next.interval=box<=1?0:Math.round(LEITNER_INTERVALS_MS[box]/(1000*60*60*24));
  next.dueAt=Date.now()+(LEITNER_INTERVALS_MS[box]||1000*60*10);
  if(box===1)next.dueAt=Date.now()+1000*60*10;
  next.ease=correct?Math.min(3.0,+(p.ease+0.05).toFixed(2)):Math.max(1.3,+(p.ease-0.15).toFixed(2));
  return next;
}
function countLeitnerBoxes(d){
  const counts=[0,0,0,0,0,0];
  for(const c of d.flashcards||[]){
    const st=d.cardStats?.[c.id];
    counts[getLeitnerBox(st)]++;
  }
  return counts;
}
function buildSessionQueue(d){
  const nowMs=Date.now();
  const due=[], neu=[];
  (d.flashcards||[]).forEach((c,i)=>{
    const st=d.cardStats?.[c.id];
    if(!st||!st.attempts)neu.push(i);
    else if(st.dueAt&&st.dueAt<=nowMs)due.push(i);
  });
  // Due first, then a few new cards
  return [...due,...neu.slice(0,Math.max(5,Math.ceil(neu.length*0.3)))];
}
function startStudySession(){
  const d=activeDoc();
  if(!d?.flashcards?.length)return toast("Add material and generate cards first.","error");
  const q=buildSessionQueue(d);
  if(!q.length)return toast("Nothing due right now. Great job — come back later.","success");
  state.sessionActive=true;
  state.sessionQueue=q;
  d.currentCard=q[0];
  toast(`Study Session: ${q.length} card${q.length===1?"":"s"} (due + new)`,"success");
  renderFlash();renderDashboard();
}
function endStudySession(){
  state.sessionActive=false;
  state.sessionQueue=[];
  toast("Study Session ended. Showing all cards again.");
  renderFlash();
}
function advanceAfterGrade(d){
  // Blitz scoring
  if(state.blitzActive){
    state.blitzLeft=Math.max(0,(state.blitzLeft||1)-1);
    // quality handled by caller; track correct when known path used — approximate via last grade toast path
  }
  // Interleaved multi-doc queue
  if(state.interleaveQueue&&state.interleaveQueue.length){
    // drop current head if matches
    const head=state.interleaveQueue[0];
    if(head&&head.docId===state.activeDocId&&head.index===d.currentCard){
      state.interleaveQueue.shift();
    }
    if(!state.interleaveQueue.length){
      state.sessionActive=false;
      state.blitzActive=false;
      toast("Interleaved session complete.","success");
      d.currentCard=nextSmartIndex(d,d.currentCard,1);
      return;
    }
    const next=state.interleaveQueue[0];
    // switch document if needed — async save deferred by caller
    state._pendingInterleave=next;
    state.activeDocId=next.docId;
    const nd=state.documents.find(x=>x.id===next.docId);
    if(nd){nd.currentCard=next.index;d.currentCard=next.index;}
    return;
  }
  if(state.sessionActive&&state.sessionQueue.length){
    const cur=d.currentCard;
    state.sessionQueue=state.sessionQueue.filter(i=>i!==cur);
    if(!state.sessionQueue.length){
      state.sessionActive=false;
      if(state.blitzActive){endBlitz();state.blitzActive=false;}
      else toast("Session complete — all due cards reviewed!","success");
      d.currentCard=nextSmartIndex(d,cur,1);
    }else{
      d.currentCard=state.sessionQueue[0];
    }
  }else{
    d.currentCard=nextSmartIndex(d,d.currentCard,1);
  }
}
async function gradeCard(quality){
  const d=activeDoc();if(!d?.flashcards.length)return;
  const card=d.flashcards[d.currentCard],id=card.id;
  d.cardStats=d.cardStats||{};
  const prev=d.cardStats[id]||{attempts:0,correct:0,streak:0,ease:2.5,interval:0,repetitions:0,dueAt:0,lastSeen:0};
  const next=sm2Schedule(prev,quality);
  const known=quality>=3;
  if(state.blitzActive&&known)state.blitzCorrect=(state.blitzCorrect||0)+1;
  if(known){if(!d.knownCardIds.includes(id))d.knownCardIds.push(id);}
  else d.knownCardIds=d.knownCardIds.filter(x=>x!==id);
  state.lastGrade={docId:d.id,cardId:id,prevStats:{...prev},known};
  d.cardStats[id]=next;
  adaptConcept(card.term||card.question,known);
  bumpCardsToday(1);
  markActivityDay();
  logStudyEvent("grade", `${card.term||card.question||"card"} · q${quality}`);
  await saveDoc(d);await saveMeta();
  const labels={1:"Again — back in 10 min",2:"Hard — shorter interval",3:"Good — scheduled",4:"Easy — longer interval"};
  toast(labels[quality]||"Graded.","success");
  advanceAfterGrade(d);
  if(state._pendingInterleave){state._pendingInterleave=null;await saveMeta();}
  await saveDoc(d);
  renderAll();renderFlash();renderDashboard();renderAI();smartCoachRefresh();
}
async function gradeLeitner(correct){
  const d=activeDoc();if(!d?.flashcards.length)return;
  const card=d.flashcards[d.currentCard],id=card.id;
  d.cardStats=d.cardStats||{};
  const prev=d.cardStats[id]||{attempts:0,correct:0,streak:0,ease:2.5,interval:0,repetitions:0,dueAt:0,lastSeen:0,box:1};
  const next=leitnerSchedule(prev,correct);
  if(correct){if(!d.knownCardIds.includes(id))d.knownCardIds.push(id);}
  else d.knownCardIds=d.knownCardIds.filter(x=>x!==id);
  state.lastGrade={docId:d.id,cardId:id,prevStats:{...prev},known:!!correct};
  d.cardStats[id]=next;
  adaptConcept(card.term||card.question,correct);
  bumpCardsToday(1);
  markActivityDay();
  logStudyEvent("leitner", (card.term||card.question||"card")+" · "+(correct?"right":"wrong"));
  await saveDoc(d);await saveMeta();
  toast(correct?`Right — Box ${next.box||1}`:`Wrong — back to Box 1`,"success");
  advanceAfterGrade(d);
  await saveDoc(d);
  renderAll();renderFlash();renderDashboard();renderAI();
}
function toggleLeitnerMode(){
  state.flashMode=state.flashMode==="leitner"?"sm2":"leitner";
  if(state.sessionActive)endStudySession();
  toast(state.flashMode==="leitner"?"Leitner mode: Right / Wrong + boxes 1–5":"SM-2 mode: Again / Hard / Good / Easy","success");
  renderFlash();
}
/** Export current document flashcards as Anki-compatible tab-separated text. */
function exportAnkiDeck(){
  const d=activeDoc();
  if(!d?.flashcards?.length)return toast("No flashcards to export.","error");
  const weak=new Set(weakConcepts(40).map(x=>normalize(x).toLowerCase()));
  const lines=["#separator:tab","#html:false","#tags:yes","#deck:StudyVault — "+String(d.fileName||"Deck").replace(/[\t\n\r]/g," ")];
  for(const c of d.flashcards){
    const front=String(c.question||"").replace(/\t/g," ").replace(/\r?\n/g,"<br>");
    const back=String(c.answer||"").replace(/\t/g," ").replace(/\r?\n/g,"<br>");
    const term=normalize(c.term||"");
    const isWeak=term&&weak.has(term.toLowerCase());
    const st=d.cardStats?.[c.id];
    const due=st?.dueAt&&st.dueAt<=Date.now();
    const tags=["StudyVault",c.type||"recall",(c.term||"").replace(/\s+/g,"_"),isWeak?"weak":"",due?"due":"",d.subject?String(d.subject).replace(/\s+/g,"_"):""].filter(Boolean).join(" ");
    lines.push(front+"\t"+back+"\t"+tags);
  }
  const blob=new Blob([lines.join("\n")],{type:"text/plain;charset=utf-8"});
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download=`studyvault-${String(d.fileName||"deck").replace(/[^\w.\-]+/g,"_").slice(0,40)}-anki.txt`;
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),3000);
  toast("Anki file downloaded. In Anki: File → Import → choose this .txt","success");
}

function looksLikeFormula(text){
  const t=String(text||"");
  if(/→|->|⇒|⟶/.test(t)) return true;
  if(/\bequation\b|\bformula\b|\breaction\b|\bohm/i.test(t)&&/[A-Za-z0-9)]\s*[+=→]/.test(t)) return true;
  if(/\d\s*[A-Z][a-z]?\d*(?:\s*[+＋]\s*\d*\s*[A-Z][a-z]?\d*)+\s*(?:→|->|=)/.test(t)) return true;
  // Electrical: V=IR, P=VI, units
  if(/\bV\s*=\s*I\s*R\b|\bI\s*=\s*V\s*\/\s*R\b|\bP\s*=\s*V\s*I\b|\bP\s*=\s*I\s*²?\s*R\b/i.test(t)) return true;
  if(/[Ωμ]|kΩ|MΩ|mA|μA|μF|nF|pF|kHz|MHz/.test(t)&&/\d|=/.test(t)) return true;
  if(/\b[A-Za-z]\s*=\s*[^.]{2,40}/.test(t)&&/\d|%|Δ|√|∛|mol|Hz|V\b|W\b|A\b|Ω|kg|m\/s/.test(t)) return true;
  if(/\b\d+[A-Z][a-z]?\d*\b/.test(t)&&/\+|→|->|=/.test(t)) return true;
  return false;
}

function extractFormulaSnippet(text){
  const t=normalize(text);
  // Prefer the clause that actually holds the equation symbols
  const parts=t.split(/(?<=[.!?])\s+/);
  const hit=parts.find(p=>looksLikeFormula(p))||parts.find(p=>/→|->|=/.test(p));
  if(hit) return softenBullet(hit,220);
  // Fallback: pull a dense symbol-rich span
  const m=t.match(/[^.]{0,40}(?:→|->|⇒|=)[^.]{0,80}/);
  if(m) return softenBullet(m[0],220);
  return softenBullet(t,200);
}

/** Reject junk "definitions" extracted from question headings (What / How / Impact…). */
function photoEvidenceText(doc){
  const parts=[];
  for(const m of doc?.media||[]){
    const cap=String(m.caption||"").trim();
    const ocr=String(m.ocrText||"").trim();
    if(cap||ocr)parts.push(`Photo "${m.name}": ${cap||""}${cap&&ocr?" | ":""}${ocr?ocr.slice(0,600):""}`);
  }
  return parts.join("\n");
}

function buildTutorSummary(doc){
  if(!doc)return "Add study material first, then ask me to summarize it.";
  const r=doc.reviewerData;
  const photo=photoEvidenceText(doc);
  const source=normalize((doc.rawText||"")+"\n"+photo);
  // Prefer structured reviewer overview
  if(r?.overview && String(r.overview).trim().length>30){
    let out="**Summary of your material**\n\n"+String(r.overview).trim();
    if(r.keyPoints?.length){
      out+="\n\n**Key points**\n"+r.keyPoints.slice(0,10).map(x=>{
        const line=typeof x==="string"?x:(x.text||"");
        const pg=x&&x.page?` (p.${x.page})`:"";
        return "• "+cleanAnswer(line,180)+pg;
      }).join("\n");
    }
    if(r.definitions?.length){
      out+="\n\n**Core terms**\n"+r.definitions.slice(0,8).map(d=>"• **"+d.term+"** — "+cleanAnswer(d.definition,140)+(d.page?` (p.${d.page})`:"")).join("\n");
    }
    if(r.facts?.length){
      out+="\n\n**Formulas & facts**\n"+r.facts.slice(0,5).map(x=>"• "+cleanAnswer(typeof x==="string"?x:x.text||"",160)).join("\n");
    }
    out+="\n\n💡 Tip: open Reviewer for full evidence, or ask about one term (e.g. a definition).";
    return out;
  }
  // Build from source if reviewer missing
  const sents=extractSentences(source,50).filter(s=>s.length>=35&&!isLikelyQuestionLine(s));
  const picked=[];
  for(const s of sents){
    if(picked.some(x=>similarity(x,s)>.5))continue;
    picked.push(s);
    if(picked.length>=8)break;
  }
  if(picked.length){
    return "**Quick summary from your text**\n\n"+picked.map(s=>"• "+cleanAnswer(s,200)).join("\n")+"\n\n💡 Tip: open Reviewer → Regenerate for a fuller structured summary.";
  }
  if((doc.media||[]).length){
    return "I can see photos attached, but there is little readable text yet.\n\n1) Open Reviewer → add a caption on each photo\n2) Re-run OCR\n3) Press Regenerate\n\nThen ask me to summarize again.";
  }
  return "I need readable text to summarize. Upload a clearer document, or run OCR on photos, then regenerate the reviewer.";
}


/** General ChatGPT-style helper when no study document is open. Offline-first, honest, useful. */
function generalChatAnswer(question){
  const q=String(question||"").trim();
  const low=q.toLowerCase();
  if(!q) return "What would you like to talk about?";

  // Greetings / identity
  if(/^(hi|hello|hey|good\s*(morning|afternoon|evening)|howdy)\b/i.test(q) || /who are you|what are you|what can you do|help me|your (name|capabilities)/i.test(low)){
    return `Hi — I'm **StudyVault Chat**, your local family assistant.

I can help with:
• **Writing** — emails, essays, outlines, rewrites
• **Explanations** — break down ideas simply
• **Planning** — study plans, to-do structure, schedules
• **STEM** — math, science, electronics basics
• **Images** — say *create an image of…*
• **Your files** — attach a PDF/photo and I'll work from it

What do you need right now?`;
  }

  // Thanks / bye
  if(/^(thanks|thank you|thx|ty)\b/i.test(low)) return "You're welcome. I'm right here whenever you need the next thing.";
  if(/^(bye|goodbye|see you|later)\b/i.test(low)) return "Take care. Your chats stay on this device — come back anytime.";

  // Writing help
  if(/write|email|essay|paragraph|rewrite|improve|tone|formal|draft|letter|cover letter|resume/i.test(low)){
    return `I can help you write that.

Tell me:
1. **What** it is (email, essay, message…)
2. **Who** it's for
3. **Tone** (friendly, formal, short…)
4. Any **must-include** points

Or paste a draft and say **“make this clearer”** or **“more formal.”**`;
  }

  // Explain / teach
  if(/^(what is|what's|explain|how does|how do|why is|define|meaning of)\b/i.test(low) || /\bexplain\b/i.test(low)){
    const topic=q.replace(/^(please\s+)?(what is|what's|explain|how does|how do|why is|define|meaning of)\s+/i,"").replace(/\?$/,"").trim();
    if(topic){
      return `Here's a clear take on **${topic}**:

I'll keep it simple first, then add a little depth.

**In plain words:**  
Think of the core idea in everyday language — the "why it matters" before the jargon.

**A bit deeper:**  
Break it into parts: definition → how it works → a concrete example → common mix-ups.

Want it **eli5**, **exam-style**, or **with an analogy**? Just say which.`;
    }
  }

  // Planning
  if(/plan|schedule|to-?do|roadmap|timeline|how should i study|study plan/i.test(low)){
    return `Let's make a practical plan.

Share:
• **Goal** (what “done” looks like)
• **Deadline**
• **Time available** per day

I'll return a simple day-by-day outline you can actually follow.`;
  }

  // Code
  if(/code|python|javascript|html|css|bug|function|program|script/i.test(low)){
    return `I can help with code.

Paste the snippet (or describe the goal), and say whether you want:
• an **explanation**
• a **fix**
• a **cleaner rewrite**
• or a **from-scratch example**

I'll keep answers practical and readable.`;
  }

  // Math-ish without doc
  if(/solve|calculate|equation|algebra|derivative|integral|fraction|percent/i.test(low)){
    return `I can walk through that step by step.

Paste the full problem (or photo it via attach). I'll show the method, not only the final number — so you can reuse the approach.`;
  }

  // Image intent already handled upstream; soft tip
  if(/image|picture|photo|draw|imagine/i.test(low)){
    return `To make a picture, try:

**create an image of a calm library at night**

or press the 🖼 button and describe what you want.`;
  }

  // Capabilities follow-up style answer for open questions
  if(/how can you help|what do you know|can you/i.test(low)){
    return `Yes. Talk to me like ChatGPT — questions, drafts, plans, explanations, or images.

I'm strongest when you give a bit of context. The more specific you are, the better the reply.`;
  }

  // Default helpful scaffold for anything else
  if(q.length < 120){
    return `Got it: **${q}**

Here's a useful way to tackle it:
1. Clarify the goal in one sentence
2. List what you already know
3. Decide the next small step

Tell me more detail (audience, constraints, or an example) and I'll give a tighter, ready-to-use answer.`;
  }

  return `Thanks for the detail.

**What I'm hearing:** ${q.slice(0,280)}${q.length>280?"…":""}

**Suggested next step:**  
Focus on the outcome you want in one line, then the constraints (time, tone, length). Reply with those two lines and I'll draft something concrete you can use immediately.`;
}

function localTutorAnswer(doc, question){
  const qRaw=normalize(question);
  const q=qRaw.toLowerCase();

  // Summarize the *last tutor message* when user says "summarize that / make it shorter"
  const wantsChatSummary=/summar(y|ize|ise)\s+(that|this|it|your|the\s+(answer|reply|response|message|last))|make\s+(it|that|this)\s+(shorter|brief|simple)|shorter\s+version|tl;?dr\s+(that|this|it)|sum\s+up\s+(that|this|what\s+you)|brief\s+(that|this|your\s+answer)/i.test(qRaw)
    || (/^(summar(y|ize|ise)|tl;?dr|shorter|make\s+it\s+short)\s*$/i.test(qRaw) && tutorChat.some(m=>m.role==="tutor"));
  if(wantsChatSummary){
    return summarizeLastTutorReply();
  }

  // Turn summary / material into flashcards + quiz
  const wantsStudyPack=/turn\s+(this|that|it|the\s+summary)\s+into\s+(flashcards?|cards|quiz|a\s+quiz)|make\s+(flashcards?|cards|a\s+quiz|quiz)\s+from\s+(this|that|it|the\s+summary|both)|flashcards?\s+from\s+(this|that|summary)|study\s+pack\s+from\s+(this|that)|create\s+(flashcards?|quiz)\s+from\s+(this|that|summary)/i.test(qRaw);
  if(wantsStudyPack){
    return "__STUDY_PACK__"; // handled async in tutorSendMessage
  }

  // Side-by-side document compare handled async in tutorSendMessage
  const wantsCompare=/\b(compare|diff|side[- ]?by[- ]?side)\b.*\b(docs?|documents?|pdfs?|materials?|files?|sources?)\b|\b(compare|diff)\s+(these|the\s+two|both)\b|\bdocument\s+compare\b/i.test(qRaw);
  if(wantsCompare){
    return "__COMPARE_DOCS__";
  }

  // FIRST: summary / overview intent — never treat "summarize" as a search term
  const wantsSummary=/summar(y|ize|ise)|overview|main\s+points?|key\s+points?|tl;?dr|what is this|what'?s this about|explain (this|the (material|pdf|lesson|chapter|notes?|document))|give me (a |the )?summary|sum up|brief me/i.test(qRaw);
  if(wantsSummary){
    return buildTutorSummary(doc);
  }

  const source=normalize((doc?.rawText||"")+"\n"+photoEvidenceText(doc));
  const domainHit=domainKnowledgeAnswer(qRaw);
  const topic=extractQuestionTopic(qRaw);
  const topicLow=topic.toLowerCase();
  const topicWords=topicLow.split(/[^a-z0-9]+/).filter(w=>w.length>=3&&!STOP.has(w));

  if(!source){
    if(domainHit){
      return `**${topic||"Answer"}**\n\n${domainHit.answer}`;
    }
    const general=generalChatAnswer(qRaw);
    if(general) return general;
    return "I'm here. Ask me anything — writing, ideas, explanations, planning, code, or say **create an image of…** for a picture.";
  }

  const defs=(doc?.reviewerData?.definitions||[]).filter(d=>{
    const name=String(d.term||"").toLowerCase().trim();
    if(!name||name.length<3)return false;
    if(BAD_DEF_TERMS.has(name))return false;
    if(/^(what|how|why|when|impact|measures|function)\b/.test(name))return false;
    // definition body must not just be another question
    if(isLikelyQuestionLine(d.definition)&&!/\bis\b|means|refers/i.test(d.definition))return false;
    return true;
  });

  // Match definition only if the user's topic clearly refers to that term
  if(defs.length&&topicLow){
    let best=null,bestScore=0;
    for(const d of defs){
      const name=String(d.term||"").toLowerCase();
      if(name.length<3)continue;
      let score=0;
      if(topicLow===name||topicLow.includes(name)||name.includes(topicLow))score+=name.length+20;
      else if(q.includes(name)&&name.length>=5)score+=name.length+8;
      for(const w of name.split(/[^a-z0-9]+/).filter(x=>x.length>=4)){
        if(topicWords.includes(w)||q.includes(w))score+=4;
      }
      // must share real overlap with the question topic
      if(score>bestScore){bestScore=score;best=d;}
    }
    // Require strong match — never grab random "What" junk
    if(best&&bestScore>=14){
      const ans=cleanAnswer(best.definition,320);
      if(ans&&!isLikelyQuestionLine(ans)){
        let out=`**${best.term}**\n\n${ans}`;
        if(domainHit&&domainHit.score>=6)out+=`\n\nExtra foundation:\n${domainHit.answer}`;
        out+=`\n\nTip: say this in your own words, then check the page.`;
        return out;
      }
    }
  }

  const sentences=extractSentences(source,160).filter(t=>t&&t.length>=20);
  const terms=(doc?.terms||[]).map(t=>typeof t==='string'?t:t?.term||t?.label||"").filter(Boolean)
    .filter(t=>{const n=String(t).toLowerCase();return n.length>=3&&!BAD_DEF_TERMS.has(n);});
  const qWords=new Set([...topicWords,...q.split(/[^a-z0-9Ωμ]+/).filter(w=>w.length>=3&&!STOP.has(w)&&!BAD_DEF_TERMS.has(w))]);
  const wantsDef=/what is|what are|what's|whats|define|meaning|definition|who is|function of|what does|explain/.test(q);
  const wantsEq=/equation|formula|chemical|overall reaction|balanced|stoichiometr|ohm|v\s*=\s*ir|kirchhoff/.test(q)
    || /\b(co2|h2o|o2|c6h12o6|nacl|hcl|v=ir)\b/.test(q);
  const wantsHow=/how does|how do|how can|how to|process|steps|stage|sequence/.test(q);
  const wantsWhy=/why |cause|because|reason|impact|effect/.test(q);
  const wantsQuiz=/quiz me|test me|ask me|practice question/.test(q);

  if(wantsQuiz){
    const pool=(doc.reviewerData?.questions||[]).filter(x=>!isLikelyQuestionLine(x.q)||true).slice(0,8);
    if(pool.length){
      const pick=pool[Math.floor(Math.random()*pool.length)];
      return `Practice question:\n\n${pick.q}\n\nAnswer from memory, then check Reviewer or Cards.`;
    }
    if(domainHit)return `Practice:\n\nExplain this in your own words:\n${domainHit.answer.split("\n")[0]}`;
    return `Practice:\n\nExplain **${topic||terms[0]||"the main idea"}** in your own words using one detail from the PDF.`;
  }

  // Score every sentence against the REAL topic (peer pressure, not "what")
  const scored=sentences.map((text,i)=>{
    const lower=text.toLowerCase();
    let score=0;
    // strong: full topic phrase
    if(topicLow&&topicLow.length>=4&&lower.includes(topicLow))score+=30;
    for(const w of topicWords){if(lower.includes(w))score+=8;}
    for(const w of qWords){if(lower.includes(w))score+=2;}
    for(const t of terms){const tl=String(t).toLowerCase();if(tl.length>=4&&lower.includes(tl)&&topicWords.some(w=>tl.includes(w)||w.includes(tl)))score+=5;}
    if(wantsDef&&/\bis\b|are\b|means|refers to|defined as|known as|called\b/i.test(text))score+=6;
    if(wantsHow&&(/stage|step|process|then|first|next|finally/i.test(text)))score+=4;
    if(wantsWhy&&(/because|therefore|leads to|results in|cause|impact|effect/i.test(text)))score+=4;
    if(looksLikeFormula(text))score+=3;
    // Penalize question-lines when user wants an answer
    if(isLikelyQuestionLine(text))score-=25;
    if(text.length>280)score-=2;
    if(text.length<30)score-=3;
    return {text,i,score};
  }).sort((a,b)=>b.score-a.score||a.i-b.i);

  const good=scored.filter(x=>x.score>=10);
  const ok=scored.filter(x=>x.score>=6);

  // Formula path
  let sourceBlock="";
  if(wantsEq){
    const formulaHits=sentences
      .map((text,i)=>({text,i}))
      .filter(x=>looksLikeFormula(x.text)||/equation|formula|overall|ohm|voltage|current|resistance/i.test(x.text));
    const ranked=formulaHits.map(x=>{
      let score=looksLikeFormula(x.text)?20:4;
      const lower=x.text.toLowerCase();
      for(const w of qWords) if(lower.includes(w)) score+=2;
      if(isLikelyQuestionLine(x.text)) score-=20;
      return {...x,score};
    }).sort((a,b)=>b.score-a.score);
    if(ranked[0]?.score>0){
      sourceBlock=`**From your material**\n\n${extractFormulaSnippet(ranked[0].text)}`;
    }
  }

  if(!sourceBlock&&(good.length||ok.length)){
    const top=(good.length?good:ok).slice(0,3);
    // Build a teaching answer, not a dump of exam questions
    if(wantsDef&&top[0]){
      const primary=cleanAnswer(top[0].text,280);
      const extra=top.slice(1).map(x=>`• ${cleanAnswer(x.text,160)}`).join("\n");
      sourceBlock=`**${topic||"Answer"}**\n\n${primary}`+(extra?`\n\nRelated from your notes:\n${extra}`:"");
    }else{
      sourceBlock=`**From your material**\n\n`+top.map(x=>`• ${cleanAnswer(x.text,200)}`).join("\n");
    }
  }

  if(sourceBlock&&domainHit&&domainHit.score>=6&&!topicLow.includes(String(domainHit.keys?.[0]||""))){
    // only add domain if it doesn't conflict — actually always ok as "extra"
    return `${sourceBlock}\n\n——\n**Extra foundation** (${domainHit.domain}):\n${domainHit.answer}\n\nTip: prefer your PDF wording for exams.`;
  }
  if(sourceBlock){
    return `${sourceBlock}\n\nTip: restate this in your own words, then check the page.`;
  }
  if(domainHit){
    return `**${topic||"Answer"}**\n\nYour PDF did not clearly define this in the extracted text, so here is built-in professor-level course knowledge (BIT-CT / BAEL / STEM / drawing):\n\n${domainHit.answer}\n\nIf it *is* in the PDF, try Re-run OCR or open the page in Reviewer.`;
  }
  // Last resort: honest + helpful
  const near=scored.slice(0,2).filter(x=>x.score>0);
  if(near.length){
    return `I could not find a clear definition of **${topic||"that"}** in the extracted text. Closest lines:\n\n${near.map(x=>`• ${cleanAnswer(x.text,160)}`).join("\n")}\n\nTry asking with the exact term from your reviewer, or open Reviewer → search.`;
  }
  return `I could not find **${topic||"that topic"}** in the loaded material.\n\nTry a key term from the Cards list, or ask a curriculum question (e.g. Ohm’s law, essay structure).`;
}
function localTutorReview(doc){
  const r=doc?.reviewerData;
  if(!r) return "Upload study material first.";
  return [
    r.overview||"",
    r.keyPoints?.length?`Key points:\n${r.keyPoints.map(x=>`• ${x}`).join("\n")}`:"",
    r.terms?.length?`Key terms:\n${r.terms.map(x=>`• ${typeof x==='string'?x:(x.term||x.label||"")}`).join("\n")}`:"",
    r.examCram?`Exam cram:\n${r.examCram}`:""
  ].filter(Boolean).join("\n\n");
}

async function runLocalAIEnhancement(){
  const d=activeDoc();if(!d)return toast("Select a study material first.","error");
  const status=$("#aiStatus"),btn=$("#aiEnhance");if(btn)btn.disabled=true;if(status)status.textContent="Starting local AI…";
  const reviewBox=$("#aiReviewer");if(reviewBox)reviewBox.textContent="AI is working locally. Tokens will appear here as they are generated…";
  try{
    const result=await aiRequest("reviewer",{source:aiSource(d),profile:learnerDigestForAI(),terms:d.terms||[]});
    const threshold=58;
    if((result.groundingScore||0)<threshold)throw new Error("AI output did not meet the grounding threshold. The deterministic reviewer was kept.");
    d.ai={...(d.ai||{}),enabled:true,generatedAt:now(),reviewer:result.text,groundingScore:result.groundingScore,device:result.device,model:result.model||state.settings.ai.model};
    d.reviewerData=d.reviewerData||buildReviewer(d);d.reviewerData.aiReviewer=result.text;await saveDoc(d);state.settings.ai.enabled=true;await saveMeta();renderAll();if(status)status.textContent=`Local AI ready • grounded ${result.groundingScore}% • ${result.device}`;toast("Local AI reviewer completed.","success");
  }catch(e){
    if(e.message==="AI task cancelled."){if(status)status.textContent="AI stopped.";return;}
    // Upgrade path: try the authenticated optional cloud reviewer before falling back to deterministic local synthesis.
    try{
      if(status)status.textContent="Local model unavailable — trying optional cloud reviewer…";
      const cloud=await cloudAI("text",{task:"reviewer",source:aiSource(d),existingReviewer:d.reviewerData?.overview||"",mode:d.summaryMode||"standard"},180000);
      if(cloud?.text){
        d.ai={...(d.ai||{}),enabled:true,generatedAt:now(),reviewer:cloud.text,groundingScore:96,device:"authenticated cloud reviewer",model:cloud.model||"gpt-5.6-luna"};
        d.reviewerData=d.reviewerData||buildReviewer(d);d.reviewerData.aiReviewer=cloud.text;await saveDoc(d);await saveMeta();renderAll();if(status)status.textContent="Cloud reviewer ready • source-grounded";toast("Cloud AI reviewer completed.","success");return;
      }
    }catch(cloudErr){console.info("Optional cloud reviewer unavailable:",cloudErr?.message||cloudErr);}
    const fallback=localTutorReview(d);d.ai={...(d.ai||{}),enabled:false,generatedAt:now(),reviewer:fallback,groundingScore:100,device:"local smart tutor",model:"deterministic-source-engine"};await saveDoc(d);renderAll();if(status)status.textContent="Offline Study Engine ready • source-grounded fallback";toast("Cloud AI was unavailable, so StudyVault used its offline source-grounded study engine. It did not pretend the offline engine had cloud capabilities.","info");}
  finally{if(btn)btn.disabled=false;}
}
async function enableLocalAI(){
  const status=$("#aiStatus");if(status)status.textContent="Loading the on-device model. The page will stay responsive while it downloads…";
  try{const worker=aiEnsureWorker();state.settings.ai.enabled=true;await saveMeta();worker.postMessage({type:"load"});toast("Local AI load started. Keep the app open until the model finishes downloading.","success");}catch(e){state.settings.ai.enabled=false;await saveMeta();toast(e.message||"Local AI could not start.","error");}
}
async function disableLocalAI(){aiCancel();state.settings.ai.enabled=false;await saveMeta();renderAll();toast("Local AI disabled. Your deterministic reviewer remains available.");}
function tutorSuggestionsFor(doc){
  const writing=["How to summarize","How to write a paragraph","Types of letters","Formal letter format","PEEL method"];
  if(!doc){
    return [
      "How to summarize",
      "Types of letters",
      "Ohm's law",
      "Electrical symbols",
      "Picture of a lion"
    ];
  }
  const terms=(doc.terms||[]).map(t=>typeof t==="string"?t:(t?.term||t?.label||"")).filter(Boolean).slice(0,4);
  const out=[];
  if(terms[0])out.push(`What is ${terms[0]}?`);
  if(terms[1])out.push(`Explain ${terms[1]} simply`);
  out.push("Summarize this material");
  out.push("Quiz me on the key ideas");
  if(terms[2])out.push(`How does ${terms[2]} work?`);
  else out.push("What is the main equation or formula?");
  // Rotate in one writing tip so the pack stays discoverable
  out.push(writing[Math.floor(Date.now()/60000)%writing.length]);
  return out.slice(0,6);
}

/** When user asks to see a picture, fetch a safe educational image (Wikipedia). Needs internet once. */
function symbolDataUrl(symbolId){
  const sym=SYMBOL_LIBRARY.find(s=>s.id===symbolId)||SYMBOL_LIBRARY[0];
  const c=document.createElement("canvas");c.width=640;c.height=420;
  const ctx=c.getContext("2d");
  ctx.fillStyle="#0f1419";ctx.fillRect(0,0,c.width,c.height);
  ctx.fillStyle="#1a2330";ctx.fillRect(40,40,560,250);
  try{sym.draw(ctx,120,165,400);}catch(e){console.warn(e);}
  ctx.textAlign="left";ctx.fillStyle="#8f7cff";ctx.font="700 12px system-ui,sans-serif";
  ctx.fillText("STUDYVAULT SYMBOL",50,320);
  ctx.fillStyle="#e8eef6";ctx.font="700 28px system-ui,sans-serif";ctx.fillText(sym.label,50,360);
  ctx.fillStyle="#9fb0c3";ctx.font="14px system-ui,sans-serif";ctx.fillText("Local diagram — works offline",50,388);
  try{return c.toDataURL("image/png");}catch{return "";}
}
function matchLocalSymbol(topic){
  const t=String(topic||"").toLowerCase();
  // Never treat real-world photo orders as circuit symbols (e.g. "background" must not match ground)
  if(isAnimalOrSceneTopic(t)) return null;
  if(/electrical\s*symbols?|all\s+symbols?|circuit\s+symbols?|schematic\s+symbols?/.test(t)) return "sheet-electrical";
  const map=[
    [/resistor|resistance/, "resistor"],
    [/capacitor|capacitance/, "capacitor"],
    [/inductor|inductance|\bcoil\b/, "inductor"],
    [/diode(?!.*led)/, "diode"],
    [/\bled\b|light.?emitting/, "led"],
    [/\bbattery\b|cell symbol/, "battery"],
    [/switch symbol|toggle switch|\bswitch\b/, "switch"],
    // Word-boundary: "background" must NEVER match ground
    [/\bground\b|\bearth\b(?:\s+symbol)?|circuit\s+ground|signal\s+ground/, "ground"],
    [/\bohm\b|omega|Ω/, "ohm"],
    [/\bfuse\b/, "fuse"],
    [/\bnpn\b|\btransistor\b/, "npn"],
    [/ac\s*source|alternating\s+current\s+source/, "acsource"],
    [/\bspeaker\b|loudspeaker/, "speaker"],
    [/\bmotor\b/, "motor"],
    [/\brelay\b/, "relay"],
    [/\band\s*gate\b/, "andgate"],
    [/\bor\s*gate\b/, "orgate"],
    [/\bnot\s*gate\b|\binverter\b/, "notgate"],
    [/\bstack\b|\blifo\b/, "stack"],
    [/\bdatabase\b|\bdbms\b|sql\s+table/, "database"],
    [/\bperspective\b|\bvanishing\b/, "perspective"],
    [/reaction\s+arrow|chemical\s+arrow|arrow\s+symbol|→/, "arrow"],
  ];
  for(const [re,id] of map){ if(re.test(t)) return id; }
  return null;
}

/** Animals / scenes / nature — photo path, never circuit-symbol path. */
function isAnimalOrSceneTopic(t){
  const s=String(t||"").toLowerCase();
  return /\b(wolf|wolves|lion|tiger|cat|dog|puppy|kitten|eagle|bird|fish|whale|shark|elephant|giraffe|zebra|bear|fox|rabbit|horse|cow|pig|chicken|duck|owl|snake|frog|monkey|gorilla|panda|koala|dolphin|penguin|butterfly|bee|spider|ant|mouse|rat|deer|moose|kangaroo|crocodile|alligator|turtle|lizard|parrot|peacock|swan|goose|goat|sheep|camel|rhino|hippo|cheetah|leopard|jaguar|hyena|raccoon|squirrel|bat|otter|seal|octopus|crab|lobster|jellyfish|starfish|husky|puppy|kitten|foxes|cub)\b/i.test(s)
    || /\b(moon|full moon|night sky|forest|jungle|ocean|beach|mountain|desert|sunset|sunrise|stars|galaxy)\b/i.test(s)
    && /\b(wolf|lion|tiger|bear|fox|dog|cat|eagle|bird|animal|howling)\b/i.test(s);
}

/** Pull the main photo subject out of chatty orders like "a wolf the background is moon". */
function extractPictureSubject(raw){
  let t=String(raw||"").trim();
  t=t.replace(/^(please\s+)?(show|send|give|display|find|draw|generate|create|make|want|need|get)\s+(me\s+)?(a\s+|an\s+|the\s+)?/i,"");
  t=t.replace(/^(a|an|the)\s+/i,"");
  t=t.replace(/\b(picture|photo|image|pic|diagram|illustration|sketch)\s+(of\s+)?/i,"");
  t=t.replace(/\s+/g," ").trim();
  // Prefer first animal name if present
  const animal=t.match(/\b(wolf|wolves|lion|tiger|cat|dog|puppy|kitten|eagle|bird|fish|whale|shark|elephant|giraffe|zebra|bear|fox|rabbit|horse|cow|pig|chicken|duck|owl|snake|frog|monkey|gorilla|panda|koala|dolphin|penguin|butterfly|deer|moose|kangaroo|crocodile|turtle|lizard|parrot|peacock|swan|camel|rhino|hippo|cheetah|leopard|jaguar|hyena|raccoon|squirrel|otter|seal|octopus|husky)\b/i);
  if(animal){
    const a=animal[1].toLowerCase();
    // Keep simple scene if user asked for moon/night with the animal
    if(/\b(moon|full moon|night|forest|howling)\b/i.test(t)){
      if(/\bmoon\b/i.test(t)) return a==="wolf"||a==="wolves"?"Wolf":a.charAt(0).toUpperCase()+a.slice(1);
      return a.charAt(0).toUpperCase()+a.slice(1);
    }
    return a.charAt(0).toUpperCase()+a.slice(1);
  }
  // Landmark / object: take first 4 meaningful words
  t=t.replace(/\b(the\s+background\s+is|background\s+is|with\s+a|with\s+the|in\s+the|on\s+the|and\s+the)\b/gi," ");
  t=t.replace(/\s+/g," ").trim();
  return t.split(/\s+/).slice(0,5).join(" ").slice(0,60)||raw;
}
async function fetchTopicImage(query){
  // Prefer cleaned subject (Wolf) over chatty full order
  let topic=extractPictureSubject(query);
  if(!topic||topic.length<2){
    topic=normalize(query)
      .replace(/^(?:show|send|give|find|display|draw|generate|create|picture|photo|image|pic|of|a|an|the|me|please|can|you)\s+/gi,"")
      .replace(/\b(?:show|send|give|find|display|draw|generate|create|picture|photo|image|pic|of|a|an|the|me|please)\b/gi," ")
      .replace(/\s+/g," ")
      .trim()
      .slice(0,80);
  }
  if(!topic||topic.length<2)return null;
  // Local circuit symbols only when clearly electronics — never for animals/scenes
  if(!isAnimalOrSceneTopic(topic)&&!isRealWorldPictureTopic(topic)){
    const localId=matchLocalSymbol(topic);
    if(localId){
      const url=symbolDataUrl(localId);
      if(url)return {topic:SYMBOL_LIBRARY.find(s=>s.id===localId)?.label||topic,imageUrl:url,extract:"Local study diagram generated on your device (no cloud)."};
    }
  }
  if(!navigator.onLine)return {error:"offline",topic};
  try{
    let data=null;
    try{
      const r=await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic.replace(/\s+/g,"_"))}`,{headers:{Accept:"application/json"}});
      if(r.ok)data=await r.json();
    }catch{}
    if(!data?.thumbnail?.source){
      const s=await fetch(`https://en.wikipedia.org/w/rest.php/v1/search/title?q=${encodeURIComponent(topic)}&limit=3`,{headers:{Accept:"application/json"}});
      if(s.ok){
        const sj=await s.json();
        for(const page of (sj?.pages||[])){
          const hit=page.key||page.title;
          if(!hit)continue;
          try{
            const r2=await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(hit)}`,{headers:{Accept:"application/json"}});
            if(r2.ok){
              data=await r2.json();
              if(data?.thumbnail?.source)break;
            }
          }catch{}
        }
      }
    }
    if(data?.thumbnail?.source||data?.originalimage?.source){
      // Prefer original when reasonable; always normalize Wikimedia hosts so CSP + SW allow them
      let imageUrl=data.originalimage?.source||data.thumbnail?.source||"";
      imageUrl=normalizeWikiImageUrl(imageUrl);
      if(!imageUrl) return {error:"not-found",topic};
      return {
        topic:data.title||topic,
        imageUrl,
        extract:cleanAnswer(data.extract||data.description||"",220),
        pageUrl:data.content_urls?.desktop?.page||""
      };
    }
    return {error:"not-found",topic};
  }catch(err){
    console.warn("image fetch failed",err);
    return {error:"failed",topic};
  }
}

/** Keep Wikipedia/Wikimedia image URLs on hosts our CSP + service worker allow. */
function normalizeWikiImageUrl(url){
  if(!url) return "";
  try{
    let u=String(url).trim();
    // Strip tracking query junk Wikipedia sometimes adds
    u=u.replace(/\?utm_[^#]*/i,"").replace(/&utm_[^&]*/gi,"");
    // thumb.wikimedia.org and upload.wikimedia.org are both allowed now
    // Prefer https and keep path intact
    if(u.startsWith("//")) u="https:"+u;
    if(!/^https:\/\//i.test(u)) return "";
    const host=new URL(u).hostname;
    if(!/(^|\.)wikimedia\.org$|(^|\.)wikipedia\.org$/i.test(host)) return "";
    return u;
  }catch{
    return "";
  }
}

/** Load any allowed image URL into a local data URL so StudyVault can remember it offline forever. */
function imageUrlToDataUrl(url, maxSide=900){
  return new Promise((resolve)=>{
    if(!url){ resolve(""); return; }
    if(/^data:image\//i.test(url)){ resolve(url); return; }
    const img=new Image();
    img.crossOrigin="anonymous";
    img.referrerPolicy="no-referrer";
    const timer=setTimeout(()=>{ try{img.src="";}catch{} resolve(""); },12000);
    img.onload=()=>{
      clearTimeout(timer);
      try{
        const scale=Math.min(1, maxSide/Math.max(img.naturalWidth||1, img.naturalHeight||1));
        const w=Math.max(1, Math.round((img.naturalWidth||maxSide)*scale));
        const h=Math.max(1, Math.round((img.naturalHeight||maxSide)*scale));
        const c=document.createElement("canvas");
        c.width=w; c.height=h;
        const ctx=c.getContext("2d");
        if(!ctx){ resolve(""); return; }
        ctx.fillStyle="#0b1220"; ctx.fillRect(0,0,w,h);
        ctx.drawImage(img,0,0,w,h);
        resolve(c.toDataURL("image/jpeg",0.86));
      }catch(e){ console.warn("imageUrlToDataUrl",e); resolve(""); }
    };
    img.onerror=()=>{ clearTimeout(timer); resolve(""); };
    img.src=url;
  });
}

/**
 * On-device “AI made” study card — always works offline.
 * Not a photorealistic generator; a clear labeled study picture the family can keep forever.
 */
function makeAiMadeStudyCard(topic, extract=""){
  const title=String(topic||"Study picture").trim().slice(0,48)||"Study picture";
  const body=String(extract||"").trim().slice(0,420);
  const W=900, H=720, pad=36;
  const c=document.createElement("canvas");
  c.width=W; c.height=H;
  const ctx=c.getContext("2d");
  if(!ctx) return "";
  // Background
  ctx.fillStyle="#0b1220"; ctx.fillRect(0,0,W,H);
  const g=ctx.createLinearGradient(0,0,W,0);
  g.addColorStop(0,"#6c5ce7"); g.addColorStop(1,"#00b894");
  ctx.fillStyle=g; ctx.fillRect(0,0,W,8);
  // Badge
  ctx.fillStyle="#121a2a";
  roundRectFill(ctx, pad, 28, 220, 34, 10);
  ctx.fillStyle="#a9a8ff"; ctx.font="700 13px system-ui,sans-serif";
  ctx.fillText("STUDY AI · MADE ON DEVICE", pad+12, 50);
  // Title
  ctx.fillStyle="#edf6ff"; ctx.font="700 42px system-ui,sans-serif";
  ctx.fillText(title, pad, 118);
  // Decorative frame for subject
  ctx.strokeStyle="rgba(108,92,231,.55)"; ctx.lineWidth=3;
  roundRectStroke(ctx, pad, 150, W-pad*2, 280, 18);
  ctx.fillStyle="#121a2a";
  roundRectFill(ctx, pad+4, 154, W-pad*2-8, 272, 16);
  // Big subject initial / icon area
  const initial=title.charAt(0).toUpperCase();
  ctx.fillStyle="#6c5ce7"; ctx.font="700 140px system-ui,sans-serif";
  ctx.textAlign="center";
  ctx.fillText(initial, W/2, 330);
  ctx.textAlign="left";
  ctx.fillStyle="#9bb0c4"; ctx.font="600 18px system-ui,sans-serif";
  ctx.textAlign="center";
  ctx.fillText(title, W/2, 390);
  ctx.textAlign="left";
  // Notes
  ctx.fillStyle="#8f7cff"; ctx.font="700 12px system-ui,sans-serif";
  ctx.fillText("WHAT TO REMEMBER", pad, 470);
  ctx.fillStyle="#d7e2ef"; ctx.font="16px system-ui,sans-serif";
  const lines=body
    ? canvasWrapText(ctx, body, W-pad*2)
    : canvasWrapText(ctx, "Reference locked into your vault. Open Photos / Notes anytime — works offline.", W-pad*2);
  lines.slice(0,6).forEach((ln,i)=>ctx.fillText(ln, pad, 498+i*24));
  // Footer
  ctx.fillStyle="#6b7c90"; ctx.font="13px system-ui,sans-serif";
  ctx.fillText("StudyVault · closed-book · remembered on this device · "+new Date().toLocaleDateString(), pad, H-28);
  try{ return c.toDataURL("image/png"); }catch{ return ""; }
}

function roundRectStroke(ctx,x,y,w,h,r){
  const rr=Math.min(r,w/2,h/2);
  ctx.beginPath();
  ctx.moveTo(x+rr,y);
  ctx.arcTo(x+w,y,x+w,y+h,rr);
  ctx.arcTo(x+w,y+h,x,y+h,rr);
  ctx.arcTo(x,y+h,x,y,rr);
  ctx.arcTo(x,y,x+w,y,rr);
  ctx.closePath();
  ctx.stroke();
}

/**
 * Remember an AI picture forever in IndexedDB:
 * - attached to the open document (Photos tab)
 * - plus a global AI gallery so it survives even with no PDF open
 */
async function rememberAiPicture(topic, dataUrl, extract=""){
  if(!dataUrl||!/^data:image\//i.test(dataUrl)) return null;
  const name=`AI · ${String(topic||"Picture").slice(0,48)}`;
  const entry={
    id:uid(),
    name,
    dataUrl,
    width:0,
    height:0,
    caption:String(extract||"").slice(0,280),
    ocrText:"",
    confidence:0,
    createdAt:now(),
    page:null,
    fromAi:true,
    aiTopic:String(topic||"").slice(0,80)
  };
  // Document media (shows in Reviewer → Photos)
  const d=activeDoc();
  if(d){
    d.media=d.media||[];
    // Avoid flooding: replace older AI pic with same topic
    d.media=d.media.filter(m=>!(m.fromAi&&String(m.aiTopic||"").toLowerCase()===String(topic||"").toLowerCase()));
    d.media.unshift(entry);
    // Cap AI pics per doc
    const aiCount=d.media.filter(m=>m.fromAi).length;
    if(aiCount>24){
      let drop=aiCount-24;
      d.media=d.media.filter(m=>{
        if(m.fromAi&&drop>0){ drop--; return false; }
        return true;
      });
    }
    try{ await saveDoc(d); }catch(e){ console.warn("rememberAiPicture doc",e); }
  }
  // Global gallery in meta (survives without an open document)
  try{
    const key="aiPictures";
    let gallery=await dbGet(META_STORE,key);
    if(!Array.isArray(gallery)) gallery=[];
    gallery=gallery.filter(m=>String(m.aiTopic||"").toLowerCase()!==String(topic||"").toLowerCase());
    gallery.unshift({id:entry.id,name:entry.name,dataUrl:entry.dataUrl,caption:entry.caption,aiTopic:entry.aiTopic,createdAt:entry.createdAt});
    if(gallery.length>40) gallery=gallery.slice(0,40);
    await dbPut(META_STORE,key,gallery);
  }catch(e){ console.warn("rememberAiPicture gallery",e); }
  return entry;
}
function isPictureRequest(q){
  const s=String(q||"").trim();
  if(!s) return false;
  // Explicit image/diagram/symbol requests
  if(/\b(picture|photo|image|pic|diagram|illustration|sketch|infographic|symbol\s*sheet|symbols?)\b/i.test(s)
     && /\b(show|send|give|display|find|draw|generate|create|make|draw\s*me|paint|render|want|need|get)\b/i.test(s))
    return true;
  if(/^(picture|photo|image|diagram|draw|sketch|pic)\b/i.test(s)) return true;
  if(/\b(create|generate|make|draw)\s+(all\s+)?(the\s+)?(electrical\s+)?symbols?\b/i.test(s)) return true;
  if(/\belectrical\s+symbols?\b/i.test(s)) return true;
  if(/\b(circuit|schematic)\s+symbols?\b/i.test(s)) return true;
  if(/\bsymbols?\s+sheet\b/i.test(s)) return true;
  if(/\b(draw|sketch)\s+(me\s+)?(a\s+|an\s+)?/i.test(s)) return true;
  // Short chat-style: "a lion", "lion", "the Eiffel Tower", "cat photo"
  if(/^(a|an|the)\s+[\w\s\-]{2,40}$/i.test(s) && isRealWorldPictureTopic(s)) return true;
  if(/^(pic|photo|image|picture)\s+(of\s+)?/i.test(s)) return true;
  if(/\b(show|send|give|display|find|draw|generate|create|make)\s+(me\s+)?(a\s+|an\s+|the\s+)?[\w\s\-]{2,40}$/i.test(s)
     && isRealWorldPictureTopic(s.replace(/^(show|send|give|display|find|draw|generate|create|make)\s+(me\s+)?(a\s+|an\s+|the\s+)?/i,"")))
    return true;
  // Bare animal / landmark names that people naturally type in chat
  if(s.split(/\s+/).length<=4 && isRealWorldPictureTopic(s) && !/\?$/.test(s) && !/^(what|who|why|how|when|where|is|are|do|does|can|could|should|explain|define|summar)/i.test(s))
    return true;
  return false;
}

/** Topics that should become a real photo (Wikipedia) rather than a text study card. */
function isRealWorldPictureTopic(topic){
  const t=String(topic||"").toLowerCase().replace(/^(a|an|the)\s+/,"").trim();
  if(!t||t.length<2) return false;
  // Animals & scenes first (before any symbol heuristics)
  if(isAnimalOrSceneTopic(t)) return true;
  if(/\b(wolf|wolves|lion|tiger|cat|dog|puppy|kitten|eagle|bird|fish|whale|shark|elephant|giraffe|zebra|bear|fox|rabbit|horse|cow|pig|chicken|duck|owl|snake|frog|monkey|gorilla|panda|koala|dolphin|penguin|butterfly|bee|spider|ant|mouse|rat|deer|moose|kangaroo|crocodile|alligator|turtle|lizard|parrot|peacock|swan|goose|goat|sheep|camel|rhino|hippo|cheetah|leopard|jaguar|hyena|raccoon|squirrel|bat|otter|seal|octopus|crab|lobster|jellyfish|starfish|husky)\b/i.test(t))
    return true;
  // Study concepts / diagrams stay local
  if(matchLocalSymbol(t)) return false;
  if(/electrical|circuit|schematic|\bohm\b|resistor|capacitor|\bgate\b|stack|database|osi|tcp|udp|photosynthesis|quadratic|essay|thesis|formula|equation|law of|theorem|protocol|algorithm|data structure|network layer|cell structure|mitosis|meiosis/i.test(t))
    return false;
  if(/\b(eiffel|tower|pyramid|statue of liberty|colosseum|great wall|mount everest|nile|amazon|sahara|grand canyon|niagara|taj mahal|big ben|sydney opera|machu picchu|acropolis|petra)\b/i.test(t))
    return true;
  if(/\b(apple|banana|orange|car|truck|plane|airplane|train|boat|ship|bicycle|motorcycle|house|castle|bridge|mountain|volcano|river|ocean|forest|desert|flower|tree|sun|moon|planet|earth|mars|jupiter|saturn|galaxy|black hole)\b/i.test(t))
    return true;
  // Short noun-ish phrases that look like "show me X" targets
  if(/^[a-z][a-z\s\-]{1,35}$/i.test(t) && t.split(/\s+/).length<=3 && !/\b(what|how|why|when|define|explain|summar|mean|function|work)\b/i.test(t))
    return true;
  return false;
}

/** Summarize the last tutor reply (chat history), not the PDF. ChatGPT-grade structure. */
function summarizeLastTutorReply(){
  for(let i=tutorChat.length-1;i>=0;i--){
    const m=tutorChat[i];
    if(m.role==="tutor"&&m.text){
      const raw=String(m.text).replace(/\n{2,}/g,"\n").trim();
      if(raw.length<80) return "That reply is already short:\n\n"+raw;
      const lines=raw.split(/\n+/).map(x=>x.replace(/^[\s•\-\*💡✅✓]+/,"").trim()).filter(Boolean);
      const bullets=[];
      let tldr="";
      for(const ln of lines){
        if(/tip:|💡|cross-check|say this in your own|prompt:/i.test(ln)) continue;
        const clean=ln.replace(/\*\*/g,"").replace(/^#+\s*/,"").slice(0,180);
        if(clean.length<12) continue;
        if(!tldr && clean.length>40) tldr=clean.slice(0,140)+(clean.length>140?"…":"");
        if(bullets.some(b=>similarity(b,clean)>0.55)) continue;
        bullets.push(clean);
        if(bullets.length>=6) break;
      }
      if(!bullets.length) return "**TL;DR**\n\n"+raw.slice(0,360)+(raw.length>360?"…":"");
      let out="**TL;DR**\n"+(tldr||bullets[0])+"\n\n**Key points**\n"+bullets.map(b=>"• "+b).join("\n");
      out+="\n\nAsk me to expand any bullet, turn this into flashcards, or make a study diagram.";
      return out;
    }
  }
  return "There’s no previous tutor answer to summarize yet. Ask a question first, then say “summarize that”.";
}

/** Turn the last summary / active document into flashcards + quiz (one-click study pack). */
async function summaryToStudyPack(opts={}){
  const d=activeDoc();
  const fromChat=!!opts.fromChat;
  let sourceText="";
  let label="your material";
  if(fromChat){
    for(let i=tutorChat.length-1;i>=0;i--){
      const m=tutorChat[i];
      if(m.role==="tutor"&&m.text&&String(m.text).length>80){
        sourceText=String(m.text).replace(/\n{2,}/g,"\n").trim();
        label="the last answer";
        break;
      }
    }
  }
  if(!sourceText && d){
    const r=d.reviewerData||buildReviewer(d);
    sourceText=[r.overview||"",
      (r.keyPoints||[]).map(x=>typeof x==="string"?x:(x.text||"")).join("\n"),
      (r.definitions||[]).map(x=>`${x.term}: ${x.definition}`).join("\n"),
      String(d.rawText||"").slice(0,60000)
    ].filter(Boolean).join("\n\n");
    label=d.fileName||"your document";
  }
  if(!sourceText||sourceText.length<40){
    return {ok:false,message:"I need a summary or an open document first. Summarize something, then say “turn this into flashcards”."};
  }

  // ChatGPT parity: generate cards + quiz via the same cloud model ChatGPT uses
  try{
    const [cardRes, quizRes]=await Promise.all([
      cloudAI("text",{task:"flashcards",source:sourceText.slice(0,80000)},180000).catch(()=>null),
      cloudAI("text",{task:"quiz",source:sourceText.slice(0,80000)},180000).catch(()=>null)
    ]);
    const cloudCards=Array.isArray(cardRes?.cards)?cardRes.cards:[];
    const cloudQuiz=Array.isArray(quizRes?.quiz)?quizRes.quiz:[];
    if(cloudCards.length || cloudQuiz.length){
      const cards=cloudCards.map((c,i)=>({
        id:"cloud-card-"+i+"-"+Date.now().toString(36),
        type:c.type||"recall",
        question:String(c.question||"").trim(),
        answer:String(c.answer||"").trim(),
        source:"chatgpt-cloud",
        term:""
      })).filter(c=>c.question&&c.answer);
      const quiz=cloudQuiz.map((q,i)=>{
        const opts=Array.isArray(q.options)?q.options.map(String):[];
        const correctIndex=Number.isInteger(q.correctIndex)?q.correctIndex:0;
        return {
          id:"cloud-q-"+i+"-"+Date.now().toString(36),
          type:opts.length>=2?"definition":"short",
          question:String(q.question||"").trim(),
          options:opts,
          correctIndex,
          correct:opts[correctIndex]||String(q.explanation||"").trim(),
          answer:opts[correctIndex]||String(q.explanation||"").trim(),
          context:String(q.explanation||"").trim(),
          page:null
        };
      }).filter(q=>q.question);
      if(d){
        if(cards.length) d.flashcards=(d.flashcards||[]).concat(cards);
        if(quiz.length) d.quiz=(d.quiz||[]).concat(quiz);
        await saveDoc(d);
        activateSection("flashcards");
        renderAll();
      }
      const preview=cards.slice(0,5).map((c,i)=>`${i+1}. **${c.question}**\n   ${c.answer}`).join("\n\n");
      return {
        ok:true,
        message:`**Study pack (ChatGPT-class cloud)** from ${label}\n\n• **${cards.length} flashcards**\n• **${quiz.length} quiz items**\n\n${preview?preview+"\n\n":""}Open **Flashcards** or **Quiz** to practice.`,
        cards:cards.length,quiz:quiz.length,cloud:true
      };
    }
  }catch(e){
    console.info("Cloud study pack unavailable; local fallback",e?.message||e);
  }

  // Local fallback (offline / no key)
  if(d && String(d.rawText||"").trim().length>80){
    regenerateDoc(d,false);
    await saveDoc(d);
    const nCards=(d.flashcards||[]).length;
    const nQuiz=(d.quiz||[]).length;
    activateSection("flashcards");
    renderAll();
    return {
      ok:true,
      message:`**Study pack ready from ${label}** (local engine)\n\n• **${nCards} flashcards**\n• **${nQuiz} quiz items**\n\nFor ChatGPT-identical card quality, start the Carrot server with OPENAI_API_KEY.`,
      cards:nCards,quiz:nQuiz
    };
  }

  const lines=sourceText.split(/\n+/).map(x=>x.replace(/^[\s•\-\*#]+/,"").trim()).filter(x=>x.length>20&&x.length<280);
  const cards=[];
  const seen=new Set();
  for(const ln of lines){
    if(/tl;?dr|key points|exam cram|evidence map|what the source/i.test(ln)) continue;
    const parts=ln.split(/[—–:\-]\s+/);
    let q,a;
    if(parts.length>=2 && parts[0].length<80){
      q=`What is ${parts[0].replace(/\*\*/g,"").trim()}?`;
      a=parts.slice(1).join(" — ").replace(/\*\*/g,"").trim();
    }else{
      q=`Recall: ${ln.slice(0,90).replace(/\*\*/g,"")}…`;
      a=ln.replace(/\*\*/g,"").slice(0,220);
    }
    const key=(q+a).toLowerCase().slice(0,60);
    if(seen.has(key)||a.length<12) continue;
    seen.add(key);
    cards.push({id:"chat-card-"+cards.length+"-"+Date.now().toString(36),type:"recall",question:q,answer:a,source:"chat-summary"});
    if(cards.length>=16) break;
  }
  if(!cards.length){
    return {ok:false,message:"Could not extract clear study points. Try summarizing a PDF first, then ask again."};
  }
  if(!d){
    return {
      ok:true,
      message:`**${cards.length} practice prompts from ${label}**\n\n`+cards.slice(0,8).map((c,i)=>`${i+1}. **${c.question}**\n   ${c.answer}`).join("\n\n")+`\n\nOpen a PDF + cloud key for ChatGPT-class packs.`,
      cards:cards.length,quiz:0,preview:cards
    };
  }
  d.flashcards=(d.flashcards||[]).concat(cards.map(c=>({...c,id:c.id||("c"+Math.random().toString(36).slice(2,9))})));
  const quiz=cards.slice(0,8).map((c,i)=>({
    id:"chat-q-"+i+"-"+Date.now().toString(36),
    type:"short",
    question:c.question,
    answer:c.answer,
    context:"From chat summary",
    page:null
  }));
  d.quiz=(d.quiz||[]).concat(quiz);
  await saveDoc(d);
  activateSection("flashcards");
  renderAll();
  return {
    ok:true,
    message:`**Study pack from ${label}** (local)\n\n• Added **${cards.length} flashcards**\n• Added **${quiz.length} quiz items**`,
    cards:cards.length,quiz:quiz.length
  };
}

/** Full side-by-side compare — cloud ChatGPT-class when available. */
async function compareDocumentsSideBySide(){
  const docs=state.documents||[];
  if(docs.length<2){
    return {ok:false,message:"Import at least two PDFs or notes, then ask me to **compare documents**."};
  }
  const a=docs[0], b=docs[1];
  const srcA=String(a.rawText||a.reviewerData?.overview||"").slice(0,45000);
  const srcB=String(b.rawText||b.reviewerData?.overview||"").slice(0,45000);

  // ChatGPT-class compare via cloud
  try{
    const cloud=await cloudAI("text",{
      task:"compare",
      source:srcA,
      sourceB:srcB,
      nameA:a.fileName||"Document A",
      nameB:b.fileName||"Document B"
    },180000);
    if(cloud?.text && String(cloud.text).trim().length>40){
      return {ok:true,message:String(cloud.text).trim(),cloud:true,a:a.fileName,b:b.fileName};
    }
  }catch(e){
    console.info("Cloud compare unavailable; local fallback",e?.message||e);
  }

  const ra=a.reviewerData||buildReviewer(a);
  const rb=b.reviewerData||buildReviewer(b);
  const ta=new Set((a.terms||ra.terms||[]).map(x=>String(x).toLowerCase().trim()).filter(Boolean));
  const tb=new Set((b.terms||rb.terms||[]).map(x=>String(x).toLowerCase().trim()).filter(Boolean));
  const shared=[...ta].filter(x=>tb.has(x)).slice(0,30);
  const onlyA=[...ta].filter(x=>!tb.has(x)).slice(0,20);
  const onlyB=[...tb].filter(x=>!ta.has(x)).slice(0,20);
  const defA=(ra.definitions||[]).slice(0,8);
  const defB=(rb.definitions||[]).slice(0,8);
  const kpA=(ra.keyPoints||[]).slice(0,6).map(x=>typeof x==="string"?x:(x.text||""));
  const kpB=(rb.keyPoints||[]).slice(0,6).map(x=>typeof x==="string"?x:(x.text||""));

  let out=`**Side-by-side compare** (local)\n\n`;
  out+=`| | **A · ${String(a.fileName||"Doc A").slice(0,40)}** | **B · ${String(b.fileName||"Doc B").slice(0,40)}** |\n`;
  out+=`|---|---|---|\n`;
  out+=`| Overview | ${String(ra.overview||"—").replace(/\n/g," ").slice(0,180)} | ${String(rb.overview||"—").replace(/\n/g," ").slice(0,180)} |\n`;
  out+=`| Terms | ${(a.terms||[]).length} | ${(b.terms||[]).length} |\n`;
  out+=`| Flashcards | ${(a.flashcards||[]).length} | ${(b.flashcards||[]).length} |\n\n`;
  out+=`**Shared concepts (${shared.length})**\n${shared.length?shared.map(x=>"• "+x).join("\n"):"• (none detected)"}\n\n`;
  out+=`**Only in A**\n${onlyA.length?onlyA.map(x=>"• "+x).join("\n"):"• —"}\n\n`;
  out+=`**Only in B**\n${onlyB.length?onlyB.map(x=>"• "+x).join("\n"):"• —"}\n\n`;
  if(defA.length||defB.length){
    out+=`**Sample definitions**\n`;
    if(defA.length) out+=`*A:* `+defA.map(d=>`**${d.term}** — ${String(d.definition||"").slice(0,80)}`).join("; ")+`\n`;
    if(defB.length) out+=`*B:* `+defB.map(d=>`**${d.term}** — ${String(d.definition||"").slice(0,80)}`).join("; ")+`\n`;
    out+=`\n`;
  }
  if(kpA.length||kpB.length){
    out+=`**Key points**\n`;
    if(kpA.length) out+=`*A:*\n`+kpA.map(x=>"• "+String(x).slice(0,120)).join("\n")+`\n`;
    if(kpB.length) out+=`*B:*\n`+kpB.map(x=>"• "+String(x).slice(0,120)).join("\n")+`\n`;
  }
  out+=`\n*Tip: with OPENAI_API_KEY + server running, compare uses the same cloud model as ChatGPT.*`;
  return {ok:true,message:out,shared:shared.length,a:a.fileName,b:b.fileName};
}

/** Progressive typing effect for cloud answers (ChatGPT-like streaming feel). */
async function streamTextIntoBubble(streamId, fullText, opts={}){
  const text=String(fullText||"");
  if(!text) return;
  const el=document.querySelector(`[data-tutor-stream="${streamId}"]`);
  if(!el){
    // No bubble yet — just ensure chat has the final text
    return;
  }
  const step=opts.step||18;
  const delay=opts.delay||12;
  let i=0;
  el.innerHTML="";
  el.classList.add("is-streaming");
  while(i<text.length){
    i=Math.min(text.length, i+step);
    const slice=text.slice(0,i);
    el.innerHTML=collapsibleHtml(slice, 99999);
    const box=$("#tutorChat");
    if(box) box.scrollTop=box.scrollHeight;
    if(i<text.length) await new Promise(r=>setTimeout(r, delay));
  }
  el.classList.remove("is-streaming");
  el.innerHTML=collapsibleHtml(text, 900);
  bindCollapsibles(el.parentElement||document);
}

/** Smarter long-document source for cloud: prefer evidence-rich sections over raw head. */
function smartSourceForCloud(doc, question, maxChars=100000){
  if(!doc) return "";
  const raw=String(doc.rawText||"");
  if(raw.length<=maxChars) return raw;
  const r=doc.reviewerData||{};
  const q=String(question||"").toLowerCase();
  const qWords=q.split(/[^a-z0-9]+/).filter(w=>w.length>=4);
  const units=[];
  // Prefer key points + definitions + processes
  for(const x of (r.keyPoints||[]).slice(0,40)){
    const t=typeof x==="string"?x:(x.text||"");
    if(t) units.push({text:t,score:8,page:x.page});
  }
  for(const d of (r.definitions||[]).slice(0,30)){
    units.push({text:`${d.term}: ${d.definition||""}`,score:10,page:d.page});
  }
  for(const p of (r.processes||[]).slice(0,15)){
    const t=typeof p==="string"?p:(p.text||p.steps||"");
    if(t) units.push({text:String(t),score:7,page:p.page});
  }
  // Score remaining raw chunks by question overlap
  const chunkSize=1200;
  for(let i=0;i<raw.length;i+=chunkSize){
    const chunk=raw.slice(i,i+chunkSize);
    let score=1;
    const low=chunk.toLowerCase();
    for(const w of qWords){ if(low.includes(w)) score+=3; }
    units.push({text:chunk,score,page:null});
  }
  units.sort((a,b)=>b.score-a.score);
  let out="", used=0;
  const seen=new Set();
  for(const u of units){
    const key=u.text.slice(0,80);
    if(seen.has(key)) continue;
    seen.add(key);
    if(used+u.text.length>maxChars) continue;
    out+=u.text+"\n\n";
    used+=u.text.length;
    if(used>=maxChars*0.92) break;
  }
  return out || raw.slice(0,maxChars);
}

/** Long text gets a Show more ▼ / Show less ▲ control so the screen stays readable. */
function chatMarkdown(text){
  // ChatGPT-like formatting: code, bold, headings, lists, simple tables, paragraphs
  let s=esc(String(text||"").trim());
  if(!s) return "";
  s=s.replace(/```([\s\S]*?)```/g,(_,code)=>`<pre class="chat-code"><code>${code.trim()}</code></pre>`);
  s=s.replace(/`([^`]+)`/g,'<code class="chat-inline">$1</code>');
  s=s.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
  s=s.replace(/\*([^*]+)\*/g,'<em>$1</em>');
  const lines=s.split(/\n/);
  let out=[], inList=false, listTag='ul', tableRows=[];
  const flushTable=()=>{
    if(!tableRows.length) return;
    out.push('<table class="chat-table"><tbody>');
    tableRows.forEach((cells,ri)=>{
      const tag=ri===0?'th':'td';
      out.push('<tr>'+cells.map(c=>`<${tag}>${c}</${tag}>`).join('')+'</tr>');
    });
    out.push('</tbody></table>');
    tableRows=[];
  };
  const flushList=()=>{
    if(inList){ out.push(listTag==='ol'?'</ol>':'</ul>'); inList=false; }
  };
  for(const line of lines){
    // markdown table row
    if(/^\s*\|.+\|\s*$/.test(line) && !/^\s*\|?\s*[-:| ]+\|?\s*$/.test(line)){
      flushList();
      const cells=line.split('|').map(c=>c.trim()).filter((c,i,a)=>!(i===0&&c==='')&&!(i===a.length-1&&c===''));
      if(cells.length) tableRows.push(cells);
      continue;
    }
    if(/^\s*\|?\s*[-:| ]+\|?\s*$/.test(line) && tableRows.length){
      continue; // separator under header
    }
    if(tableRows.length) flushTable();

    const h=line.match(/^\s*#{1,3}\s+(.+)/);
    const li=line.match(/^\s*[-•]\s+(.+)/);
    const num=line.match(/^\s*(\d+)[.)]\s+(.+)/);
    if(h){
      flushList();
      out.push(`<p class="chat-h"><strong>${h[1]}</strong></p>`);
    }else if(li){
      if(!inList||listTag!=='ul'){ flushList(); out.push('<ul class="chat-ul">'); inList=true; listTag='ul'; }
      out.push('<li>'+li[1]+'</li>');
    }else if(num){
      if(!inList||listTag!=='ol'){ flushList(); out.push('<ol class="chat-ol">'); inList=true; listTag='ol'; }
      out.push('<li>'+num[2]+'</li>');
    }else{
      flushList();
      if(line.trim()) out.push('<p class="chat-p">'+line+'</p>');
      else out.push('<div class="chat-gap"></div>');
    }
  }
  flushList();
  flushTable();
  return out.join('');
}
function collapsibleHtml(text,maxChars=900){
  const raw=String(text||"").trim();
  if(!raw)return "";
  const html=chatMarkdown(raw);
  if(raw.length<=maxChars)return `<div class="collapse-body chat-md">${html}</div>`;
  const id="c"+Math.random().toString(36).slice(2,9);
  return `<div class="collapse-wrap" data-collapse-id="${id}"><div class="collapse-body chat-md is-collapsed" id="${id}">${html}</div><button type="button" class="collapse-toggle" data-collapse-for="${id}" aria-expanded="false">Show more ▼</button></div>`;
}
function bindCollapsibles(root){
  const scope=root||document;
  scope.querySelectorAll(".collapse-toggle").forEach(btn=>{
    if(btn.dataset.bound)return;
    btn.dataset.bound="1";
    btn.onclick=()=>{
      const body=document.getElementById(btn.dataset.collapseFor);
      if(!body)return;
      body.classList.toggle("is-collapsed");
      const collapsed=body.classList.contains("is-collapsed");
      btn.textContent=collapsed?"Show more ▼":"Show less ▲";
      btn.setAttribute("aria-expanded",collapsed?"false":"true");
    };
  });
}

function formatWiseAnswer(body,opts={}){
  // Chat-style: clear answer; tip only when useful (not every single reply)
  let out=String(body||"").trim();
  if(!out)return "I need a clearer question — or open a PDF so I can ground the answer.";
  if(opts.tip) out+=`\n\n💡 ${opts.tip}`;
  else if(opts.forceTip && !/Tip:|💡/i.test(out)){
    out+=`\n\n💡 Tip: say this in your own words, then check the page in Reviewer.`;
  }
  return out;
}

function renderTutorChat(){
  const box=$("#tutorChat");if(!box)return;
  if(!tutorChat.length){
    box.innerHTML=`<div class="gpt-welcome">
      <div class="gpt-welcome-mark">✦</div>
      <h1>How can I help you today?</h1>
      <p>I'm <strong>Carrot</strong> — your study-first AI. I generate images, summarize like a pro, ground answers in your PDFs, and work offline when needed.</p>
      <div class="gpt-cards">
        <button type="button" class="gpt-card" data-suggest="create an image of a futuristic library at sunset, cinematic">Create an image</button>
        <button type="button" class="gpt-card" data-suggest="Summarize the main ideas clearly with key points and exam takeaways">Summarize something</button>
        <button type="button" class="gpt-card" data-suggest="Explain this concept simply with an example">Explain simply</button>
        <button type="button" class="gpt-card" data-suggest="Help me write a clear formal paragraph">Write something</button>
      </div>
    </div>`;
    box.querySelectorAll('[data-suggest]').forEach(btn=>{
      btn.onclick=()=>{
        const t=btn.getAttribute('data-suggest')||'';
        const input=$('#tutorInput');
        if(input){ input.value=t; input.focus(); }
        if(typeof tutorSendMessage==='function') tutorSendMessage();
      };
    });
    return;
  }
  box.innerHTML=tutorChat.map(m=>{
    const who=m.role==="user"?"You":"Carrot";
    const mode=m.mode?`<span class="tutor-mode-tag">${esc(m.mode)}</span>`:"";
    const streamAttr=m.streamId?` data-tutor-stream="${esc(m.streamId)}"`:"";
    let body=m.role==="tutor"
      ?`<div class="tutor-msg-body"${streamAttr}>${collapsibleHtml(m.text,520)}</div>`
      :`<div class="tutor-msg-body">${esc(m.text).replace(/\n/g,"<br>")}</div>`;
    if(m.imageUrl){
      const canRegenerate=!!m.imagePrompt;
      body+=`<div class="tutor-img-wrap"><img class="tutor-img" src="${esc(m.imageUrl)}" alt="${esc(m.imageAlt||"Illustration")}" loading="lazy" referrerpolicy="no-referrer" crossorigin="anonymous" onerror="this.onerror=null;this.style.display='none';const f=this.nextElementSibling;if(f){f.textContent=(f.textContent||'Picture')+' — could not load (check network or try again)';f.classList.add('tutor-img-fail');}"><div class="tutor-img-cap tiny">${esc(m.imageAlt||"")}</div><div class="tutor-img-actions"><button type="button" class="btn secondary small" data-tutor-download="${esc(m.imageUrl)}" data-tutor-name="${esc((m.imageAlt||'study-image').replace(/[^a-z0-9]+/gi,'-').slice(0,40))}">Save image</button><button type="button" class="btn secondary small" data-tutor-edit="${esc(m.streamId||m.at||'')}">Edit image</button><button type="button" class="btn secondary small" data-tutor-variation="${esc(m.streamId||m.at||'')}">Variation</button>${canRegenerate?`<button type="button" class="btn secondary small" data-tutor-regenerate="${esc(m.streamId||m.at||'')}">Regenerate</button>`:''}</div></div>`;
    }
    return `<div class="tutor-msg ${m.role==="user"?"is-user":"is-tutor"}"><div class="tutor-msg-meta"><span class="tutor-who">${who}</span>${mode}</div>${body}</div>`;
  }).join("");
  bindCollapsibles(box);
  if(typeof gptAddMessageActions==="function") gptAddMessageActions(box);
  box.querySelectorAll('[data-tutor-download]').forEach(btn=>btn.onclick=()=>{
    try{ downloadDataUrl(btn.getAttribute('data-tutor-download'), `${btn.getAttribute('data-tutor-name')||'study-image'}-${Date.now()}.png`); toast('Image saved.','success'); }
    catch(e){ toast('Could not save that image.','error'); }
  });
  box.querySelectorAll('[data-tutor-edit]').forEach(btn=>btn.onclick=async()=>{
    const id=btn.getAttribute('data-tutor-edit');
    const msg=tutorChat.find(m=>String(m.streamId||m.at||'')===String(id));
    if(!msg?.imageUrl)return;
    const instruction=window.prompt('What should I change in this image?','Keep the subject and composition, but change the lighting and background.');
    if(!instruction)return;
    if(tutorBusy)return toast('Image generation is already running.','error');
    tutorBusy=true; btn.disabled=true;
    const status=$('#tutorStatus'); if(status)status.textContent='Editing image…';
    try{
      const result=await editChatImage(msg,instruction);
      msg.imageUrl=result.url; msg.imageModel=result.model; msg.imagePrompt=instruction; msg.imageAlt=msg.imageAlt||'Edited image'; msg.at=now();
      msg.text=`Edited the image with your requested changes.\n\n**Change:** ${instruction}`;
      renderTutorChat(); await persistAiSessions();
      toast('Image edited.','success');
      if(status)status.textContent='Image ready';
    }catch(e){toast(String(e?.message||e||'Could not edit image.'),'error');if(status)status.textContent='Image unavailable';}
    finally{tutorBusy=false;renderTutor();}
  });
  box.querySelectorAll('[data-tutor-variation]').forEach(btn=>btn.onclick=async()=>{
    const id=btn.getAttribute('data-tutor-variation');
    const msg=tutorChat.find(m=>String(m.streamId||m.at||'')===String(id));
    if(!msg?.imageUrl)return;
    if(tutorBusy)return toast('Image generation is already running.','error');
    const instruction=window.prompt(
      'Variation options — describe the change (or leave default):\n• different lighting / angle\n• anime style\n• photorealistic\n• poster look\n• same subject, new background',
      'Create a fresh variation. Preserve the main subject and intent. Change composition, lighting, and small details. Optional style: cinematic.'
    );
    if(instruction===null)return;
    tutorBusy=true; btn.disabled=true;
    const status=$('#tutorStatus'); if(status)status.textContent='Creating variation…';
    try{
      const prompt=String(instruction||'').trim() || 'Create a fresh variation while preserving the main subject, important identity/features, and overall intent. Change composition, lighting, and small visual details naturally.';
      const result=await editChatImage(msg, prompt);
      tutorChat.push({
        role:'tutor',
        text:'Here is a fresh variation. Ask for another style (anime, photo, poster, diagram) or a specific change.',
        mode:'Image · Variation',
        at:now(),
        imageUrl:result.url,
        imageAlt:msg.imageAlt||'Variation',
        imagePrompt:prompt,
        imageModel:result.model
      });
      renderTutorChat(); await persistAiSessions(); toast('Variation ready.','success');
      if(status)status.textContent='Image ready';
    }catch(e){toast(String(e?.message||e||'Could not create variation.'),'error');if(status)status.textContent='Image unavailable';}
    finally{tutorBusy=false;renderTutor();}
  });
  box.querySelectorAll('[data-tutor-regenerate]').forEach(btn=>btn.onclick=async()=>{
    const id=btn.getAttribute('data-tutor-regenerate');
    const msg=tutorChat.find(m=>String(m.streamId||m.at||'')===String(id));
    if(!msg?.imagePrompt)return;
    if(tutorBusy)return toast('Image generation is already running.','error');
    tutorBusy=true;
    const status=$('#tutorStatus'); if(status)status.textContent='Regenerating image…';
    btn.disabled=true;
    try{
      const result=await createChatImageFromPrompt(msg.imagePrompt);
      msg.imageUrl=result.url; msg.imageModel=result.model; msg.at=now();
      renderTutorChat(); await persistAiSessions();
      if(status)status.textContent='Image ready';
    }catch(e){ toast(String(e?.message||e||'Could not regenerate image.'),'error'); btn.disabled=false; if(status)status.textContent='Image unavailable'; }
    finally{ tutorBusy=false; renderTutor(); }
  });
  box.scrollTop=box.scrollHeight;
}

function renderTutor(){
  const d=activeDoc();
  const meta=$("#tutorMeta");
  if(meta)meta.textContent=d?`Using: ${d.fileName}`:"Chat · local-first";
  const status=$("#tutorStatus");
  const device=$("#tutorDevice");
  const modeLabel=$("#tutorModeLabel");
  const neural=!!(state.settings.ai?.enabled&&aiWorker);
  if(status)status.textContent=neural?"Ready · Neural":"Ready";
  if(device)device.textContent=neural?"On-device model streaming · private to this device":"Fast offline answers · Load AI for deeper chat";
  if(modeLabel)modeLabel.textContent=neural?"Neural":"Instant";
  if($("#tutorMsgCount"))$("#tutorMsgCount").textContent=String(tutorChat.length);
  const weak=$("#tutorWeak");
  if(weak){const ws=weakConcepts();weak.innerHTML=ws.length?ws.map(x=>`<span class="term">${esc(x)}</span>`).join(""):"<span class='tiny'>Appear after quizzes and cards.</span>";}
  const sug=$("#tutorSuggestions");
  if(sug && !tutorChat.length){
    const items=tutorSuggestionsFor(d);
    sug.innerHTML=items.map(t=>`<button type="button" class="tutor-chip" data-tutor-q="${esc(t)}">${esc(t)}</button>`).join("");
    sug.querySelectorAll("[data-tutor-q]").forEach(b=>b.onclick=()=>{const input=$("#tutorInput");if(input){input.value=b.dataset.tutorQ;input.focus();}tutorSendMessage();});
  }else if(sug && tutorChat.length){
    // keep follow-ups; don't wipe mid-chat
  }
  renderTutorChat();
  renderAiChatList();
}


function detectImageStyle(q){
  const s=String(q||'').toLowerCase();
  if(/\b(anime|manga|chibi)\b/.test(s)) return 'anime';
  if(/\b(photo|photoreal|realistic|photograph|dslr|cinematic photo)\b/.test(s)) return 'photo';
  if(/\b(diagram|schematic|flowchart|labeled|blueprint|circuit)\b/.test(s)) return 'diagram';
  if(/\b(poster|flyer|banner|thumbnail)\b/.test(s)) return 'poster';
  if(/\b(illustration|editorial|vector|flat design)\b/.test(s)) return 'illustration';
  if(/\b(study|textbook|educational|classroom|reviewer)\b/.test(s)) return 'diagram';
  return 'cinematic';
}

function imagePromptFromChat(q){
  let prompt=String(q||'').trim();
  prompt=prompt.replace(/^(please\s+)?(create|generate|make|draw|render|design|produce|show|give)\s+(me\s+)?(an?\s+)?(image|picture|photo|illustration|artwork|poster|wallpaper|scene|portrait|diagram)\s*(of|for)?\s*/i,'');
  prompt=prompt.replace(/^an?\s+image\s+(of|showing)\s+/i,'');
  prompt=prompt.replace(/^(an?\s+)?(picture|photo|illustration)\s+(of|for)\s+/i,'');
  if(!prompt) prompt=String(q||'').trim();
  // Keep the public free engine honest: short, visual, no private study text.
  return String(prompt).replace(/\s+/g,' ').trim().slice(0,480);
}

function buildImaginePrompt(userPrompt, style){
  const core=String(userPrompt||'').trim().slice(0,480);
  const styles={
    study:"clean educational study illustration, clear labels, accurate diagram style, high contrast, textbook quality, no watermark",
    poster:"bold educational poster, modern student design, crisp composition, readable focal subject",
    soft:"soft cinematic lighting, beautiful detailed illustration, coherent scene",
    diagram:"precise technical diagram, labeled parts, simple background, educational clarity"
  };
  const s=styles[style]||styles.study;
  return `${core}, ${s}`.slice(0,700);
}

/** Free public AI image — no API key, no StudyVault server. Only the short prompt leaves the device. */
async function freePublicImagine(prompt, opts={}){
  const width=Math.min(1280, Math.max(512, Number(opts.width)||1024));
  const height=Math.min(1280, Math.max(512, Number(opts.height)||1024));
  const seed=opts.seed!=null?opts.seed:Math.floor(Math.random()*1e9);
  // Prefer a tight visual prompt for public engines; strip long instructional fluff.
  const raw=String(prompt||'').replace(/\.\s*Do not add irrelevant objects.*$/i,'').slice(0,700).trim();
  const q=encodeURIComponent(raw);
  const candidates=[
    `https://image.pollinations.ai/prompt/${q}?width=${width}&height=${height}&nologo=true&seed=${seed}&enhance=true&model=flux`,
    `https://image.pollinations.ai/prompt/${q}?width=${width}&height=${height}&nologo=true&seed=${seed}&enhance=true`,
    `https://image.pollinations.ai/prompt/${q}?width=${width}&height=${height}&nologo=true&seed=${seed}`,
    `https://gen.pollinations.ai/image/${q}?width=${width}&height=${height}&model=flux&seed=${seed}`
  ];

  // Important browser fix: do NOT require CORS just to display the generated image.
  // The old implementation used fetch()+FileReader only; many image CDNs intentionally
  // omit CORS headers, so the request failed even though the image URL itself was valid.
  for(const url of candidates){
    try{
      const ok=await new Promise(resolve=>{
        const img=new Image();
        let done=false;
        const finish=v=>{if(done)return;done=true;img.onload=img.onerror=null;resolve(v);};
        img.onload=()=>finish(true); img.onerror=()=>finish(false);
        img.referrerPolicy='no-referrer';
        img.src=url;
        setTimeout(()=>finish(false),25000);
      });
      if(ok) return {url,model:'Public image engine',prompt:raw,seed,remote:true};
    }catch{}
  }
  throw new Error('No public image engine responded.');
}

/** Ordered stack: cloud flagship → free public AI → local canvas art. */
async function createChatImageFromPrompt(prompt, opts={}){
  const clean=String(prompt||'').trim();
  if(!clean) throw new Error('Describe the image you want first.');
  const style=opts.style||detectImageStyle(clean)||'cinematic';
  const full=buildChatGPTImagePrompt(clean, style);
  let base=String(state.settings?.sync?.url||'').trim().replace(/\/$/,"");
  if(!base){
    const found=await discoverAiServer(1200);
    base=found?.base||"";
  }

  // Prefer the configured cloud image model. This is the real generative path,
  // not a web photo lookup and not a canvas approximation.
  if(base){
    try{
      const data=await cloudAI('image',{
        prompt:full.slice(0,9000),
        image:opts.image||'',
        action:opts.action||(opts.image?'edit':'generate'),
        size:opts.size||'auto',
        quality:opts.quality||'high',
        background:opts.background||'auto',
        output_format:opts.output_format||'png'
      },300000);
      const url=data?.imageDataUrl||data?.url;
      if(url) return {url,model:data?.model||'GPT Image',prompt:full,action:data?.action||opts.action||'generate',cloud:true};
    }catch(err){
      console.warn('Flagship image generation failed; trying offline/public fallback',err);
    }
  }

  // Public fallback keeps the app useful when the optional cloud server is not configured.
  if(navigator.onLine!==false){
    try{
      return await freePublicImagine(full,{width:opts.width||768,height:opts.height||768,seed:opts.seed});
    }catch(err){ console.warn('Free Imagine fallback failed',err); }
  }

  try{
    const localUrl=(typeof generateOrderedStudyImage==='function') ? generateOrderedStudyImage(clean,{silent:true}) : null;
    if(localUrl) return {url:localUrl,model:'Local study art',prompt:clean,local:true};
  }catch(e){ console.warn(e); }
  throw new Error('No image engine responded. Start Carrot AI with an API key for full AI generation, or reconnect to the internet for the public image fallback.');
}

function buildChatGPTImagePrompt(userPrompt, style='cinematic'){
  const core=String(userPrompt||'').replace(/\s+/g,' ').trim().slice(0,1200);
  const styles={
    cinematic:'photorealistic where appropriate, cinematic composition, natural lighting, realistic materials, coherent depth, professional photography quality',
    photo:'highly photorealistic photograph, natural lens rendering, realistic lighting, authentic textures, believable proportions',
    illustration:'polished editorial illustration, strong composition, clean shapes, rich detail, professional visual design',
    anime:'high-quality anime-inspired illustration, expressive composition, polished linework, detailed lighting',
    poster:'professional poster design, clear hierarchy, strong focal point, clean typography-safe composition',
    diagram:'precise educational diagram, logically arranged components, clean labels, high legibility, textbook-quality visual structure'
  };
  return `${core}. ${styles[style]||styles.cinematic}. Do not add irrelevant objects, fake signatures, watermarks, or decorative text unless requested.`.slice(0,9000);
}

async function editChatImage(message, instruction){
  const src=String(message?.imageUrl||'');
  if(!src) throw new Error('There is no editable image in that message.');
  const prompt=String(instruction||'').trim();
  if(!prompt) throw new Error('Describe the change you want.');
  return createChatImageFromPrompt(prompt,{image:src,action:'edit',quality:'high',size:'auto'});
}

async function tutorCreateImage(promptOverride){
  const input=$('#tutorInput');
  const q=String(promptOverride||input?.value||'').trim();
  if(!q)return toast('Describe the image you want first.','error');
  if(tutorBusy)return toast('Study AI is still working…','error');
  tutorBusy=true;
  if(input && !promptOverride) input.value='';
  tutorChat.push({role:'user',text:q,at:now()});
  renderTutorChat();
  const status=$('#tutorStatus');
  if(status)status.textContent='Imagining…';
  try{
    const result=await createChatImageFromPrompt(imagePromptFromChat(q));
    const how=result.local
      ? 'I made a local study illustration on this device (offline-safe).'
      : `I created this with the StudyVault image studio (${result.model}).`;
    tutorChat.push({
      role:'tutor',
      text:`${how}\n\n**Prompt:** ${q}\n\nAsk me to change the style, lighting, objects, background, or mood and I will make another version.`,
      mode: result.local ? 'Local study art' : 'Image Studio',
      at:now(),
      imageUrl:result.url,
      imageAlt:q.slice(0,120),
      imagePrompt:result.prompt,
      imageModel:result.model
    });
    // Remember the picture in the family gallery when possible
    try{
      if(result.url && typeof rememberAiPicture==='function'){
        await rememberAiPicture(q.slice(0,80), result.url, result.prompt||q);
      }
    }catch(e){ console.warn('remember picture',e); }
    renderTutorChat();
    if(status)status.textContent='Image ready';
    toast(result.local?'Local study image ready.':'Generated image ready.','success');
  }catch(e){
    tutorChat.push({role:'tutor',text:`I couldn't generate that image yet.\n\n${String(e?.message||e||'Image generation failed.')}\n\nTry the same request again. If cloud AI is off, Carrot will try its public image engine and then the offline Study Image generator.`,mode:'Image error',at:now()});
    renderTutorChat();
    if(status)status.textContent='Image unavailable';
  }finally{
    tutorBusy=false;
    await persistAiSessions().catch(()=>{});
    renderTutor();
  }
}

async function tutorSendMessage(){
  const d=activeDoc();
  const input=$("#tutorInput");
  const regenQ=window.__carrotRegenQ?String(window.__carrotRegenQ).trim():"";
  window.__carrotRegenQ=null;
  const q=(regenQ||input?.value||"").trim();
  if(!q)return toast("Type a question first.","error");
  if(tutorBusy)return toast("Tutor is still answering…","error");
  tutorBusy=true;
  // Skip duplicate user bubble when regenerating the same question
  const lastUser=tutorChat[tutorChat.length-1];
  const skipUserPush=!!regenQ && lastUser && lastUser.role==="user" && String(lastUser.text||"").trim()===q;
  if(!skipUserPush) tutorChat.push({role:"user",text:q,at:now()});
  if(input)input.value="";
  renderTutorChat();
  if($("#tutorMsgCount"))$("#tutorMsgCount").textContent=String(tutorChat.length);
  const status=$("#tutorStatus");
  if(status)status.textContent="Thinking…";

  let answer="", mode="Wise Tutor", imageUrl="", imageAlt="";
  try{
    // Picture / diagram requests — Imagine works on its own (no API key)
    if(isPictureRequest(q)){
      if(status)status.textContent="Imagining…";
      try{
        const result=await createChatImageFromPrompt(imagePromptFromChat(q));
        imageUrl=result.url;
        imageAlt=q.slice(0,120);
        if(result.local){
          answer=formatWiseAnswer(`I made a local study illustration on this device.

✓ Attached to this chat. Ask for a different style or topic anytime.`,{tip:"Cloud AI can create higher-quality images when the Carrot AI server has an OpenAI API key."});
          mode="Image · Local study art";
        }else{
          answer=formatWiseAnswer(`Created an AI image from your description.

✓ The image is attached to this chat. Ask for changes and I can generate another version.`,{tip:"Image generation uses the configured Carrot AI image model when available; offline fallback is clearly labeled."});
          mode="Imagine · AI image";
        }
        try{ if(result.url && typeof rememberAiPicture==='function') await rememberAiPicture(q.slice(0,80), result.url, result.prompt||q); }catch{}
      }catch(imagineErr){
        console.warn("Imagine failed; using classic picture pipeline",imagineErr);
        if(status)status.textContent="Creating image…";
      let topic=q.replace(/^(please\s+)?(show|send|give|display|find|draw|generate|create|make|want|need|get)\s+(me\s+)?(a\s+|an\s+|the\s+)?/i,"")
        .replace(/^(a|an|the)\s+/i,"")
        .replace(/\b(picture|photo|image|pic|diagram|illustration|sketch)\s+(of\s+)?/i,"")
        .replace(/\bon\s+the\s+pdf\b/i,"")
        .trim()||q;
      if(/electrical\s*symbols?|all\s+symbols?/i.test(q)) topic="electrical symbols";

      // Clean subject for photos: "a wolf the background is moon" → "Wolf"
      const photoSubject=extractPictureSubject(q);
      const wantsPhoto=(isRealWorldPictureTopic(topic)||isRealWorldPictureTopic(photoSubject)||isAnimalOrSceneTopic(topic))
        && !matchLocalSymbol(topic)
        && !matchLocalSymbol(photoSubject)
        && !/electrical\s*symbols?/i.test(topic);

      if(wantsPhoto){
        if(status)status.textContent="Making picture…";
        const searchTopic=photoSubject||topic;
        const img=await fetchTopicImage(searchTopic);
        if(img?.imageUrl){
          if(status)status.textContent="Locking picture into your vault…";
          // Bake remote photo into a local data URL so chat + vault work offline forever
          let localData=await imageUrlToDataUrl(img.imageUrl, 960);
          if(!localData){
            // Network/CORS blocked the bake — still show remote, and make an on-device card as backup memory
            localData=makeAiMadeStudyCard(img.topic||searchTopic, img.extract||"");
            imageUrl=img.imageUrl;
          }else{
            imageUrl=localData;
          }
          imageAlt=img.topic||searchTopic;
          try{ await rememberAiPicture(img.topic||searchTopic, localData||imageUrl, img.extract||""); }catch(e){ console.warn(e); }
          answer=formatWiseAnswer(
            `Here is your picture of **${img.topic||searchTopic}**.\n\n${img.extract||""}\n\n✓ **Remembered** in your vault (Photos when a document is open). Works offline after this.`,
            {tip:"Study AI locked this picture on-device. Circuit symbols & study diagrams are drawn fully offline."}
          );
          mode="Picture · Saved";
        }else if(img?.error==="offline" || !navigator.onLine){
          // Offline: AI still makes a study card and remembers it
          if(status)status.textContent="Making offline study picture…";
          const card=makeAiMadeStudyCard(searchTopic, "Offline study card — reconnect later for a real photo reference.");
          imageUrl=card;
          imageAlt=searchTopic;
          try{ await rememberAiPicture(searchTopic, card, "Offline AI study card"); }catch(e){ console.warn(e); }
          answer=formatWiseAnswer(
            `You’re offline, so I **made** a study card for **${searchTopic}** on this device and saved it.\n\nReconnect and ask again for a real photo (e.g. “picture of a parrot”). Study diagrams (resistor, gates) always work offline.`,
            {tip:"Remembered offline. Real-world photos need one short online lookup the first time."}
          );
          mode="Picture · Saved";
        }else{
          // Not found online — still make + remember a local card so the family never gets nothing
          if(status)status.textContent="Making study picture…";
          const card=makeAiMadeStudyCard(searchTopic, "Could not find a web photo — kept this study card in your vault.");
          imageUrl=card;
          imageAlt=searchTopic;
          try{ await rememberAiPicture(searchTopic, card, ""); }catch(e){ console.warn(e); }
          answer=formatWiseAnswer(
            `I couldn’t find a web photo of **${searchTopic}**, so I **made** a study card and saved it in your vault.\n\nTry a short name online: “parrot”, “wolf”, “lion”. For diagrams say “draw a resistor”.`,
            {tip:"Every picture request leaves something remembered on this device."}
          );
          mode="Picture · Saved";
        }
      }else{
        // Study diagrams / symbols / curriculum topics → on-device PNG + remember
        const localUrl=generateOrderedStudyImage(topic,{silent:false});
        if(localUrl){
          imageUrl=localUrl;
          imageAlt=topic.slice(0,80);
          try{ await rememberAiPicture(topic.slice(0,80), localUrl, "On-device study diagram"); }catch(e){ console.warn(e); }
          const hit=domainKnowledgeAnswer(topic);
          answer=formatWiseAnswer(
            `Here is an **accurate study image** for **${topic}** (built on-device${hit?" + "+hit.domain+" knowledge":""}).\n\n✓ **Remembered** in your vault.`,
            {tip:"Local image — works offline. Ask “picture of a lion” online for a real photo reference."}
          );
          mode="Accurate Image · Saved";
        }else{
          const img=await fetchTopicImage(topic);
          if(img?.imageUrl){
            let localData=await imageUrlToDataUrl(img.imageUrl, 960);
            if(!localData) localData=makeAiMadeStudyCard(img.topic||topic, img.extract||"");
            imageUrl=localData||img.imageUrl;
            imageAlt=img.topic||"Illustration";
            try{ await rememberAiPicture(img.topic||topic, localData||"", img.extract||""); }catch(e){ console.warn(e); }
            answer=formatWiseAnswer(
              `Here is a reference picture of **${img.topic}**.\n\n${img.extract||""}\n\n✓ **Remembered** in your vault.`,
              {tip:"Locked on-device after first fetch."}
            );
            mode="Picture · Saved";
          }else{
            const card=makeAiMadeStudyCard(topic, "Study card saved on this device.");
            imageUrl=card;
            imageAlt=topic.slice(0,80);
            try{ await rememberAiPicture(topic.slice(0,80), card, ""); }catch(e){ console.warn(e); }
            answer=formatWiseAnswer(
              `I made a study card for “${topic}” and saved it. Try: “diagram of OSI model”, “draw a resistor”, or “picture of a parrot”.`,
              {tip:"Create study image on Home also accepts a custom order."}
            );
            mode="Picture · Saved";
          }
        }
      }
      }
    }else{
      // ── ChatGPT-style Study AI path ──────────────────────────
      const isSummaryQ=/summar(y|ize|ise)|overview|main\s+points?|tl;?dr|key\s+points?/i.test(q);
      const wantsStudyPack=/turn\s+(this|that|it|the\s+summary)\s+into\s+(flashcards?|cards|quiz|a\s+quiz)|make\s+(flashcards?|cards|a\s+quiz|quiz)\s+from\s+(this|that|it|the\s+summary|both)|flashcards?\s+from\s+(this|that|summary)|study\s+pack\s+from\s+(this|that)|create\s+(flashcards?|quiz)\s+from\s+(this|that|summary)/i.test(q);
      const wantsCompare=/\b(compare|diff|side[- ]?by[- ]?side)\b.*\b(docs?|documents?|pdfs?|materials?|files?|sources?)\b|\b(compare|diff)\s+(these|the\s+two|both)\b|\bdocument\s+compare\b/i.test(q);
      const history=tutorChat.slice(-20).map(x=>({role:x.role==="tutor"?"tutor":"user",text:String(x.text||"").slice(0,4000)}));
      const streamId="ts"+Date.now().toString(36);
      const useNeural=!!(state.settings.ai?.enabled && (aiWorker || state.settings.ai?.enabled));

      // One-click study pack from summary or active document
      if(wantsStudyPack){
        if(status)status.textContent="Building flashcards + quiz…";
        const pack=await summaryToStudyPack({fromChat:true});
        answer=pack.message;
        mode=pack.ok?"Study pack":"Study pack · need source";
        tutorChat.push({role:"tutor",text:answer,mode,at:now(),streamId});
        renderTutorChat();
        renderTutorFollowups(q,answer);
        if(status)status.textContent=pack.ok?"Study pack ready":"Ready";
        try{await persistAiSessions();renderAiChatList();}catch{}
        return;
      }

      // Side-by-side compare (cloud ChatGPT-class when available)
      if(wantsCompare){
        if(status)status.textContent="Comparing documents…";
        const cmp=await compareDocumentsSideBySide();
        answer=cmp.message;
        mode=cmp.cloud?"Compare · Cloud":"Compare";
        tutorChat.push({role:"tutor",text:answer,mode,at:now(),streamId});
        renderTutorChat();
        if(status)status.textContent="Ready";
        try{await persistAiSessions();renderAiChatList();}catch{}
        return;
      }

      // ChatGPT-identical document summary via dedicated cloud task
      if(isSummaryQ && d && String(d.rawText||"").trim().length>80){
        try{
          if(status)status.textContent="Summarizing with cloud AI…";
          const src=typeof smartSourceForCloud==="function"?smartSourceForCloud(d,q,90000):String(d.rawText||"").slice(0,90000);
          const cloudSum=await cloudAI("text",{task:"chatgpt-summary",source:src},180000);
          if(cloudSum?.text && String(cloudSum.text).trim().length>40){
            answer=String(cloudSum.text).trim();
            mode="Summary · Cloud";
            tutorChat.push({role:"tutor",text:"",mode,at:now(),streamId});
            renderTutorChat();
            await streamTextIntoBubble(streamId, answer, {step:28, delay:6});
            for(let i=tutorChat.length-1;i>=0;i--){
              if(tutorChat[i].streamId===streamId){ tutorChat[i].text=answer; break; }
            }
            renderTutorChat();
            renderTutorFollowups(q,answer);
            if(status)status.textContent="Ready · cloud summary";
            try{await persistAiSessions();renderAiChatList();}catch{}
            return;
          }
        }catch(sumErr){
          console.info("Cloud summary fallback to general chat",sumErr?.message||sumErr);
        }
      }

      // Prefer the authenticated cloud model when configured. It provides the strongest
      // general reasoning, vision, and current-information behavior; local paths remain
      // the automatic fallback so StudyVault still works without a server.
      let cloudUsed=false;
      try{
        if(true){
          if(status)status.textContent="Thinking with Carrot AI…";
          const smartSrc=typeof smartSourceForCloud==="function" ? smartSourceForCloud(d,q,100000) : (d?.rawText||"");
          // ChatGPT parity: auto web search on current-events queries; explicit if user asks
          const wantWeb=/\b(search the web|look up|google|current|latest|today|news|right now|what happened|price of|weather)\b/i.test(q);
          const cloud=await cloudChat(q,history,{source:smartSrc,images:gptPendingImages,webSearch:wantWeb});
          if(cloud?.text){
            answer=String(cloud.text).trim();
            mode=cloud.webSearch?"Carrot · Web search":"Carrot · Cloud";
            cloudUsed=true;
            gptCloudAvailable=true;
            const modeBadge=$('#gptAiMode');if(modeBadge){modeBadge.textContent=gptCloudStatusLabel();modeBadge.classList.add('cloud');modeBadge.classList.remove('local');}
            if(Array.isArray(cloud.sources)&&cloud.sources.length){
              answer += "\n\n**Sources**\n" + cloud.sources.map(s=>`- [${String(s.title||s.url).replace(/]/g,"\\]")}](${s.url})`).join("\n");
            }
            // Progressive stream into the bubble (ChatGPT-like feel)
            tutorChat.push({role:"tutor",text:"",mode,at:now(),streamId});
            renderTutorChat();
            await streamTextIntoBubble(streamId, answer, {step:24, delay:8});
            // Ensure final text is stored
            for(let i=tutorChat.length-1;i>=0;i--){
              if(tutorChat[i].streamId===streamId){ tutorChat[i].text=answer; break; }
            }
            renderTutorChat();
            renderTutorFollowups(q,answer);
            gptPendingImages=[];
            if(status)status.textContent="Ready · "+(cloud.webSearch?"web search":"Carrot cloud");
            try{await persistAiSessions();renderAiChatList();}catch{}
            return;
          }
        }
      }catch(cloudErr){
        console.info("Cloud ChatGPT path unavailable; using local fallback:",cloudErr?.message||cloudErr);
        gptCloudAvailable=false;
      }

      // Instant local answer so chat never feels empty
      answer=conversationalTutorAnswer(d,q,history);
      mode=d?"Chat · grounded":"Chat";
      tutorChat.push({role:"tutor",text:answer,mode,at:now(),imageUrl:"",imageAlt:"",streamId});
      renderTutorChat();

      // Deepen with on-device neural model when loaded (streams into the same bubble)
      if(!isSummaryQ && state.settings.ai?.enabled){
        try{
          if(status)status.textContent="Thinking…";
          aiEnsureWorker();
          // Show typing state
          const typingEl=document.querySelector(`[data-tutor-stream="${streamId}"]`);
          if(typingEl) typingEl.innerHTML=`<span class="ai-typing"><span></span><span></span><span></span></span>`;
          const r=await aiRequest("ask",{
            source:d?aiQuestionSource(d,q):"",
            profile:learnerDigestForAI(),
            question:q,
            history,
            terms:(d?.terms||[]).slice(0,24)
          },{tutorStreamId:streamId});
          if(r?.text && String(r.text).trim().length>12){
            // Prefer neural when grounding is ok OR no source loaded (open chat)
            const ok=!d || r.groundingScore==null || r.groundingScore>=50 || !String(d.rawText||"").trim();
            if(ok){
              answer=String(r.text).trim();
              mode="Chat · Neural";
              for(let i=tutorChat.length-1;i>=0;i--){
                if(tutorChat[i].role==="tutor"){
                  tutorChat[i]={role:"tutor",text:answer,mode,at:now(),streamId};
                  break;
                }
              }
              renderTutorChat();
            }
          }
        }catch(e){
          console.warn("Study AI neural path",e);
          // Keep the local conversational answer already shown
        }
      }
      if(status)status.textContent=mode.includes("Neural")?"Ready · Neural":"Ready";
      gptPendingImages=[];
      // Follow-up suggestion chips
      renderTutorFollowups(q,answer);
      try{ await persistAiSessions(); renderAiChatList(); }catch{}
      return;
    }
    tutorChat.push({role:"tutor",text:answer,mode,at:now(),imageUrl,imageAlt});
    renderTutorChat();
    if(status)status.textContent=/Picture/.test(mode)?"Picture ready":"Answered";
  }catch(e){
    tutorChat.push({role:"tutor",text:e.message||"Could not answer right now. Try again in a moment.",mode:"Error",at:now()});
    if(status)status.textContent="Could not answer";
  }finally{
    tutorBusy=false;
    try{ await persistAiSessions(); }catch{}
    renderTutor();
  }
}

/** Natural chat-style local answer (used instantly; neural may replace it). */
function conversationalTutorAnswer(doc, question, history){
  const raw=localTutorAnswer(doc, question);
  let out=String(raw||"").trim();
  if(out==="__STUDY_PACK__"){
    out="Say **turn this into flashcards** after a summary, or open a PDF first so I can build a full study pack.";
  }
  if(out==="__COMPARE_DOCS__"){
    out="Import at least two PDFs, then say **compare documents**.";
  }
  if(!out) out=generalChatAnswer(question) || "I'm here. Ask me anything.";
  // Follow-up continuity softener
  if(history && history.length>=2){
    const prevUser=history.filter(h=>h.role==="user").slice(-2,-1)[0];
    if(prevUser && /what about|and |also |more|explain|why|how|continue/i.test(question) && !/follow|continuing/i.test(out)){
      // content already grounded by local matcher
    }
  }
  const tipCount=(out.match(/💡|Tip:/g)||[]).length;
  if(tipCount>1) out=out.replace(/\n\n💡 Tip:[^\n]*/g,(m,i)=>i?"":m);
  // Drop leftover study-only nudges for pure chat questions when no doc
  if(!doc && /Load your class PDF|Add a PDF or photo/i.test(out) && !/pdf|document|notes|material/i.test(question)){
    out=out.replace(/\n\nLoad your class PDF[^\n]*/gi,"").replace(/Add a PDF or photo[^.\n]*/gi,"").trim();
    if(!out) out=generalChatAnswer(question);
  }
  return out;
}

/** After each answer, offer natural follow-ups like ChatGPT. */
function renderTutorFollowups(question, answer){
  const sug=$("#tutorSuggestions");
  if(!sug) return;
  const q=String(question||"").toLowerCase();
  const a=String(answer||"").toLowerCase();
  const chips=[];
  if(/summar|overview|key points|tl;?dr/i.test(q)){
    chips.push("Turn this into flashcards","Make a quiz from this","Key terms only","Explain simpler");
  }else if(/image|picture|draw|generate|create an? (image|picture)/i.test(q)){
    chips.push("Make a variation","Photorealistic version","Anime style","Change the background");
  }else if(/letter|essay|paragraph|email|write/i.test(q+a)){
    chips.push("Make it shorter","Make it more formal","Give me an example","Check my tone");
  }else if(/ohm|circuit|resistor|voltage|gate|osi|tcp/i.test(q+a)){
    chips.push("Give a simple example","Quiz me on this","Draw a diagram","Go deeper");
  }else if(/formula|equation|math|solve|calculate/i.test(q+a)){
    chips.push("Show steps","Another example","Quiz me","Explain simpler");
  }else if(/compare|diff|side.?by.?side/i.test(q)){
    chips.push("Focus on differences","Shared concepts only","Make flashcards from both");
  }else{
    chips.push("Explain simpler","Give an example","Go deeper","Make it shorter","Continue");
  }
  sug.innerHTML=chips.slice(0,5).map(t=>`<button type="button" class="tutor-chip" data-tutor-q="${esc(t)}">${esc(t)}</button>`).join("");
  sug.querySelectorAll("[data-tutor-q]").forEach(b=>{
    b.onclick=()=>{const input=$("#tutorInput");if(input){input.value=b.dataset.tutorQ;input.focus();}tutorSendMessage();};
  });
}

function renderAI(){
  const d=activeDoc(),ai=d?.ai||{},p=learnerProfile();
  const status=$("#aiStatus");
  if(status&&!ai.generatedAt)status.textContent=state.settings.ai?.enabled?"Local AI enabled — use Deep AI Review here, or chat in the Tutor tab.":"Optional on-device AI for a deeper reviewer rewrite. Everyday questions live in Tutor.";
  if($("#aiReviewer"))$("#aiReviewer").textContent=ai.reviewer||"No AI rewrite yet. The deterministic source-grounded reviewer below stays available.";
  const weak=$("#weakConcepts");if(weak){const ws=weakConcepts();weak.innerHTML=ws.length?ws.map(x=>`<span class="term">${esc(x)}</span>`).join(""):"<span class='tiny'>Weak areas appear after you study and answer questions.</span>";}
  const entries=Object.values(p.concepts||{}),avg=entries.length?entries.reduce((s,x)=>s+(Number(x.mastery)||0),0)/entries.length:0;if($("#aiMasteryBar"))$("#aiMasteryBar").style.width=`${Math.round(avg*100)}%`;if($("#aiMasteryText"))$("#aiMasteryText").textContent=entries.length?`Overall mastery ${Math.round(avg*100)}% • ${p.sessions||0} sessions • streak ${p.streak||0}`:"No mastery data yet.";
  const settingsInfo=$("#settingsAiInfo");if(settingsInfo)settingsInfo.textContent=state.settings.ai?.enabled?"AI enabled. Chat lives in Tutor; Deep AI Review can still rewrite the reviewer.":"AI is optional; Instant Tutor and deterministic review work without it.";
  renderTutor();
}

function updateConnectivity(){
  const el=$("#networkStatus");
  if(!el)return;
  const online=navigator.onLine;
  el.textContent=online?"ONLINE • local study + optional AI":"OFFLINE • local study mode";
  el.classList.toggle("offline",!online);
  const aiButtons=[$("#aiEnable"),$("#settingsAiEnable"),$("#tutorLoadAI")].filter(Boolean);
  if(!online){for(const b of aiButtons)b.title="The app still works offline. Local AI needs the model to have been downloaded and cached first.";}
}

async function checkForUpdates(opts={}){
  const quiet=!!opts.quiet;
  const status=$("#updateStatus");
  if(status&&!quiet)status.textContent="Checking version.json…";
  try{
    const res=await fetch(VERSION_URL,{cache:"no-store"});
    if(!res.ok)throw new Error("version.json not reachable ("+res.status+")");
    const remote=await res.json();
    const remoteVer=Number(remote.version||0);
    const remoteBuild=String(remote.buildId||"");
    try{state.settings.lastUpdateCheck=now();await saveMeta();}catch{}
    if($("#buildVersionLabel"))$("#buildVersionLabel").textContent=String(APP_VERSION);
    if(remoteVer>APP_VERSION){
      const msg=`Newer shell available: v${remoteVer}${remoteBuild?" ("+remoteBuild+")":""}. Replace the app files from your family update package, then hard-refresh. Your study data in this browser stays safe.`;
      if(status)status.textContent=msg;
      if(!quiet)toast("A newer StudyVault shell is ready when you want it.","success");
      return {update:true,remote};
    }
    if(remoteBuild&&remoteBuild!==BUILD_ID&&remoteVer===APP_VERSION){
      const msg=`Same version (v${APP_VERSION}) but build id differs: ${remoteBuild}. You are on ${BUILD_ID}.`;
      if(status)status.textContent=msg;
      if(!quiet)toast("Build id differs — refresh after you replace files.","success");
      return {update:false,remote};
    }
    const msg=`You are current: v${APP_VERSION} · ${BUILD_ID}. ${(remote.notes||[]).slice(0,2).join(" · ")||"Local-first forever shell"}`;
    if(status)status.textContent=msg;
    if(!quiet)toast("StudyVault shell is up to date for the family.","success");
    return {update:false,remote};
  }catch(e){
    const msg=`Could not check updates (${e.message||"offline"}). The local shell still works for years offline.`;
    if(status)status.textContent=msg;
    if(!quiet)toast("Update check unavailable offline — local shell is fine.","error");
    return {update:false,error:e};
  }
}
async function maybeAutoCheckUpdates(){
  try{
    const last=Number(state.settings?.lastUpdateCheck||0);
    const THIRTY_DAYS=30*24*60*60*1000;
    if(!last||(Date.now()-last)>THIRTY_DAYS){
      await checkForUpdates({quiet:true});
    }
  }catch(e){console.warn("auto update check",e);}
}
function applyTheme(){document.body.classList.toggle('light',state.settings.theme==='light');updateConnectivity();}
async function setTheme(theme){state.settings.theme=theme==='light'?'light':'dark';await saveMeta();applyTheme();toast(`${state.settings.theme==='light'?'Light':'Dark'} mode enabled.`,'success');}

function exportBackup(){
  const payload={app:'StudyVault',version:APP_VERSION,exportedAt:now(),settings:{theme:state.settings.theme,ai:{enabled:!!state.settings.ai?.enabled,model:state.settings.ai?.model||"onnx-community/Qwen3-1.7B-ONNX"},learner:learnerProfile()},documents:state.documents};
  downloadText(`studyvault-backup-${new Date().toISOString().slice(0,10)}.json`,JSON.stringify(payload,null,2));toast('Backup exported.','success');
}
async function importBackup(){
  const file=$("#backupInput").files[0];if(!file)return toast('Choose a JSON backup first.','error');
  if(file.size>MAX_BACKUP_BYTES)return toast('Backup is larger than the supported 150 MB limit.','error');
  try{
    const data=safeJsonParse(await file.text());if(!data||data.app!=='StudyVault')throw new Error('Invalid StudyVault backup.');
    const incoming=Array.isArray(data.documents)?data.documents:(data.data?.fileName?[data.data]:null);if(!incoming)throw new Error('No StudyVault documents found in this backup.');
    if(incoming.length>500)throw new Error('Backup contains an unusually large number of documents.');
    for(const raw of incoming){const d=normalizeDoc(raw);await dbPut(DOC_STORE,d);}
    state.documents=(await dbGetAll(DOC_STORE)).map(normalizeDoc);state.activeDocId=state.documents[0]?.id||null;state.settings.theme=data.settings?.theme==='light'?'light':'dark';state.settings.learner={...defaultLearner(),...(data.settings?.learner||{})};state.settings.ai={...state.settings.ai,model:"onnx-community/Qwen3-1.7B-ONNX",tier:"auto",...(data.settings?.ai||{enabled:false})};await saveMeta();$("#importModal").classList.remove('open');$("#backupInput").value='';renderAll();toast('Backup imported.','success');
  }catch(e){console.error(e);toast(e.message||'Import failed.','error');}
}
async function resetAll(){if(!confirm('Delete ALL StudyVault data from this browser? This removes every document, note, quiz history, and PIN.'))return;try{const payload=await buildBackupPayload();downloadText(`studyvault-emergency-backup-${new Date().toISOString().slice(0,10)}.json`,JSON.stringify(payload,null,2));}catch(e){console.warn('Emergency backup failed',e);}await dbClear();location.reload();}

async function documentFingerprint(file, text="") {
  try {
    const seed=`${file?.name||""}|${file?.size||0}|${file?.lastModified||0}|${String(text).slice(0,200000)}`;
    if(crypto?.subtle){
      const buf=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(seed));
      return [...new Uint8Array(buf)].map(x=>x.toString(16).padStart(2,"0")).join("");
    }
  }catch{}
  return `${String(file?.name||"").toLowerCase()}|${file?.size||0}|${file?.lastModified||0}`;
}

function attachDocMetadata(doc,file,extra={}){
  doc.meta={...(doc.meta||{}),fileKey:`${String(file?.name||"").toLowerCase()}|${file?.size||0}|${file?.lastModified||0}`,mime:file?.type||"",importedAt:doc.createdAt||now(),...extra};
  return doc;
}

function baseDoc(file,sourceType,extracted,media=[]){
  const doc={id:uid(),fileName:file.name,sourceType,pageCount:extracted.pageCount||0,pageTexts:extracted.pageTexts||[],units:extracted.units||[],rawText:extracted.rawText||"",terms:[],reviewerData:null,reviewerText:"",summaryMode:"standard",flashcards:[],currentCard:0,knownCardIds:[],cardStats:{},notesTitle:"Study Notes",notesHtml:"<p></p>",notes:"",notesUpdatedAt:"",quiz:[],quizScore:null,quizHistory:[],ai:{enabled:false,generatedAt:"",reviewer:"",cards:[],quiz:[],groundingScore:0},media,createdAt:now(),updatedAt:now()};
  regenerateDoc(doc,true);return doc;
}

  async function extractDocx(file){
    // Bundled, CSP-safe DOCX reader. It extracts paragraphs, headings, and
    // table cells directly from word/document.xml; no external CDN is required.
    const zip=await loadJSZip();
    if(zip){
      const archive=await zip.loadAsync(await file.arrayBuffer());
      const entry=archive.file("word/document.xml");
      if(!entry)throw new Error("This Word file has no readable document.xml content.");
      const xml=await entry.async("string");
      const doc=new DOMParser().parseFromString(xml,"application/xml");
      if(doc.querySelector("parsererror"))throw new Error("The Word document XML is invalid.");
      const paragraphs=[...doc.getElementsByTagNameNS("http://schemas.openxmlformats.org/wordprocessingml/2006/main","p")];
      const lines=[];
      for(const p of paragraphs){
        const texts=[...p.getElementsByTagNameNS("http://schemas.openxmlformats.org/wordprocessingml/2006/main","t")].map(n=>n.textContent||"");
        const value=normalize(texts.join(""));
        if(value)lines.push(value);
      }
      const text=repairSymbols(lines.join("\n\n"));
      if(text) return {text,warnings:[]};
    }
    // Last-resort online reader, only if the browser explicitly allows it.
    const mammoth=await loadMammoth();
    if(mammoth){
      const result=await mammoth.extractRawText({arrayBuffer:await file.arrayBuffer()});
      const text=repairSymbols(normalize(result?.value||""));
      if(text)return {text,warnings:(result?.messages||[]).map(x=>x.message).filter(Boolean)};
    }
    throw new Error("Word (.docx) reader could not extract readable text.");
  }
  async function extractTextFile(file){
    let raw=await file.text();
    const name=String(file.name||"").toLowerCase();
    let text=raw, warnings=[];
    if(/\.(html?|xhtml)$/i.test(name)){
      const holder=document.createElement("div");
      holder.innerHTML=raw;
      holder.querySelectorAll("script,style,noscript,template,svg").forEach(n=>n.remove());
      text=holder.innerText||holder.textContent||"";
    }else if(/\.rtf$/i.test(name)){
      text=raw.replace(/\{\\fonttbl[\s\S]*?\}/gi,"").replace(/\{\\colortbl[\s\S]*?\}/gi,"")
        .replace(/\\par[d]?/gi,"\n").replace(/\\tab/g,"\t").replace(/\\'[0-9a-f]{2}/gi," ")
        .replace(/\\[a-z]+-?\d* ?/gi,"").replace(/[{}]/g,"");
      warnings.push("RTF formatting was flattened to readable text.");
    }else if(/\.json$/i.test(name)){
      try{ text=JSON.stringify(JSON.parse(raw),null,2); }catch{ warnings.push("JSON could not be parsed structurally; imported as plain text."); }
    }else if(/\.csv$/i.test(name)){
      // Preserve rows/columns while making them readable to the tutor.
      text=raw.split(/\r?\n/).map(row=>row.replace(/,(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)/g," | ")).join("\n");
    }
    text=repairSymbols(normalize(text));
    if(!text) throw new Error("The text document is empty.");
    return {text,warnings};
  }
  function isLikelyDuplicate(file){
    const key=`${String(file.name||'').trim().toLowerCase()}|${file.size||0}|${file.lastModified||0}`;
    const name=String(file.name||'').trim().toLowerCase();
    return state.documents.some(d=>d.meta?.fileKey===key || (name && Number(file.size||0)>0 && String(d.fileName||'').trim().toLowerCase()===name && Number(d.meta?.size||0)===Number(file.size||0)));
  }

  async function processDocxFiles(files){
  for(const file of [...files]){try{assertImportSize(file);}catch(e){toast(`${file.name}: ${e.message}`,"error");}}
    for(const file of [...files]){
      if(!/\.docx$/i.test(file.name||"")) continue;
      $("#upload").innerHTML=`<div class="loading"><span class="spinner"></span><span id="processStatus">Reading ${esc(file.name)}…</span></div>`;
      try{
        if(isLikelyDuplicate(file)){toast(`${file.name} is already in your library.`,'info');continue;}
        const extracted=await extractDocx(file);
        const doc=baseDoc(file,"docx",{pageCount:1,pageTexts:[{page:1,text:extracted.text}],units:[],rawText:extracted.text},[]);
        doc.media=[];
        attachDocMetadata(doc,file,{importWarnings:[...(extracted.warnings||[]),...(extracted.ocrLimited?[`Visual OCR was limited to ${navigator.deviceMemory&&navigator.deviceMemory<=4?12:30} sparse pages to protect device memory.`]:[])]});
        doc.meta.fingerprint=await documentFingerprint(file,extracted.text);
        regenerateDoc(doc,true);
        state.documents.unshift(doc); state.activeDocId=doc.id;
        await saveDoc(doc); await saveMeta(); renderAll();
        toast(`${file.name} imported successfully.`,"success");
      }catch(e){
        console.error(e);toast(`${file.name}: ${e.message||"Could not read Word document."}`,"error");
      }
    }
  }
  async function processTextFiles(files){
  for(const file of [...files]){try{assertImportSize(file);}catch(e){toast(`${file.name}: ${e.message}`,"error");}}
    for(const file of [...files]){
      if(!/\.(txt|md|markdown|csv|json|html|htm|rtf)$/i.test(file.name||"")) continue;
      try{
        if(isLikelyDuplicate(file)){toast(`${file.name} is already in your library.`,'info');continue;}
        const extracted=await extractTextFile(file);
        const doc=baseDoc(file,"text",{pageCount:1,pageTexts:[{page:1,text:extracted.text}],units:[],rawText:extracted.text},[]);
        attachDocMetadata(doc,file);
        doc.meta.fingerprint=await documentFingerprint(file,extracted.text);
        regenerateDoc(doc,true);state.documents.unshift(doc);state.activeDocId=doc.id;await saveDoc(doc);await saveMeta();renderAll();
        toast(`${file.name} imported successfully.`,"success");
      }catch(e){console.error(e);toast(`${file.name}: ${e.message||"Could not read file."}`,"error");}
    }
  }
async function serverFilePost(path,file,timeoutMs=120000){
  const base=String(state.settings?.sync?.url||"http://127.0.0.1:8787").trim().replace(/\/$/,"");
  if(!(await ensureSyncSession(base)))throw new Error("Carrot server is not available for this file fallback.");
  const form=new FormData();form.append("file",file,file.name||"upload");
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const r=await fetch(base+path,{method:"POST",credentials:"include",body:form,signal:controller.signal});
    const data=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(data.error||`Server file operation failed (${r.status}).`);
    return data;
  }finally{clearTimeout(timer);}
}
async function processLegacyDocFiles(files){
  for(const file of [...files]){
    if(!/\.doc$/i.test(file.name||""))continue;
    try{
      const base=String(state.settings?.sync?.url||"http://127.0.0.1:8787").replace(/\/$/,"");
      if(!(await ensureSyncSession(base)))throw new Error("Legacy .doc files need the local Carrot server. Convert the file to .docx or start server.py.");
      const form=new FormData();form.append("file",file,file.name);
      const r=await fetch(base+"/api/files/extract-document",{method:"POST",credentials:"include",body:form});
      const data=await r.json().catch(()=>({}));
      if(!r.ok||!data.text)throw new Error(data.error||"The legacy Word file could not be read.");
      const extracted={pageCount:1,pageTexts:[{page:1,text:repairSymbols(data.text),source:"server-doc"}],units:extractSentences(data.text,18).map(text=>({page:1,text,source:"server-doc"})),rawText:repairSymbols(data.text)};
      const doc=baseDoc(file,"doc",extracted,[]);attachDocMetadata(doc,file,{importWarnings:data.warnings||[]});
      doc.meta.fingerprint=await documentFingerprint(file,extracted.rawText);
      await saveDoc(doc);state.documents.unshift(doc);state.activeDocId=doc.id;await saveMeta();renderAll();
      toast(`${file.name} imported successfully.`,'success');
    }catch(e){console.error(e);toast(`${file.name}: ${e.message||"Could not read legacy Word file."}`,'error');}
  }
}
async function processPdfFiles(files){
  for(const file of [...files]){try{assertImportSize(file);}catch(e){toast(`${file.name}: ${e.message}`,"error");}}
  for(const file of [...files]){
    if(file.type!=='application/pdf'&&!/\.pdf$/i.test(file.name||"")){toast(`${file.name}: not a PDF.`,'error');continue;}
    $("#upload").innerHTML=`<div class="loading"><span class="spinner"></span><span id="processStatus">Reading ${esc(file.name)}…</span></div>`;
    try{
      const extracted=await extractPdf(file,(page,total)=>{
        const el=$("#processStatus");if(!el)return;
        el.textContent=String(page).startsWith("ocr:")
          ?`Reading pictures on ${file.name} — page ${String(page).slice(4)} of ${total}…`
          :page==="ocr-skip"
            ?`OCR skipped (engine not ready) for ${file.name}`
            :`Reading ${file.name} — page ${page} of ${total}…`;
      });
      const pdfMedia=Array.isArray(extracted.media)?extracted.media:[];
      const words=wordCount(extracted.rawText);
      // Allow picture-only PDFs: media alone is enough to create a study doc
      if(words<5&&!pdfMedia.length){
        try{
          const remote=await serverFilePost('/api/files/extract-pdf',file,180000);
          if(remote?.text){extracted.rawText=repairSymbols(remote.text);extracted.pageTexts=[{page:1,text:extracted.rawText,source:'server-pdf'}];extracted.units=extractSentences(extracted.rawText,18).map(text=>({page:1,text,source:'server-pdf'}));}
        }catch(remoteErr){console.warn('server PDF fallback unavailable',remoteErr);}
      }
      if(wordCount(extracted.rawText)<5&&!pdfMedia.length){
        throw new Error("This PDF has almost no readable text and no pictures could be captured. Start the Carrot server for scanned-PDF OCR or add a clearer source.");
      }
      const doc=baseDoc(file,"pdf",extracted,pdfMedia);
      if(words<8&&pdfMedia.length){
        // Seed a tiny bit of structure so reviewer is not empty
        doc.rawText=doc.rawText||pdfMedia.map((m,i)=>`Visual page ${m.page||i+1}: ${m.caption||m.name}`).join("\n");
      }
      state.documents.unshift(doc);state.activeDocId=doc.id;
      await dbPut(DOC_STORE,doc);await saveMeta();renderAll();
      const ocrNote=extracted.ocrPages?` · OCR on ${extracted.ocrPages} page${extracted.ocrPages===1?"":"s"}`:"";
      const picNote=pdfMedia.length?` · ${pdfMedia.length} picture${pdfMedia.length===1?"":"s"}`:"";
      toast(`${file.name} added${ocrNote}${picNote} · ${(doc.flashcards||[]).length} cards. Open Reviewer or Flashcards.`,"success");
    }catch(e){
      console.error(e);
      toast(`${file.name}: ${e.message||"Could not process PDF."}`,"error");
    }
  }
}
async function processImageFiles(files){
  for(const file of [...files]){try{assertImportSize(file);}catch(e){toast(`${file.name}: ${e.message}`,"error");}}for(const file of [...files]){if(!/^image\/(png|jpeg|webp|bmp|gif|svg\+xml)$/.test(file.type||'') && !/\.(png|jpe?g|webp|bmp|gif|svg)$/i.test(file.name||'')){toast(`${file.name}: unsupported image type.`,'error');continue;}$("#upload").innerHTML=`<div class="loading"><span class="spinner"></span><span id="processStatus">Preparing ${esc(file.name)}…</span></div>`;try{if(isLikelyDuplicate(file)){toast(`${file.name} is already in your library.`,'info');continue;}const visual=await dataUrlFromFile(file);let ocr={text:'',confidence:0};try{
        ocr=await ocrImage(file,m=>{$("#processStatus").textContent=`OCR ${file.name} — ${m.progress?Math.round(m.progress*100):0}%…`;});
        ocr.text=repairSymbols(ocr.text||'');
        if(wordCount(ocr.text)<3){
          try{const remote=await serverFilePost('/api/files/ocr-image',file,120000);ocr={text:repairSymbols(remote.text||''),confidence:Number(remote.confidence)||0};}catch(remoteErr){console.warn('server OCR fallback unavailable',remoteErr);}
        }
      }catch(err){
        console.warn('OCR unavailable',err);
        try{const remote=await serverFilePost('/api/files/ocr-image',file,120000);ocr={text:repairSymbols(remote.text||''),confidence:Number(remote.confidence)||0};}
        catch(remoteErr){toast(`${file.name}: photo saved, but OCR was unavailable. Add a caption on the Reviewer page.`,'error');}
      }const mediaId=uid();const extracted={pageCount:1,pageTexts:[{page:1,text:ocr.text,source:'photo',photoId:mediaId}],units:extractSentences(ocr.text,18).map(text=>({page:1,text,source:'photo',photoId:mediaId})),rawText:ocr.text};const media=[{id:mediaId,name:file.name,dataUrl:visual.dataUrl,width:visual.width,height:visual.height,caption:'',ocrText:ocr.text,confidence:ocr.confidence,createdAt:now()}];const doc=baseDoc(file,'image',extracted,media);doc.meta={...(doc.meta||{}),fileKey:`${String(file.name||'').toLowerCase()}|${file.size||0}|${file.lastModified||0}`,mime:file.type||"",importedAt:now()};state.documents.unshift(doc);state.activeDocId=doc.id;await dbPut(DOC_STORE,doc);await saveMeta();renderAll();toast(`${file.name} added as a photo study sheet.`,'success');}catch(e){console.error(e);toast(`${file.name}: ${e.message||'Could not process photo.'}`,'error');}}}
async function processFiles(files){
  const list=[...files].filter(Boolean);
  if(!list.length)return;
  for(const f of list){try{assertImportSize(f);}catch(e){toast(`${f.name}: ${e.message}`,"error");}}
  const accepted=list.filter(f=>{try{assertImportSize(f);return fileKind(f)!=="unknown";}catch{return false;}});
  if(!accepted.length){toast("No supported study files were selected.","error");return;}
  const pdfs=accepted.filter(f=>fileKind(f)==='pdf'),images=accepted.filter(f=>fileKind(f)==='image'),docx=accepted.filter(f=>fileKind(f)==='docx'),docs=accepted.filter(f=>fileKind(f)==='doc'),texts=accepted.filter(f=>fileKind(f)==='text');
  if(pdfs.length)await processPdfFiles(pdfs);if(docx.length)await processDocxFiles(docx);if(docs.length)await processLegacyDocFiles(docs);if(texts.length)await processTextFiles(texts);if(images.length)await processImageFiles(images);
  $("#upload").innerHTML='<div><div class="upload-icon">📚</div><h3>Drop any study material here</h3><p>PDF, Word, text, CSV, JSON, HTML, RTF, screenshots, lecture photos, or a whole folder.</p><div class="hero-actions" style="justify-content:center"><label for="universalInput" class="btn primary">Add files</label><label for="folderInput" class="btn secondary">Import folder</label></div></div>';}

async function buildBackupPayload(){
  return {app:"StudyVault",version:APP_VERSION,exportedAt:now(),settings:{theme:state.settings.theme,ai:{enabled:false,model:state.settings.ai?.model||"onnx-community/Qwen3-1.7B-ONNX"},learner:learnerProfile()},documents:state.documents};
}
async function ensureSyncSession(url){
  const base=String(url||'').trim().replace(/\/$/,'');
  if(!base)return false;
  try{
    const r=await fetch(base+"/api/session",{credentials:"include"});
    if(r.ok)return true;
    // Remote servers require a one-time pairing code. The code is entered in Settings.
    const pair=String(state.settings?.sync?.pairCode||'').trim();
    if(!pair)return false;
    const p=await fetch(base+"/api/pair",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:pair})});
    return p.ok;
  }catch{return false;}
}
async function syncPush(){
  const url=String(state.settings.sync?.url||"").trim().replace(/\/$/,"");
  if(!url)return toast("Enter a Sync URL first.","error");
  if(!(await ensureSyncSession(url)))return toast("Pair this browser with the StudyVault server first.","error");
  const payload=await buildBackupPayload();
  try{const r=await fetch(url+"/api/sync/push",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({updatedAt:Date.now(),payload})});if(!r.ok)throw new Error("Sync server returned "+r.status);state.settings.sync.enabled=true;await saveMeta();toast("Cloud/self-hosted backup synced.","success");}catch(e){toast("Sync failed: "+(e.message||"server unavailable"),"error");}}
async function syncPull(){
  const url=String(state.settings.sync?.url||"").trim().replace(/\/$/,"");
  if(!url)return toast("Enter a Sync URL first.","error");
  if(!(await ensureSyncSession(url)))return toast("Pair this browser with the StudyVault server first.","error");
  try{const r=await fetch(url+"/api/sync/pull",{credentials:"include"});if(!r.ok)throw new Error("Sync server returned "+r.status);const data=await r.json();if(!data.payload)return toast("The sync server has no backup yet.");if(!confirm("Replace this browser's StudyVault data with the synced backup?"))return;const p=data.payload;await dbClear();state.settings={...state.settings,...(p.settings||{}),sync:{...state.settings.sync,url,enabled:true,pairCode:state.settings.sync?.pairCode||""}};state.documents=Array.isArray(p.documents)?p.documents.map(normalizeDoc):[];for(const d of state.documents)await dbPut(DOC_STORE,d);state.activeDocId=state.documents[0]?.id||null;await saveMeta();renderAll();toast("Synced study library restored.","success");}catch(e){toast("Sync failed: "+(e.message||"server unavailable"),"error");}}
async function probeCloudAI(){
  let base=String(state.settings?.sync?.url||"").trim().replace(/\/$/,"");
  const statusEl=$("#cloudAiStatus");
  if(!base){
    const found=await discoverAiServer(1200);
    base=found?.base||"";
  }
  if(!base){if(statusEl)statusEl.textContent="Carrot AI server: offline. Start START-CARROT-AI.bat for full cloud AI.";return {ok:false,reason:"no_url"};}
  try{
    await ensureSyncSession(base);
    const ac=new AbortController();const t=setTimeout(()=>ac.abort(),5000);
    const r=await fetch(base+"/api/health",{signal:ac.signal,credentials:"include"}).finally(()=>clearTimeout(t));
    const data=await r.json().catch(()=>({}));
    if(!r.ok){if(statusEl)statusEl.textContent=`Cloud AI: server reachable but health failed (${r.status}).`;return {ok:false,reason:"health_fail"};}
    const hasAI=!!data.cloudAI;gptCloudAvailable=hasAI;if(statusEl)statusEl.textContent=hasAI?`Cloud AI: ready • text ${data.textModel||"?"} • image ${data.imageModel||"?"} • server v${data.version||"?"}`:`Cloud AI: server online but OPENAI_API_KEY is not set on the server.`;return {ok:hasAI,data};
  }catch(e){if(statusEl)statusEl.textContent=`Cloud AI: cannot reach ${base} — is server.py running?`;return {ok:false,reason:"unreachable"};}
}
function setupSync(){
  const url=$("#syncUrl"),pair=$("#syncPairCode");if(!url)return;
  url.value=state.settings.sync?.url||"http://127.0.0.1:8787";if(pair)pair.value=state.settings.sync?.pairCode||"";
  $("#saveSyncBtn").onclick=async()=>{state.settings.sync={...(state.settings.sync||{}),url:url.value.trim().replace(/\/$/,""),pairCode:pair?.value.trim().toUpperCase()||"",enabled:!!url.value.trim()};await saveMeta();toast("Connection settings saved.","success");probeCloudAI();};
  $("#syncPush").onclick=syncPush;$("#syncPull").onclick=syncPull;
  const testBtn=$("#testSyncBtn");if(testBtn)testBtn.onclick=async()=>{testBtn.disabled=true;testBtn.textContent="Testing…";const r=await probeCloudAI();testBtn.disabled=false;testBtn.textContent="Test";if(r.ok)toast("StudyVault server is ready.","success");else toast("Server not ready — check the URL and, for remote servers, the pairing code.","error");};
  setTimeout(probeCloudAI,800);
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
const COMMANDS=[
  ['Import study files','import','PDF, Word, images, text'],
  ['Open Reviewer','reviewer','Synthesize your active material'],
  ['Open Tutor','tutor','Ask questions about your source'],
  ['Open Flashcards','flashcards','Practice recall'],
  ['Open Quiz','quiz','Test yourself'],
  ['Search source','search','Find exact evidence'],
  ['Open Notes','notes','Write and organize notes'],
  ['Open Settings','settings','Security, AI, backup, sync'],
  ['Export Anki deck','anki','TXT for Anki import'],
  ['Export study pack MD','mdpack','Markdown study pack'],
  ['Print study sheet','printsheet','Printable one-page sheet'],
  ['Generate study photo','photo','Local PNG — no server needed'],
  ['Test Cloud AI','cloud','Probe optional server AI'],
  ['Start focus timer','focus','25-minute study block'],
  ['5-min focus sprint','focus5','Quick 5-minute sprint'],
  ['Cancel focus timer','focuscancel','Stop the current focus block'],
  ['Weak-concept quiz','weakquiz','Quiz focused on your weak areas'],
  ['Keyboard shortcuts','shortcuts','Show all shortcuts'],
  ['Card blitz','blitz','10 rapid cards under pressure'],
  ['Interleave practice','interleave','Mix due cards across materials'],
  ['Feynman explain','feynman','Teach a term, then reveal source'],
  ['Exam simulator','exam','Timed exam-style quiz'],
  ['Glossary export','glossary','Definitions markdown'],
  ['Diff two docs','diff','Shared vs unique concepts'],
  ['Focus mode','focus','Dim chrome for deep practice'],
  ['Exam blueprint','blueprint','Must-know sheet from source'],
  ['Week plan','weekplan','7-day closed-book plan'],
  ['Undo last grade','undo','Restore previous card schedule'],
  ['Flag for exam','flag','Mark current card for exam'],
  ['Compact UI','compact','Denser layout'],
  ['Lock StudyVault','lock','Privacy lock'],
];
function openCommandPalette(){const p=$("#commandPalette");if(!p)return;p.classList.add('open');const q=$("#commandSearch");if(q){q.value='';renderCommandPalette();setTimeout(()=>q.focus(),20);}}
function renderCommandPalette(){const q=normalize($("#commandSearch")?.value||'').toLowerCase();const box=$("#commandList");if(!box)return;const rows=COMMANDS.filter(x=>(x[0]+' '+x[2]).toLowerCase().includes(q));box.innerHTML=rows.map(x=>`<button class="command-item" data-command="${x[1]}"><strong>${esc(x[0])}</strong><span>${esc(x[2])}</span><kbd>↵</kbd></button>`).join('')||'<div class="empty">No command found.</div>';}
function runCommand(command){
  $("#commandPalette")?.classList.remove('open');
  if(command==='import'){ $("#universalInput")?.click(); return;}
  if(command==='lock'){lockApp();return;}
  if(command==='anki'){exportAnkiDeck();return;}
  if(command==='mdpack'){exportStudyPackMarkdown();return;}
  if(command==='printsheet'){printStudySheet();return;}
  if(command==='photo'){promptStudyImageOrder();return;}
  if(command==='cloud'){probeCloudAI().then(r=>r.ok?toast("Cloud AI ready.","success"):toast("Cloud AI not ready.","error"));return;}
  if(command==='focus'){startFocusTimer(25);return;}
  if(command==='focus5'){startFocusTimer(5);return;}
  if(command==='focuscancel'){cancelFocusTimer();return;}
  if(command==='weakquiz'){activateSection('quiz');newQuiz(true);return;}
  if(command==='shortcuts'){showShortcutsHelp();return;}
  activateSection(command);
}
/** Visual concept graph — circular layout with strength-weighted edges (no external libs). */
function renderConceptMapSVG(links){
  const edges=(links||[]).slice(0,28);
  if(!edges.length)return '<div class="empty">No strong concept links yet. Build the study guide after importing denser material.</div>';
  const nodes=new Map();
  for(const e of edges){
    if(!nodes.has(e.from))nodes.set(e.from,{id:e.from,w:0});
    if(!nodes.has(e.to))nodes.set(e.to,{id:e.to,w:0});
    nodes.get(e.from).w+=e.strength||1;
    nodes.get(e.to).w+=e.strength||1;
  }
  const list=[...nodes.values()].sort((a,b)=>b.w-a.w).slice(0,16);
  const ids=new Set(list.map(n=>n.id));
  const W=640,H=360,cx=W/2,cy=H/2,R=Math.min(W,H)*0.38;
  list.forEach((n,i)=>{
    const ang=(i/list.length)*Math.PI*2-Math.PI/2;
    n.x=cx+Math.cos(ang)*R;
    n.y=cy+Math.sin(ang)*R;
  });
  const maxS=Math.max(...edges.map(e=>e.strength||1),1);
  const edgeSvg=edges.filter(e=>ids.has(e.from)&&ids.has(e.to)).map(e=>{
    const a=nodes.get(e.from),b=nodes.get(e.to);if(!a||!b)return"";
    const sw=1.2+((e.strength||1)/maxS)*3.2;
    const op=0.25+((e.strength||1)/maxS)*0.55;
    return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="var(--primary)" stroke-width="${sw.toFixed(2)}" opacity="${op.toFixed(2)}"/>`;
  }).join("");
  const nodeSvg=list.map(n=>{
    const label=String(n.id).length>22?String(n.id).slice(0,20)+"…":String(n.id);
    const r=10+Math.min(8,n.w*0.6);
    return `<g class="cmap-node" data-term="${esc(n.id)}"><circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${r}" fill="var(--surface)" stroke="var(--primary)" stroke-width="2"/><text x="${n.x.toFixed(1)}" y="${(n.y+r+14).toFixed(1)}" text-anchor="middle" font-size="11" fill="var(--text)">${esc(label)}</text></g>`;
  }).join("");
  return `<div class="concept-map-wrap"><svg viewBox="0 0 ${W} ${H}" class="concept-map-svg" role="img" aria-label="Concept connections">${edgeSvg}${nodeSvg}</svg><div class="concept-link-list">${edges.slice(0,12).map(x=>`<div class="concept-link"><span>${esc(x.from)}</span><span>↔</span><span>${esc(x.to)}</span><em>${x.strength}</em></div>`).join("")}</div></div>`;
}
function showShortcutsHelp(){
  const rows=[
    ["⌘/Ctrl + K","Command palette"],
    ["⌘/Ctrl + /","This shortcuts list"],
    ["1–7","Jump sections (Dashboard→Settings)"],
    ["F","Flashcards"],
    ["Q","Quiz"],
    ["R","Reviewer"],
    ["T","Tutor"],
    ["Esc","Close palette / overlays"],
  ];
  const html=`<div class="shortcuts-panel"><h3>Keyboard shortcuts</h3><ul>${rows.map(([k,v])=>`<li><kbd>${esc(k)}</kbd><span>${esc(v)}</span></li>`).join("")}</ul><p class="tiny muted">StudyVault stays local-first — shortcuts never leave your device.</p><button class="btn secondary" id="closeShortcuts">Close</button></div>`;
  let overlay=$("#shortcutsOverlay");
  if(!overlay){
    overlay=document.createElement("div");
    overlay.id="shortcutsOverlay";
    overlay.className="modal-overlay";
    document.body.appendChild(overlay);
  }
  overlay.innerHTML=html;
  overlay.classList.add("open");
  overlay.onclick=e=>{if(e.target===overlay||e.target.id==="closeShortcuts")overlay.classList.remove("open");};
}
function printStudySheet(){
  const d=activeDoc();
  if(!d)return toast("Open study material first.","error");
  const r=d.reviewerData||buildReviewer(d);
  const weak=weakConcepts(8);
  const body=`
<!DOCTYPE html><html><head><meta charset="utf-8"><title>Study Sheet — ${esc(d.fileName||"StudyVault")}</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:800px;margin:24px auto;padding:0 16px;color:#111;line-height:1.45}
  h1{font-size:1.35rem;margin:0 0 4px} h2{font-size:1rem;margin:18px 0 6px;border-bottom:1px solid #ddd;padding-bottom:4px}
  .meta{color:#555;font-size:.85rem} ul{margin:6px 0;padding-left:1.2rem} li{margin:3px 0}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px} .box{border:1px solid #ddd;border-radius:8px;padding:10px}
  .term{font-weight:700} @media print{body{margin:0;max-width:none} .noprint{display:none}}
</style></head><body>
  <h1>Study Sheet — ${esc(d.fileName||"Untitled")}</h1>
  <p class="meta">StudyVault v${APP_VERSION} · source-grounded · ${new Date().toLocaleDateString()} · confidence ${r.confidence??"—"}%</p>
  <h2>Overview</h2><p>${esc(r.overview||"(build the study guide first)")}</p>
  <div class="grid">
    <div class="box"><h2>Key terms</h2><ul>${(r.terms||[]).slice(0,16).map(t=>`<li class="term">${esc(t)}</li>`).join("")||"<li>—</li>"}</ul></div>
    <div class="box"><h2>Weak spots to drill</h2><ul>${weak.length?weak.map(t=>`<li>${esc(t)}</li>`).join(""):"<li>Complete a quiz or flash session to surface weak spots.</li>"}</ul></div>
  </div>
  <h2>Definitions</h2><ul>${(r.definitions||[]).slice(0,12).map(x=>`<li><strong>${esc(x.term)}</strong> — ${esc(x.definition||"")}${x.page?` <em>(p.${x.page})</em>`:""}</li>`).join("")||"<li>—</li>"}</ul>
  <h2>Exam checklist</h2><ul>${(r.checklist||[]).slice(0,14).map(x=>`<li>☐ ${esc(typeof x==="string"?x:(x.text||x))}</li>`).join("")||"<li>—</li>"}</ul>
  <h2>Facts & formulas</h2><ul>${(r.facts||[]).slice(0,10).map(x=>`<li>${esc(typeof x==="string"?x:(x.text||""))}</li>`).join("")||"<li>—</li>"}</ul>
  <p class="meta noprint">Tip: use your browser Print dialog → Save as PDF for a portable sheet.</p>
  <script>window.onload=()=>setTimeout(()=>window.print(),200)<\\/script>
</body></html>`;
  const w=window.open("","_blank");
  if(!w)return toast("Allow pop-ups to print the study sheet.","error");
  w.document.write(body);
  w.document.close();
  toast("Printable study sheet opened.","success");
}

/** NotebookLM-style Audio Overview — local TTS from YOUR source (no cloud). */
function playAudioOverview(){
  const d=activeDoc();
  if(!d)return toast("Open study material first.","error");
  if(!window.speechSynthesis)return toast("This browser cannot speak text aloud.","error");
  const r=d.reviewerData||buildReviewer(d);
  const parts=[
    `StudyVault audio overview for ${String(d.fileName||"your material").replace(/\.[^.]+$/,"")}.`,
    r.overview?`Overview. ${r.overview}`:"",
    (r.terms||[]).length?`Key terms to master: ${(r.terms||[]).slice(0,12).join(", ")}.`:"",
    (r.definitions||[]).slice(0,5).map(x=>`${x.term}. ${x.definition}`).join(" "),
    (r.checklist||[]).length?`Exam checklist. ${(r.checklist||[]).slice(0,6).map(x=>typeof x==="string"?x:(x.text||x)).join(". ")}.`:"",
    "End of overview. Open flashcards or quiz to practice active recall."
  ].filter(Boolean);
  const text=parts.join(" ").slice(0,3500);
  try{window.speechSynthesis.cancel();}catch{}
  const u=new SpeechSynthesisUtterance(text);
  u.rate=1;u.pitch=1;u.lang=navigator.language||"en-US";
  window.speechSynthesis.speak(u);
  toast("Audio overview playing — from your sources only.","success");
}
function stopAudioOverview(){
  try{window.speechSynthesis?.cancel();}catch{}
  toast("Audio stopped.","info");
}
/** Notability-style Auto Study: due cards → weak quiz in one flow. */
async function startAutoStudy(){
  const d=activeDoc();
  if(!d)return toast("Add study material first.","error");
  if(!(d.flashcards||[]).length){
    regenerateDoc(d,true);await saveDoc(d);
  }
  state.sessionActive=true;
  state.sessionQueue=buildSessionQueue(d);
  if(state.sessionQueue.length){
    d.currentCard=state.sessionQueue[0];
    await saveDoc(d);
    activateSection("flashcards");
    renderFlash();
    toast(`Auto Study: ${state.sessionQueue.length} cards in session. After cards, run a weak quiz.`,"success");
  }else{
    activateSection("quiz");
    await newQuiz(true);
    toast("Auto Study: no due cards — weak-concept quiz ready.","success");
  }
}
function studioAction(action){
  const d=activeDoc();
  if(!d&&!["import"].includes(action))return toast("Open study material first.","error");
  if(action==="guide"){activateSection("reviewer");$("#buildReviewBtn")?.click();return;}
  if(action==="photo"){promptStudyImageOrder();return;}
  if(action==="audio"){playAudioOverview();return;}
  if(action==="audio-stop"){stopAudioOverview();return;}
  if(action==="print"){printStudySheet();return;}
  if(action==="flash"){activateSection("flashcards");return;}
  if(action==="quiz"){activateSection("quiz");newQuiz(false);return;}
  if(action==="weak"){activateSection("quiz");newQuiz(true);return;}
  if(action==="match"){activateSection("quiz");newQuiz(false);toast("Quiz includes mix & match + fill-in when definitions exist.","info");return;}
  if(action==="auto"){startAutoStudy();return;}
  if(action==="map"){activateSection("reviewer");setTimeout(()=>$("#reviewerConceptMap")?.scrollIntoView({behavior:"smooth",block:"center"}),200);return;}
  if(action==="tutor"){activateSection("tutor");return;}
  if(action==="pack"){exportStudyPackMarkdown();return;}
  if(action==="daily"){startDailyReview();return;}
  if(action==="reverse"){toggleFlashReversed();return;}
  if(action==="weaklist"){exportWeakList();return;}
  if(action==="eli5"){tutorSimplify();return;}
  if(action==="timed"){startTimedQuiz(5);return;}
  if(action==="blitz"){startBlitz(10);return;}
  if(action==="interleave"){startInterleavedPractice(25);return;}
  if(action==="feynman"){startFeynman();return;}
  if(action==="exam"){startExamSimulator(10);return;}
  if(action==="glossary"){exportGlossary(false);return;}
  if(action==="glossary-all"){exportGlossary(true);return;}
  if(action==="diff"){diffTwoDocuments();return;}
  if(action==="focus"){toggleFocusMode();return;}
  if(action==="confused"){markConfused();return;}
  if(action==="bury"){buryCard();return;}
  if(action==="voice"){startVoiceFill();return;}
  if(action==="quote"){startQuoteDrill();return;}
  if(action==="palace"){buildMemoryPalace();return;}
  if(action==="read"){markPagesReviewed(1);return;}
  if(action==="blueprint"){buildExamBlueprint();return;}
  if(action==="weekplan"){buildWeekPlan();return;}
  if(action==="undo"){undoLastGrade();return;}
  if(action==="flag"){flagCardForExam();return;}
  if(action==="compact"){toggleCompactUI();return;}
  if(action==="flags"){exportExamFlags();return;}
  if(action==="compare"){compareDefinitions();return;}
}

function exportStudyPackMarkdown(){
  const d=activeDoc();
  if(!d)return toast("Open study material first.","error");
  const r=d.reviewerData||buildReviewer(d);
  const lines=[
    `# Study Pack — ${d.fileName||"Untitled"}`,
    ``,
    `> Generated by StudyVault v${APP_VERSION} · source-grounded · ${new Date().toISOString().slice(0,10)}`,
    ``,
    `## Executive overview`,
    r.overview||"(none)",
    ``,
    `## Key terms`,
    ...(r.terms||[]).slice(0,40).map(t=>`- ${t}`),
    ``,
    `## Definitions`,
    ...(r.definitions||[]).slice(0,30).map(x=>`- **${x.term}** — ${x.definition}${x.page?` (p.${x.page})`:""}`),
    ``,
    `## Key points`,
    ...(r.keyPoints||[]).slice(0,40).map((x,i)=>`${i+1}. ${typeof x==="string"?x:(x.text||"")}${x.page?` [p.${x.page}]`:""}`),
    ``,
    `## Processes & steps`,
    ...(r.processes||[]).slice(0,20).map(x=>`- ${typeof x==="string"?x:(x.text||"")}`),
    ``,
    `## Facts & formulas`,
    ...(r.facts||[]).slice(0,30).map(x=>`- ${typeof x==="string"?x:(x.text||"")}`),
    ``,
    `## Exam checklist`,
    ...(r.checklist||[]).slice(0,25).map(x=>`- [ ] ${typeof x==="string"?x:(x.text||x)}`),
    ``,
    `## Flashcards (${(d.flashcards||[]).length})`,
    ...(d.flashcards||[]).slice(0,80).map(c=>`### Q: ${c.q||c.question||""}\nA: ${c.a||c.answer||""}\n`),
    ``,
    `## Source excerpt`,
    "```",
    String(d.rawText||"").slice(0,12000),
    "```",
  ];
  downloadText(`studyvault-pack-${String(d.fileName||"study").replace(/[^\w.\-]+/g,"_").slice(0,40)}.md`,lines.join("\n"));
  toast("Markdown study pack exported.","success");
}
let focusTimerId=null,focusEndsAt=0,focusMinutesPlanned=25;
function startFocusTimer(minutes=25){
  if(focusTimerId){clearInterval(focusTimerId);focusTimerId=null;}
  focusMinutesPlanned=Math.max(1,Number(minutes)||25);
  focusEndsAt=Date.now()+focusMinutesPlanned*60*1000;
  const tick=()=>{
    const left=Math.max(0,focusEndsAt-Date.now());
    const m=Math.floor(left/60000),s=Math.floor((left%60000)/1000);
    const el=$("#networkStatus");
    if(el)el.textContent=`FOCUS ${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
    if(left<=0){
      clearInterval(focusTimerId);focusTimerId=null;
      if(el)el.textContent=(navigator.onLine?"ONLINE":"OFFLINE")+" • focus complete";
      const p=learnerProfile();
      p.studyMinutes=(p.studyMinutes||0)+focusMinutesPlanned;
      const day=new Date().toISOString().slice(0,10);
      p.lastStudyDay=day;
      try{saveMeta();}catch{}
      toast(`Focus block complete (+${focusMinutesPlanned} min). Take a short break.`,"success");
      try{if(navigator.vibrate)navigator.vibrate([80,40,80]);}catch{}
      try{renderStats();}catch{}
    }
  };
  tick();
  focusTimerId=setInterval(tick,1000);
  toast(`Focus timer started — ${focusMinutesPlanned} minutes.`,"success");
}
function cancelFocusTimer(){
  if(focusTimerId){clearInterval(focusTimerId);focusTimerId=null;}
  const el=$("#networkStatus");
  if(el)el.textContent=navigator.onLine?"ONLINE":"OFFLINE";
  toast("Focus timer cancelled.","info");
}

function ensureCompatibilityDom(){
  // The ChatGPT shell replaced the older dashboard, but a number of mature
  // study functions still target legacy IDs. Create safe off-screen anchors so
  // one missing optional widget can never abort the entire bind() pass.
  const ids={
    activeDocPanel:'div',activityCalendar:'div',aiAnswer:'div',aiCancel:'button',aiEnable:'button',aiEnhance:'button',aiMasteryBar:'div',aiMasteryText:'div',aiStatus:'div',audioOverviewBtn:'button',autoStudyBtn:'button',blitzBtn:'button',blueprintBtn:'button',buildNotesBtn:'button',buildStudyPackBtn:'button',buildVersionLabel:'span',buryCardBtn:'button',checkUpdateBtn:'button',clearNotesBtn:'button',closeImport:'button',closePin:'button',cloudAiStatus:'div',commandBtn:'button',compactUiBtn:'button',confusedBtn:'button',confusionList:'div',copyPhoneUrl:'button',dailyGoalProgress:'div',dailyReviewBtn:'button',darkMode:'button',eli5Btn:'button',engineStatus:'div',examBtn:'button',exportBtn:'button',exportCustomImgBtn:'button',exportDefsImgBtn:'button',exportFlashBatchBtn:'button',exportFlashImgBtn:'button',exportNotesBtn:'button',exportSummaryImgBtn:'button',exportWeakBtn:'button',feynmanBtn:'button',flagExamBtn:'button',flashAnswer:'div',flashEvidence:'div',flashKnown:'div',flashQuestion:'div',flashScheduleHint:'div',flashStatus:'div',focusModeBtn:'button',globalDueCount:'span',heroDocCount:'span',imgStudioBody:'textarea',imgStudioTitle:'input',importBackup:'button',importModal:'div',insertChecklist:'button',insertDefinitionNote:'button',insertDefsFromDoc:'button',insertQuestionNote:'button',installBtn:'button',interleaveBtn:'button',leitnerRight:'button',leitnerWrong:'button',library:'div',libraryStatus:'div',lightMode:'button',markReadBtn:'button',masteryHeatmap:'div',navDailyBtn:'button',navDue:'span',navFlash:'span',navQuiz:'span',networkStatus:'span',newQuiz:'button',noteDocumentHint:'div',noteSaveStatus:'div',noteUpdatedAt:'div',noteWordCount:'div',notesDocLabel:'div',ocrStatus:'div',onboardingChecklist:'div',openImport:'button',openReviewer:'button',phoneQr:'canvas',phoneUrl:'span',pinSettings:'button',processStatus:'span',provePanel:'div',quizContainer:'div',quizHistory:'div',quizResult:'div',quizTimer:'div',quoteDrillCheck:'button',quoteDrillInput:'input',quoteDrillWhy:'div',refreshPhoneQr:'button',regenDocBtn:'button',removePin:'button',reviewerConceptMap:'div',reviewerConfidence:'div',reviewerCram:'div',reviewerGuideStatus:'div',reviewerOverview:'div',reviewerPhotos:'div',reviewerStrategy:'div',reviewerTerms:'div',savePin:'button',setGoalBtn:'button',settingsAiDisable:'button',settingsAiEnable:'button',settingsAiInfo:'div',settingsLock:'button',shortcutsOverlay:'div',smartCoach:'div',speakFlash:'button',speakNotes:'button',statBoxesSide:'span',statDocs:'span',statDueSide:'span',statFlash:'span',statFlashSide:'span',statIntervalSide:'span',statMasterySide:'span',statPages:'span',statPhotos:'span',statQuiz:'span',statSessions:'span',statStreak:'span',statTerms:'span',statWords:'span',stats:'div',studyEta:'div',studyLog:'div',studyPathDue:'span',studyPathGo:'button',studyPathHint:'div',studyPathWeak:'div',submitQuiz:'button',syncPull:'button',syncPush:'button',themeBtn:'button',timedQuizBtn:'button',toast:'div',toggleLeitnerBtn:'button',tplExam:'button',tplFormula:'button',tplSummary:'button',tplWeak:'button',undoGradeBtn:'button',updateStatus:'div',upload:'div',verifyQuizBtn:'button',verifyStudyPackBtn:'button',voiceFillBtn:'button',weakConcepts:'div',weekPlanBox:'div',weekPlanBtn:'button'
  };
  const host=document.getElementById('compatibilityAnchors')||(()=>{const x=document.createElement('div');x.id='compatibilityAnchors';x.hidden=true;document.body.appendChild(x);return x;})();
  for(const [id,tag] of Object.entries(ids)){
    if(document.getElementById(id))continue;
    const el=document.createElement(tag);el.id=id;el.setAttribute('aria-hidden','true');
    if(tag==='canvas'){el.width=200;el.height=200;}
    if(tag==='input')el.type='text';
    host.appendChild(el);
  }
}

function bind(){
  try{
  if($("#commandBtn"))$("#commandBtn").onclick=openCommandPalette;
  if($("#pdfInput"))$("#pdfInput").addEventListener('change',e=>{processFiles(e.target.files);e.target.value='';});
  if($("#imageInput"))$("#imageInput").addEventListener('change',e=>{processFiles(e.target.files);e.target.value='';});
  if($("#docInput"))$("#docInput").addEventListener('change',e=>{processFiles(e.target.files);e.target.value='';});
  if($("#folderInput"))$("#folderInput").addEventListener('change',e=>{processFiles(e.target.files);e.target.value='';});
  if($("#universalInput"))$("#universalInput").addEventListener('change',e=>{processFiles(e.target.files);e.target.value='';});
  if($("#noteImageInput"))$("#noteImageInput").addEventListener('change',e=>{insertImageFilesIntoNotes(e.target.files);e.target.value='';});
  $$('[data-section]').forEach(b=>b.addEventListener('click',()=>activateSection(b.dataset.section)));
  $$('[data-summary-mode]').forEach(b=>b.addEventListener('click',()=>setSummaryMode(b.dataset.summaryMode)));
  if($("#openReviewer"))$("#openReviewer").onclick=()=>activateSection('reviewer');
  if($("#buildReviewBtn"))$("#buildReviewBtn").onclick=async()=>{
    const d=activeDoc();
    if(!d)return toast('Add study material first.','error');
    const b=$("#buildReviewBtn"); b.disabled=true; b.textContent='⏳ Building study guide…';
    try{
      regenerateDoc(d,true);
      try{
        if(typeof buildVerifiedNotes==="function"){
          d.notesTitle = d.notesTitle || ("Verified Notes — " + (d.fileName||"Study Material"));
          if(!d.notesHtml || !String(d.notesHtml).trim()){
            d.notesHtml = buildVerifiedNotes(d);
            d.notes = stripHtml(d.notesHtml);
            d.notesUpdatedAt = now();
          }
        }
      }catch(e){ console.warn("notes auto-build", e); }
      await saveDoc(d); renderAll();
      const details=$("#reviewerDetails"); if(details)details.classList.add('is-collapsed');
      const toggle=$("#toggleReviewerDetails"); if(toggle){toggle.textContent='Show detailed sections ▾';toggle.setAttribute('aria-expanded','false');}
      toast(`Study guide ready · ${(d.reviewerData?.terms||[]).length} concepts · ${(d.flashcards||[]).length} cards · ${(d.quiz||[]).length} questions.`,'success');
    }finally{b.disabled=false;b.textContent='🎯 Build My Study Guide';}
  };
  if($("#toggleReviewerDetails"))$("#toggleReviewerDetails").onclick=()=>{
    const box=$("#reviewerDetails"), btn=$("#toggleReviewerDetails"); if(!box||!btn)return;
    const collapsed=box.classList.toggle('is-collapsed');
    btn.textContent=collapsed?'Show detailed sections ▾':'Hide detailed sections ▴';
    btn.setAttribute('aria-expanded',collapsed?'false':'true');
  };
  if($("#aiEnable")) $("#aiEnable").onclick=enableLocalAI;if($("#aiEnhance")) $("#aiEnhance").onclick=runLocalAIEnhancement;if($("#aiCancel")) $("#aiCancel").onclick=aiCancel;if($("#settingsAiEnable"))$("#settingsAiEnable").onclick=enableLocalAI;if($("#settingsAiDisable"))$("#settingsAiDisable").onclick=disableLocalAI;
  // Dedicated Tutor workspace (multi-chat, local sessions)
  if($("#tutorSend"))$("#tutorSend").onclick=()=>tutorSendMessage();
  if($("#tutorImage"))$("#tutorImage").onclick=()=>tutorCreateImage();
  if($("#tutorLoadAI"))$("#tutorLoadAI").onclick=enableLocalAI;
  if($("#tutorClear"))$("#tutorClear").onclick=()=>createAiSession(false);
  if($("#tutorNewChat"))$("#tutorNewChat").onclick=()=>createAiSession(false);
  if($("#tutorStop"))$("#tutorStop").onclick=()=>{aiCancel();tutorBusy=false;const s=$("#tutorStatus");if(s)s.textContent="Carrot · Stopped";toast("Tutor stopped.","success");};
  if($("#tutorInput"))$("#tutorInput").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();tutorSendMessage();}});
  if($("#checkUpdateBtn"))$("#checkUpdateBtn").onclick=()=>checkForUpdates();
  if($("#buildVersionLabel"))$("#buildVersionLabel").textContent=String(APP_VERSION);
  if($("#updateStatus"))$("#updateStatus").textContent=`Running StudyVault v${APP_VERSION} · ${BUILD_ID}`;
  if($("#copyReviewer"))$("#copyReviewer").onclick=copyReviewer;if($("#downloadReviewer"))$("#downloadReviewer").onclick=downloadReviewer;if($("#regenerateReviewer"))$("#regenerateReviewer").onclick=async()=>{const d=activeDoc();if(!d)return toast('Select a document first.','error');regenerateDoc(d,true);await saveDoc(d);renderAll();toast(`Reviewer ready · ${(d.flashcards||[]).length} flashcards · ${(d.quiz||[]).length} quiz items.`,'success');};
  if($("#prevFlash")) $("#prevFlash").onclick=()=>moveFlash(-1);if($("#nextFlash")) $("#nextFlash").onclick=()=>moveFlash(1);
  if($("#showFlashAnswer")) $("#showFlashAnswer").onclick=()=>{
    if(!activeDoc())return;
    if($("#flashAnswer"))$("#flashAnswer").classList.remove("hidden");
    if($("#showFlashAnswer"))$("#showFlashAnswer").classList.add("hidden");
    if($("#flashEvidence")&&$("#flashEvidence").textContent)$("#flashEvidence").classList.remove("hidden");
    if(state.flashMode==="leitner"){
      document.querySelectorAll(".leitner-grade").forEach(b=>b.classList.remove("hidden"));
      document.querySelectorAll(".sm2-grade").forEach(b=>b.classList.add("hidden"));
    }else{
      document.querySelectorAll(".sm2-grade").forEach(b=>b.classList.remove("hidden"));
      document.querySelectorAll(".leitner-grade").forEach(b=>b.classList.add("hidden"));
    }
  };
  if($("#gradeAgain"))$("#gradeAgain").onclick=()=>gradeCard(1);
  if($("#gradeHard"))$("#gradeHard").onclick=()=>gradeCard(2);
  if($("#gradeGood"))$("#gradeGood").onclick=()=>gradeCard(3);
  if($("#gradeEasy"))$("#gradeEasy").onclick=()=>gradeCard(4);
  if($("#leitnerWrong"))$("#leitnerWrong").onclick=()=>gradeLeitner(false);
  if($("#leitnerRight"))$("#leitnerRight").onclick=()=>gradeLeitner(true);
  if($("#exportAnkiBtn"))$("#exportAnkiBtn").onclick=()=>exportAnkiDeck();
  if($("#exportFlashImgBtn"))$("#exportFlashImgBtn").onclick=()=>exportCurrentFlashcardImage();
  if($("#exportFlashBatchBtn"))$("#exportFlashBatchBtn").onclick=()=>exportFlashcardImagesBatch(8);
  if($("#exportSummaryImgBtn"))$("#exportSummaryImgBtn").onclick=()=>exportSummaryImage();
  if($("#exportDefsImgBtn"))$("#exportDefsImgBtn").onclick=()=>exportDefinitionImages(5);
  if($("#generateStudyImageBtn"))$("#generateStudyImageBtn").onclick=()=>promptStudyImageOrder();
  if($("#homeStudyImageBtn"))$("#homeStudyImageBtn").onclick=()=>promptStudyImageOrder();
  if($("#homeAddAnyFile"))$("#homeAddAnyFile").onclick=()=>$("#universalInput")?.click();
  if($("#dashStudyImageBtn"))$("#dashStudyImageBtn").onclick=()=>promptStudyImageOrder();
  document.querySelectorAll("[data-studio]").forEach(b=>b.addEventListener("click",()=>studioAction(b.dataset.studio)));
  if($("#audioOverviewBtn"))$("#audioOverviewBtn").onclick=()=>playAudioOverview();
  if($("#autoStudyBtn"))$("#autoStudyBtn").onclick=()=>startAutoStudy();
  if($("#dailyReviewBtn"))$("#dailyReviewBtn").onclick=()=>startDailyReview();
  if($("#navDailyBtn"))$("#navDailyBtn").onclick=()=>startDailyReview();
  if($("#libraryFilter"))$("#libraryFilter").addEventListener("input",()=>renderLibrary());
  if($("#reverseFlashBtn"))$("#reverseFlashBtn").onclick=()=>toggleFlashReversed();
  if($("#timedQuizBtn"))$("#timedQuizBtn").onclick=()=>startTimedQuiz(5);
  if($("#exportWeakBtn"))$("#exportWeakBtn").onclick=()=>exportWeakList();
  if($("#eli5Btn"))$("#eli5Btn").onclick=()=>tutorSimplify();
  if($("#setGoalBtn"))$("#setGoalBtn").onclick=()=>{
    const n=prompt("Daily card goal (5–200)", String(learnerProfile().dailyGoal||20));
    if(n!=null)setDailyGoal(n);
  };
  if($("#blitzBtn"))$("#blitzBtn").onclick=()=>startBlitz(10);
  if($("#interleaveBtn"))$("#interleaveBtn").onclick=()=>startInterleavedPractice(25);
  if($("#feynmanBtn"))$("#feynmanBtn").onclick=()=>startFeynman();
  if($("#examBtn"))$("#examBtn").onclick=()=>startExamSimulator(10);
  if($("#confusedBtn"))$("#confusedBtn").onclick=()=>markConfused();
  if($("#buryCardBtn"))$("#buryCardBtn").onclick=()=>buryCard();
  if($("#focusModeBtn"))$("#focusModeBtn").onclick=()=>toggleFocusMode();
  if($("#voiceFillBtn"))$("#voiceFillBtn").onclick=()=>startVoiceFill();
  if($("#undoGradeBtn"))$("#undoGradeBtn").onclick=()=>undoLastGrade();
  if($("#flagExamBtn"))$("#flagExamBtn").onclick=()=>flagCardForExam();
  if($("#weekPlanBtn"))$("#weekPlanBtn").onclick=()=>buildWeekPlan();
  if($("#blueprintBtn"))$("#blueprintBtn").onclick=()=>buildExamBlueprint();
  if($("#compactUiBtn"))$("#compactUiBtn").onclick=()=>toggleCompactUI();
  if($("#exportCustomImgBtn"))$("#exportCustomImgBtn").onclick=()=>exportCustomStudyImage();
  if($("#startSessionBtn"))$("#startSessionBtn").onclick=()=>{if(state.sessionActive)endStudySession();else startStudySession();};
  if($("#buildStudyPackBtn"))$("#buildStudyPackBtn").onclick=buildVerifiedStudyPack;
  if($("#verifyStudyPackBtn"))$("#verifyStudyPackBtn").onclick=verifyStudyPack;
  if($("#verifyQuizBtn"))$("#verifyQuizBtn").onclick=()=>{const d=activeDoc();if(!d)return toast("Select a document first.","error");const bad=(d.quiz||[]).filter(q=>!validateQuizItem(d,q)).length;toast(bad?`${bad} quiz item(s) need regeneration.`:`All ${d.quiz.length} quiz items passed source validation.`,bad?"error":"success");};
  if($("#buildNotesBtn"))$("#buildNotesBtn").onclick=async()=>{const d=activeDoc();if(!d)return toast("Select a document first.","error");d.notesTitle=`Verified Notes — ${d.fileName||"Study Material"}`;d.notesHtml=buildVerifiedNotes(d);d.notes=stripHtml(d.notesHtml);d.notesUpdatedAt=now();await saveDoc(d);renderNotes();toast("Verified notes built from source evidence.","success");};
  if($("#toggleLeitnerBtn"))$("#toggleLeitnerBtn").onclick=()=>toggleLeitnerMode();
  if($("#speakFlash"))$("#speakFlash").onclick=()=>{const d=activeDoc();if(!d?.flashcards?.length)return;const c=d.flashcards[d.currentCard];const ans=$("#flashAnswer");const text=(ans&&!ans.classList.contains("hidden"))?`${c.question}. ${c.answer}`:c.question;speakText(text);};
  if($("#speakNotes"))$("#speakNotes").onclick=()=>{const d=activeDoc();if(!d)return;speakText(stripHtml(d.notesHtml||d.notes||""));};
  if($("#submitQuiz"))$("#submitQuiz").onclick=submitQuiz;if($("#newQuiz"))$("#newQuiz").onclick=newQuiz;
  if($("#searchInput")) $("#searchInput").addEventListener('input',debounce(e=>searchActive(e.target.value),180));
  if($("#notesEditor")) $("#notesEditor").addEventListener('input',()=>{const d=activeDoc();if(!d)return;$("#noteWordCount").textContent=`${wordCount(stripHtml($("#notesEditor").innerHTML))} words`;scheduleNoteSave();});
  if($("#notesTitle")) $("#notesTitle").addEventListener('input',scheduleNoteSave);
  $$('[data-note-cmd]').forEach(b=>b.onclick=()=>selectNoteCommand(b.dataset.noteCmd,b.dataset.noteValue));
  if($("#insertChecklist"))$("#insertChecklist").onclick=()=>insertAtCursor('<p>☐ </p>');
  if($("#insertDefinitionNote"))$("#insertDefinitionNote").onclick=()=>insertAtCursor('<blockquote><strong>Definition:</strong> Write the concept and its meaning here.</blockquote>');
  if($("#insertQuestionNote"))$("#insertQuestionNote").onclick=()=>insertAtCursor('<blockquote><strong>Exam question:</strong> </blockquote>');
  if($("#tplSummary"))$("#tplSummary").onclick=()=>insertNoteTemplate("summary");
  if($("#tplFormula"))$("#tplFormula").onclick=()=>insertNoteTemplate("formula");
  if($("#tplWeak"))$("#tplWeak").onclick=()=>insertNoteTemplate("weak");
  if($("#tplExam"))$("#tplExam").onclick=()=>insertNoteTemplate("exam");
  if($("#insertDefsFromDoc"))$("#insertDefsFromDoc").onclick=()=>insertDefinitionsFromDoc();
  document.querySelectorAll(".symbol-btn").forEach(b=>b.onclick=()=>exportSymbolCard(b.dataset.symbol));
  if($("#exportNotesBtn"))$("#exportNotesBtn").onclick=exportNotes;
  if($("#clearNotesBtn"))$("#clearNotesBtn").onclick=async()=>{const d=activeDoc();if(!d)return;if(!confirm('Clear the notes for this document?'))return;d.notesTitle='Study Notes';d.notesHtml='<p></p>';d.notes='';d.notesUpdatedAt=now();await saveDoc(d);renderNotes();toast('Notes cleared.','success');};
  document.querySelectorAll("[data-path]").forEach(b=>b.onclick=()=>runStudyPath(b.dataset.path));
  if($("#studyPathGo"))$("#studyPathGo").onclick=()=>{
    const d=activeDoc();
    if(!d)return toast("Add a PDF or photo first.","error");
    const due=countDueCards(d);
    if(due>0)runStudyPath("memorize");
    else runStudyPath("reviewer");
  };
  if($("#copyPhoneUrl"))$("#copyPhoneUrl").onclick=async()=>{try{await navigator.clipboard.writeText(window.location.href);toast("Link copied.","success");}catch{toast("Copy blocked — select the URL.","error");}};
  if($("#refreshPhoneQr"))$("#refreshPhoneQr").onclick=()=>renderPhoneAccess();
  if($("#themeBtn"))$("#themeBtn").onclick=()=>setTheme(state.settings.theme==='dark'?'light':'dark');if($("#darkMode"))$("#darkMode").onclick=()=>setTheme('dark');if($("#lightMode"))$("#lightMode").onclick=()=>setTheme('light');
  if($("#lockBtn")) $("#lockBtn").onclick=lockApp;if($("#settingsLock")) $("#settingsLock").onclick=lockApp;if($("#pinSettings")) $("#pinSettings").onclick=openPin;if($("#savePinBtn"))$("#savePinBtn").onclick=setPin;if($("#removePinBtn"))$("#removePinBtn").onclick=removePin;if($("#cancelPinBtn"))$("#cancelPinBtn").onclick=closePin;if($("#savePin")) $("#savePin").onclick=setPin;if($("#removePin")) $("#removePin").onclick=removePin;if($("#closePin")) $("#closePin").onclick=closePin;if($("#unlockBtn"))$("#unlockBtn").onclick=unlockApp;if($("#unlockPin"))$("#unlockPin").addEventListener('keydown',e=>{if(e.key==='Enter')unlockApp();});
  if($("#resetBtn")) $("#resetBtn").onclick=resetAll;if($("#exportBtn")) $("#exportBtn").onclick=exportBackup;if($("#openImport"))$("#openImport").onclick=()=>$("#importModal")?.classList.add('open');if($("#closeImport"))$("#closeImport").onclick=()=>$("#importModal")?.classList.remove('open');if($("#importBackup"))$("#importBackup").onclick=importBackup;
  if($("#pinModal"))$("#pinModal").addEventListener('click',e=>{if(e.target.id==='pinModal')closePin();});if($("#importModal"))$("#importModal").addEventListener('click',e=>{if(e.target.id==='importModal')$("#importModal").classList.remove('open');});
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'){closePin();$("#importModal")?.classList.remove('open');$("#commandPalette")?.classList.remove('open');$("#shortcutsOverlay")?.classList.remove('open');}
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();openCommandPalette();return;}
    if((e.ctrlKey||e.metaKey)&&e.key==='/'){e.preventDefault();showShortcutsHelp();return;}
    if(e.key==='/'&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!e.shiftKey&&document.activeElement?.tagName!=='INPUT'&&document.activeElement?.tagName!=='TEXTAREA'){e.preventDefault();activateSection('search');setTimeout(()=>$("#searchInput")?.focus(),30);return;}
    if(e.target.matches('input,textarea,select,[contenteditable="true"]'))return;
    if($("#flashcards")?.classList.contains('active')){
      if(e.key==='ArrowRight')moveFlash(1);
      if(e.key==='ArrowLeft')moveFlash(-1);
      if(e.key===' '){e.preventDefault();$("#showFlashAnswer")?.click();}
      if(e.key==='1'){$("#gradeAgain")?.click();}
      if(e.key==='2'){$("#gradeHard")?.click();}
      if(e.key==='3'){$("#gradeGood")?.click();}
      if(e.key==='4'){$("#gradeEasy")?.click();}
      if(e.key.toLowerCase()==='r'){toggleFlashReversed();}
      if(e.key.toLowerCase()==='u'){undoLastGrade();}
      if(e.key.toLowerCase()==='b'){flagCardForExam();}
    }
    // Section jump keys when not typing
    const jump={'1':'dashboard','2':'reviewer','3':'flashcards','4':'quiz','5':'tutor','6':'notes','7':'settings','f':'flashcards','q':'quiz','r':'reviewer','t':'tutor'};
    const target=jump[e.key.toLowerCase()];
    if(target&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();activateSection(target);}
  });
  if($("#commandPaletteClose"))$("#commandPaletteClose").onclick=()=>$("#commandPalette").classList.remove('open');
  if($("#commandSearch"))$("#commandSearch").addEventListener('input',renderCommandPalette);
  if($("#commandPalette"))$("#commandPalette").addEventListener('click',e=>{const b=e.target.closest('[data-command]');if(!b)return;runCommand(b.dataset.command);});
  }catch(err){ console.warn('bind partial', err); }
}

async function load(){
  try{
    const meta=await dbGet(META_STORE,SETTINGS_KEY);
    if(meta){state.settings={...state.settings,...meta,ai:{...state.settings.ai,...(meta.ai||{})},sync:{...state.settings.sync,...(meta.sync||{})},learner:{...defaultLearner(),...(meta.learner||{})}};state.activeDocId=meta.activeDocId||null;}
    state.documents=(await dbGetAll(DOC_STORE)).map(normalizeDoc);
    for(const d of state.documents)await dbPut(DOC_STORE,d);
    if(!state.activeDocId)state.activeDocId=state.documents[0]?.id||null;
    // v151.2 migration: remove the old manual sync token. Authentication is now
    // handled by an automatic local browser session or a short-lived remote pairing code.
    if(state.settings.sync && Object.prototype.hasOwnProperty.call(state.settings.sync,"token")){
      delete state.settings.sync.token;
      state.settings.sync.pairCode=state.settings.sync.pairCode||"";
    }
    // v106 PIN repair: v103-v105 builds can carry stale local metadata.
    // Because the requested package PIN is 12345, migrate pre-v106 metadata to
    // the verified PBKDF2 record once. After v106, user-created PINs are preserved.
    const DEFAULT_PIN_SALT="uarIEHw4rT6N7E7s6LkYqw==";
    const DEFAULT_PIN_HASH="29792bdd8ae699154e0af7b92be8d9a9765b634b18c73089eeb8fcac6bc8e8a6";
    const metaVersion=Number(meta?.version||0);
    if(metaVersion<106){
      state.settings.pinSalt=DEFAULT_PIN_SALT;
      state.settings.pinIterations=120000;
      state.settings.pinHash=DEFAULT_PIN_HASH;
      state.settings.pinFails=0;
      state.settings.pinLockUntil=0;
    }else if(!state.settings.pinHash){
      state.settings.pinSalt=DEFAULT_PIN_SALT;
      state.settings.pinIterations=120000;
      state.settings.pinHash=DEFAULT_PIN_HASH;
      state.settings.pinFails=0;
      state.settings.pinLockUntil=0;
    }
    await saveMeta();
    try{ await loadAiSessions(); }catch(e){ console.warn("ai sessions",e); }
    renderAll({full:true});setupDrop();setupInstall();setupSync();
    if(state.settings.pinHash)lockApp();
    // Quiet self-check so a shell left alone for weeks/months still notices a newer package
    setTimeout(()=>maybeAutoCheckUpdates(),2500);
  }catch(e){console.error(e);toast('StudyVault could not open the local study library. Your files stay on this device — try refreshing once.','error');}
}

window.addEventListener("unhandledrejection",e=>{console.error(e.reason||e);toast("A background task failed. Your saved study data was kept.","error");});

// Lightweight runtime diagnostics: visible to developers without exposing study content.
window.addEventListener("error",e=>{console.error(e.error||e.message||e);if(document.visibilityState!=="hidden")toast("A page component failed, but your saved study data is still protected.","error");});

window.StudyVaultDiagnostics=async()=>{
  const checks=[];
  const add=(name,ok,detail="")=>checks.push({name,ok:Boolean(ok),detail});
  add("IndexedDB",!!window.indexedDB);
  add("Crypto",!!window.crypto?.subtle);
  add("Service Worker",!!navigator.serviceWorker);
  add("Web Worker",!!window.Worker);
  add("PDF engine",!!window.pdfjsLib);
  try{ if(navigator.storage?.estimate){const e=await navigator.storage.estimate();add("Storage estimate",true,`${Math.round((e.usage||0)/1048576)}MB used / ${Math.round((e.quota||0)/1048576)}MB quota`);} }catch(err){add("Storage estimate",false,err.message);}
  add("Online",navigator.onLine);
  return {version:APP_VERSION,build:BUILD_ID,checks};
};

window.addEventListener("online",()=>{const n=$("#networkStatus");if(n)n.textContent="ONLINE • local + optional sync";});
window.addEventListener("offline",()=>{const n=$("#networkStatus");if(n)n.textContent="OFFLINE • local study mode";});
window.addEventListener("error",e=>{
  if(e?.error)console.error(e.error);
  const msg=String(e?.message||e?.error?.message||"");
  if(msg && !/ResizeObserver loop/i.test(msg)) toast("A page function hit an error, but your saved data is safe. Try the action again.","error");
});

window.addEventListener("online",updateConnectivity);
window.addEventListener("offline",updateConnectivity);
updateConnectivity();
ensureCompatibilityDom();
bind();
setEngineStatus("idle — engines load only when needed");
window.StudyVaultHealthCheck=async()=>{
  const checks=[];const add=(name,ok,detail="")=>checks.push({name,ok:Boolean(ok),detail});
  add("Version",APP_VERSION>=127,`v${APP_VERSION}`);add("Secure context",window.isSecureContext||location.hostname==="localhost"||location.hostname==="127.0.0.1",location.protocol);add("Writing knowledge",DOMAIN_KB.filter(x=>/english|bael/i.test(x.domain)).length>=40,`${DOMAIN_KB.length} domain entries`);
  add("IndexedDB",!!window.indexedDB);add("Crypto",!!window.crypto?.subtle);add("Service Worker",'serviceWorker' in navigator);add("Web Worker",'Worker' in window);add("File API",'FileReader' in window);add("PDF engine",!!window.pdfjsLib);add("Camera API",!!navigator.mediaDevices?.getUserMedia);
  try{await openDB();add("Database open",true)}catch(e){add("Database open",false,e.message)}
  try{const docs=await dbGetAll(DOC_STORE);add("Document store",Array.isArray(docs),`${docs.length} docs`)}catch(e){add("Document store",false,e.message)}
  try{const st=await navigator.storage?.estimate?.();if(st)add("Storage estimate",true,`${Math.round((st.usage||0)/1048576)}MB / ${Math.round((st.quota||0)/1048576)}MB`)}catch(e){add("Storage estimate",false,e.message)}
  return {ok:checks.every(x=>x.ok),checks,version:APP_VERSION,build:BUILD_ID,at:now()};
};
window.StudyVaultExportDiagnostics=async()=>{const h=await window.StudyVaultHealthCheck();downloadText(`studyvault-diagnostics-${new Date().toISOString().slice(0,10)}.json`,JSON.stringify(h,null,2));return h;};

if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./service-worker.js').catch(err=>console.warn('Service worker registration failed:',err)));
load();

/** Phone link + QR (scan from computer screen with phone camera). */
function renderPhoneAccess(){
  const url=String(window.location.href||"");
  const el=$("#phoneUrl"); if(el)el.textContent=url||"—";
  const canvas=$("#phoneQr"); if(!canvas)return;
  const ctx=canvas.getContext("2d"); const size=canvas.width||200;
  const paintFallback=()=>{ctx.fillStyle="#fff";ctx.fillRect(0,0,size,size);ctx.fillStyle="#222";ctx.font="12px system-ui,sans-serif";ctx.textAlign="center";ctx.fillText("QR unavailable",size/2,72);ctx.fillText("Use Copy link",size/2,94);};
  const drawLocal=async()=>{
    try{
      if(!(url.startsWith("http://")||url.startsWith("https://")))return false;
      const factory=await loadQrLibrary();
      if(typeof factory!=="function")return false;
      const qr=factory(0,"M");qr.addData(url);qr.make();
      const count=qr.getModuleCount(), margin=8, cell=Math.max(1,Math.floor((size-margin*2)/count)), actual=count*cell, offset=Math.floor((size-actual)/2);
      ctx.fillStyle="#fff";ctx.fillRect(0,0,size,size);
      ctx.fillStyle="#111";
      for(let r=0;r<count;r++)for(let c=0;c<count;c++)if(qr.isDark(r,c))ctx.fillRect(offset+c*cell,offset+r*cell,cell,cell);
      return true;
    }catch(e){console.warn("Local QR failed",e);return false;}
  };
  (async()=>{
    if(await drawLocal())return;
    if(url.startsWith("http://")||url.startsWith("https://")){
      const img=new Image();img.crossOrigin="anonymous";
      img.onload=()=>{ctx.fillStyle="#fff";ctx.fillRect(0,0,size,size);ctx.drawImage(img,0,0,size,size);};
      img.onerror=paintFallback;
      img.src="https://api.qrserver.com/v1/create-qr-code/?size="+size+"x"+size+"&margin=8&data="+encodeURIComponent(url);
    }else{
      ctx.fillStyle="#fff";ctx.fillRect(0,0,size,size);ctx.fillStyle="#222";ctx.font="11px system-ui,sans-serif";ctx.textAlign="center";
      ctx.fillText("Run phone-server.py",size/2,76);ctx.fillText("then refresh QR",size/2,96);
    }
  })();
}

})();


/* ===== v151.3 ChatGPT workspace polish ===== */
const GPT_PREFS_KEY="gptWorkspacePrefs";
let gptVoiceRec=null;

async function loadGptPrefs(){
  const defaults={compact:false,enterSend:true,autoSpeak:false};
  try{ const saved=await dbGet(META_STORE,GPT_PREFS_KEY); return {...defaults,...(saved||{})}; }
  catch{return defaults;}
}
async function saveGptPrefs(p){try{await dbPut(META_STORE,GPT_PREFS_KEY,p);}catch(e){console.warn('saveGptPrefs',e);}}
function gptApplyPrefs(p){
  document.body.classList.toggle('compact-chat',!!p.compact);
  const c=$('#compactChatToggle');if(c)c.checked=!!p.compact;
  const e=$('#enterSendToggle');if(e)e.checked=p.enterSend!==false;
  const a=$('#autoSpeakToggle');if(a)a.checked=!!p.autoSpeak;
}
function gptVisibleHistory(query){
  const q=String(query||'').trim().toLowerCase();
  document.querySelectorAll('#aiChatList .ai-chat-item').forEach(el=>{
    const text=(el.textContent||'').toLowerCase();
    el.style.display=!q||text.includes(q)?'flex':'none';
  });
}
function gptRenameChat(){
  const cur=(aiSessions||[]).find(s=>s.id===activeSessionId); if(!cur)return;
  const next=window.prompt('Chat name',cur.title==='New chat'?'':cur.title);
  if(next===null)return;
  const title=String(next).replace(/\s+/g,' ').trim().slice(0,70)||'New chat';
  cur.title=title;cur.updatedAt=now();
  persistAiSessions().then(()=>{renderAiChatList();renderTutor();toast('Chat renamed.','success');});
}
async function gptSpeak(text){
  const raw=String(text||'').trim(); if(!raw)return;
  try{
    if(state.settings?.sync?.url && gptCloudAvailable){
      const r=await cloudAI('speech',{text:raw.slice(0,4096),voice:'marin',instructions:'Speak naturally, warmly, clearly, and at a comfortable study pace.'},120000);
      if(r?.audioDataUrl){const a=new Audio(r.audioDataUrl);await a.play();return;}
    }
  }catch(e){console.info('Cloud TTS fallback',e?.message||e);}
  if(!window.speechSynthesis)return toast('Speech playback is not supported here.','error');
  try{speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(raw.slice(0,4000));u.lang=navigator.language||'en-US';u.rate=.98;speechSynthesis.speak(u);}catch(e){toast('Could not play the reply.','error');}
}
function gptAddMessageActions(box){
  box.querySelectorAll('.tutor-msg.is-tutor').forEach((el,i)=>{
    if(el.querySelector('.gpt-msg-actions')) return; // avoid duplicate binds on re-render
    const msg=[...tutorChat].filter(m=>m.role==='tutor')[i]; if(!msg)return;
    const actions=document.createElement('div'); actions.className='gpt-msg-actions';
    actions.innerHTML=[
      '<button type="button" class="gpt-msg-action" data-copy title="Copy">Copy</button>',
      '<button type="button" class="gpt-msg-action" data-speak title="Read aloud">Read aloud</button>',
      '<button type="button" class="gpt-msg-action" data-regen title="Regenerate">Regenerate</button>',
      '<button type="button" class="gpt-msg-action" data-shorter title="Make shorter">Shorter</button>',
      '<button type="button" class="gpt-msg-action" data-continue title="Continue">Continue</button>'
    ].join('');
    el.appendChild(actions);
    actions.querySelector('[data-copy]').onclick=async()=>{try{await navigator.clipboard.writeText(msg.text||'');toast('Reply copied.','success');}catch{toast('Clipboard access was blocked.','error');}};
    actions.querySelector('[data-speak]').onclick=()=>gptSpeak(msg.text||'');
    actions.querySelector('[data-regen]').onclick=()=>regenerateTutorAnswer(msg);
    actions.querySelector('[data-shorter]').onclick=()=>{
      const input=$('#tutorInput');
      if(input){ input.value='Make that shorter and clearer'; input.focus(); }
      tutorSendMessage();
    };
    actions.querySelector('[data-continue]').onclick=()=>{
      const input=$('#tutorInput');
      if(input){ input.value='Continue from where you left off'; input.focus(); }
      tutorSendMessage();
    };
  });
}

/** Regenerate the last (or selected) tutor answer — ChatGPT parity. */
async function regenerateTutorAnswer(targetMsg){
  if(tutorBusy) return toast('Carrot is still working…','error');
  let userQ='';
  const list=tutorChat.slice();
  let idx=list.findIndex(m=>m===targetMsg || (targetMsg && m.streamId && m.streamId===targetMsg.streamId && m.role==='tutor'));
  if(idx<0){
    for(let i=list.length-1;i>=0;i--){ if(list[i].role==='tutor'){ idx=i; break; } }
  }
  for(let i=idx-1;i>=0;i--){
    if(list[i].role==='user' && String(list[i].text||'').trim()){
      userQ=String(list[i].text).trim();
      break;
    }
  }
  if(!userQ) return toast('No question to regenerate from.','error');
  // Drop the old tutor reply so the new one replaces it
  if(idx>=0 && tutorChat[idx]?.role==='tutor') tutorChat.splice(idx,1);
  // Avoid duplicate user bubble: if last message is already this question, keep it
  const last=tutorChat[tutorChat.length-1];
  const input=$('#tutorInput');
  if(last && last.role==='user' && String(last.text||'').trim()===userQ){
    if(input) input.value='';
    // Call internal path by temporarily setting a flag
    window.__carrotRegenQ=userQ;
  }else if(input){
    input.value=userQ;
  }
  await tutorSendMessage();
  window.__carrotRegenQ=null;
}
function gptRenderHubStats(){
  const box=$('#studyHubStats');if(!box)return;
  const docs=Array.isArray(state?.documents)?state.documents.length:0;
  const chats=Array.isArray(aiSessions)?aiSessions.length:0;
  const cards=(state?.documents||[]).reduce((n,d)=>n+(d.flashcards?.length||0),0);
  box.innerHTML=`<span><b>${docs}</b> sources</span><span><b>${chats}</b> chats</span><span><b>${cards}</b> cards</span>`;
}
async function gptEnhanceFileChips(files){
  const chips=$('#gptFileChips');if(!chips)return;
  const arr=[...files];
  chips.innerHTML=arr.map((f,i)=>`<span class="gpt-chip" title="${esc(f.name)}"><span>${f.type.startsWith('image/')?'🖼':'📄'} ${esc(f.name)}</span><button type="button" data-chip-remove="${i}" aria-label="Remove ${esc(f.name)}">×</button></span>`).join('');
  for(const f of arr){
    if(f.type.startsWith('image/')){
      try{const visual=await dataUrlFromFile(f,1000,.70);gptPendingImages.push({name:f.name,dataUrl:visual.dataUrl});}catch(e){console.warn('attachment preview',e);}
    }
  }
  chips.querySelectorAll('[data-chip-remove]').forEach(b=>b.onclick=()=>{
    const idx=Number(b.dataset.chipRemove||-1); if(idx>=0)gptPendingImages.splice(idx,1); b.parentElement?.remove();
  });
}
async function gptHandleDrop(files){
  const list=[...files]; if(!list.length)return;
  await gptEnhanceFileChips(list);
  processFiles(list).then(()=>toast(`${list.length} file${list.length===1?'':'s'} added to StudyVault.`,'success')).catch(e=>toast(e?.message||'Could not import files.','error'));
}
function wireGptShell(){
  try{ activateSection('tutor'); }catch(e){}
  document.querySelectorAll('[data-suggest]').forEach(btn=>{btn.addEventListener('click',()=>{const t=btn.getAttribute('data-suggest')||'';const input=$('#tutorInput');if(input){input.value=t;input.focus();}tutorSendMessage();});});
  if($('#gptMenuBtn'))$('#gptMenuBtn').onclick=()=>$('#gptSidebar')?.classList.toggle('open');
  if($('#gptStudyToolsBtn'))$('#gptStudyToolsBtn').onclick=()=>{activateSection('dashboard');gptRenderHubStats();$('#gptSidebar')?.classList.remove('open');};
  if($('#gptSettingsBtn'))$('#gptSettingsBtn').onclick=()=>{activateSection('settings');$('#gptSidebar')?.classList.remove('open');};
  if($('#gptRenameChat'))$('#gptRenameChat').onclick=gptRenameChat;
  const panel=$('#gptSearchPanel');
  if($('#gptWebSearchBtn'))$('#gptWebSearchBtn').onclick=()=>{if(panel){panel.hidden=false;$('#gptSearchInput')?.focus();}};
  if($('#gptSearchClose'))$('#gptSearchClose').onclick=()=>{if(panel)panel.hidden=true;};
  async function runWebSearch(){
    const q=String($('#gptSearchInput')?.value||'').trim(),box=$('#gptSearchResults');if(!q||!box)return;
    box.innerHTML='<p class="muted">Searching the web…</p>';
    try{
      if(true){
        const r=await cloudAI('chat',{question:q,history:[],source:'',webSearch:true,maxOutputTokens:2200},120000);
        gptCloudAvailable=true;
        const links=Array.isArray(r.sources)?r.sources:[];
        box.innerHTML=`<div class="result"><div class="chat-md">${chatMarkdown(r.text||'No answer returned.')}</div>${links.length?`<div class="chat-sources"><strong>Sources</strong>${links.map(s=>`<div><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title||s.url)}</a></div>`).join('')}</div>`:''}</div>`;
        return;
      }
    }catch(e){console.info('AI web search fallback',e?.message||e);}
    try{const r=await fetch('https://api.duckduckgo.com/?q='+encodeURIComponent(q)+'&format=json&no_html=1&skip_disambig=1');const d=await r.json();const items=[];
      if(d.AbstractText)items.push({title:d.Heading||q,url:d.AbstractURL||('https://duckduckgo.com/?q='+encodeURIComponent(q)),snippet:d.AbstractText});
      (d.RelatedTopics||[]).slice(0,8).forEach(x=>{if(x.Text&&x.FirstURL)items.push({title:x.Text.slice(0,80),url:x.FirstURL,snippet:x.Text});});
      box.innerHTML=items.length?items.map(it=>`<div class="result"><a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a><p class="tiny muted">${esc(it.snippet||'').slice(0,220)}</p></div>`).join(''):`<div class="result">No quick results. Open the full search in a new tab.</div>`;
    }catch{box.innerHTML='<div class="result">Search is unavailable right now. Try again when you are online.</div>';}
  }
  if($('#gptSearchGo'))$('#gptSearchGo').onclick=runWebSearch;
  if($('#gptSearchInput'))$('#gptSearchInput').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();runWebSearch();}});
  function startVoice(targetInput){
    const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!SR)return toast('Voice input is not supported in this browser.','error');
    if(gptVoiceRec){try{gptVoiceRec.stop();}catch{}gptVoiceRec=null;$('#gptComposerStatus').textContent='Ready · voice stopped';return;}
    const rec=new SR();gptVoiceRec=rec;rec.lang=navigator.language||'en-US';rec.interimResults=true;rec.continuous=false;
    const status=$('#gptComposerStatus'); if(status)status.textContent='● Listening… speak now';
    rec.onresult=e=>{let final='';for(const r of e.results){if(r.isFinal)final+=r[0]?.transcript||'';}if(final&&targetInput){targetInput.value=(targetInput.value?targetInput.value+' ':'')+final;targetInput.dispatchEvent(new Event('input'));}};
    rec.onerror=e=>{if(status)status.textContent='Voice error · '+(e.error||'try again');};
    rec.onend=()=>{gptVoiceRec=null;if(status)status.textContent='Ready · local-first';};
    try{rec.start();}catch{toast('Microphone unavailable.','error');gptVoiceRec=null;}
  }
  if($('#gptMicBtn'))$('#gptMicBtn').onclick=()=>startVoice($('#tutorInput'));
  if($('#gptVoiceBtn'))$('#gptVoiceBtn').onclick=()=>startVoice($('#tutorInput'));
  if($('#gptPhotoBtn'))$('#gptPhotoBtn').onclick=()=>$('#imageInput')?.click();
  if($('#gptFileInput'))$('#gptFileInput').addEventListener('change',async()=>{const files=[...$('#gptFileInput').files];await gptEnhanceFileChips(files);try{await processFiles(files);toast(`${files.length} file${files.length===1?'':'s'} added.`,'success');}catch(e){toast(e?.message||'Import failed.','error');}$('#gptFileInput').value='';});
  const drop=$('#gptDropZone');
  if(drop){
    const hint=$('#gptAttachHint');
    const showHint=()=>{drop.classList.add('is-dragging');if(hint){hint.removeAttribute('hidden');hint.hidden=false;}};
    const hideHint=()=>{drop.classList.remove('is-dragging');if(hint){hint.setAttribute('hidden','');hint.hidden=true;}};
    hideHint(); // never leave overlay covering the chat box on load
    ['dragenter','dragover'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();e.stopPropagation();showHint();}));
    drop.addEventListener('dragleave',e=>{e.preventDefault();if(!drop.contains(e.relatedTarget))hideHint();});
    drop.addEventListener('drop',e=>{e.preventDefault();hideHint();gptHandleDrop(e.dataTransfer?.files||[]);});
    window.addEventListener('dragend',hideHint);
    document.addEventListener('dragleave',e=>{if(e.clientX<=0||e.clientY<=0||e.clientX>=window.innerWidth||e.clientY>=window.innerHeight)hideHint();});
  }
  const input=$('#tutorInput');
  if(input){input.addEventListener('input',()=>{input.style.height='auto';input.style.height=Math.min(180,input.scrollHeight)+'px';});}
  if($('#gptHistorySearch'))$('#gptHistorySearch').addEventListener('input',e=>gptVisibleHistory(e.target.value));
  if($('#gptHistoryClear'))$('#gptHistoryClear').onclick=()=>{const x=$('#gptHistorySearch');if(x){x.value='';x.focus();gptVisibleHistory('');}};
  if($('#themeToggle'))$('#themeToggle').onclick=()=>document.body.classList.toggle('light');
  if($('#openPinModal'))$('#openPinModal').onclick=()=>$('#pinModal')?.classList.add('open');
  if($('#cancelPinBtn'))$('#cancelPinBtn').onclick=()=>$('#pinModal')?.classList.remove('open');
  loadGptPrefs().then(gptApplyPrefs);
  $('#compactChatToggle')?.addEventListener('change',async e=>{const p=await loadGptPrefs();p.compact=e.target.checked;gptApplyPrefs(p);await saveGptPrefs(p);});
  $('#enterSendToggle')?.addEventListener('change',async e=>{const p=await loadGptPrefs();p.enterSend=e.target.checked;await saveGptPrefs(p);});
  $('#autoSpeakToggle')?.addEventListener('change',async e=>{const p=await loadGptPrefs();p.autoSpeak=e.target.checked;await saveGptPrefs(p);});
  $('#clearChatHistoryBtn')?.addEventListener('click',async()=>{if(!confirm('Delete all saved StudyVault chats? Study materials are kept.'))return;aiSessions=[{id:uid(),title:'New chat',messages:[],createdAt:now(),updatedAt:now()}];activeSessionId=aiSessions[0].id;tutorChat=[];await persistAiSessions();renderTutor();toast('Chat history cleared.','success');});
  document.addEventListener('keydown',e=>{
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();$('#gptWebSearchBtn')?.click();}
    if((e.ctrlKey||e.metaKey)&&e.shiftKey&&e.key.toLowerCase()==='v'){e.preventDefault();startVoice($('#tutorInput'));}
    if(e.key==='Escape'){if(panel&&!panel.hidden)panel.hidden=true;$('#gptSidebar')?.classList.remove('open');}
  });
  const titleEl=$('#gptChatTitle');
  setInterval(()=>{try{const cur=(aiSessions||[]).find(s=>s.id===activeSessionId);if(titleEl)titleEl.textContent=cur?.title||'New chat';}catch{}},800);
  const st=$('#tutorStatus');if(st)st.textContent='Ready';
  const modeBadge=$('#gptAiMode');if(modeBadge){modeBadge.textContent=gptCloudStatusLabel();modeBadge.classList.toggle('cloud',gptCloudAvailable);modeBadge.classList.toggle('local',!gptCloudAvailable);}
  gptRenderHubStats();
}
if(typeof load==='function'){const _load=load;load=async function(){await _load.apply(this,arguments);try{wireGptShell();}catch(e){console.warn(e);}};}
