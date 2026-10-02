"""Writing a .chiefbackup: what goes in, what never does, and how it is made safely.

Parts:
- `setup`: the Hermes root (every profile's SOUL, memory, skills, routines, chat history, kanban, config,
  installed plugins) and the app's own data folder.
- `second-brain`: the Second Brain folder, as it is.

Never included: the Hermes runtime, caches, logs, locks, the speech model, machine-specific launchers.
Secrets (`.env` values that look like keys, sign-in files, phone-alert keys, tokens) are included only when
the backup is encrypted; otherwise they are left out and their names recorded so a restore can ask for them.

A backup is zipped in a local temporary folder, verified (every entry's CRC and the manifest's SHA-256s), then
encrypted if asked, written to the destination under a temporary name, and renamed only when complete.
SQLite databases are copied with SQLite's online backup API, so Chief can keep running.
"""
from __future__ import annotations

import errno
import fnmatch
import getpass
import hashlib
import json
import os
import re
import shutil
import sqlite3
import tempfile
import time
import zipfile
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from collections.abc import Callable, Iterator

from . import crypto

FORMAT = "chief-backup"
FORMAT_VERSION = 1
SUFFIX = ".chiefbackup"
PARTS = ("setup", "second-brain")

# Anywhere in the Hermes root.
_SKIP_DIRS = {"cache", "image_cache", "audio_cache", "logs", "hf-cache", "runtime", "__pycache__", "node_modules", ".git",
              "pm-runtime", "uv-cache", "crash-dumps"}
_SKIP_FILES = ["*.lock", "*.pid", "*.db-wal", "*.db-shm", "*.db-journal", "*.tmp", "*.part", "gateway_state.json",
               "gateway.heartbeat", "*_cache.json", "models_dev_cache.*", "provider_models_cache.json", "install_id"]
# Only at the top of the Hermes root: launchers and install records belong to this PC's app install.
_SKIP_ROOT = {"bin", "installs"}
# Only directly in a profile: the speech model is re-downloadable and large.
_SKIP_PROFILE = {"models"}
# What belongs to this PC rather than to the setup: left out of backups, and carried across a same-PC restore.
MACHINE_LOCAL_ROOT = ("bin", "installs", "install_id")
MACHINE_LOCAL_PROFILE = ("models",)
# Secret files: kept only in an encrypted backup.
_SECRET_FILES = {"auth.json": "sign-ins (auth.json)", ".token": "the app's bridge token",
                 "command_center_vapid.json": "phone-alert keys", "command_center_push_subscriptions.json": "phone-alert subscriptions"}
_SECRET_PATTERNS = ["*.pem", "*.key", "*.p12", "*.pfx", "credentials.json"]
_SECRET_ENV = re.compile(r"(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|COOKIE|SESSION|AUTH|PRIVATE)", re.I)
_ENV_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=")


class BackupError(RuntimeError):
    pass


@dataclass
class Plan:
    """What a backup will contain: (archive path, source file, kind) plus the secrets left out."""
    entries: list[tuple[str, Path, str]] = field(default_factory=list)
    dropped: list[str] = field(default_factory=list)
    sanitized_env: dict[str, str] = field(default_factory=dict)  # archive path -> sanitized text


def _matches(name: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatch(name.lower(), p.lower()) for p in patterns)


def is_secret_env_name(name: str) -> bool:
    return bool(_SECRET_ENV.search(name))


def sanitize_env(text: str) -> tuple[str, list[str]]:
    """Drop lines whose variable name looks secret; keep paths, ports and other settings."""
    kept, dropped = [], []
    for line in text.splitlines(keepends=True):
        m = _ENV_LINE.match(line)
        if m and is_secret_env_name(m.group(1)):
            dropped.append(m.group(1))
            continue
        kept.append(line)
    return "".join(kept), dropped


def _walk(root: Path, *, skip: Callable[[PurePosixPath, bool], bool]) -> Iterator[tuple[PurePosixPath, Path]]:
    for current, dirs, files in os.walk(root):
        rel_dir = PurePosixPath(Path(current).relative_to(root).as_posix())
        rel_dir = PurePosixPath("") if str(rel_dir) == "." else rel_dir
        dirs[:] = sorted(d for d in dirs if not skip(rel_dir / d, True) and not os.path.islink(os.path.join(current, d)))
        for name in sorted(files):
            rel = rel_dir / name
            if not skip(rel, False):
                yield rel, Path(current) / name


