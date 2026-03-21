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
          if (toolState.registeredClientTools >= toolState.expectedClientTools && toolState.resolveToolTurn) {
            toolState.resolveToolTurn();
          }
        });
      }
    );
  });

  return new GeminiCliAgent({
    instructions: options.instructions || 'You are a helpful assistant.',
    model: options.model,
    cwd: options.cwd || process.cwd(),
    tools: sdkTools,
  });
}

/**
 * Gemini にプロンプトを送信し、ストリームを直接返す（ストリーミング用）
 * 既存のセッションがあれば再開する。
 */
export function sendPromptStream(
  prompt: string,
  options: GeminiBackendOptions = {},
): {
  stream: AsyncGenerator<ServerGeminiStreamEvent, any, any>;
  toolState: ToolState;
  sessionId: string;
} {
  const sessionId = options.sessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const toolState: ToolState = { callIds: new Map(), expectedClientTools: 0, registeredClientTools: 0 };

  // 既存セッションが存在し、ストリームが保持されていれば再利用 (+ tool_result が送信された後)
  const session = sessionStore.getSession(sessionId);
  if (session && session.stream) {
    // ツール使用完了後の再開フローでは、新しいプロンプトは送信せず既存ストリームを消費する
    return { stream: session.stream, toolState, sessionId };
  }

  // 新規またはセッション情報なしの場合は新規 Agent を作成して送信
  const agent = createAgent(options, toolState, sessionId);
  const geminiSession = agent.session();
  const stream = geminiSession.sendStream(prompt);
  
  sessionStore.setStream(sessionId, stream);

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
  const { stream, toolState, sessionId } = sendPromptStream(prompt, options);

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

