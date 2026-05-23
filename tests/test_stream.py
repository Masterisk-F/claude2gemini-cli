"""Tests for SSE stream converter."""

import pytest


class TestStreamConverter:
    @pytest.mark.asyncio
    async def test_emits_error_event_when_stream_throws(self):
        """TS equivalent: test_emits_error_event_and_stops_gracefully_when_stream_throws"""
        from claude2gemini.converters.stream import stream_antigravity_to_claude_sse

        async def error_chunks():
            yield {"type": "text", "text": "Hello"}
            raise Exception("Stream interrupted midway")

        mock_response = type("MockResponse", (), {"chunks": error_chunks()})()

        events = []
        async for chunk in stream_antigravity_to_claude_sse(
            mock_response, "test-model", "sess_1", [], []
        ):
            events.append(chunk)

        full = "".join(events)
        assert "event: error" in full
        assert "message_stop" in full

    @pytest.mark.asyncio
    async def test_fatal_error_emits_error_event(self):
        """TS equivalent: throws_GeminiApiError_if_stream_yields_fatal_error"""
        from claude2gemini.converters.stream import stream_antigravity_to_claude_sse

        async def fatal_chunks():
            yield {"type": "error", "message": "Child process died", "status": 500}

        mock_response = type("MockResponse", (), {"chunks": fatal_chunks()})()

        events = []
        async for chunk in stream_antigravity_to_claude_sse(
            mock_response, "test-model", "sess_1", [], []
        ):
            events.append(chunk)

        full = "".join(events)
        assert "event: error" in full
        assert "Child process died" in full
        assert "message_stop" in full

    @pytest.mark.asyncio
    async def test_text_stream_produces_correct_sse_events(self):
        from claude2gemini.converters.stream import stream_antigravity_to_claude_sse

        async def text_chunks():
            yield {"type": "text", "text": "Hello"}
            yield {"type": "text", "text": " World"}
            yield {"type": "turn_end", "stop_reason": "end_turn", "usage": {"input_tokens": 10, "output_tokens": 20}}

        mock_response = type("MockResponse", (), {"chunks": text_chunks()})()

        events = []
        async for chunk in stream_antigravity_to_claude_sse(
            mock_response, "test-model", "sess_1", [], []
        ):
            events.append(chunk)

        full = "".join(events)
        assert "event: ping" in full
        assert "event: message_start" in full
        assert "event: content_block_start" in full
        assert "event: content_block_delta" in full
        assert "event: content_block_stop" in full
        assert "event: message_delta" in full
        assert "event: message_stop" in full

    @pytest.mark.asyncio
    async def test_empty_response_emits_error(self):
        from claude2gemini.converters.stream import stream_antigravity_to_claude_sse

        async def empty_chunks():
            yield {"type": "turn_end", "stop_reason": "end_turn", "usage": {"input_tokens": 0, "output_tokens": 0}}

        mock_response = type("MockResponse", (), {"chunks": empty_chunks()})()

        events = []
        async for chunk in stream_antigravity_to_claude_sse(
            mock_response, "test-model", "sess_1", [], []
        ):
            events.append(chunk)

        full = "".join(events)
        assert "event: error" in full

    @pytest.mark.asyncio
    async def test_tool_call_produces_tool_use_blocks(self):
        from claude2gemini.converters.stream import stream_antigravity_to_claude_sse

        async def tool_chunks():
            yield {"type": "tool_call", "callId": "toolu_abc123", "name": "read_file", "args": {"path": "/tmp/test"}}
            yield {"type": "text", "text": "File content retrieved"}
            yield {"type": "turn_end", "stop_reason": "end_turn", "usage": {"input_tokens": 5, "output_tokens": 10}}

        mock_response = type("MockResponse", (), {"chunks": tool_chunks()})()

        events = []
        async for chunk in stream_antigravity_to_claude_sse(
            mock_response, "test-model", "sess_1", ["read_file"], []
        ):
            events.append(chunk)

        full = "".join(events)
        assert "tool_use" in full
        assert "toolu_abc123" in full
        assert "read_file" in full

    @pytest.mark.asyncio
    async def test_web_search_produces_server_tool_use(self):
        from claude2gemini.converters.stream import stream_antigravity_to_claude_sse

        async def ws_chunks():
            yield {"type": "server_tool_call", "callId": "srvtoolu_abc", "name": "web_search", "args": {"query": "test"}}
            yield {"type": "server_tool_result", "callId": "srvtoolu_abc", "result": [{"type": "web_search_result", "url": "http://example.com", "title": "Example", "encrypted_content": "dGVzdA=="}]}
            yield {"type": "text", "text": "Here are the results"}
            yield {"type": "turn_end", "stop_reason": "end_turn", "usage": {"input_tokens": 5, "output_tokens": 10}}

        mock_response = type("MockResponse", (), {"chunks": ws_chunks()})()

        events = []
        async for chunk in stream_antigravity_to_claude_sse(
            mock_response, "test-model", "sess_1", ["web_search"], []
        ):
            events.append(chunk)

        full = "".join(events)
        assert "server_tool_use" in full
        assert "web_search_tool_result" in full
        assert "srvtoolu_abc" in full
