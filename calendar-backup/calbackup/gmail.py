"""Gmail backup: an incremental local copy of the whole mailbox.

Every message is stored once, as the original RFC 822 file received from the Gmail API
(format=raw), in <local_dir>/<account>/messages/YYYY/MM/<id>.eml. An SQLite index next to
it keeps labels, a few headers, SHA-256 checksums and the sync state.

A run:
  * reconciliation (first run, when Gmail no longer keeps our history point, and every
    `reconcile_days`): list all message ids, queue the ones not stored yet, mark stored
    ones that are no longer in the mailbox as gone;
  * otherwise users.history.list since the saved historyId: queue added messages, mark
    deleted ones as gone, update labels;
  * download the queue within a time budget; what is left continues on the next run.

Nothing is ever deleted from the local copy: a message removed from Gmail stays on disk
and is only marked `gone_at` in the index.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import random
import re
import shutil
import sqlite3
import tempfile
import time
from datetime import datetime, timezone
from email.parser import BytesHeaderParser
from email.policy import default as default_policy
from email.utils import parseaddr
from pathlib import Path

log = logging.getLogger("calbackup")

DEFAULTS = {
    "enabled": False,
    "interval_hours": 1,
    "local_dir": "~/MailBackups",
    "include_spam": False,       # Trash is always copied, Spam only on request
    "max_minutes_per_run": 50,   # time budget for downloads; the rest goes to the next run
    "batch_size": 25,            # messages per Gmail batch request
    "reconcile_days": 7,         # full id listing to catch anything history missed
    "min_free_gb": 5,            # stop downloading when the disk has less free space
    "verify_sample": 50,         # stored files re-hashed on every run
}

MAX_ATTEMPTS = 8
CONTINUE_AFTER_S = 30            # next run when the queue was not drained
_ID_RE = re.compile(r"^[0-9A-Za-z_-]{1,64}$")
GONE_ALERT_SHARE = 0.05          # warn when a reconciliation finds this share of the mail gone

SCHEMA = """
CREATE TABLE IF NOT EXISTS messages(
  id TEXT PRIMARY KEY,
  thread_id TEXT,
  internal_date INTEGER,
  size INTEGER,
  sha256 TEXT,
  path TEXT,
  labels TEXT,
  subject TEXT,
  sender TEXT,
  date_hdr TEXT,
  stored_at TEXT,
  gone_at TEXT
);
CREATE INDEX IF NOT EXISTS messages_date ON messages(internal_date);
CREATE TABLE IF NOT EXISTS queue(
  id TEXT PRIMARY KEY,
  added_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, value TEXT);
