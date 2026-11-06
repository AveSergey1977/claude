"""All calendars connected to Calendar.app on this Mac (iCloud, Google, Exchange/Outlook,
Yahoo, subscriptions, Birthdays...) through EventKit.

EventKit returns occurrences, not series: recurring events are stored expanded within the
window [now - years_back, now + years_forward]. For lossless copies of iCloud and Google
prefer the "caldav" and "google" sources; this source catches everything else.
Requires: pip install pyobjc-framework-EventKit, and access in
System Settings -> Privacy & Security -> Calendars."""

from __future__ import annotations

import json
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import write_ics

PRODID = "-//calendar-backup//macOS EventKit export//RU"
CHUNK_DAYS = 365  # EventKit limits a predicate to ~4 years

_STATUS = {1: "CONFIRMED", 2: "TENTATIVE", 3: "CANCELLED"}
_AUTHORIZED = {3}  # EKAuthorizationStatusAuthorized / FullAccess


def _py(nsdate):
    if nsdate is None:
        return None
    return datetime.fromtimestamp(nsdate.timeIntervalSince1970(), tz=timezone.utc)


def _ns(dt: datetime):
    from Foundation import NSDate

    return NSDate.dateWithTimeIntervalSince1970_(dt.timestamp())


def _request_access(store) -> None:
    import EventKit

    status = EventKit.EKEventStore.authorizationStatusForEntityType_(EventKit.EKEntityTypeEvent)
    if status in _AUTHORIZED:
        return
    done = threading.Event()
    granted = {"ok": False, "err": None}

    def cb(ok, err):
        granted["ok"], granted["err"] = bool(ok), err
        done.set()

    if hasattr(store, "requestFullAccessToEventsWithCompletion_"):  # macOS 14+
        store.requestFullAccessToEventsWithCompletion_(cb)
    else:
        store.requestAccessToEntityType_completion_(EventKit.EKEntityTypeEvent, cb)
    done.wait(120)
    if not granted["ok"]:
        raise RuntimeError(
            "Нет доступа к Календарю. Разрешите его: Системные настройки → "
            "Конфиденциальность и безопасность → Календари (python3), "
            "затем выполните в Терминале: calbackup grant-macos"
        )


def _tz_name(ev):
    try:
        tz = ev.timeZone()
        return str(tz.name()) if tz is not None else None
    except Exception:
        return None


def _to_local(dt: datetime, tzname: str | None):
    if tzname:
        try:
            from zoneinfo import ZoneInfo

            return dt.astimezone(ZoneInfo(tzname))
        except Exception:
            pass
    return dt


def _vevent(ev, cal_name: str):
    from icalendar import Event

    start, end = _py(ev.startDate()), _py(ev.endDate())
    tzname = _tz_name(ev)
    ext = str(ev.calendarItemExternalIdentifier() or ev.eventIdentifier() or "")
    recurring = bool(ev.hasRecurrenceRules())
    occ = _py(ev.occurrenceDate()) if recurring else None

    ve = Event()
    ve.add("uid", f"{ext}-{int(occ.timestamp())}" if occ else ext)
    if recurring:
        ve.add("x-calbackup-series-uid", ext)
    ve.add("dtstamp", _py(ev.lastModifiedDate()) or datetime.now(timezone.utc))
    if ev.isAllDay():
        s = _to_local(start, tzname).date() if tzname else start.astimezone().date()
        e = (_to_local(end, tzname) if tzname else end.astimezone()).date() + timedelta(days=1)
        ve.add("dtstart", s)
        ve.add("dtend", e)
    else:
        ve.add("dtstart", _to_local(start, tzname))
        ve.add("dtend", _to_local(end, tzname))
    if ev.title():
        ve.add("summary", str(ev.title()))
    if ev.location():
        ve.add("location", str(ev.location()))
    if ev.notes():
        ve.add("description", str(ev.notes()))
    if ev.URL():
        ve.add("url", str(ev.URL().absoluteString()))
    st = _STATUS.get(int(ev.status()))
    if st:
        ve.add("status", st)
    try:
        org = ev.organizer()
        if org is not None and org.URL() is not None:
            ve.add("organizer", str(org.URL().absoluteString()))
        for a in ev.attendees() or []:
            if a.URL() is not None:
                ve.add("attendee", str(a.URL().absoluteString()))
    except Exception:
        pass
    ve.add("x-calbackup-calendar", cal_name)
    return ve


def fetch(cfg: dict, out_dir: Path) -> dict:
    import EventKit
    from icalendar import Calendar

    store = EventKit.EKEventStore.alloc().init()
    _request_access(store)
    store.refreshSourcesIfNecessary()

    now = datetime.now(timezone.utc)
    lo = now - timedelta(days=365 * float(cfg.get("years_back", 10)))
    hi = now + timedelta(days=365 * float(cfg.get("years_forward", 5)))
    only = set(cfg.get("calendars") or [])
    skip_accounts = set(cfg.get("exclude_accounts") or [])

    taken: set = set()
    result, index = [], []
    for c in store.calendarsForEntityType_(EventKit.EKEntityTypeEvent):
        title = str(c.title())
        account = str(c.source().title()) if c.source() is not None else ""
        if (only and title not in only) or account in skip_accounts:
            continue
        cal = Calendar()
        cal.add("prodid", PRODID)
        cal.add("version", "2.0")
        cal.add("x-wr-calname", title)
        seen: set = set()
        t = lo
        while t < hi:
            t2 = min(t + timedelta(days=CHUNK_DAYS), hi)
            pred = store.predicateForEventsWithStartDate_endDate_calendars_(_ns(t), _ns(t2), [c])
            for ev in store.eventsMatchingPredicate_(pred) or []:
                ve = _vevent(ev, title)
                uid = str(ve["uid"])
                if uid in seen:  # events spanning chunk borders come twice
                    continue
                seen.add(uid)
                cal.add_component(ve)
            t = t2
        if hasattr(cal, "add_missing_timezones"):
            try:
                cal.add_missing_timezones()
            except Exception:
                pass
        entry = write_ics(out_dir, f"{account} - {title}" if account else title, cal.to_ical(), taken)
        entry["id"] = str(c.calendarIdentifier())
        entry["account"] = account
        result.append(entry)
        index.append({"title": title, "account": account, "id": entry["id"], "file": entry["file"]})
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "_calendars.json").write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")
    return {"calendars": result}


def grant() -> None:
    """Run once from Terminal so macOS shows the permission prompt."""
    import EventKit

    store = EventKit.EKEventStore.alloc().init()
    _request_access(store)
    cals = store.calendarsForEntityType_(EventKit.EKEntityTypeEvent)
    print("Доступ есть. Календари на этом Mac:")
    for c in cals:
        src = c.source().title() if c.source() is not None else ""
        print(f"  [{src}] {c.title()}")
