# StudyVault v4

StudyVault v4 is a browser-first PDF study workspace. It processes selectable PDF text in the browser and stores the resulting study data in IndexedDB.

## Main upgrades
- Fuller reviewer with overview, study strategy, definitions, key points, study questions, and page highlights
- Up to 40 generated flashcards using definition, cloze, explanation, and main-idea patterns
- Up to 20 local quiz questions with page references and history
- Page-aware search with highlighted snippets
- Better PDF text reconstruction using page line positions
- Multiple PDF documents with separate notes/progress
- Rich study notes with title, formatting, bullets, checklist blocks, definition blocks, exam-question blocks, word count, autosave, and export
- Stable flashcard IDs so progress is not tied to array positions
- PBKDF2 + random salt local PIN
- JSON backup/import
- PWA shell and service worker for the app shell
- No AI, backend, account, or paid API required

## Important limitation
PDF.js is loaded from the free cdnjs CDN when PDF processing is needed. Study data stays local in your browser, but PDF processing still needs the PDF.js resource to be reachable. This build does **not** claim that PDF.js is fully offline.

Image-only/scanned PDFs are not OCR'd. They need selectable text or a separate OCR solution.

## GitHub Pages
Upload the files as a project folder and enable GitHub Pages. Keep `index.html`, `app.js`, `manifest.json`, `service-worker.js`, and `icon.svg` together.
