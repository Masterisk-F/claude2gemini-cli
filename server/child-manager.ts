import { fork, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import { serializeIPCMessage, type ParentMessage, type ChildMessage } from './ipc-protocol.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ext = path.extname(url.fileURLToPath(import.meta.url)); // .ts or .js
const CHILD_WORKER_SCRIPT = path.join(__dirname, `child-worker${ext}`);

interface ChildConnection {
    process: ChildProcess;
    socket: net.Socket;
    rl: readline.Interface;
    ready: Promise<void>;
}

class ChildManager extends EventEmitter {
    private children = new Map<string, ChildConnection>();

    /**
     * 単一のアカウントIDに対する子プロセスとソケット接続を確立する
     */
    async spawnChild(accountId: string): Promise<void> {
        if (this.children.has(accountId)) {
            return;
        }

        const socketPath = path.join(os.tmpdir(), `c2g-worker-${os.userInfo().username}-${accountId}.sock`);

        // 子プロセスを起動 (tsx 環境であれば自動的に引き継がれる)
        const child = fork(CHILD_WORKER_SCRIPT, [
            `--account-id=${accountId}`,
            `--socket=${socketPath}`
        ], {
            // 標準出力・標準エラー出力を親プロセスに引き継ぐ
            stdio: ['ignore', 'inherit', 'inherit', 'ipc']
        });

        child.on('exit', (code) => {
            console.error(`[ChildManager] Child worker for ${accountId} exited with code ${code}.`);
            this.children.delete(accountId);
            this.emit('child_exit', accountId);
        });

        let resolveReady: () => void;
        let rejectReady: (err: Error) => void;
        const readyPromise = new Promise<void>((resolve, reject) => {
            resolveReady = resolve;
            rejectReady = reject;
        });

        // ソケットへの接続を試行 (一定間隔でリトライ)
        const connectToSocket = async () => {
            let retries = 0;
            const maxRetries = 100; // 10秒

            while (retries < maxRetries) {
                try {
                    const socket = await new Promise<net.Socket>((resolve, reject) => {
                        const client = net.createConnection(socketPath, () => {
                            resolve(client);
                        });
                        client.on('error', reject);
                    });

                    // 接続成功
                    const rl = readline.createInterface({
                        input: socket,
                        crlfDelay: Infinity
                    });

                    rl.on('line', (line) => {
                        if (!line.trim()) return;
                        try {
                            const msg = JSON.parse(line) as ChildMessage;
                            if (msg.type === 'ready') {
                                resolveReady();
                            } else {
                                this.emit(`message:${accountId}`, msg);
                            }
                        } catch (err) {
                            console.error(`[ChildManager] Parse error from ${accountId}:`, err);
                        }
                    });

                    socket.on('error', (err) => {
                        console.error(`[ChildManager] Socket error for ${accountId}:`, err);
                    });

                    socket.on('close', () => {
                        console.error(`[ChildManager] Socket closed for ${accountId}`);
                    });

                    this.children.set(accountId, {
                        process: child,
                        socket,
                        rl,
                        ready: readyPromise
                    });

                    return;

                } catch (err) {
                    retries++;
                    await new Promise((resume) => setTimeout(resume, 100)); // 100ms待機してリトライ
                }
            }

            rejectReady(new Error(`[ChildManager] Failed to connect to socket for ${accountId} after 100 retries`));
        };

        connectToSocket().catch((err) => {
            console.error(err);
            child.kill();
        });

        await readyPromise;
        console.log(`[ChildManager] Connection established for ${accountId}`);
    }

    /**
     * 複数アカウントのプロセスを一括起動
     */
    async spawnAll(accountIds: string[]): Promise<void> {
        const promises = accountIds.map(id => this.spawnChild(id));
        await Promise.all(promises);
    }

    /**
     * 指定したアカウントの子プロセスへメッセージを送信する
     */
    async sendRequest(accountId: string, message: ParentMessage): Promise<void> {
        const conn = this.children.get(accountId);
        if (!conn) {
            throw new Error(`[ChildManager] Child process for ${accountId} is not running`);
        }

        await conn.ready;

        return new Promise((resolve, reject) => {
            const payload = serializeIPCMessage(message);
            conn.socket.write(payload, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    /**
     * 子プロセスからのメッセージを受信するイベントリスナーを登録
     */
    onMessage(accountId: string, handler: (msg: ChildMessage) => void): (() => void) {
        const eventName = `message:${accountId}`;
        this.on(eventName, handler);
        return () => this.off(eventName, handler);
    }

    /**
     * プロセスを終了する
     */
    killAll(): void {
        for (const [accountId, conn] of this.children.entries()) {
            conn.socket.end();
            conn.process.kill();
        }
        this.children.clear();
    }
}

export const childManager = new ChildManager();
