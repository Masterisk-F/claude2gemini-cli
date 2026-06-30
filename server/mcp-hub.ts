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
  /** If claimed by a cascade */
  claimedBy?: string;
}

interface PendingEntry {
  callId: string;
  name: string;
  args: any;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  claimedBy?: string;
}

// ── Hub ────────────────────────────────────────────────────────────────────

export class McpHub extends EventEmitter {
  private server: http.Server;
  private _port = 0;
  private tools: { name: string; description: string; inputSchema: any }[] = [];
  private pending = new Map<string, PendingEntry>();
  private running = false;
  private originalSchemas = new Map<string, any>();

  /**
   * Timestamp (ms) of the last tools registration via setTools().
   * Used to verify the MCP proxy has fetched the updated tool list.
   */
  private toolsVersion = 0;
  /**
   * Version of the tool list last served to a client (mcp-proxy) via GET /tools.
   * Compared against `toolsVersion` to detect stale fetches.
   */
  private lastServedVersion = 0;
  /**
   * Resolvers waiting for the proxy to fetch the latest tool list.
   */
  private toolsFetchWaiters: Array<{ version: number; resolve: () => void }> = [];

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
   *
   * The original schema is forwarded as-is to the LS so anyOf/oneOf/allOf,
   * descriptions, enums, defaults, and $ref are preserved. The MCP spec
   * requires clients (LS) to support JSON Schema 2020-12, so flattening
   * these keywords loses information the model would otherwise use to
   * generate correct tool calls (notably: `oneOf` collapses to "all
   * branches required", which causes the model to invent parameters
   * the schema never asked for).
   */
  setTools(defs: { name: string; description?: string; input_schema?: any }[]): void {
    this.originalSchemas.clear();
    this.tools = defs.map((d) => {
      const name = d.name;
      const originalSchema = d.input_schema ?? {};
      this.originalSchemas.set(name, originalSchema);
      return {
        name,
        description: d.description ?? '',
        inputSchema: originalSchema,
      };
    });
    this.toolsVersion++;
  }

