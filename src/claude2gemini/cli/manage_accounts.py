"""CLI for managing Gemini API accounts."""

import json
import os
import sys

DATA_DIR = os.path.join(os.getcwd(), "data")
ACCOUNTS_FILE = os.path.join(DATA_DIR, "accounts.json")


def _load_accounts() -> list[dict]:
    if not os.path.exists(ACCOUNTS_FILE):
        return []
    with open(ACCOUNTS_FILE) as f:
        data = json.load(f)
    if isinstance(data, list):
        return data
    return []


def _save_accounts(accounts: list[dict]) -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(ACCOUNTS_FILE, "w") as f:
        json.dump(accounts, f, indent=2)


def cmd_list() -> None:
    """List all registered accounts."""
    accounts = _load_accounts()
    if not accounts:
        print("No accounts registered.")
        return
    print(f"\nRegistered Accounts ({len(accounts)}):\n")
    for a in accounts:
        print(f"  ID: {a.get('id', '?')}")
        print(f"  Label: {a.get('label', '?')}")
        print(f"  Credentials: *** (MASKED) ***")
        print()


def cmd_add(label: str, creds_json: str) -> None:
    """Add a new account."""
    try:
        credentials = json.loads(creds_json)
    except json.JSONDecodeError:
        print("Error: Invalid JSON format for credentials.")
        sys.exit(1)

    accounts = _load_accounts()
    account_id = f"account-{len(accounts)}-{os.urandom(4).hex()}"
    accounts.append({"id": account_id, "label": label, "credentials": credentials})
    _save_accounts(accounts)
    print(f"Account '{label}' added successfully (ID: {account_id})")


def cmd_remove(account_id: str) -> None:
    """Remove an account by ID."""
    accounts = _load_accounts()
    before = len(accounts)
    accounts = [a for a in accounts if a.get("id") != account_id]
    if len(accounts) == before:
        print(f"Account with ID '{account_id}' not found.")
        return
    _save_accounts(accounts)
    print(f"Account '{account_id}' removed.")


def main() -> None:
    command = sys.argv[1] if len(sys.argv) > 1 else None

    if command == "list":
        cmd_list()
    elif command == "add":
        if len(sys.argv) < 4:
            print("Usage: python -m claude2gemini.cli.manage_accounts add <label> <credentials_json>")
            sys.exit(1)
        cmd_add(sys.argv[2], sys.argv[3])
    elif command == "remove":
        if len(sys.argv) < 3:
            print("Usage: python -m claude2gemini.cli.manage_accounts remove <id>")
            sys.exit(1)
        cmd_remove(sys.argv[2])
    else:
        print("Usage: python -m claude2gemini.cli.manage_accounts [add|list|remove]")
        sys.exit(1)


if __name__ == "__main__":
    main()
