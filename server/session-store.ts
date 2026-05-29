/**
 * Session Store
 *
 * Manages conversation sessions and pending tool calls.
 * Simplified for single-account Antigravity architecture.
 */

class SessionStore {
  private pendingToolCalls = new Map<string, string>(); // toolCallId -> sessionId

  deleteSession(sessionId: string): void {
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
