"""Tests for Claude API type models."""

import pytest
from pydantic import ValidationError

from claude2gemini.types import (
    ClaudeTextBlock,
    ClaudeToolUseBlock,
    ClaudeToolResultBlock,
    ClaudeWebSearchToolResultBlock,
    ClaudeImageBlock,
    ClaudeDocumentBlock,
    ClaudeMessage,
    ClaudeRequest,
    ClaudeResponse,
    ClaudeUsage,
    ClaudeMessageStartEvent,
    ClaudeContentBlockStartEvent,
    ClaudeContentBlockDeltaEvent,
    ClaudeContentBlockStopEvent,
    ClaudeMessageDeltaEvent,
    ClaudeMessageStopEvent,
    ClaudePingEvent,
)


class TestClaudeTextBlock:
    def test_basic_text_block(self):
        block = ClaudeTextBlock(text="Hello, world!")
        assert block.type == "text"
        assert block.text == "Hello, world!"
        assert block.citations is None

    def test_text_block_with_citations(self):
        block = ClaudeTextBlock(
            text="Some text with sources.",
            citations=[
                {
                    "type": "web_search_result_location",
                    "url": "http://example.com",
                    "title": "Example",
                    "encrypted_index": "aGVsbG8=",
                    "cited_text": "Some text",
                }
            ],
        )
        assert block.citations is not None
        assert len(block.citations) == 1


class TestClaudeToolUseBlock:
    def test_tool_use_block(self):
        block = ClaudeToolUseBlock(
            id="toolu_abc123",
            name="read_file",
            input={"path": "/tmp/test.txt"},
        )
        assert block.type == "tool_use"
        assert block.id == "toolu_abc123"
        assert block.name == "read_file"

    def test_server_tool_use(self):
        block = ClaudeToolUseBlock.model_validate({
            "type": "server_tool_use",
            "id": "srvtoolu_abc123",
            "name": "web_search",
            "input": {"query": "test"},
        })
        assert block.type == "server_tool_use"
        assert block.name == "web_search"


class TestClaudeToolResultBlock:
    def test_tool_result_with_string_content(self):
        block = ClaudeToolResultBlock(
            tool_use_id="toolu_abc123",
            content="File content here",
        )
        assert block.tool_use_id == "toolu_abc123"

    def test_tool_result_with_array_content(self):
        block = ClaudeToolResultBlock(
            tool_use_id="toolu_abc123",
            content=[{"type": "text", "text": "result"}],
        )
        assert isinstance(block.content, list)

    def test_tool_result_type_default(self):
        block = ClaudeToolResultBlock(tool_use_id="t1", content="")
        assert block.type == "tool_result"


class TestClaudeImageBlock:
    def test_image_block(self):
        block = ClaudeImageBlock(
            source={
                "type": "base64",
                "media_type": "image/jpeg",
                "data": "dGVzdA==",
            }
        )
        assert block.source["media_type"] == "image/jpeg"

    def test_image_block_invalid(self):
        # source is typed as dict; missing keys won't raise ValidationError
        block = ClaudeImageBlock(source={"type": "base64"})
        assert block.source["type"] == "base64"


class TestClaudeDocumentBlock:
    def test_document_block(self):
        block = ClaudeDocumentBlock(
            source={
                "type": "base64",
                "media_type": "application/pdf",
                "data": "UERG",
            }
        )
        assert block.source["media_type"] == "application/pdf"


class TestClaudeMessage:
    def test_user_message_with_string(self):
        msg = ClaudeMessage(role="user", content="Hello")
        assert msg.role == "user"
        assert msg.content == "Hello"

    def test_user_message_with_blocks(self):
        msg = ClaudeMessage(
            role="user",
            content=[
                ClaudeTextBlock(text="Hello"),
                ClaudeImageBlock(
                    source={
                        "type": "base64",
                        "media_type": "image/png",
                        "data": "aW1hZ2U=",
                    }
                ),
            ],
        )
        assert isinstance(msg.content, list)
        assert len(msg.content) == 2

    def test_assistant_message(self):
        msg = ClaudeMessage(role="assistant", content="I can help")
        assert msg.role == "assistant"


