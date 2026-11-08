"""Second copy outside Google: encrypted restic repositories (Hetzner Storage Box over SFTP,
any S3-compatible bucket, an external disk...).

What goes in: the calendar archives folder, the Gmail copy and a small metadata folder
(config.json without secrets, a consistent snapshot of every Gmail index, restore notes).
restic encrypts on this Mac before upload, deduplicates and compresses; a snapshot can be
restored on any computer with the standard `restic` program and the repository password,
without this application.

Per target and run: `restic backup`; every `prune_days` `forget --prune` with the keep
policy; every `check_days` `check --read-data-subset`. Passwords and cloud keys live in the
macOS Keychain; restic receives them through its environment, never on the command line.
"""

from __future__ import annotations

import json
import logging
import os
import re
import secrets as pysecrets
import shutil
import socket
import sqlite3
import subprocess
import time
from datetime import datetime
from pathlib import Path

from .config import _atomic_write, app_home

log = logging.getLogger("calbackup")

RESTIC_VERSION = "0.19.1"   # what install-macos.sh downloads when Homebrew has none
TAG = "calbackup"
DEFAULTS = {
    "enabled": False,
    "interval_hours": 24,
    "restic_path": "",
    "keep": {"daily": 14, "weekly": 8, "monthly": 24, "yearly": 10},
    "prune_days": 7,
    "check_days": 7,
    "check_subset": "5%",
    "stale_days": 3,
    "targets": [],
}
DEFAULT_PASSWORD_KEY = "restic"

# restic exit codes (doc/075_scripting.rst, restic >= 0.17.1)
EXIT_OK, EXIT_PARTIAL, EXIT_NO_REPO, EXIT_LOCKED, EXIT_BAD_PASSWORD = 0, 3, 10, 11, 12


def settings(cfg: dict) -> dict:
    out = json.loads(json.dumps(DEFAULTS))
    for k, v in (cfg.get("offsite") or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k].update(v)
        else:
            out[k] = v
    return out


def mask(repository: str) -> str:
    """Hide credentials embedded in a repository URL (rest:https://user:pass@host/...)."""
    return re.sub(r"(//[^/:@]+):[^@/]+@", r"\1:***@", repository or "")


def ssh_key_path() -> Path:
    return app_home() / "offsite_ed25519"


def state_path() -> Path:
    return app_home() / "offsite_state.json"


