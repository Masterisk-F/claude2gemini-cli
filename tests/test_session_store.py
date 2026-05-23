"""Tests for SessionStore."""

import pytest
from claude2gemini.session_store import SessionStore


class TestSessionStore:
    @pytest.mark.asyncio
    async def test_get_or_create_session(self):
        store = SessionStore()
        session = await store.get_or_create("sess_1", "account_a")
        assert session.account_id == "account_a"
        # verify it's the same instance on second call
        session2 = await store.get_or_create("sess_1", "account_a")
        assert session2 is session

    @pytest.mark.asyncio
    async def test_get_session(self):
        store = SessionStore()
        await store.get_or_create("sess_1", "account_a")
        session = await store.get("sess_1")
        assert session is not None
        assert session.account_id == "account_a"

    @pytest.mark.asyncio
    async def test_get_nonexistent_session(self):
        store = SessionStore()
        session = await store.get("nonexistent")
        assert session is None

    @pytest.mark.asyncio
    async def test_delete_session(self):
        store = SessionStore()
        session = await store.get_or_create("sess_1", "account_a")
        # add a tool call
        future = session.create_tool_future("tool_1", "read_file", {})
        store.index_tool_call("tool_1", "sess_1")

        await store.delete("sess_1")

        assert await store.get("sess_1") is None
        # verify session was removed from tool index
        assert store.resolve_session("tool_1") is None
        # verify future was cancelled
        assert future.done()

    @pytest.mark.asyncio
    async def test_resolve_tool_call(self):
        store = SessionStore()
        session = await store.get_or_create("sess_1", "account_a")
        future = session.create_tool_future("tool_abc", "read_file", {})
        store.index_tool_call("tool_abc", "sess_1")

        await store.resolve_tool_call("tool_abc", "file content")
        assert future.done()
        assert future.result() == "file content"
        # index should be cleaned up
        assert store.resolve_session("tool_abc") is None

    @pytest.mark.asyncio
    async def test_resolve_nonexistent_tool_call(self):
        store = SessionStore()
        result = await store.resolve_tool_call("no_such_tool", "result")
        assert result is False

    @pytest.mark.asyncio
    async def test_multiple_sessions_independent(self):
        store = SessionStore()
        s1 = await store.get_or_create("sess_1", "account_a")
        s2 = await store.get_or_create("sess_2", "account_b")
        assert s1.account_id == "account_a"
        assert s2.account_id == "account_b"
        assert s1 is not s2
