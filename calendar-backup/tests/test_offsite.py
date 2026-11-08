"""Second copy through a real restic binary (RESTIC_BIN or restic in PATH; skipped without it)."""

import json
import os
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import time
import sys
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

os.environ.setdefault("CALBACKUP_HOME", os.path.join(tempfile.mkdtemp(prefix="calbackup-test-"), "home"))

from calbackup import config, gmail, offsite  # noqa: E402

RESTIC = os.environ.get("RESTIC_BIN") or shutil.which("restic")
try:
    if RESTIC:
        offsite._check_version(RESTIC)
except RuntimeError:  # too old for the exit codes the module relies on
    RESTIC = None
SECRETS = {"restic": "correct horse battery staple", "other": "another password"}


def get_secret(name):
    if name not in SECRETS:
        raise RuntimeError("not found")
    return SECRETS[name]


def restic(repo, *args, password="correct horse battery staple"):
    env = {"PATH": os.environ["PATH"], "HOME": os.environ.get("HOME", "/root"), "RESTIC_REPOSITORY": repo,
           "RESTIC_PASSWORD": password, "RESTIC_CACHE_DIR": tempfile.gettempdir() + "/restic-test-cache"}
    return subprocess.run([RESTIC, *args], env=env, capture_output=True, text=True)


@unittest.skipUnless(RESTIC, "restic >= 0.17.1 not installed")
class Offsite(unittest.TestCase):
    def setUp(self):
        from test_gmail import FakeMailbox

        self.t = Path(tempfile.mkdtemp(prefix="offsite-"))
        self.saved_cfg = config.load_config()
        cal = self.t / "cal"
        (cal / "latest" / "google").mkdir(parents=True)
        (cal / "latest" / "google" / "a.ics").write_text("ics")
        (cal / ".staging-20261108-000000").mkdir()
        (cal / "calendar-backup-20261108-000000.zip").write_bytes(os.urandom(2000))
        (cal / "calendar-backup-20261108-000000.zip.part").write_bytes(b"partial")
        g = {**gmail.DEFAULTS, "local_dir": str(self.t / "mail"), "min_free_gb": 0}
        self.mb = FakeMailbox()
        for n in range(1, 6):
            self.mb.add(n)
        gmail.sync(g, self.mb)
        self.repo = str(self.t / "repo")
        cfg = config.load_config()
        cfg.update(local_dir=str(cal), notify_on_error=False)
        cfg["gmail"] = {"enabled": True, "local_dir": str(self.t / "mail")}
        cfg["offsite"] = {"enabled": True, "restic_path": RESTIC, "check_subset": "100%",
                          "targets": [{"id": "disk", "repository": self.repo}]}
        config.save_config(cfg)
        offsite.save_state({})

    def tearDown(self):
        config.save_config(self.saved_cfg)

    def run_offsite(self):
        return offsite.run_offsite("manual", get_secret=get_secret)

    def test_backup_contents_restore_and_schedule(self):
        e = self.run_offsite()
        self.assertEqual(e["status"], "ok", e)
        rec = e["targets"][0]
        self.assertTrue(rec["created"] and rec["pruned"] and rec["checked"], rec)
        self.assertEqual(rec["files_new"], rec["files_total"])

        out = restic(self.repo, "ls", "--json", "latest")
        self.assertEqual(out.returncode, 0, out.stderr)
        names = [json.loads(l).get("path", "") for l in out.stdout.splitlines() if l.startswith("{")]
        joined = "\n".join(names)
        self.assertIn("calendar-backup-20261108-000000.zip", joined)
        self.assertEqual(sum(n.endswith(".eml") for n in names), 5)
        self.assertIn("offsite-meta/gmail-index/me@example.com/index.snapshot.sqlite", joined)
        self.assertIn("offsite-meta/config.json", joined)
        self.assertIn("offsite-meta/RESTORE.txt", joined)
        for bad in ("/latest/", ".staging-", ".zip.part", "me@example.com/index.sqlite"):
            self.assertNotIn(bad, joined)

        # second run: only new mail is added; prune/check are not repeated within a week
        self.mb.add(6)
        gmail.sync({**gmail.DEFAULTS, "local_dir": str(self.t / "mail"), "min_free_gb": 0}, self.mb)
        e = self.run_offsite()
        rec = e["targets"][0]
        self.assertEqual(e["status"], "ok", e)
        self.assertFalse(rec.get("created") or rec.get("pruned") or rec.get("checked"), rec)
        self.assertGreaterEqual(rec["files_new"], 1)
        st = offsite.status(config.load_config())["targets"][0]
        self.assertEqual(st["last_snapshot"], rec["snapshot"])
        self.assertTrue(st["last_check_ok"])
        self.assertGreater(st["repo_size"], 0)
        self.assertAlmostEqual(offsite.next_run_ts(config.load_config()), e["started_ts"] + 86400, delta=1)

        # restore with plain restic: mail files and a usable index
        dest = self.t / "restore"
        out = restic(self.repo, "restore", "latest", "--target", str(dest))
        self.assertEqual(out.returncode, 0, out.stderr)
        emls = list(dest.rglob("*.eml"))
        self.assertEqual(len(emls), 6)
        idx = next(dest.rglob("index.snapshot.sqlite"))
        db = sqlite3.connect(str(idx))
        n = db.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
        db.close()
        self.assertEqual(n, 6)
        orig = next((self.t / "mail").rglob(emls[0].name)).read_bytes()
        self.assertEqual(emls[0].read_bytes(), orig)

    def test_wrong_password_missing_secret_and_disconnected_disk(self):
        self.run_offsite()
        cfg = config.load_config()
        cfg["offsite"]["targets"] = [
            {"id": "disk", "repository": self.repo, "password_keyring": "other"},
            {"id": "usb", "repository": "/Volumes/NoSuchDisk-xyz/restic"},
            {"id": "nokey", "repository": str(self.t / "repo2"), "password_keyring": "absent"},
        ]
        config.save_config(cfg)
        e = self.run_offsite()
        self.assertEqual(e["status"], "error", e)
        by = {r["id"]: r for r in e["targets"]}
        self.assertIn("неверный пароль", by["disk"]["error"])
        self.assertTrue(by["usb"]["skipped"])
        self.assertIn("не подключён", by["usb"]["error"])
        self.assertIn("offsite-password", by["nokey"]["error"])
        self.assertIn("usb: успешной копии нет ни разу", e["message"])
        self.assertFalse(Path("/Volumes/NoSuchDisk-xyz").exists())
        self.assertFalse((self.t / "repo2").exists())

    def test_locked_repository_is_unlocked_and_retried(self):
        from unittest import mock

        real, calls = offsite.Restic.run, []

        def run(self_, args, timeout=None, on_line=None):
            calls.append(args[0])
            if args[0] == "backup" and calls.count("backup") == 1:
                return offsite.EXIT_LOCKED, "", '{"message_type":"exit_error","code":11,"message":"repository is already locked"}'
            return real(self_, args, timeout, on_line)

        with mock.patch.object(offsite.Restic, "run", run):
            e = self.run_offsite()
        self.assertEqual(e["status"], "ok", e)
        self.assertEqual(calls[:4], ["cat", "init", "backup", "unlock"])
        self.assertEqual(calls.count("backup"), 2)

    def test_old_restic_is_refused(self):
        fake = self.t / "restic-old"
        fake.write_text("#!/bin/sh\necho 'restic 0.16.4 compiled with go1.22.2 on linux/amd64'\n")
        fake.chmod(0o755)
        with self.assertRaisesRegex(RuntimeError, "0.16.4 устарел"):
            offsite.find_restic({"restic_path": str(fake)})

    def test_mask(self):
        self.assertEqual(offsite.mask("rest:https://user:secret@host/repo"), "rest:https://user:***@host/repo")
        self.assertEqual(offsite.mask("sftp:u1@u1.your-storagebox.de:restic"), "sftp:u1@u1.your-storagebox.de:restic")


