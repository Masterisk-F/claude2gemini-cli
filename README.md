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

This proxy uses the **Gemini CLI SDK**, which is included in the `gemini-cli` package itself and accesses Google's servers in the standard `gemini-cli` way.

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

### Authenticate with Gemini (Multi-Account Support)

This proxy supports **multiple Gemini accounts** and distributes requests using a round-robin strategy. You can manage multiple authentication credentials via an interactive CLI tool.

#### 1. Prepare your credentials
Before adding an account to the proxy, you need an authorized `oauth_creds.json` file. You can generate one on any machine (including your host) by running:

```bash
cd gemini-cli
npx gemini auth login
# Follow the browser-based login prompt.
# This creates ~/.gemini/oauth_creds.json
```

#### 2. Add accounts to the proxy
Use the built-in management tool to add the contents of your `oauth_creds.json` to the proxy's account pool:

```bash
# Start the interactive add process
npm run account:add
```
1. Enter a **label** for the account (e.g., your email address).
2. Paste the **entire JSON content** of your `oauth_creds.json`.
3. Press **Enter twice** to finish.

The proxy will automatically start using the new account for incoming requests.

#### 3. Manage accounts
- **List registered accounts**: `npm run account:list`
- **Remove an account**: `npm run account:remove`

Registered accounts are stored securely in `data/accounts.json` (this directory is in `.gitignore`).

---

### Run the Proxy

```bash
# Development mode (with hot reload)
npm run dev

# Or with a custom port
PORT=3000 npm run dev
```

The server starts on `http://localhost:8080` by default. If no accounts are registered in the pool, it will automatically fall back to using the default `~/.gemini` directory on your host machine.

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

---

## Running with Docker

You can run Claude2Gemini-CLI in a Docker container. Accounts are persisted in a Docker volume.

### 1. Build and Start the Container

```bash
docker compose up -d --build
```

### 2. Manage Accounts in Docker

Since the management CLI is interactive, you must use `docker compose exec` to run it inside the container:

```bash
# Add a new account
docker compose exec -it claude2gemini npm run account:add

# List accounts
docker compose exec -it claude2gemini npm run account:list

# Remove an account
docker compose exec -it claude2gemini npm run account:remove
```

Registered account data is persisted via the `gemini-accounts` volume.

## License

This project is provided as-is for educational and experimental purposes.
