import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import net from 'node:net';
import readline from 'node:readline';
import { serializeIPCMessage, type ParentMessage, type ChildMessage } from '../server/ipc-protocol.js';

test('Child Worker: startup, ready event, and handle request', async () => {
    const socketPath = `/tmp/c2g-test-${Date.now()}.sock`;
    const accountId = 'test-worker';

    // Child Worker 起動
    const child = spawn('npx', ['tsx', 'server/child-worker.ts', `--account-id=${accountId}`, `--socket=${socketPath}`], {
        stdio: 'ignore'
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

        const messages: ChildMessage[] = [];

        rl.on('line', (line) => {
            if (!line.trim()) return;
            const msg = JSON.parse(line) as ChildMessage;
            messages.push(msg);

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
            } else if (msg.type === 'error') {
                // credential がないため、認証エラーなどが返るはず
                receivedResponse = true;
            }
        });

        // 最大10秒間、ready と response を待つ
        await new Promise((resolve) => setTimeout(resolve, 10000));

        assert.strictEqual(receivedReady, true, 'Did not receive ready event from child worker');
        assert.strictEqual(receivedResponse, true, 'Did not receive error response for invalid credentials from child worker');
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
