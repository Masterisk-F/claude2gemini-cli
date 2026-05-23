"""Account pool for round-robin account selection."""

import json
import logging
import os
from typing import Optional

logger = logging.getLogger(__name__)

DEFAULT_ACCOUNTS_FILE = os.path.join(os.getcwd(), "data", "accounts.json")


class AccountPool:
    """Manages multiple Gemini API accounts with round-robin selection."""

    def __init__(self, accounts_file: str = DEFAULT_ACCOUNTS_FILE):
        self._accounts: list[dict] = []
        self._index = 0
        self._load(accounts_file)

    def _load(self, path: str) -> None:
        if not os.path.exists(path):
            logger.info("accounts.json not found at %s", path)
            return
        try:
            with open(path) as f:
                data = json.load(f)
            if isinstance(data, list):
                self._accounts = data
                logger.info("Loaded %d account(s) from %s", len(self._accounts), path)
            else:
                logger.warning("Invalid accounts.json format: expected array")
        except (json.JSONDecodeError, OSError) as e:
            logger.warning("Failed to load accounts.json: %s", e)

    def next(self) -> Optional[dict]:
        """Return next account in round-robin order, or None if empty."""
        if not self._accounts:
            return None
        account = self._accounts[self._index]
        self._index = (self._index + 1) % len(self._accounts)
        return account

    def get_account_ids(self) -> list[str]:
        return [a.get("id", "unknown") for a in self._accounts]

    def count(self) -> int:
        return len(self._accounts)


# Module-level singleton
account_pool = AccountPool()
