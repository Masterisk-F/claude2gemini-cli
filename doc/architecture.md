# System Architecture

## Overview

Claude2Gemini-CLI is a translation proxy that bridges two fundamentally different API paradigms:

- **Claude Messages API** — Stateless, request/response model. Every HTTP request contains the full conversation history.
- **Gemini CLI SDK** — Stateful agent loop. A single `sendStream()` call runs an internal loop that automatically handles tool execution via callbacks.

The proxy reconciles these differences by converting Claude's stateless requests into Gemini's stateful sessions, using Promise-based suspension to bridge the tool execution gap.

---

## Component Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Express Server (index.ts)                   │
│                        Port 8080                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │              POST /v1/messages (routes/messages.ts)        │  │
│  │                                                           │  │
│  │  1. Validate request (model, messages, max_tokens)        │  │
│  │  2. Detect tool_result messages → session resume          │  │
│  │  3. Convert messages → prompt                             │  │
│  │  4. Dispatch to streaming or non-streaming path           │  │
│  └───────────────┬────────────────────┬──────────────────────┘  │
│                  │                    │                          │
│         ┌────────▼────────┐  ┌───────▼─────────┐               │
│         │  Non-Streaming  │  │   Streaming      │               │
│         │  response.ts    │  │   stream.ts      │               │
│         └────────┬────────┘  └───────┬──────────┘               │
│                  │                    │                          │
│         ┌────────▼────────────────────▼──────────────────────┐  │
│         │           gemini-backend.ts                         │  │
│         │                                                    │  │
│         │  • createAgent() — SDK agent + tool registration   │  │
│         │  • sendPromptStream() — session creation/resume    │  │
│         │  • sendPromptAndCollect() — non-streaming wrapper  │  │
│         └────────────────────┬───────────────────────────────┘  │
│                              │                                  │
│         ┌────────────────────▼───────────────────────────────┐  │
│         │           session-store.ts                          │  │
│         │                                                    │  │
│         │  • Session lifecycle (create, resume, delete)       │  │
│         │  • Pending tool call tracking (toolCallId → Promise)│  │
│         │  • AsyncGenerator stream preservation               │  │
│         │  • ToolState persistence across turns               │  │
│         └────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌──── Converters ──────────────────────────────────────────┐   │
│  │                                                          │   │
│  │  request.ts       — Claude messages → Gemini prompt text │   │
│  │  response.ts      — Gemini output → Claude JSON response │   │
│  │  stream.ts        — Gemini events → Claude SSE events    │   │
│  │  tool-schema.ts   — JSON Schema → Zod schema conversion  │   │
│  │                                                          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────▼──────────┐
                    │  Gemini CLI SDK    │
                    │  (git submodule)   │
                    │                    │
                    │  GeminiCliAgent    │
                    │  GeminiCliSession  │
                    │  sendStream()      │
                    └─────────┬──────────┘
                              │
                    ┌─────────▼──────────┐
                    │  Google Gemini API │
                    └────────────────────┘
```

---

## File-by-File Description

### `server/index.ts`

Express application entry point. Configures JSON body parsing (200MB limit for large conversation histories), registers the `/v1/messages` route, and provides a `/health` endpoint.

### `server/routes/messages.ts`

The core request handler for `POST /v1/messages`. Responsibilities:

1. **Request validation** — Checks `messages`, `max_tokens`, and `model` fields
2. **Tool result detection** — Inspects the last message for `tool_result` blocks to determine if this is a session resume
3. **Session resume** — Resolves pending tool call Promises via `SessionStore.resolveToolCall()`
4. **Prompt conversion** — Delegates to `convertMessagesToPrompt()` for new conversations
5. **Response dispatch** — Routes to streaming (SSE) or non-streaming path
6. **Error handling** — Returns Claude-compatible error responses; sends SSE `event: error` during active streams

### `server/gemini-backend.ts`

Manages the Gemini CLI SDK lifecycle:

- **`createAgent()`** — Creates a `GeminiCliAgent` with dynamically registered tools. Each tool's `action` callback returns a Promise that suspends the SDK's internal agent loop until the Claude client sends back a `tool_result`.
- **`sendPromptStream()`** — Creates a new agent session or resumes an existing one. On resume, the same `ToolState` object is reused (counters and callIds reset) to maintain closure compatibility with action callbacks.
- **`sendPromptAndCollect()`** — Non-streaming wrapper that consumes the AsyncGenerator and collects text + tool calls.

### `server/session-store.ts`

In-memory state management for active tool execution sessions:

| Data | Purpose |
|------|---------|
| `SessionData.stream` | The Gemini SDK's `AsyncGenerator` — preserved across HTTP requests |
| `SessionData.pendingToolCalls` | Map of `toolCallId → { resolve, reject }` Promises |
| `SessionData.toolState` | Shared `ToolState` object for closure compatibility |
| `toolCallToSessionId` | Reverse index: `toolCallId → sessionId` for stateless lookups |

### `server/converters/request.ts`

Converts Claude message arrays into Gemini prompt strings:

- **Single user message** → Plain text extraction
- **Multi-turn** → Role-labeled conversation text (`User: ...`, `Assistant: ...`)
- **Tool blocks** → Text representations (`[Tool Call: name({...})]`, `[Tool Result: ...]`)
- **Model name mapping** — `mapModelName()` converts Claude model names to Gemini equivalents (sonnet/opus → `gemini-3.1-pro-preview`, haiku → `gemini-2.5-flash`)
- **System prompt extraction** — `extractSystemPrompt()` normalizes various system prompt formats

### `server/converters/response.ts`

Builds Claude-compatible JSON responses from Gemini output. Handles both text-only and tool-use responses, generating appropriate `stop_reason` (`end_turn` vs `tool_use`).

### `server/converters/stream.ts`

The most complex converter. Transforms Gemini's `ServerGeminiStreamEvent` async generator into Claude SSE events in real-time:

```
Gemini Event Flow                    Claude SSE Event Flow
─────────────────                    ─────────────────────
                                     event: message_start
