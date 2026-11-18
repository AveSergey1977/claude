"""Hetzner Storage Box (or any SFTP server) as an extra copy outside Google.

Access is by an SSH key generated for this program; the server's host key is pinned in
a separate known_hosts file and unknown keys are rejected. Uploads go to <name>.part,
are checked by size and then renamed, so a half-written file never looks like a backup."""

from __future__ import annotations

import os
import posixpath
import socket
import subprocess
from contextlib import contextmanager
from pathlib import Path

from .archives import is_archive, sort_newest_first
from .config import app_home, load_config, save_config

DEFAULT_PORT = 23  # Hetzner Storage Box: SFTP/SSH with keys on port 23


def _scfg(cfg: dict) -> dict:
    s = dict(cfg.get("storage_box") or {})
    ssh_dir = app_home() / ".ssh"
    s.setdefault("port", DEFAULT_PORT)
    s["key_file"] = s.get("key_file") or str(ssh_dir / "storagebox_ed25519")
    s["known_hosts"] = s.get("known_hosts") or str(ssh_dir / "known_hosts_storagebox")
    # relative paths start in the Storage Box home directory
    s["path"] = (s.get("path") or "calendar-backups").rstrip("/") or "calendar-backups"
    return s


@contextmanager
def connect(s: dict):
    import paramiko

    if not s.get("host") or not s.get("username"):
        raise RuntimeError("Storage Box не настроен: выполните calbackup storagebox-init")
    kh = Path(s["known_hosts"])
    if not kh.exists():
        raise RuntimeError(f"нет {kh}: выполните calbackup storagebox-init")
    client = paramiko.SSHClient()
    client.load_host_keys(str(kh))
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    try:
        client.connect(
            s["host"], port=int(s["port"]), username=s["username"], key_filename=s["key_file"],
            look_for_keys=False, allow_agent=False, timeout=30, banner_timeout=30, auth_timeout=30,
        )
        sftp = client.open_sftp()
        yield sftp
    finally:
        client.close()


def _mkdirs(sftp, path: str) -> None:
    cur = "/" if path.startswith("/") else ""
    for part in [p for p in path.split("/") if p]:
        cur = posixpath.join(cur, part) if cur else part
        try:
            sftp.stat(cur)
        except IOError:
            sftp.mkdir(cur)


def store_storage_box(archive: Path, cfg: dict) -> dict:
    s = _scfg(cfg)
    folder = s["path"]
    final = posixpath.join(folder, archive.name)
    part = final + ".part"
    with connect(s) as sftp:
        _mkdirs(sftp, folder)
        sftp.put(str(archive), part, confirm=True)
        if sftp.stat(part).st_size != archive.stat().st_size:
            sftp.remove(part)
            raise RuntimeError("размер файла на Storage Box не совпадает с локальным")
        try:
            sftp.posix_rename(part, final)
        except IOError:
            try:
                sftp.remove(final)
            except IOError:
                pass
            sftp.rename(part, final)

        names = sftp.listdir(folder)
        for n in names:  # leftovers of interrupted uploads
            if n.endswith(".zip.part"):
                try:
                    sftp.remove(posixpath.join(folder, n))
                except IOError:
                    pass
        removed = 0
        for n in sort_newest_first(n for n in names if is_archive(n))[int(s.get("keep", 120)):]:
            sftp.remove(posixpath.join(folder, n))
            removed += 1
    return {"id": "storagebox", "ok": True, "path": f"{s['host']}:{final}", "pruned": removed}


# ---------- setup commands ----------

def _run(cmd: list[str]) -> str:
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"Ошибка: {' '.join(cmd)}\n{(r.stderr or r.stdout).strip()}")
    return r.stdout


def init(host: str, username: str, port: int = DEFAULT_PORT, path: str = "calendar-backups") -> None:
    """Create the program's SSH key, pin the Storage Box host key, store the settings."""
    cfg = load_config()
    sb = cfg.setdefault("storage_box", {})
    sb.update(host=host, username=username, port=port, path=path)
    sb.setdefault("enabled", False)
    sb.setdefault("keep", 120)
    s = _scfg(cfg)
    ssh_dir = Path(s["key_file"]).parent
    ssh_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(ssh_dir, 0o700)

    key = Path(s["key_file"])
    if not key.exists():
        _run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", f"calendar-backup@{socket.gethostname()}", "-f", str(key)])
    scan = _run(["ssh-keyscan", "-T", "15", "-p", str(port), "-t", "ed25519,rsa", host])
    if not scan.strip():
        raise SystemExit(f"Storage Box {host}:{port} не ответил. Проверьте адрес и что доступ по SSH включён.")
    kh = Path(s["known_hosts"])
    kh.write_text(scan, encoding="utf-8")
    os.chmod(kh, 0o600)
    save_config(cfg)

    print("Ключ хоста Storage Box (сверьте отпечаток с опубликованным Hetzner):")
    print(_run(["ssh-keygen", "-l", "-f", str(kh)]).strip())
    print("\nДалее — один раз, от root, с паролем Storage Box:")
    print(f"  ssh-copy-id -p {port} -s -i {key}.pub -o UserKnownHostsFile={kh} {username}@{host}")
    print("Затем проверка (при успехе загрузка включится):")
    print("  calbackup storagebox-test")


def test(enable: bool = True) -> int:
    cfg = load_config()
    s = _scfg(cfg)
    probe = posixpath.join(s["path"], ".calbackup-probe")
    try:
        with connect(s) as sftp:
            _mkdirs(sftp, s["path"])
            with sftp.open(probe, "w") as f:
                f.write(b"ok")
            sftp.remove(probe)
            count = sum(1 for n in sftp.listdir(s["path"]) if is_archive(n))
    except Exception as e:
        print(f"[!!] Storage Box недоступен: {type(e).__name__}: {e}")
        return 1
    print(f"[ok] Storage Box {s['host']}:{s['path']} — запись работает, копий там: {count}")
    if enable and not (cfg.get("storage_box") or {}).get("enabled"):
        cfg["storage_box"]["enabled"] = True
        save_config(cfg)
        print("Загрузка на Storage Box включена (со следующей копии)")
    return 0
