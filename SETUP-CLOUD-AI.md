# StudyVault AI Image Generation

The frontend remains GitHub Pages compatible and does not contain an API key.

## 1. Run the protected server

No StudyVault sync token is required. The server creates an automatic browser session for local access. For remote access, it prints a short-lived pairing code when it starts. Set only the OpenAI API key if you want Cloud AI:

```bash
export OPENAI_API_KEY="your-api-key"
python3 server.py
```

The server listens on `127.0.0.1:8787` by default.

## 2. Connect StudyVault

Open **Settings → Cloud AI / Sync** and enter the server URL. Local browsers pair automatically. A remote browser can enter the short pairing code shown in the server console.

## 3. Generate images from chat

In **Study AI**, type things like:

- `Create an image of a futuristic Cebu city at sunset, cinematic and realistic`
- `Draw a clean labeled diagram of the OSI model for a student reviewer`
- `Make a dark purple gaming poster with a cyberpunk robot and the title STUDYVAULT`

Press **Create image**, or simply send the request if it is recognized as an image request.

Generated images appear inside the chat and can be saved or regenerated.

## GitHub Pages

GitHub Pages can host the static frontend, but it cannot safely hold the OpenAI API key. Use a separate HTTPS server for `/api/ai/image` and `/api/ai/text`, then enter that server URL in StudyVault.


## v151.6 AI Suite
When `OPENAI_API_KEY` is set on the server, StudyVault enables ChatGPT-style general chat, multimodal image understanding, Responses API web search, GPT Image generation, cloud transcription, and natural TTS. The key remains server-side. Without the key, local-first AI and study tools remain available.
