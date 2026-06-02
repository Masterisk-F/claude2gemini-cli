import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import http from 'http';
import readline from 'readline';

describe('mcp-proxy timeout', () => {
  it('should return 24 hours timeout message when call times out', async () => {
    // 1. Create a slow HTTP mock server that doesn't respond quickly
    const server = http.createServer((req, res) => {
      // Don't respond to keep connection open and force timeout
    });

    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          resolve(address.port);
        } else {
          resolve(0);
        }
      });
    });

    // 2. Spawn mcp-proxy.mjs with short timeout environment variable
    const mcpProxyPath = new URL('../server/mcp-proxy.mjs', import.meta.url).pathname;
    const proxyProcess = spawn('node', [mcpProxyPath, '--hub-port', port.toString()], {
      env: {
        ...process.env,
        MCP_PROXY_TIMEOUT_MS: '50', // 50ms timeout
      },
    });

    // 3. Read output from proxyProcess stdout
    const rl = readline.createInterface({
      input: proxyProcess.stdout,
    });

    const responsePromise = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for mcp-proxy output'));
      }, 5000);

      rl.on('line', (line) => {
        try {
          const parsed = JSON.parse(line);
          // Only resolve if it matches our expected JSON-RPC response format for tools/call
          if (parsed.id === 1) {
            clearTimeout(timeout);
            resolve(parsed);
          }
        } catch (e) {
          // ignore invalid JSON or log messages
        }
      });
    });

    // Send initialize first
    proxyProcess.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      id: 0,
      params: { protocolVersion: '2024-11-05' }
    }) + '\n');

    // Send tools/call
    proxyProcess.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      id: 1,
      params: {
        name: 'dummy-tool',
        arguments: {}
      }
    }) + '\n');

    const response = await responsePromise;

    // Clean up
    rl.close();
    proxyProcess.kill();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    // Verify error response
    expect(response).toBeDefined();
    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe(1);
    expect(response.error).toBeDefined();
    expect(response.error.code).toBe(-32001);
    expect(response.error.message).toBe('tool call timed out after 24 hours');
  });
});
