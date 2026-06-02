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
  private originalSchemas = new Map<string, any>();

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
    this.originalSchemas.clear();
    this.tools = defs.map((d) => {
      const name = d.name;
      const originalSchema = d.input_schema ?? {};
      this.originalSchemas.set(name, originalSchema);
      return {
        name,
        description: d.description ?? '',
        inputSchema: simplifySchema(originalSchema),
      };
    });
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
 * Simplifies a JSON Schema to a cleaner subset that the Gemini/Antigravity LS
 * model planner can easily understand.
 */
export function simplifySchema(schema: any): any {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  // 1. Resolve anyOf or oneOf into a simpler model
  if (schema.anyOf && Array.isArray(schema.anyOf)) {
    const firstValid = schema.anyOf.find((s: any) => s && s.type !== 'null') || schema.anyOf[0];
    if (firstValid) {
      return simplifySchema({ ...schema, ...firstValid, anyOf: undefined });
    }
  }
  if (schema.oneOf && Array.isArray(schema.oneOf)) {
    const firstValid = schema.oneOf.find((s: any) => s && s.type !== 'null') || schema.oneOf[0];
    if (firstValid) {
      return simplifySchema({ ...schema, ...firstValid, oneOf: undefined });
    }
  }

  // 2. Resolve allOf by merging all nested properties and required arrays
  if (schema.allOf && Array.isArray(schema.allOf)) {
    const merged: any = {
      ...schema,
      type: schema.type || 'object',
      properties: { ...schema.properties },
      required: [...(schema.required || [])]
    };
    for (const sub of schema.allOf) {
      const simplifiedSub = simplifySchema(sub);
      if (simplifiedSub.properties) {
        merged.properties = { ...merged.properties, ...simplifiedSub.properties };
      }
      if (Array.isArray(simplifiedSub.required)) {
        merged.required = Array.from(new Set([...merged.required, ...simplifiedSub.required]));
      }
      if (simplifiedSub.type && simplifiedSub.type !== 'object') {
        merged.type = simplifiedSub.type;
      }
    }
    delete merged.allOf;
    return simplifySchema(merged);
  }

  // 3. Handle arrays
  if (schema.type === 'array' || schema.items) {
    const newSchema = { ...schema };
    if (schema.items) {
      newSchema.items = simplifySchema(schema.items);
    }
    return newSchema;
  }

  // 4. Handle objects
  if (schema.type === 'object' || schema.properties) {
    const newSchema = { ...schema, type: 'object' };
    if (schema.properties) {
      const newProps: any = {};
      for (const [key, prop] of Object.entries(schema.properties)) {
        newProps[key] = simplifySchema(prop);
      }
      newSchema.properties = newProps;
    }
    if ('additionalProperties' in newSchema) {
      delete newSchema.additionalProperties;
    }
    return newSchema;
  }

  // 5. Handle multi-type array declarations like type: ['string', 'null']
  if (Array.isArray(schema.type)) {
    const newSchema = { ...schema };
    const mainType = schema.type.find((t: string) => t !== 'null') || schema.type[0];
    newSchema.type = mainType;
    return newSchema;
  }

  return schema;
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
      // If default is defined, always apply it
      if ((propSchema as any).default !== undefined) {
        result[key] = (propSchema as any).default;
      } else if (required.includes(key)) {
        if (expectedType === 'integer' || expectedType === 'number') {
          result[key] = 0;
        } else if (expectedType === 'boolean') {
          result[key] = false;
        } else if (expectedType === 'string') {
          result[key] = '';
        } else if (expectedType === 'array') {
          result[key] = [];
        } else if (expectedType === 'object') {
          result[key] = {};
        } else {
          result[key] = null;
        }
      }
    }
  }

  return result;
}

/**
 * Unpacks metadata tool calls (e.g. call_mcp_tool) into their target tool name and arguments.
 */
export function unpackMetaCall(name: string, args: any): { name: string; args: any } {
  if (name === 'call_mcp_tool' && args && typeof args === 'object') {
    const toolName = args.ToolName || args.toolName;
    const toolArgs = args.Arguments || args.arguments;
    if (toolName && typeof toolName === 'string') {
      return {
        name: toolName,
        args: toolArgs ?? {},
      };
    }
  }
  return { name, args };
}
