import base64
import json
import mailbox
import os
import tempfile
import time
import unittest
from pathlib import Path

os.environ.setdefault("CALBACKUP_HOME", os.path.join(tempfile.mkdtemp(prefix="calbackup-test-"), "home"))

from calbackup import config, gmail  # noqa: E402


def raw_msg(n: int, body: str = "") -> str:
    text = (
        f"From: Sender {n} <s{n}@example.com>\r\nTo: me@example.com\r\n"
        f"Subject: =?utf-8?b?{base64.b64encode(f'Письмо {n}'.encode()).decode()}?=\r\n"
        "Date: Mon, 2 Nov 2026 10:00:00 +0200\r\n\r\n"
        f"Body {n}\r\n{body}"
    )
    return base64.urlsafe_b64encode(text.encode()).decode().rstrip("=")


class FakeHttpError(Exception):
    def __init__(self, status, content=b""):
        super().__init__(f"HTTP {status}")
        self.status_code = status
        self.content = content


class FakeMailbox:
    """The GmailApi interface over an in-memory mailbox."""

    def __init__(self):
        self.msgs = {}
        self.hid = 100
        self.records = []
        self.expired = False
        self.fail_ids = set()
        self.get_calls = 0

    def add(self, n, labels=("INBOX",), body=""):
        mid = f"{n:016x}"
        self.hid += 1
        self.msgs[mid] = {"id": mid, "threadId": mid, "labelIds": list(labels),
                          "internalDate": str(1793000000000 + n * 1000), "raw": raw_msg(n, body)}
        self.records.append({"id": str(self.hid), "messagesAdded": [{"message": {"id": mid, "labelIds": list(labels)}}]})
        return mid

    def delete(self, mid):
        self.msgs.pop(mid)
        self.hid += 1
        self.records.append({"id": str(self.hid), "messagesDeleted": [{"message": {"id": mid}}]})

    def relabel(self, mid, labels):
        self.msgs[mid]["labelIds"] = list(labels)
        self.hid += 1
        self.records.append({"id": str(self.hid), "labelsAdded": [{"message": {"id": mid, "labelIds": list(labels)}}]})

    # GmailApi interface
    def profile(self):
        return {"emailAddress": "me@example.com", "messagesTotal": len(self.msgs), "historyId": str(self.hid)}

    def labels(self):
        return [{"id": "INBOX", "name": "INBOX"}, {"id": "Label_1", "name": "Проект X"}, {"id": "SPAM", "name": "SPAM"}]

    def list_ids(self, q="", include_spam_trash=True):
        for mid, m in self.msgs.items():
            if "-in:spam" in q and "SPAM" in m["labelIds"]:
                continue
            yield mid

    def history(self, start):
        if self.expired:
            raise gmail.HistoryExpired("404")
        return [r for r in self.records if int(r["id"]) > int(start)], str(self.hid)

    def get_raw(self, ids):
        self.get_calls += 1
        out = {}
        for mid in ids:
            if mid in self.fail_ids:
                out[mid] = FakeHttpError(400)
            else:
                out[mid] = self.msgs.get(mid)
        return out


