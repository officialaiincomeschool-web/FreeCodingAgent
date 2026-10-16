# Build with AI — local single-page chatbot

A dark navy, amber and teal chat interface powered by any OpenAI-compatible API. Connect your provider right in the page (base URL + API key) or set it in `.env`. Model selection, streaming replies, visible reasoning, image (vision) input, built-in tools, token/cost metering and multi-conversation history. No third-party packages or build step: the browser talks to a small local Node server, and only that server talks to your provider.

## Run in VS Code (Windows)

1. Install Node.js 22 or newer from https://nodejs.org/ if needed. Restart VS Code after installation. Check `node --version` in its terminal.
2. Extract this ZIP. In VS Code choose **File → Open Folder** and open `river-chat`, the folder containing `package.json`.
3. Open **Terminal → New Terminal** and start the app:

   ```powershell
   npm start
   ```

   No `npm install` is needed: the app uses only Node's built-in libraries. If Windows blocks `npm.ps1`, use `npm.cmd start` or `node server.mjs`.

4. Open **http://127.0.0.1:3000** in your browser. In **Model & settings** enter your provider's **base URL** (it usually ends in `/v1`) and **API key**, then click **⚡ Connect & load models**. Pick a model from the dropdown and chat — the key is saved only in your browser.

   Prefer file-based configuration (or a machine you can't type into)? Copy `.env.example` to `.env`, fill in `BASE_URL`, `API_KEY` and optional `MODELS`, restart the server, and the page connects automatically. Existing terminal environment variables take precedence over `.env`, and `.env` is ignored by Git.

   Enter sends; Shift+Enter adds a new line; the server must be restarted after code changes.

Keep the terminal running. Ctrl+C stops the server. Do not use VS Code Live Server, and do not open `index.html` directly: the backend is required. On macOS/Linux, `Copy-Item .env.example .env` becomes `cp .env.example .env`.

## What the app can do

| Feature | How it works |
| --- | --- |
| Multi-conversation history | Conversations are saved in your browser's localStorage. Switch, rename (double-click) or delete (✕) chats in the sidebar. Nothing is written to disk by the server. |
| Provider from the page | Under **Model & settings**, enter any OpenAI-compatible base URL + API key and click **⚡ Connect & load models**. The app verifies the key, loads the provider's model list, and remembers it in this browser. `.env` stays as fallback. |
| Vision | Attach up to 4 PNG/JPEG images per message with the **🖼 Images** button, paste, or drag-and-drop. Images are downscaled in your browser to 1600 px JPEG before sending. |
| Reasoning | Reasoning models stream their thinking into a collapsible **Thinking** panel. Set **Reasoning effort** per model (`DeepSeek`: none/high/max; `GLM`: low/high/max). |
| Tools | With **Allow tools** on, the model can call a safe calculator, current time, and Wikipedia lookup. Each call is shown inline with its result; the loop stops after 5 rounds. |
| Token & cost meter | Every reply shows input/output/reasoning/cached tokens and an estimated cost using River's published per-model prices. |
| Sampling controls | Temperature (0–2), top P (0–1), stop sequences (up to 4) and a System prompt in **Model & settings**. |
| Model switching | Switching models keeps the conversation; use **＋ New conversation** for an independent comparison. The selected model, token limit and tool state are shown under the chat box. **↻ Refresh available models** queries your provider. |
| Save code to a folder | In Chrome/Edge, choose a folder once; the **💾 Save** button under each code block writes that file straight into the folder (subfolders like `src/app.js` supported; overwriting asks first). |

## First tests

1. Chat: send `My name is AIBrain. Reply with a short greeting.` then `What name did I tell you?` — the second request includes the earlier exchange.
2. Vision: attach a photo/screenshot and ask what's in it.
3. Tools: ask `Use your calculator tool to compute 18% of 2,450.`
4. Reasoning: pick `deepseek-ai/DeepSeek-V4.1-Flash`, set Reasoning effort to `high`, and ask a small puzzle.

## API and limits

The server uses any OpenAI-compatible endpoint (`POST /chat/completions` — set from the page or via `BASE_URL`; defaults to River's `https://api.river.ai/v1`) and re-streams normalized events to the page: text, reasoning, tool calls, usage and completion status.

- Requests: max 24 MiB body (images count), up to 4 images per message, each ≤ ~4.5 MB after base64, 100 messages per request, 3–10 minutes upstream timeout, no automatic retries.
- Tool loop: the server executes tool calls (calculator/time/Wikipedia) and continues the conversation, at most 5 rounds per request.
- Output limit: default 4,096 tokens including reasoning. Increase it if an answer is cut short; the reply shows when it was.
- Privacy: conversation history lives in your browser's localStorage, and a provider key entered in the page is stored there too (plus in the server's memory while it runs — never on disk, never in Git). The server exposes only four public files and never `.env`.

## Changing the AI provider

Everything speaks the standard OpenAI chat-completions format, so OpenAI, Groq, OpenRouter, Together, Ollama, LM Studio, apinex and similar services all work. There are two ways to configure one:

**1. In the page (recommended).** **Model & settings → Provider base URL + Provider API key → ⚡ Connect & load models.** The app verifies the key against the provider, loads its model list, and remembers the choice in this browser. To go back to the `.env` values, clear both fields and connect again. A key entered in the page is only ever sent to the base URL you typed next to it.

**2. In `.env`:**

```dotenv
BASE_URL=https://api.openai.com/v1
API_KEY=sk-your-key
MODELS=gpt-5.2,o4-mini
```

- `MODELS` is optional: it seeds the dropdown; otherwise the app auto-loads the provider's model list at start (or click **↻ Refresh available models**).
- A trailing slash in `BASE_URL` is fine. Key precedence: with `BASE_URL` set, `API_KEY` is used (falling back to `RIVER_API_KEY`); otherwise `RIVER_API_KEY` is used (falling back to `API_KEY`) — so your River key is never sent to another provider.

Notes that apply to both:

- Chat, streaming, vision and tool calling all use the standard format. If the provider rejects `stream_options`, the server retries once without it.
- River-specific extras (cosmetic or inert elsewhere): the cost meter only shows costs for River model IDs, reasoning-effort presets only appear for models whose name contains `deepseek` or `glm`, and the console link in the sidebar can be edited in `public/index.html`.

## Save code to a folder (optional)

When a reply contains code, each code block gets a **💾 Save** button. Click it once, choose any folder on your computer, and the file is written straight into it. Subfolders are supported (`src/utils.js` creates the `src` folder), and if the model names the file in the fence (a fence starting with `js app.js`, or `title=app.js`) the button shows that name — otherwise you are asked for one. Overwriting an existing file always asks first.

- Requires **Chrome, Edge or Opera on desktop** (the browser's File System Access API). In Firefox/Safari the folder section simply doesn't appear.
- Your folder choice is remembered across restarts (stored in IndexedDB). After restarting the browser, one click on **📁 Re-allow** re-opens it.
- Files are written only when you click save — the app never scans, reads or uploads your folder, and files stay on your machine.

## Fine-tuning (optional, experimental)

River is also a training platform (SFT / RL / distillation) via the Python `river-client`. The `finetune/` folder has ready scripts (see `finetune/README.md`). Note: this requires Python 3.12 or newer and training may be billed separately — check **Console → Billing → Pricing**.

## Verification

`npm test` runs local integration tests against a mock upstream; they do not spend API credits. They cover forwarding, validation (roles, images, sampling params, size limits), the tool loop and its round limit, usage/reasoning passthrough, stream errors, connecting a provider from the page (including bad input and clearing it again), and blocked private/cross-origin access. A live smoke test (tools + vision) was run manually with a real key.

## Files

- `server.mjs`: local server, provider proxy (UI- or `.env`-configured), image validation, built-in tools (calculator, time, Wikipedia), normalized streaming
- `public/index.html`: single-page interface
- `public/style.css`: responsive styling
- `public/app.js`: chat UI, streaming, settings, provider connection, image handling, localStorage conversations
- `public/icon.svg`: app logo (vector)
- `test.mjs`: mock integration tests (`npm test`)
- `finetune/`: optional Python scripts for River training (see its README)
- `.env.example`: optional file-based provider configuration template

Official references: https://docs.river.ai/guides/inference/ · https://docs.river.ai/guides/inference-tools/ · https://docs.river.ai/guides/inference-images/ · https://docs.river.ai/guides/inference-controls/
