"""Google Calendar via the Calendar API v3.

For every calendar two files are written: <name>.ics (importable into any calendar app)
and <name>.json (raw API response, lossless)."""

from __future__ import annotations

import json
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from . import write_ics

PRODID = "-//calendar-backup//Google Calendar export//RU"

_PARTSTAT = {
    "needsAction": "NEEDS-ACTION",
    "declined": "DECLINED",
    "tentative": "TENTATIVE",
    "accepted": "ACCEPTED",
}


def _zone(name):
    if not name:
        return None
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo(name)
    except Exception:
        return None


def _parse_rfc3339(s: str) -> datetime:
    s = s.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    # Python 3.9 accepts at most 6 fractional digits
    m = re.match(r"^(.*?\.)(\d+)(.*)$", s)
    if m:
        s = m.group(1) + m.group(2)[:6].ljust(6, "0") + m.group(3)
    return datetime.fromisoformat(s)


def gtime(obj: dict | None, default_tz: str | None):
    """Google {date} / {dateTime, timeZone} -> date or tz-aware datetime."""
    if not obj:
        return None
    if obj.get("date"):
        return date.fromisoformat(obj["date"])
    dt = _parse_rfc3339(obj["dateTime"])
    tz = _zone(obj.get("timeZone")) or _zone(default_tz)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=tz or timezone.utc)
    elif tz is not None:
        dt = dt.astimezone(tz)
    return dt


def _recurrence_props(lines: list[str]):
    from icalendar import Event

    text = "BEGIN:VEVENT\r\n" + "\r\n".join(l.strip() for l in lines if l.strip()) + "\r\nEND:VEVENT\r\n"
    try:
        return list(Event.from_ical(text).property_items(recursive=False))[1:-1]
    except Exception:
        return []


def event_to_vevent(ev: dict, default_tz: str | None, default_reminders: list | None):
    from icalendar import Alarm, Event, vCalAddress, vText

    ve = Event()
    ve.add("uid", ev.get("iCalUID") or f"{ev.get('id')}@google.com")
    stamp = ev.get("updated") or ev.get("created")
    ve.add("dtstamp", _parse_rfc3339(stamp) if stamp else datetime.now(timezone.utc))
    if ev.get("created"):
        ve.add("created", _parse_rfc3339(ev["created"]))
    if ev.get("updated"):
        ve.add("last-modified", _parse_rfc3339(ev["updated"]))

    start = gtime(ev.get("start"), default_tz)
    end = gtime(ev.get("end"), default_tz)
    if start is not None:
        ve.add("dtstart", start)
    if end is not None:
        ve.add("dtend", end)
    elif isinstance(start, date) and not isinstance(start, datetime):
        ve.add("dtend", start + timedelta(days=1))

    if ev.get("recurringEventId") and ev.get("originalStartTime"):
        ve.add("recurrence-id", gtime(ev["originalStartTime"], default_tz))
    for name, value in _recurrence_props(ev.get("recurrence") or []):
        ve.add(name, value)

    for key, prop in (("summary", "summary"), ("location", "location")):
        if ev.get(key):
            ve.add(prop, ev[key])

    desc = ev.get("description") or ""
    conf = []
    if ev.get("hangoutLink"):
        conf.append(ev["hangoutLink"])
    for ep in (ev.get("conferenceData") or {}).get("entryPoints") or []:
        uri = ep.get("uri")
        if uri and uri not in conf:
            conf.append(uri)
    if conf:
        ve.add("x-google-conference", conf[0])
        desc = (desc + "\n\n" if desc else "") + "\n".join(conf)
    if desc:
        ve.add("description", desc)

    if ev.get("status"):
        ve.add("status", ev["status"].upper())
    ve.add("transp", "TRANSPARENT" if ev.get("transparency") == "transparent" else "OPAQUE")
    if ev.get("visibility") in ("private", "confidential"):
        ve.add("class", ev["visibility"].upper())
    if "sequence" in ev:
        ve.add("sequence", int(ev["sequence"]))
    if ev.get("htmlLink"):
        ve.add("url", ev["htmlLink"])

    org = ev.get("organizer") or {}
    if org.get("email"):
        o = vCalAddress(f"mailto:{org['email']}")
        if org.get("displayName"):
            o.params["CN"] = vText(org["displayName"])
        ve.add("organizer", o, encode=0)
    for att in ev.get("attendees") or []:
        if not att.get("email"):
            continue
        a = vCalAddress(f"mailto:{att['email']}")
        if att.get("displayName"):
            a.params["CN"] = vText(att["displayName"])
        a.params["PARTSTAT"] = _PARTSTAT.get(att.get("responseStatus"), "NEEDS-ACTION")
        a.params["ROLE"] = "OPT-PARTICIPANT" if att.get("optional") else "REQ-PARTICIPANT"
        if att.get("resource"):
            a.params["CUTYPE"] = "RESOURCE"
        ve.add("attendee", a, encode=0)

    for f in ev.get("attachments") or []:
        if f.get("fileUrl"):
            ve.add("attach", f["fileUrl"])

    rem = ev.get("reminders") or {}
    overrides = rem.get("overrides") if not rem.get("useDefault") else default_reminders
    for r in overrides or []:
        if r.get("minutes") is None:
            continue
        al = Alarm()
        al.add("action", "DISPLAY")
        al.add("description", ev.get("summary") or "Reminder")
        al.add("trigger", timedelta(minutes=-int(r["minutes"])))
        ve.add_component(al)
    return ve


