"""Tests for messages route."""

import pytest
from claude2gemini.routes.messages import classify_error


class TestClassifyError:
    """TS equivalent: messages.test.ts classifyError tests."""

    def test_classifies_QUOTA_EXHAUSTED_as_overloaded_error(self):
        status, error_type, _ = classify_error(Exception("QUOTA_EXHAUSTED"))
        assert status == 500
        assert error_type == "overloaded_error"

    def test_classifies_RESOURCE_EXHAUSTED_as_overloaded_error(self):
        status, error_type, _ = classify_error(Exception("RESOURCE_EXHAUSTED"))
        assert status == 500
        assert error_type == "overloaded_error"

    def test_classifies_status_429_as_overloaded_error(self):
        err = Exception("Test 429 error")
        err.status_code = 429
        status, error_type, _ = classify_error(err)
        assert status == 500
        assert error_type == "overloaded_error"

    def test_classifies_TerminalQuotaError_as_overloaded_error(self):
        err = Exception("Terminal quota exceeded")
        err.name = "TerminalQuotaError"
        status, error_type, _ = classify_error(err)
        assert status == 500
        assert error_type == "overloaded_error"

    def test_classifies_generic_error_as_api_error_500(self):
        status, error_type, _ = classify_error(Exception("Unknown generic error"))
        assert status == 500
        assert error_type == "api_error"

    def test_classifies_gemini_api_error_with_status(self):
        from claude2gemini.routes.messages import GeminiApiError
        err = GeminiApiError("Rate limited", status_code=429)
        status, error_type, _ = classify_error(err)
        assert status == 500
        assert error_type == "overloaded_error"

    def test_classifies_401_as_authentication_error(self):
        from claude2gemini.routes.messages import GeminiApiError
        err = GeminiApiError("Unauthorized", status_code=401)
        status, error_type, _ = classify_error(err)
        assert status == 401
        assert error_type == "authentication_error"


class TestMessagesEndpoint:
    @pytest.mark.asyncio
    async def test_missing_messages_returns_400(self, client):
        resp = await client.post("/v1/messages", json={"model": "test"})
        assert resp.status_code == 400
        data = resp.json()
        assert data["error"]["type"] == "invalid_request_error"

    @pytest.mark.asyncio
    async def test_missing_model_returns_400(self, client):
        resp = await client.post("/v1/messages", json={"messages": [{"role": "user", "content": "hi"}]})
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_empty_messages_returns_400(self, client):
        resp = await client.post("/v1/messages", json={"model": "test", "messages": []})
        assert resp.status_code == 400
