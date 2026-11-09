"""Archive names and ordering.

New names carry UTC time and the producing machine, so archives from a server (often
running in UTC) and from the Mac (local time) sort correctly and never collide:
    calendar-backup-20261109-120000Z-myserver.zip
Older names without "Z" were written in the local time of the machine that made them."""

from __future__ import annotations

import re
import socket
from datetime import datetime, timezone

ARCHIVE_PREFIX = "calendar-backup-"
ARCHIVE_RE = re.compile(
    r"^calendar-backup-(\d{8})-(\d{6})(Z?)(?:-([A-Za-z0-9_.-]{1,40}))?\.zip$"
)


def host_tag(cfg: dict | None = None) -> str:
    raw = (cfg or {}).get("host_tag") or socket.gethostname().split(".")[0]
    tag = re.sub(r"[^A-Za-z0-9_-]+", "-", raw).strip("-")[:24]
    return tag or "host"


def archive_name(ts: float, tag: str) -> str:
    stamp = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y%m%d-%H%M%S")
    return f"{ARCHIVE_PREFIX}{stamp}Z-{tag}.zip"


def is_archive(name: str) -> bool:
    return bool(ARCHIVE_RE.match(name))


def archive_ts(name: str) -> float | None:
    m = ARCHIVE_RE.match(name)
    if not m:
        return None
    dt = datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S")
    if m.group(3) == "Z":
        return dt.replace(tzinfo=timezone.utc).timestamp()
    return dt.timestamp()  # legacy name: local time of this machine


def archive_tag(name: str) -> str | None:
    m = ARCHIVE_RE.match(name)
    return m.group(4) if m else None


def sort_newest_first(names) -> list:
    """Archive names (or objects with a 'name' key) ordered newest first."""
    def key(x):
        n = x["name"] if isinstance(x, dict) else x
        return (archive_ts(n) or 0.0, n)

    return sorted((x for x in names if is_archive(x["name"] if isinstance(x, dict) else x)), key=key, reverse=True)
