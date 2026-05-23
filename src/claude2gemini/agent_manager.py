"""Agent session management using google-antigravity SDK."""

import logging
from typing import Any, Optional

from claude2gemini.session_store import Session

logger = logging.getLogger(__name__)


class AgentSessionManager:
    """Manages Antigravity Agent instances and conversation lifecycle.

    Each Claude API session maps to an Antigravity conversation_id.
    Agent instances are created per-turn and cleaned up after each response,
    since Antigravity maintains state server-side via conversation_id.
    """

    def __init__(self):
        self._sessions: dict[str, dict] = {}

    def store_conversation_id(self, session_id: str, conversation_id: str) -> None:
        """Store the Antigravity conversation_id for a session."""
        entry = self._sessions.get(session_id)
        if entry:
            entry["conversation_id"] = conversation_id
        else:
            self._sessions[session_id] = {"conversation_id": conversation_id}

    def get_conversation_id(self, session_id: str) -> Optional[str]:
        """Get stored conversation_id for a session."""
        entry = self._sessions.get(session_id)
        if entry:
            return entry.get("conversation_id")
        return None

    def remove(self, session_id: str) -> None:
        """Remove session tracking."""
        self._sessions.pop(session_id, None)

    def clear(self) -> None:
        """Remove all sessions."""
        self._sessions.clear()
