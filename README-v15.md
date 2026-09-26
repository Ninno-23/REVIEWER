# StudyVault v15 — Android AI Optimization

## What changed
- Android-aware AI runtime selection.
- Uses a Web Worker so model loading/inference does not block the main UI.
- Prefers WebGPU on capable Android devices, with a safer CPU/WASM path for conservative/low-memory profiles.
- Adds a second compatible GPU format attempt before falling back to WASM.
- Android generation defaults to fewer output tokens to reduce heat, RAM pressure, and battery use.
- Android AI source context is capped more aggressively for faster inference.
- Mobile AI controls use larger touch targets and a compact layout.
- Instant source-grounded Tutor remains available even when neural AI cannot load.
- Service-worker cache bumped to v15.
- Optional sync backend now includes CORS headers on normal API responses, so a separately hosted frontend can call it.

## Important
The Qwen model still needs to download on its first neural-AI use. After the browser caches the model, later use can be faster and may work without the network depending on browser cache behavior. The core StudyVault reviewer does not require Qwen.

## Mobile behavior
StudyVault does not automatically force-load Qwen on Android. The user can choose **Load AI**. This avoids unexpectedly consuming mobile data, storage, battery, or memory.

## Verification
- `node --check app.js` passed.
- `node --check ai-worker.js` passed.
- `python3 -m py_compile server.py` passed.
- ZIP integrity check passed.
- Real Android hardware/WebGPU testing was not available in this environment, so Android compatibility is implemented defensively rather than claimed as device-certified.
