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
from .config import (
    load_config,
    load_history,
    local_dir,
    save_config,
    validate_interval,
)
from .destinations import detect_drive_folder, local_usage
from .engine import AlreadyRunning, run_backup

log = logging.getLogger("calbackup")

RETRY_AFTER_FAILURE_S = 3600
STATIC_DIR = Path(__file__).parent / "static"
STATIC = {"favicon.svg": "image/svg+xml", "favicon.png": "image/png", "apple-touch-icon.png": "image/png"}  # a failed run is retried after at most 1 hour


class Scheduler:
    def __init__(self):
        self.wake = threading.Event()
        self._lock = threading.Lock()
        self.running = False
        self.current: dict | None = None
        self.last_error: str | None = None
        self.last_attempt_ts = 0.0

    def next_run_ts(self) -> float:
        cfg = load_config()
        interval = float(cfg.get("interval_hours", 6)) * 3600
        hist = load_history()
        if not hist:
            return time.time()
        last = hist[0]
        start = float(last.get("started_ts") or 0)
        if last.get("status") != "ok":
            interval = min(interval, RETRY_AFTER_FAILURE_S)
        return start + interval

    def start(self, trigger: str) -> bool:
        with self._lock:
            if self.running:
                return False
            self.running = True
            self.current = {"trigger": trigger, "started_ts": time.time()}
            self.last_attempt_ts = time.time()
        threading.Thread(target=self._work, args=(trigger,), daemon=True).start()
        return True

    def _work(self, trigger: str) -> None:
        try:
            run_backup(trigger)
            self.last_error = None
        except AlreadyRunning as e:  # a CLI run holds the lock
            self.last_error = str(e)
        except Exception as e:  # never kill the daemon
            log.exception("run crashed")
            self.last_error = str(e)
        finally:
            with self._lock:
                self.running = False
                self.current = None
            self.wake.set()

    def loop(self) -> None:
        while True:
            try:
                due = self.next_run_ts()
                if self.last_error:  # crashed or locked run: back off 5 minutes
                    due = max(due, self.last_attempt_ts + 300)
                # wall clock: after sleep/wake of the Mac an overdue run starts at once
                if time.time() >= due and not self.running:
                    self.start("schedule")
                    due = time.time() + 60
                timeout = max(1.0, min(30.0, due - time.time()))
            except Exception:
                log.exception("scheduler tick failed")
                timeout = 30.0
            self.wake.wait(timeout)
            self.wake.clear()


def status_payload(sched: Scheduler) -> dict:
    cfg = load_config()
    hist = load_history()
    d = cfg.get("drive") or {}
    return {
        "version": __version__,
        "running": sched.running,
        "current": sched.current,
        "last_error": sched.last_error,
        "next_run_ts": sched.next_run_ts(),
        "interval_hours": cfg.get("interval_hours"),
        "keep_local": cfg.get("keep_local"),
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
    allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}

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
            if self.headers.get("Host", "") in allowed_hosts:
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

            if self.path == "/api/run":
                if sched.start("manual"):
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
