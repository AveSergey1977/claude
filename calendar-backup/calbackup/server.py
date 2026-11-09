"""Daemon: scheduler + local control panel (http://127.0.0.1:8765)."""

from __future__ import annotations

import json
import logging
import secrets
import subprocess
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import __version__
from .archives import host_tag
from .config import (
    PRODUCE_MODES,
    load_config,
    load_history,
    load_sync_state,
    local_dir,
    save_config,
    validate_interval,
)
from .destinations import detect_drive_folder, local_usage
from .engine import AlreadyRunning, run_backup
from .sync import sync_from_drive

log = logging.getLogger("calbackup")

RETRY_AFTER_FAILURE_S = 3600  # a failed run is retried after at most 1 hour
SLEEP_GAP_S = 120  # a pause between scheduler ticks longer than this means the Mac slept
STATIC_DIR = Path(__file__).parent / "static"
STATIC = {"favicon.svg": "image/svg+xml", "favicon.png": "image/png", "apple-touch-icon.png": "image/png"}
LOCAL_HOSTNAMES = {"127.0.0.1", "localhost", "[::1]"}


def _own_runs(hist: list) -> list:
    return [e for e in hist if e.get("trigger") != "sync"]


def newest_backup_ts(hist: list, sync_state: dict) -> float:
    """Newest backup known here: made locally, downloaded, or seen on Drive."""
    ts = [float(e.get("started_ts") or 0) for e in hist if e.get("archive")]
    remote = (sync_state.get("newest_remote") or {}).get("ts")
    if remote:
        ts.append(float(remote))
    return max(ts) if ts else 0.0


def backup_due(cfg: dict, hist: list, sync_state: dict, now: float) -> float | None:
    """When this machine should make its next backup (None: never)."""
    produce = cfg.get("produce", "always")
    interval = float(cfg.get("interval_hours", 6)) * 3600
    own = _own_runs(hist)
    last = own[0] if own else None
    if produce == "never":
        return None
    if produce == "always":
        if not last:
            return now
        start = float(last.get("started_ts") or 0)
        return start + (interval if last.get("status") == "ok" else min(interval, RETRY_AFTER_FAILURE_S))
    # fallback: only when the newest backup anywhere is overdue
    grace = float(cfg.get("fallback_grace_minutes", 30)) * 60
    newest = newest_backup_ts(hist, sync_state)
    due = newest + interval + grace if newest else now
    if last and last.get("status") != "ok" and float(last.get("started_ts") or 0) >= newest:
        due = max(due, float(last["started_ts"]) + RETRY_AFTER_FAILURE_S)
    return due


class Scheduler:
    def __init__(self):
        self.wake = threading.Event()
        self._lock = threading.Lock()
        self.running = False
        self.current: dict | None = None
        self.last_error: str | None = None
        self.last_attempt_ts = 0.0
        self.last_tick = 0.0
        self.next_sync_ts = time.time()  # sync once right after start

    def next_run_ts(self, cfg: dict | None = None, now: float | None = None) -> float | None:
        cfg = cfg or load_config()
        due = backup_due(cfg, load_history(), load_sync_state(), time.time() if now is None else now)
        if due is not None and self.last_error:  # crashed or locked run: back off 5 minutes
            due = max(due, self.last_attempt_ts + 300)
        return due

    def start(self, kind: str, trigger: str) -> bool:
        with self._lock:
            if self.running:
                return False
            self.running = True
            self.current = {"kind": kind, "trigger": trigger, "started_ts": time.time()}
            self.last_attempt_ts = time.time()
        threading.Thread(target=self._work, args=(kind, trigger), daemon=True).start()
        return True

    def _work(self, kind: str, trigger: str) -> None:
        try:
            cfg = load_config()
            if kind == "sync":
                sync_from_drive(trigger)
                self.next_sync_ts = time.time() + float(cfg.get("sync_interval_minutes", 30)) * 60
            else:
                if trigger == "schedule" and cfg.get("produce") == "fallback":
                    if cfg.get("sync_from_drive"):
                        sync_from_drive("before-fallback")
                        self.next_sync_ts = time.time() + float(cfg.get("sync_interval_minutes", 30)) * 60
                    due = backup_due(cfg, load_history(), load_sync_state(), time.time())
                    if due is None or due > time.time():
                        log.info("fallback: a fresh backup is on Drive, nothing to do")
                        return
                    trigger = "fallback"
                run_backup(trigger)
            self.last_error = None
        except AlreadyRunning as e:  # a CLI run holds the lock
            self.last_error = str(e)
        except Exception as e:  # never kill the daemon
            log.exception("%s crashed", kind)
            self.last_error = str(e)
        finally:
            with self._lock:
                self.running = False
                self.current = None
            self.wake.set()

    def loop(self) -> None:
        while True:
            timeout = 30.0
            try:
                now = time.time()
                cfg = load_config()
                if self.last_tick and now - self.last_tick > SLEEP_GAP_S:
                    log.info("woke up after %.0f s", now - self.last_tick)
                    self.next_sync_ts = now  # catch up with the server at once
                self.last_tick = now
                sync_on = bool(cfg.get("sync_from_drive"))
                due = self.next_run_ts(cfg, now)
                if not self.running:
                    if sync_on and now >= self.next_sync_ts:
                        self.start("sync", "schedule")
                    elif due is not None and now >= due:
                        self.start("backup", "schedule")
                waits = [30.0]
                if due is not None:
                    waits.append(due - now)
                if sync_on:
                    waits.append(self.next_sync_ts - now)
                timeout = max(1.0, min(waits))
            except Exception:
                log.exception("scheduler tick failed")
            self.wake.wait(timeout)
            self.wake.clear()


