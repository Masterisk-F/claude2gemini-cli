"""Claude API type definitions for the proxy.

These Pydantic models represent the Claude Messages API request/response
format and SSE event structures used in streaming responses.
"""

from typing import Any, Literal, Optional, Union

from pydantic import BaseModel


# --- Content blocks ---

class ClaudeTextBlock(BaseModel):
    type: Literal["text"] = "text"
    text: str
    citations: Optional[list[dict]] = None


class ClaudeToolUseBlock(BaseModel):
    type: Literal["tool_use", "server_tool_use"] = "tool_use"
    id: str
    name: str
    input: dict[str, Any]


class ClaudeToolResultBlock(BaseModel):
    type: Literal["tool_result"] = "tool_result"
    tool_use_id: str
    content: Union[str, list[Any]]


class ClaudeWebSearchToolResultBlock(BaseModel):
    type: Literal["web_search_tool_result"] = "web_search_tool_result"
    tool_use_id: str
    content: Any


class ClaudeImageBlock(BaseModel):
    type: Literal["image"] = "image"
    source: dict  # {type: 'base64', media_type: str, data: str}


class ClaudeDocumentBlock(BaseModel):
    type: Literal["document"] = "document"
    source: dict  # {type: 'base64', media_type: str, data: str}


ClaudeContentBlock = Union[
    ClaudeTextBlock,
    ClaudeToolUseBlock,
    ClaudeToolResultBlock,
    ClaudeWebSearchToolResultBlock,
    ClaudeImageBlock,
    ClaudeDocumentBlock,
]


# --- Message and request ---

class ClaudeMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: Union[str, list[ClaudeContentBlock]]


class ClaudeToolDefinition(BaseModel):
    name: str
    description: Optional[str] = None
    input_schema: Optional[dict] = None
    type: Optional[str] = None  # carries "web_search_20260209" for web search


class ClaudeRequest(BaseModel):
    model: str
    messages: list[ClaudeMessage]
    max_tokens: int = 4096
    stream: bool = False
    system: Optional[Union[str, list]] = None
    tools: Optional[list[ClaudeToolDefinition]] = None
    stop_sequences: Optional[list[str]] = None
    temperature: Optional[float] = None
    top_p: Optional[float] = None
    top_k: Optional[int] = None


# --- Response types ---

class ClaudeUsage(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_input_tokens: Optional[int] = None
    cache_creation_input_tokens: Optional[int] = None
    server_tool_use: Optional[dict] = None  # {web_search_requests: int}


ClaudeStopReason = Literal["end_turn", "max_tokens", "stop_sequence", "tool_use"]


class ClaudeResponse(BaseModel):
    id: str
    type: Literal["message"] = "message"
    role: Literal["assistant"] = "assistant"
    content: list[ClaudeContentBlock]
    model: str
    stop_reason: Optional[ClaudeStopReason] = None
    stop_sequence: Optional[str] = None
    usage: ClaudeUsage


# --- SSE event types ---

class ClaudeMessageStartEvent(BaseModel):
    type: Literal["message_start"] = "message_start"
    message: dict


class ClaudeContentBlockStartEvent(BaseModel):
    type: Literal["content_block_start"] = "content_block_start"
    index: int
    content_block: dict


class ClaudeContentBlockDeltaEvent(BaseModel):
    type: Literal["content_block_delta"] = "content_block_delta"
    index: int
    delta: dict


class ClaudeContentBlockStopEvent(BaseModel):
    type: Literal["content_block_stop"] = "content_block_stop"
    index: int


class ClaudeMessageDeltaEvent(BaseModel):
    type: Literal["message_delta"] = "message_delta"
    delta: dict
    usage: dict


class ClaudeMessageStopEvent(BaseModel):
    type: Literal["message_stop"] = "message_stop"


class ClaudePingEvent(BaseModel):
    type: Literal["ping"] = "ping"
