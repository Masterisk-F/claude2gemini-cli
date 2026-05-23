"""Session store with asyncio-based tool call management."""

import asyncio
import logging
from typing import Optional

logger = logging.getLogger(__name__)


class Session:
    """Holds state for a single conversation session."""

    def __init__(self, account_id: str):
        self.account_id = account_id
        self.conversation_id: Optional[str] = None
        self._pending_tool_calls: dict[str, asyncio.Future] = {}

    def create_tool_future(
        self, call_id: str, name: str, args: dict
    ) -> asyncio.Future:
        """Create a Future that will resolve when the client sends tool_result."""
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self._pending_tool_calls[call_id] = future
        return future

    def resolve_tool_call(self, call_id: str, result: str) -> bool:
        """Resolve a pending tool call Future with the given result."""
        future = self._pending_tool_calls.pop(call_id, None)
        if future is None or future.done():
            return False
        future.set_result(result)
        return True

    def cancel_all_pending(self) -> None:
        """Cancel all pending tool call futures."""
        for call_id, future in list(self._pending_tool_calls.items()):
            if not future.done():
                future.cancel()
        self._pending_tool_calls.clear()

    @property
    def has_pending_tool_calls(self) -> bool:
        return bool(self._pending_tool_calls)


class SessionStore:
    """Manages all active sessions and tool call indices."""

    def __init__(self):
        self._sessions: dict[str, Session] = {}
        self._tool_call_index: dict[str, str] = {}  # tool_call_id -> session_id
        self._lock = asyncio.Lock()

    async def get_or_create(self, session_id: str, account_id: str) -> Session:
        async with self._lock:
            if session_id not in self._sessions:
                self._sessions[session_id] = Session(account_id)
            return self._sessions[session_id]

    async def get(self, session_id: str) -> Optional[Session]:
        return self._sessions.get(session_id)

    async def delete(self, session_id: str) -> None:
        async with self._lock:
            session = self._sessions.pop(session_id, None)
            if session:
                session.cancel_all_pending()
                # Clean up tool call index entries for this session
                stale = [
                    call_id
                    for call_id, sid in list(self._tool_call_index.items())
                    if sid == session_id
                ]
                for call_id in stale:
                    del self._tool_call_index[call_id]

    def index_tool_call(self, tool_call_id: str, session_id: str) -> None:
        """Register a mapping from tool_call_id to session_id."""
        self._tool_call_index[tool_call_id] = session_id

    def resolve_session(self, tool_call_id: str) -> Optional[str]:
        """Look up session_id for a given tool_call_id, removing the entry."""
        return self._tool_call_index.pop(tool_call_id, None)

    async def resolve_tool_call(
        self, tool_call_id: str, result: str
    ) -> bool:
        """Resolve a pending tool call by tool_call_id."""
        session_id = self.resolve_session(tool_call_id)
        if session_id is None:
            logger.warning("No session found for tool_call_id %s", tool_call_id)
            return False
        session = await self.get(session_id)
        if session is None:
            return False
        return session.resolve_tool_call(tool_call_id, result)


# Module-level singleton
session_store = SessionStore()
