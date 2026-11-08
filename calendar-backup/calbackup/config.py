"""Paths, configuration and run history."""

from __future__ import annotations

import copy
import json
import os
import sys
import tempfile
import threading
from pathlib import Path


def app_home() -> Path:
    """Directory with config, tokens, history and logs."""
    env = os.environ.get("CALBACKUP_HOME")
    if env:
        return Path(env).expanduser()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "CalendarBackup"
    return Path.home() / ".config" / "calendar-backup"


DEFAULTS: dict = {
    "interval_hours": 6,
    "panel_host": "127.0.0.1",
    "panel_port": 8765,
    "local_dir": "~/CalendarBackups",
    "keep_local": 120,
    "notify_on_error": True,
    "drive": {
        # "api"    - upload through the Google Drive API (OAuth, see README)
        # "folder" - copy into a folder synced by Google Drive for desktop
        "enabled": True,
        "mode": "api",
        "folder_name": "Calendar Backups",
        "folder_path": "",
        "keep": 120,
    },
    "sources": [],
    # Gmail: incremental local copy of the mailbox (see calbackup/gmail.py for all keys)
    "gmail": {"enabled": False, "interval_hours": 1, "local_dir": "~/MailBackups", "include_spam": False},
}

MIN_INTERVAL_HOURS = 0.25
MAX_INTERVAL_HOURS = 24 * 7
HISTORY_LIMIT = 50

_lock = threading.RLock()


def _merge(base: dict, override: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def config_path() -> Path:
    return app_home() / "config.json"


def history_path(name: str = "history") -> Path:
    return app_home() / f"{name}.json"


def _atomic_write(path: Path, data: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(data)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def load_config() -> dict:
    with _lock:
        p = config_path()
        if not p.exists():
            return copy.deepcopy(DEFAULTS)
        with open(p, encoding="utf-8") as f:
            return _merge(DEFAULTS, json.load(f))


def save_config(cfg: dict) -> None:
    with _lock:
        _atomic_write(config_path(), json.dumps(cfg, ensure_ascii=False, indent=2) + "\n")


def validate_interval(value) -> float:
    v = float(value)
    if not (MIN_INTERVAL_HOURS <= v <= MAX_INTERVAL_HOURS):
        raise ValueError(
            f"Интервал должен быть от {MIN_INTERVAL_HOURS} до {MAX_INTERVAL_HOURS} ч."
        )
    return v


def load_history(name: str = "history") -> list:
    """Run history, newest first: "history" for calendars, "gmail_history" for Gmail."""
    with _lock:
        p = history_path(name)
        if not p.exists():
            return []
        try:
            with open(p, encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, list) else []
        except (OSError, ValueError):
            return []


def append_history(entry: dict, name: str = "history") -> None:
    with _lock:
        hist = load_history(name)
        hist.insert(0, entry)
        del hist[HISTORY_LIMIT:]
        _atomic_write(history_path(name), json.dumps(hist, ensure_ascii=False, indent=2) + "\n")


def local_dir(cfg: dict) -> Path:
    return Path(os.path.expanduser(cfg["local_dir"]))
