"""OAuth for Google Calendar (read-only), Google Drive (files created by this app only)
and Gmail (read-only, for the mailbox copy)."""

from __future__ import annotations

from .config import _atomic_write, app_home

CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly"
DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file"
GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
SCOPES = [CALENDAR_SCOPE, DRIVE_SCOPE, GMAIL_SCOPE]


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
    granted = set(getattr(creds, "granted_scopes", None) or creds.scopes or [])
    missing = [s for s in SCOPES if granted and s not in granted]
    print(f"Готово. Токен сохранён: {token_path()}")
    if missing:
        print("Не выданы разрешения: " + ", ".join(missing) + ". Соответствующие копии работать не будут.")


def _save(creds) -> None:
    _atomic_write(token_path(), creds.to_json())


def credentials(required: list | None = None):
    """Credentials with the scopes recorded in the token file.

    The scopes are not overridden on load: a token issued before Gmail support (calendar +
    drive only) keeps refreshing with its own scopes, so calendar backups continue, and only
    a part that needs a missing scope (`required`) asks for re-authorisation."""
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials

    p = token_path()
    if not p.exists():
        raise RuntimeError("Google не авторизован. Выполните: calbackup auth-google")
    creds = Credentials.from_authorized_user_file(str(p))
    if required and not creds.has_scopes(required):
        raise RuntimeError(
            "Токен Google выдан без доступа к Gmail. Выполните: calbackup auth-google "
            "(календари продолжают копироваться и без этого)"
        )
    if not creds.valid:
        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
            _save(creds)
        else:
            raise RuntimeError("Токен Google недействителен. Выполните: calbackup auth-google")
    return creds


def service(name: str, version: str, required: list | None = None):
    from googleapiclient.discovery import build

    return build(name, version, credentials=credentials(required), cache_discovery=False)
