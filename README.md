# StudyVault v8

Local-first adaptive study workspace for PDFs, screenshots, and class photos.

## Major upgrades
- One unified reviewer engine inside `app.js` (no duplicate reviewer engine).
- Four evidence-preserving summary modes: Quick Scan, Standard, Deep Review, Exam Cram.
- Structure detection for definitions, processes, cause/effect, comparisons, examples, facts/formulas, headings, and page evidence.
- Source-confidence indicator and concept connections.
- Up to 60 varied flashcards with adaptive due dates and mastery tracking.
- Up to 24 varied multiple-choice questions plus quiz history.
- Scanned-PDF OCR fallback when the PDF has little selectable text.
- PDF + photo OCR + visual study material.
- IndexedDB connection reuse and serialized writes.
- Constant-time PIN verification comparison.
- Stricter notes HTML sanitization.
- Rich local notes with per-document storage.
- PWA shell with offline app assets.

## Important limitation
This build does not use a generative LLM or paid API. Summaries are intentionally source-faithful and locally generated, so the app can run without a server. PDF.js and Tesseract.js are loaded on demand from CDNs unless those assets are packaged locally.

Upload the contents of this folder to the root of a GitHub Pages repository.


## v9 local adaptive AI

StudyVault v9 adds an optional on-device language model using Transformers.js and `onnx-community/Qwen2.5-0.5B-Instruct`. Models run in the browser with WebGPU when available or WASM fallback; Transformers.js can cache model files in the browser for later runs. The app also stores a local learner profile (mastery, attempts, streaks, recent accuracy) and uses it to prioritize weak concepts and personalize prompts. This is adaptive learning, not model-weight retraining.

The first local-AI use normally requires internet access to download the runtime/model. The deterministic reviewer remains available when the model is unavailable.
