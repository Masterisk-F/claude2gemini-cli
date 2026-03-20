/**
 * ツール実行のセッション管理ストア
 *
 * Claude API クライアントが `tool_use` を受け取り、
 * 後続の `tool_result` リクエストを送ってくるまでの間、
 * Gemini Agent を一時停止させる Promise の resolve 関数を保持する。
 * また、Gemini のステートフルな AsyncGenerator を保持し、
 * 次の HTTP リクエストでストリーム出力を再開できるようにする。
 */

import type { ServerGeminiStreamEvent } from '@google/gemini-cli-core';

export interface PendingToolCall {
  toolCallId: string;
  name: string;
  params: unknown;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export interface SessionData {
  stream?: AsyncGenerator<ServerGeminiStreamEvent, any, any>;
  pendingNext?: Promise<IteratorResult<ServerGeminiStreamEvent, any>>;
  pendingToolCalls: Map<string, PendingToolCall>; // toolCallId -> PendingToolCall
}

class SessionStore {
  // toolCallId -> sessionId のマッピング (ステートレスなリクエストからの復元用)
  private toolCallToSessionId = new Map<string, string>();
  
  // sessionId -> SessionData
  private store = new Map<string, SessionData>();

  getSession(sessionId: string): SessionData | undefined {
    return this.store.get(sessionId);
  }

  getOrCreateSession(sessionId: string): SessionData {
    let session = this.store.get(sessionId);
    if (!session) {
      session = {
        pendingToolCalls: new Map(),
      };
      this.store.set(sessionId, session);
    }
    return session;
  }

  setStream(sessionId: string, stream: AsyncGenerator<ServerGeminiStreamEvent, any, any>): void {
    const session = this.getOrCreateSession(sessionId);
    session.stream = stream;
  }

  addPendingToolCall(sessionId: string, pendingCall: PendingToolCall): void {
    const session = this.getOrCreateSession(sessionId);
    session.pendingToolCalls.set(pendingCall.toolCallId, pendingCall);
    this.toolCallToSessionId.set(pendingCall.toolCallId, sessionId);
  }

  getSessionIdForToolCall(toolCallId: string): string | undefined {
    return this.toolCallToSessionId.get(toolCallId);
  }

  resolveToolCall(toolCallId: string, result: unknown): string | undefined {
    const sessionId = this.toolCallToSessionId.get(toolCallId);
    if (!sessionId) {
      return undefined;
    }

    const session = this.store.get(sessionId);
    if (!session) return undefined;

    const pendingCall = session.pendingToolCalls.get(toolCallId);
    if (!pendingCall) return undefined;

    pendingCall.resolve(result);
    session.pendingToolCalls.delete(toolCallId);
    this.toolCallToSessionId.delete(toolCallId);
    return sessionId;
  }

  deleteSession(sessionId: string): void {
    const session = this.store.get(sessionId);
    if (session) {
      for (const [toolCallId, call] of session.pendingToolCalls.entries()) {
        call.reject(new Error('Session closed'));
        this.toolCallToSessionId.delete(toolCallId);
      }
      this.store.delete(sessionId);
    }
  }
}

export const sessionStore = new SessionStore();