class GmailSync(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="gmail-"))
        self.g = {**gmail.DEFAULTS, "local_dir": str(self.dir), "min_free_gb": 0, "verify_sample": 100}
        self.mb = FakeMailbox()
        self.root = self.dir / "me@example.com"

    def store(self):
        return gmail.Store(self.root)

    def test_full_then_incremental(self):
        a, b, c = (self.mb.add(n) for n in (1, 2, 3))
        st = gmail.sync(self.g, self.mb)
        self.assertEqual(st["mode"], "full")
        self.assertEqual((st["fetched"], st["present"], st["queue"]), (3, 3, 0))
        f = self.root / "messages" / "2026" / "10" / f"{a}.eml"
        self.assertTrue(f.exists(), list(self.root.rglob("*.eml")))
        self.assertTrue(f.read_bytes().startswith(b"From: Sender 1"))
        self.assertEqual(oct(f.stat().st_mode & 0o777), "0o600")
        s = self.store()
        row = s.db.execute("SELECT subject, sender FROM messages WHERE id=?", (a,)).fetchone()
        self.assertEqual(row, ("Письмо 1", "Sender 1 <s1@example.com>"))
        s.close()

        d = self.mb.add(4)
        self.mb.delete(b)
        self.mb.relabel(c, ["INBOX", "Label_1"])
        st = gmail.sync(self.g, self.mb)
        self.assertEqual(st["mode"], "incremental")
        self.assertEqual((st["fetched"], st["newly_gone"], st["labels_changed"]), (1, 1, 1))
        self.assertEqual((st["present"], st["gone"], st["stored"]), (3, 1, 4))
        st = gmail.sync(self.g, self.mb)   # nothing changed since
        self.assertEqual((st["fetched"], st["newly_gone"], st["gone"]), (0, 0, 1))
        # deleted in Gmail, kept on disk
        self.assertTrue(list(self.root.rglob(f"{b}.eml")))
        s = self.store()
        self.assertIsNotNone(s.db.execute("SELECT gone_at FROM messages WHERE id=?", (b,)).fetchone()[0])
        self.assertEqual(json.loads(s.db.execute("SELECT labels FROM messages WHERE id=?", (c,)).fetchone()[0]),
                         ["INBOX", "Label_1"])
        s.close()
        self.assertTrue(list(self.root.rglob(f"{d}.eml")))
        self.assertEqual(gmail.Store(self.root, readonly=True).full_check()["problems"], 0)

    def test_expired_history_reconciles(self):
        a, b = self.mb.add(1), self.mb.add(2)
        gmail.sync(self.g, self.mb)
        self.mb.msgs.pop(a)          # vanished without a history record
        new = self.mb.add(3)
        self.mb.expired = True
        st = gmail.sync(self.g, self.mb)
        self.assertEqual(st["mode"], "reconcile")
        self.assertEqual((st["fetched"], st["newly_gone"], st["present"]), (1, 1, 2))
        self.assertTrue(any("полная сверка" in w for w in st["warnings"]))
        self.assertTrue(list(self.root.rglob(f"{new}.eml")))

    def test_mass_disappearance_warns(self):
        ids = [self.mb.add(n) for n in range(1, 41)]
        gmail.sync(self.g, self.mb)
        for mid in ids[:30]:
            self.mb.msgs.pop(mid)
        self.g["reconcile_days"] = 0
        st = gmail.sync(self.g, self.mb)
        self.assertEqual((st["newly_gone"], st["gone"]), (30, 30))
        self.assertTrue(any("исчезло 30" in w for w in st["warnings"]), st["warnings"])

    def test_budget_and_resume(self):
        for n in range(1, 11):
            self.mb.add(n)
        self.g["max_minutes_per_run"] = 0
        st = gmail.sync(self.g, self.mb)
        self.assertEqual((st["fetched"], st["queue"]), (0, 10))
        self.g["max_minutes_per_run"] = 50
        self.g["batch_size"] = 1      # 4 messages per round
        st = gmail.sync(self.g, self.mb)
        self.assertEqual((st["fetched"], st["queue"], st["present"]), (10, 0, 10))
        self.assertEqual(self.mb.get_calls, 3)

    def test_gone_before_fetch_errors_and_spam(self):
        a = self.mb.add(1)
        bad = self.mb.add(2)
        spam = self.mb.add(3, labels=("SPAM",))
        self.mb.fail_ids.add(bad)
        st = gmail.sync(self.g, self.mb)
        self.assertEqual((st["fetched"], st["fetch_errors"], st["queue"]), (1, 1, 1))
        self.assertFalse(list(self.root.rglob(f"{spam}.eml")))   # listing skips spam
        # a spam message announced by history is fetched but not stored
        sp2 = self.mb.add(4, labels=("SPAM",))
        gone = self.mb.add(5)
        self.mb.msgs.pop(gone)          # deleted before we fetch it -> 404
        self.mb.fail_ids.clear()
        st = gmail.sync(self.g, self.mb)
        self.assertEqual((st["fetched"], st["skipped"], st["queue"]), (1, 2, 0))
        self.assertFalse(list(self.root.rglob(f"{sp2}.eml")))
        self.assertTrue(list(self.root.rglob(f"{bad}.eml")))
        self.assertTrue(list(self.root.rglob(f"{a}.eml")))

    def test_failed_message_stops_after_max_attempts(self):
        bad = self.mb.add(1)
        self.mb.fail_ids.add(bad)
        self.g["reconcile_days"] = 1000
        for _ in range(gmail.MAX_ATTEMPTS + 1):
            st = gmail.sync(self.g, self.mb)
        self.assertEqual((st["queue"], st["queue_failed"]), (0, 1))

    def test_verify_detects_damage(self):
        a = self.mb.add(1)
        b = self.mb.add(2)
        gmail.sync(self.g, self.mb)
        next(self.root.rglob(f"{a}.eml")).write_bytes(b"tampered")
        next(self.root.rglob(f"{b}.eml")).unlink()
        r = gmail.Store(self.root, readonly=True).full_check()
        self.assertEqual(r["problems"], 2)
        st = gmail.sync(self.g, self.mb)
        self.assertTrue(any("Проверка файлов: 2" in w for w in st["warnings"]), st["warnings"])

    def test_export_mbox(self):
        self.mb.add(1, body="From the start of a line\r\n>From quoted\r\n")
        b = self.mb.add(2, labels=("Label_1",))
        gmail.sync(self.g, self.mb)
        out = self.dir / "all.mbox"
        self.assertEqual(gmail.export_mbox(self.root, out), 2)
        data = out.read_bytes()
        self.assertIn(b"\n>From the start", data)
        self.assertIn(b"\n>>From quoted", data)
        box = mailbox.mbox(str(out))
        self.assertEqual([m["From"] for m in box], ["Sender 1 <s1@example.com>", "Sender 2 <s2@example.com>"])
        box.close()
        self.assertEqual(gmail.export_mbox(self.root, self.dir / "x.mbox", label="Проект X"), 1)
        self.mb.delete(b)
        gmail.sync(self.g, self.mb)
        self.assertEqual(gmail.export_mbox(self.root, self.dir / "y.mbox", include_gone=False), 1)
        self.assertEqual(gmail.export_mbox(self.root, self.dir / "z.mbox", since="2030-01-01"), 0)
        self.assertEqual(gmail.export_mbox(self.root, self.dir / "w.mbox", until="2026-10-31"), 2)

    def test_status(self):
        self.mb.add(1)
        gmail.sync(self.g, self.mb)
        st = gmail.status({"gmail": self.g})
        self.assertEqual(st["accounts"][0]["account"], "me@example.com")
        self.assertEqual(st["accounts"][0]["present"], 1)


