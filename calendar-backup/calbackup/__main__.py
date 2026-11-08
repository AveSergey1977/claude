"""Command line: python -m calbackup <command>."""

from __future__ import annotations

import argparse
import getpass
import json
import logging
import shutil
import subprocess
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

from .config import app_home, config_path, load_history


def _setup_logging() -> None:
    home = app_home()
    home.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    fh = RotatingFileHandler(home / "calbackup.log", maxBytes=2_000_000, backupCount=3, encoding="utf-8")
    fh.setFormatter(fmt)
    sh = logging.StreamHandler()
    sh.setFormatter(fmt)
    root = logging.getLogger("calbackup")
    root.setLevel(logging.INFO)
    root.addHandler(fh)
    root.addHandler(sh)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="calbackup", description="Резервное копирование календарей и Gmail")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init", help="создать config.json из примера")
    sub.add_parser("serve", help="демон: расписание + панель")
    sub.add_parser("run", help="выполнить копирование сейчас")
    sub.add_parser("status", help="последние 5 запусков")
    sub.add_parser("auth-google", help="авторизовать Google Calendar, Google Drive и Gmail")
    sub.add_parser("gmail-sync", help="копирование Gmail сейчас")
    sub.add_parser("gmail-status", help="состояние копии Gmail")
    sub.add_parser("gmail-verify", help="проверить контрольные суммы всех сохранённых писем")
    ex = sub.add_parser("gmail-export", help="выгрузить сохранённые письма в mbox")
    ex.add_argument("--out", required=True, help="файл .mbox")
    ex.add_argument("--account", help="адрес, если сохранено несколько аккаунтов")
    ex.add_argument("--label", help="метка: имя или id (INBOX, SENT, «Проект X»)")
    ex.add_argument("--since", help="с даты ГГГГ-ММ-ДД (UTC)")
    ex.add_argument("--until", help="по дату ГГГГ-ММ-ДД включительно (UTC)")
    ex.add_argument("--skip-gone", action="store_true", help="без писем, удалённых из ящика")
    sub.add_parser("offsite-run", help="вторая копия (restic) сейчас")
    sub.add_parser("offsite-status", help="состояние второй копии")
    op = sub.add_parser("offsite-password", help="создать пароль репозитория restic и сохранить в Связке ключей")
    op.add_argument("--target", help="id хранилища (по умолчанию общий пароль)")
    op.add_argument("--show", action="store_true", help="показать сохранённый пароль")
    op.add_argument("--set", action="store_true", help="ввести существующий пароль вручную")
    sub.add_parser("offsite-ssh-key", help="создать SSH-ключ для хранилища SFTP (Hetzner Storage Box)")
    for name, hlp in (("offsite-snapshots", "список копий в хранилище"),
                      ("offsite-check", "проверить репозиторий (--full: прочитать все данные)")):
        x = sub.add_parser(name, help=hlp)
        x.add_argument("--target")
        if name == "offsite-check":
            x.add_argument("--full", action="store_true")
    rs = sub.add_parser("offsite-restore", help="восстановить копию из хранилища в папку")
    rs.add_argument("--target")
    rs.add_argument("--to", required=True, help="пустая папка для восстановления")
    rs.add_argument("--snapshot", default="latest")
    rr = sub.add_parser("restic", help="произвольная команда restic для хранилища: calbackup restic --target ID -- snapshots")
    rr.add_argument("--target")
    rr.add_argument("args", nargs=argparse.REMAINDER)
    sub.add_parser("grant-macos", help="запросить доступ к Календарю macOS")
    s = sub.add_parser("set-secret", help="сохранить пароль в Связке ключей")
    s.add_argument("name")
    sub.add_parser("paths", help="показать пути к файлам")
    a = p.parse_args(argv)
    _setup_logging()

    if a.cmd == "init":
        dst = config_path()
        if dst.exists():
            print(f"Уже существует: {dst}")
            return 0
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(Path(__file__).resolve().parent.parent / "config.example.json", dst)
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
    if a.cmd == "gmail-sync":
        from .engine import AlreadyRunning
        from .gmail import run_gmail

        try:
            e = run_gmail("cli")
        except AlreadyRunning as ex:
            print(ex)
            return 2
        keys = ("status", "message", "account", "mode", "fetched", "queue", "present", "gone", "bytes")
        print(json.dumps({k: e.get(k) for k in keys}, ensure_ascii=False, indent=2))
        return 0 if e["status"] == "ok" else 1
    if a.cmd == "gmail-status":
        from .config import load_config
        from .gmail import history_entries, status

        print(json.dumps(status(load_config()), ensure_ascii=False, indent=2))
        for e in history_entries()[:5]:
            print(f"{e.get('started_at')}  {e.get('status'):8} {e.get('message')}")
        return 0
    if a.cmd in ("gmail-verify", "gmail-export"):
        from .config import load_config
        from .gmail import Store, accounts, export_mbox, settings

        accs = accounts(settings(load_config()))
        if a.cmd == "gmail-export" and a.account:
            accs = [p for p in accs if p.name == a.account]
        if not accs:
            print("Копий Gmail не найдено")
            return 1
        if a.cmd == "gmail-verify":
            rc = 0
            for root in accs:
                st = Store(root, readonly=True)
                try:
                    r = st.full_check()
                finally:
                    st.close()
                print(f"{root.name}: проверено {r['checked']}, ошибок {r['problems']}")
                for mid, why in r["examples"]:
                    print(f"  {mid}: {why}")
                rc = rc or (1 if r["problems"] else 0)
            return rc
        if len(accs) > 1:
            print("Сохранено несколько аккаунтов, укажите --account: " + ", ".join(p.name for p in accs))
            return 1
        n = export_mbox(accs[0], Path(a.out).expanduser(), a.label, a.since, a.until, not a.skip_gone)
        print(f"Выгружено писем: {n} → {a.out}")
        return 0
    if a.cmd.startswith("offsite-") or a.cmd == "restic":
        return _offsite_cmd(a)
    if a.cmd == "auth-google":
        from .google_auth import authorize

        authorize()
        return 0
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
        set_secret(a.name, value)
        print("Сохранено в Связке ключей")
        return 0
    if a.cmd == "paths":
        from .google_auth import client_secret_path, token_path

        print(f"Настройки:      {config_path()}")
        print(f"Google client:  {client_secret_path()}")
        print(f"Google token:   {token_path()}")
        print(f"Журнал:         {app_home() / 'calbackup.log'}")
        from .config import load_config
        from .gmail import base_dir, settings

        print(f"Копия Gmail:    {base_dir(settings(load_config()))}")
        return 0
    return 1


