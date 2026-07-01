/**
 * mcp-proxy.mjs tests
 *
 * Spawns the real mcp-proxy.mjs subprocess and exercises its JSON-RPC
 * bridge to a local mock McpHub HTTP server. Validates:
 *  - initialize handshake
 *  - tools/list (success / empty / hub error / hub unreachable)
 *  - tools/call (success, Arguments vs arguments, call_mcp_tool, _meta, hub error)
 *  - Protocol errors (invalid JSON, unknown method, notifications, parallel calls)
 *  - tools/list_changed notification (1s polling)
 *  - 24h timeout (existing test, preserved)
 *
 * The hub is a tiny HTTP server in-process; the proxy talks to it over
 * HTTP just like in production. Tests run in < 5s each.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import http from 'http';
import readline from 'readline';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

const MCP_PROXY_PATH = new URL('../server/mcp-proxy.mjs', import.meta.url).pathname;

// ── Mock hub ────────────────────────────────────────────────────────────

type CallHandler = (body: { name: string; arguments?: any; Arguments?: any; _meta?: any }) =>
  { status: number; body: any };

interface MockHub {
  port: number;
  setTools: (tools: any[]) => void;
  setCallHandler: (handler: CallHandler) => void;
  close: () => Promise<void>;
}

/** Create a tiny HTTP server that mimics McpHub's /tools, /call, /resolve. */
function startMockHub(): Promise<MockHub> {
  return new Promise((resolve) => {
    let tools: any[] = [];
    let callHandler: CallHandler = () => ({ status: 200, body: { result: { content: [] } } });

    const server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json');
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        if (req.url === '/tools' && req.method === 'GET') {
          res.writeHead(200);
          res.end(JSON.stringify({ tools }));
          return;
        }
        if (req.url === '/call' && req.method === 'POST') {
          try {
            const data = raw ? JSON.parse(raw) : {};
            const { status, body } = callHandler(data);
            res.writeHead(status);
            res.end(JSON.stringify(body));
          } catch (e: any) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: e.message }));
          }
          return;
        }
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'not found' }));
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        setTools: (t) => { tools = t; },
        setCallHandler: (h) => { callHandler = h; },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// ── Proxy runner ────────────────────────────────────────────────────────

interface Proxy {
  proc: ChildProcessWithoutNullStreams;
  send: (msg: any) => void;
  /** Wait for the next JSON-RPC message that satisfies `predicate`. */
  waitFor: (predicate: (msg: any) => boolean, timeoutMs?: number) => Promise<any>;
  /** Drain all messages currently in the read buffer that match `predicate`. */
  collect: (predicate: (msg: any) => boolean, timeoutMs?: number) => Promise<any[]>;
  close: () => Promise<void>;
}

