"""Tool bridge: create Antigravity tool stubs that interact with SessionStore."""

import json
import logging
import secrets
from typing import Any, Callable, Optional

from claude2gemini.session_store import Session

logger = logging.getLogger(__name__)

TOOL_TIMEOUT = 60.0  # seconds


def _make_stub(session: Session, name: str):
    """Create an async stub for a tool that emits tool calls via the session."""

    async def stub(**kwargs: Any) -> str:
        call_id = f"toolu_{secrets.token_hex(12)}"
        session.create_tool_future(call_id, name, kwargs)
        logger.debug("Tool stub created: %s (id=%s, args=%s)", name, call_id, kwargs)
        return json.dumps({"__pending": True, "call_id": call_id})

    return stub


class ToolBridge:
    """Builds tool registrations for Antigravity Agent from Claude tool definitions."""

    def build_tools(
        self,
        session: Session,
        tool_defs: Optional[list[dict]],
    ) -> list[tuple[str, str, Optional[dict], Callable]]:
        """Convert Claude tool definitions to Antigravity-compatible registrations.

        Returns a list of (name, description, input_schema, callable) tuples.
        """
        if not tool_defs:
            return []

        result: list[tuple[str, str, Optional[dict], Callable]] = []
        for td in tool_defs:
            if not isinstance(td, dict):
                continue
            name = td.get("name", "unknown_tool")
            description = td.get("description", "")
            input_schema = td.get("input_schema")
            # Skip tools with type starting with "web_search_"
            tool_type = td.get("type") or ""
            if tool_type.startswith("web_search_"):
                continue
            result.append((name, description, input_schema, _make_stub(session, name)))

        return result
