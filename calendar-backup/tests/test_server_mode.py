"""Server produces backups, the Mac mirrors them from Drive (folder mode stands in for Drive)."""

import http.server
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path

from calbackup import archives, config, secrets
from calbackup.server import backup_due

ROOT = Path(tempfile.mkdtemp(prefix="calbackup-srv-"))
DRIVE = ROOT / "drive"

ICS = (
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//t//EN\r\n"
    "BEGIN:VEVENT\r\nUID:a@x\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:20260105T090000Z\r\n"
    "SUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
)


class _H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(ICS.encode())

    def log_message(self, *a):
        pass


def use(machine: str, **over):
    """Switch CALBACKUP_HOME to a machine and write its config."""
    os.environ["CALBACKUP_HOME"] = str(ROOT / machine / "home")
    cfg = config.load_config()
    cfg.update(local_dir=str(ROOT / machine / "backups"), notify_on_error=False, host_tag=machine)
    cfg["drive"] = {"enabled": True, "mode": "folder", "folder_path": str(DRIVE),
                    "folder_name": "Calendar Backups", "keep": 120}
    cfg["sources"] = [{"id": "links", "type": "ics", "urls": {"Работа": URL}}]
    cfg.update(over)
    config.save_config(cfg)
    return cfg


_ICS_SERVER = None


def setUpModule():
    global URL, _ICS_SERVER
    _ICS_SERVER = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _H)
    threading.Thread(target=_ICS_SERVER.serve_forever, daemon=True).start()
    URL = f"http://127.0.0.1:{_ICS_SERVER.server_address[1]}/c.ics"


def tearDownModule():
    _ICS_SERVER.shutdown()
    _ICS_SERVER.server_close()
    os.environ.pop("CALBACKUP_HOME", None)


class Archives(unittest.TestCase):
    def test_names(self):
        n = archives.archive_name(1794225600, "srv")  # 2026-11-09 12:00:00 UTC
        self.assertEqual(n, "calendar-backup-20261109-120000Z-srv.zip")
        self.assertEqual(archives.archive_ts(n), 1794225600)
        self.assertEqual(archives.archive_tag(n), "srv")
        legacy = "calendar-backup-20261106-115100.zip"
        self.assertTrue(archives.is_archive(legacy))
        self.assertIsNone(archives.archive_tag(legacy))
        self.assertFalse(archives.is_archive("calendar-backup-x.zip"))
        self.assertFalse(archives.is_archive("../calendar-backup-20261109-120000Z-a.zip"))
        order = archives.sort_newest_first([legacy, n, "notes.txt"])
        self.assertEqual(order, [n, legacy])


class FallbackSchedule(unittest.TestCase):
    cfg = {"produce": "fallback", "interval_hours": 6, "fallback_grace_minutes": 30}

    def test_fresh_server_backup_postpones(self):
        now = 1_000_000.0
        hist = [{"trigger": "sync", "archive": "a", "started_ts": now - 3600, "status": "ok"}]
        self.assertEqual(backup_due(self.cfg, hist, {}, now), now - 3600 + 6 * 3600 + 1800)

    def test_remote_seen_but_not_downloaded_counts(self):
        now = 1_000_000.0
        state = {"newest_remote": {"ts": now - 600}}
        self.assertGreater(backup_due(self.cfg, [], state, now), now)

    def test_stale_server_triggers_and_failed_fallback_backs_off(self):
        now = 1_000_000.0
        hist = [{"trigger": "sync", "archive": "a", "started_ts": now - 7 * 3600, "status": "ok"}]
        self.assertLess(backup_due(self.cfg, hist, {}, now), now)
        hist.insert(0, {"trigger": "fallback", "started_ts": now - 60, "status": "error"})
        self.assertEqual(backup_due(self.cfg, hist, {}, now), now - 60 + 3600)

    def test_never_and_always(self):
        self.assertIsNone(backup_due({"produce": "never"}, [], {}, 5.0))
        self.assertEqual(backup_due({"produce": "always", "interval_hours": 6}, [], {}, 5.0), 5.0)


