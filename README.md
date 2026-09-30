# StudyVault / Carrot AI v154.0

This build is a foundation rebuild of the Carrot chat + StudyVault study workspace.

## Start

1. Copy `.env.example` to `.env`.
2. Put your OpenAI API key in `OPENAI_API_KEY` if you want cloud chat, vision, web search, image generation/editing, transcription, and speech.
3. Run `START-CARROT-AI.bat` on Windows, or run `python server.py` and a static web server from this folder.
4. Open the StudyVault page.

The API key stays on the server and is never placed in browser JavaScript.

## File import

Supported browser-first imports include PDF, DOCX, legacy DOC (server fallback), TXT, Markdown, CSV, JSON, HTML, RTF, PNG/JPEG/WebP/BMP/GIF/SVG, and folders.

PDF.js, Tesseract, and JSZip are bundled locally. DOCX extraction no longer depends on a CDN. The local Carrot server also provides OCR and legacy Word/PDF extraction fallbacks.

## AI

Cloud AI routes through the local Carrot server. The default text model is `gpt-5.6-sol` and the default image model is `gpt-image-2`.

Image requests use the real image-generation API path when cloud AI is configured. Editing and variations send the previous image back to the image pipeline rather than drawing a fake canvas result.

Without a cloud API key, the app remains usable in local/offline mode and clearly labels fallback behavior.
