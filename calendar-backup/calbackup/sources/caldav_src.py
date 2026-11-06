"""Any CalDAV server: iCloud (https://caldav.icloud.com), Fastmail, Yandex, Nextcloud, Zoho...

The objects are stored as returned by the server (original iCalendar), merged into one
VCALENDAR per calendar. Reminder lists (VTODO) are included."""

from __future__ import annotations

from pathlib import Path

from . import write_ics
from ..secrets import get_secret

PRODID = "-//calendar-backup//CalDAV export//RU"


def merge_objects(name: str, payloads: list[str]) -> tuple[bytes, int]:
    """Merge single-object iCalendar payloads into one calendar. Returns (ics, parse_errors)."""
    from icalendar import Calendar

    cal = Calendar()
    cal.add("prodid", PRODID)
    cal.add("version", "2.0")
    cal.add("x-wr-calname", name)
    seen_tz: set = set()
    errors = 0
    for raw in payloads:
        try:
            src = Calendar.from_ical(raw)
        except Exception:
            errors += 1
            continue
        for comp in src.subcomponents:
            if comp.name == "VTIMEZONE":
                tzid = str(comp.get("TZID"))
                if tzid in seen_tz:
                    continue
                seen_tz.add(tzid)
            cal.add_component(comp)
    return cal.to_ical(), errors


def _display_name(c) -> str:
    for getter in (lambda: c.get_display_name(), lambda: c.name):
        try:
            v = getter()
            if v:
                return str(v)
        except Exception:
            pass
    return str(c.url).rstrip("/").rsplit("/", 1)[-1]


def _data(obj) -> str | None:
    d = getattr(obj, "data", None)
    if isinstance(d, bytes):
        d = d.decode("utf-8", "replace")
    return d


def fetch(cfg: dict, out_dir: Path) -> dict:
    import caldav

    password = get_secret(cfg["password_keyring"]) if cfg.get("password_keyring") else cfg.get("password")
    client = caldav.DAVClient(url=cfg["url"], username=cfg.get("username"), password=password)
    principal = client.principal()
    only = set(cfg.get("calendars") or [])

    taken: set = set()
    result, warnings = [], []
    for c in principal.calendars():
        name = _display_name(c)
        if only and name not in only:
            continue
        objs, urls = [], set()
        groups = [("events", lambda: c.events())]
        if cfg.get("include_todos", True):
            groups.append(("todos", lambda: c.todos(include_completed=True)))
        for label, getter in groups:
            try:
                for o in getter():
                    u = str(o.url)
                    if u in urls:
                        continue
                    urls.add(u)
                    d = _data(o)
                    if d:
                        objs.append(d)
            except Exception as e:  # e.g. calendar does not support VTODO
                if label == "events":
                    raise
                warnings.append(f"{name}: задачи не получены ({type(e).__name__})")
        ics, errors = merge_objects(name, objs)
        if errors:
            warnings.append(f"{name}: {errors} объект(ов) не разобрано")
        entry = write_ics(out_dir, name, ics, taken)
        entry["id"] = str(c.url)
        result.append(entry)
    return {"calendars": result, "warnings": warnings}
