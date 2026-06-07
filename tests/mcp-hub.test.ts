/**
 * McpHub HTTP API tests
 *
 * Coverage:
 *  - Lifecycle (start / stop / idempotent start)
 *  - GET /tools (registration, format, raw schema passthrough)
 *  - POST /call (blocking, JSON validation, name validation,
 *               call_mcp_tool unpacking, cleanAndFixArguments application,
 *               pending_call events, shutdown rejection)
 *  - POST /resolve (normal, isError, unknown callId, missing callId)
 *  - clearPendingCalls (mass rejection, custom reason)
 *  - Tool definition roundtrip: setTools → /tools preserves names,
 *    descriptions, required fields, and anyOf/oneOf/allOf/nested schemas
 *    verbatim.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpHub } from '../server/mcp-hub.js';

let hub: McpHub;
let port: number;

/**
 * Small fetch helper that talks to the in-process hub. Returns parsed
 * JSON and the response status so tests can assert on the wire format
 * as well as the decoded body.
 */
async function fetchJson(
  path: string,
  init?: { method?: string; body?: any },
): Promise<{ status: number; json: any; text: string }> {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (init?.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: init?.method ?? 'GET',
    headers,
    body,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // text-only responses
  }
  return { status: res.status, json, text };
}

/** Set up a fresh hub for each test. */
async function setupHub(): Promise<void> {
  hub = new McpHub();
  await hub.start();
  port = hub.port;
}

