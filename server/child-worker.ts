import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';

// SDKがリクエストごとにAgentを生成してイベントリスナーを登録するため、
// Warningを抑制するために最大リスナー数を引き上げる
EventEmitter.defaultMaxListeners = 1000;

import { GeminiCliAgent, tool } from '@google/gemini-cli-sdk';
import type { ChildMessage, ParentMessage } from './ipc-protocol.js';
import { convertClaudeToolToZodSchema } from './converters/tool-schema.js';
import { convertMessagesToPrompt, extractSystemPrompt } from './converters/request.js';
import { buildProxyHome } from './env-setup.js';
import type { ServerGeminiStreamEvent } from '@google/gemini-cli-core';

// 引数のパーサー (--account-id=xxx --socket=/tmp/xxx)
function parseArgs() {
    const args = process.argv.slice(2);
    let accountId = 'default';
    let socketPath = '';

    for (const arg of args) {
        if (arg.startsWith('--account-id=')) {
            accountId = arg.split('=')[1] || accountId;
        } else if (arg.startsWith('--socket=')) {
            socketPath = arg.split('=')[1] || '';
        }
    }

    if (!socketPath) {
        console.error('[Child Worker] Error: --socket argument is required');
        process.exit(1);
    }

    return { accountId, socketPath };
}

const { accountId, socketPath } = parseArgs();

// アカウント専用の環境変数をセットアップ
const proxyHome = buildProxyHome(accountId);
process.env['GEMINI_CLI_HOME'] = proxyHome;
process.env.GEMINI_SYSTEM_MD = path.join(proxyHome, '.gemini', 'system.md');

console.log(`[Child Worker ${accountId}] Started with proxyHome: ${proxyHome}`);

// --- セッション状態管理 ---
interface ToolState {
    callIds: Map<string, string[]>;
    resolveToolTurn?: () => void;
    expectedClientTools: number;
    registeredClientTools: number;
}

interface PendingToolCall {
    toolCallId: string;
    name: string;
    params: unknown;
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
}

interface SessionData {
    stream?: AsyncGenerator<ServerGeminiStreamEvent, any, any>;
    pendingNext?: Promise<IteratorResult<ServerGeminiStreamEvent, any>>;
    pendingToolCalls: Map<string, PendingToolCall>;
    toolState?: ToolState;
    lastUsage?: {
        input_tokens: number;
        output_tokens: number;
    };
}

const sessionStore = new Map<string, SessionData>();

function getOrCreateSession(sessionId: string): SessionData {
    let session = sessionStore.get(sessionId);
    if (!session) {
        session = { pendingToolCalls: new Map() };
        sessionStore.set(sessionId, session);
    }
    return session;
}

// --- SDK操作ヘルパー ---

let initMutex: Promise<void> = Promise.resolve();

async function initializeSessionLocally(
    session: any,
    allowedToolNames: string[]
): Promise<void> {
    const prevMutex = initMutex;
    let releaseMutex: () => void;
    initMutex = new Promise<void>(resolve => { releaseMutex = resolve; });
    await prevMutex;

    try {
        await session.initialize();
    } finally {
        releaseMutex!();
    }

    // 組み込みツールの無効化パッチ適用
    disableBuiltinTools(session, allowedToolNames);
}

function disableBuiltinTools(session: any, allowedToolNames: string[]) {
    const config = session.config;
    if (config && config.toolRegistry) {
        const registry = config.toolRegistry;
        const allTools = [...registry.getAllToolNames()];
        for (const name of allTools) {
            if (!allowedToolNames.includes(name)) {
                registry.unregisterTool(name);
            }
        }
    }

    try {
        const client = session.client;
        if (client) {
            const generator = client.getContentGeneratorOrFail();
            if (generator && !generator.__proxyPatched) {
                const removeEmptyTools = (params: any) => {
                    if (params?.config?.tools) {
                        const tools = params.config.tools;
                        if (Array.isArray(tools) && tools.length === 1 &&
                            Array.isArray(tools[0].functionDeclarations) &&
                            tools[0].functionDeclarations.length === 0) {
                            delete params.config.tools;
                        }
                    }
                };

                const originalGenerateContentStream = generator.generateContentStream?.bind(generator);
                if (originalGenerateContentStream) {
                    generator.generateContentStream = async function* (params: any, promptId: string, role: string) {
                        removeEmptyTools(params);
                        const stream = await originalGenerateContentStream(params, promptId, role);
                        yield* stream;
                    };
                }

                const originalGenerateContent = generator.generateContent?.bind(generator);
                if (originalGenerateContent) {
                    generator.generateContent = async (params: any, promptId: string, role: string) => {
                        removeEmptyTools(params);
                        return originalGenerateContent(params, promptId, role);
                    };
                }

                generator.__proxyPatched = true;
            }
        }
    } catch (e) {
        console.error(`[Child Worker ${accountId}] Failed to patch generator`, e);
    }
}