def build_calendar(meta: dict, items: list[dict]) -> bytes:
    from icalendar import Calendar

    tz = meta.get("timeZone")
    cal = Calendar()
    cal.add("prodid", PRODID)
    cal.add("version", "2.0")
    cal.add("calscale", "GREGORIAN")
    cal.add("x-wr-calname", meta.get("summaryOverride") or meta.get("summary") or meta.get("id"))
    if tz:
        cal.add("x-wr-timezone", tz)
    if meta.get("description"):
        cal.add("x-wr-caldesc", meta["description"])

    by_id: dict[str, object] = {}
    cancelled = []
    for ev in items:
        if ev.get("status") == "cancelled":
            if ev.get("recurringEventId") and ev.get("originalStartTime"):
                cancelled.append(ev)
            continue
        ve = event_to_vevent(ev, tz, meta.get("defaultReminders"))
        cal.add_component(ve)
        if not ev.get("recurringEventId"):
            by_id[ev["id"]] = ve
    # cancelled instances of a series -> EXDATE on the master event
    for ev in cancelled:
        master = by_id.get(ev["recurringEventId"])
        if master is not None:
            master.add("exdate", gtime(ev["originalStartTime"], tz))

    if hasattr(cal, "add_missing_timezones"):
        try:
            cal.add_missing_timezones()
        except Exception:
            pass
    return cal.to_ical()


def _list_all(request_fn, **kwargs) -> list[dict]:
    items, token = [], None
    while True:
        resp = request_fn(pageToken=token, **kwargs).execute(num_retries=3)
        items.extend(resp.get("items", []))
        token = resp.get("nextPageToken")
        if not token:
            return items


def fetch(cfg: dict, out_dir: Path) -> dict:
    from ..google_auth import service

    svc = service("calendar", "v3")
    calendars = _list_all(svc.calendarList().list, showHidden=True, maxResults=250)
    only = set(cfg.get("calendar_ids") or [])
    skip = set(cfg.get("exclude_ids") or [])
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "_calendar_list.json").write_text(
        json.dumps(calendars, ensure_ascii=False, indent=1), encoding="utf-8"
    )

    taken: set = set()
    result = []
    for meta in calendars:
        cid = meta["id"]
        if (only and cid not in only) or cid in skip:
            continue
        items = _list_all(
            svc.events().list,
            calendarId=cid,
            singleEvents=False,
            showDeleted=False,
            maxResults=2500,
        )
        name = meta.get("summaryOverride") or meta.get("summary") or cid
        entry = write_ics(out_dir, name, build_calendar(meta, items), taken)
        stem = entry["file"][:-4]
        (out_dir / f"{stem}.json").write_text(
            json.dumps({"calendar": meta, "items": items}, ensure_ascii=False, indent=1),
            encoding="utf-8",
        )
        entry["id"] = cid
        result.append(entry)
    return {"calendars": result}
