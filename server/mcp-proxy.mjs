#!/usr/bin/env node

process.on('SIGTERM', () => {
  process.exit(0);
});

process.on('SIGINT', () => {
  process.exit(0);
});

/**
 * MCP stdio-to-HTTP proxy for Antigravity Language Server.
 *
 * Runs as a child process of the LS. Relays MCP JSON-RPC messages
 * (tools/list, tools/call) to the McpHub internal HTTP server.
 *
 * Usage: node mcp-proxy.mjs --hub-port <PORT>
 *
 * stdin/stdout: MCP JSON-RPC 2.0 (Newline-delimited JSON transport)
 */

import readline from 'readline';

// ── Configuration ──────────────────────────────────────────────────────────

const hubPort = parseInt(
  process.argv[process.argv.indexOf('--hub-port') + 1] ?? '',
  10,
);
if (!hubPort || Number.isNaN(hubPort)) {
  process.stderr.write('[mcp-proxy] ERROR: --hub-port <PORT> is required\n');
  process.exit(1);
}

const HUB_BASE = `http://127.0.0.1:${hubPort}`;
const CALL_TIMEOUT_MS = process.env.MCP_PROXY_TIMEOUT_MS
  ? parseInt(process.env.MCP_PROXY_TIMEOUT_MS, 10)
  : 24 * 60 * 60 * 1000; // 24 hours

// ── Output ─────────────────────────────────────────────────────────────────

function sendMessage(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

// ── HTTP relay ─────────────────────────────────────────────────────────────

async function handleToolsList(requestId) {
  try {
    const resp = await fetch(`${HUB_BASE}/tools`);
    if (!resp.ok) {
      const text = await resp.text();
      sendMessage({
        jsonrpc: '2.0',
        id: requestId,
        error: { code: -32000, message: `hub error: ${resp.status} ${text}` },
      });
      return;
    }
    const data = await resp.json();
    sendMessage({
      jsonrpc: '2.0',
      id: requestId,
      result: { tools: data.tools ?? [] },
    });
  } catch (err) {
    sendMessage({
      jsonrpc: '2.0',
      id: requestId,
      error: { code: -32000, message: `hub unreachable: ${err.message}` },
    });
  }
}

async function handleToolsCall(requestId, params) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);

    const resp = await fetch(`${HUB_BASE}/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: params.name,
        arguments: params.arguments ?? {},
        _meta: params._meta,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      const text = await resp.text();
      sendMessage({
        jsonrpc: '2.0',
        id: requestId,
        error: { code: -32000, message: `hub call error: ${resp.status} ${text}` },
      });
      return;
    }

    const data = await resp.json();
    sendMessage({
      jsonrpc: '2.0',
      id: requestId,
      result: data.result ?? data,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      sendMessage({
        jsonrpc: '2.0',
        id: requestId,
        error: {
          code: -32001,
          message: 'tool call timed out after 24 hours',
        },
      });
    } else {
      sendMessage({
        jsonrpc: '2.0',
        id: requestId,
        error: { code: -32000, message: `hub unreachable: ${err.message}` },
      });
    }
  }
}

// ── Message Handler ────────────────────────────────────────────────────────

async function handleMessage(msg) {
  const { method, id, params } = msg;

  // notifications (no id) are silently ignored or logged
  if (id === undefined || id === null) {
    return;
  }

  switch (method) {
    case 'initialize':
      sendMessage({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2024-11-05',
          capabilities: {
            tools: {
              listChanged: true
            }
          },
          serverInfo: {
            name: 'claude2gemini-mcp-proxy',
            version: '0.6.0'
          }
        }
      });
      break;
    case 'tools/list':
      await handleToolsList(id);
      break;
    case 'tools/call':
      await handleToolsCall(id, params);
      break;
    default:
      sendMessage({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
      break;
  }
}

// ── Main loop ──────────────────────────────────────────────────────────────

function main() {
  process.stderr.write(`[mcp-proxy] started, hub on ${hubPort}\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      handleMessage(msg).catch((err) => {
        process.stderr.write(`[mcp-proxy] handler error: ${err.stack}\n`);
      });
    } catch (e) {
      process.stderr.write(`[mcp-proxy] ERROR: invalid JSON: ${line}\n`);
    }
  });

  rl.on('close', () => {
    process.stderr.write('[mcp-proxy] stdin closed, exiting\n');
    process.exit(0);
  });

  // Poll McpHub for tool changes and notify LS via notifications/tools/list_changed
  let lastToolsHash = '';
  const pollTimer = setInterval(async () => {
    try {
      const resp = await fetch(`${HUB_BASE}/tools`);
      if (resp.ok) {
        const data = await resp.json();
        const hash = JSON.stringify(data.tools ?? []);
        if (lastToolsHash && lastToolsHash !== hash) {
          sendMessage({
            jsonrpc: '2.0',
            method: 'notifications/tools/list_changed',
          });
        }
        lastToolsHash = hash;
      }
    } catch (err) {
      // ignore
    }
  }, 1000);
  if (pollTimer.unref) {
    pollTimer.unref();
  }
}

main();
