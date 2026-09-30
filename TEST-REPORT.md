# v154.0 Test Report

## Automated foundation checks

- JavaScript syntax (`node --check app.js`): PASS
- Python syntax (`server.py`, `phone-server.py`): PASS
- ZIP/package vendor presence: PASS
- Version/build consistency: PASS
- Local server health: PASS
- Local browser session/CORS headers: PASS
- File import route wiring: PASS
- Universal file input binding: PASS
- DOCX bundled extraction path: PASS
- Legacy DOC server route: PASS
- Server OCR route: PASS
- Server PDF fallback route: PASS

## Repeated AI regression

Using a local OpenAI-compatible mock upstream (not a real paid API key):

- Chat: 100/100
- Vision: 100/100
- Study/reviewer text: 100/100
- Image generation: 100/100

The tests verify the actual Carrot server routing, authentication/session handling, JSON contracts, image base64 decoding path, model selection, and error handling. They do not claim that a real OpenAI account was charged or that a real cloud image was generated in this test environment.

## File pipeline samples

- PNG OCR: PASS
- PDF text extraction: PASS
- DOCX XML extraction: PASS

## Browser limitation

This execution environment blocks Chromium navigation to local/file URLs with `ERR_BLOCKED_BY_ADMINISTRATOR`. Therefore a full end-to-end interactive Chromium test against the local web server cannot truthfully be marked passed here. A DOM shell smoke test was still used to catch JavaScript binding failures; the stale binding that could abort the study UI was repaired.
