"""Claude messages → Antigravity prompt conversion."""

import json
import logging
from typing import Any, Optional, Union

from claude2gemini.types import (
    ClaudeContentBlock,
    ClaudeMessage,
    ClaudeToolResultBlock,
    ClaudeWebSearchToolResultBlock,
)

logger = logging.getLogger(__name__)

InlineDataPart = dict  # {"inlineData": {"mimeType": str, "data": str}}


class ConvertedPrompt:
    """Result of converting Claude messages to Antigravity prompt."""

    def __init__(self, prompt: str, inline_data_parts: Optional[list[InlineDataPart]] = None):
        self.prompt = prompt
        self.inline_data_parts = inline_data_parts or []

    def __repr__(self) -> str:
        return f"ConvertedPrompt(prompt={self.prompt!r}, inline_data_parts={self.inline_data_parts})"


def map_model_name(model: str) -> str:
    """Map Claude model names to Antigravity-compatible names."""
    lower = model.lower()
    if "opus" in lower:
        return "gemini-3.1-pro-preview"
    if "sonnet" in lower:
        return "gemini-3-flash-preview"
    if "haiku" in lower:
        return "gemini-2.5-flash-lite"
    if "gemini" not in lower:
        return "gemini-3-flash-preview"
    return model


def extract_system_prompt(system: Any) -> Optional[str]:
    """Extract plain text system prompt from Claude system parameter."""
    if system is None:
        return None
    if isinstance(system, str):
        return system
    if isinstance(system, list):
        parts = []
        for block in system:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text", ""))
            else:
                parts.append(json.dumps(block))
        return "\n".join(parts)
    return str(system)


def normalize_tool_result_content(content: Any) -> str:
    """Convert tool_result content to string."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        texts = []
        for block in content:
            if isinstance(block, str):
                texts.append(block)
            elif isinstance(block, dict) and block.get("type") == "text":
                texts.append(block.get("text", ""))
            else:
                texts.append(json.dumps(block))
        return "\n".join(texts)
    return json.dumps(content)


def _block_to_dict(block: Any) -> dict:
    """Convert a content block to dict, handling both dict and Pydantic model."""
    if isinstance(block, dict):
        return block
    if hasattr(block, "model_dump"):
        return block.model_dump()
    return {"type": "unknown"}


async def _format_content_for_prompt(
    content: Union[str, list[ClaudeContentBlock]],
    inline_data_parts: list[InlineDataPart],
) -> str:
    """Convert a message's content blocks to prompt text, collecting inline data."""
    if isinstance(content, str):
        return content

    parts: list[str] = []
    for block in content:
        d = _block_to_dict(block)
        block_type = d.get("type", "")
        if block_type == "text":
            parts.append(d.get("text", ""))
        elif block_type in ("tool_use", "server_tool_use"):
            name = d.get("name", "unknown")
            inp = d.get("input", {})
            parts.append(f"[Tool Call: {name}({json.dumps(inp)})]")
        elif block_type == "tool_result":
            tool_use_id = d.get("tool_use_id", "unknown")
            cnt = d.get("content", "")
            result_text = normalize_tool_result_content(cnt)
            parts.append(f"[Tool Result {tool_use_id}: {result_text}]")
        elif block_type == "web_search_tool_result":
            tool_use_id = d.get("tool_use_id", "unknown")
            cnt = d.get("content", "")
            result_text = normalize_tool_result_content(cnt)
            parts.append(f"[Tool Result {tool_use_id}: {result_text}]")
        elif block_type == "image":
            _process_media_block(d, inline_data_parts, parts)
        elif block_type == "document":
            _process_media_block(d, inline_data_parts, parts)
        else:
            logger.warning("Unknown content block type: %s", block_type)
    return "\n".join(parts)


def _process_media_block(
    block: dict, inline_data_parts: list[InlineDataPart], parts: list[str]
) -> None:
    """Process image/document block: collect inline data and add placeholder."""
    source = block.get("source", {})
    media_type = source.get("media_type", "")
    data = source.get("data", "")
    if media_type and data:
        inline_data_parts.append({"inlineData": {"mimeType": media_type, "data": data}})
        parts.append(f"[Attached: {media_type}]")
    else:
        logger.warning("Skipping %s block with missing source data", block.get("type"))


def _msg_role(msg: Any) -> str:
    """Get role from a message that may be dict or Pydantic model."""
    if isinstance(msg, dict):
        return msg.get("role", "user")
    if hasattr(msg, "role"):
        return msg.role
    return "user"


def _msg_content(msg: Any) -> Any:
    """Get content from a message that may be dict or Pydantic model."""
    if isinstance(msg, dict):
        return msg.get("content", "")
    if hasattr(msg, "content"):
        return msg.content
    return ""


async def convert_messages_to_prompt(
    messages: list,
) -> ConvertedPrompt:
    """Convert Claude messages to a prompt for Antigravity.

    Accepts both Pydantic ClaudeMessage models and raw dicts.
    """
    if not messages:
        raise ValueError("messages must contain at least one message")

    inline_data_parts: list[InlineDataPart] = []

    # Single user message → plain text
    if len(messages) == 1 and _msg_role(messages[0]) == "user":
        prompt = await _format_content_for_prompt(
            _msg_content(messages[0]), inline_data_parts
        )
        return ConvertedPrompt(prompt=prompt, inline_data_parts=inline_data_parts)

    # Multi-turn: role-labeled conversation text
    parts: list[str] = []
    for msg in messages:
        role_label = "User" if _msg_role(msg) == "user" else "Assistant"
        text = await _format_content_for_prompt(_msg_content(msg), inline_data_parts)
        if text:
            parts.append(f"{role_label}: {text}")

    return ConvertedPrompt(
        prompt="\n\n".join(parts), inline_data_parts=inline_data_parts
    )
