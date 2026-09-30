# StudyVault 151.6 — AI Capability Policy

StudyVault now separates **flagship cloud AI** from the **offline Study Engine**.

## Flagship mode
- Default general model: `gpt-5.6-sol` (server-side).
- Multimodal chat: text + images.
- Web search when enabled.
- Cloud image generation.
- Cloud transcription and speech.
- Source-grounded reviewer/summary generation.

The browser cannot silently select a weaker model in flagship mode. A server administrator must explicitly set `STUDYVAULT_ALLOW_CLIENT_MODEL_OVERRIDE=1` to permit client model selection.

## Offline mode
The browser worker remains available for source-grounded study tasks when cloud AI is unavailable. It is intentionally described as an **Offline Study Engine**, not as a full ChatGPT replacement. It must not claim to have web search, cloud image generation, cloud voice, or flagship reasoning when those services are unavailable.

## Honest capability behavior
- If cloud AI is unavailable, StudyVault says so.
- If an API call fails, StudyVault reports the failure rather than fabricating a result.
- Local image cards are labeled local.
- Cloud-generated images are labeled with the actual cloud model.
- The health/capabilities endpoint reports the active tier and models.