def status_payload(sched: Scheduler) -> dict:
    cfg = load_config()
    hist = load_history()
    sync_state = load_sync_state()
    d = cfg.get("drive") or {}
    interval_s = float(cfg.get("interval_hours", 6)) * 3600
    grace_s = float(cfg.get("fallback_grace_minutes", 30)) * 60
    newest = newest_backup_ts(hist, sync_state)
    return {
        "version": __version__,
        "host_tag": host_tag(cfg),
        "running": sched.running,
        "current": sched.current,
        "last_error": sched.last_error,
        "next_run_ts": sched.next_run_ts(cfg),
        "interval_hours": cfg.get("interval_hours"),
        "keep_local": cfg.get("keep_local"),
        "produce": cfg.get("produce", "always"),
        "sync": {
            "enabled": bool(cfg.get("sync_from_drive")),
            "interval_minutes": cfg.get("sync_interval_minutes", 30),
            "next_ts": sched.next_sync_ts if cfg.get("sync_from_drive") else None,
            "state": sync_state,
        },
        "newest_backup_ts": newest or None,
        "stale": bool(newest) and time.time() - newest > interval_s + grace_s,
        "local": {"dir": str(local_dir(cfg)), **local_usage(local_dir(cfg))},
        "drive": {
            "enabled": bool(d.get("enabled")),
            "mode": d.get("mode", "api"),
            "keep": d.get("keep"),
            "folder_name": d.get("folder_name"),
            "folder_path": d.get("folder_path") or (detect_drive_folder() if d.get("mode") == "folder" else None),
        },
        "sources": [
            {"id": s.get("id") or s.get("type"), "type": s.get("type"), "enabled": s.get("enabled", True)}
            for s in cfg.get("sources", [])
        ],
        "history": hist[:5],
        "history_total": len(hist),
    }


def apply_settings(body: dict) -> dict:
    cfg = load_config()
    if "interval_hours" in body:
        cfg["interval_hours"] = validate_interval(body["interval_hours"])
    if "keep_local" in body:
        v = int(body["keep_local"])
        if not 1 <= v <= 10000:
            raise ValueError("Число локальных копий: от 1 до 10000")
        cfg["keep_local"] = v
    if "produce" in body:
        if body["produce"] not in PRODUCE_MODES:
            raise ValueError("Неизвестный режим создания копий")
        cfg["produce"] = body["produce"]
    if "sync_from_drive" in body:
        cfg["sync_from_drive"] = bool(body["sync_from_drive"])
    if "sync_interval_minutes" in body:
        v = int(body["sync_interval_minutes"])
        if not 5 <= v <= 1440:
            raise ValueError("Интервал синхронизации: от 5 до 1440 минут")
        cfg["sync_interval_minutes"] = v
    if cfg.get("produce") == "never" and not cfg.get("sync_from_drive"):
        raise ValueError("Режим «не создавать копии» имеет смысл только с загрузкой копий с Google Drive")
    drive = cfg.setdefault("drive", {})
    if "drive_keep" in body:
        v = int(body["drive_keep"])
        if not 1 <= v <= 10000:
            raise ValueError("Число копий на Google Drive: от 1 до 10000")
        drive["keep"] = v
    if "drive_enabled" in body:
        drive["enabled"] = bool(body["drive_enabled"])
    for s in cfg.get("sources", []):
        sid = s.get("id") or s.get("type")
        if sid in (body.get("sources") or {}):
            s["enabled"] = bool(body["sources"][sid])
    save_config(cfg)
    return cfg