def load_state() -> dict:
    try:
        return json.loads(state_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_state(st: dict) -> None:
    _atomic_write(state_path(), json.dumps(st, ensure_ascii=False, indent=2) + "\n")


# ------------------------------------------------------------------------ restic


MIN_VERSION = (0, 17, 1)   # exit codes 10 (no repository) and 12 (wrong password)
_version_ok: dict = {}


def _check_version(path: str) -> None:
    if path in _version_ok:
        return
    out = subprocess.run([path, "version"], capture_output=True, text=True, timeout=30).stdout
    m = re.search(r"restic (\d+)\.(\d+)\.(\d+)", out)
    if not m or tuple(map(int, m.groups())) < MIN_VERSION:
        raise RuntimeError(
            f"restic {m.group(0)[7:] if m else '?'} устарел, нужна версия 0.17.1 или новее: "
            "brew upgrade restic или запустите install-macos.sh заново"
        )
    _version_ok[path] = True


def find_restic(ocfg: dict, check: bool = True) -> str:
    cands = [ocfg.get("restic_path") or "", str(app_home() / "bin" / "restic"),
             "/opt/homebrew/bin/restic", "/usr/local/bin/restic", shutil.which("restic") or ""]
    for c in cands:
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            if check:
                _check_version(c)
            return c
    raise RuntimeError("программа restic не найдена: запустите install-macos.sh заново или brew install restic")


class Restic:
    """One repository. Secrets are passed through the environment only."""

    def __init__(self, ocfg: dict, target: dict, get_secret=None):
        if get_secret is None:
            from .secrets import get_secret
        self.bin = find_restic(ocfg)
        self.target = target
        repo = (target.get("repository") or "").strip()
        if not repo:
            raise RuntimeError("не указан repository")
        self.env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin:/usr/sbin:/sbin"),
            "HOME": os.environ.get("HOME", str(Path.home())),
            "RESTIC_REPOSITORY": repo,
            "RESTIC_CACHE_DIR": str(app_home() / "restic-cache"),
            "RESTIC_PROGRESS_FPS": "0.2",
            "LC_ALL": "C",
        }
        for name in ("TMPDIR", "USER", "LOGNAME", "SSH_AUTH_SOCK"):
            if os.environ.get(name):
                self.env[name] = os.environ[name]
        pw = _secret(get_secret, target.get("password_keyring") or DEFAULT_PASSWORD_KEY)
        if not pw:
            raise RuntimeError(
                f"нет пароля репозитория в Связке ключей ({target.get('password_keyring') or DEFAULT_PASSWORD_KEY}): "
                "выполните calbackup offsite-password"
            )
        self.env["RESTIC_PASSWORD"] = pw
        for var, key in (target.get("env_keyring") or {}).items():
            val = _secret(get_secret, key)
            if not val:
                raise RuntimeError(f"нет секрета «{key}» в Связке ключей: calbackup set-secret {key}")
            self.env[var] = val
        for var, val in (target.get("env") or {}).items():
            self.env[var] = str(val)
        self.opts: list = []
        key = target.get("ssh_key")
        if repo.startswith("sftp:") and key != "":
            key = os.path.expanduser(key or str(ssh_key_path()))
            kh = app_home() / "offsite_known_hosts"
            tokens = ["-i", key, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
                      "-o", "StrictHostKeyChecking=accept-new", "-o", f"UserKnownHostsFile={kh}",
                      "-o", "ServerAliveInterval=60", "-o", "ServerAliveCountMax=240"]
            # restic splits sftp.args like a shell, honouring quotes only around whole words
            args = " ".join(f'"{t}"' if (" " in t or "'" in t) else t for t in tokens)
            # restic reads each -o value as one CSV field, then splits sftp.args like a shell:
            # quote the field so the double quotes around paths with spaces survive
            self.opts = ["-o", '"' + f"sftp.args={args}".replace('"', '""') + '"']

    def run(self, args: list, timeout=None, on_line=None) -> tuple:
        """(exit code, stdout, stderr). With on_line, stdout lines are streamed to it."""
        cmd = [self.bin, *self.opts, *args]
        if on_line is None:
            r = subprocess.run(cmd, env=self.env, capture_output=True, text=True, timeout=timeout)
            return r.returncode, r.stdout, r.stderr
        # stderr goes to a file: a full stderr pipe would block restic while stdout is read
        import tempfile

        with tempfile.TemporaryFile("w+") as errf, subprocess.Popen(
                cmd, env=self.env, stdout=subprocess.PIPE, stderr=errf, text=True) as p:
            out = []
            assert p.stdout is not None
            for line in p.stdout:
                out.append(line)
                try:
                    on_line(line)
                except Exception:
                    pass
            code = p.wait()
            errf.seek(0)
            return code, "".join(out), errf.read()

    def ensure_repo(self) -> bool:
        """True when a new repository was created."""
        code, _, err = self.run(["cat", "config"], timeout=600)
        if code == EXIT_OK:
            return False
        if code == EXIT_NO_REPO:
            code, _, err = self.run(["init"], timeout=600)
            if code != EXIT_OK:
                raise RuntimeError("не удалось создать репозиторий: " + _err(err))
            return True
        if code == EXIT_BAD_PASSWORD:
            raise RuntimeError("неверный пароль репозитория (в Связке ключей другой пароль, чем при создании)")
        raise RuntimeError(_err(err) or f"restic завершился с кодом {code}")


def _secret(get_secret, name: str):
    try:
        return get_secret(name)
    except Exception:  # missing entry or Keychain unavailable
        return None


def _err(stderr: str) -> str:
    lines = [l.strip() for l in (stderr or "").splitlines() if l.strip()]
    for l in reversed(lines):  # restic --json prints a final {"message_type":"exit_error",...}
        if l.startswith("{"):
            try:
                j = json.loads(l)
                if j.get("message"):
                    return j["message"][:400]
            except ValueError:
                pass
    return " | ".join(lines[-3:])[:400]


