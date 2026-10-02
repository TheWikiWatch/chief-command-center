"""SOUL and memory editing for any profile (contract `chief.persona.v1`).

- SOUL.md: read, write with a stale-write check (the hash the editor started from), Hermes's own injection
  scan shown as warnings (a user's own SOUL still loads, as in Hermes), the truncation limit, and version
  history (every write keeps the previous text; older hand-made `SOUL.md.bak*` files are listed too).
- MEMORY.md / USER.md: Hermes's MemoryStore, so its file lock, its strict injection/exfiltration scan and
  its character limits apply exactly as when the agent writes. Edits are a batch of add / replace / remove
  pinned to the exact entries the editor showed: if the agent changed one meanwhile, nothing is written and
  the caller gets the current entries to reconcile (a conflict, never a silent overwrite).

Hermes reads SOUL and memory once per session (a frozen snapshot), so changes apply from the next session.
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from collections.abc import Iterator

from . import data
from .util import subdict

logger = logging.getLogger("chief-dashboard-bridge")

CONTRACT = "chief.persona.v1"
_PROFILE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_HISTORY_DIR = "soul-history"
_HISTORY_KEEP = 50
_SOUL_MAX = 200_000


class PersonaError(ValueError):
    pass


def profile_home(profile: str) -> Path:
    profile = (profile or "chief").strip().lower()
    if not _PROFILE.match(profile):
        raise PersonaError("Unknown profile.")
    home = data.chief_home() if profile == "chief" else data.profiles_dir() / profile
    if not home.is_dir():
        raise PersonaError("Unknown profile.")
    return home


@contextmanager
def profile_scope(home: Path) -> Iterator[None]:
    """Run Hermes code as if HERMES_HOME were this profile (memory dir, config limits)."""
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    token = set_hermes_home_override(home)
    try:
        yield
    finally:
        reset_hermes_home_override(token)


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        return ""


# ---------------------------------------------------------------- SOUL


def _soul_warnings(text: str) -> list[str]:
    try:
        from tools.threat_patterns import scan_for_threats

        return [str(f) for f in scan_for_threats(text, scope="context")] if text.strip() else []
    except Exception:
        return []


def _soul_limit() -> int | None:
    try:
        from agent import prompt_builder

        return int(prompt_builder._get_context_file_max_chars(None))
    except Exception:
        return None


def _history(home: Path) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    folder = home / _HISTORY_DIR
    if folder.is_dir():
        for p in folder.glob("SOUL-*.md"):
            items.append({"id": p.name, "at": p.stat().st_mtime, "size": p.stat().st_size, "kind": "saved"})
    # Hand-made backups next to SOUL.md (SOUL.md.bak-…) count as history too.
    for p in home.glob("SOUL.md.bak*"):
        if p.is_file():
            items.append({"id": p.name, "at": p.stat().st_mtime, "size": p.stat().st_size, "kind": "backup"})
    return sorted(items, key=lambda i: i["at"], reverse=True)


def _history_path(home: Path, version_id: str) -> Path:
    name = Path(version_id).name
    if name.startswith("SOUL-") and name.endswith(".md"):
        path = home / _HISTORY_DIR / name
    elif name.startswith("SOUL.md.bak"):
        path = home / name
    else:
        raise PersonaError("Unknown version.")
    if not path.is_file():
        raise PersonaError("Unknown version.")
    return path


def read_soul(profile: str) -> dict[str, Any]:
    home = profile_home(profile)
    text = _read(home / "SOUL.md")
    with profile_scope(home):
        limit = _soul_limit()
    return {"text": text, "hash": _hash(text), "limit": limit, "warnings": _soul_warnings(text), "history": _history(home)}


def write_soul(profile: str, text: str, base_hash: str) -> dict[str, Any]:
    home = profile_home(profile)
    text = (text or "").replace("\r\n", "\n")
    if len(text) > _SOUL_MAX:
        return {"ok": False, "error": f"SOUL.md is limited to {_SOUL_MAX:,} characters here."}
    if not text.strip():
        return {"ok": False, "error": "SOUL.md can't be empty. Hermes would fall back to its default identity."}
    path = home / "SOUL.md"
    current = _read(path)
    if _hash(current) != (base_hash or ""):
        return {"ok": False, "conflict": True, "error": "SOUL.md changed since you opened it.",
                "current": {"text": current, "hash": _hash(current)}}
    if current == text:
        return {"ok": True, "hash": _hash(text), "warnings": _soul_warnings(text), "unchanged": True}
    _keep_version(home, current)
    from utils import atomic_write_text

    atomic_write_text(path, text)
    logger.info("persona: SOUL.md saved for %s (%d chars)", home.name, len(text))
    return {"ok": True, "hash": _hash(text), "warnings": _soul_warnings(text), "history": _history(home)}


def _keep_version(home: Path, text: str) -> None:
    if not text.strip():
        return
    folder = home / _HISTORY_DIR
    folder.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime())
    target = folder / f"SOUL-{stamp}.md"
    n = 1
    while target.exists():
        n += 1
        target = folder / f"SOUL-{stamp}-{n}.md"
    target.write_text(text, encoding="utf-8")
    saved = sorted(folder.glob("SOUL-*.md"), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in saved[_HISTORY_KEEP:]:
        try:
            old.unlink()
        except OSError:
            pass


def read_version(profile: str, version_id: str) -> dict[str, Any]:
    home = profile_home(profile)
    return {"id": Path(version_id).name, "text": _read(_history_path(home, version_id))}


def restore_version(profile: str, version_id: str, base_hash: str) -> dict[str, Any]:
    version = read_version(profile, version_id)
    return write_soul(profile, version["text"], base_hash)


# ---------------------------------------------------------------- memory


def _store(home: Path):
    from tools.memory_tool import load_on_disk_store

    with profile_scope(home):
        return load_on_disk_store()


def _target_view(store: Any, target: str) -> dict[str, Any]:
    entries = list(store.user_entries if target == "user" else store.memory_entries)
    limit = store.user_char_limit if target == "user" else store.memory_char_limit
    from tools.memory_tool import ENTRY_DELIMITER

    return {"entries": entries, "limit": int(limit), "used": len(ENTRY_DELIMITER.join(entries)),
            "enabled": bool(store.target_enabled(target))}


def read_memory(profile: str) -> dict[str, Any]:
    home = profile_home(profile)
    store = _store(home)
    return {"memory": _target_view(store, "memory"), "user": _target_view(store, "user")}


def edit_memory(profile: str, target: str, ops: list[dict[str, Any]]) -> dict[str, Any]:
    """Apply the editor's changes as one Hermes batch. Each op is {action: add|replace|remove,
    entry: <the exact entry as shown> (replace/remove), content: <new text> (add/replace)}."""
    if target not in ("memory", "user"):
        return {"ok": False, "error": "Unknown memory."}
    home = profile_home(profile)
    batch: list[dict[str, Any]] = []
    for op in ops or []:
        action = str((op or {}).get("action") or "")
        entry = str((op or {}).get("entry") or "")
        content = str((op or {}).get("content") or "").strip()
        if action == "add" and content:
            batch.append({"action": "add", "content": content})
        elif action == "replace" and entry and content:
            batch.append({"action": "replace", "old_text": entry, "matched_entry": entry, "content": content})
        elif action == "remove" and entry:
            batch.append({"action": "remove", "old_text": entry, "matched_entry": entry})
        else:
            return {"ok": False, "error": "A change was incomplete."}
    if not batch:
        return {"ok": True, **read_memory(profile)}
    with profile_scope(home):
        from tools.memory_tool import load_on_disk_store

        store = load_on_disk_store()
        current = list(store.user_entries if target == "user" else store.memory_entries)
        removing = [b for b in batch if b["action"] == "remove"]
        # Hermes refuses a batch that empties a store (a guard against model mistakes); an owner deleting
        # everything is deliberate, so the last removal goes through the single remove() path.
        last: dict[str, Any] | None = None
        if current and removing and not any(b["action"] == "add" for b in batch):
            remaining = [e for e in current if e not in {b["matched_entry"] for b in removing}]
            replaced = [b for b in batch if b["action"] == "replace"]
            if not remaining and not replaced:
                last = removing[-1]
                batch = [b for b in batch if b is not last]
        result = store.apply_batch(target, batch) if batch else {"success": True}
        if result.get("success") and last is not None:
            result = store.remove(target, last["old_text"], matched_entry=last["matched_entry"])
    if not result.get("success"):
        error = str(result.get("error") or "Hermes refused the change.")
        conflict = "changed since" in error or "no entry matched" in error
        return {"ok": False, "conflict": conflict, "error": _plain_memory_error(error), **read_memory(profile)}
    logger.info("persona: %s updated for %s (%d change(s))", target, home.name, len(ops))
    return {"ok": True, **read_memory(profile)}


def _plain_memory_error(error: str) -> str:
    if "changed since" in error or "no entry matched" in error:
        return "The chief changed this memory while you were editing. Your view is refreshed; make the change again."
    if "over the limit" in error or "exceed" in error:
        return "That would go over this memory's character limit. Shorten or remove something first."
    if "threat" in error.lower() or "injection" in error.lower() or "blocked" in error.lower():
        return "Hermes blocked this text because it looks like an instruction injection or data exfiltration pattern."
    return error.splitlines()[0][:240]


def read_all(profile: str) -> dict[str, Any]:
    return {"ok": True, "contract": CONTRACT, "profile": (profile or "chief").lower(),
            "soul": read_soul(profile), **read_memory(profile)}


# ---------------------------------------------------------------- name

_NAME_OK = re.compile(r"^[^\n\r\t]{1,40}$")
_ROLE_OK = re.compile(r"^[^\n\r\t]{0,60}$")


def _title_parts(title: str) -> tuple[str, str]:
    name, sep, role = str(title or "").partition(" - ")
    return name.strip(), role.strip() if sep else ""


def rename(profile: str, name: str, role: str = "", update_soul: bool = True) -> dict[str, Any]:
    """Rename a bot (the chief too): its title ("Name - Role") in profile.yaml, and, unless asked not to, the
    first "You are <old name>" in its SOUL. A SOUL that doesn't open that way is left alone (`soul` says so)."""
    import yaml

    home = profile_home(profile)
    name, role = " ".join(str(name or "").split()), " ".join(str(role or "").split())
    if not name or not _NAME_OK.match(name) or " - " in name:
        raise PersonaError("Give a name of up to 40 characters (no ' - ').")
    if not _ROLE_OK.match(role):
        raise PersonaError("Keep the role under 60 characters.")
    meta_path = home / "profile.yaml"
    meta = data.load_yaml(meta_path) if meta_path.is_file() else {}
    meta = meta if isinstance(meta, dict) else {}
    ui = subdict(meta, "ui_meta")
    bots = subdict(ui, "hermes-bots")
    old_name, old_role = _title_parts(bots.get("title") or "")
    if not old_name and profile in ("chief", ""):
        from . import identity

        old_name = identity.DEFAULT_ASSISTANT
    bots["title"] = f"{name} - {role}" if role else name
    ui["hermes-bots"] = bots
    meta["ui_meta"] = ui
    tmp = meta_path.with_suffix(".yaml.tmp")
    tmp.write_text(yaml.safe_dump(meta, sort_keys=False, allow_unicode=True), encoding="utf-8")
    os.replace(tmp, meta_path)

    soul_note = "unchanged"
    if update_soul and old_name and old_name != name:
        path = home / "SOUL.md"
        current = _read(path)
        pattern = re.compile(r"^(\s*You are )" + re.escape(old_name) + r"(?=[\s,.;:!—-])", re.M)
        match = pattern.search(current)
        if match and match.start() < 400:
            updated = current[: match.start()] + match.group(1) + name + current[match.end():]
            result = write_soul(profile, updated, _hash(current))
            soul_note = "updated" if result.get("ok") else "not updated"
        else:
            soul_note = "kept (it doesn't open with \"You are " + old_name + "\")"
    try:
        from . import identity

        identity._cache.pop("assistant", None)
    except Exception:
        pass
    logger.info("persona: %s renamed to %s", home.name, bots["title"])
    return {"ok": True, "title": bots["title"], "name": name, "role": role, "soul": soul_note}
