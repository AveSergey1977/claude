"""Mirror: download archives from Google Drive that are missing in the local folder
(for example, made by the server while this Mac was off)."""

from __future__ import annotations

import json
import logging
import os
import shutil
import time
import zipfile
from datetime import datetime
from pathlib import Path, PurePosixPath

from .archives import ARCHIVE_PREFIX, archive_tag, archive_ts, is_archive, sort_newest_first
from .config import append_history, load_config, load_history, local_dir, save_sync_state
from .destinations import RemoteArchives, prune_local
from .engine import _replace_latest, _short, run_lock

log = logging.getLogger("calbackup")


def _read_manifest(path: Path) -> dict:
    with zipfile.ZipFile(path) as z:
        bad = z.testzip()
        if bad:
            raise RuntimeError(f"{path.name}: архив повреждён ({bad})")
        try:
            return json.loads(z.read("manifest.json").decode("utf-8"))
        except KeyError:
            return {}


def _history_entry(name: str, manifest: dict, size: int) -> dict:
    sources = manifest.get("sources") or []
    status = manifest.get("status") or ("ok" if sources and all(s.get("ok") for s in sources) else "partial")
    ts = manifest.get("created_ts") or archive_ts(name) or time.time()
    return {
        "started_at": manifest.get("created_at") or datetime.fromtimestamp(ts).astimezone().isoformat(timespec="seconds"),
        "started_ts": float(ts),
        "trigger": "sync",
        "origin": manifest.get("origin") or archive_tag(name) or manifest.get("host") or "?",
        "status": status,
        "ok": status == "ok",
        "sources": sources,
        "destinations": [{"id": "sync", "ok": True}],
        "archive": name,
        "size_bytes": size,
        "calendars": sum(s.get("calendars", 0) for s in sources),
        "events": sum(s.get("events", 0) for s in sources),
        "message": "Скачано с Google Drive",
        "synced_at": datetime.now().astimezone().isoformat(timespec="seconds"),
    }


def _safe_extract(archive: Path, dest: Path) -> None:
    with zipfile.ZipFile(archive) as z:
        for info in z.infolist():
            p = PurePosixPath(info.filename)
            if p.is_absolute() or ".." in p.parts:
                raise RuntimeError(f"{archive.name}: недопустимый путь {info.filename}")
        z.extractall(dest)


def _refresh_latest(base: Path) -> None:
    """Make base/latest the unpacked copy of the newest archive in base."""
    names = sort_newest_first(p.name for p in base.glob(f"{ARCHIVE_PREFIX}*.zip"))
    if not names:
        return
    newest = names[0]
    try:
        current = json.loads((base / "latest" / "manifest.json").read_text(encoding="utf-8"))
        current_ts = float(current.get("created_ts") or 0)
    except (OSError, ValueError):
        current_ts = 0.0
    if (archive_ts(newest) or 0) <= current_ts + 1:
        return
    staging = base / ".latest-new"
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir()
    try:
        _safe_extract(base / newest, staging)
        _replace_latest(staging, base)
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def sync_from_drive(trigger: str = "sync") -> dict:
    with run_lock():
        return _sync(trigger)


def _sync(trigger: str) -> dict:
    cfg = load_config()
    base = local_dir(cfg)
    base.mkdir(parents=True, exist_ok=True)
    keep = int(cfg.get("keep_local", 120))
    started = time.time()
    state: dict = {"last_sync_ts": started, "trigger": trigger, "ok": False, "downloaded": 0, "errors": []}
    try:
        remote = RemoteArchives(cfg)
        items = remote.list()
        by_name = {i["name"]: i for i in items}
        local_names = {p.name for p in base.glob(f"{ARCHIVE_PREFIX}*.zip") if is_archive(p.name)}
        wanted = sort_newest_first(local_names | set(by_name))[:keep]
        missing = [n for n in wanted if n not in local_names and n in by_name]
        known = {e.get("archive") for e in load_history()}

        for name in reversed(missing):  # oldest first
            part = base / (name + ".part")
            try:
                remote.download(by_name[name], part)
                manifest = _read_manifest(part)
                os.replace(part, base / name)
                if name not in known:
                    append_history(_history_entry(name, manifest, (base / name).stat().st_size))
                state["downloaded"] += 1
            except Exception as e:
                log.exception("download %s failed", name)
                state["errors"].append(_short(e))
                if part.exists():
                    part.unlink()

        prune_local(base, keep)
        _refresh_latest(base)
        newest = sort_newest_first(list(by_name))
        if newest:
            n = newest[0]
            state["newest_remote"] = {"name": n, "ts": archive_ts(n), "origin": archive_tag(n)}
        state.update(ok=not state["errors"], remote_count=len(items), missing=len(missing))
    except Exception as e:
        log.exception("sync failed")
        state["errors"].append(_short(e))
    state["duration_s"] = round(time.time() - started, 1)
    save_sync_state(state)
    log.info("sync: downloaded %s, errors %s", state["downloaded"], state["errors"])
    return state
