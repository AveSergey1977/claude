"""Where backups are kept: validation of a user-chosen folder and moving existing copies.

Both the calendar archives (`local_dir`) and the Gmail copy (`gmail.local_dir`) can be put
anywhere the panel user chooses; an empty value means the standard folder."""

from __future__ import annotations

import errno
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from .config import app_home

ARCHIVE_GLOB = "calendar-backup-*.zip"


def expand(value: str) -> Path:
    return Path(os.path.expanduser((value or "").strip()))


def same_folder(a: str, b: str) -> bool:
    return os.path.normpath(str(expand(a))) == os.path.normpath(str(expand(b)))


def require_volume(p: Path) -> None:
    """A folder on an external disk (/Volumes/<disk>/...) is used only while that disk is
    connected; otherwise mkdir would silently create the path on the system disk."""
    parts = Path(os.path.normpath(str(p))).parts
    if len(parts) >= 3 and parts[1] == "Volumes":
        vol = Path("/", "Volumes", parts[2])
        if not (os.path.ismount(vol) or (vol.is_symlink() and vol.resolve() == Path("/"))):
            raise RuntimeError(f"диск «{parts[2]}» не подключён ({p})")


def validate(value: str, what: str) -> Path:
    """Checks a folder typed or chosen in the panel and creates it. Returns the full path."""
    raw = (value or "").strip()
    p = expand(raw)
    if not p.is_absolute():
        raise ValueError(f"{what}: укажите полный путь, например ~/Backups или /Volumes/Диск/Backups")
    p = Path(os.path.normpath(str(p)))
    if p == Path("/") or p == Path.home():
        raise ValueError(f"{what}: выберите отдельную папку, а не {p}")
    home = Path(os.path.normpath(str(app_home())))
    if p == home or home in p.parents:
        raise ValueError(f"{what}: эта папка служебная ({home})")
    try:
        require_volume(p)
    except RuntimeError as e:
        raise ValueError(f"{what}: {e}") from None
    try:
        p.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(p), prefix=".calbackup-write-test-")
        os.close(fd)
        os.unlink(tmp)
    except PermissionError:
        raise ValueError(
            f"{what}: нет доступа к {p}. Если папка в «Документах», на «Рабочем столе», в iCloud Drive "
            "или на внешнем диске, разрешите доступ программе python: Системные настройки → "
            "Конфиденциальность и безопасность → Файлы и папки (или Полный доступ к диску)"
        ) from None
    except OSError as e:
        raise ValueError(f"{what}: не удалось использовать {p}: {e.strerror or e}") from None
    return p


def move_calendar_archives(old: Path, new: Path) -> str:
    """Moves calendar-backup-*.zip and the unpacked latest copy. Archives are small, so a
    move to another disk is a copy followed by deletion."""
    if not old.is_dir():
        return ""
    moved = kept = 0
    for f in sorted(old.glob(ARCHIVE_GLOB)):
        if (new / f.name).exists():
            kept += 1
            continue
        shutil.move(str(f), str(new / f.name))
        moved += 1
    latest = old / "latest"
    if latest.is_dir() and not (new / "latest").exists():
        shutil.move(str(latest), str(new / "latest"))
    if not moved and not kept:
        return ""
    msg = f"Архивы календарей перенесены в {new}: {moved}"
    if kept:
        msg += f"; {kept} с теми же именами уже были в новой папке и остались в {old}"
    return msg


def move_gmail(old: Path, new: Path) -> str:
    """Moves each account folder of the Gmail copy. Only within one disk (an instant rename):
    copying gigabytes inside a panel request is not done. Across disks the old copy stays
    and the new folder is filled by the next syncs."""
    if not old.is_dir():
        return ""
    notes = []
    for acc in sorted(p for p in old.iterdir() if (p / "index.sqlite").exists()):
        dest = new / acc.name
        if dest.exists():
            notes.append(f"Gmail {acc.name}: в новой папке уже есть копия, используется она; прежняя осталась в {acc}")
            continue
        try:
            os.rename(acc, dest)
            notes.append(f"Копия Gmail {acc.name} перенесена в {dest}")
        except OSError as e:
            if e.errno != errno.EXDEV:
                raise
            notes.append(
                f"Gmail {acc.name}: новая папка на другом диске, автоматически копия не переносится. "
                f"Прежняя копия осталась в {acc}; в новой папке письма будут загружены заново. "
                "Чтобы не загружать повторно, выключите копирование Gmail, скопируйте папку в Finder "
                "и включите снова"
            )
    return "; ".join(notes)


def choose_folder_dialog(prompt: str, start: str | None) -> str | None:
    """macOS folder picker. Returns a POSIX path, or None when cancelled."""
    if sys.platform != "darwin":
        raise RuntimeError("выбор папки в окне доступен только на Mac; введите путь вручную")
    script = f"POSIX path of (choose folder with prompt {_aq(prompt)}"
    if start and Path(start).is_dir():
        script += f" default location (POSIX file {_aq(start)})"
    script += ")"
    r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        if "-128" in r.stderr:  # user cancelled
            return None
        raise RuntimeError(r.stderr.strip() or "окно выбора папки не открылось")
    path = r.stdout.strip()
    return path.rstrip("/") or "/"


def _aq(s: str) -> str:
    """AppleScript string literal."""
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'