class FakeRequest:
    def __init__(self, mid):
        self.mid = mid


class FakeBatch:
    def __init__(self, svc):
        self.svc, self.items = svc, []

    def add(self, req, callback, request_id):
        self.items.append((req, callback, request_id))

    def execute(self):
        self.svc.batches.append(len(self.items))
        for req, cb, rid in self.items:
            plan = self.svc.plan.get(req.mid, [])
            outcome = plan.pop(0) if plan else "ok"
            if outcome == "ok":
                cb(rid, {"id": req.mid, "raw": raw_msg(1)}, None)
            else:
                cb(rid, None, FakeHttpError(outcome, b'{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}'))


class FakeSvc:
    def __init__(self, plan):
        self.plan, self.batches = plan, []

    def new_batch_http_request(self):
        return FakeBatch(self)

    def users(self):
        return self

    def messages(self):
        return self

    def get(self, userId, id, format):
        assert format == "raw"
        return FakeRequest(id)


class GmailApiBatch(unittest.TestCase):
    def test_retry_404_and_errors(self):
        svc = FakeSvc({"a": [429, "ok"], "b": [404], "c": [403, 403, "ok"], "d": [400]})
        sleeps = []
        api = gmail.GmailApi(svc, batch_size=3, sleep=sleeps.append)
        res = api.get_raw(["a", "b", "c", "d"])
        self.assertEqual(res["a"]["id"], "a")
        self.assertIsNone(res["b"])
        self.assertEqual(res["c"]["id"], "c")
        self.assertIsInstance(res["d"], Exception)
        self.assertEqual(svc.batches, [3, 1, 2, 1])
        self.assertEqual(len(sleeps), 2)

    def test_gives_up(self):
        svc = FakeSvc({"a": [429] * 10})
        res = gmail.GmailApi(svc, sleep=lambda s: None).get_raw(["a"])
        self.assertIn("лимит", str(res["a"]))


class Credentials(unittest.TestCase):
    def test_old_token_keeps_calendar_and_asks_for_gmail(self):
        from datetime import datetime, timedelta, timezone

        from calbackup import google_auth

        tok = {
            "token": "x", "refresh_token": "r", "client_id": "c", "client_secret": "s",
            "scopes": [google_auth.CALENDAR_SCOPE, google_auth.DRIVE_SCOPE],
            "expiry": (datetime.now(timezone.utc) + timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        p = google_auth.token_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        old = p.read_text() if p.exists() else None
        p.write_text(json.dumps(tok))
        try:
            creds = google_auth.credentials()
            self.assertEqual(creds.scopes, tok["scopes"])   # refresh would not ask for Gmail
            with self.assertRaisesRegex(RuntimeError, "auth-google"):
                google_auth.credentials([google_auth.GMAIL_SCOPE])
        finally:
            if old is None:
                p.unlink()
            else:
                p.write_text(old)


class RunWrapper(unittest.TestCase):
    def test_history_and_schedule(self):
        d = tempfile.mkdtemp(prefix="gmail-run-")
        cfg = config.load_config()
        cfg["notify_on_error"] = False
        cfg["gmail"] = {"enabled": True, "interval_hours": 2, "local_dir": d, "min_free_gb": 0,
                        "max_minutes_per_run": 0}
        config.save_config(cfg)
        mb = FakeMailbox()
        mb.add(1)
        before = len(gmail.history_entries())
        e = gmail.run_gmail("manual", api=mb)
        self.assertTrue(e["in_progress"])
        self.assertEqual(e["status"], "ok")
        # queue left: continue shortly after this run, not after the interval
        self.assertLess(gmail.next_run_ts(config.load_config()), time.time() + 60)
        cfg["gmail"]["max_minutes_per_run"] = 50
        config.save_config(cfg)
        e = gmail.run_gmail("schedule", api=mb)
        self.assertFalse(e["in_progress"])
        self.assertAlmostEqual(gmail.next_run_ts(config.load_config()), e["started_ts"] + 7200, delta=1)

        class Broken(FakeMailbox):
            def profile(self):
                raise FakeHttpError(403, b"insufficientPermissions")

        e = gmail.run_gmail("schedule", api=Broken())
        self.assertEqual(e["status"], "error")
        self.assertIn("auth-google", e["message"])
        self.assertEqual(len(gmail.history_entries()), min(before + 3, config.HISTORY_LIMIT))
        cfg["gmail"]["enabled"] = False
        config.save_config(cfg)
        self.assertIsNone(gmail.next_run_ts(config.load_config()))


if __name__ == "__main__":
    unittest.main(verbosity=2)
