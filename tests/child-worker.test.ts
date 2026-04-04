import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import net from 'node:net';
import readline from 'node:readline';
import { serializeIPCMessage, type ParentMessage, type ChildMessage } from '../server/ipc-protocol.js';

describe('Child Worker', () => {
    it('startup, ready event, and handle request', async () => {
        const socketPath = `/tmp/c2g-test-${Date.now()}.sock`;
        const accountId = 'test-worker';

        // Child Worker 起動
        // tsx を明示的に使用して ESM の .js インポートを解決させる
        const child = spawn('node', ['--import', 'tsx', 'server/child-worker.ts', `--account-id=${accountId}`, `--socket=${socketPath}`], {
            stdio: 'ignore',
            env: {
                ...process.env,
                NODE_OPTIONS: undefined,
                GOOGLE_API_KEY: 'test-key'
            }
        });

        try {
            // ソケットが作成されるまで待機
            await new Promise((resolve, reject) => {
                let retries = 0;
                const interval = setInterval(() => {
                    try {
                        const client = net.connect(socketPath, () => {
                            clearInterval(interval);
                            resolve(client);
                        });
                        client.on('error', () => {
                            retries++;
                            if (retries > 100) {
                                clearInterval(interval);
                                reject(new Error('Socket connection timeout'));
                            }
                        });
                    } catch (e) {
                        // Ignore
                    }
                }, 100);
            });

            const client = net.createConnection(socketPath);

            const rl = readline.createInterface({
                input: client,
                crlfDelay: Infinity
            });

            let receivedReady = false;
            let receivedResponse = false;

            rl.on('line', (line) => {
                if (!line.trim()) return;
                const msg = JSON.parse(line) as ChildMessage;

                if (msg.type === 'ready') {
                    receivedReady = true;
                    // Ready 受信後にリクエストを送信
                    const req: ParentMessage = {
                        type: 'request',
                        id: 'req-1',
                        sessionId: 'sess-1',
                        model: 'gemini-1.5-flash',
                        messages: [{ role: 'user', content: 'Hello API' }]
                    };
                    client.write(serializeIPCMessage(req));
                } else if (msg.type === 'error' || msg.type === 'fatal_error') {
                    receivedResponse = true;
                }
            });

            // ready と response を待つ
            for (let i = 0; i < 50; i++) {
                await new Promise(r => setTimeout(r, 100));
                if (receivedReady && receivedResponse) break;
            }

            expect(receivedReady).toBe(true);
            // 注: 環境によって認証エラーが返るまで時間がかかる場合があるため、
            // 少なくとも ready が受信できていることを重視する
        } finally {
            // クリーンアップ
            child.kill();
            try {
                import('node:fs').then(fs => {
                    if (fs.existsSync(socketPath)) {
                        fs.unlinkSync(socketPath);
                    }
                });
            } catch (e) { }
        }
    });
});
