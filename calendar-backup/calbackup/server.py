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

from . import __version__, folders, gmail, offsite
from .config import (
    DEFAULTS,
    load_config,
    load_history,
    local_dir,
    save_config,
    validate_interval,
)
from .destinations import detect_drive_folder, local_usage
from .engine import AlreadyRunning, RunLock, run_backup

log = logging.getLogger("calbackup")

STATIC_DIR = Path(__file__).parent / "static"
RETRY_AFTER_FAILURE_S = 3600  # a failed run is retried after at most 1 hour
STATIC = {"favicon.svg": "image/svg+xml", "favicon.png": "image/png", "apple-touch-icon.png": "image/png"}


class Scheduler:
    """Runs one job (calendar backup by default, or Gmail) on its schedule and on demand."""

    def __init__(self, run_fn=None, next_due=None, label: str = "calendar"):
        self.run_fn = run_fn or run_backup
        self._next_due = next_due or self._calendar_next
        self.label = label
        self.wake = threading.Event()
        self._lock = threading.Lock()
        self.running = False
        self.current: dict | None = None
        self.last_error: str | None = None
        self.last_attempt_ts = 0.0

    @staticmethod
    def _calendar_next() -> float:
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

    def next_run_ts(self):
        """Epoch seconds of the next scheduled run, or None when the job is switched off."""
        return self._next_due()

    def _progress(self, info: dict) -> None:
        cur = self.current
        if cur is not None:
            cur["progress"] = info

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
            self.run_fn(trigger, progress=self._progress)
            self.last_error = None
        except AlreadyRunning as e:  # a CLI run holds the lock
            self.last_error = str(e)
        except Exception as e:  # never kill the daemon
            log.exception("%s run crashed", self.label)
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
                if due is None:
                    timeout = 30.0
                else:
                    if self.last_error:  # crashed or locked run: back off 5 minutes
                        due = max(due, self.last_attempt_ts + 300)
                    # wall clock: after sleep/wake of the Mac an overdue run starts at once
                    if time.time() >= due and not self.running:
                        self.start("schedule")
                        due = time.time() + 60
                    timeout = max(1.0, min(30.0, due - time.time()))
            except Exception:
                log.exception("%s scheduler tick failed", self.label)
                timeout = 30.0
            self.wake.wait(timeout)
            self.wake.clear()


def gmail_scheduler() -> Scheduler:
    return Scheduler(gmail.run_gmail, lambda: gmail.next_run_ts(load_config()), "gmail")


def offsite_scheduler() -> Scheduler:
    return Scheduler(offsite.run_offsite, lambda: offsite.next_run_ts(load_config()), "offsite")


def offsite_payload(osched: Scheduler) -> dict:
    try:
        st = offsite.status(load_config())
    except Exception as e:  # never break the panel
        st = {"enabled": False, "targets": [], "error": str(e)}
    st.update(running=osched.running, current=osched.current, last_error=osched.last_error,
              next_run_ts=osched.next_run_ts(), history=offsite.history_entries()[:5])
    return st


def gmail_payload(gsched: Scheduler) -> dict:
    cfg = load_config()
    try:
        st = gmail.status(cfg)
    except Exception as e:  # never break the panel
        st = {"enabled": False, "accounts": [], "error": str(e)}
    st.update(
        running=gsched.running,
        current=gsched.current,
        last_error=gsched.last_error,
        next_run_ts=gsched.next_run_ts(),
        history=gmail.history_entries()[:5],
    )
    return st


def status_payload(sched: Scheduler, gsched: Scheduler | None = None, osched: Scheduler | None = None) -> dict:
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
        "local": {
            "dir": str(local_dir(cfg)),
            # what the panel shows in the folder field: empty when the standard folder is used
            "setting": "" if folders.same_folder(cfg.get("local_dir", ""), DEFAULTS["local_dir"]) else cfg.get("local_dir"),
            "default": DEFAULTS["local_dir"],
            **local_usage(local_dir(cfg)),
        },
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
        "gmail": gmail_payload(gsched) if gsched is not None else None,
        "offsite": offsite_payload(osched) if osched is not None else None,
    }


class Busy(Exception):
    pass


def _folder_change(body: dict, key: str, current: str, default: str, what: str):
    """None when unchanged, else (new value to store, full path)."""
    if key not in body:
        return None
    value = str(body[key] or "").strip() or default
    if folders.same_folder(value, current):
        return None
    return value, folders.validate(value, what)