# ------------------------------------------------------------------ what to copy


def _snapshot_index(src: Path, dst: Path) -> None:
    """Consistent copy of a live SQLite index (the Gmail sync may be writing)."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(".part")
    if tmp.exists():
        tmp.unlink()
    s = sqlite3.connect(src.resolve().as_uri() + "?mode=ro", uri=True, timeout=30)
    d = sqlite3.connect(str(tmp))
    try:
        s.backup(d)
    finally:
        d.close()
        s.close()
    os.replace(tmp, dst)


def prepare_sources(cfg: dict) -> tuple:
    """(paths, excludes, notes). Builds the metadata folder; skips folders on a
    disconnected disk."""
    from . import gmail
    from .config import local_dir
    from .folders import require_volume

    paths, notes = [], []
    meta = app_home() / "offsite-meta"
    shutil.rmtree(meta, ignore_errors=True)
    (meta / "gmail-index").mkdir(parents=True)

    cal = local_dir(cfg)
    gdir = gmail.base_dir(gmail.settings(cfg))
    for label, p in (("архивы календарей", cal), ("копия Gmail", gdir)):
        try:
            require_volume(p)
        except RuntimeError as e:
            notes.append(f"{label} пропущены: {e}")
            continue
        if p.is_dir():
            paths.append(str(p))

    for acc in gmail.accounts(gmail.settings(cfg)):
        try:
            _snapshot_index(acc / "index.sqlite", meta / "gmail-index" / acc.name / "index.snapshot.sqlite")
        except (sqlite3.Error, OSError) as e:
            notes.append(f"индекс Gmail {acc.name} не скопирован: {e}")
    if config_file_exists():
        shutil.copy2(app_home() / "config.json", meta / "config.json")
    (meta / "manifest.json").write_text(json.dumps({
        "app": "calendar-backup", "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "host": socket.gethostname(), "calendar_dir": str(cal), "gmail_dir": str(gdir),
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    (meta / "RESTORE.txt").write_text(RESTORE_NOTE.format(cal=cal, gdir=gdir), encoding="utf-8")
    paths.append(str(meta))
    excludes = [
        str(cal / "latest"), str(cal / ".staging-*"), "*.part", "*.tmp", ".calbackup-write-test-*",
        # the live Gmail index is copied consistently into offsite-meta/gmail-index instead
        "index.sqlite", "index.sqlite-wal", "index.sqlite-shm",
    ]
    return paths, excludes, notes


def config_file_exists() -> bool:
    return (app_home() / "config.json").exists()


RESTORE_NOTE = """Восстановление из этой копии (restic)

Архивы календарей: {cal}
Копия Gmail:       {gdir}

