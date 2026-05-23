"""Tests for AccountPool."""

import json
import os
import tempfile

import pytest

from claude2gemini.account_pool import AccountPool


@pytest.fixture
def accounts_file():
    fd, path = tempfile.mkstemp(suffix=".json", prefix="accounts_")
    os.close(fd)
    yield path
    if os.path.exists(path):
        os.unlink(path)


class TestAccountPool:
    def test_loads_accounts_from_json(self, accounts_file):
        accounts = [
            {"id": "a1", "label": "Account 1", "credentials": {"access_token": "tok1"}},
            {"id": "a2", "label": "Account 2", "credentials": {"access_token": "tok2"}},
        ]
        with open(accounts_file, "w") as f:
            json.dump(accounts, f)

        pool = AccountPool(accounts_file)
        assert pool.count() == 2

    def test_round_robin_distributes(self, accounts_file):
        accounts = [
            {"id": "a1", "label": "A1", "credentials": {"access_token": "tok1"}},
            {"id": "a2", "label": "A2", "credentials": {"access_token": "tok2"}},
            {"id": "a3", "label": "A3", "credentials": {"access_token": "tok3"}},
        ]
        with open(accounts_file, "w") as f:
            json.dump(accounts, f)

        pool = AccountPool(accounts_file)
        ids = [pool.next()["id"] for _ in range(6)]
        assert ids == ["a1", "a2", "a3", "a1", "a2", "a3"]

    def test_empty_file_returns_default(self, accounts_file):
        with open(accounts_file, "w") as f:
            json.dump([], f)

        pool = AccountPool(accounts_file)
        assert pool.count() == 0
        account = pool.next()
        assert account is None  # no accounts = no valid selection

    def test_missing_file_returns_default(self):
        pool = AccountPool("/tmp/nonexistent_accounts_file.json")
        assert pool.count() == 0
        account = pool.next()
        assert account is None

    def test_corrupted_file_handled_gracefully(self, accounts_file):
        with open(accounts_file, "w") as f:
            f.write("not valid json")

        pool = AccountPool(accounts_file)
        assert pool.count() == 0

    def test_get_account_ids(self, accounts_file):
        accounts = [
            {"id": "a1", "label": "A1", "credentials": {"token": "t1"}},
            {"id": "a2", "label": "A2", "credentials": {"token": "t2"}},
        ]
        with open(accounts_file, "w") as f:
            json.dump(accounts, f)

        pool = AccountPool(accounts_file)
        assert pool.get_account_ids() == ["a1", "a2"]
