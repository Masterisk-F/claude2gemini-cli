import { test, expect } from 'vitest';
import { spawn } from 'node:child_process';
import net from 'node:net';
import readline from 'node:readline';
import { serializeIPCMessage, type ParentMessage, type ChildMessage } from '../server/ipc-protocol.js';

test('Child Worker: startup, ready event, and handle request', async () => {
    const socketPath = `/tmp/c2g-test-${Date.now()}.sock`;
    const accountId = 'test-worker';

    // Child Worker 起動
    const child = spawn('./node_modules/.bin/tsx', ['server/child-worker.ts', `--account-id=${accountId}`, `--socket=${socketPath}`], {
        stdio: 'inherit'
    });

    try {
        let client: net.Socket | null = null;
        let receivedReady = false;
        let receivedResponse = false;
        const messages: ChildMessage[] = [];

        // ソケットが作成されるまでリトライしながら接続
        const connect = async () => {
            for (let i = 0; i < 100; i++) {
                try {
                    return await new Promise<net.Socket>((resolve, reject) => {
                        const s = net.connect(socketPath);
                        s.on('connect', () => resolve(s));
                        s.on('error', reject);
                    });
                } catch (e) {
                    await new Promise(r => setTimeout(r, 100));
                }
            }
            throw new Error('Socket connection timeout after 100 retries');
        };

        client = await connect();
        const rl = readline.createInterface({
            input: client,
            crlfDelay: Infinity
        });

        rl.on('line', (line) => {
            if (!line.trim()) return;
            const msg = JSON.parse(line) as ChildMessage;
            messages.push(msg);

            if (msg.type === 'ready') {
                receivedReady = true;
                const req: ParentMessage = {
                    type: 'request',
                    id: 'req-1',
                    sessionId: 'sess-1',
                    model: 'gemini-1.5-flash',
                    messages: [{ role: 'user', content: 'Hello API' }]
                };
                client?.write(serializeIPCMessage(req));
            } else if (msg.type === 'error') {
                receivedResponse = true;
            }
        });

        // ready と response を待つ
        const startTime = Date.now();
        while (!(receivedReady && receivedResponse) && Date.now() - startTime < 15000) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        expect(receivedReady).toBe(true);
        expect(receivedResponse).toBe(true);
    } finally {
        child.kill();
        try {
            const fs = await import('node:fs');
            if (fs.existsSync(socketPath)) {
                fs.unlinkSync(socketPath);
            }
        } catch (e) { }
    }
}, 25000);