class TestClaudeRequest:
    def test_minimal_request(self):
        req = ClaudeRequest(
            model="claude-3-opus-20240229",
            messages=[ClaudeMessage(role="user", content="Hi")],
            max_tokens=100,
        )
        assert req.model == "claude-3-opus-20240229"
        assert req.stream is False

    def test_request_with_all_fields(self):
        req = ClaudeRequest(
            model="claude-3-sonnet-20240229",
            messages=[ClaudeMessage(role="user", content="Hello")],
            max_tokens=200,
            stream=True,
            system="Be helpful.",
            temperature=0.7,
            top_p=0.9,
            top_k=40,
            stop_sequences=["STOP"],
            tools=[{"name": "web_search", "type": "web_search_20260209"}],
        )
        assert req.stream is True
        assert req.system == "Be helpful."
        assert req.tools is not None
        assert len(req.tools) == 1
        assert req.tools[0].name == "web_search"


class TestClaudeUsage:
    def test_basic_usage(self):
        usage = ClaudeUsage(input_tokens=10, output_tokens=20)
        assert usage.input_tokens == 10
        assert usage.output_tokens == 20
        assert usage.cache_read_input_tokens is None
        assert usage.server_tool_use is None

    def test_usage_with_server_tool_use(self):
        usage = ClaudeUsage(
            input_tokens=10,
            output_tokens=20,
            server_tool_use={"web_search_requests": 1},
        )
        assert usage.server_tool_use["web_search_requests"] == 1


class TestClaudeResponse:
    def test_basic_response(self):
        response = ClaudeResponse(
            id="msg_abc123",
            content=[ClaudeTextBlock(text="Hello!")],
            model="claude-3-opus-20240229",
            stop_reason="end_turn",
            usage=ClaudeUsage(input_tokens=10, output_tokens=20),
        )
        assert response.type == "message"
        assert response.role == "assistant"
        assert response.stop_reason == "end_turn"
        assert response.stop_sequence is None

    def test_response_serialization(self):
        response = ClaudeResponse(
            id="msg_abc",
            content=[ClaudeTextBlock(text="Hi")],
            model="claude-3",
            stop_reason="end_turn",
            usage=ClaudeUsage(input_tokens=1, output_tokens=2),
        )
        data = response.model_dump(exclude_none=True)
        assert data["type"] == "message"
        assert data["role"] == "assistant"


class TestSSEEvents:
    def test_message_start_event(self):
        event = ClaudeMessageStartEvent(
            message={
                "id": "msg_1",
                "type": "message",
                "role": "assistant",
                "content": [],
                "model": "claude-3",
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {"input_tokens": 0, "output_tokens": 0},
            }
        )
        assert event.type == "message_start"

    def test_content_block_start_text(self):
        event = ClaudeContentBlockStartEvent(
            index=0,
            content_block={"type": "text", "text": ""},
        )
        assert event.type == "content_block_start"
        assert event.index == 0

    def test_content_block_start_tool_use(self):
        event = ClaudeContentBlockStartEvent(
            index=0,
            content_block={
                "type": "tool_use",
                "id": "toolu_1",
                "name": "read_file",
                "input": {},
            },
        )
        assert event.content_block["type"] == "tool_use"

    def test_content_block_delta_text(self):
        event = ClaudeContentBlockDeltaEvent(
            index=0,
            delta={"type": "text_delta", "text": "Hello"},
        )
        assert event.type == "content_block_delta"

    def test_content_block_delta_input_json(self):
        event = ClaudeContentBlockDeltaEvent(
            index=0,
            delta={"type": "input_json_delta", "partial_json": '{"path": "/tmp"}'},
        )
        assert event.delta["type"] == "input_json_delta"

    def test_content_block_stop(self):
        event = ClaudeContentBlockStopEvent(index=0)
        assert event.type == "content_block_stop"

    def test_message_delta(self):
        event = ClaudeMessageDeltaEvent(
            delta={"stop_reason": "end_turn", "stop_sequence": None},
            usage={"output_tokens": 10},
        )
        assert event.type == "message_delta"

    def test_message_stop(self):
        event = ClaudeMessageStopEvent()
        assert event.type == "message_stop"

    def test_ping(self):
        event = ClaudePingEvent()
        assert event.type == "ping"