"""


def settings(cfg: dict) -> dict:
    out = dict(DEFAULTS)
    out.update(cfg.get("gmail") or {})
    return out


def base_dir(gcfg: dict) -> Path:
    return Path(os.path.expanduser(gcfg.get("local_dir") or DEFAULTS["local_dir"]))


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _safe_dir(name: str) -> str:
    return re.sub(r"[^0-9A-Za-z@._+-]+", "_", name).strip(".") or "account"


class HistoryExpired(Exception):
    """Gmail no longer keeps the saved historyId: a full reconciliation is needed."""


def _http_status(exc) -> int | None:
    st = getattr(exc, "status_code", None)
    if st is None:
        resp = getattr(exc, "resp", None)
        st = getattr(resp, "status", None)
    try:
        return int(st) if st is not None else None
    except (TypeError, ValueError):
        return None


def _is_retryable(exc) -> bool:
    st = _http_status(exc)
    if st in (429, 500, 502, 503, 504):
        return True
    if st == 403:
        text = str(getattr(exc, "content", b"") or b"")
        return "RateLimitExceeded" in text or "rateLimitExceeded" in text
    return False


def _short(e: BaseException) -> str:
    st = _http_status(e)
    reason = ""
    if hasattr(e, "_get_reason"):
        try:
            reason = e._get_reason()
        except Exception:
            reason = ""
    content = getattr(e, "content", b"") or b""
    if isinstance(content, bytes):
        content = content.decode("utf-8", "replace")
    if st == 403 and "insufficient" in f"{reason} {e} {content}".lower():
        return ("нет разрешения на чтение Gmail: выполните calbackup auth-google и отметьте "
                "доступ к почте")
    msg = f"HTTP {st}: {reason}" if st and reason else (str(e).strip() or type(e).__name__)
    return msg[:400]


# --------------------------------------------------------------------------- API


class GmailApi:
    """Thin wrapper over the Gmail API v1 client; tests replace it with a fake."""

    def __init__(self, svc, batch_size: int = 25, sleep=time.sleep):
        self.svc = svc
        self.batch_size = max(1, min(int(batch_size), 50))
        self.sleep = sleep

    def profile(self) -> dict:
        return self.svc.users().getProfile(userId="me").execute(num_retries=5)

    def labels(self) -> list:
        return self.svc.users().labels().list(userId="me").execute(num_retries=5).get("labels", [])

    def list_ids(self, q: str = "", include_spam_trash: bool = True):
        token = None
        while True:
            resp = self.svc.users().messages().list(
                userId="me", maxResults=500, includeSpamTrash=include_spam_trash, q=q or None,
                pageToken=token, fields="messages/id,nextPageToken",
            ).execute(num_retries=5)
            for m in resp.get("messages", []):
                yield m["id"]
            token = resp.get("nextPageToken")
            if not token:
                return

    def history(self, start: str):
        """All history records since `start` -> (records, latest historyId)."""
        records, token, latest = [], None, start
        while True:
            try:
                resp = self.svc.users().history().list(
                    userId="me", startHistoryId=start, maxResults=500, pageToken=token,
                    historyTypes=["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"],
                ).execute(num_retries=5)
            except Exception as e:
                if _http_status(e) == 404:
                    raise HistoryExpired(str(e)) from e
                raise
            records.extend(resp.get("history", []))
            latest = resp.get("historyId") or latest
            token = resp.get("nextPageToken")
            if not token:
                return records, str(latest)

    def get_raw(self, ids: list) -> dict:
        """id -> message dict (format=raw), None when the message no longer exists,
        or an Exception. Rate-limited items are retried with exponential backoff."""
        out: dict = {}
        pending, delay = list(ids), 1.0
        for attempt in range(6):
            retry: list = []

            def cb(rid, resp, exc):
                if exc is None:
                    out[rid] = resp
                elif _http_status(exc) == 404:
                    out[rid] = None
                elif _is_retryable(exc):
                    retry.append(rid)
                else:
                    out[rid] = exc

            for i in range(0, len(pending), self.batch_size):
                batch = self.svc.new_batch_http_request()
                for mid in pending[i:i + self.batch_size]:
                    batch.add(self.svc.users().messages().get(userId="me", id=mid, format="raw"),
                              callback=cb, request_id=mid)
                batch.execute()
            if not retry:
                return out
            pending = retry
            if attempt < 5:
                self.sleep(delay + random.random())
                delay = min(delay * 2, 32)
        for mid in pending:
            out[mid] = RuntimeError("Gmail: превышен лимит запросов, повтор в следующий запуск")
        return out


def real_api(gcfg: dict) -> GmailApi:
    from .google_auth import GMAIL_SCOPE, service

    return GmailApi(service("gmail", "v1", required=[GMAIL_SCOPE]), gcfg.get("batch_size", 25))


# ------------------------------------------------------------------------- store


class Store:
    """One account: message files + SQLite index."""

    def __init__(self, root: Path, readonly: bool = False):
        self.root = root
        if readonly:  # the panel reads while a sync may be writing
            uri = (root / "index.sqlite").resolve().as_uri() + "?mode=ro"
            self.db = sqlite3.connect(uri, uri=True, timeout=5)
            return
        root.mkdir(parents=True, exist_ok=True)
        os.chmod(root, 0o700)
        self.db = sqlite3.connect(str(root / "index.sqlite"), timeout=30)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(SCHEMA)
        os.chmod(root / "index.sqlite", 0o600)

    def close(self):
        self.db.close()

    # state
    def get(self, key: str, default=None):
        row = self.db.execute("SELECT value FROM state WHERE key=?", (key,)).fetchone()
        return row[0] if row else default

    def set(self, key: str, value) -> None:
        self.db.execute("INSERT OR REPLACE INTO state(key, value) VALUES(?, ?)", (key, str(value)))

    def commit(self):
        self.db.commit()

    # queries
    def stored(self, mid: str):
        return self.db.execute("SELECT gone_at FROM messages WHERE id=?", (mid,)).fetchone()

    def counts(self) -> dict:
        q = self.db.execute
        return {
            "stored": q("SELECT COUNT(*) FROM messages").fetchone()[0],
            "present": q("SELECT COUNT(*) FROM messages WHERE gone_at IS NULL").fetchone()[0],
            "gone": q("SELECT COUNT(*) FROM messages WHERE gone_at IS NOT NULL").fetchone()[0],
            "bytes": q("SELECT COALESCE(SUM(size), 0) FROM messages").fetchone()[0],
            "queue": q("SELECT COUNT(*) FROM queue WHERE attempts < ?", (MAX_ATTEMPTS,)).fetchone()[0],
            "queue_failed": q("SELECT COUNT(*) FROM queue WHERE attempts >= ?", (MAX_ATTEMPTS,)).fetchone()[0],
        }

    # queue
    def queue_left(self) -> int:
        return self.db.execute("SELECT COUNT(*) FROM queue WHERE attempts < ?", (MAX_ATTEMPTS,)).fetchone()[0]

    def enqueue(self, mid: str) -> bool:
        if not _ID_RE.match(mid) or self.stored(mid):
            return False
        cur = self.db.execute("INSERT OR IGNORE INTO queue(id, added_at) VALUES(?, ?)", (mid, _now_iso()))
        return cur.rowcount > 0

    def dequeue(self, mid: str) -> None:
        self.db.execute("DELETE FROM queue WHERE id=?", (mid,))

    def queue_fail(self, mid: str, err: str) -> None:
        self.db.execute("UPDATE queue SET attempts = attempts + 1, last_error=? WHERE id=?", (err, mid))

    def queue_batch(self, n: int) -> list:
        """Next ids to download; each id is tried at most once per run (see begin_run)."""
        rows = self.db.execute(
            "SELECT id FROM queue WHERE attempts < ? AND id NOT IN (SELECT id FROM run_tried)"
            " ORDER BY attempts, added_at, id LIMIT ?",
            (MAX_ATTEMPTS, n),
        ).fetchall()
        ids = [r[0] for r in rows]
        self.db.executemany("INSERT OR IGNORE INTO run_tried(id) VALUES(?)", [(i,) for i in ids])
        return ids

    def begin_run(self) -> None:
        self.db.execute("CREATE TEMP TABLE IF NOT EXISTS run_tried(id TEXT PRIMARY KEY)")
        self.db.execute("DELETE FROM run_tried")

    # messages
    def mark_gone(self, mid: str, when: str) -> bool:
        cur = self.db.execute("UPDATE messages SET gone_at=? WHERE id=? AND gone_at IS NULL", (when, mid))
        return cur.rowcount > 0

    def mark_present(self, mid: str) -> None:
        self.db.execute("UPDATE messages SET gone_at=NULL WHERE id=?", (mid,))

    def set_labels(self, mid: str, labels: list) -> bool:
        cur = self.db.execute(
            "UPDATE messages SET labels=? WHERE id=? AND COALESCE(labels, '') != ?",
            (json.dumps(sorted(labels)), mid, json.dumps(sorted(labels))),
        )
        return cur.rowcount > 0

    def put(self, msg: dict) -> int:
        mid = msg["id"]
        if not _ID_RE.match(mid):
            raise ValueError(f"недопустимый id письма: {mid!r}")
        raw = base64.urlsafe_b64decode(msg["raw"] + "=" * (-len(msg["raw"]) % 4))
        ts = int(msg.get("internalDate") or 0) / 1000
        d = datetime.fromtimestamp(ts, timezone.utc)
        rel = f"messages/{d.year:04d}/{d.month:02d}/{mid}.eml"
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=f".{mid}.", suffix=".part")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(raw)
            os.chmod(tmp, 0o600)
            os.replace(tmp, path)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise
        subject = sender = date_hdr = ""
        try:
            h = BytesHeaderParser(policy=default_policy).parsebytes(raw)
            subject = str(h.get("Subject", "") or "")[:500]
            sender = str(h.get("From", "") or "")[:500]
            date_hdr = str(h.get("Date", "") or "")[:100]
        except Exception:
            pass
        self.db.execute(
            "INSERT OR REPLACE INTO messages(id, thread_id, internal_date, size, sha256, path, labels,"
            " subject, sender, date_hdr, stored_at, gone_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL)",
            (mid, msg.get("threadId"), int(msg.get("internalDate") or 0), len(raw),
             hashlib.sha256(raw).hexdigest(), rel, json.dumps(sorted(msg.get("labelIds") or [])),
             subject, sender, date_hdr, _now_iso()),
        )
        return len(raw)

    def check(self, rows) -> list:
        """[(id, problem)] for rows of (id, path, sha256)."""
        bad = []
        for mid, rel, sha in rows:
            p = self.root / rel
            try:
                data = p.read_bytes()
            except OSError:
                bad.append((mid, "файл отсутствует"))
                continue
            if hashlib.sha256(data).hexdigest() != sha:
                bad.append((mid, "контрольная сумма не совпадает"))
        return bad

    def sample_check(self, n: int) -> list:
        if n <= 0:
            return []
        rows = self.db.execute("SELECT id, path, sha256 FROM messages ORDER BY RANDOM() LIMIT ?", (n,)).fetchall()
        return self.check(rows)

    def full_check(self) -> dict:
        rows = self.db.execute("SELECT id, path, sha256 FROM messages").fetchall()
        bad = self.check(rows)
        return {"checked": len(rows), "problems": len(bad), "examples": bad[:20]}


def accounts(gcfg: dict) -> list:
    base = base_dir(gcfg)
    if not base.is_dir():
        return []
    return sorted(p for p in base.iterdir() if (p / "index.sqlite").exists())


# -------------------------------------------------------------------------- sync


def _apply_history(store: Store, records: list, stats: dict) -> None:
    when = _now_iso()
    for rec in records:
        for x in rec.get("messagesAdded", []):
            m = x.get("message") or {}
            mid = m.get("id")
            if not mid:
                continue
            row = store.stored(mid)
            if row is None:
                if store.enqueue(mid):
                    stats["queued"] += 1
            else:
                if row[0] is not None:
                    store.mark_present(mid)
                if "labelIds" in m and store.set_labels(mid, m["labelIds"]):
                    stats["labels_changed"] += 1
        for x in rec.get("messagesDeleted", []):
            mid = (x.get("message") or {}).get("id")
            if not mid:
                continue
            store.dequeue(mid)
            if store.mark_gone(mid, when):
                stats["newly_gone"] += 1
        for x in rec.get("labelsAdded", []) + rec.get("labelsRemoved", []):
            m = x.get("message") or {}
            if m.get("id") and "labelIds" in m and store.stored(m["id"]) is not None:
                if store.set_labels(m["id"], m["labelIds"]):
                    stats["labels_changed"] += 1


def _reconcile(store: Store, api, gcfg: dict, history_id: str, stats: dict) -> None:
    q = "" if gcfg.get("include_spam") else "-in:spam"
    listed = set(api.list_ids(q=q, include_spam_trash=True))
    stats["listed"] = len(listed)
    known = {r[0]: r[1] for r in store.db.execute("SELECT id, gone_at FROM messages")}
    when = _now_iso()
    for mid in listed:
        if mid not in known:
            if store.enqueue(mid):
                stats["queued"] += 1
        elif known[mid] is not None:
            store.mark_present(mid)
    present_before = sum(1 for v in known.values() if v is None)
    newly_gone = 0
    for mid, gone in known.items():
        if gone is None and mid not in listed:
            store.mark_gone(mid, when)
            newly_gone += 1
    # queued ids that are no longer in the mailbox would only fail with 404
    for (mid,) in store.db.execute("SELECT id FROM queue").fetchall():
        if mid not in listed:
            store.dequeue(mid)
    stats["newly_gone"] += newly_gone
    if present_before and newly_gone >= max(20, GONE_ALERT_SHARE * present_before):
        stats["warnings"].append(
            f"Из ящика исчезло {newly_gone} писем из {present_before} сохранённых "
            "(удаление или перенос в спам). Копии писем сохранены."
        )
    store.set("history_id", history_id)
    store.set("last_reconcile_ts", time.time())


def _drain(store: Store, api, gcfg: dict, deadline: float, stats: dict, progress) -> None:
    store.begin_run()
    min_free = float(gcfg.get("min_free_gb", 5)) * 1024 ** 3
    batch_n = max(1, int(gcfg.get("batch_size", 25))) * 4
    while time.time() < deadline:
        ids = store.queue_batch(batch_n)
        if not ids:
            return
        if shutil.disk_usage(store.root).free < min_free:
            raise RuntimeError(
                f"на диске меньше {gcfg.get('min_free_gb', 5)} ГБ свободного места; загрузка писем остановлена"
            )
        res = api.get_raw(ids)
        for mid in ids:
            r = res.get(mid, RuntimeError("нет ответа"))
            if r is None:
                store.dequeue(mid)
                stats["skipped"] += 1
            elif isinstance(r, Exception):
                store.queue_fail(mid, _short(r))
                stats["fetch_errors"] += 1
            elif "SPAM" in (r.get("labelIds") or []) and not gcfg.get("include_spam"):
                store.dequeue(mid)
                stats["skipped"] += 1
            else:
                stats["bytes_fetched"] += store.put(r)
                store.dequeue(mid)
                stats["fetched"] += 1
        store.commit()
        if progress:
            progress({"fetched": stats["fetched"], "queue": store.queue_left()})


def sync(gcfg: dict, api, progress=None, now=None) -> dict:
    """One sync pass for the account behind `api`. Returns run statistics."""
    started = now or time.time()
    deadline = started + float(gcfg.get("max_minutes_per_run", 50)) * 60
    # per-run counters; store.counts() adds the totals (stored, present, gone, bytes, queue)
    stats = {"queued": 0, "fetched": 0, "skipped": 0, "fetch_errors": 0, "newly_gone": 0,
             "labels_changed": 0, "bytes_fetched": 0, "warnings": [], "mode": "incremental"}
    prof = api.profile()
    email = prof.get("emailAddress") or "me"
    stats["account"] = email
    stats["mailbox_total"] = prof.get("messagesTotal")
    from .folders import require_volume

    require_volume(base_dir(gcfg))
    store = Store(base_dir(gcfg) / _safe_dir(email))
    try:
        (store.root / "labels.json").write_text(
            json.dumps(api.labels(), ensure_ascii=False, indent=1), encoding="utf-8")
        hid = store.get("history_id")
        last_rec = float(store.get("last_reconcile_ts", 0) or 0)
        due = not hid or started - last_rec >= float(gcfg.get("reconcile_days", 7)) * 86400
        if not due:
            try:
                records, latest = api.history(hid)
            except HistoryExpired:
                due = True
                stats["warnings"].append("Gmail больше не хранит прежнюю точку истории; выполнена полная сверка")
            else:
                _apply_history(store, records, stats)
                store.set("history_id", latest)
        if due:
            stats["mode"] = "full" if not hid else "reconcile"
            _reconcile(store, api, gcfg, str(prof.get("historyId")), stats)
        store.commit()
        if progress:
            progress({"fetched": 0, "queue": store.queue_left()})

        _drain(store, api, gcfg, deadline, stats, progress)
        store.commit()

        bad = store.sample_check(int(gcfg.get("verify_sample", 50)))
        if bad:
            stats["warnings"].append(
                f"Проверка файлов: {len(bad)} с ошибкой, напр. {bad[0][0]}: {bad[0][1]}. "
                "Выполните calbackup gmail-verify"
            )
        stats.update(store.counts())
        stats["dir"] = str(store.root)
    finally:
        store.commit()
        store.close()
    return stats


# ------------------------------------------------------------------ run wrapper


def history_entries() -> list:
    from .config import load_history

    return load_history("gmail_history")


def next_run_ts(cfg: dict) -> float | None:
    gcfg = settings(cfg)
    if not gcfg.get("enabled"):
        return None
    hist = history_entries()
    if not hist:
        return time.time()
    last = hist[0]
    if last.get("in_progress"):
        return float(last.get("finished_ts") or last.get("started_ts") or 0) + CONTINUE_AFTER_S
    interval = float(gcfg.get("interval_hours", 1)) * 3600
    if last.get("status") != "ok":
        interval = min(interval, 3600)
    return float(last.get("started_ts") or 0) + interval


def run_gmail(trigger: str = "manual", progress=None, api=None) -> dict:
    from .config import append_history, load_config
    from .engine import AlreadyRunning, RunLock, notify

    cfg = load_config()
    gcfg = settings(cfg)
    with RunLock("gmail.lock", "копирование Gmail уже выполняется"):
        started = time.time()
        entry = {
            "started_at": datetime.fromtimestamp(started).astimezone().isoformat(timespec="seconds"),
            "started_ts": started,
            "trigger": trigger,
        }
        try:
            stats = sync(gcfg, api or real_api(gcfg), progress=progress, now=started)
            entry.update(stats)
            entry["in_progress"] = stats.get("queue", 0) > 0
            problems = []
            if stats["fetch_errors"]:
                problems.append(f"не загружено писем: {stats['fetch_errors']} (повтор в следующий запуск)")
            if stats.get("queue_failed"):
                problems.append(f"писем с повторяющейся ошибкой загрузки: {stats['queue_failed']}")
            entry["status"] = "partial" if (problems or stats["warnings"]) else "ok"
            parts = [f"новых {stats['fetched']}"]
            if stats["newly_gone"]:
                parts.append(f"исчезли из ящика {stats['newly_gone']}")
            if entry["in_progress"]:
                parts.append(f"в очереди {stats['queue']}")
            entry["message"] = "; ".join(problems + stats["warnings"]) or ", ".join(parts)
        except AlreadyRunning:
            raise
        except Exception as e:
            log.exception("gmail sync failed")
            entry.update(status="error", message=_short(e), in_progress=False)
        entry["ok"] = entry["status"] == "ok"
        entry["finished_ts"] = time.time()
        entry["finished_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
        entry["duration_s"] = round(entry["finished_ts"] - started, 1)
        append_history(entry, "gmail_history")
        log.info("gmail %s: %s", entry["status"], entry.get("message"))
        if entry["status"] == "error" and cfg.get("notify_on_error", True):
            notify("Резервная копия Gmail", entry["message"][:200])
        return entry


def status(cfg: dict) -> dict:
    gcfg = settings(cfg)
    accs = []
    for root in accounts(gcfg):
        try:
            st = Store(root, readonly=True)
            try:
                c = st.counts()
                c["last_reconcile_ts"] = float(st.get("last_reconcile_ts", 0) or 0) or None
            finally:
                st.close()
        except Exception as e:  # never break the panel
            c = {"error": str(e)}
        accs.append({"account": root.name, "dir": str(root), **c})
    from .folders import same_folder

    setting = gcfg.get("local_dir") or DEFAULTS["local_dir"]
    return {
        "enabled": bool(gcfg.get("enabled")),
        "interval_hours": gcfg.get("interval_hours"),
        "include_spam": bool(gcfg.get("include_spam")),
        "dir": str(base_dir(gcfg)),
        "dir_setting": "" if same_folder(setting, DEFAULTS["local_dir"]) else setting,
        "dir_default": DEFAULTS["local_dir"],
        "accounts": accs,
    }


# ------------------------------------------------------------------ export, verify


def _resolve_label(root: Path, label: str) -> str:
    try:
        labels = json.loads((root / "labels.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        labels = []
    for lb in labels:
        if label in (lb.get("id"), lb.get("name")):
            return lb["id"]
    raise SystemExit(f"Метка не найдена: {label}")


def _ts(day: str | None, end: bool = False) -> int | None:
    if not day:
        return None
    d = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    return int(d.timestamp() * 1000) + (86400000 if end else 0)


def export_mbox(root: Path, out: Path, label: str | None = None, since: str | None = None,
                until: str | None = None, include_gone: bool = True) -> int:
    """Write stored messages into one mbox file (mboxrd quoting), oldest first.
    The original bytes are kept; only line endings become LF as mbox requires."""
    st = Store(root, readonly=True)
    try:
        sql, args = "SELECT path, sender, internal_date, labels FROM messages WHERE 1=1", []
        if not include_gone:
            sql += " AND gone_at IS NULL"
        if since:
            sql += " AND internal_date >= ?"
            args.append(_ts(since))
        if until:
            sql += " AND internal_date < ?"
            args.append(_ts(until, end=True))
        sql += " ORDER BY internal_date, id"
        label_id = _resolve_label(root, label) if label else None
        n = 0
        out.parent.mkdir(parents=True, exist_ok=True)
        part = out.with_name(out.name + ".part")
        from_re = re.compile(rb"^(>*From )", re.M)
        with open(part, "wb") as f:
            for rel, sender, idate, labels in st.db.execute(sql, args):
                if label_id and label_id not in json.loads(labels or "[]"):
                    continue
                raw = (root / rel).read_bytes().replace(b"\r\n", b"\n")
                addr = parseaddr(sender or "")[1] or "MAILER-DAEMON"
                addr = re.sub(r"\s", "", addr)
                stamp = time.strftime("%a %b %d %H:%M:%S %Y", time.gmtime((idate or 0) / 1000))
                f.write(f"From {addr} {stamp}\n".encode("ascii", "replace"))
                f.write(from_re.sub(rb">\1", raw))
                if not raw.endswith(b"\n"):
                    f.write(b"\n")
                f.write(b"\n")
                n += 1
        os.replace(part, out)
        os.chmod(out, 0o600)
        return n
    finally:
        st.close()
