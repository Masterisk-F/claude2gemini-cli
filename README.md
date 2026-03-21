# Claude2Gemini-CLI Proxy

## What is this?

Claude2Gemini-CLI is a proxy server that makes [Google Gemini CLI SDK](https://github.com/google-gemini/gemini-cli) accessible through the [Anthropic Claude Messages API](https://docs.anthropic.com/en/api/messages). It translates Claude API requests into Gemini SDK calls in real-time, allowing any Claude-compatible client — such as [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Cursor](https://cursor.sh/), or [Cline](https://github.com/cline/cline) — to use Gemini models as a drop-in backend.

```
┌──────────────┐     Claude API     ┌──────────────────┐     Gemini SDK     ┌──────────────┐
│  Claude Code  │ ──────────────── │  Claude2Gemini   │ ──────────────── │  Gemini API  │
│  Cursor, etc. │   POST /v1/msgs   │  Proxy (Express) │   sendStream()   │  (Google AI) │
└──────────────┘                   └──────────────────┘                   └──────────────┘
```

## Features

- **Full Claude Messages API compatibility** — `POST /v1/messages` with both streaming (SSE) and non-streaming responses
- **Tool use support** — Claude `tool_use` / `tool_result` round-trips are transparently bridged to Gemini's agent tool execution loop, including MCP (Model Context Protocol) tools
- **Multi-turn conversations** — Conversation history is preserved across turns
- **System prompts** — Claude `system` parameter maps to Gemini `instructions`
- **Model name mapping** — Claude model names (e.g., `claude-sonnet-4-20250514`) are automatically mapped to appropriate Gemini models
- **Stateful session management** — Tool execution sessions are kept alive across HTTP requests using an in-memory store
- **SSE error reporting** — Errors during streaming are delivered as SSE `event: error` instead of silently dropping

## Will my Gemini subscription be suspended?

This project uses the **Gemini CLI SDK**, which in turn uses the standard Gemini API under the hood.

> [!WARNING]
> **Use at your own risk.** This proxy essentially automates API calls to Google's Gemini service. While the Gemini CLI SDK itself is an official Google project, using it as a backend for third-party Claude-compatible clients is **not an officially supported use case**. Google may change their terms of service, rate limits, or API access policies at any time.

**Recommendations:**
- Monitor your API usage and billing dashboard regularly
- Be mindful of rate limits — high-frequency tool use loops can generate many API calls
- Consider using `gemini-2.5-flash` (via model mapping) for lighter workloads to reduce costs

## Installation & Setup

### Prerequisites

- **Node.js** >= 20
- **npm**
- A **Google account** with access to Gemini

### Clone & Install

```bash
git clone --recursive https://github.com/Masterisk-F/claude2gemini-cli.git
cd claude2gemini-cli
npm install
```

> [!NOTE]  
> The `--recursive` flag is required to clone the `gemini-cli` submodule.

If you already cloned without `--recursive`:
```bash
git submodule update --init --recursive
```

### Build the Gemini CLI SDK (required once)

```bash
cd gemini-cli
npm install
npm run build
cd ..
```

### Authenticate with Google (required before first run)

This proxy uses **Gemini CLI's authentication** internally. You must log in with your Google account via Gemini CLI before starting the proxy:

```bash
cd gemini-cli
npx gemini  # Follow the browser-based login prompt
```

Once authenticated, the credentials are cached locally and reused by the proxy automatically. You only need to do this once (unless your session expires).

### Run the Proxy

```bash
# Development mode (with hot reload)
npm run dev

# Or with a custom port
PORT=3000 npm run dev
```

The server starts on `http://localhost:8080` by default.

### Configure your Claude client

Point your Claude-compatible client to the proxy:

| Setting | Value |
|---------|-------|
| API Base URL | `http://localhost:8080` |
| API Key | Any non-empty string (the proxy does not validate it) |
| Model | Any string (e.g., `claude-sonnet-4-20250514` — it will be auto-mapped) |

### Health Check

```bash
curl http://localhost:8080/health
# → {"status":"ok"}
```

## License

This project is provided as-is for educational and experimental purposes.
