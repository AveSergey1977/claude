"""Diagnostics for "the panel does not open" and a service restart."""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import urllib.request
from pathlib import Path

from .config import app_home, config_path

LABEL = "com.calendar-backup.agent"
SYSTEMD_UNIT = "calendar-backup"


def _domain() -> str:
    return f"gui/{os.getuid()}"


def _plist() -> Path:
    return Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"


def _tail(path: Path, n: int = 15) -> list[str]:
    try:
        return path.read_text(encoding="utf-8", errors="replace").splitlines()[-n:]
    except OSError:
        return []


def _launchd_state() -> dict | None:
    r = subprocess.run(["launchctl", "print", f"{_domain()}/{LABEL}"], capture_output=True, text=True)
    if r.returncode != 0:
        return None
    info = {}
    for line in r.stdout.splitlines():
        line = line.strip()
        for key in ("state", "pid", "last exit code", "runs"):
            if line.startswith(key + " ="):
                info[key] = line.split("=", 1)[1].strip()
    return info


def doctor() -> int:
    ok = True
    print(f"Каталог программы: {app_home()}")

    port = 8765
    try:
        with open(config_path(), encoding="utf-8") as f:
            cfg = json.load(f)
        port = int(cfg.get("panel_port", 8765))
        print(f"[ok] config.json читается, порт панели {port}")
    except FileNotFoundError:
        print("[!!] config.json отсутствует — выполните: calbackup init")
        ok = False
    except ValueError as e:
        print(f"[!!] config.json повреждён (ошибка JSON): {e}")
        ok = False

    try:
        from . import server  # noqa: F401  (import errors in dependencies show up here)

        print("[ok] модули и зависимости загружаются")
    except Exception as e:
        print(f"[!!] ошибка загрузки модулей: {type(e).__name__}: {e} — переустановите: ./install-macos.sh")
        ok = False

    if sys.platform.startswith("linux"):
        r = subprocess.run(
            ["systemctl", "show", "-p", "ActiveState,SubState,NRestarts,ExecMainStatus", SYSTEMD_UNIT],
            capture_output=True, text=True,
        )
        info = dict(l.split("=", 1) for l in r.stdout.splitlines() if "=" in l)
        if r.returncode == 0 and info:
            good = info.get("ActiveState") == "active"
            print(f"[{'ok' if good else '!!'}] служба {SYSTEMD_UNIT}: " + ", ".join(f"{k}={v}" for k, v in info.items()))
            if not good:
                print(f"     журнал: sudo journalctl -u {SYSTEMD_UNIT} -n 50 ; перезапуск: sudo systemctl restart {SYSTEMD_UNIT}")
            ok = ok and good
    if sys.platform == "darwin":
        st = _launchd_state()
        if st is None:
            print(f"[!!] служба {LABEL} не загружена — выполните: calbackup restart")
            ok = False
        else:
            print(f"[{'ok' if st.get('state') == 'running' else '!!'}] служба: " +
                  ", ".join(f"{k}: {v}" for k, v in st.items()))
            ok = ok and st.get("state") == "running"

    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/status", timeout=5) as r:
            data = json.load(r)
        print(f"[ok] панель отвечает: http://127.0.0.1:{port} (версия {data.get('version')})")
    except Exception as e:
        ok = False
        print(f"[!!] панель не отвечает на порту {port}: {e}")
        s = socket.socket()
        busy = s.connect_ex(("127.0.0.1", port)) == 0
        s.close()
        if busy and sys.platform == "darwin":
            r = subprocess.run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN"], capture_output=True, text=True)
            print(f"     порт {port} занят другим процессом:\n{r.stdout.strip()}")

    for name in ("launchd.err.log", "calbackup.log"):
        lines = _tail(app_home() / name)
        if lines:
            print(f"--- последние строки {name} ---")
            print("\n".join(lines))
    print("Итог: всё в порядке" if ok else "Итог: есть проблемы (см. [!!] выше)")
    return 0 if ok else 1


def restart() -> int:
    if sys.platform != "darwin":
        print(f"На сервере: sudo systemctl restart {SYSTEMD_UNIT}")
        return 1
    dom = _domain()
    if _launchd_state() is None:
        if not _plist().exists():
            print(f"Нет {_plist()} — запустите ./install-macos.sh")
            return 1
        subprocess.run(["launchctl", "enable", f"{dom}/{LABEL}"], capture_output=True)
        r = subprocess.run(["launchctl", "bootstrap", dom, str(_plist())], capture_output=True, text=True)
    else:
        r = subprocess.run(["launchctl", "kickstart", "-k", f"{dom}/{LABEL}"], capture_output=True, text=True)
    if r.returncode != 0:
        print(f"Ошибка launchctl: {(r.stderr or r.stdout).strip()}")
        return 1
    print("Служба перезапущена. Проверка: calbackup doctor")
    return 0
