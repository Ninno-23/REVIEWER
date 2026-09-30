# StudyVault v151.8 — security notes (family plain language)

## What stays on this device
- Chat history, PDFs, photos, notes, PIN hash
- Unlock lockout after wrong tries (backs off automatically)

## PIN
- Stored as PBKDF2-SHA256 + random salt (not the PIN itself)
- New PINs: 210,000 iterations
- Starter PIN `12345` is only for first open — change it; the app will not let you save `12345` as the permanent PIN again
- Constant-time compare to reduce timing leaks

## Server (optional Cloud AI)
- `OPENAI_API_KEY` lives only in the server environment — never shipped to the browser
- Local sessions + short pairing codes for remote access (no shared long-lived token required)
- Security headers: nosniff, DENY framing, no-referrer, tight permissions-policy
- CORS defaults to localhost unless you explicitly set `STUDYVAULT_CORS_ORIGINS`

## Offline forever
- Service worker caches the shell first
- When you later drop in a newer zip and hard-refresh, the new cache name takes over without drama

## Honest limits
- A PIN is privacy on a shared computer, not military encryption of the whole disk
- If someone has full access to the unlocked browser profile, they can read local data — same as any local-first app
