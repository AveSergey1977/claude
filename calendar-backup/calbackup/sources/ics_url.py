"""Calendars published as an .ics link: Google "Secret address in iCal format",
Outlook/Office 365 "Publish calendar", Yandex, subscriptions (webcal://)."""

from __future__ import annotations

import ssl
import urllib.request
from pathlib import Path

from . import write_ics
from ..secrets import get_secret


def _ssl_context():
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


def download(url: str, timeout: int = 60) -> bytes:
    if url.startswith("webcal://"):
        url = "https://" + url[len("webcal://"):]
    req = urllib.request.Request(url, headers={"User-Agent": "calendar-backup/1.0"})
    with urllib.request.urlopen(req, timeout=timeout, context=_ssl_context()) as r:
        data = r.read()
    if b"BEGIN:VCALENDAR" not in data[:2048]:
        raise RuntimeError("ответ не является файлом iCalendar")
    return data


def fetch(cfg: dict, out_dir: Path) -> dict:
    # "urls": {"Name": "https://..."} or {"Name": {"keyring": "secret-name"}}
    # (secret addresses contain a private token; keeping them in Keychain is preferable)
    taken: set = set()
    result, errors = [], []
    urls = cfg.get("urls") or {}
    for name, spec in urls.items():
        try:
            url = get_secret(spec["keyring"]) if isinstance(spec, dict) else spec
            result.append(write_ics(out_dir, name, download(url), taken))
        except Exception as e:
            errors.append(f"{name}: {e}")
    if urls and not result:
        raise RuntimeError("; ".join(errors))
    return {"calendars": result, "errors": errors}
