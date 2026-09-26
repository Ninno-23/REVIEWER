# StudyVault v14 — Foundation Build

This release focuses on reliability and a long-term architecture without making the app dependent on a backend or neural model.

## Core
- IndexedDB remains the offline source of truth.
- Existing StudyVault v13 data is migrated in place.
- Instant source-grounded tutor answers before optional neural AI.
- Optional Qwen runs only when explicitly enabled/loaded.
- PDF.js/Tesseract still use the pinned remote resources because this build environment could not download vendor bundles; the app reports that limitation instead of pretending they are bundled.
- Notes autosave is less aggressive to reduce IndexedDB transaction pressure.
- Optional Python standard-library sync server included as `server.py`.

## Optional backend
```
STUDYVAULT_SYNC_TOKEN=replace-with-a-long-random-token python3 server.py
```
Then configure the Sync URL in Settings. Do not expose the server publicly without HTTPS/authentication infrastructure.

## Verification
- Node syntax checks for app.js, ai-worker.js, service-worker.js.
- Python compile check for server.py.
- ZIP integrity check.
- Chromium headless smoke test was attempted but the installed Chromium process did not complete in this environment, so no claim of full browser/device coverage is made.
