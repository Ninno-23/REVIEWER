# StudyVault v29 — Evidence Brain (Strict Summary)

## What this build does
- Flashcards and quizzes are built only from source evidence and validated before display.
- Tutor keeps conversation context and treats your uploaded material as the authority.
- Neural AI answers are accepted only when they pass a high grounding threshold; otherwise the deterministic source tutor is used.

## Strict Summary (this update)
The overview is now **source-only**:
- Only high-confidence, non-question sentences from your material are used.
- Definitions and glossary pairs are preferred (most accurate for study).
- Question-like lines and weak OCR fragments are rejected.
- If the material is too thin or mostly images, the app says so clearly instead of inventing a summary.
- Header always states: “Taken only from your uploaded material — nothing invented”.

## Verification
- `node --check app.js`
- `node --check ai-worker.js`
- `python3 -m py_compile server.py`

Your study data stays in the browser (IndexedDB). Hard-refresh once after updating the files.