def plan_setup(hermes_root: Path, app_dir: Path | None, *, secrets: bool, exclude: list[Path]) -> Plan:
    plan = Plan()
    excluded = [p.resolve() for p in exclude]

    def skip(rel: PurePosixPath, is_dir: bool) -> bool:
        parts = rel.parts
        name = parts[-1]
        full = (hermes_root / Path(*parts)).resolve()
        if any(full == e or e in full.parents for e in excluded):
            return True
        if is_dir:
            if name in _SKIP_DIRS:
                return True
            if len(parts) == 1 and name in _SKIP_ROOT:
                return True
            if len(parts) == 3 and parts[0] == "profiles" and name in _SKIP_PROFILE:
                return True
            return False
        return _matches(name, _SKIP_FILES)

    for rel, src in _walk(hermes_root, skip=skip):
        name = rel.name
        arc = f"hermes/{rel}"
        secret_label = _SECRET_FILES.get(name) or ("key files" if _matches(name, _SECRET_PATTERNS) else "")
        if secret_label and not secrets:
            if secret_label not in plan.dropped:
                plan.dropped.append(secret_label)
            continue
        if (name == ".env" or name.startswith(".env.")) and not secrets:
            text, names = sanitize_env(src.read_text(encoding="utf-8", errors="replace"))
            plan.sanitized_env[arc] = text
            plan.dropped.extend(n for n in names if n not in plan.dropped)
            plan.entries.append((arc, src, "env"))
            continue
        plan.entries.append((arc, src, "db" if name.endswith(".db") else "file"))
    if app_dir and app_dir.is_dir():
        for rel, src in _walk(app_dir, skip=lambda rel, is_dir: (is_dir and rel.name in _SKIP_DIRS) or _matches(rel.name, _SKIP_FILES)):
            plan.entries.append((f"app/{rel}", src, "file"))
    return plan


def plan_second_brain(vault: Path, *, exclude: list[Path]) -> Plan:
    plan = Plan()
    excluded = [p.resolve() for p in exclude]

    def skip(rel: PurePosixPath, is_dir: bool) -> bool:
        full = (vault / Path(*rel.parts)).resolve()
        return any(full == e or e in full.parents for e in excluded)

    for rel, src in _walk(vault, skip=skip):
        plan.entries.append((f"second-brain/{rel}", src, "file"))
    return plan


def _copy_sqlite(src: Path, dst: Path) -> None:
    """A consistent copy of a live database (SQLite's online backup API; WAL content included)."""
    source = sqlite3.connect(f"file:{src.as_posix()}?mode=ro", uri=True, timeout=30)
    try:
        target = sqlite3.connect(dst)
        try:
            source.backup(target, pages=4096, sleep=0.005)
        finally:
            target.close()
    finally:
        source.close()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _count_notes(plan: Plan) -> int:
    return sum(1 for arc, _, _ in plan.entries if arc.startswith("second-brain/") and arc.lower().endswith(".md"))


def _profiles(plan: Plan) -> list[str]:
    found = set()
    for arc, _, _ in plan.entries:
        parts = arc.split("/")
        if len(parts) >= 4 and parts[1] == "profiles":
            found.add(parts[2])
    return sorted(found)


def backup_name(kind: str = "manual", when: float | None = None) -> str:
    stamp = time.strftime("%Y-%m-%d %H%M%S", time.localtime(when or time.time()))
    label = {"auto": " (auto)", "safety": " (before restore)", "pre-update": " (before update)"}.get(kind, "")
    return f"Chief backup{label} {stamp}{SUFFIX}"


