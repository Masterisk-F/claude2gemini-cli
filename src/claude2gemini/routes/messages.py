"""POST /v1/messages route handler."""

import json
import logging
import time
from typing import Any, Optional
from uuid import uuid4

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from starlette.responses import StreamingResponse

from claude2gemini.account_pool import account_pool
from claude2gemini.converters.request import (
    convert_messages_to_prompt,
    extract_system_prompt,
    map_model_name,
    normalize_tool_result_content,
)
from claude2gemini.converters.stream import stream_antigravity_to_claude_sse
from claude2gemini.session_store import session_store
from claude2gemini.tool_bridge import ToolBridge
from claude2gemini.types import (
    ClaudeMessage,
    ClaudeRequest,
    ClaudeResponse,
    ClaudeTextBlock,
    ClaudeToolUseBlock,
    ClaudeUsage,
)

router = APIRouter()
logger = logging.getLogger(__name__)
tool_bridge = ToolBridge()


class GeminiApiError(Exception):
    """Error from the Gemini API with optional HTTP status code."""

    def __init__(self, message: str, status_code: Optional[int] = None):
        super().__init__(message)
        self.status_code = status_code


def classify_error(error: Exception) -> tuple[int, str, str]:
    """Classify an error into Claude API-compatible error response.

    Returns (status_code, error_type, client_message).
    """
    error_msg = str(error)

    # GeminiApiError with specific status
    if isinstance(error, GeminiApiError):
        status = error.status_code or 500
        msg = f"Gemini API error: {error_msg}"
        if status == 400:
            return 400, "invalid_request_error", msg
        if status in (401, 403):
            return status, "authentication_error", f"Gemini API auth error: {error_msg}"
        if status == 404:
            return 404, "not_found_error", msg
        if status == 429:
            return 500, "overloaded_error", msg
        return status if status >= 500 else 500, "api_error", msg

    # Rate limit / quota checks
    err_name = getattr(error, "name", "")
    err_status = getattr(error, "status_code", 0) or getattr(error, "status", 0)

    is_rate_limit = (
        "QUOTA_EXHAUSTED" in error_msg
        or "RESOURCE_EXHAUSTED" in error_msg
        or err_status == 429
        or err_name == "TerminalQuotaError"
    )

    if is_rate_limit:
        return 500, "overloaded_error", "Gemini API quota exhausted or rate limit exceeded."

    return 500, "api_error", f"Internal server error: {error_msg}"


def _normalize_content(
    content: Any,
) -> tuple[list[dict], list[dict], Optional[str], bool]:
    """Analyze the last message content.

    Returns (tool_results, text_blocks, resolved_session_id, is_resuming).
    """
    if not isinstance(content, list):
        return [], [], None, False

    tool_results = []
    text_blocks = []
    for block in content:
        if isinstance(block, dict):
            bt = block.get("type", "")
            if bt == "tool_result":
                tool_results.append(block)
            elif bt == "text":
                text_blocks.append(block)

    if not tool_results:
        return [], [], None, False

    # Try to resolve session from first tool_result
    resolved_id = None
    for tr in tool_results:
        tid = tr.get("tool_use_id", "")
        sid = session_store.resolve_session(tid)
        if sid:
            resolved_id = sid
            break

    if text_blocks:
        # Mixed: text + tool_result → don't resume
        return tool_results, text_blocks, resolved_id, False

    return tool_results, [], resolved_id, True


def _build_error_body(error_type: str, message: str) -> dict:
    return {
        "type": "error",
        "error": {"type": error_type, "message": message},
    }


@router.post("/v1/messages")
async def handle_messages(body: dict):
    """Handle POST /v1/messages (Claude Messages API compatible)."""
    try:
        # Validate
        if not body.get("messages") or not isinstance(body["messages"], list) or len(body["messages"]) == 0:
            return _error_response(400, "invalid_request_error", "messages are required")

        if not body.get("model") or not isinstance(body["model"], str):
            return _error_response(400, "invalid_request_error", "model is required")

        # Classify request
        last_msg = body["messages"][-1]
        tool_results, text_blocks, resolved_id, is_resuming = _normalize_content(
            last_msg.get("content", [])
        )

        # Handle mixed tool_result+text: cancel session, start fresh
        if tool_results and text_blocks and resolved_id:
            session_data = await session_store.get(resolved_id)
            if session_data:
                logger.info("Mixed tool_result+text - cancelling session %s", resolved_id)
                session_data.cancel_all_pending()
                await session_store.delete(resolved_id)
            resolved_id = None
            is_resuming = False

        # Select account
        account = account_pool.next()
        if account is None:
            return _error_response(500, "api_error", "No accounts available")

        account_id = account.get("id", "default") if isinstance(account, dict) else "default"

        # Get or create session
        if resolved_id:
            session_id = resolved_id
            session = await session_store.get(session_id)
            if session is None:
                session = await session_store.get_or_create(session_id, account_id)
        else:
            session_id = f"session_{int(time.time() * 1000)}_{uuid4().hex[:6]}"
            session = await session_store.get_or_create(session_id, account_id)

        # Convert messages to prompt
        converted = await convert_messages_to_prompt(body["messages"])

        model = map_model_name(body["model"])
        stream_mode = body.get("stream", False)
        allowed_tool_names = [t.get("name", "") for t in (body.get("tools") or [])]

        if stream_mode:
            return await _handle_streaming(body, converted, model, session_id, allowed_tool_names, session)
        else:
            return await _handle_non_streaming(body, converted, model, session_id, allowed_tool_names, session)

    except Exception as exc:
        logger.error("Request error: %s", exc)
        status_code, error_type, client_msg = classify_error(exc)
        return _error_response(status_code, error_type, client_msg)


async def _handle_streaming(
    body: dict,
    converted: Any,
    model: str,
    session_id: str,
    allowed_tool_names: list[str],
    session: Any,
) -> StreamingResponse:
    """Handle streaming request using SSE."""
    async def event_stream():
        # This is a simplified stub - real Antigravity integration would happen here
        # For now, yield a basic SSE stream
        yield "event: ping\ndata: {\"type\": \"ping\"}\n\n"
        yield f"event: message_start\ndata: {json.dumps({'type': 'message_start', 'message': {'id': f'msg_{uuid4().hex[:24]}', 'type': 'message', 'role': 'assistant', 'content': [], 'model': body.get('model', ''), 'stop_reason': None, 'stop_sequence': None, 'usage': {'input_tokens': 0, 'output_tokens': 0}}})}\n\n"
        yield "event: message_stop\ndata: {\"type\": \"message_stop\"}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )


async def _handle_non_streaming(
    body: dict,
    converted: Any,
    model: str,
    session_id: str,
    allowed_tool_names: list[str],
    session: Any,
) -> dict:
    """Handle non-streaming request."""
    # Simplified stub - would call Antigravity agent here
    return ClaudeResponse(
        id=f"msg_{uuid4().hex[:24]}",
        content=[ClaudeTextBlock(text=f"Response to: {converted.prompt[:100]}...")],
        model=body.get("model", ""),
        stop_reason="end_turn",
        usage=ClaudeUsage(input_tokens=0, output_tokens=0),
    ).model_dump(exclude_none=True)


def _error_response(status: int, error_type: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content=_build_error_body(error_type, message),
    )