content (text)           ──────►     event: content_block_start (text)
                                     event: content_block_delta (text_delta) × N
                                     event: content_block_stop

tool_call_request        ──────►     event: content_block_start (tool_use)
                                     event: content_block_delta (input_json_delta)
                                     event: content_block_stop

stream done / tool turn  ──────►     event: message_delta (stop_reason)
                                     event: message_stop
```

Key behaviors:
- **Built-in tool filtering** — Gemini's internal tools (e.g., `google:run_shell_command`) are silently consumed; only client-defined tools are forwarded as `tool_use` events
- **Tool turn synchronization** — Uses `ToolState.expectedClientTools` / `registeredClientTools` counters to detect when all parallel tool calls have been registered before resolving the turn

### `server/converters/tool-schema.ts`

Converts Claude's JSON Schema tool definitions into Zod schemas at runtime. Supports:

- Primitive types: `string`, `number`, `integer`, `boolean`
- Complex types: `object` (recursive), `array`
- Enums: `enum` arrays
- Required fields and optional properties

### `server/types.ts`

TypeScript type definitions for Claude API request/response structures, SSE event types, and tool-related interfaces.

---

## Core Design: Tool Use Bridge

The most challenging aspect of this proxy is bridging the tool execution models:

```
Claude Client                    Proxy                         Gemini SDK
────────────                     ─────                         ──────────
1. Send request with tools  ──►
                                 2. Create agent with tools
                                    (action = Promise)
                                 3. Call sendStream(prompt) ──► 4. Agent processes prompt
                                                                5. Decides to call a tool
                                                           ◄──  6. Triggers action callback
                                 7. action() creates Promise
                                    and stores resolve() in
                                    SessionStore
                                 8. Sends tool_use SSE     ──►
◄── 9. Receives tool_use
10. Executes tool locally
11. Sends tool_result      ──►
                                12. Looks up resolve() in
                                    SessionStore
                                13. resolve(result)        ──► 14. Agent loop resumes
                                                                15. Processes result
                                                                16. Generates response
                                                           ◄── 17. Streams response
                            ◄── 18. Forwards as SSE
```

### Multi-Turn ToolState Consistency

A critical invariant: the `ToolState` object referenced by `createAgent()`'s action closures **must be the same object** used by `stream.ts` when consuming the generator.

On session resume (turn 2+), `sendPromptStream()` retrieves the **original** `ToolState` from `SessionData` instead of creating a new one. Only the counters and `callIds` map are reset:

```typescript
// Resume path in sendPromptStream()
const toolState = session.toolState as ToolState;
toolState.callIds.clear();
toolState.expectedClientTools = 0;
toolState.registeredClientTools = 0;
```

This ensures action closures and stream consumers always share the same state across all turns.

---

## Limitations

- **No image/file content** — Only text content blocks are supported
- **No conversation caching** — Gemini SDK manages its own conversation state; multi-turn history is flattened into prompt text
- **In-memory sessions** — Sessions are lost on server restart
- **Single-process** — No horizontal scaling support (session state is process-local)
- **Built-in tool leakage** — Gemini may internally invoke tools like `google:run_shell_command` or `web_fetch` that are outside the client's defined tool set; these are filtered but may affect response quality