// --- UNIX ソケットサーバの構築 ---

if (fs.existsSync(socketPath)) {
    fs.unlinkSync(socketPath);
}

const server = net.createServer((socket) => {
    console.log(`[Child Worker ${accountId}] Client connected!`);

    const rl = readline.createInterface({
        input: socket,
        crlfDelay: Infinity,
    });

    // メッセージ送信関数
    const send = (msg: ChildMessage) => {
        try {
            if (!socket.destroyed) {
                socket.write(JSON.stringify(msg) + '\n');
            }
        } catch (e) {
            console.error(`[Child Worker ${accountId}] Socket write error:`, e);
        }
    };

    rl.on('line', async (line) => {
        if (!line.trim()) return;
        try {
            const msg = JSON.parse(line) as ParentMessage;
            await handleParentMessage(msg, send);
        } catch (err) {
            console.error(`[Child Worker ${accountId}] Parse error:`, err);
            send({ type: 'error', sessionId: 'unknown', message: String(err) });
        }
    });

    socket.on('error', (err) => {
        console.error(`[Child Worker ${accountId}] Socket error:`, err);
    });

    socket.on('end', () => {
        console.log(`[Child Worker ${accountId}] Client disconnected.`);
    });

    // 接続直後に Ready を送信
    send({ type: 'ready' });
});

