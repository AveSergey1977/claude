import errno
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault("CALBACKUP_HOME", os.path.join(tempfile.mkdtemp(prefix="calbackup-test-"), "home"))

from calbackup import config, folders, gmail, server  # noqa: E402


class FakeSched:
    def __init__(self, running=False):
        self.running = running


def make_store(base: Path, account="me@example.com") -> Path:
    st = gmail.Store(base / account)
    st.db.execute("INSERT INTO messages(id, path, size) VALUES('a1', 'messages/2026/10/a1.eml', 3)")
    st.commit()
    st.close()
    f = base / account / "messages" / "2026" / "10" / "a1.eml"
    f.parent.mkdir(parents=True)
    f.write_bytes(b"x\r\n")
    return base / account


class Folders(unittest.TestCase):
    def setUp(self):
        self.old_home = os.environ.get("HOME")
        self.t = Path(tempfile.mkdtemp(prefix="folders-"))
        os.environ["HOME"] = str(self.t / "user")        # standard folders live here
        (self.t / "user").mkdir()
        self.saved_cfg = config.load_config()
        cfg = config.load_config()
        cfg["local_dir"] = str(self.t / "cal-a")
        cfg["gmail"] = {"enabled": False, "local_dir": str(self.t / "mail-a")}
        config.save_config(cfg)
        (self.t / "cal-a" / "latest" / "google").mkdir(parents=True)
        (self.t / "cal-a" / "latest" / "google" / "x.ics").write_text("ics")
        for n in ("20261101-000000", "20261102-000000"):
            (self.t / "cal-a" / f"calendar-backup-{n}.zip").write_bytes(b"zip")
        (self.t / "cal-a" / "unrelated.txt").write_text("keep")
        make_store(self.t / "mail-a")

    def tearDown(self):
        config.save_config(self.saved_cfg)
        if self.old_home is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = self.old_home

    def test_validate(self):
        for bad, why in (("relative/dir", "полный путь"), ("/", "отдельную папку"), ("~", "отдельную папку"),
                         (str(config.app_home() / "x"), "служебная"),
                         ("/Volumes/NoSuchDisk-xyz/Backups", "не подключён")):
            with self.assertRaisesRegex(ValueError, why):
                folders.validate(bad, "Папка")
        self.assertFalse(Path("/Volumes/NoSuchDisk-xyz").exists())
        p = folders.validate("~/Backups/Почта", "Папка")
        self.assertEqual(p, self.t / "user" / "Backups" / "Почта")
        self.assertTrue(p.is_dir())

    def test_change_and_move(self):
        cfg, notices = server.apply_settings(
            {"local_dir": str(self.t / "cal-b"), "gmail_dir": str(self.t / "mail-b")}, FakeSched(), FakeSched())
        self.assertEqual(cfg["local_dir"], str(self.t / "cal-b"))
        saved = config.load_config()
        self.assertEqual((saved["local_dir"], saved["gmail"]["local_dir"]), (str(self.t / "cal-b"), str(self.t / "mail-b")))
        self.assertEqual(len(list((self.t / "cal-b").glob("calendar-backup-*.zip"))), 2)
        self.assertTrue((self.t / "cal-b" / "latest" / "google" / "x.ics").exists())
        self.assertTrue((self.t / "cal-a" / "unrelated.txt").exists())   # only our files move
        self.assertTrue((self.t / "mail-b" / "me@example.com" / "messages" / "2026" / "10" / "a1.eml").exists())
        self.assertFalse((self.t / "mail-a" / "me@example.com").exists())
        self.assertEqual(len(notices), 2, notices)
        self.assertEqual(gmail.status(saved)["accounts"][0]["stored"], 1)

        # empty field -> the standard folder, existing copies follow
        cfg, notices = server.apply_settings({"local_dir": "", "gmail_dir": ""})
        self.assertEqual(cfg["local_dir"], "~/CalendarBackups")
        self.assertEqual(cfg["gmail"]["local_dir"], "~/MailBackups")
        self.assertEqual(len(list((self.t / "user" / "CalendarBackups").glob("*.zip"))), 2)
        self.assertTrue((self.t / "user" / "MailBackups" / "me@example.com" / "index.sqlite").exists())
        st = server.status_payload(server.Scheduler(lambda t, progress=None: None), server.Scheduler(
            lambda t, progress=None: None, lambda: None, "gmail"))
        self.assertEqual((st["local"]["setting"], st["gmail"]["dir_setting"]), ("", ""))
        # unchanged values are not re-validated or moved
        cfg, notices = server.apply_settings({"local_dir": "~/CalendarBackups/", "gmail_dir": ""})
        self.assertEqual(notices, [])

    def test_without_move(self):
        cfg, notices = server.apply_settings({"gmail_dir": str(self.t / "mail-c"), "move_existing": False})
        self.assertTrue((self.t / "mail-a" / "me@example.com" / "index.sqlite").exists())
        self.assertIn("загружены заново", notices[0])

    def test_busy_and_conflicts(self):
        with self.assertRaises(server.Busy):
            server.apply_settings({"local_dir": str(self.t / "cal-x")}, FakeSched(True), FakeSched())
        with self.assertRaises(server.Busy):
            server.apply_settings({"gmail_dir": str(self.t / "mail-x")}, FakeSched(), FakeSched(True))
        # a busy job does not block a change of the other folder or other settings
        server.apply_settings({"interval_hours": 2}, FakeSched(True), FakeSched(True))
        with self.assertRaisesRegex(ValueError, "служебных"):
            server.apply_settings({"gmail_dir": str(self.t / "cal-a" / "latest" / "m")})
        self.assertEqual(config.load_config()["local_dir"], str(self.t / "cal-a"))
        # a copy already in the target is used, the old one stays
        make_store(self.t / "mail-y")
        cfg, notices = server.apply_settings({"gmail_dir": str(self.t / "mail-y")})
        self.assertIn("уже есть копия", notices[0])
        self.assertTrue((self.t / "mail-a" / "me@example.com").exists())

    def test_other_disk(self):
        real = os.rename

        def rename(a, b):
            if "mail-a" in str(a):
                raise OSError(errno.EXDEV, "Invalid cross-device link")
            return real(a, b)

        with mock.patch("calbackup.folders.os.rename", side_effect=rename):
            cfg, notices = server.apply_settings({"gmail_dir": str(self.t / "mail-d")})
        self.assertIn("другом диске", notices[0])
        self.assertTrue((self.t / "mail-a" / "me@example.com" / "index.sqlite").exists())
        self.assertEqual(config.load_config()["gmail"]["local_dir"], str(self.t / "mail-d"))

    def test_disconnected_disk_at_run_time(self):
        from calbackup.engine import run_backup

        cfg = config.load_config()
        cfg["local_dir"] = "/Volumes/NoSuchDisk-xyz/Backups"
        cfg["notify_on_error"] = False
        config.save_config(cfg)
        e = run_backup("schedule")
        self.assertEqual(e["status"], "error")
        self.assertIn("не подключён", e["message"])
        self.assertFalse(Path("/Volumes/NoSuchDisk-xyz").exists())
        self.assertEqual(config.load_history()[0]["message"], e["message"])

        from test_gmail import FakeMailbox

        g = {**gmail.DEFAULTS, "local_dir": "/Volumes/NoSuchDisk-xyz/Mail"}
        with self.assertRaisesRegex(RuntimeError, "не подключён"):
            gmail.sync(g, FakeMailbox())

    def test_dialog_off_mac(self):
        if os.uname().sysname == "Darwin":
            self.skipTest("macOS")
        with self.assertRaisesRegex(RuntimeError, "только на Mac"):
            folders.choose_folder_dialog("x", None)
        self.assertEqual(folders._aq('a"b\\c'), '"a\\"b\\\\c"')


if __name__ == "__main__":
    unittest.main(verbosity=2)
