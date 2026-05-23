"""Tests for ToolBridge."""

import pytest
from claude2gemini.tool_bridge import ToolBridge
from claude2gemini.session_store import Session


class TestToolBridge:
    def test_build_tools_returns_list(self):
        bridge = ToolBridge()
        session = Session("account_a")
        tool_defs = [
            {"name": "read_file", "description": "Read a file", "input_schema": {"type": "object"}},
        ]
        tools = bridge.build_tools(session, tool_defs)
        assert len(tools) == 1
        name, desc, schema, callable_fn = tools[0]
        assert name == "read_file"
        assert callable(callable_fn)

    def test_build_tools_empty_returns_empty(self):
        bridge = ToolBridge()
        session = Session("account_a")
        tools = bridge.build_tools(session, [])
        assert tools == []

    def test_build_tools_none_returns_empty(self):
        bridge = ToolBridge()
        session = Session("account_a")
        tools = bridge.build_tools(session, None)
        assert tools == []

    @pytest.mark.asyncio
    async def test_stub_queues_tool_call_and_returns_placeholder(self):
        bridge = ToolBridge()
        session = Session("account_a")
        tool_defs = [{"name": "read_file", "description": "Read"}]
        tools = bridge.build_tools(session, tool_defs)
        name, _, _, stub = tools[0]

        from claude2gemini.tool_bridge import TOOL_TIMEOUT
        result = await stub(path="/tmp/test.txt")

        # Should return a placeholder JSON
        import json
        data = json.loads(result)
        assert "__pending" in data or "call_id" in data

    @pytest.mark.asyncio
    async def test_stub_generates_unique_call_ids(self):
        bridge = ToolBridge()
        session = Session("account_a")
        tools = bridge.build_tools(session, [{"name": "read_file", "description": "Read"}])

        import json
        name, _, _, stub = tools[0]
        r1 = json.loads(await stub(path="a"))
        r2 = json.loads(await stub(path="b"))
        assert r1["call_id"] != r2["call_id"]

    @pytest.mark.asyncio
    async def test_multiple_tools(self):
        bridge = ToolBridge()
        session = Session("account_a")
        tool_defs = [
            {"name": "read_file", "description": "Read"},
            {"name": "search", "description": "Search"},
        ]
        tools = bridge.build_tools(session, tool_defs)
        assert len(tools) == 2
        names = [t[0] for t in tools]
        assert "read_file" in names
        assert "search" in names
