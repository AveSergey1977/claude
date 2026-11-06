"""Calendar sources. Each `fetch(cfg, out_dir)` writes one .ics per calendar into out_dir
and returns {"calendars": [{"name", "file", "events"}...]}."""

from __future__ import annotations

import re
from pathlib import Path


def safe_name(name: str, taken: set | None = None) -> str:
    base = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_", (name or "calendar").strip()).strip(". ")[:80]
    base = base or "calendar"
    if taken is None:
        return base
    candidate, n = base, 2
    while candidate.lower() in taken:
        candidate, n = f"{base} ({n})", n + 1
    taken.add(candidate.lower())
    return candidate


def count_components(ics_bytes: bytes) -> int:
    """Number of VEVENT/VTODO/VJOURNAL blocks in an iCalendar payload."""
    return len(re.findall(rb"^BEGIN:(VEVENT|VTODO|VJOURNAL)\r?$", ics_bytes, flags=re.M))


def write_ics(out_dir: Path, name: str, data: bytes, taken: set) -> dict:
    fname = safe_name(name, taken) + ".ics"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / fname).write_bytes(data)
    return {"name": name, "file": fname, "events": count_components(data), "bytes": len(data)}


def get_fetcher(kind: str):
    if kind == "google":
        from . import google

        return google.fetch
    if kind == "caldav":
        from . import caldav_src

        return caldav_src.fetch
    if kind == "ics":
        from . import ics_url

        return ics_url.fetch
    if kind == "macos":
        from . import macos

        return macos.fetch
    raise ValueError(f"Неизвестный тип источника: {kind}")
