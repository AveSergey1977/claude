"""Storage Box upload against a real OpenSSH server on localhost (needs root and sshd;
skipped otherwise). Covers: setup command, key login, pinned host key, upload, retention."""

import os
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

SSHD = shutil.which("sshd") or ("/usr/sbin/sshd" if os.path.exists("/usr/sbin/sshd") else None)
CAN_RUN = SSHD and shutil.which("ssh-keygen") and shutil.which("ssh-keyscan") and os.geteuid() == 0


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@unittest.skipUnless(CAN_RUN, "needs root, sshd, ssh-keygen and ssh-keyscan")
class StorageBox(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(tempfile.mkdtemp(prefix="calbackup-sb-"))
        os.chmod(cls.root, 0o755)
        cls.sshd_dir = cls.root / "sshd"
        cls.sshd_dir.mkdir(mode=0o755)
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(cls.sshd_dir / "host_ed25519")], check=True)
        cls.auth = cls.sshd_dir / "authorized_keys"
        cls.auth.write_text("")
        os.chmod(cls.auth, 0o600)
        cls.port = _free_port()
        conf = cls.sshd_dir / "sshd_config"
        conf.write_text(
            f"Port {cls.port}\nListenAddress 127.0.0.1\nHostKey {cls.sshd_dir}/host_ed25519\n"
            f"AuthorizedKeysFile {cls.auth}\nPasswordAuthentication no\nPermitRootLogin prohibit-password\n"
            f"Subsystem sftp internal-sftp\nPidFile {cls.sshd_dir}/pid\nUsePAM no\nStrictModes no\n"
        )
        os.makedirs("/run/sshd", exist_ok=True)
        cls.proc = subprocess.Popen([SSHD, "-D", "-e", "-f", str(conf)], stderr=subprocess.DEVNULL)
        for _ in range(50):
            try:
                socket.create_connection(("127.0.0.1", cls.port), timeout=0.2).close()
                break
            except OSError:
                time.sleep(0.1)
        cls.remote = cls.root / "remote"  # sftp paths are relative to root's home; use an absolute one
        os.environ["CALBACKUP_HOME"] = str(cls.root / "home")

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(5)
        os.environ.pop("CALBACKUP_HOME", None)

    def test_flow(self):
        from calbackup import config, sftp_dest
        from calbackup.engine import run_backup

        user = os.environ.get("USER") or "root"
        sftp_dest.init("127.0.0.1", user, self.port, str(self.remote).lstrip("/"))
        cfg = config.load_config()
        cfg["storage_box"]["path"] = str(self.remote)  # absolute on the test server
        cfg["storage_box"]["keep"] = 2
        cfg.update(local_dir=str(self.root / "backups"), notify_on_error=False, host_tag="srv")
        cfg["drive"]["enabled"] = False
        ics = self.root / "c.ics"
        ics.write_text("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:x\r\nBEGIN:VEVENT\r\nUID:1\r\nDTSTAMP:20260101T000000Z\r\n"
                       "DTSTART:20260105T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")
        cfg["sources"] = [{"id": "f", "type": "ics", "urls": {"Файл": ics.as_uri()}}]
        config.save_config(cfg)

        # before the key is installed: login refused, not enabled
        self.assertEqual(sftp_dest.test(), 1)
        self.assertFalse(config.load_config()["storage_box"]["enabled"])

        pub = self.root / "home" / ".ssh" / "storagebox_ed25519.pub"
        self.auth.write_text(pub.read_text())
        self.assertEqual(sftp_dest.test(), 0)
        self.assertTrue(config.load_config()["storage_box"]["enabled"])

        for _ in range(3):
            e = run_backup("schedule")
            self.assertEqual(e["status"], "ok", e["message"])
            d = [x for x in e["destinations"] if x["id"] == "storagebox"][0]
            self.assertTrue(d["ok"])
            time.sleep(1.05)
        remote = sorted(p.name for p in self.remote.iterdir())
        self.assertEqual(len(remote), 2, remote)  # keep = 2, no .part leftovers
        self.assertTrue(all(n.endswith("Z-srv.zip") for n in remote))
        local_newest = sorted((self.root / "backups").glob("*.zip"))[-1]
        self.assertEqual((self.remote / local_newest.name).read_bytes(), local_newest.read_bytes())

        # a different host key is rejected (man-in-the-middle protection)
        kh = self.root / "home" / ".ssh" / "known_hosts_storagebox"
        other = self.root / "other"
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(other)], check=True)
        kh.write_text(f"[127.0.0.1]:{self.port} " + " ".join(Path(str(other) + ".pub").read_text().split()[:2]) + "\n")
        e = run_backup("schedule")
        self.assertEqual(e["status"], "partial")
        self.assertIn("Storage Box", e["message"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
