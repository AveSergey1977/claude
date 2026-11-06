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


def authorize() -> None:
    """Interactive consent in the browser; run once from Terminal."""
    from google_auth_oauthlib.flow import InstalledAppFlow

    cs = client_secret_path()
    if not cs.exists():
        raise SystemExit(
            f"Нет файла {cs}.\nСкачайте OAuth client (тип Desktop app) из Google Cloud Console "
            "и сохраните его по этому пути (см. README)."
        )
    flow = InstalledAppFlow.from_client_secrets_file(str(cs), SCOPES)
    creds = flow.run_local_server(port=0, prompt="consent", access_type="offline")
    _save(creds)
    print(f"Готово. Токен сохранён: {token_path()}")


def _save(creds) -> None:
    import os

    p = token_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(creds.to_json(), encoding="utf-8")
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