server.listen(socketPath, () => {
    console.log(`[Child Worker ${accountId}] Listening on socket: ${socketPath}`);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

// --- メッセージハンドリング ---

async function handleParentMessage(msg: ParentMessage, sendEvent: (msg: ChildMessage) => void) {
    if (msg.type === 'request') {
        const { sessionId, system, messages, model, tools } = msg;

        // session 再開か新規か
        const sessionData = getOrCreateSession(sessionId);

        // Prompt の構築
        let prompt = '';
        // 如果有历史记录且 sessionData.stream は存在しない場合は結合
        if (!sessionData.stream) {
            prompt = convertMessagesToPrompt(messages);
        }
        const systemPrompt = extractSystemPrompt(system);

        try {
            let stream = sessionData.stream;
            let toolState = sessionData.toolState;

            if (stream && toolState) {
                // 再利用
                toolState.callIds.clear();
                toolState.expectedClientTools = 0;
                toolState.registeredClientTools = 0;
            } else {
                // 新規作成
                toolState = { callIds: new Map(), expectedClientTools: 0, registeredClientTools: 0 };
                sessionData.toolState = toolState;

                const sdkTools = tools?.map((t) => tool(
                    {
                        name: t.name,
                        description: t.description,
                        inputSchema: convertClaudeToolToZodSchema(t),
                    },
                    async (params) => {
                        const callIds = toolState!.callIds.get(t.name);
                        const callId = callIds?.shift();
                        if (!callId) throw new Error(`callId not found for tool ${t.name}`);

                        return new Promise((resolve, reject) => {
                            sessionData.pendingToolCalls.set(callId, {
                                toolCallId: callId,
                                name: t.name,
                                params,
                                resolve,
                                reject,
                            });

                            toolState!.registeredClientTools++;
                            if (toolState!.registeredClientTools >= toolState!.expectedClientTools && toolState!.resolveToolTurn) {
                                toolState!.resolveToolTurn();
                            }
                        });
                    }
                ));

                const agent = new GeminiCliAgent({
                    instructions: systemPrompt || 'You are a helpful assistant.',
                    model: model,
                    cwd: proxyHome, // アカウントごとのHOMEを明示的に cwd に指定
                    tools: sdkTools,
                });

                const geminiSession = agent.session();
                const allowedToolNames = tools?.map(t => t.name) || [];
                await initializeSessionLocally(geminiSession, allowedToolNames);

                stream = geminiSession.sendStream(prompt);
                sessionData.stream = stream;
            }

            // ストリーム消費ループ開始
            consumeStream(stream, toolState!, sessionId, sessionData, sendEvent);

        } catch (err) {
            console.error(`[Child Worker ${accountId}] Failed to process request:`, err);
            sendEvent({ type: 'error', sessionId, message: String(err) });
        }

    } else if (msg.type === 'tool_result') {
        const { sessionId, toolCallId, result } = msg;
        const sessionData = sessionStore.get(sessionId);
        if (!sessionData) {
            console.warn(`[Child Worker ${accountId}] Session not found for tool_result: ${sessionId}`);
            return;
        }

        const pendingCall = sessionData.pendingToolCalls.get(toolCallId);
        if (pendingCall) {
            pendingCall.resolve(result);
            sessionData.pendingToolCalls.delete(toolCallId);
        } else {
            console.warn(`[Child Worker ${accountId}] Pending tool call not found: ${toolCallId}`);
        }
    } else if (msg.type === 'resume_stream') {
        const { sessionId } = msg;
        const sessionData = sessionStore.get(sessionId);
        if (!sessionData || !sessionData.stream || !sessionData.toolState) {
            console.warn(`[Child Worker ${accountId}] Cannot resume stream, session invalid: ${sessionId}`);
            return;
        }

        // ストリーム消費ループを再開
        consumeStream(sessionData.stream, sessionData.toolState, sessionId, sessionData, sendEvent);
    }
}

// ストリーム消費ループ
async function consumeStream(
    stream: AsyncGenerator<ServerGeminiStreamEvent, any, any>,
    toolState: ToolState,
    sessionId: string,
    sessionData: SessionData,
    sendEvent: (msg: ChildMessage) => void
) {
    let isToolTurnReached = false;
    let turnPromiseResolve: () => void;
    const turnPromise = new Promise<void>((resolve) => { turnPromiseResolve = resolve; });

    toolState.resolveToolTurn = () => {
        isToolTurnReached = true;
        turnPromiseResolve();
    };

    let nextPromise = sessionData.pendingNext || stream.next();
    sessionData.pendingNext = undefined;

    let hasProducedAnyBlock = false;
    let stopReason = 'end_turn';

    try {
        while (true) {
            if (isToolTurnReached) {
                sessionData.pendingNext = nextPromise;
                break;
            }

            const result = await Promise.race([nextPromise, turnPromise.then(() => 'TURN_ENDED')]);

            if (result === 'TURN_ENDED') {
                sessionData.pendingNext = nextPromise;
                break;
            }

            const iter = result as IteratorResult<any>;
            if (iter.done) {
                sessionStore.delete(sessionId);
                break; // 完全終了
            }

            const chunk = iter.value;

            if (chunk.type === 'content' && chunk.value) {
                hasProducedAnyBlock = true;
                sendEvent({ type: 'stream_event', sessionId, event: { type: 'content', value: chunk.value } });
            } else if (chunk.type === 'error') {
                const errValue = chunk.value?.error;
                sendEvent({
                    type: 'error',
                    sessionId,
                    message: errValue?.message || 'Gemini API error',
                    status: errValue?.status
                });
                return; // エラー時は関数終了
            } else if (chunk.type === 'finished') {
                const usage = chunk.value?.usageMetadata;
                if (usage) {
                    sessionData.lastUsage = {
                        input_tokens: usage.promptTokenCount || 0,
                        output_tokens: usage.candidatesTokenCount || 0,
                    };
                }
            } else if (chunk.type === 'tool_call_request') {
                const callInfo = chunk.value;
                const callId = callInfo.callId;
                const name = callInfo.name;

                toolState.expectedClientTools++;
                hasProducedAnyBlock = true;
                stopReason = 'tool_use';

                let q = toolState.callIds.get(name);
                if (!q) {
                    q = [];
                    toolState.callIds.set(name, q);
                }
                q.push(callId);

                let parsedArgs: Record<string, unknown> = {};
                if (typeof callInfo.args === 'string') {
                    try { parsedArgs = JSON.parse(callInfo.args); } catch (e) { }
                } else if (callInfo.args && typeof callInfo.args === 'object') {
                    parsedArgs = callInfo.args;
                }

                // 親プロセスへツール呼び出しを通知
                sendEvent({
                    type: 'tool_call',
                    sessionId,
                    callId,
                    name,
                    args: parsedArgs
                });
            }

            nextPromise = stream.next();
        }

        // ターン終了
        if (!hasProducedAnyBlock && !isToolTurnReached) {
            sendEvent({ type: 'error', sessionId, message: 'Gemini API returned an empty response', status: 500 });
            return;
        }

        sendEvent({
            type: 'turn_end',
            sessionId,
            stopReason,
            usage: sessionData.lastUsage,
        });

    } catch (error) {
        console.error(`[Child Worker ${accountId}] Stream loop error:`, error);
        sessionStore.delete(sessionId);
        sendEvent({
            type: 'error',
            sessionId,
            message: error instanceof Error ? error.message : String(error)
        });
    }
}
