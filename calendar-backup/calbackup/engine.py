"""One backup run: fetch all enabled sources, build a zip, store it locally and on Google Drive."""

from __future__ import annotations

import json
import logging
import os
import shutil
import socket
import subprocess
import sys
import time
import zipfile
from datetime import datetime
from pathlib import Path

from . import __version__
from .archives import archive_name, host_tag
from .config import app_home, append_history, load_config, local_dir
from .destinations import store_drive, store_local
from .sources import get_fetcher

log = logging.getLogger("calbackup")


class AlreadyRunning(RuntimeError):
    pass


class _RunLock:
    """Inter-process lock, so a CLI run and the daemon never overlap."""

    def __init__(self):
        self.path = app_home() / "run.lock"
        self.fh = None

    def __enter__(self):
        import fcntl

        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.fh = open(self.path, "w")
        try:
            fcntl.flock(self.fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.fh.close()
            raise AlreadyRunning("резервное копирование уже выполняется")
        return self

    def __exit__(self, *exc):
        import fcntl

        fcntl.flock(self.fh, fcntl.LOCK_UN)
        self.fh.close()


def _short(e: BaseException) -> str:
    msg = str(e).strip() or type(e).__name__
    return (msg[:400] + "…") if len(msg) > 400 else msg


def _notify(title: str, text: str) -> None:
    if sys.platform != "darwin":
        return
    script = f"display notification {json.dumps(text)} with title {json.dumps(title)}"
    try:
        subprocess.run(["osascript", "-e", script], timeout=10, check=False, capture_output=True)
    except Exception:
        pass


def _zip_dir(src: Path, dest: Path) -> None:
    part = dest.with_suffix(".zip.part")
    with zipfile.ZipFile(part, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in sorted(src.rglob("*")):
            if p.is_file():
                z.write(p, p.relative_to(src).as_posix())
    with zipfile.ZipFile(part) as z:  # integrity check before publishing
        bad = z.testzip()
        if bad:
            raise RuntimeError(f"архив повреждён: {bad}")
    os.replace(part, dest)


def _dir_bytes(p: Path) -> int:
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file())


def _replace_latest(staging: Path, base: Path) -> None:
    latest, old = base / "latest", base / ".latest-old"
    if old.exists():
        shutil.rmtree(old, ignore_errors=True)
    if latest.exists():
        os.replace(latest, old)
    os.replace(staging, latest)
    shutil.rmtree(old, ignore_errors=True)


def run_lock() -> _RunLock:
    return _RunLock()


def run_backup(trigger: str = "manual") -> dict:
    with _RunLock():
        return _run(trigger)


def _run(trigger: str) -> dict:
    cfg = load_config()
    started = time.time()
    stamp = datetime.fromtimestamp(started).strftime("%Y%m%d-%H%M%S")
    tag = host_tag(cfg)
    base = local_dir(cfg)
    base.mkdir(parents=True, exist_ok=True)
    staging = base / f".staging-{stamp}"
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)

    entry: dict = {
        "started_at": datetime.fromtimestamp(started).astimezone().isoformat(timespec="seconds"),
        "started_ts": started,
        "trigger": trigger,
        "origin": tag,
        "sources": [],
        "destinations": [],
    }
    sources = [s for s in cfg.get("sources", []) if s.get("enabled", True)]
    problems: list[str] = []
    try:
        if not sources:
            raise RuntimeError("нет включённых источников (config.json → sources)")
        for s in sources:
            sid = s.get("id") or s["type"]
            out = staging / sid
            t0 = time.time()
            rec = {"id": sid, "type": s["type"]}
            try:
                res = get_fetcher(s["type"])(s, out)
                cals = res.get("calendars", [])
                errs = res.get("errors") or []
                rec.update(
                    ok=not errs,
                    calendars=len(cals),
                    events=sum(c.get("events", 0) for c in cals),
                    items=[{k: c.get(k) for k in ("name", "file", "events")} for c in cals],
                    warnings=(res.get("warnings") or []) + errs,
                )
                if errs:
                    problems.append(f"{sid}: {'; '.join(errs)}")
            except Exception as e:
                log.exception("source %s failed", sid)
                shutil.rmtree(out, ignore_errors=True)
                rec.update(ok=False, error=_short(e))
                problems.append(f"{sid}: {_short(e)}")
            rec["duration_s"] = round(time.time() - t0, 1)
            entry["sources"].append(rec)

        fetched = [r for r in entry["sources"] if r.get("calendars")]
        if not fetched:
            raise RuntimeError("ни один источник не дал данных; архив не создан")

        manifest = {
            "app": "calendar-backup",
            "version": __version__,
            "created_at": entry["started_at"],
            "created_ts": started,
            "host": socket.gethostname(),
            "origin": tag,
            "trigger": trigger,
            "status": "partial" if problems else "ok",
            "sources": entry["sources"],
        }
        (staging / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

        archive = base / archive_name(started, tag)
        entry["uncompressed_bytes"] = _dir_bytes(staging)
        _zip_dir(staging, archive)
        entry["archive"] = archive.name
        entry["size_bytes"] = archive.stat().st_size
        entry["calendars"] = sum(r.get("calendars", 0) for r in entry["sources"])
        entry["events"] = sum(r.get("events", 0) for r in entry["sources"])
        _replace_latest(staging, base)

        entry["destinations"].append(store_local(archive, cfg))
        if (cfg.get("drive") or {}).get("enabled"):
            try:
                entry["destinations"].append(store_drive(archive, cfg))
            except Exception as e:
                log.exception("drive upload failed")
                entry["destinations"].append({"id": "drive", "ok": False, "error": _short(e)})
                problems.append(f"Google Drive: {_short(e)}")
        entry["status"] = "partial" if problems else "ok"
    except Exception as e:
        log.exception("backup failed")
        problems.append(_short(e))
        entry["status"] = "error"
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    entry["ok"] = entry["status"] == "ok"
    entry["message"] = "; ".join(problems) if problems else "Успешно"
    entry["finished_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
    entry["duration_s"] = round(time.time() - started, 1)
    append_history(entry)
    log.info("backup %s: %s", entry["status"], entry["message"])
    if entry["status"] != "ok" and cfg.get("notify_on_error", True):
        _notify("Резервная копия календарей", entry["message"][:200])
    return entry