def create(
    dest_dir: Path,
    *,
    parts: list[str],
    hermes_root: Path | None = None,
    app_dir: Path | None = None,
    second_brain: Path | None = None,
    passphrase: str = "",
    app_version: str = "0.0.0",
    hermes_version: str = "",
    kind: str = "manual",
    tmp_dir: Path | None = None,
    progress: Callable[[int, int], None] | None = None,
    secrets_plain: bool = False,
) -> dict:
    """`secrets_plain` is only for the local safety backup a restore takes of the live data (which already
    holds those secrets in plain files next to it); every backup a person carries elsewhere follows the rule."""
    parts = [p for p in PARTS if p in parts]
    if not parts:
        raise BackupError("Choose what to back up.")
    if "setup" in parts and not (hermes_root and hermes_root.is_dir()):
        raise BackupError("Chief's data folder wasn't found.")
    if "second-brain" in parts and not (second_brain and second_brain.is_dir()):
        raise BackupError("The Second Brain folder wasn't found.")
    dest_dir.mkdir(parents=True, exist_ok=True)
    exclude = [dest_dir] + ([tmp_dir] if tmp_dir else [])
    plan = Plan()
    if "setup" in parts:
        assert hermes_root is not None  # checked above
        setup = plan_setup(hermes_root, app_dir, secrets=bool(passphrase) or secrets_plain, exclude=exclude)
        plan.entries += setup.entries
        plan.dropped += setup.dropped
        plan.sanitized_env.update(setup.sanitized_env)
    if "second-brain" in parts:
        assert second_brain is not None  # checked above
        plan.entries += plan_second_brain(second_brain, exclude=exclude).entries

    final = dest_dir / backup_name(kind)
    work = Path(tempfile.mkdtemp(prefix="chief-backup-", dir=tmp_dir))
    partial = dest_dir / f".{final.name}.partial"
    try:
        zip_path = work / "backup.zip"
        files: list[dict] = []
        total = sum((src.stat().st_size if src.exists() else 0) for _, src, _ in plan.entries)
        done = 0
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True, strict_timestamps=False) as zf:
            for arc, src, kind_ in plan.entries:
                try:
                    if kind_ == "env":
                        data = plan.sanitized_env[arc].encode("utf-8")
                        zf.writestr(arc, data)
                        files.append({"path": arc, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})
                        continue
                    source = src
                    if kind_ == "db":
                        source = work / "db.snapshot"
                        source.unlink(missing_ok=True)
                        _copy_sqlite(src, source)
                    zf.write(source, arc)
                    files.append({"path": arc, "size": source.stat().st_size, "sha256": _sha256(source)})
                except FileNotFoundError:
                    continue  # removed while we were walking
                except PermissionError:
                    raise BackupError(f"Couldn't read {arc.split('/', 1)[1]}. Close the app using it and try again.") from None
                except sqlite3.Error as exc:
                    raise BackupError(f"Couldn't copy the database {arc.split('/', 1)[1]} ({exc}).") from None
                done += src.stat().st_size if src.exists() else 0
                if progress:
                    progress(done, total)
            manifest = {
                "format": FORMAT,
                "format_version": FORMAT_VERSION,
                "created": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "kind": kind,
                "app_version": app_version,
                "hermes_version": hermes_version,
                "parts": parts,
                "encrypted": bool(passphrase),
                "secrets_included": bool(passphrase) or secrets_plain,
                "dropped_secrets": plan.dropped,
                "source": {
                    "hermes_root": str(hermes_root) if hermes_root else "",
                    "app_dir": str(app_dir) if app_dir else "",
                    "second_brain": str(second_brain) if second_brain else "",
                    "home": str(Path.home()),
                    "user": getpass.getuser(),
                },
                "summary": {"profiles": _profiles(plan), "notes": _count_notes(plan), "files": len(files),
                            "bytes": sum(f["size"] for f in files)},
                "files": files,
            }
            zf.writestr("manifest.json", json.dumps(manifest, indent=1))
        _verify_zip(zip_path)
        with open(partial, "wb") as out:
            if passphrase:
                crypto.encrypt_file(zip_path, out, passphrase)
            else:
                with open(zip_path, "rb") as src_handle:
                    shutil.copyfileobj(src_handle, out, 1 << 20)
            out.flush()
            os.fsync(out.fileno())
        os.replace(partial, final)
        return {"ok": True, "path": str(final), "bytes": final.stat().st_size, "parts": parts, "encrypted": bool(passphrase),
                "dropped_secrets": plan.dropped, "summary": manifest["summary"]}
    except OSError as exc:
        partial.unlink(missing_ok=True)
        if exc.errno == errno.ENOSPC or getattr(exc, "winerror", 0) in (39, 112):
            raise BackupError("There isn't enough free space for the backup. Free some space or choose another folder.") from None
        if isinstance(exc, PermissionError):
            raise BackupError("Chief can't write to that backup folder. Choose another one.") from None
        raise BackupError(f"The backup couldn't be written ({exc.strerror or type(exc).__name__}).") from None
    except BaseException:
        partial.unlink(missing_ok=True)
        raise
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _verify_zip(path: Path) -> None:
    with zipfile.ZipFile(path) as zf:
        bad = zf.testzip()
        if bad:
            raise BackupError(f"The backup failed its own check ({bad}).")
        manifest = json.loads(zf.read("manifest.json"))
        for entry in manifest["files"]:
            digest = hashlib.sha256()
            with zf.open(entry["path"]) as handle:
                for block in iter(lambda: handle.read(1 << 20), b""):
                    digest.update(block)
            if digest.hexdigest() != entry["sha256"]:
                raise BackupError(f"The backup failed its own check ({entry['path']}).")


def prune(dest_dir: Path, keep: int, kind: str = "auto") -> list[str]:
    """Keep the newest `keep` backups of this kind ("auto" or "pre-update"); manual ones are never removed."""
    label = backup_name(kind).rsplit(" ", 2)[0]  # "Chief backup (auto)", "Chief backup (before update)"
    autos = sorted(dest_dir.glob(f"{label} *{SUFFIX}"), key=lambda p: p.name, reverse=True)
    removed = []
    for old in autos[max(keep, 1):]:
        try:
            old.unlink()
            removed.append(old.name)
        except OSError:
            pass
    return removed