def _sshd_available():
    return RESTIC and shutil.which("sshd") is not None and shutil.which("ssh-keygen") and os.geteuid() == 0


@unittest.skipUnless(_sshd_available(), "needs restic, sshd and root")
class OffsiteSftp(unittest.TestCase):
    """The Hetzner-style target: sftp://user@host:port/relative-path with our own key,
    kept in a folder whose name has spaces (like ~/Library/Application Support)."""

    @classmethod
    def setUpClass(cls):
        cls.t = Path(tempfile.mkdtemp(prefix="sftp-"))
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            cls.port = s.getsockname()[1]
        keydir = cls.t / "Application Support"
        keydir.mkdir()
        cls.key = keydir / "key"
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(cls.key)], check=True)
        hostkey = cls.t / "hostkey"
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(hostkey)], check=True)
        auth = cls.t / "authorized_keys"
        shutil.copy(str(cls.key) + ".pub", auth)
        os.chmod(auth, 0o600)
        Path("/run/sshd").mkdir(exist_ok=True)
        conf = cls.t / "sshd_config"
        conf.write_text(
            f"Port {cls.port}\nListenAddress 127.0.0.1\nHostKey {hostkey}\nAuthorizedKeysFile {auth}\n"
            "PasswordAuthentication no\nPermitRootLogin prohibit-password\nStrictModes no\n"
            "Subsystem sftp internal-sftp\nPidFile none\n")
        cls.proc = subprocess.Popen([shutil.which("sshd"), "-D", "-e", "-f", str(conf)],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1)
        cls.saved_cfg = config.load_config()

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(10)
        config.save_config(cls.saved_cfg)

    def test_sftp_target(self):
        cal = self.t / "cal"
        cal.mkdir()
        (cal / "calendar-backup-20261108-000000.zip").write_bytes(b"zip")
        cfg = config.load_config()
        cfg.update(local_dir=str(cal), notify_on_error=False)
        cfg["gmail"] = {"enabled": False, "local_dir": str(self.t / "nomail")}
        # relative path: inside the remote user's home, as on a Storage Box
        cfg["offsite"] = {"enabled": True, "restic_path": RESTIC, "targets": [
            {"id": "box", "repository": f"sftp://root@127.0.0.1:{self.port}/{self.t.name}-repo",
             "ssh_key": str(self.key)}]}
        config.save_config(cfg)
        offsite.save_state({})
        e = offsite.run_offsite("manual", get_secret=get_secret)
        self.assertEqual(e["status"], "ok", e)
        self.assertTrue(e["targets"][0]["created"])
        self.assertTrue((Path.home() / f"{self.t.name}-repo" / "config").exists())
        self.assertTrue((config.app_home() / "offsite_known_hosts").exists())
        shutil.rmtree(Path.home() / f"{self.t.name}-repo")


if __name__ == "__main__":
    unittest.main(verbosity=2)
