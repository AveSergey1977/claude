"""Passwords and secret links, never stored in config.json.

macOS: the login Keychain (via `keyring`).
Linux server: secrets.json in the program directory, mode 600, readable only by the
service user (a headless server has no keychain). CALBACKUP_SECRETS=file forces the
file store on macOS too."""

from __future__ import annotations

import json
import os
import sys

from .config import _atomic_write, _lock, app_home

SERVICE = "calendar-backup"


def _use_keychain() -> bool:
    return sys.platform == "darwin" and os.environ.get("CALBACKUP_SECRETS") != "file"


def _file():
    return app_home() / "secrets.json"


def _load_file() -> dict:
    try:
        with open(_file(), encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def get_secret(name: str) -> str:
    if _use_keychain():
        import keyring

        value = keyring.get_password(SERVICE, name)
    else:
        value = _load_file().get(name)
    if not value:
        where = "Связке ключей" if _use_keychain() else f"файле {_file()}"
        raise RuntimeError(f"Секрет '{name}' не найден в {where}. Выполните: calbackup set-secret {name}")
    return value


def set_secret(name: str, value: str) -> str:
    """Stores the secret and returns a human description of where."""
    if _use_keychain():
        import keyring

        keyring.set_password(SERVICE, name, value)
        return "Связке ключей macOS"
    with _lock:
        data = _load_file()
        data[name] = value
        _atomic_write(_file(), json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    return f"{_file()} (права 600)"
