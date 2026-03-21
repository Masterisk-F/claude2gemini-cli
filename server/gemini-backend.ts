/**
 * Gemini CLI SDK ラッパー
 *
 * GeminiCliAgent のインスタンス管理と、
 * プロンプト送信・レスポンス収集の機能を提供する。
 */

import { GeminiCliAgent, tool } from '@google/gemini-cli-sdk';
import type { GeminiCliSession } from '@google/gemini-cli-sdk';
import type { ServerGeminiStreamEvent } from '@google/gemini-cli-core';
import type { ClaudeToolDefinition, ClaudeToolUseBlock } from './types.js';
import { convertClaudeToolToZodSchema } from './converters/tool-schema.js';
import { sessionStore } from './session-store.js';

export interface GeminiBackendOptions {
  sessionId?: string;
  instructions?: string;
  model?: string;
  cwd?: string;
  tools?: ClaudeToolDefinition[];
}

export interface ToolState {
  callIds: Map<string, string[]>;
  resolveToolTurn?: () => void;
  expectedClientTools: number;
  registeredClientTools: number;
}

/**
 * GeminiCliAgent を作成する
 */
function createAgent(options: GeminiBackendOptions, toolState: ToolState, sessionId: string): GeminiCliAgent {
  const sdkTools = options.tools?.map((t) => {
    return tool(
      {
        name: t.name,
        description: t.description,
        inputSchema: convertClaudeToolToZodSchema(t),
      },
      async (params) => {
        // queue から callId を取得
        const callIds = toolState.callIds.get(t.name);
        const callId = callIds?.shift();
        if (!callId) throw new Error(`callId not found for tool ${t.name}`);

        console.log(`[ToolAction] Tool ${t.name} (${callId}) action called, registering pending call...`);

        // クライアントからの tool_result 待ち
        return new Promise((resolve, reject) => {
          sessionStore.addPendingToolCall(sessionId, {
            toolCallId: callId,
            name: t.name,
            params,
            resolve,
            reject,
          });

          // 全クライアントツールの登録完了後にストリーム停止を通知
          toolState.registeredClientTools++;
          console.log(`[ToolAction] Tool ${t.name} (${callId}) registered (${toolState.registeredClientTools}/${toolState.expectedClientTools})`);
          if (toolState.registeredClientTools >= toolState.expectedClientTools && toolState.resolveToolTurn) {
            console.log(`[ToolAction] All ${toolState.expectedClientTools} client tools registered, resolving turn`);
            toolState.resolveToolTurn();
          }
        });
      }
    );
  });

  return new GeminiCliAgent({
    instructions: options.instructions || 'You are a helpful assistant.',
    model: options.model,
    // proxy ホーム（仮想環境）を cwd とする。存在しない場合は process.cwd() をフォールバック。
    cwd: options.cwd || process.env.HOME || process.cwd(),
    tools: sdkTools,
  });
}

/**
 * GeminiCliAgent 内部の registry から、クライアント指定ツール以外の組み込みツールを消去するハック
 * さらに、もしツール配列が空になった場合、API送信時に invalid proto エラーになるため、
 * リクエスト送信直前でリクエストから tools プロパティを削除するモンキーパッチを適用する。
 */
async function disableBuiltinTools(session: GeminiCliSession, allowedToolNames: string[]) {
  // session の初期化を強制（内部で config や toolRegistry が作られる）
  await session.initialize();

  // private property へのアクセス
  const config = (session as any).config;
  if (config && config.toolRegistry) {
    const registry = config.toolRegistry;
    const allTools = [...registry.getAllToolNames()];
    for (const name of allTools) {
      if (!allowedToolNames.includes(name)) {
        console.log(`[Proxy] Unregistering built-in tool: ${name}`);
        registry.unregisterTool(name);
      }
    }
  }

  // SDK内部の生成器にモンキーパッチを当てて空の [{ functionDeclarations: [] }] を消す
  try {
    const client = (session as any).client;
    if (client) {
      const generator = client.getContentGeneratorOrFail();
      if (generator && !generator.__proxyPatched) {
        // パッチ用ヘルパー関数
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

        const originalGenerateContent = generator.generateContent?.bind(generator);
        if (originalGenerateContent) {
          generator.generateContent = async (params: any, promptId: string, role: string) => {
            removeEmptyTools(params);
            return originalGenerateContent(params, promptId, role);
          };
        }

        const originalGenerateContentStream = generator.generateContentStream?.bind(generator);
        if (originalGenerateContentStream) {
          generator.generateContentStream = async function* (params: any, promptId: string, role: string) {
            removeEmptyTools(params);
            const stream = await originalGenerateContentStream(params, promptId, role);
            yield* stream;
          };
        }

        generator.__proxyPatched = true;
      }
    }
  } catch (e) {
    console.error('[Proxy] Failed to apply monkey patch for empty tools', e);
  }
}

