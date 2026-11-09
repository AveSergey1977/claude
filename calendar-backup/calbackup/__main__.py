"""Command line: python -m calbackup <command>."""

from __future__ import annotations

import argparse
import getpass
import json
import os
import logging
import shutil
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

from .config import app_home, config_path, load_history


def _setup_logging() -> None:
    home = app_home()
    home.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    fh = RotatingFileHandler(home / "calbackup.log", maxBytes=2_000_000, backupCount=3, encoding="utf-8")
    try:
        os.chmod(home / "calbackup.log", 0o600)
    except OSError:
        pass
    fh.setFormatter(fmt)
    sh = logging.StreamHandler()
    sh.setFormatter(fmt)
    root = logging.getLogger("calbackup")
    root.setLevel(logging.INFO)
    root.addHandler(fh)
    root.addHandler(sh)


def main(argv=None) -> int:
    os.umask(0o077)  # config, tokens, history, logs and backups: owner only
    p = argparse.ArgumentParser(prog="calbackup", description="Резервное копирование календарей")
    sub = p.add_subparsers(dest="cmd", required=True)
    i = sub.add_parser("init", help="создать config.json из примера")
    i.add_argument("--server", action="store_true", help="пример для сервера (Linux)")
    sub.add_parser("serve", help="демон: расписание + панель")
    sub.add_parser("run", help="выполнить копирование сейчас")
    sub.add_parser("sync", help="скачать с Google Drive недостающие копии")
    sub.add_parser("status", help="последние 5 запусков")
    g = sub.add_parser("auth-google", help="авторизовать Google Calendar и Google Drive")
    g.add_argument("--no-browser", action="store_true", help="для сервера: вход через SSH-туннель")
    g.add_argument("--port", type=int, default=0)
    sub.add_parser("import-google-token", help="установить токен Google, переданный на stdin (с Mac)")
    sub.add_parser("grant-macos", help="запросить доступ к Календарю macOS")
    s = sub.add_parser("set-secret", help="сохранить пароль (Связка ключей на Mac, файл 600 на сервере)")
    s.add_argument("name")
    sub.add_parser("paths", help="показать пути к файлам")
    sub.add_parser("doctor", help="диагностика: служба, панель, журналы")
    sub.add_parser("restart", help="перезапустить службу (на Mac; на сервере: sudo systemctl restart calendar-backup)")
    a = p.parse_args(argv)
    _setup_logging()

    if a.cmd == "init":
        dst = config_path()
        if dst.exists():
            print(f"Уже существует: {dst}")
            return 0
        dst.parent.mkdir(parents=True, exist_ok=True)
        example = "config.server.example.json" if a.server else "config.example.json"
        shutil.copy(Path(__file__).resolve().parent.parent / example, dst)
        dst.chmod(0o600)
        print(f"Создан {dst}. Отредактируйте раздел sources.")
        return 0
    if a.cmd == "serve":
        from .server import serve

        serve()
        return 0
    if a.cmd == "run":
        from .engine import AlreadyRunning, run_backup

        try:
            e = run_backup("cli")
        except AlreadyRunning as ex:
            print(ex)
            return 2
        print(json.dumps({k: e.get(k) for k in ("status", "message", "archive", "size_bytes", "calendars", "events")},
                         ensure_ascii=False, indent=2))
        return 0 if e["status"] == "ok" else 1
    if a.cmd == "status":
        for e in load_history()[:5]:
            print(f"{e.get('started_at')}  {e.get('status'):8} {e.get('size_bytes') or 0:>10} Б  {e.get('message')}")
        return 0
    if a.cmd == "auth-google":
        from .google_auth import authorize

        authorize(no_browser=a.no_browser, port=a.port)
        return 0
    if a.cmd == "import-google-token":
        from .google_auth import import_token

        import_token(sys.stdin.read())
        return 0
    if a.cmd == "sync":
        from .sync import sync_from_drive
        from .engine import AlreadyRunning

        try:
            st = sync_from_drive("cli")
        except AlreadyRunning as ex:
            print(ex)
            return 2
        print(json.dumps({k: st.get(k) for k in ("ok", "downloaded", "missing", "remote_count", "errors", "newest_remote")},
                         ensure_ascii=False, indent=2))
        return 0 if st.get("ok") else 1
    if a.cmd == "grant-macos":
        from .sources.macos import grant

        grant()
        return 0
    if a.cmd == "set-secret":
        from .secrets import set_secret

        value = getpass.getpass(f"Значение для '{a.name}': ")
        if not value:
            print("Пустое значение, ничего не сохранено")
            return 1
        where = set_secret(a.name, value)
        print(f"Сохранено: {where}")
        return 0
    if a.cmd == "doctor":
        from .doctor import doctor

        return doctor()
    if a.cmd == "restart":
        from .doctor import restart

        return restart()
    if a.cmd == "paths":
        from .google_auth import client_secret_path, token_path

        print(f"Настройки:      {config_path()}")
        print(f"Google client:  {client_secret_path()}")
        print(f"Google token:   {token_path()}")
        print(f"Журнал:         {app_home() / 'calbackup.log'}")
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
