# StudyVault v13 — Reliability Repair

This build keeps the local-first reviewer usable even when the optional neural AI cannot load.

## What changed
- Instant source-grounded Smart Tutor fallback for questions and AI review.
- Reduced Qwen generation workload to reduce phone lag.
- Reviewer engine version bumped so older generated reviewers regenerate safely.
- Service-worker cache bumped to v13.
- Mobile CSS from the v12 repair retained.
- JavaScript syntax checked with Node for app, worker, and service worker.

## Important limitation
The optional Qwen model still requires a browser-compatible model download on first use. It is deliberately not required for the core reviewer/tutor workflow.
PDF.js and Tesseract.js also retain remote first-use dependencies unless their libraries are bundled locally.
