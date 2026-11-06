"""Where finished archives go: the local folder (always) and Google Drive (API or synced folder)."""

from __future__ import annotations

import glob
import os
import shutil
from pathlib import Path

ARCHIVE_PREFIX = "calendar-backup-"


def _prune_dir(folder: Path, keep: int) -> int:
    files = sorted(folder.glob(f"{ARCHIVE_PREFIX}*.zip"))
    removed = 0
    for f in files[: max(0, len(files) - keep)]:
        f.unlink()
        removed += 1
    return removed


def store_local(archive: Path, cfg: dict) -> dict:
    """The archive is already built inside local_dir; only retention is applied here."""
    removed = _prune_dir(archive.parent, int(cfg.get("keep_local", 120)))
    return {"id": "local", "ok": True, "path": str(archive), "pruned": removed}


def detect_drive_folder() -> str | None:
    """Google Drive for desktop on macOS: ~/Library/CloudStorage/GoogleDrive-<account>/My Drive."""
    roots = sorted(glob.glob(os.path.expanduser("~/Library/CloudStorage/GoogleDrive-*")))
    for root in roots:
        for name in ("My Drive", "Мой диск"):
            p = Path(root) / name
            if p.is_dir():
                return str(p)
    return None


def store_drive_folder(archive: Path, dcfg: dict) -> dict:
    base = dcfg.get("folder_path") or detect_drive_folder()
    if not base:
        raise RuntimeError("Папка Google Drive для компьютера не найдена; укажите drive.folder_path")
    target = Path(os.path.expanduser(base)) / dcfg.get("folder_name", "Calendar Backups")
    target.mkdir(parents=True, exist_ok=True)
    tmp = target / (archive.name + ".part")
    shutil.copy2(archive, tmp)
    os.replace(tmp, target / archive.name)
    removed = _prune_dir(target, int(dcfg.get("keep", 120)))
    return {"id": "drive", "ok": True, "mode": "folder", "path": str(target / archive.name), "pruned": removed}


def _drive_folder_id(svc, name: str) -> str:
    q = (
        "mimeType='application/vnd.google-apps.folder' and trashed=false and "
        f"name='{name.replace(chr(39), chr(92) + chr(39))}' and 'root' in parents"
    )
    found = svc.files().list(q=q, fields="files(id)", spaces="drive").execute(num_retries=3)
    if found.get("files"):
        return found["files"][0]["id"]
    meta = {"name": name, "mimeType": "application/vnd.google-apps.folder"}
    return svc.files().create(body=meta, fields="id").execute(num_retries=3)["id"]


def store_drive_api(archive: Path, dcfg: dict) -> dict:
    from googleapiclient.http import MediaFileUpload

    from .google_auth import service

    svc = service("drive", "v3")
    folder = _drive_folder_id(svc, dcfg.get("folder_name", "Calendar Backups"))
    media = MediaFileUpload(str(archive), mimetype="application/zip", resumable=True)
    created = (
        svc.files()
        .create(body={"name": archive.name, "parents": [folder]}, media_body=media, fields="id,size,webViewLink")
        .execute(num_retries=3)
    )
    if int(created.get("size", -1)) != archive.stat().st_size:
        raise RuntimeError("размер файла на Google Drive не совпадает с локальным")

    keep = int(dcfg.get("keep", 120))
    files, token = [], None
    while True:
        resp = (
            svc.files()
            .list(
                q=f"'{folder}' in parents and trashed=false and name contains '{ARCHIVE_PREFIX}'",
                fields="nextPageToken, files(id,name)",
                orderBy="name",
                pageSize=1000,
                pageToken=token,
            )
            .execute(num_retries=3)
        )
        files.extend(resp.get("files", []))
        token = resp.get("nextPageToken")
        if not token:
            break
    files.sort(key=lambda f: f["name"])
    removed = 0
    for f in files[: max(0, len(files) - keep)]:
        svc.files().delete(fileId=f["id"]).execute(num_retries=3)
        removed += 1
    return {
        "id": "drive",
        "ok": True,
        "mode": "api",
        "file_id": created["id"],
        "link": created.get("webViewLink"),
        "pruned": removed,
    }


def store_drive(archive: Path, cfg: dict) -> dict:
    dcfg = cfg.get("drive") or {}
    if dcfg.get("mode", "api") == "folder":
        return store_drive_folder(archive, dcfg)
    return store_drive_api(archive, dcfg)


def local_usage(folder: Path) -> dict:
    files = sorted(folder.glob(f"{ARCHIVE_PREFIX}*.zip")) if folder.exists() else []
    return {"count": len(files), "bytes": sum(f.stat().st_size for f in files)}