def _offsite_cmd(a) -> int:
    from . import offsite
    from .config import load_config
    from .secrets import get_secret, set_secret

    cfg = load_config()
    if a.cmd == "offsite-run":
        from .engine import AlreadyRunning

        try:
            e = offsite.run_offsite("cli", progress=_print_progress)
        except AlreadyRunning as ex:
            print(ex)
            return 2
        print()
        print(json.dumps({k: e.get(k) for k in ("status", "message", "targets")}, ensure_ascii=False, indent=2))
        return 0 if e["status"] == "ok" else 1
    if a.cmd == "offsite-status":
        print(json.dumps(offsite.status(cfg), ensure_ascii=False, indent=2))
        for e in offsite.history_entries()[:5]:
            print(f"{e.get('started_at')}  {e.get('status'):8} {e.get('message')}")
        return 0
    if a.cmd == "offsite-password":
        name = offsite.DEFAULT_PASSWORD_KEY
        if a.target:
            name = offsite.target_by_id(cfg, a.target).get("password_keyring") or name
        try:
            current = get_secret(name)
        except Exception:
            current = None
        if a.show:
            print(current or "Пароль не задан")
            return 0 if current else 1
        if current and not a.set:
            print(f"Пароль «{name}» уже есть в Связке ключей. Показать: calbackup offsite-password --show")
            print("Заменять его нельзя: копии, уже созданные с этим паролем, перестанут открываться.")
            return 1
        if a.set:
            pw = getpass.getpass("Пароль существующего репозитория: ")
            if not pw:
                return 1
        else:
            pw = offsite.new_password()
        set_secret(name, pw)
        if not a.set:
            print("Пароль репозитория создан и сохранён в Связке ключей:\n")
            print("    " + pw + "\n")
            print("ЗАПИШИТЕ ЕГО И ХРАНИТЕ ОТДЕЛЬНО ОТ MAC (бумага, сейф, менеджер паролей).")
            print("Без пароля вторую копию не восстановить никому, включая Вас.")
        else:
            print("Сохранено в Связке ключей")
        return 0
    if a.cmd == "offsite-ssh-key":
        path, pub = offsite.make_ssh_key()
        print(f"Ключ: {path}\n\nОткрытая часть (её можно показывать):\n{pub}\n")
        print("Hetzner Storage Box: включите «SSH support» в консоли Hetzner и выполните (пароль Storage Box потребуется один раз):\n")
        print(f"    cat \"{path}.pub\" | ssh -p23 uXXXXX@uXXXXX.your-storagebox.de install-ssh-key")
        return 0

    t = offsite.target_by_id(cfg, a.target)
    r = offsite.Restic(offsite.settings(cfg), t)
    if a.cmd == "offsite-snapshots":
        args = ["snapshots"]
    elif a.cmd == "offsite-check":
        args = ["check", "--read-data"] if a.full else ["check"]
    elif a.cmd == "offsite-restore":
        dest = Path(a.to).expanduser()
        if dest.exists() and any(dest.iterdir()):
            print(f"Папка {dest} не пуста; укажите пустую или новую папку")
            return 1
        args = ["restore", a.snapshot, "--target", str(dest)]
    else:
        args = [x for x in a.args if x != "--"]
        if not args:
            print("Укажите команду restic после --, например: calbackup restic -- snapshots")
            return 1
    p = subprocess.run([r.bin, *r.opts, *args], env=r.env)
    if a.cmd == "offsite-restore" and p.returncode == 0:
        print(f"\nВосстановлено в {dest}. Индекс Gmail — в offsite-meta/gmail-index (см. RESTORE.txt там же).")
    return p.returncode


def _print_progress(info: dict) -> None:
    if "percent" in info:
        print(f"\r{info['target']}: {info['percent']:5.1f} %", end="", flush=True)


if __name__ == "__main__":
    sys.exit(main())
