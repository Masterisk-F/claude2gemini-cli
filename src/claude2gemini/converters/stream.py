"""Antigravity response chunks → Claude SSE events conversion."""

import json
import logging
from typing import Any, AsyncGenerator, Optional
from uuid import uuid4

logger = logging.getLogger(__name__)


async def stream_antigravity_to_claude_sse(
    response: Any,
    model: str,
    session_id: str,
    allowed_tool_names: list[str],
    pending_citations: Optional[list[dict]] = None,
) -> AsyncGenerator[str, None]:
    """Convert Antigravity ChatResponse chunks to Claude SSE event strings."""
    message_id = f"msg_{uuid4().hex[:24]}"
    block_index = 0
    msg_started = False
    estimated_tokens = 0
    text_active = False
    has_content = False
    searches = 0
    citations: list[dict] = pending_citations or []

    def msg_ensure():
        nonlocal msg_started
        if not msg_started:
            msg_started = True
            return _sse("ping", {"type": "ping"}) + _message_start(message_id, model, estimated_tokens)
        return ""

    def close_text():
        nonlocal text_active, block_index
        if text_active:
            text_active = False
            block_index += 1
            return _content_block_stop(block_index - 1)
        return ""

    try:
        async for chunk in response.chunks:
            t = chunk.get("type", "")
            val = chunk.get("value") or chunk.get("text") or ""

            if t in ("text", "content") and val:
                out = msg_ensure()
                if not text_active:
                    out += _text_start(block_index, citations)
                    text_active = True
                    has_content = True
                    citations = []
                out += _sse("content_block_delta", {
                    "type": "content_block_delta", "index": block_index,
                    "delta": {"type": "text_delta", "text": val},
                })
                yield out

            elif t == "tool_call":
                cid = chunk.get("callId") or chunk.get("id", f"toolu_{uuid4().hex[:24]}")
                nm = chunk.get("name", "unknown")
                if nm not in allowed_tool_names:
                    continue
                out = msg_ensure() + close_text()
                out += _tool_use_events(block_index, cid, nm, chunk.get("args", {}))
                block_index += 1
                has_content = True
                yield out

            elif t == "server_tool_call":
                out = msg_ensure() + close_text()
                searches += 1
                cid = chunk.get("callId") or chunk.get("id", f"srvtoolu_{uuid4().hex[:24]}")
                nm = chunk.get("name", "web_search")
                out += _server_tool_use_events(block_index, cid, nm, chunk.get("args", {}))
                block_index += 1
                has_content = True
                yield out

            elif t == "server_tool_result":
                out = msg_ensure() + close_text()
                cid = chunk.get("callId") or chunk.get("id", "")
                result = chunk.get("result", chunk.get("value", []))
                out += _sse("content_block_start", {
                    "type": "content_block_start", "index": block_index,
                    "content_block": {"type": "web_search_tool_result", "tool_use_id": cid, "content": result},
                })
                out += _content_block_stop(block_index)
                block_index += 1
                has_content = True
                if isinstance(result, list):
                    citations.extend(result)
                yield out

            elif t == "turn_end":
                if not has_content:
                    yield _error("empty_response", "Gemini API returned an empty response")
                    yield _sse("message_stop", {"type": "message_stop"})
                    return
                out = close_text()
                usage = chunk.get("usage") or chunk.get("value", {})
                du = {
                    "input_tokens": (isinstance(usage, dict) and usage.get("input_tokens", estimated_tokens)) or estimated_tokens,
                    "output_tokens": (isinstance(usage, dict) and usage.get("output_tokens", 0)) or 0,
                    "cache_read_input_tokens": (isinstance(usage, dict) and usage.get("cache_read_input_tokens", 0)) or 0,
                    "cache_creation_input_tokens": 0,
                }
                if searches > 0:
                    du["server_tool_use"] = {"web_search_requests": searches}
                out += _sse("message_delta", {
                    "type": "message_delta",
                    "delta": {"stop_reason": chunk.get("stop_reason", "end_turn"), "stop_sequence": None},
                    "usage": du,
                })
                out += _sse("message_stop", {"type": "message_stop"})
                yield out
                return

            elif t == "error":
                yield msg_ensure() + close_text()
                raise _make_stream_error(chunk)

        if not has_content:
            yield _error("empty_response", "Gemini API returned an empty response")
            yield _sse("message_stop", {"type": "message_stop"})

    except Exception as exc:
        logger.error("Stream error: %s", exc)
        ep = json.dumps({"type": "error", "error": {"type": "api_error", "message": f"Internal server error: {exc}"}})
        yield f"event: error\ndata: {ep}\n\n"
        yield _sse("message_stop", {"type": "message_stop"})


def _text_start(index: int, citations: list[dict]) -> str:
    block: dict = {"type": "text", "text": ""}
    if citations:
        block["citations"] = [
            {"type": "web_search_result_location", "url": s.get("url", ""), "title": s.get("title", ""),
             "encrypted_index": s.get("encrypted_content", ""), "cited_text": ""}
            for s in citations
        ]
    return _sse("content_block_start", {"type": "content_block_start", "index": index, "content_block": block})


def _tool_use_events(index: int, call_id: str, name: str, args: dict) -> str:
    return (
        _sse("content_block_start", {
            "type": "content_block_start", "index": index,
            "content_block": {"type": "tool_use", "id": call_id, "name": name, "input": {}},
        })
        + _sse("content_block_delta", {
            "type": "content_block_delta", "index": index,
            "delta": {"type": "input_json_delta", "partial_json": json.dumps(args)},
        })
        + _content_block_stop(index)
    )


def _server_tool_use_events(index: int, call_id: str, name: str, args: dict) -> str:
    return (
        _sse("content_block_start", {
            "type": "content_block_start", "index": index,
            "content_block": {"type": "server_tool_use", "id": call_id, "name": name, "input": {}},
        })
        + _sse("content_block_delta", {
            "type": "content_block_delta", "index": index,
            "delta": {"type": "input_json_delta", "partial_json": json.dumps(args)},
        })
        + _content_block_stop(index)
    )


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def _message_start(mid: str, model: str, tokens: int) -> str:
    return _sse("message_start", {
        "type": "message_start",
        "message": {
            "id": mid, "type": "message", "role": "assistant", "content": [], "model": model,
            "stop_reason": None, "stop_sequence": None,
            "usage": {"input_tokens": tokens, "output_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
        },
    })


def _content_block_stop(index: int) -> str:
    return _sse("content_block_stop", {"type": "content_block_stop", "index": index})


def _error(t: str, msg: str) -> str:
    return _sse("error", {"type": "error", "error": {"type": t, "message": msg}})


class _StreamError(Exception):
    def __init__(self, message: str, status: Optional[int] = None):
        super().__init__(message)
        self.status = status


def _make_stream_error(chunk: dict) -> _StreamError:
    return _StreamError(chunk.get("message", "Unknown stream error"), chunk.get("status"))
