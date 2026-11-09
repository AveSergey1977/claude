"""OAuth for Google Calendar (read-only) and Google Drive (files created by this app only)."""

from __future__ import annotations

from .config import app_home

SCOPES = [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/drive.file",
]


def client_secret_path():
    return app_home() / "google_client_secret.json"


def token_path():
    return app_home() / "google_token.json"


def authorize(no_browser: bool = False, port: int = 0) -> None:
    """Interactive consent in the browser; run once from Terminal.

    no_browser: for a server without a browser. The program waits on 127.0.0.1:<port>;
    open the printed link on the Mac after `ssh -L <port>:127.0.0.1:<port> server`."""
    from google_auth_oauthlib.flow import InstalledAppFlow

    cs = client_secret_path()
    if not cs.exists():
        raise SystemExit(
            f"Нет файла {cs}.\nСкачайте OAuth client (тип Desktop app) из Google Cloud Console "
            "и сохраните его по этому пути (см. README)."
        )
    flow = InstalledAppFlow.from_client_secrets_file(str(cs), SCOPES)
    if no_browser:
        port = port or 8085
        msg = (
            f"1) На Mac в отдельном окне Терминала: ssh -N -L {port}:127.0.0.1:{port} <пользователь>@<сервер>\n"
            "2) Откройте на Mac ссылку и подтвердите доступ:\n{url}\n"
        )
        creds = flow.run_local_server(
            host="localhost", bind_addr="127.0.0.1", port=port, open_browser=False,
            authorization_prompt_message=msg, prompt="consent", access_type="offline",
        )
    else:
        creds = flow.run_local_server(port=port, prompt="consent", access_type="offline")
    _save(creds)
    print(f"Готово. Токен сохранён: {token_path()}")


def import_token(text: str) -> None:
    """Install a token created on another machine (the same OAuth client), e.g. the Mac's."""
    import json

    from google.oauth2.credentials import Credentials

    try:
        info = json.loads(text)
    except ValueError:
        raise SystemExit("На вход подан не JSON. Передайте содержимое google_token.json.")
    if not info.get("refresh_token"):
        raise SystemExit("В токене нет refresh_token; выполните на Mac calbackup auth-google заново.")
    granted = set(info.get("scopes") or [])
    lacking = [s for s in SCOPES if granted and s not in granted]
    if lacking:
        raise SystemExit(f"Токен выдан без прав: {', '.join(lacking)}")
    _save(Credentials.from_authorized_user_info(info, SCOPES))
    print(f"Токен установлен: {token_path()}")


def _save(creds) -> None:
    import os

    p = token_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(p), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(creds.to_json())
    os.chmod(p, 0o600)


def credentials():
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials

    p = token_path()
    if not p.exists():
        raise RuntimeError("Google не авторизован. Выполните: calbackup auth-google")
    creds = Credentials.from_authorized_user_file(str(p), SCOPES)
    if not creds.valid:
        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
            _save(creds)
        else:
            raise RuntimeError("Токен Google недействителен. Выполните: calbackup auth-google")
    return creds


def service(name: str, version: str):
    from googleapiclient.discovery import build

    return build(name, version, credentials=credentials(), cache_discovery=False)
