"""Fixtures for tests."""

from unittest.mock import MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

from claude2gemini.main import app


@pytest.fixture(autouse=True)
def mock_account_pool(monkeypatch):
    """Mock account_pool to provide a test account."""
    mock_pool = MagicMock()
    mock_pool.next.return_value = {"id": "test-account-1", "label": "Test Account"}
    monkeypatch.setattr("claude2gemini.routes.messages.account_pool", mock_pool)
    return mock_pool


@pytest.fixture
def client():
    """FastAPI test client using httpx."""
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")
