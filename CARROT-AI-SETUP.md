# Carrot AI v153.1

Carrot is a ChatGPT-style StudyVault workspace with a local-first fallback and an optional server-side cloud AI layer.

## Full AI mode

1. Put your OpenAI API key in the server environment as OPENAI_API_KEY (or copy .env.example to .env and fill it in).
2. Run START-CARROT-AI.bat on Windows, or run python server.py.
3. Open the StudyVault page. Carrot automatically probes http://127.0.0.1:8787.
4. The top badge should change from local mode to Carrot AI / multimodal.

The API key is used by server.py; it is never placed in the browser code.

## Image generation

- create a photorealistic cow in a green field at sunrise
- make an educational diagram of the OSI model
- Attach an image → Edit image / Variation / Regenerate

Variation prompts for style (anime, photo, poster, new lighting, etc.).

## Summarization

- Open a PDF → summarize or exam cram summary
- After any long answer → summarize that

## Study pack (flashcards + quiz)

After a summary or with a PDF open:
- turn this into flashcards
- make a quiz from this
- study pack from this

## Compare documents

With 2+ materials imported:
- compare documents
- side by side compare

## Streaming

Cloud replies type into the bubble progressively. Local neural streaming still works when enabled.

## Offline mode

Without a cloud key/server, Carrot still keeps local chat, document tools, local study images, and browser voice. Results are labeled local/fallback.
