"""Restoring a .chiefbackup, in steps that can each be checked and undone.

1. `inspect`: what a backup holds and whether this app can restore it (a backup from a newer app can't).
2. `stage`: extract the chosen parts next to their targets (same drive, so the swap is a rename), refusing any
   path that would escape, and verify every file's SHA-256 against the manifest. Nothing live is touched.
3. `apply` (Chief stopped): a safety backup of what will be replaced, then a journaled swap. Each target is
   renamed to `<name>.before-restore-<time>` and the staged folder takes its place. A failure part-way rolls
   back; a crash part-way is rolled back by `recover` at the next start. Known paths are remapped
   (OBSIDIAN_VAULT_PATH, WIKI_PATH, the Second Brain record and skill), secrets a backup left out are carried
   over from the current setup when they exist, and any other old absolute paths are listed for review.
4. `finish` (after Chief starts healthy) removes the old folders; `rollback` puts them back.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
import time
import zipfile
from pathlib import Path, PurePosixPath
from collections.abc import Callable

from . import archive, crypto

JOURNAL = "restore-journal.json"
_TEXT_REVIEW = ("config.yaml", "jobs.json", "cron.json")


class RestoreError(RuntimeError):
    pass


def _version_tuple(value: str) -> tuple[int, ...]:
    return tuple(int(x) for x in re.findall(r"\d+", str(value or "0"))[:4]) or (0,)


def _open_zip(path: Path, passphrase: str, work: Path) -> Path:
    if not path.is_file():
        raise RestoreError("That backup file wasn't found.")
    if crypto.is_encrypted(path):
        target = work / "backup.zip"
        with open(target, "wb") as out:
            crypto.decrypt_file(path, out, passphrase)
        return target
    return path


def _read_manifest(zip_path: Path) -> dict:
    try:
        with zipfile.ZipFile(zip_path) as zf:
            manifest = json.loads(zf.read("manifest.json"))
    except (zipfile.BadZipFile, KeyError, ValueError, OSError) as exc:
        raise RestoreError("This file isn't a Chief backup, or it is damaged.") from exc
    if manifest.get("format") != archive.FORMAT:
        raise RestoreError("This file isn't a Chief backup.")
    return manifest


def _compatibility(manifest: dict, app_version: str) -> str:
    if int(manifest.get("format_version", 0)) > archive.FORMAT_VERSION or _version_tuple(manifest.get("app_version", "0")) > _version_tuple(app_version):
        return "newer"
    return "ok"


def inspect(path: Path, passphrase: str = "", *, app_version: str = "0.0.0") -> dict:
    if not path.is_file():
        raise RestoreError("That backup file wasn't found.")
    if crypto.is_encrypted(path) and not passphrase:
        return {"ok": True, "encrypted": True, "needs_passphrase": True}
    work = Path(tempfile.mkdtemp(prefix="chief-restore-"))
    try:
        manifest = _read_manifest(_open_zip(path, passphrase, work))
    finally:
        shutil.rmtree(work, ignore_errors=True)
    compat = _compatibility(manifest, app_version)
    return {
        "ok": True,
        "encrypted": bool(manifest.get("encrypted")),
        "needs_passphrase": False,
        "compatible": compat == "ok",
        "problem": "" if compat == "ok" else f"This backup was made by a newer version of the app ({manifest.get('app_version')}). Update the app first.",
        "created": manifest.get("created"),
        "kind": manifest.get("kind"),
        "app_version": manifest.get("app_version"),
        "hermes_version": manifest.get("hermes_version"),
        "parts": manifest.get("parts", []),
        "secrets_included": bool(manifest.get("secrets_included")),
        "dropped_secrets": manifest.get("dropped_secrets", []),
        "summary": manifest.get("summary", {}),
        "source": {"second_brain": manifest.get("source", {}).get("second_brain", "")},
    }


# ---------------------------------------------------------------- stage


def _staging_for(target: Path) -> Path:
    return target.parent / f".{target.name}.chief-restore"


def _safe_rel(arc: str, prefix: str) -> PurePosixPath | None:
    if not arc.startswith(prefix + "/"):
        return None
    rel = PurePosixPath(arc[len(prefix) + 1 :])
    if not rel.parts or rel.is_absolute() or any(p in ("..", "") or ":" in p for p in rel.parts):
        raise RestoreError("The backup contains an unsafe path and was not restored.")
    return rel


def stage(
    path: Path,
    passphrase: str,
    *,
    parts: list[str],
    hermes_root: Path | None,
    app_dir: Path | None,
    second_brain: Path | None,
    current_second_brain: Path | None,
    state_dir: Path,
    app_version: str = "0.0.0",
) -> dict:
    work = Path(tempfile.mkdtemp(prefix="chief-restore-"))
    staged: dict[str, str] = {}
    try:
        zip_path = _open_zip(path, passphrase, work)
        manifest = _read_manifest(zip_path)
        if _compatibility(manifest, app_version) != "ok":
            raise RestoreError(f"This backup was made by a newer version of the app ({manifest.get('app_version')}). Update the app first.")
        parts = [p for p in archive.PARTS if p in parts and p in manifest.get("parts", [])]
        if not parts:
            raise RestoreError("Choose at least one part of the backup to restore.")
        targets: dict[str, Path] = {}
        if "setup" in parts:
            if not hermes_root:
                raise RestoreError("Chief's data folder isn't known.")
            targets["hermes"] = hermes_root
            if app_dir:
                targets["app"] = app_dir
        if "second-brain" in parts:
            if not second_brain:
                raise RestoreError("Choose where the Second Brain should go.")
            same = current_second_brain and os.path.normcase(os.path.abspath(second_brain)) == os.path.normcase(os.path.abspath(current_second_brain))
            if second_brain.exists() and any(second_brain.iterdir()) and not same:
                raise RestoreError("That folder already has files. Choose an empty or new folder, or your current Second Brain (it is backed up first).")
            targets["second-brain"] = second_brain
        expected = {f["path"]: f for f in manifest.get("files", [])}
        with zipfile.ZipFile(zip_path) as zf:
            for key, target in targets.items():
                staging = _staging_for(target)
                if staging.exists():
                    shutil.rmtree(staging)
                staging.mkdir(parents=True)
                staged[key] = str(staging)
                prefix = {"hermes": "hermes", "app": "app", "second-brain": "second-brain"}[key]
                wanted = [arc for arc in expected if arc.startswith(prefix + "/")]
                for arc in wanted:
                    rel = _safe_rel(arc, prefix)
                    if rel is None:
                        continue
                    dest = staging / Path(*rel.parts)
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    digest = hashlib.sha256()
                    try:
                        with zf.open(arc) as src, open(dest, "wb") as out:
                            for block in iter(lambda: src.read(1 << 20), b""):
                                digest.update(block)
                                out.write(block)
                    except KeyError:
                        raise RestoreError(f"The backup is missing {arc}; it wasn't restored.") from None
                    except RestoreError:
                        raise
                    except Exception as exc:  # BadZipFile, zlib.error, CRC errors, OSError
                        if isinstance(exc, OSError) and (exc.errno == 28 or getattr(exc, "winerror", 0) in (39, 112)):
                            raise RestoreError("There isn't enough free space to restore this backup.") from None
                        raise RestoreError("The backup is damaged; nothing was changed.") from None
                    if digest.hexdigest() != expected[arc]["sha256"]:
                        raise RestoreError(f"{arc} didn't match its checksum; nothing was changed.")
        state_dir.mkdir(parents=True, exist_ok=True)
        journal = {
            "state": "staged",
            "staged_at": time.time(),
            "parts": parts,
            "live_root": str(hermes_root) if hermes_root else "",
            "manifest": {k: v for k, v in manifest.items() if k != "files"},
            "targets": {k: str(v) for k, v in targets.items()},
            "staged": staged,
            "current_second_brain": str(current_second_brain) if current_second_brain else "",
            "steps": [],
        }
        _write_journal(state_dir, journal)
        return {"ok": True, "parts": parts, "targets": journal["targets"], "files": len(expected)}
    except BaseException:
        for folder in staged.values():
            shutil.rmtree(folder, ignore_errors=True)
        raise
    finally:
        shutil.rmtree(work, ignore_errors=True)


def discard_staging(state_dir: Path) -> None:
    journal = _read_journal(state_dir)
    if journal and journal.get("state") == "staged":
        for folder in journal.get("staged", {}).values():
            shutil.rmtree(folder, ignore_errors=True)
        (state_dir / JOURNAL).unlink(missing_ok=True)


# ---------------------------------------------------------------- apply


def _write_journal(state_dir: Path, journal: dict) -> None:
    tmp = state_dir / (JOURNAL + ".tmp")
    tmp.write_text(json.dumps(journal, indent=1), encoding="utf-8")
    os.replace(tmp, state_dir / JOURNAL)


def _read_journal(state_dir: Path) -> dict | None:
    try:
        return json.loads((state_dir / JOURNAL).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _same(a: str, b: str) -> bool:
    return bool(a and b) and os.path.normcase(os.path.normpath(a)) == os.path.normcase(os.path.normpath(b))


def _under(value: str, root: str) -> bool:
    if not value or not root:
        return False
    v, r = os.path.normcase(os.path.normpath(value)), os.path.normcase(os.path.normpath(root))
    return v == r or v.startswith(r.rstrip("\\/") + os.sep)


def _swap_prefix(value: str, old: str, new: str) -> str:
    v = os.path.normpath(value)
    return new + v[len(os.path.normpath(old)) :]


_ENV_VALUE = re.compile(r"^(\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*)(.*?)\s*$")


def _env_read(text: str) -> dict[str, str]:
    values = {}
    for line in text.splitlines():
        m = _ENV_VALUE.match(line)
        if m:
            raw = m.group(3)
            if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
                raw = raw[1:-1].replace("\\\\", "\\") if raw[0] == '"' else raw[1:-1]
            values[m.group(2)] = raw
    return values


def _env_quote(value: str) -> str:
    if re.search(r"[\s#\"'\\]", value):
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return value


def _env_set(text: str, name: str, value: str) -> str:
    lines = text.splitlines(keepends=True)
    for i, line in enumerate(lines):
        m = _ENV_VALUE.match(line)
        if m and m.group(2) == name:
            lines[i] = f"{name}={_env_quote(value)}\n"
            return "".join(lines)
    if lines and not lines[-1].endswith("\n"):
        lines[-1] += "\n"
    lines.append(f"{name}={_env_quote(value)}\n")
    return "".join(lines)


def _gateway_running(hermes_root: Path, is_alive: Callable[[int], bool]) -> bool:
    for pid_file in list(hermes_root.glob("gateway.pid")) + list(hermes_root.glob("profiles/*/gateway.pid")):
        try:
            text = pid_file.read_text(encoding="utf-8").strip()
            pid = int(json.loads(text).get("pid") if text.startswith("{") else text)
        except (OSError, ValueError, TypeError, AttributeError):
            continue
        if is_alive(pid):
            return True
    return False


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes

        handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        code = ctypes.c_ulong()
        ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
        ctypes.windll.kernel32.CloseHandle(handle)
        return code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def apply(
    state_dir: Path,
    *,
    safety_dir: Path,
    app_version: str = "0.0.0",
    is_alive: Callable[[int], bool] = pid_alive,
    hooks: dict[str, Callable[[], None]] | None = None,
) -> dict:
    journal = _read_journal(state_dir)
    if not journal or journal.get("state") != "staged":
        raise RestoreError("There is no staged restore to apply.")
    targets = {k: Path(v) for k, v in journal["targets"].items()}
    manifest = journal["manifest"]
    hermes_root = targets.get("hermes")
    live_root = Path(journal["live_root"]) if journal.get("live_root") else None
    if live_root and live_root.exists() and _gateway_running(live_root, is_alive):
        raise RestoreError("Chief is still running. Stop it before restoring.")

    # 1. Safety backup of everything that will be replaced (kept locally, secrets included, unencrypted, like the live data).
    safety_parts = []
    if hermes_root and hermes_root.is_dir():
        safety_parts.append("setup")
    brain_target = targets.get("second-brain")
    replacing_brain = bool(brain_target and brain_target.exists() and any(brain_target.iterdir()))
    if replacing_brain:
        safety_parts.append("second-brain")
    safety = None
    if safety_parts:
        safety = archive.create(
            safety_dir,
            parts=safety_parts,
            hermes_root=hermes_root,
            app_dir=targets.get("app"),
            second_brain=brain_target if replacing_brain else None,
            kind="safety",
            app_version=app_version,
            secrets_plain=True,
        )
    journal["safety_backup"] = safety["path"] if safety else ""

    # 2. The swap, journaled step by step.
    stamp = time.strftime("%Y%m%d-%H%M%S")
    journal["state"] = "swapping"
    journal["steps"] = []
    _write_journal(state_dir, journal)
    try:
        for key, target in targets.items():
            staged = Path(journal["staged"][key])
            previous = target.parent / f"{target.name}.before-restore-{stamp}"
            step = {"key": key, "target": str(target), "previous": str(previous), "moved_old": False, "moved_new": False}
            journal["steps"].append(step)
            if target.exists():
                os.replace(target, previous)
                step["moved_old"] = True
                _write_journal(state_dir, journal)
            if hooks and hooks.get(f"after_old:{key}"):
                hooks[f"after_old:{key}"]()
            target.parent.mkdir(parents=True, exist_ok=True)
            os.replace(staged, target)
            step["moved_new"] = True
            _write_journal(state_dir, journal)
    except BaseException:
        _roll_back_steps(journal)
        journal["state"] = "rolled-back"
        _write_journal(state_dir, journal)
        raise

    # 3. Carry this PC's own pieces across, remap known paths, carry secrets over, list the rest for review.
    _carry_machine_local(journal)
    _write_journal(state_dir, journal)
    report = _remap(journal, manifest)
    journal["state"] = "applied"
    journal["report"] = report
    _write_journal(state_dir, journal)
    return {"ok": True, "parts": journal["parts"], "safety_backup": journal["safety_backup"], **report}


def _carry_machine_local(journal: dict) -> None:
    """Launchers, install records and the speech model aren't in a backup; on the same PC they move into the
    restored Hermes root (and back on rollback)."""
    for step in journal.get("steps", []):
        if step["key"] != "hermes" or not step.get("moved_old"):
            continue
        old, new = Path(step["previous"]), Path(step["target"])
        pairs = [(old / name, new / name) for name in archive.MACHINE_LOCAL_ROOT]
        for profile in (old / "profiles").glob("*") if (old / "profiles").is_dir() else []:
            if (new / "profiles" / profile.name).is_dir():
                pairs += [(profile / name, new / "profiles" / profile.name / name) for name in archive.MACHINE_LOCAL_PROFILE]
        carried = step.setdefault("carried", [])
        for src, dst in pairs:
            if src.exists() and not dst.exists():
                os.replace(src, dst)
                carried.append([str(src), str(dst)])


def _roll_back_steps(journal: dict) -> None:
    for step in reversed(journal.get("steps", [])):
        for src, dst in reversed(step.get("carried", [])):
            if Path(dst).exists() and not Path(src).exists():
                os.replace(dst, src)
        target, previous = Path(step["target"]), Path(step["previous"])
        if step.get("moved_new") and target.exists():
            shutil.rmtree(target, ignore_errors=True)
        if step.get("moved_old") and previous.exists() and not target.exists():
            os.replace(previous, target)


def _remap(journal: dict, manifest: dict) -> dict:
    targets = journal["targets"]
    source = manifest.get("source", {})
    setup_restored = "hermes" in targets
    root = journal.get("live_root") or ""
    # The Hermes config now on disk names the backup's Second Brain (setup restored) or the current one.
    old_brain = source.get("second_brain", "") if setup_restored else journal.get("current_second_brain", "")
    new_brain = targets.get("second-brain") or journal.get("current_second_brain") or ""
    remapped: list[str] = []
    review: list[dict] = []
    missing: list[str] = []
    env_roots = [Path(root)] if root and Path(root).is_dir() else []
    for base in env_roots:
        for env_file in [base / ".env", *base.glob("profiles/*/.env")]:
            if not env_file.is_file():
                continue
            text = env_file.read_text(encoding="utf-8")
            values = _env_read(text)
            changed = False
            for name in ("OBSIDIAN_VAULT_PATH", "WIKI_PATH"):
                value = values.get(name, "")
                if value and new_brain and old_brain and _under(value, old_brain) and not _under(value, new_brain):
                    text = _env_set(text, name, _swap_prefix(value, old_brain, new_brain))
                    remapped.append(f"{env_file.relative_to(base).as_posix()}: {name}")
                    changed = True
            # Secrets the backup left out: carry them over from the setup being replaced, if it had them.
            previous_env = _previous_path(journal, "hermes", env_file)
            if previous_env and previous_env.is_file() and not manifest.get("secrets_included"):
                old_values = _env_read(previous_env.read_text(encoding="utf-8"))
                for name, value in old_values.items():
                    if archive.is_secret_env_name(name) and name not in values and value:
                        text = _env_set(text, name, value)
                        changed = True
            if changed:
                env_file.write_text(text, encoding="utf-8")
            final_values = _env_read(text)
            for name in manifest.get("dropped_secrets", []) if setup_restored else []:
                if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name) and name not in final_values and name not in missing:
                    missing.append(name)
        # Second Brain record and skill.
        for record in base.glob("profiles/*/second_brain.json"):
            try:
                data = json.loads(record.read_text(encoding="utf-8"))
            except ValueError:
                continue
            if old_brain and new_brain and _same(data.get("path", ""), old_brain) and not _same(old_brain, new_brain):
                data["path"] = new_brain
                record.write_text(json.dumps(data, indent=2), encoding="utf-8")
                remapped.append(f"{record.relative_to(base).as_posix()}: path")
        for skill in base.glob("profiles/*/skills/note-taking/second-brain/SKILL.md"):
            text = skill.read_text(encoding="utf-8")
            if old_brain and new_brain and old_brain in text and not _same(old_brain, new_brain):
                skill.write_text(text.replace(old_brain, new_brain), encoding="utf-8")
                remapped.append(f"{skill.relative_to(base).as_posix()}: Second Brain path")
        # Anything else that still names the old locations is listed, never rewritten.
        if not setup_restored:
            continue
        olds = [p for p in (source.get("hermes_root", ""), source.get("home", ""), old_brain) if p]
        news = [root, new_brain, str(Path.home())]
        stale = [o for o in olds if not any(_same(o, n) for n in news)]
        if stale:
            for path in base.rglob("*"):
                if path.is_file() and (path.name in _TEXT_REVIEW or path.suffix in (".yaml", ".yml")) and path.stat().st_size < 2_000_000:
                    try:
                        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
                    except OSError:
                        continue
                    for number, line in enumerate(lines, 1):
                        if any(o.lower() in line.lower() or o.replace("\\", "/").lower() in line.lower() for o in stale):
                            review.append({"file": path.relative_to(base).as_posix(), "line": number, "text": line.strip()[:200]})
    return {"remapped": remapped, "review": review[:200], "missing_secrets": missing}


def _previous_path(journal: dict, key: str, now: Path) -> Path | None:
    for step in journal.get("steps", []):
        if step["key"] == key and step.get("moved_old"):
            rel = now.relative_to(step["target"])
            return Path(step["previous"]) / rel
    return None


# ---------------------------------------------------------------- after apply


def finish(state_dir: Path) -> dict:
    journal = _read_journal(state_dir)
    if not journal or journal.get("state") != "applied":
        return {"ok": True, "finished": False}
    for step in journal.get("steps", []):
        shutil.rmtree(step["previous"], ignore_errors=True)
    (state_dir / JOURNAL).unlink(missing_ok=True)
    return {"ok": True, "finished": True}


def rollback(state_dir: Path) -> dict:
    journal = _read_journal(state_dir)
    if not journal or journal.get("state") not in ("applied", "swapping"):
        return {"ok": True, "rolled_back": False}
    _roll_back_steps(journal)
    journal["state"] = "rolled-back"
    _write_journal(state_dir, journal)
    (state_dir / JOURNAL).unlink(missing_ok=True)
    return {"ok": True, "rolled_back": True}


def recover(state_dir: Path) -> dict:
    """At start-up: a restore interrupted mid-swap is rolled back; a staged one is discarded."""
    journal = _read_journal(state_dir)
    if not journal:
        return {"ok": True, "action": "none"}
    state = journal.get("state")
    if state == "swapping":
        _roll_back_steps(journal)
        (state_dir / JOURNAL).unlink(missing_ok=True)
        return {"ok": True, "action": "rolled-back"}
    if state == "staged":
        discard_staging(state_dir)
        return {"ok": True, "action": "discarded-staging"}
    if state == "applied":
        return {"ok": True, "action": "awaiting-finish"}
    (state_dir / JOURNAL).unlink(missing_ok=True)
    return {"ok": True, "action": "cleared"}