  /**
   * Wait until an MCP client (the mcp-proxy) has fetched the current
   * tool list via GET /tools. This resolves the race condition where
   * refreshMcpServers returns before the proxy has actually loaded
   * the tools.
   */
  async waitForToolsFetch(timeoutMs = 10_000): Promise<void> {
    // Already fetched — return immediately
    if (this.lastServedVersion >= this.toolsVersion) return;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove this waiter from the list
        this.toolsFetchWaiters = this.toolsFetchWaiters.filter(w => w.resolve !== wrappedResolve);
        resolve(); // Don't reject — just proceed (best-effort)
      }, timeoutMs);
      const wrappedResolve = () => {
        clearTimeout(timer);
        resolve();
      };
      this.toolsFetchWaiters.push({ version: this.toolsVersion, resolve: wrappedResolve });
    });
  }

  /** Return the set of currently registered tools in MCP tools/list format. */
  getTools(): { name: string; description: string; inputSchema: any }[] {
    return this.tools;
  }

  /** Return the original input_schema for a tool (for argument validation). */
  getOriginalSchema(name: string): any {
    return this.originalSchemas.get(name);
  }

  // ── Call management ──

  /**
   * Return a list of pending tool calls that have been received by the hub
   * but not yet resolved.
   */
  getPendingCalls(): PendingCall[] {
    return Array.from(this.pending.values()).map(entry => ({
      callId: entry.callId,
      name: entry.name,
      args: entry.args,
      claimedBy: entry.claimedBy,
    }));
  }

  /**
   * Claim a pending call for a specific cascade to prevent other concurrent
   * cascades from picking up the same tool call.
   */
  claimCall(callId: string, cascadeId: string): boolean {
    const call = this.pending.get(callId);
    if (!call) return false;
    if (call.claimedBy && call.claimedBy !== cascadeId) return false;
    call.claimedBy = cascadeId;
    return true;
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

  /**
   * Clear all pending tool calls and reject their associated HTTP requests.
   * Useful when the cascade history is reverted and old tool calls are no longer valid.
   * @param reason The error message to send to the proxy.
   */
  clearPendingCalls(reason: string = 'Pending calls cleared'): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
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
    this.lastServedVersion = this.toolsVersion;
    // Wake up any waiters that were waiting for this fetch
    const currentVersion = this.toolsVersion;
    this.toolsFetchWaiters = this.toolsFetchWaiters.filter(w => {
      if (w.version <= currentVersion) {
        w.resolve();
        return false;
      }
      return true;
    });
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
        let name = data.name;
        let args = data.arguments ?? data.Arguments;
        if (!name || typeof name !== 'string') {
          res.writeHead(400);
          res.end(JSON.stringify({ error: { code: -32602, message: 'missing or invalid tool name' } }));
          return;
        }

        // Unpack metadata tool calls like call_mcp_tool
        const unpacked = unpackMetaCall(name, args ?? {});
        name = unpacked.name;
        args = unpacked.args;

        const originalSchema = this.originalSchemas.get(name);
        if (originalSchema) {
          args = cleanAndFixArguments(args ?? {}, originalSchema);
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
        process.stderr.write(`[McpHub] Pending tool call: ${name} (${callId}) args: ${JSON.stringify(args)}\n`);
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

/**
 * Cleanses and coerces arguments generated by LS to match the constraints
 * defined in the original schema (e.g. types, required fields, and additionalProperties restriction).
 */
export function cleanAndFixArguments(args: any, schema: any): any {
  if (!schema || typeof schema !== 'object') {
    return args;
  }
  if (!args || typeof args !== 'object') {
    return args;
  }

  let activeSchema = { ...schema };

  // Resolve multi-schema options to find the best match based on keys
  if (schema.anyOf && Array.isArray(schema.anyOf)) {
    let bestSchema = schema.anyOf[0];
    let maxMatches = -1;
    for (const sub of schema.anyOf) {
      if (sub && sub.properties) {
        const matches = Object.keys(args).filter(k => k in sub.properties).length;
        if (matches > maxMatches) {
          maxMatches = matches;
          bestSchema = sub;
        }
      }
    }
    activeSchema = { ...schema, ...bestSchema };
  } else if (schema.oneOf && Array.isArray(schema.oneOf)) {
    let bestSchema = schema.oneOf[0];
    let maxMatches = -1;
    for (const sub of schema.oneOf) {
      if (sub && sub.properties) {
        const matches = Object.keys(args).filter(k => k in sub.properties).length;
        if (matches > maxMatches) {
          maxMatches = matches;
          bestSchema = sub;
        }
      }
    }
    activeSchema = { ...schema, ...bestSchema };
  } else if (schema.allOf && Array.isArray(schema.allOf)) {
    const mergedProperties = { ...schema.properties };
    const mergedRequired = [...(schema.required || [])];
    for (const sub of schema.allOf) {
      if (sub.properties) {
        Object.assign(mergedProperties, sub.properties);
      }
      if (Array.isArray(sub.required)) {
        mergedRequired.push(...sub.required);
      }
    }
    activeSchema = { ...schema, properties: mergedProperties, required: Array.from(new Set(mergedRequired)) };
  }

  const result: any = {};
  const properties = activeSchema.properties || {};
  const required = activeSchema.required || [];

  // Copy defined properties, applying coercion
  for (const [key, propSchema] of Object.entries(properties)) {
    const value = args[key];
    const expectedType = (propSchema as any).type;

    if (value !== undefined) {
      if (expectedType === 'integer' || expectedType === 'number') {
        const numVal = Number(value);
        result[key] = isNaN(numVal) ? value : numVal;
      } else if (expectedType === 'boolean') {
        if (typeof value === 'string') {
          result[key] = value.toLowerCase() === 'true';
        } else {
          result[key] = Boolean(value);
        }
      } else if (expectedType === 'string') {
        if (typeof value === 'object') {
          result[key] = JSON.stringify(value);
        } else {
          result[key] = String(value);
        }
      } else if (expectedType === 'array' && Array.isArray(value)) {
        const itemSchema = (propSchema as any).items;
        if (itemSchema) {
          result[key] = value.map(item => {
            if (typeof item === 'object' && item !== null) {
              return cleanAndFixArguments(item, itemSchema);
            }
            return item;
          });
        } else {
          result[key] = value;
        }
      } else if (expectedType === 'object' && typeof value === 'object' && value !== null) {
        result[key] = cleanAndFixArguments(value, propSchema);
      } else {
        result[key] = value;
      }
    } else {
      // If default is defined, always apply it.
      // For required fields with no value provided, leave them undefined
      // rather than filling with empty strings/zeros/false. Let the tool
      // call fail with a meaningful error so the model can self-correct.
      // Filling required strings with '' causes tools like browser_evaluate
      // and browser_click to execute with nonsensical empty arguments.
      if ((propSchema as any).default !== undefined) {
        result[key] = (propSchema as any).default;
      }
    }
  }

  return result;
}

/**
 * Unpacks metadata tool calls (e.g. call_mcp_tool) into their target tool name and arguments.
 */
export function unpackMetaCall(name: string, args: any): { name: string; args: any } {
  let resolvedName = name;
  // Strip MCP server prefix if present (safety net for models that prepend it)
  const MCP_PREFIX = 'claude2gemini-mcp-proxy:';
  const MCP_ALT_PREFIX = 'claude2gemini-mcp-proxy__';
  if (typeof resolvedName === 'string' && resolvedName.startsWith(MCP_PREFIX)) {
    resolvedName = resolvedName.slice(MCP_PREFIX.length);
  } else if (typeof resolvedName === 'string' && resolvedName.startsWith(MCP_ALT_PREFIX)) {
    resolvedName = resolvedName.slice(MCP_ALT_PREFIX.length);
  }

  if (resolvedName === 'call_mcp_tool' && args && typeof args === 'object') {
    const toolName = args.ToolName || args.toolName;
    const toolArgs = args.Arguments || args.arguments;
    if (toolName && typeof toolName === 'string') {
      return {
        name: toolName,
        args: toolArgs ?? {},
      };
    }
  }
  return { name: resolvedName, args };
}