1. Установите restic (https://restic.net) на любом компьютере.
2. restic -r <адрес репозитория> snapshots          — список копий (нужен пароль репозитория)
3. restic -r <адрес> restore latest --target ~/Restore
4. Индекс Gmail лежит отдельно: offsite-meta/gmail-index/<адрес>/index.snapshot.sqlite —
   положите его в папку аккаунта Gmail рядом с messages/ под именем index.sqlite.
   Сами письма — обычные файлы .eml.
"""


# --------------------------------------------------------------------------- run


def _run_target(cfg: dict, ocfg: dict, t: dict, sources: tuple, state: dict, progress=None,
                get_secret=None, now=None) -> dict:
    tid = t.get("id") or "target"
    now = now or time.time()
    rec = {"id": tid, "repository": mask(t.get("repository", "")), "ok": False}
    st = state.setdefault(tid, {})
    t0 = time.time()
    try:
        repo = (t.get("repository") or "").strip()
        if repo.startswith("/"):
            from .folders import require_volume

            try:
                require_volume(Path(repo))
            except RuntimeError as e:
                rec.update(skipped=True, error=str(e))
                return rec
        r = Restic(ocfg, t, get_secret)
        if r.ensure_repo():
            rec["created"] = True
        paths, excludes, _ = sources
        args = ["backup", "--json", "--tag", TAG, "--host", socket.gethostname()]
        for ex in excludes:
            args += ["--exclude", ex]
        summary: dict = {}

        def on_line(line: str):
            try:
                j = json.loads(line)
            except ValueError:
                return
            if j.get("message_type") == "summary":
                summary.update(j)
            elif j.get("message_type") == "status" and progress:
                progress({"target": tid, "percent": round(100 * float(j.get("percent_done") or 0), 1),
                          "bytes_done": j.get("bytes_done"), "total_bytes": j.get("total_bytes")})

        code, _, err = r.run(args + paths, on_line=on_line)
        if code == EXIT_LOCKED:  # a lock left by an interrupted run: remove stale locks, retry once
            r.run(["unlock"], timeout=600)
            code, _, err = r.run(args + paths, on_line=on_line)
        if code not in (EXIT_OK, EXIT_PARTIAL) or not summary.get("snapshot_id"):
            raise RuntimeError(_err(err) or f"restic backup завершился с кодом {code}")
        rec.update(
            snapshot=summary.get("snapshot_id", "")[:8],
            files_new=summary.get("files_new"), files_changed=summary.get("files_changed"),
            files_total=summary.get("total_files_processed"), bytes_total=summary.get("total_bytes_processed"),
            added=summary.get("data_added"), added_packed=summary.get("data_added_packed"),
        )
        warnings = []
        if code == EXIT_PARTIAL:
            warnings.append("часть файлов не прочитана: " + _err(err))
        st["last_success_ts"] = now
        st["last_snapshot"] = rec["snapshot"]

        if t.get("prune", True) and now - float(st.get("last_prune_ts") or 0) >= float(ocfg["prune_days"]) * 86400:
            k = ocfg["keep"]
            fargs = ["forget", "--tag", TAG, "--group-by", "host,tags", "--prune",
                     "--keep-daily", str(k["daily"]), "--keep-weekly", str(k["weekly"]),
                     "--keep-monthly", str(k["monthly"]), "--keep-yearly", str(k["yearly"])]
            code, _, err = r.run(fargs)
            if code == EXIT_OK:
                st["last_prune_ts"] = now
                rec["pruned"] = True
            else:
                warnings.append("очистка старых копий не выполнена: " + _err(err))

        if now - float(st.get("last_check_ts") or 0) >= float(ocfg["check_days"]) * 86400:
            code, _, err = r.run(["check", "--read-data-subset", str(ocfg["check_subset"])])
            if code == EXIT_OK:
                st["last_check_ts"] = now
                st["last_check_ok"] = True
                rec["checked"] = True
            else:
                st["last_check_ok"] = False
                warnings.append("проверка репозитория обнаружила ошибки: " + _err(err))
            code, out, _ = r.run(["stats", "--json", "--mode", "raw-data"], timeout=1800)
            if code == EXIT_OK:
                try:
                    st["repo_size"] = json.loads(out.strip().splitlines()[-1]).get("total_size")
                except (ValueError, IndexError):
                    pass
        rec["warnings"] = warnings
        rec["ok"] = not warnings
        rec["done"] = True
    except Exception as e:
        log.exception("offsite target %s failed", tid)
        rec["error"] = str(e)[:400]
    finally:
        rec["duration_s"] = round(time.time() - t0, 1)
    return rec


def run_offsite(trigger: str = "manual", progress=None, get_secret=None) -> dict:
    from .config import append_history, load_config
    from .engine import RunLock, notify

    cfg = load_config()
    ocfg = settings(cfg)
    with RunLock("offsite.lock", "вторая копия уже создаётся"):
        started = time.time()
        entry = {"started_at": datetime.fromtimestamp(started).astimezone().isoformat(timespec="seconds"),
                 "started_ts": started, "trigger": trigger, "targets": []}
        problems: list = []
        try:
            targets = [t for t in ocfg["targets"] if t.get("enabled", True)]
            if not targets:
                raise RuntimeError("не настроено ни одного хранилища (config.json → offsite.targets)")
            sources = prepare_sources(cfg)
            entry["paths"] = sources[0]
            problems += sources[2]
            state = load_state()
            for t in targets:
                rec = _run_target(cfg, ocfg, t, sources, state, progress, get_secret, started)
                entry["targets"].append(rec)
                if rec.get("skipped"):
                    pass
                elif rec.get("error"):
                    problems.append(f"{rec['id']}: {rec['error']}")
                else:
                    problems += [f"{rec['id']}: {w}" for w in rec.get("warnings", [])]
            save_state(state)
            stale_s = float(ocfg["stale_days"]) * 86400
            for t in targets:
                last = float(state.get(t.get("id") or "target", {}).get("last_success_ts") or 0)
                if started - last > stale_s:
                    rec = next(r for r in entry["targets"] if r["id"] == (t.get("id") or "target"))
                    since = f"с {datetime.fromtimestamp(last):%d.%m.%Y}" if last else "ни разу"
                    why = f" ({rec['error']})" if rec.get("skipped") else ""
                    problems.append(f"{rec['id']}: успешной копии нет {since}{why}")
            done = [r for r in entry["targets"] if r.get("done")]
            entry["status"] = "error" if not done else ("partial" if problems else "ok")
        except Exception as e:
            log.exception("offsite run failed")
            problems.append(str(e)[:400])
            entry["status"] = "error"
        entry["ok"] = entry["status"] == "ok"
        entry["message"] = "; ".join(problems) if problems else "Успешно"
        entry["finished_ts"] = time.time()
        entry["duration_s"] = round(entry["finished_ts"] - started, 1)
        append_history(entry, "offsite_history")
        log.info("offsite %s: %s", entry["status"], entry["message"])
        if entry["status"] != "ok" and cfg.get("notify_on_error", True):
            notify("Вторая копия", entry["message"][:200])
        return entry


def history_entries() -> list:
    from .config import load_history

    return load_history("offsite_history")


def next_run_ts(cfg: dict):
    ocfg = settings(cfg)
    if not ocfg.get("enabled"):
        return None
    hist = history_entries()
    if not hist:
        return time.time()
    last = hist[0]
    interval = float(ocfg.get("interval_hours", 24)) * 3600
    if last.get("status") != "ok":
        interval = min(interval, 3600)
    return float(last.get("started_ts") or 0) + interval


def status(cfg: dict) -> dict:
    ocfg = settings(cfg)
    state = load_state()
    try:
        restic = find_restic(ocfg, check=False)
    except RuntimeError:
        restic = None
    return {
        "enabled": bool(ocfg.get("enabled")),
        "interval_hours": ocfg.get("interval_hours"),
        "restic": restic,
        "targets": [
            {"id": t.get("id"), "enabled": t.get("enabled", True), "repository": mask(t.get("repository", "")),
             **{k: state.get(t.get("id"), {}).get(k) for k in
                ("last_success_ts", "last_snapshot", "last_check_ts", "last_check_ok", "repo_size")}}
            for t in ocfg["targets"]
        ],
    }


# ------------------------------------------------------------------- setup helpers


def target_by_id(cfg: dict, tid: str | None) -> dict:
    targets = settings(cfg)["targets"]
    if not targets:
        raise SystemExit("Хранилища не настроены: добавьте offsite.targets в config.json (см. README)")
    if tid is None:
        if len(targets) > 1:
            raise SystemExit("Укажите --target: " + ", ".join(t.get("id", "?") for t in targets))
        return targets[0]
    for t in targets:
        if t.get("id") == tid:
            return t
    raise SystemExit(f"Хранилище не найдено: {tid}")


def new_password() -> str:
    return pysecrets.token_urlsafe(24)


def make_ssh_key() -> tuple:
    """(path, public key). Creates an ed25519 key without passphrase if none exists."""
    p = ssh_key_path()
    if not p.exists():
        p.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", f"calbackup@{socket.gethostname()}",
                        "-f", str(p)], check=True)
        os.chmod(p, 0o600)
    return p, Path(str(p) + ".pub").read_text(encoding="utf-8").strip()
