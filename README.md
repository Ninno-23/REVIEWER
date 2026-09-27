# StudyVault v25 — Final phone-ready family build

Local-first study app for PDFs and photos. Data stays in the browser (IndexedDB).

## Highlights
- **Responsive Tutor** — Instant answers first (feels fast on phones); optional on-device AI can deepen later
- **Adaptive flashcards** — about 24 on a short handout, up to **200** on a dense multi-page PDF
- **Images** — OCR read + **Create study pic**; PDF pages with pictures captured as media
- **Symbols** — math, chemistry, electrical (Ω, μF, V=IR), digital logic gates in curriculum
- **Saving** — retries if the phone put the tab to sleep; warns if storage is full
- **Touch** — larger buttons, sticky tutor compose, no iOS input zoom

## Quick start
1. Unzip and open `index.html` (or host on GitHub Pages / HTTPS).
2. Hard-refresh once after install.
3. Add PDF or photos. Wait for OCR on picture pages if needed.
4. Reviewer · Tutor · Flashcards · Quiz · Notes.

## Flashcard scaling
Budget grows with pages, terms, definitions, units, and photos, clamped **24–200**.
Regenerate after adding material to rebuild the deck size.

## Optional AI model
Settings or Tutor → Load AI (Qwen3 0.6B). Instant Tutor works without it.

## Optional sync
```bash
STUDYVAULT_SYNC_TOKEN="$(openssl rand -hex 32)" python3 server.py
```