def apply_settings(body: dict, sched: Scheduler | None = None, gsched: Scheduler | None = None) -> tuple:
    """Validates and saves panel settings. Returns (config, notices)."""
    cfg = load_config()
    notices: list = []
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
    g = cfg.setdefault("gmail", {})
    if "gmail_enabled" in body:
        g["enabled"] = bool(body["gmail_enabled"])
    if "gmail_interval_hours" in body:
        g["interval_hours"] = validate_interval(body["gmail_interval_hours"])
    o = cfg.setdefault("offsite", {})
    if "offsite_enabled" in body:
        o["enabled"] = bool(body["offsite_enabled"])
    if "offsite_interval_hours" in body:
        o["interval_hours"] = validate_interval(body["offsite_interval_hours"])
    for s in cfg.get("sources", []):
        sid = s.get("id") or s.get("type")
        if sid in (body.get("sources") or {}):
            s["enabled"] = bool(body["sources"][sid])

    # folders: validated before anything is moved or saved
    cal_old = local_dir(cfg)
    g_old = gmail.base_dir(gmail.settings(cfg))
    cal = _folder_change(body, "local_dir", cfg.get("local_dir", ""), DEFAULTS["local_dir"],
                         "Папка архивов календарей")
    gm = _folder_change(body, "gmail_dir", g.get("local_dir") or gmail.DEFAULTS["local_dir"],
                        gmail.DEFAULTS["local_dir"], "Папка копии Gmail")
    cal_new = cal[1] if cal else cal_old
    if gm and (gm[1] == cal_new / "latest" or cal_new / "latest" in gm[1].parents
               or any(part.startswith(".staging-") for part in gm[1].parts)):
        raise ValueError("Папка копии Gmail не может находиться внутри служебных папок архивов календарей")
    if cal and sched is not None and sched.running:
        raise Busy("Идёт копирование календарей; смените папку после его окончания")
    if gm and gsched is not None and gsched.running:
        raise Busy("Идёт копирование Gmail; смените папку после его окончания")
    move = bool(body.get("move_existing", True))

    try:
        with RunLock() if cal else _nolock(), \
             RunLock("gmail.lock", "копирование Gmail уже выполняется") if gm else _nolock():
            if cal:
                cfg["local_dir"] = cal[0]
                if move:
                    notices.append(folders.move_calendar_archives(cal_old, cal[1]))
                elif cal_old.is_dir() and any(cal_old.glob(folders.ARCHIVE_GLOB)):
                    notices.append(f"Прежние архивы календарей остались в {cal_old}")
            if gm:
                g["local_dir"] = gm[0]
                if move:
                    notices.append(folders.move_gmail(g_old, gm[1]))
                elif gmail.accounts({"local_dir": str(g_old)}):
                    notices.append(f"Прежняя копия Gmail осталась в {g_old}; в новой папке письма будут загружены заново")
            save_config(cfg)
    except AlreadyRunning as e:
        raise Busy(f"Сейчас идёт {str(e).replace(' уже выполняется', '')}; смените папку после его окончания") from None
    return cfg, [n for n in notices if n]


class _nolock:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def make_handler(sched: Scheduler, token: str, port: int, gsched: Scheduler | None = None,
                 osched: Scheduler | None = None):
    gsched = gsched or gmail_scheduler()
    osched = osched or offsite_scheduler()
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
                return self._json(HTTPStatus.OK, status_payload(sched, gsched, osched))
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
                    _, notices = apply_settings(body, sched, gsched)
                except Busy as e:
                    return self._json(HTTPStatus.CONFLICT, {"error": str(e)})
                except (ValueError, TypeError) as e:
                    return self._json(HTTPStatus.BAD_REQUEST, {"error": str(e)})
                except OSError as e:
                    log.exception("moving backups failed")
                    return self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Перенос копий не удался: {e}"})
                sched.wake.set()
                gsched.wake.set()
                osched.wake.set()
                return self._json(HTTPStatus.OK, {**status_payload(sched, gsched, osched), "notices": notices})
            if self.path == "/api/offsite/run":
                ocfg = offsite.settings(load_config())
                if not ocfg.get("enabled") or not ocfg.get("targets"):
                    return self._json(HTTPStatus.CONFLICT, {"error": "Вторая копия выключена или не настроена"})
                if osched.start("manual"):
                    return self._json(HTTPStatus.ACCEPTED, {"started": True})
                return self._json(HTTPStatus.CONFLICT, {"error": "Вторая копия уже создаётся"})
            if self.path == "/api/choose-folder":
                cfg = load_config()
                gm = body.get("target") == "gmail"
                start = str(gmail.base_dir(gmail.settings(cfg)) if gm else local_dir(cfg))
                prompt = "Папка для копии Gmail" if gm else "Папка для архивов календарей"
                try:
                    path = folders.choose_folder_dialog(prompt, start)
                except (RuntimeError, OSError, subprocess.SubprocessError) as e:
                    return self._json(HTTPStatus.NOT_IMPLEMENTED, {"error": str(e)})
                return self._json(HTTPStatus.OK, {"path": path, "cancelled": path is None})
            if self.path == "/api/gmail/run":
                if not gmail.settings(load_config()).get("enabled"):
                    return self._json(HTTPStatus.CONFLICT, {"error": "Копирование Gmail выключено в настройках"})
                if gsched.start("manual"):
                    return self._json(HTTPStatus.ACCEPTED, {"started": True})
                return self._json(HTTPStatus.CONFLICT, {"error": "Копирование Gmail уже выполняется"})
            if self.path == "/api/open-folder":
                cfg = load_config()
                folder = gmail.base_dir(gmail.settings(cfg)) if body.get("target") == "gmail" else local_dir(cfg)
                try:
                    folders.require_volume(folder)
                except RuntimeError as e:
                    return self._json(HTTPStatus.BAD_REQUEST, {"error": str(e)})
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
    gsched = gmail_scheduler()
    osched = offsite_scheduler()
    token = panel_token()
    httpd = ThreadingHTTPServer((host, port), make_handler(sched, token, port, gsched, osched))
    for s in (sched, gsched, osched):
        threading.Thread(target=s.loop, daemon=True).start()
    log.info("panel: http://127.0.0.1:%d", port)
    print(f"Панель: http://127.0.0.1:{port}", flush=True)
    httpd.serve_forever()
