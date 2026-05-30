/**
 * McpHub — Internal HTTP server that mediates between the Antigravity LS
 * (via mcp-proxy.mjs) and the external Claude API client.
 *
 * ── Endpoints ──
 * GET  /tools    → Return currently registered tools (MCP tools/list format).
 * POST /call     → Accept a tools/call from the LS; blocks the HTTP response
 *                  until resolveCall() is called by the external client.
 * POST /resolve  → Receive a tool result from the external client and resolve
 *                  a previously blocked /call request.
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

// ── Types ──────────────────────────────────────────────────────────────────

export interface PendingCall {
  /** External-facing ID matching tool_use.id / tool_result.tool_use_id */
  callId: string;
  /** Tool name */
  name: string;
  /** Tool arguments */
  args: any;
}

interface PendingEntry {
  callId: string;
  name: string;
  args: any;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

// ── Hub ────────────────────────────────────────────────────────────────────

export class McpHub extends EventEmitter {
  private server: http.Server;
  private _port = 0;
  private tools: { name: string; description: string; inputSchema: any }[] = [];
  private pending = new Map<string, PendingEntry>();
  private running = false;

  constructor() {
    super();
    this.server = http.createServer((req, res) => this.#onRequest(req, res));
    // Allow the server to not block process exit
    this.server.unref();
  }

  /** The port the hub is listening on (0 until start()). */
  get port(): number {
    return this._port;
  }

  /** Start the hub on a random available port. */
  async start(): Promise<void> {
    if (this.running) return;
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        this._port = (this.server.address() as any).port;
        this.running = true;
        resolve();
      });
    });
  }

  /** Stop the hub and reject every pending call. */
  async stop(): Promise<void> {
    this.running = false;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('McpHub shutting down'));
    }
    this.pending.clear();
    return new Promise((r) => this.server.close(() => r()));
  }

  // ── Tool management ──

  /**
   * Register tools from a Claude API request (ClaudeToolDefinition format).
   * Converts `input_schema` → `inputSchema` for MCP compatibility.
   */
  setTools(defs: { name: string; description?: string; input_schema?: any }[]): void {
    this.tools = defs.map((d) => ({
      name: d.name,
      description: d.description ?? '',
      inputSchema: d.input_schema ?? {},
    }));
  }

  /** Return the set of currently registered tools in MCP tools/list format. */
  getTools(): { name: string; description: string; inputSchema: any }[] {
    return this.tools;
  }

  // ── Call management ──

  /** Get all currently pending (unresolved) tool calls. */
  getPendingCalls(): PendingCall[] {
    return Array.from(this.pending.values()).map((e) => ({
      callId: e.callId,
      name: e.name,
      args: e.args,
    }));
  }

  /** True when at least one tool call is waiting for resolution. */
  hasPendingCalls(): boolean {
    return this.pending.size > 0;
  }

  /**
   * Resolve a pending tool call with the result from the external client.
   * @param callId The callId (matches tool_use.id / tool_result.tool_use_id)
   * @param result The MCP tool result (e.g. `{ content: [{ type: 'text', text: '...' }] }`)
   */
  async resolveCall(callId: string, result: unknown): Promise<void> {
    const entry = this.pending.get(callId);
    if (!entry) {
      throw new Error(`resolveCall: unknown callId "${callId}"`);
    }
    clearTimeout(entry.timer);
    this.pending.delete(callId);
    entry.resolve(result);
  }

  // ── HTTP handlers ──

  #onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    if (url === '/tools' && method === 'GET') {
      this.#handleToolsList(res);
    } else if (url === '/call' && method === 'POST') {
      this.#handleToolsCall(req, res);
    } else if (url === '/resolve' && method === 'POST') {
      this.#handleResolve(req, res);
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'not found' }));
    }
  }

  /** GET /tools → return tools in MCP format */
  #handleToolsList(res: http.ServerResponse): void {
    res.writeHead(200);
    res.end(JSON.stringify({ tools: this.tools }));
  }

  /**
   * POST /call → block the HTTP response until resolveCall() is called.
   *
   * The request body is the MCP tools/call params forwarded by mcp-proxy.mjs:
   *   { name: string, arguments: object }
   */
  #handleToolsCall(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.#readBody(req)
      .then((data) => {
        const { name, arguments: args } = data;
        if (!name || typeof name !== 'string') {
          res.writeHead(400);
          res.end(JSON.stringify({ error: { code: -32602, message: 'missing or invalid tool name' } }));
          return;
        }

        const callId = `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
        const timer = setTimeout(() => {
          this.pending.delete(callId);
          res.writeHead(504);
          res.end(JSON.stringify({ error: { code: -32001, message: 'tool call timed out' } }));
        }, 24 * 60 * 60 * 1000); // 24 hours

        this.pending.set(callId, {
          callId,
          name,
          args: args ?? {},
          resolve: (result) => {
            res.writeHead(200);
            res.end(JSON.stringify({ result }));
          },
          reject: (err) => {
            res.writeHead(500);
            res.end(JSON.stringify({ error: { code: -32000, message: err.message } }));
          },
          timer,
        });

        // Log the pending call and notify listeners
        process.stderr.write(`[McpHub] Pending tool call: ${name} (${callId})\n`);
        this.emit('pending_call', { callId, name, args: args ?? {} });
      })
      .catch((err) => {
        res.writeHead(400);
        res.end(JSON.stringify({ error: { code: -32700, message: err.message } }));
      });
  }

  /**
   * POST /resolve → resolve a pending tool call with the result.
   *
   * Body:
   *   { callId: string, result: any, isError?: boolean }
   */
  #handleResolve(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.#readBody(req)
      .then((data) => {
        const { callId, result, isError } = data;
        if (!callId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'missing callId' }));
          return;
        }

        const entry = this.pending.get(callId);
        if (!entry) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: `unknown callId "${callId}"` }));
          return;
        }

        clearTimeout(entry.timer);
        this.pending.delete(callId);

        if (isError) {
          entry.resolve({
            content: [],
            isError: true,
          });
        } else {
          entry.resolve(result ?? { content: [] });
        }

        process.stderr.write(`[McpHub] Resolved tool call: ${entry.name} (${callId})\n`);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
      })
      .catch((err) => {
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message }));
      });
  }

  /** Helper: read the full request body as JSON. */
  #readBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (e: any) {
          reject(new Error(`invalid JSON body: ${e.message}`));
        }
      });
      req.on('error', reject);
    });
  }
}