/**
 * Gemini にプロンプトを送信し、ストリームを直接返す（ストリーミング用）
 * 既存のセッションがあれば再開する。
 */
export async function sendPromptStream(
  prompt: string,
  options: GeminiBackendOptions = {},
): Promise<{
  stream: AsyncGenerator<ServerGeminiStreamEvent, any, any>;
  toolState: ToolState;
  sessionId: string;
}> {
  const sessionId = options.sessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  // 既存セッションが存在し、ストリームが保持されていれば再利用 (+ tool_result が送信された後)
  const session = sessionStore.getSession(sessionId);
  if (session && session.stream) {
    // 元の toolState を再利用（action クロージャと同一オブジェクトを共有するため）
    const toolState = session.toolState as ToolState;
    toolState.callIds.clear();
    toolState.expectedClientTools = 0;
    toolState.registeredClientTools = 0;
    console.log(`[sendPromptStream] Resuming session ${sessionId} with existing toolState`);
    return { stream: session.stream, toolState, sessionId };
  }

  // 新規セッション: Agent を作成して送信
  const toolState: ToolState = { callIds: new Map(), expectedClientTools: 0, registeredClientTools: 0 };
  const agent = createAgent(options, toolState, sessionId);
  const geminiSession = agent.session();
  
  // 組み込みツールの強制無効化
  const allowedToolNames = options.tools?.map((t) => t.name) || [];
  await disableBuiltinTools(geminiSession, allowedToolNames);

  const stream = geminiSession.sendStream(prompt);
  
  // toolState をセッションに保存（次ターンで再利用するため）
  const sessionData = sessionStore.getOrCreateSession(sessionId);
  sessionData.stream = stream;
  sessionData.toolState = toolState;

  return { stream, toolState, sessionId };
}

export interface NonStreamingResult {
  text: string;
  toolCalls: ClaudeToolUseBlock[];
  sessionId: string;
}

/**
 * Gemini にプロンプトを送信し、非ストリーミングで応答を返す。
 * ツール使用が発生した場合は一時停止し、toolCalls と共に返す。
 */
export async function sendPromptAndCollect(
  prompt: string,
  options: GeminiBackendOptions = {},
): Promise<NonStreamingResult> {
  const { stream, toolState, sessionId } = await sendPromptStream(prompt, options);

  let fullText = '';
  const toolCalls: ClaudeToolUseBlock[] = [];

  // ツール実行待ちを判定するための Promise
  let isToolTurnReached = false;
  let turnPromiseResolve: () => void;
  const turnPromise = new Promise<void>((resolve) => {
    turnPromiseResolve = resolve;
  });
  toolState.resolveToolTurn = () => {
    isToolTurnReached = true;
    turnPromiseResolve();
  };

  // session に pendingNext があればそこから再開する
  const sessionData = sessionStore.getOrCreateSession(sessionId);
  let nextPromise = sessionData.pendingNext || stream.next();
  sessionData.pendingNext = undefined;

  while (true) {
    if (isToolTurnReached) {
      // ツール実行フェーズに到達。nextPromise は dangling なのでストアに保持する
      sessionData.pendingNext = nextPromise;
      break;
    }

    const result = await Promise.race([nextPromise, turnPromise.then(() => 'TURN_ENDED')]);

    if (result === 'TURN_ENDED') {
      // ツール実行フェーズに到達。
      sessionData.pendingNext = nextPromise;
      break;
    }

    const iter = result as IteratorResult<ServerGeminiStreamEvent>;
    if (iter.done) {
      sessionStore.deleteSession(sessionId);
      break; // 完全に終了
    }

    const chunk = iter.value;

    if (chunk.type === 'content' && chunk.value) {
      // text は文字列 (SDK v0.36)
      fullText += chunk.value as string;
    } else if (chunk.type === 'tool_call_request') {
      const callInfo = chunk.value;
      const callId = callInfo.callId;
      const name = callInfo.name;

      const allowedToolNames = options.tools?.map((t) => t.name) || [];
      if (!allowedToolNames.includes(name)) {
        // 組み込みツールはクライアントに返さず、内部処理に任せる
        nextPromise = stream.next();
        continue;
      }

      toolState.expectedClientTools++;

      // Queue for action()
      let q = toolState.callIds.get(name);
      if (!q) {
        q = [];
        toolState.callIds.set(name, q);
      }
      q.push(callId);

      let parsedArgs: Record<string, unknown> = {};
      if (typeof callInfo.args === 'string') {
        try {
          parsedArgs = JSON.parse(callInfo.args);
        } catch (e) {
          console.warn(`Failed to parse args for ${name}`, callInfo.args);
        }
      } else if (callInfo.args && typeof callInfo.args === 'object') {
        parsedArgs = callInfo.args as Record<string, unknown>;
      }

      toolCalls.push({
        type: 'tool_use',
        id: callId,
        name: name,
        input: parsedArgs,
      });
    }

    nextPromise = stream.next();
  }

  return { text: fullText, toolCalls, sessionId };
}

