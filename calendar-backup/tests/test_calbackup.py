import http.server
import json
import os
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
import zipfile
from datetime import date, datetime
from pathlib import Path

TMP = tempfile.mkdtemp(prefix="calbackup-test-")
os.environ["CALBACKUP_HOME"] = os.path.join(TMP, "home")

from icalendar import Calendar  # noqa: E402

from calbackup import config  # noqa: E402
from calbackup.sources import caldav_src, google  # noqa: E402

SAMPLE_ICS = (
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//t//EN\r\n"
    "BEGIN:VEVENT\r\nUID:a@x\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:20260105T090000Z\r\n"
    "DTEND:20260105T100000Z\r\nSUMMARY:Встреча\r\nEND:VEVENT\r\n"
    "BEGIN:VEVENT\r\nUID:b@x\r\nDTSTAMP:20260101T000000Z\r\nDTSTART;VALUE=DATE:20260110\r\n"
    "SUMMARY:Весь день\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
)


class GoogleConversion(unittest.TestCase):
    def test_events(self):
        meta = {"id": "me@x", "summary": "Мой", "timeZone": "Europe/Vilnius",
                "defaultReminders": [{"method": "popup", "minutes": 10}]}
        items = [
            {"id": "s1", "iCalUID": "s1@google.com", "status": "confirmed", "summary": "Еженедельная",
             "start": {"dateTime": "2026-11-02T10:00:00+02:00", "timeZone": "Europe/Vilnius"},
             "end": {"dateTime": "2026-11-02T11:00:00+02:00", "timeZone": "Europe/Vilnius"},
             "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=5"],
             "reminders": {"useDefault": True},
             "organizer": {"email": "me@x", "displayName": "Я"},
             "attendees": [{"email": "a@y", "responseStatus": "accepted"},
                           {"email": "b@y", "responseStatus": "declined", "optional": True}],
             "hangoutLink": "https://meet.google.com/abc-defg-hij",
             "created": "2026-10-01T08:00:00.123Z", "updated": "2026-10-02T08:00:00Z"},
            {"id": "s1_x", "iCalUID": "s1@google.com", "status": "confirmed", "summary": "Перенесено",
             "recurringEventId": "s1",
             "originalStartTime": {"dateTime": "2026-11-09T10:00:00+02:00", "timeZone": "Europe/Vilnius"},
             "start": {"dateTime": "2026-11-09T12:00:00+02:00"}, "end": {"dateTime": "2026-11-09T13:00:00+02:00"},
             "updated": "2026-10-03T08:00:00Z"},
            {"id": "s1_c", "status": "cancelled", "recurringEventId": "s1",
             "originalStartTime": {"dateTime": "2026-11-16T10:00:00+02:00", "timeZone": "Europe/Vilnius"}},
            {"id": "d1", "iCalUID": "d1@google.com", "status": "confirmed", "summary": "Отпуск",
             "start": {"date": "2026-12-24"}, "end": {"date": "2026-12-27"}, "transparency": "transparent",
             "visibility": "private", "reminders": {"useDefault": False}},
        ]
        cal = Calendar.from_ical(google.build_calendar(meta, items))
        evs = [c for c in cal.walk("VEVENT")]
        self.assertEqual(len(evs), 3)
        master, exc, allday = evs
        self.assertEqual(str(master["uid"]), "s1@google.com")
        self.assertIn("RRULE", master)
        self.assertEqual(master["dtstart"].dt.tzinfo.key, "Europe/Vilnius")
        self.assertIn("EXDATE", master)
        self.assertEqual(len(master.walk("VALARM")), 1)
        self.assertEqual(len(master.get("attendee")), 2)
        self.assertIn("meet.google.com", str(master["description"]))
        self.assertEqual(str(exc["uid"]), "s1@google.com")
        self.assertEqual(exc["recurrence-id"].dt, datetime.fromisoformat("2026-11-09T10:00:00+02:00"))
        self.assertEqual(allday["dtstart"].dt, date(2026, 12, 24))
        self.assertEqual(str(allday["transp"]), "TRANSPARENT")
        self.assertEqual(str(allday["class"]), "PRIVATE")
        self.assertEqual(len(allday.walk("VALARM")), 0)
        self.assertTrue(cal.walk("VTIMEZONE"), "VTIMEZONE must be embedded")


class CalDavMerge(unittest.TestCase):
    def test_merge_dedups_timezones(self):
        one = ("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:x\r\nBEGIN:VTIMEZONE\r\nTZID:Europe/Vilnius\r\n"
               "BEGIN:STANDARD\r\nDTSTART:19701025T040000\r\nTZOFFSETFROM:+0300\r\nTZOFFSETTO:+0200\r\n"
               "END:STANDARD\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nUID:{u}\r\nDTSTAMP:20260101T000000Z\r\n"
               "DTSTART;TZID=Europe/Vilnius:20260105T090000\r\nSUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")
        data, errors = caldav_src.merge_objects("Дом", [one.format(u=1), one.format(u=2), "garbage"])
        cal = Calendar.from_ical(data)
        self.assertEqual(len(cal.walk("VEVENT")), 2)
        self.assertEqual(len(cal.walk("VTIMEZONE")), 1)
        self.assertEqual(errors, 1)


class _ICSHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = SAMPLE_ICS.encode() if self.path == "/cal.ics" else b"<html>nope</html>"
        self.send_response(200)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


class EndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ics = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _ICSHandler)
        threading.Thread(target=cls.ics.serve_forever, daemon=True).start()
        port = cls.ics.server_address[1]
        cls.local = Path(TMP) / "backups"
        cls.drive = Path(TMP) / "drive"
        cfg = config.load_config()
        cfg.update(local_dir=str(cls.local), keep_local=2, notify_on_error=False, panel_port=0)
        cfg["drive"] = {"enabled": True, "mode": "folder", "folder_path": str(cls.drive),
                        "folder_name": "Calendar Backups", "keep": 2}
        cfg["sources"] = [
            {"id": "links", "type": "ics", "urls": {"Работа": f"http://127.0.0.1:{port}/cal.ics"}},
            {"id": "broken", "type": "ics", "enabled": True, "urls": {"Плохой": f"http://127.0.0.1:{port}/x"}},
        ]
        config.save_config(cfg)

    @classmethod
    def tearDownClass(cls):
        cls.ics.shutdown()

    def test_1_partial_then_ok_and_retention(self):
        from calbackup.engine import run_backup

        e = run_backup("manual")
        self.assertEqual(e["status"], "partial", e)
        self.assertIn("broken", e["message"])
        self.assertEqual(e["events"], 2)
        arch = self.local / e["archive"]
        with zipfile.ZipFile(arch) as z:
            names = set(z.namelist())
        self.assertIn("links/Работа.ics", names)
        self.assertIn("manifest.json", names)
        self.assertTrue((self.drive / "Calendar Backups" / e["archive"]).exists())
        self.assertTrue((self.local / "latest" / "links" / "Работа.ics").exists())

        cfg = config.load_config()
        cfg["sources"][1]["enabled"] = False
        config.save_config(cfg)
        for _ in range(2):
            time.sleep(1.1)  # archive names have one-second resolution
            e = run_backup("schedule")
            self.assertEqual(e["status"], "ok", e)
        self.assertEqual(len(list(self.local.glob("calendar-backup-*.zip"))), 2)
        self.assertEqual(len(list((self.drive / "Calendar Backups").glob("*.zip"))), 2)
        self.assertEqual(len(config.load_history()), 3)
        self.assertFalse(list(self.local.glob(".staging-*")))

    def test_2_panel(self):
        from calbackup import server

        sched = server.Scheduler()
        gcalls = []
        gsched = server.Scheduler(lambda t, progress=None: gcalls.append(t), lambda: None, "gmail")
        httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(sched, "TKN", 0, gsched))
        port = httpd.server_address[1]
        # rebuild the handler with the real port so the Host check matches
        httpd.RequestHandlerClass = server.make_handler(sched, "TKN", port, gsched)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{port}"

        def req(path, body=None, token="TKN", host=None):
            r = urllib.request.Request(base + path, method="POST" if body is not None else "GET",
                                       data=json.dumps(body).encode() if body is not None else None)
            if token:
                r.add_header("X-CalBackup-Token", token)
            if host:
                r.add_header("Host", host)
            try:
                with urllib.request.urlopen(r) as resp:
                    return resp.status, resp.read()
            except urllib.error.HTTPError as ex:
                return ex.code, ex.read()

        code, html = req("/")
        self.assertEqual(code, 200)
        self.assertIn(b"TKN", html)
        code, st = req("/api/status")
        st = json.loads(st)
        self.assertEqual(len(st["history"]), 3)
        self.assertEqual(req("/api/status", host="evil.example:80")[0], 403)
        self.assertEqual(req("/api/run", {}, token="bad")[0], 403)
        self.assertEqual(req("/api/settings", {"interval_hours": 0})[0], 400)
        code, st = req("/api/settings", {"interval_hours": 3, "keep_local": 5, "sources": {"links": True}})
        self.assertEqual(code, 200)
        self.assertEqual(config.load_config()["interval_hours"], 3.0)
        # next run = last start + 3 h
        last = config.load_history()[0]["started_ts"]
        self.assertAlmostEqual(json.loads(st)["next_run_ts"], last + 3 * 3600, delta=1)

        self.assertEqual(req("/api/run", {})[0], 202)
        self.assertEqual(req("/api/run", {})[0], 409)
        for _ in range(100):
            if not sched.running:
                break
            time.sleep(0.1)
        self.assertEqual(config.load_history()[0]["trigger"], "manual")

        # Gmail: off by default, switched on from the panel, started manually
        st = json.loads(req("/api/status")[1])
        self.assertFalse(st["gmail"]["enabled"])
        self.assertIsNone(st["gmail"]["next_run_ts"])
        self.assertEqual(req("/api/gmail/run", {})[0], 409)
        self.assertEqual(req("/api/settings", {"gmail_interval_hours": 0.1})[0], 400)
        code, st = req("/api/settings", {"gmail_enabled": True, "gmail_interval_hours": 2})
        self.assertEqual(code, 200)
        self.assertTrue(json.loads(st)["gmail"]["enabled"])
        self.assertEqual(config.load_config()["gmail"]["interval_hours"], 2.0)
        self.assertEqual(req("/api/gmail/run", {})[0], 202)
        for _ in range(100):
            if not gsched.running:
                break
            time.sleep(0.05)
        self.assertEqual(gcalls, ["manual"])
        self.assertEqual(req("/api/open-folder", {"target": "gmail"})[0], 200)
        httpd.shutdown()


if __name__ == "__main__":
    unittest.main(verbosity=2)