class MirrorSync(unittest.TestCase):
    def test_server_then_mirror(self):
        from calbackup.engine import run_backup
        from calbackup.sync import sync_from_drive

        use("srv")
        for _ in range(3):
            self.assertEqual(run_backup("schedule")["status"], "ok")
            time.sleep(1.05)
        remote = sorted(p.name for p in (DRIVE / "Calendar Backups").glob("*.zip"))
        self.assertEqual(len(remote), 3)
        self.assertTrue(all(n.endswith("Z-srv.zip") for n in remote))

        use("mac", produce="fallback", sync_from_drive=True, keep_local=2)
        st = sync_from_drive("manual")
        self.assertTrue(st["ok"], st)
        self.assertEqual(st["downloaded"], 2)  # keep_local=2: only the newest two
        mac = ROOT / "mac" / "backups"
        self.assertEqual(sorted(p.name for p in mac.glob("*.zip")), remote[1:])
        hist = config.load_history()
        self.assertEqual([e["trigger"] for e in hist], ["sync", "sync"])
        self.assertEqual(hist[0]["origin"], "srv")
        self.assertEqual(hist[0]["archive"], remote[2])
        self.assertEqual(hist[0]["events"], 1)
        self.assertGreater(hist[0]["started_ts"], hist[1]["started_ts"])
        latest = json.loads((mac / "latest" / "manifest.json").read_text())
        self.assertEqual(latest["origin"], "srv")
        self.assertTrue((mac / "latest" / "links" / "Работа.ics").exists())
        self.assertEqual(st["newest_remote"]["name"], remote[2])

        # nothing new: nothing downloaded, history unchanged
        st = sync_from_drive("schedule")
        self.assertEqual((st["downloaded"], st["ok"]), (0, True))
        self.assertEqual(len(config.load_history()), 2)

        # the fresh server copy postpones the Mac's own backup
        cfg = config.load_config()
        due = backup_due(cfg, config.load_history(), config.load_sync_state(), time.time())
        self.assertGreater(due, time.time() + 5 * 3600)

        # a corrupted file on Drive is rejected and not kept
        use("srv")
        time.sleep(1.05)
        run_backup("schedule")
        newest = archives.sort_newest_first(p.name for p in (DRIVE / "Calendar Backups").glob("*.zip"))[0]
        (DRIVE / "Calendar Backups" / newest).write_bytes(b"not a zip")
        use("mac", produce="fallback", sync_from_drive=True, keep_local=2)
        st = sync_from_drive("schedule")
        self.assertFalse(st["ok"])
        self.assertFalse((mac / newest).exists())
        self.assertFalse(list(mac.glob("*.part")))


class SchedulerLoop(unittest.TestCase):
    def test_first_backup_starts_without_history(self):
        from calbackup import server

        use("loop")
        sched = server.Scheduler()
        threading.Thread(target=sched.loop, daemon=True).start()
        for _ in range(100):
            if config.load_history():
                break
            time.sleep(0.1)
        hist = config.load_history()
        self.assertTrue(hist, "the scheduler did not start the first backup")
        self.assertEqual(hist[0]["trigger"], "schedule")

    def test_mirror_syncs_at_start_and_does_not_produce_when_fresh(self):
        from calbackup import server

        use("mirror", produce="fallback", sync_from_drive=True)
        sched = server.Scheduler()
        threading.Thread(target=sched.loop, daemon=True).start()
        for _ in range(100):
            if config.load_sync_state().get("last_sync_ts") and not sched.running:
                break
            time.sleep(0.1)
        time.sleep(0.5)
        st = config.load_sync_state()
        self.assertTrue(st.get("last_sync_ts"))
        self.assertGreaterEqual(st.get("downloaded", 0), 1)  # (the corrupted file from MirrorSync is skipped)
        hist = config.load_history()
        self.assertTrue(hist)
        self.assertTrue(all(e["trigger"] == "sync" for e in hist), hist)
        self.assertIsNone(sched.current)


class SecretsFile(unittest.TestCase):
    def test_file_store_mode_600(self):
        os.environ["CALBACKUP_HOME"] = str(ROOT / "sec")
        os.environ["CALBACKUP_SECRETS"] = "file"
        try:
            where = secrets.set_secret("icloud", "abcd-efgh")
            self.assertIn("secrets.json", where)
            self.assertEqual(secrets.get_secret("icloud"), "abcd-efgh")
            self.assertEqual(os.stat(ROOT / "sec" / "secrets.json").st_mode & 0o777, 0o600)
            with self.assertRaises(RuntimeError):
                secrets.get_secret("missing")
        finally:
            os.environ.pop("CALBACKUP_SECRETS")


class ImportToken(unittest.TestCase):
    def test_validation(self):
        from calbackup import google_auth

        os.environ["CALBACKUP_HOME"] = str(ROOT / "tok")
        with self.assertRaises(SystemExit):
            google_auth.import_token("nope")
        with self.assertRaises(SystemExit):
            google_auth.import_token(json.dumps({"client_id": "x"}))
        with self.assertRaises(SystemExit):
            google_auth.import_token(json.dumps({"refresh_token": "r", "client_id": "c", "client_secret": "s",
                                                 "scopes": [google_auth.SCOPES[0]]}))
        google_auth.import_token(json.dumps({"refresh_token": "r", "client_id": "c", "client_secret": "s",
                                             "token_uri": "https://oauth2.googleapis.com/token",
                                             "scopes": google_auth.SCOPES}))
        p = google_auth.token_path()
        self.assertEqual(os.stat(p).st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(p.read_text())["refresh_token"], "r")


URL = ""

if __name__ == "__main__":
    unittest.main(verbosity=2)