def make_handler(sched: Scheduler, token: str, port: int):
    panel = (Path(__file__).parent / "panel.html").read_text(encoding="utf-8")

    class Handler(BaseHTTPRequestHandler):
        server_version = "calbackup/" + __version__

        def log_message(self, fmt, *args):
            log.debug("http " + fmt, *args)

        def _send(self, code, body: bytes, ctype="application/json; charset=utf-8"):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, code, obj):
            self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

        def _host_ok(self) -> bool:
            # protects against DNS rebinding: only literal localhost names are served
            # (any port, so the panel also works through an SSH tunnel such as -L 8766:127.0.0.1:8765)
            host = self.headers.get("Host", "")
            name = host.rsplit(":", 1)[0] if not host.endswith("]") else host
            if name in LOCAL_HOSTNAMES:
                return True
            self._json(HTTPStatus.FORBIDDEN, {"error": "bad host"})
            return False

        def do_GET(self):
            if not self._host_ok():
                return
            if self.path in ("/", "/index.html"):
                html = panel.replace("__TOKEN__", token).encode("utf-8")
                return self._send(HTTPStatus.OK, html, "text/html; charset=utf-8")
            if self.path == "/api/status":
                return self._json(HTTPStatus.OK, status_payload(sched))
            name = self.path.lstrip("/")
            if name == "favicon.ico":
                name = "favicon.png"
            if name in STATIC:
                body = (STATIC_DIR / name).read_bytes()
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", STATIC[name])
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "max-age=86400")
                self.end_headers()
                self.wfile.write(body)
                return
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})

        def do_POST(self):
            if not self._host_ok():
                return
            if not secrets.compare_digest(self.headers.get("X-CalBackup-Token", ""), token):
                return self._json(HTTPStatus.FORBIDDEN, {"error": "bad token"})
            length = int(self.headers.get("Content-Length") or 0)
            if length > 65536:
                return self._json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "too large"})
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                return self._json(HTTPStatus.BAD_REQUEST, {"error": "bad json"})

            if self.path == "/api/sync":
                if not load_config().get("drive", {}).get("enabled"):
                    return self._json(HTTPStatus.BAD_REQUEST, {"error": "Google Drive выключен"})
                if sched.start("sync", "manual"):
                    return self._json(HTTPStatus.ACCEPTED, {"started": True})
                return self._json(HTTPStatus.CONFLICT, {"error": "Уже выполняется"})
            if self.path == "/api/run":
                if sched.start("backup", "manual"):
                    return self._json(HTTPStatus.ACCEPTED, {"started": True})
                return self._json(HTTPStatus.CONFLICT, {"error": "Копирование уже выполняется"})
            if self.path == "/api/settings":
                try:
                    apply_settings(body)
                except (ValueError, TypeError) as e:
                    return self._json(HTTPStatus.BAD_REQUEST, {"error": str(e)})
                sched.wake.set()
                return self._json(HTTPStatus.OK, status_payload(sched))
            if self.path == "/api/open-folder":
                folder = local_dir(load_config())
                folder.mkdir(parents=True, exist_ok=True)
                if sys.platform == "darwin":
                    subprocess.Popen(["open", str(folder)])
                return self._json(HTTPStatus.OK, {"path": str(folder)})
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    return Handler


def panel_token() -> str:
    """Kept across restarts, so a panel tab left open keeps working after the daemon restarts."""
    import os

    from .config import app_home

    p = app_home() / "panel_token"
    try:
        tok = p.read_text(encoding="utf-8").strip()
        if len(tok) >= 32:
            return tok
    except OSError:
        pass
    tok = secrets.token_urlsafe(32)
    p.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(p), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(tok)
    return tok


def serve() -> None:
    cfg = load_config()
    host, port = cfg.get("panel_host", "127.0.0.1"), int(cfg.get("panel_port", 8765))
    if host not in ("127.0.0.1", "localhost", "::1"):
        raise SystemExit("Панель доступна только на localhost (panel_host)")
    sched = Scheduler()
    token = panel_token()
    httpd = ThreadingHTTPServer((host, port), make_handler(sched, token, port))
    threading.Thread(target=sched.loop, daemon=True).start()
    log.info("panel: http://127.0.0.1:%d", port)
    print(f"Панель: http://127.0.0.1:{port}", flush=True)
    httpd.serve_forever()
