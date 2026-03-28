interface SessionData {
  accountId: string;
}

class SessionStore {
  private sessions = new Map<string, SessionData>();
  private pendingToolCalls = new Map<string, string>();

  getSession(sessionId: string): SessionData | undefined {
    return this.sessions.get(sessionId);
  }

  getOrCreateSession(sessionId: string): SessionData {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { accountId: '' };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    for (const [callId, sId] of Array.from(this.pendingToolCalls.entries())) {
      if (sId === sessionId) {
        this.pendingToolCalls.delete(callId);
      }
    }
  }

  addPendingToolCall(sessionId: string, toolCallId: string): void {
    this.pendingToolCalls.set(toolCallId, sessionId);
  }

  resolveToolCall(toolCallId: string): string | undefined {
    const sessionId = this.pendingToolCalls.get(toolCallId);
    if (sessionId) {
      this.pendingToolCalls.delete(toolCallId);
      return sessionId;
    }
    return undefined;
  }
}

export const sessionStore = new SessionStore();
