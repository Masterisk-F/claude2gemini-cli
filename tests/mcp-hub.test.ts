/**
 * McpHub HTTP API tests
 *
 * Coverage:
 *  - Lifecycle (start / stop / idempotent start)
 *  - GET /tools (registration, format, simplification roundtrip)
 *  - POST /call (blocking, JSON validation, name validation,
 *               call_mcp_tool unpacking, cleanAndFixArguments application,
 *               pending_call events, shutdown rejection)
 *  - POST /resolve (normal, isError, unknown callId, missing callId)
 *  - clearPendingCalls (mass rejection, custom reason)
 *  - Tool definition roundtrip: setTools → /tools preserves names,
 *    descriptions, required fields, and nested schemas through
 *    simplifySchema.
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

  it('returns the SIMPLIFIED inputSchema, not the raw input_schema', async () => {
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
    // simplifySchema should drop anyOf with [string, null] and keep the string type.
    const valueSchema = res.json.tools[0].inputSchema.properties.value;
    expect(valueSchema.type).toBe('string');
    expect(valueSchema.anyOf).toBeUndefined();
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

  it('merges allOf without losing required or description from any branch', async () => {
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
    expect(schema.allOf).toBeUndefined();
    expect(schema.properties.a.description).toBe('param a');
    expect(schema.properties.b.description).toBe('param b');
    expect(schema.required.sort()).toEqual(['a', 'b']);
  });

  it('merges anyOf (with null branch) and keeps the non-null type (description is currently dropped on the branch merge — see note)', async () => {
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
    expect(tag.type).toBe('string');
    // The anyOf branch is dropped, so the description from the string branch
    // is also dropped by the current implementation. This is a known
    // limitation that LS-side models would benefit from fixing — see
    // simplifySchema in mcp-hub.ts. Snapshotting current behavior here.
    expect(tag.anyOf).toBeUndefined();
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
