"""Passwords are kept in the macOS Keychain (via `keyring`), never in config.json."""

from __future__ import annotations

SERVICE = "calendar-backup"


def get_secret(name: str) -> str:
    import keyring

    value = keyring.get_password(SERVICE, name)
    if not value:
        raise RuntimeError(
            f"Пароль '{name}' не найден в Связке ключей. "
            f"Выполните: calbackup set-secret {name}"
        )
    return value


def set_secret(name: str, value: str) -> None:
    import keyring

    keyring.set_password(SERVICE, name, value)