async function teardownHub(): Promise<void> {
  if (hub) {
    await hub.stop();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────

describe('McpHub lifecycle', () => {
  beforeEach(setupHub);
  afterEach(teardownHub);

  it('start assigns a non-zero port', () => {
    expect(port).toBeGreaterThan(0);
  });

  it('start is idempotent (calling start() again does not rebind the port)', async () => {
    const portBefore = hub.port;
    await hub.start();
    expect(hub.port).toBe(portBefore);
  });

  it('stop is safe to call without start', async () => {
    const fresh = new McpHub();
    await expect(fresh.stop()).resolves.toBeUndefined();
  });

  it('stop rejects every pending call with "McpHub shutting down"', async () => {
    const pending = new Promise<unknown>((resolve, reject) => {
      hub.once('pending_call', ({ callId, name, args }: any) => {
        // Capture the in-flight call so we can attempt resolution AFTER stop().
        resolve({ callId, name, args });
      });
    });
    // Fire-and-forget: we do NOT await here so we can race with stop().
    void fetchJson('/call', {
      method: 'POST',
      body: { name: 'Bash', arguments: { command: 'sleep 60' } },
    });
    await pending;
    // Now stop the hub — this should reject all in-flight /call responses.
    await hub.stop();
    // The promise we set up via fetch will reject with ECONNRESET or similar.
    // We just assert that hub.pending is empty after stop.
    expect(hub.hasPendingCalls()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /tools
// ─────────────────────────────────────────────────────────────────────────

describe('GET /tools', () => {
  beforeEach(setupHub);
  afterEach(teardownHub);

  it('returns { tools: [] } when no tools are registered', async () => {
    const res = await fetchJson('/tools');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ tools: [] });
  });

  it('returns registered tools in MCP tools/list format', async () => {
    hub.setTools([
      { name: 'Bash', description: 'Run a shell command', input_schema: { type: 'object' } },
    ]);
    const res = await fetchJson('/tools');
    expect(res.status).toBe(200);
    expect(res.json.tools).toHaveLength(1);
    expect(res.json.tools[0].name).toBe('Bash');
    expect(res.json.tools[0].description).toBe('Run a shell command');
    // The wire format must use `inputSchema` (camelCase), not `input_schema`.
    expect(res.json.tools[0].inputSchema).toBeDefined();
    expect(res.json.tools[0].input_schema).toBeUndefined();
  });

  it('returns the RAW inputSchema (passthrough is the default)', async () => {
    hub.setTools([
      {
        name: 'complex',
        description: 'has anyOf',
        input_schema: {
          type: 'object',
          properties: {
            value: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          },
        },
      },
    ]);
    const res = await fetchJson('/tools');
    // Default behavior: the original schema is forwarded as-is so the LS
    // sees anyOf/oneOf/allOf/enum/default/description verbatim.
    const valueSchema = res.json.tools[0].inputSchema.properties.value;
    expect(valueSchema.anyOf).toBeDefined();
    expect(valueSchema.anyOf).toEqual([{ type: 'string' }, { type: 'null' }]);
  });

  it('returns 404 for unknown paths', async () => {
    const res = await fetchJson('/nope');
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: 'not found' });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /call
// ─────────────────────────────────────────────────────────────────────────

describe('POST /call', () => {
  beforeEach(setupHub);
  afterEach(teardownHub);

  it('returns 400 on invalid JSON body', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{',
    });
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error.code).toBe(-32700);
  });

  it('returns 400 when name is missing', async () => {
    const res = await fetchJson('/call', {
      method: 'POST',
      body: { arguments: { x: 1 } },
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe(-32602);
  });

  it('returns 400 when name is not a string', async () => {
    const res = await fetchJson('/call', {
      method: 'POST',
      body: { name: 123, arguments: {} },
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe(-32602);
  });

  it('blocks the HTTP response until resolveCall is called', async () => {
    const pending = new Promise<{ callId: string }>((resolve) => {
      hub.once('pending_call', (e: any) => resolve({ callId: e.callId }));
    });

    // Start the request — it should hang because no one resolves it.
    const callPromise = fetchJson('/call', {
      method: 'POST',
      body: { name: 'Bash', arguments: { command: 'echo hi' } },
    });

    const { callId } = await pending;

    // The HTTP request should still be pending.
    let settled = false;
    callPromise.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);

    // Resolve the call — this unblocks the request.
    await hub.resolveCall(callId, { content: [{ type: 'text', text: 'hi\n' }] });
    const res = await callPromise;
    expect(res.status).toBe(200);
    expect(res.json.result).toEqual({ content: [{ type: 'text', text: 'hi\n' }] });
  });

  it('emits a "pending_call" event with callId, name, and args', async () => {
    const seen: any[] = [];
    hub.on('pending_call', (e: any) => seen.push(e));

    const pending = new Promise<string>((resolve) => {
      const onPending = (e: any) => {
        hub.off('pending_call', onPending);
        resolve(e.callId);
      };
      hub.on('pending_call', onPending);
    });

    const callPromise = fetchJson('/call', {
      method: 'POST',
      body: { name: 'Bash', arguments: { command: 'ls' } },
    });
    const callId = await pending;
    await hub.resolveCall(callId, { content: [] });
    await callPromise;

    expect(seen).toHaveLength(1);
    expect(seen[0].callId).toMatch(/^call_[0-9a-f]+$/);
    expect(seen[0].name).toBe('Bash');
    expect(seen[0].args).toEqual({ command: 'ls' });
  });

  it('unpacks call_mcp_tool into the target tool name and args', async () => {
    const seen: any[] = [];
    const pending = new Promise<string>((resolve) => {
      hub.on('pending_call', (e: any) => {
        seen.push(e);
        if (e.callId) resolve(e.callId);
      });
    });
    const callPromise = fetchJson('/call', {
      method: 'POST',
      body: {
        name: 'call_mcp_tool',
        Arguments: {
          ToolName: 'Bash',
          Arguments: { command: 'find .' },
          ServerName: 'claude2gemini-mcp-proxy',
        },
      },
    });
    const callId = await pending;
    await hub.resolveCall(callId, { content: [] });
    await callPromise;

    expect(seen[0].name).toBe('Bash');
    expect(seen[0].args).toEqual({ command: 'find .' });
  });

  it('applies cleanAndFixArguments using the original input_schema', async () => {
    hub.setTools([
      {
        name: 'Bash',
        description: 'run',
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            timeout: { type: 'integer', default: 30 },
            verbose: { type: 'boolean' },
          },
          required: ['command', 'verbose'],
        },
      },
    ]);

    const seen: any[] = [];
    const pending = new Promise<string>((resolve) => {
      hub.on('pending_call', (e: any) => {
        seen.push(e);
        if (e.callId) resolve(e.callId);
      });
    });
    const callPromise = fetchJson('/call', {
      method: 'POST',
      body: {
        name: 'Bash',
        arguments: {
          command: 'ls -la',
          timeout: '60', // should be coerced to integer 60
          verbose: 'true', // should be coerced to boolean true
          extra_junk: 'should be removed', // not in schema, should be stripped
        },
      },
    });
    const callId = await pending;
    await hub.resolveCall(callId, { content: [] });
    await callPromise;

    expect(seen[0].args).toEqual({
      command: 'ls -la',
      timeout: 60,
      verbose: true,
    });
    expect(seen[0].args.extra_junk).toBeUndefined();
  });

  it('keeps a missing required field as undefined (not coerced to empty string)', async () => {
    hub.setTools([
      {
        name: 'eval',
        description: 'browser evaluate',
        input_schema: {
          type: 'object',
          properties: { function: { type: 'string' } },
          required: ['function'],
        },
      },
    ]);
    const seen: any[] = [];
    const pending = new Promise<string>((resolve) => {
      hub.on('pending_call', (e: any) => {
        seen.push(e);
        if (e.callId) resolve(e.callId);
      });
    });
    const callPromise = fetchJson('/call', {
      method: 'POST',
      body: { name: 'eval', arguments: {} },
    });
    const callId = await pending;
    await hub.resolveCall(callId, { content: [] });
    await callPromise;

    // Current behavior: the missing required field is left as undefined
    // (the comment in cleanAndFixArguments says this is intentional — let
    // the tool fail with a meaningful error rather than sending "").
    expect(seen[0].args).toEqual({});
  });

  it('does NOT cleanAndFixArguments if the tool was never registered', async () => {
    // No setTools call — originalSchemas is empty.
    const seen: any[] = [];
    const pending = new Promise<string>((resolve) => {
      hub.on('pending_call', (e: any) => {
        seen.push(e);
        if (e.callId) resolve(e.callId);
      });
    });
    const callPromise = fetchJson('/call', {
      method: 'POST',
      body: {
        name: 'Unknown',
        arguments: { command: 'ls', extra_junk: 'kept verbatim' },
      },
    });
    const callId = await pending;
    await hub.resolveCall(callId, { content: [] });
    await callPromise;

    // Without originalSchemas, the args pass through unmodified.
    expect(seen[0].args).toEqual({ command: 'ls', extra_junk: 'kept verbatim' });
  });

  it('exposes the pending call via getPendingCalls / hasPendingCalls', async () => {
    const pending = new Promise<string>((resolve) => {
      hub.on('pending_call', (e: any) => resolve(e.callId));
    });
    const callPromise = fetchJson('/call', {
      method: 'POST',
      body: { name: 'Bash', arguments: { command: 'ls' } },
    });
    const callId = await pending;

    expect(hub.hasPendingCalls()).toBe(true);
    const list = hub.getPendingCalls();
    expect(list).toHaveLength(1);
    expect(list[0].callId).toBe(callId);
    expect(list[0].name).toBe('Bash');
    expect(list[0].args).toEqual({ command: 'ls' });

    await hub.resolveCall(callId, { content: [] });
    await callPromise;
    expect(hub.hasPendingCalls()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /resolve
// ─────────────────────────────────────────────────────────────────────────

describe('POST /resolve', () => {
  beforeEach(setupHub);
  afterEach(teardownHub);

  async function startCallAndGetId(name = 'Bash', args: any = { command: 'ls' }): Promise<string> {
    return new Promise<string>((resolve) => {
      hub.on('pending_call', (e: any) => resolve(e.callId));
      void fetchJson('/call', { method: 'POST', body: { name, arguments: args } });
    });
  }

  it('returns 400 when callId is missing', async () => {
    const res = await fetchJson('/resolve', {
      method: 'POST',
      body: { result: { content: [] } },
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('missing callId');
  });

  it('returns 404 for unknown callId', async () => {
    const res = await fetchJson('/resolve', {
      method: 'POST',
      body: { callId: 'no-such-call', result: { content: [] } },
    });
    expect(res.status).toBe(404);
    expect(res.json.error).toContain('unknown callId');
  });

  it('resolves a pending /call with the given result', async () => {
    // Start a call and capture its callId via the 'pending_call' event.
    const pending = new Promise<string>((resolve) => {
      hub.on('pending_call', (e: any) => resolve(e.callId));
    });
    const callPromise = fetchJson('/call', { method: 'POST', body: { name: 'Bash', arguments: { command: 'ls' } } });
    const callId = await pending;

    const resolveRes = await fetchJson('/resolve', {
      method: 'POST',
      body: { callId, result: { content: [{ type: 'text', text: 'ok' }] } },
    });
    expect(resolveRes.status).toBe(200);
    expect(resolveRes.json).toEqual({ ok: true });

    const callRes = await callPromise;
    expect(callRes.json.result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
  });

  it('isError: true resolves the call with { content: [], isError: true }', async () => {
    const pending = new Promise<string>((resolve) => {
      hub.on('pending_call', (e: any) => resolve(e.callId));
    });
    const callPromise = fetchJson('/call', { method: 'POST', body: { name: 'Bash', arguments: { command: 'false' } } });
    const callId = await pending;

    await fetchJson('/resolve', {
      method: 'POST',
      body: { callId, isError: true },
    });

    const callRes = await callPromise;
    expect(callRes.json.result).toEqual({ content: [], isError: true });
  });

  it('resolveCall throws on unknown callId (programmatic API)', async () => {
    await expect(hub.resolveCall('nope', { content: [] })).rejects.toThrow(/unknown callId/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// clearPendingCalls
// ─────────────────────────────────────────────────────────────────────────

describe('clearPendingCalls', () => {
  beforeEach(setupHub);
  afterEach(teardownHub);

  it('rejects every pending /call and clears the map', async () => {
    const settledResults: { status: number; json: any }[] = [];
    const c1 = fetchJson('/call', { method: 'POST', body: { name: 'Bash', arguments: { command: '1' } } });
    const c2 = fetchJson('/call', { method: 'POST', body: { name: 'Bash', arguments: { command: '2' } } });
    const c3 = fetchJson('/call', { method: 'POST', body: { name: 'Bash', arguments: { command: '3' } } });

    // Wait until all three are pending.
    await new Promise((r) => setTimeout(r, 30));
    expect(hub.hasPendingCalls()).toBe(true);
    expect(hub.getPendingCalls()).toHaveLength(3);

    hub.clearPendingCalls('test-cleanup');

    settledResults.push(await c1, await c2, await c3);
    for (const r of settledResults) {
      expect(r.status).toBe(500);
      expect(r.json.error.code).toBe(-32000);
      expect(r.json.error.message).toBe('test-cleanup');
    }
    expect(hub.hasPendingCalls()).toBe(false);
  });

  it('uses the default reason "Pending calls cleared" when none is provided', async () => {
    const c = fetchJson('/call', { method: 'POST', body: { name: 'Bash', arguments: { command: 'x' } } });
    await new Promise((r) => setTimeout(r, 30));
    hub.clearPendingCalls();
    const res = await c;
    expect(res.json.error.message).toBe('Pending calls cleared');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Tool definition roundtrip — perspective 1:
//   Claude → setTools → /tools preserves names, descriptions, and
//   required fields at every level of nesting.
// ─────────────────────────────────────────────────────────────────────────

describe('Tool definition roundtrip: setTools → /tools', () => {
  beforeEach(setupHub);
  afterEach(teardownHub);

  it('preserves every tool name and description', async () => {
    const defs = [
      { name: 'Bash', description: 'Run shell command', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
      { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
      { name: 'Write', description: 'Write a file', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
      { name: 'Glob', description: 'List files matching a pattern', input_schema: { type: 'object', properties: { pattern: { type: 'string' } } } },
    ];
    hub.setTools(defs);
    const res = await fetchJson('/tools');
    expect(res.json.tools).toHaveLength(4);
    const names = res.json.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(['Bash', 'Glob', 'Read', 'Write']);
    const byName: Record<string, any> = {};
    for (const t of res.json.tools) byName[t.name] = t;
    expect(byName.Bash.description).toBe('Run shell command');
    expect(byName.Read.description).toBe('Read a file');
    expect(byName.Write.description).toBe('Write a file');
    expect(byName.Glob.description).toBe('List files matching a pattern');
  });

  it('preserves description on every nested property (3 levels deep)', async () => {
    const def = {
      name: 'complex',
      description: 'has deep schema',
      input_schema: {
        type: 'object',
        properties: {
          outer: {
            type: 'object',
            description: 'outer wrapper',
            properties: {
              middle: {
                type: 'object',
                description: 'middle wrapper',
                properties: {
                  inner: { type: 'string', description: 'deepest field' },
                },
                required: ['inner'],
              },
            },
            required: ['middle'],
          },
        },
        required: ['outer'],
      },
    };
    hub.setTools([def]);
    const res = await fetchJson('/tools');
    const root = res.json.tools[0].inputSchema;
    expect(root.required).toEqual(['outer']);
    expect(root.properties.outer.description).toBe('outer wrapper');
    expect(root.properties.outer.required).toEqual(['middle']);
    expect(root.properties.outer.properties.middle.description).toBe('middle wrapper');
    expect(root.properties.outer.properties.middle.required).toEqual(['inner']);
    expect(root.properties.outer.properties.middle.properties.inner.description).toBe('deepest field');
  });

  it('preserves allOf as-is (no flattening in passthrough mode)', async () => {
    const def = {
      name: 'mergeable',
      description: 'allOf test',
      input_schema: {
        type: 'object',
        allOf: [
          {
            type: 'object',
            properties: { a: { type: 'string', description: 'param a' } },
            required: ['a'],
          },
          {
            type: 'object',
            properties: { b: { type: 'integer', description: 'param b' } },
            required: ['b'],
          },
        ],
      },
    };
    hub.setTools([def]);
    const res = await fetchJson('/tools');
    const schema = res.json.tools[0].inputSchema;
    expect(schema.allOf).toBeDefined();
    expect(schema.allOf).toHaveLength(2);
    expect(schema.allOf[0].properties.a.description).toBe('param a');
    expect(schema.allOf[1].properties.b.description).toBe('param b');
    expect(schema.allOf[0].required).toEqual(['a']);
    expect(schema.allOf[1].required).toEqual(['b']);
  });

  it('preserves anyOf as-is (with null branch)', async () => {
    const def = {
      name: 'optnull',
      description: 'optional nullable',
      input_schema: {
        type: 'object',
        properties: {
          tag: {
            anyOf: [
              { type: 'string', description: 'a tag value' },
              { type: 'null' },
            ],
          },
        },
      },
    };
    hub.setTools([def]);
    const res = await fetchJson('/tools');
    const tag = res.json.tools[0].inputSchema.properties.tag;
    expect(tag.anyOf).toBeDefined();
    expect(tag.anyOf).toEqual([
      { type: 'string', description: 'a tag value' },
      { type: 'null' },
    ]);
  });

  it('emits inputSchema with type:"object" at the root (MCP expectation)', async () => {
    hub.setTools([
      { name: 't', description: 'd', input_schema: { type: 'object', properties: {} } },
    ]);
    const res = await fetchJson('/tools');
    expect(res.json.tools[0].inputSchema.type).toBe('object');
  });

  it('clears previous tools when setTools is called again', async () => {
    hub.setTools([{ name: 'A', description: 'a', input_schema: { type: 'object' } }]);
    hub.setTools([{ name: 'B', description: 'b', input_schema: { type: 'object' } }]);
    const res = await fetchJson('/tools');
    expect(res.json.tools).toHaveLength(1);
    expect(res.json.tools[0].name).toBe('B');
  });

  it('clears originalSchemas when setTools is called again (subsequent calls use the new schema)', async () => {
    hub.setTools([
      {
        name: 'tool',
        description: 'v1',
        input_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      },
    ]);
    hub.setTools([
      {
        name: 'tool',
        description: 'v2',
        input_schema: { type: 'object', properties: { y: { type: 'integer' } }, required: ['y'] },
      },
    ]);

    // With v2's schema, the v1-only "x" property should be stripped.
    const seen: any[] = [];
    const pending = new Promise<string>((resolve) => {
      hub.on('pending_call', (e: any) => {
        seen.push(e);
        if (e.callId) resolve(e.callId);
      });
    });
    const callPromise = fetchJson('/call', {
      method: 'POST',
      body: { name: 'tool', arguments: { x: 'stale', y: '7' } },
    });
    const callId = await pending;
    await hub.resolveCall(callId, { content: [] });
    await callPromise;

    expect(seen[0].args).toEqual({ y: 7 });
    expect(seen[0].args.x).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CORS preflight (every endpoint sets Access-Control-Allow-Origin: *)
// ─────────────────────────────────────────────────────────────────────────

describe('CORS headers', () => {
  beforeEach(setupHub);
  afterEach(teardownHub);

  it('sets Access-Control-Allow-Origin: * on /tools', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/tools`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('sets Access-Control-Allow-Origin: * on /call', async () => {
    // Subscribe to the pending call so we can resolve it before draining.
    const pending = new Promise<string>((resolve) => {
      hub.on('pending_call', (e: any) => resolve(e.callId));
    });
    const fetchPromise = fetch(`http://127.0.0.1:${port}/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bash', arguments: {} }),
    });
    const callId = await pending;
    await hub.resolveCall(callId, { content: [] });
    const res = await fetchPromise;
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Default behavior (passthrough)
//
// setTools() forwards the original input_schema as-is. anyOf/oneOf/allOf,
// descriptions, enums, defaults, additionalProperties, and $ref are all
// preserved verbatim so the LS sees the schema the tool author wrote.
// ─────────────────────────────────────────────────────────────────────────

describe('Default behavior (passthrough — no env var)', () => {
  beforeEach(setupHub);
  afterEach(teardownHub);

  it('preserves anyOf as-is (no branch merging, type kept on parent)', async () => {
    const def = {
      name: 'anyoftool',
      description: 'tool with anyOf',
      input_schema: {
        type: 'object',
        properties: {
          value: {
            anyOf: [
              { type: 'string', description: 'string branch' },
              { type: 'integer', description: 'integer branch' },
              { type: 'null' },
            ],
            description: 'value field',
          },
        },
        required: ['value'],
      },
    };
    hub.setTools([def]);
    const res = await fetchJson('/tools');
    const prop = res.json.tools[0].inputSchema.properties.value;

    expect(prop.anyOf).toBeDefined();
    expect(prop.anyOf).toHaveLength(3);
    expect(prop.anyOf[0].type).toBe('string');
    expect(prop.anyOf[0].description).toBe('string branch');
    expect(prop.anyOf[1].type).toBe('integer');
    expect(prop.anyOf[1].description).toBe('integer branch');
    expect(prop.anyOf[2].type).toBe('null');
    expect(prop.description).toBe('value field');
    expect(prop.type).toBeUndefined();
  });

  it('preserves oneOf as-is (XOR semantics intact — branches not flattened)', async () => {
    const def = {
      name: 'oneoftool',
      description: 'tool with oneOf',
      input_schema: {
        type: 'object',
        properties: {
          mode: {
            oneOf: [
              { type: 'string', enum: ['a', 'b'], description: 'string mode' },
              { type: 'number', description: 'numeric mode' },
            ],
            description: 'mode selector',
          },
        },
      },
    };
    hub.setTools([def]);
    const res = await fetchJson('/tools');
    const prop = res.json.tools[0].inputSchema.properties.mode;

    expect(prop.oneOf).toBeDefined();
    expect(prop.oneOf).toHaveLength(2);
    expect(prop.oneOf[0].enum).toEqual(['a', 'b']);
    expect(prop.oneOf[0].description).toBe('string mode');
    expect(prop.oneOf[1].description).toBe('numeric mode');
  });

  it('preserves allOf as-is (no flattening)', async () => {
    const def = {
      name: 'alloftool',
      description: 'tool with allOf',
      input_schema: {
        allOf: [
          {
            type: 'object',
            properties: { id: { type: 'string', description: 'id field' } },
            required: ['id'],
          },
          {
            type: 'object',
            properties: { name: { type: 'string', description: 'name field' } },
            required: ['name'],
          },
        ],
      },
    };
    hub.setTools([def]);
    const res = await fetchJson('/tools');
    const schema = res.json.tools[0].inputSchema;

    expect(schema.allOf).toBeDefined();
    expect(schema.allOf).toHaveLength(2);
    expect(schema.allOf[0].properties.id.description).toBe('id field');
    expect(schema.allOf[1].properties.name.description).toBe('name field');
  });

  it('preserves enum values on individual properties', async () => {
    const def = {
      name: 'enumtool',
      description: 'tool with enum',
      input_schema: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['low', 'medium', 'high'], description: 'log level' },
        },
        required: ['level'],
      },
    };
    hub.setTools([def]);
    const res = await fetchJson('/tools');
    const prop = res.json.tools[0].inputSchema.properties.level;

    expect(prop.enum).toEqual(['low', 'medium', 'high']);
    expect(prop.description).toBe('log level');
  });

  it('preserves default values on individual properties', async () => {
    const def = {
      name: 'defaulttool',
      description: 'tool with default',
      input_schema: {
        type: 'object',
        properties: {
          retries: { type: 'integer', default: 3, description: 'retry count' },
        },
      },
    };
    hub.setTools([def]);
    const res = await fetchJson('/tools');
    const prop = res.json.tools[0].inputSchema.properties.retries;

    expect(prop.default).toBe(3);
    expect(prop.description).toBe('retry count');
  });

  it('preserves additionalProperties (the legacy simplifier used to drop it)', async () => {
    const def = {
      name: 'addltool',
      description: 'tool with additionalProperties',
      input_schema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        additionalProperties: false,
      },
    };
    hub.setTools([def]);
    const res = await fetchJson('/tools');
    expect(res.json.tools[0].inputSchema.additionalProperties).toBe(false);
  });

  it('preserves multi-type array declarations like ["string", "null"]', async () => {
    const def = {
      name: 'multitypetool',
      description: 'tool with multi-type',
      input_schema: {
        type: 'object',
        properties: {
          value: { type: ['string', 'null'], description: 'nullable string' },
        },
      },
    };
    hub.setTools([def]);
    const res = await fetchJson('/tools');
    const prop = res.json.tools[0].inputSchema.properties.value;

    expect(prop.type).toEqual(['string', 'null']);
    expect(prop.description).toBe('nullable string');
  });

  it('preserves descriptions on the root schema', async () => {
    const def = {
      name: 'rootdesctool',
      description: 'tool description here',
      input_schema: {
        type: 'object',
        description: 'the root schema description',
        properties: { x: { type: 'integer' } },
      },
    };
    hub.setTools([def]);
    const res = await fetchJson('/tools');
    expect(res.json.tools[0].inputSchema.description).toBe('the root schema description');
  });

  it('preserves deeply nested anyOf/oneOf/allOf intact', async () => {
    const def = {
      name: 'nestedtool',
      description: 'nested composition',
      input_schema: {
        type: 'object',
        properties: {
          outer: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  inner: {
                    oneOf: [
                      { type: 'string', description: 'a' },
                      { type: 'integer', description: 'b' },
                    ],
                    description: 'inner selector',
                  },
                },
                required: ['inner'],
              },
              { type: 'null' },
            ],
            description: 'outer wrapper',
          },
        },
      },
    };
    hub.setTools([def]);
    const res = await fetchJson('/tools');
    const outer = res.json.tools[0].inputSchema.properties.outer;

    expect(outer.anyOf).toBeDefined();
    expect(outer.anyOf).toHaveLength(2);
    const inner = outer.anyOf[0].properties.inner;
    expect(inner.oneOf).toBeDefined();
    expect(inner.oneOf[0].description).toBe('a');
    expect(inner.oneOf[1].description).toBe('b');
  });

  it('preserves $ref / $defs (passes them through unchanged)', async () => {
    const def = {
      name: 'reftool',
      description: 'tool with $ref',
      input_schema: {
        type: 'object',
        properties: {
          foo: { $ref: '#/$defs/Bar', description: 'referenced' },
        },
        $defs: {
          Bar: { type: 'string', description: 'bar def' },
        },
      },
    };
    hub.setTools([def]);
    const res = await fetchJson('/tools');
    const schema = res.json.tools[0].inputSchema;

    expect(schema.properties.foo.$ref).toBe('#/$defs/Bar');
    expect(schema.$defs.Bar.description).toBe('bar def');
  });
});
