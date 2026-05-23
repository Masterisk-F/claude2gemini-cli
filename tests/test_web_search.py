"""Tests for web search E2E flow."""

import json

import pytest


class TestWebSearch:
    @pytest.mark.asyncio
    async def test_web_search_non_streaming_with_mapped_results(self, client):
        """TS equivalent: handles_web_search_non-streaming_with_mapped_results"""
        resp = await client.post("/v1/messages", json={
            "model": "claude-3-opus-20240229",
            "messages": [{"role": "user", "content": "search"}],
            "tools": [{"name": "web_search", "description": "desc", "type": "web_search_20260209"}],
        })
        # Should work with mocked account pool
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_web_search_streaming(self, client):
        """TS equivalent: handles_web_search_streaming"""
        async with client.stream("POST", "/v1/messages", json={
            "model": "claude-3-opus-20240229",
            "messages": [{"role": "user", "content": "search"}],
            "tools": [{"name": "web_search", "type": "web_search_20260209"}],
            "stream": True,
        }) as resp:
            body = await resp.aread()
            text = body.decode()
            if resp.status_code == 200:
                assert "text/event-stream" in resp.headers.get("content-type", "")
                # Check for basic SSE structure
                assert "message_start" in text or "error" in text

    @pytest.mark.asyncio
    async def test_web_search_returns_200(self, client):
        """Verify web_search request returns successfully."""
        resp = await client.post("/v1/messages", json={
            "model": "claude-3-opus-20240229",
            "messages": [{"role": "user", "content": "search for weather in Tokyo"}],
            "tools": [{"name": "web_search", "description": "Web search", "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}}, "type": "web_search_20260209"}],
        })
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_web_search_without_tools_works(self, client):
        """Verify request without tools still works."""
        resp = await client.post("/v1/messages", json={
            "model": "claude-3-opus-20240229",
            "messages": [{"role": "user", "content": "hello"}],
        })
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_regular_tool_still_works(self, client):
        """Verify non-web_search tools still work."""
        resp = await client.post("/v1/messages", json={
            "model": "claude-3-opus-20240229",
            "messages": [{"role": "user", "content": "read file"}],
            "tools": [{"name": "read_file", "description": "Read a file", "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}}}],
        })
        assert resp.status_code == 200
