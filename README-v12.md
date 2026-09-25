# StudyVault v11

StudyVault v11 is a local-first study workspace for PDFs and study photos. It keeps processed material, notes, reviewer data, quiz history, and the learner profile in IndexedDB.

## Core modes

- Automatic source-grounded reviewer with Quick, Standard, Deep, and Exam Cram modes.
- Definitions, key points, process patterns, cause/effect, comparisons, examples, facts/formulas, memory cues, questions, concept links, and page evidence.
- Adaptive flashcards with per-card statistics and spaced review.
- Practice quiz and history.
- Photo attachments + optional browser OCR.
- Rich notes canvas with images, checklists, definitions, and exam-question blocks.
- Export / import backups.
- Optional on-device AI in a Web Worker using Transformers.js + Qwen3 0.6B ONNX.
- PWA shell with offline app access after the shell and required resources have been cached.

## AI behavior

The local AI is optional. It is not required for ordinary reviewer/flashcard/quiz functionality. On first use, the model may download hundreds of megabytes. Later use can reuse browser-cached model files. The app also provides a deterministic reviewer when the AI model is unavailable.

## Important offline behavior

The app shell is designed for offline use. PDF.js and OCR libraries are loaded from pinned public CDNs and are runtime-cacheable by the service worker; if a required resource has never been cached and the device is offline, that specific operation can be unavailable while the rest of the app continues to work.

## Long-term maintenance

The application uses versioned IndexedDB data, explicit engine versions, fallbacks, and a dedicated worker for AI inference. No browser application can be guaranteed to work forever because browsers, operating systems, hosted model repositories, and web standards can change.
