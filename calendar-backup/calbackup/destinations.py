"""Where finished archives go: the local folder (always) and Google Drive (API or synced folder).
Also lists and downloads archives on Drive for the sync of a mirror machine."""

from __future__ import annotations

import glob
import hashlib
import os
import shutil
from pathlib import Path

from .archives import ARCHIVE_PREFIX, is_archive, sort_newest_first

DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder"


def _prune_dir(folder: Path, keep: int) -> int:
    names = sort_newest_first(p.name for p in folder.glob(f"{ARCHIVE_PREFIX}*.zip"))
    removed = 0
    for name in names[max(0, keep):]:
        (folder / name).unlink()
        removed += 1
    return removed


def prune_local(folder: Path, keep: int) -> int:
    return _prune_dir(folder, keep) if folder.exists() else 0


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


def drive_folder_path(dcfg: dict) -> Path:
    base = dcfg.get("folder_path") or detect_drive_folder()
    if not base:
        raise RuntimeError("Папка Google Drive для компьютера не найдена; укажите drive.folder_path")
    return Path(os.path.expanduser(base)) / dcfg.get("folder_name", "Calendar Backups")


def store_drive_folder(archive: Path, dcfg: dict) -> dict:
    target = drive_folder_path(dcfg)
    target.mkdir(parents=True, exist_ok=True)
    tmp = target / (archive.name + ".part")
    shutil.copy2(archive, tmp)
    os.replace(tmp, target / archive.name)
    removed = _prune_dir(target, int(dcfg.get("keep", 120)))
    return {"id": "drive", "ok": True, "mode": "folder", "path": str(target / archive.name), "pruned": removed}


def _drive_folder_id(svc, name: str, create: bool = True) -> str | None:
    q = (
        f"mimeType='{DRIVE_FOLDER_MIME}' and trashed=false and "
        f"name='{name.replace(chr(39), chr(92) + chr(39))}' and 'root' in parents"
    )
    found = svc.files().list(q=q, fields="files(id)", spaces="drive").execute(num_retries=3)
    if found.get("files"):
        return found["files"][0]["id"]
    if not create:
        return None
    meta = {"name": name, "mimeType": DRIVE_FOLDER_MIME}
    return svc.files().create(body=meta, fields="id").execute(num_retries=3)["id"]


def list_drive_archives(svc, folder_id: str) -> list[dict]:
    files, token = [], None
    while True:
        resp = (
            svc.files()
            .list(
                q=f"'{folder_id}' in parents and trashed=false and name contains '{ARCHIVE_PREFIX}'",
                fields="nextPageToken, files(id,name,size,md5Checksum)",
                pageSize=1000,
                pageToken=token,
            )
            .execute(num_retries=3)
        )
        files.extend(f for f in resp.get("files", []) if is_archive(f["name"]))
        token = resp.get("nextPageToken")
        if not token:
            return files


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
    removed = 0
    for f in sort_newest_first(list_drive_archives(svc, folder))[keep:]:
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


class RemoteArchives:
    """Read access to the archives on Drive, in either mode."""

    def __init__(self, cfg: dict):
        self.dcfg = cfg.get("drive") or {}
        self.mode = self.dcfg.get("mode", "api")
        self._svc = None
        self._folder_id = None

    def list(self) -> list[dict]:
        if self.mode == "folder":
            folder = drive_folder_path(self.dcfg)
            if not folder.exists():
                return []
            return [{"name": p.name, "size": str(p.stat().st_size)} for p in folder.iterdir() if is_archive(p.name)]
        from .google_auth import service

        self._svc = service("drive", "v3")
        self._folder_id = _drive_folder_id(self._svc, self.dcfg.get("folder_name", "Calendar Backups"), create=False)
        if not self._folder_id:
            return []
        return list_drive_archives(self._svc, self._folder_id)

    def download(self, item: dict, dest: Path) -> None:
        """Download to dest and verify size and (API) MD5."""
        if self.mode == "folder":
            shutil.copyfile(drive_folder_path(self.dcfg) / item["name"], dest)
        else:
            from googleapiclient.http import MediaIoBaseDownload

            req = self._svc.files().get_media(fileId=item["id"])
            with open(dest, "wb") as fh:
                dl = MediaIoBaseDownload(fh, req, chunksize=8 * 1024 * 1024)
                done = False
                while not done:
                    _, done = dl.next_chunk(num_retries=3)
        if item.get("size") is not None and int(item["size"]) != dest.stat().st_size:
            raise RuntimeError(f"{item['name']}: размер не совпадает")
        if item.get("md5Checksum"):
            h = hashlib.md5()
            with open(dest, "rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    h.update(chunk)
            if h.hexdigest() != item["md5Checksum"]:
                raise RuntimeError(f"{item['name']}: контрольная сумма не совпадает")


def local_usage(folder: Path) -> dict:
    files = [p for p in folder.glob(f"{ARCHIVE_PREFIX}*.zip") if is_archive(p.name)] if folder.exists() else []
    return {"count": len(files), "bytes": sum(f.stat().st_size for f in files)}