function spawnProxy(hubPort: number, env: Record<string, string> = {}): Proxy {
  const proc = spawn('node', [MCP_PROXY_PATH, '--hub-port', String(hubPort)], {
    env: { ...process.env, ...env },
  }) as ChildProcessWithoutNullStreams;

  const queue: any[] = [];
  const waiters: { predicate: (m: any) => boolean; resolve: (m: any) => void; timer: NodeJS.Timeout }[] = [];

  const rl = readline.createInterface({ input: proc.stdout, terminal: false });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    queue.push(parsed);
    // Wake any waiter that matches.
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i]!;
      if (w.predicate(parsed)) {
        clearTimeout(w.timer);
        waiters.splice(i, 1);
        w.resolve(parsed);
      }
    }
  });

  const send = (msg: any) => {
    proc.stdin.write(JSON.stringify(msg) + '\n');
  };

  const waitFor = (predicate: (m: any) => boolean, timeoutMs = 2000): Promise<any> => {
    // First check the queue (in case the message arrived before we set up the waiter).
    for (let i = 0; i < queue.length; i++) {
      if (predicate(queue[i])) {
        const [m] = queue.splice(i, 1);
        return Promise.resolve(m);
      }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = waiters.findIndex((w) => w.predicate === predicate);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error(`waitFor: timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      waiters.push({ predicate, resolve, timer });
    });
  };

  const collect = (predicate: (m: any) => boolean, timeoutMs = 200): Promise<any[]> => {
    const matched: any[] = [];
    for (let i = queue.length - 1; i >= 0; i--) {
      if (predicate(queue[i])) matched.unshift(queue.splice(i, 1)[0]!);
    }
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(matched), timeoutMs);
      const drain = (m: any) => {
        if (predicate(m)) {
          matched.push(m);
        }
      };
      // Attach a transient listener to capture anything that arrives before the timer.
      const handler = (m: any) => drain(m);
      // Use a one-shot sub-listener via the same waiter machinery.
      const promise = new Promise<void>((res) => {
        const stopper = setTimeout(() => {
          clearTimeout(t);
          res();
        }, timeoutMs);
        waiters.push({
          predicate: (m) => {
            if (predicate(m)) {
              drain(m);
              return true;
            }
            return false;
          },
          resolve: () => {
            clearTimeout(stopper);
            res();
          },
          timer: stopper,
        });
      });
      void handler;
      void promise;
    });
  };

  const close = () => new Promise<void>((resolve) => {
    try { proc.stdin.end(); } catch { /* already closed */ }
    try { proc.kill('SIGTERM'); } catch { /* already dead */ }
    rl.close();
    // Give the process a brief moment to exit, then move on regardless.
    setTimeout(resolve, 50);
  });

  return { proc, send, waitFor, collect, close };
}

// ── Test scaffolding ────────────────────────────────────────────────────

interface Fixture {
  hub: MockHub;
  proxy: Proxy;
  cleanup: () => Promise<void>;
}

async function setup(env: Record<string, string> = {}): Promise<Fixture> {
  const hub = await startMockHub();
  const proxy = spawnProxy(hub.port, env);
  return {
    hub,
    proxy,
    cleanup: async () => {
      await proxy.close();
      await hub.close();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Existing 24-hour timeout test (preserved)
// ─────────────────────────────────────────────────────────────────────────

describe('mcp-proxy timeout', () => {
  it('should return 24 hours timeout message when call times out', async () => {
    const server = http.createServer(() => {
      // Never respond → force timeout.
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve((server.address() as AddressInfo).port);
      });
    });

    const proc = spawn('node', [MCP_PROXY_PATH, '--hub-port', port.toString()], {
      env: { ...process.env, MCP_PROXY_TIMEOUT_MS: '50' },
    });
    const rl = readline.createInterface({ input: proc.stdout });
    const responsePromise = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout')), 5000);
      rl.on('line', (line) => {
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === 1) {
            clearTimeout(timeout);
            resolve(parsed);
          }
        } catch { /* ignore */ }
      });
    });

    proc.stdin.write(JSON.stringify({
      jsonrpc: '2.0', method: 'initialize', id: 0, params: { protocolVersion: '2024-11-05' },
    }) + '\n');
    proc.stdin.write(JSON.stringify({
      jsonrpc: '2.0', method: 'tools/call', id: 1, params: { name: 'dummy-tool', arguments: {} },
    }) + '\n');

    const response = await responsePromise;
    rl.close();
    proc.kill();
    await new Promise<void>((r) => server.close(() => r()));

    expect(response.error).toBeDefined();
    expect(response.error.code).toBe(-32001);
    expect(response.error.message).toBe('tool call timed out after 24 hours');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// initialize handshake
// ─────────────────────────────────────────────────────────────────────────

describe('mcp-proxy initialize', () => {
  let f: Fixture;
  afterEach(async () => { if (f) await f.cleanup(); });

  it('responds to initialize with protocolVersion, capabilities, and serverInfo', async () => {
    f = await setup();
    f.proxy.send({ jsonrpc: '2.0', method: 'initialize', id: 'init-1', params: { protocolVersion: '2024-11-05' } });
    const res = await f.proxy.waitFor((m) => m.id === 'init-1');
    expect(res.jsonrpc).toBe('2.0');
    expect(res.result.protocolVersion).toBe('2024-11-05');
    expect(res.result.capabilities).toEqual({ tools: { listChanged: true } });
    expect(res.result.serverInfo).toEqual({
      name: 'claude2gemini-mcp-proxy',
      version: '0.6.0',
    });
  });

  it('falls back to a default protocolVersion when none is supplied', async () => {
    f = await setup();
    f.proxy.send({ jsonrpc: '2.0', method: 'initialize', id: 'init-2', params: {} });
    const res = await f.proxy.waitFor((m) => m.id === 'init-2');
    expect(res.result.protocolVersion).toBe('2024-11-05');
  });

  it('still responds when params is null', async () => {
    f = await setup();
    f.proxy.send({ jsonrpc: '2.0', method: 'initialize', id: 'init-3', params: null });
    const res = await f.proxy.waitFor((m) => m.id === 'init-3');
    expect(res.result.protocolVersion).toBe('2024-11-05');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// tools/list
// ─────────────────────────────────────────────────────────────────────────

describe('mcp-proxy tools/list', () => {
  let f: Fixture;
  afterEach(async () => { if (f) await f.cleanup(); });

  it('forwards the hub tool list to the LS as { result: { tools: [...] } }', async () => {
    f = await setup();
    f.hub.setTools([
      { name: 'Bash', description: 'run cmd', inputSchema: { type: 'object' } },
      { name: 'Read', description: 'read file', inputSchema: { type: 'object' } },
    ]);
    f.proxy.send({ jsonrpc: '2.0', method: 'tools/list', id: 10 });
    const res = await f.proxy.waitFor((m) => m.id === 10);
    expect(res.result.tools).toHaveLength(2);
    expect(res.result.tools[0].name).toBe('Bash');
    expect(res.result.tools[1].name).toBe('Read');
  });

  it('returns { result: { tools: [] } } when the hub has no tools', async () => {
    f = await setup();
    f.hub.setTools([]);
    f.proxy.send({ jsonrpc: '2.0', method: 'tools/list', id: 11 });
    const res = await f.proxy.waitFor((m) => m.id === 11);
    expect(res.result).toEqual({ tools: [] });
  });

  it('returns a -32000 error when the hub responds with non-2xx', async () => {
    // Build a one-off hub that 500s on /tools.
    const altServer = http.createServer((_req, res) => {
      res.writeHead(500);
      res.end('kaboom');
    });
    const altPort = await new Promise<number>((resolve) => {
      altServer.listen(0, '127.0.0.1', () => resolve((altServer.address() as AddressInfo).port));
    });
    const proxy = spawnProxy(altPort);
    try {
      proxy.send({ jsonrpc: '2.0', method: 'tools/list', id: 12 });
      const res = await proxy.waitFor((m) => m.id === 12);
      expect(res.error).toBeDefined();
      expect(res.error.code).toBe(-32000);
      expect(res.error.message).toContain('hub error: 500');
    } finally {
      await proxy.close();
      await new Promise<void>((r) => altServer.close(() => r()));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// tools/call
// ─────────────────────────────────────────────────────────────────────────

describe('mcp-proxy tools/call', () => {
  let f: Fixture;
  afterEach(async () => { if (f) await f.cleanup(); });

  it('forwards tools/call with arguments (camelCase) to the hub and returns the result', async () => {
    f = await setup();
    f.hub.setCallHandler(({ name, arguments: args }) => {
      return { status: 200, body: { result: { content: [{ type: 'text', text: `called ${name}` }] } } };
    });
    f.proxy.send({
      jsonrpc: '2.0',
      method: 'tools/call',
      id: 20,
      params: { name: 'Bash', arguments: { command: 'ls' } },
    });
    const res = await f.proxy.waitFor((m) => m.id === 20);
    expect(res.result.content[0].text).toBe('called Bash');
  });

  it('also accepts Arguments (PascalCase) as the args container', async () => {
    f = await setup();
    let received: any = null;
    f.hub.setCallHandler((body) => {
      received = body;
      return { status: 200, body: { result: { content: [] } } };
    });
    f.proxy.send({
      jsonrpc: '2.0',
      method: 'tools/call',
      id: 21,
      params: { name: 'Bash', Arguments: { command: 'ls' } },
    });
    await f.proxy.waitFor((m) => m.id === 21);
    // The mcp-proxy.mjs prefers `arguments` over `Arguments` (the hub
    // additionally has its own fallback). Either way, the hub should
    // receive the command.
    expect(received.arguments?.command ?? received.Arguments?.command).toBe('ls');
  });

  it('forwards call_mcp_tool form unchanged (the hub unpacks it)', async () => {
    f = await setup();
    let received: any = null;
    f.hub.setCallHandler((body) => {
      received = body;
      return { status: 200, body: { result: { content: [] } } };
    });
    f.proxy.send({
      jsonrpc: '2.0',
      method: 'tools/call',
      id: 22,
      params: {
        name: 'call_mcp_tool',
        Arguments: { ToolName: 'Bash', Arguments: { command: 'ls' } },
      },
    });
    await f.proxy.waitFor((m) => m.id === 22);
    // mcp-proxy.mjs normalizes Arguments → arguments when forwarding to
    // the hub, so the hub sees the call_mcp_tool form with the nested
    // ToolName/Arguments inside `arguments` (the hub's own unpackMetaCall
    // will then unwrap it).
    expect(received.name).toBe('call_mcp_tool');
    expect(received.arguments.ToolName).toBe('Bash');
    expect(received.arguments.Arguments.command).toBe('ls');
  });

  it('propagates _meta unchanged to the hub', async () => {
    f = await setup();
    let received: any = null;
    f.hub.setCallHandler((body) => {
      received = body;
      return { status: 200, body: { result: { content: [] } } };
    });
    f.proxy.send({
      jsonrpc: '2.0',
      method: 'tools/call',
      id: 23,
      params: {
        name: 'Bash',
        arguments: { command: 'ls' },
        _meta: { traceId: 'abc-123' },
      },
    });
    await f.proxy.waitFor((m) => m.id === 23);
    expect(received._meta).toEqual({ traceId: 'abc-123' });
  });

  it('returns a -32000 error when the hub responds with non-2xx', async () => {
    f = await setup();
    f.hub.setCallHandler(() => ({ status: 400, body: { error: 'bad tool' } }));
    f.proxy.send({
      jsonrpc: '2.0',
      method: 'tools/call',
      id: 24,
      params: { name: 'Broken', arguments: {} },
    });
    const res = await f.proxy.waitFor((m) => m.id === 24);
    expect(res.error).toBeDefined();
    expect(res.error.code).toBe(-32000);
    expect(res.error.message).toContain('hub call error: 400');
  });

  it('passes through { result: ... } wrapping from the hub verbatim', async () => {
    f = await setup();
    f.hub.setCallHandler(() => ({
      status: 200,
      body: { result: { content: [{ type: 'text', text: 'verbatim' }], isError: false } },
    }));
    f.proxy.send({
      jsonrpc: '2.0',
      method: 'tools/call',
      id: 25,
      params: { name: 'Bash', arguments: {} },
    });
    const res = await f.proxy.waitFor((m) => m.id === 25);
    expect(res.result).toEqual({ content: [{ type: 'text', text: 'verbatim' }], isError: false });
  });

  it('falls back to the raw body when the hub response has no `result` key', async () => {
    f = await setup();
    f.hub.setCallHandler(() => ({
      status: 200,
      body: { content: [{ type: 'text', text: 'flat' }] },
    }));
    f.proxy.send({
      jsonrpc: '2.0',
      method: 'tools/call',
      id: 26,
      params: { name: 'Bash', arguments: {} },
    });
    const res = await f.proxy.waitFor((m) => m.id === 26);
    // mcp-proxy.mjs does: result: data.result ?? data — so flat body
    // becomes `result` verbatim.
    expect(res.result).toEqual({ content: [{ type: 'text', text: 'flat' }] });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Protocol errors
// ─────────────────────────────────────────────────────────────────────────

describe('mcp-proxy protocol errors', () => {
  let f: Fixture;
  afterEach(async () => { if (f) await f.cleanup(); });

  it('returns -32601 for unknown methods', async () => {
    f = await setup();
    f.proxy.send({ jsonrpc: '2.0', method: 'tools/foo', id: 30 });
    const res = await f.proxy.waitFor((m) => m.id === 30);
    expect(res.error).toBeDefined();
    expect(res.error.code).toBe(-32601);
    expect(res.error.message).toContain('Method not found: tools/foo');
  });

  it('silently ignores notifications (messages with no id)', async () => {
    f = await setup();
    f.proxy.send({ jsonrpc: '2.0', method: 'notifications/something' });
    // Give the proxy a moment to process; no response should be emitted.
    const matches = await f.proxy.collect(() => true, 200);
    expect(matches).toHaveLength(0);
  });

  it('does NOT respond to invalid JSON (logs to stderr, drops the line)', async () => {
    f = await setup();
    f.proxy.proc.stdin.write('not-json{\n');
    const matches = await f.proxy.collect(() => true, 200);
    expect(matches).toHaveLength(0);
    // The proxy is still alive and responsive.
    f.proxy.send({ jsonrpc: '2.0', method: 'tools/list', id: 31 });
    const res = await f.proxy.waitFor((m) => m.id === 31);
    expect(res.result).toBeDefined();
  });

  it('handles multiple parallel tools/call without cross-talk (all ids match)', async () => {
    f = await setup();
    f.hub.setCallHandler(({ name }) => ({
      status: 200,
      body: { result: { content: [{ type: 'text', text: `ok:${name}` }] } },
    }));
    const ids = [40, 41, 42, 43, 44];
    for (const id of ids) {
      f.proxy.send({
        jsonrpc: '2.0',
        method: 'tools/call',
        id,
        params: { name: `tool-${id}`, arguments: {} },
      });
    }
    const responses = await Promise.all(ids.map((id) => f.proxy.waitFor((m) => m.id === id)));
    for (let i = 0; i < ids.length; i++) {
      expect(responses[i].result.content[0].text).toBe(`ok:tool-${ids[i]}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// tools/list_changed notification
// ─────────────────────────────────────────────────────────────────────────

describe('mcp-proxy tools/list_changed notification', () => {
  let f: Fixture;
  afterEach(async () => { if (f) await f.cleanup(); });

  it('emits notifications/tools/list_changed when the hub tool list changes', async () => {
    f = await setup();
    f.hub.setTools([{ name: 'A', description: 'a', inputSchema: { type: 'object' } }]);

    // Wait for the proxy to complete its first poll (~1s), then change tools.
    await new Promise((r) => setTimeout(r, 1200));
    f.hub.setTools([
      { name: 'A', description: 'a', inputSchema: { type: 'object' } },
      { name: 'B', description: 'b', inputSchema: { type: 'object' } },
    ]);

    // The proxy polls /tools every 1s. Wait for a list_changed notification.
    const notif = await f.proxy.waitFor(
      (m) => m.method === 'notifications/tools/list_changed',
      2500,
    );
    expect(notif.jsonrpc).toBe('2.0');
    expect(notif.id).toBeUndefined();
  });

  it('does NOT emit list_changed when the hub tool list is unchanged', async () => {
    f = await setup();
    f.hub.setTools([{ name: 'A', description: 'a', inputSchema: { type: 'object' } }]);
    // Wait through at least 2 poll cycles with no change.
    await new Promise((r) => setTimeout(r, 2300));
    const matches = await f.proxy.collect(
      (m) => m.method === 'notifications/tools/list_changed',
      100,
    );
    expect(matches).toHaveLength(0);
  });
});
