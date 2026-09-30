# Carrot AI v154.0 — Foundation Rebuild

The previous build mixed a new ChatGPT-style shell with older StudyVault controls. A missing legacy DOM element could abort the rest of `bind()`, making unrelated study controls stop working. v154.0 adds safe compatibility anchors and repairs the current UI controls directly.

Key repairs:
- universal Add any file input is now actually bound;
- study-file input accepts common text/Word/image formats;
- bundled JSZip gives DOCX a CSP-safe local reader;
- PDF.js and Tesseract browser assets are bundled;
- server OCR/PDF/DOC fallbacks are available;
- Carrot AI image/chat/vision/text routes use per-capability rate buckets;
- image errors expose upstream details instead of only saying "generation failed";
- server loads `.env` relative to `server.py`, not the caller's working directory;
- version/build headers are synchronized to v154.0;
- stale v152.1 startup label was removed.
