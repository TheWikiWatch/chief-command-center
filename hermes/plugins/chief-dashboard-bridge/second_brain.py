"""The owner's Second Brain folder (contract `chief.second_brain.v1`).

- `inspect(path)`: what a candidate folder holds (notes, folders, an Obsidian vault, a Second Brain we made) and
  exactly what each setup choice would create there, so the app can show it before anything is written.
- `setup(path, mode)`: writes the template once, create-only (an existing file is never overwritten), then
  points Chief at the folder: `OBSIDIAN_VAULT_PATH` and `WIKI_PATH` in the profile `.env` (the upstream
  `obsidian` and `llm-wiki` skills read them) and a `second-brain` skill rendered with the folder's path.
  Modes: `new` (the full layout, empty or new folder), `keep` (an existing folder keeps its layout; only the
  rules, Inbox, Knowledge wiki and Templates are added) and `reorganize` (as `keep` now; Chief then proposes a
  move plan in chat for the owner to approve).
- `seed_soul()`: a fresh profile still carrying Hermes's stock persona gets Chief's default SOUL (the old
  text is kept in SOUL history). A SOUL anyone has edited is never touched.

After setup the app writes nothing in the folder; the agent does all later writing.
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Optional

from . import data, persona

logger = logging.getLogger("chief-dashboard-bridge")

CONTRACT = "chief.second_brain.v1"
_HERE = Path(__file__).resolve().parent / "second_brain"
TEMPLATE = _HERE / "template"
SKILL_SOURCE = _HERE / "skill" / "SKILL.md"
SOUL_SOURCE = _HERE / "SOUL.md"
SKILL_DIR = ("note-taking", "second-brain")
STATE_FILE = "second_brain.json"
MODES = ("new", "keep", "reorganize")
_SCAN_LIMIT = 20_000
_HIDDEN = {".obsidian", ".git", ".trash", ".stfolder", "node_modules", "__pycache__"}
_PLACEHOLDER = re.compile(r"\{\{(today|in3days|in14days|layout)\}\}")

_LAYOUT_NEW = """## Where things go

| Folder | For |
| --- | --- |
| `00 Inbox/` | Quick captures, sorted later |
| `10 Projects/` | One note per project: an outcome and an end |
| `20 Areas/` | Ongoing responsibilities (health, home, work) |
| `30 Resources/` | The owner's own reference notes by topic |
| `40 Knowledge/` | The agent-maintained wiki (see `40 Knowledge/SCHEMA.md`) |
| `90 Archive/` | Finished or inactive notes, never deleted |
| `Journal/Daily/`, `Journal/Weekly/` | Daily notes and weekly reviews |
| `Templates/` | Note templates |
| `Bases/` | Saved views of notes by their properties |
| `Attachments/` | Images and files linked from notes |"""

_LAYOUT_KEEP = """## Where things go

This folder keeps the owner's own layout. Chief adds only `00 Inbox/` (quick captures), `40 Knowledge/` (the
agent-maintained wiki, see `40 Knowledge/SCHEMA.md`), `Templates/` and this file.

<!-- Chief: describe the owner's existing folders here (where projects, areas, references and journals live),
     and ask the owner to review the description before saving it. -->"""

_KEEP_PROMPT = ("I've connected my existing notes folder as my Second Brain and kept my folders as they are. Please look "
                "around it, then draft the \"Where things go\" section of AGENTS.md describing where my projects, areas, "
                "reference notes and journals live. Show me the draft before you save it.")
_REORGANIZE_PROMPT = ("I've connected my existing notes folder as my Second Brain and I'd like it reorganized into Projects, "
                      "Areas, Resources and Archive. Please look around and propose a move plan: every move from -> to, and "
                      "which links would change. Don't move anything until I approve, keep links working, and log each move.")


class SecondBrainError(ValueError):
    pass


# ---------------------------------------------------------------- locations


def default_folder() -> str:
    """`Documents\\Second Brain`, using the real Documents folder (it may be redirected, e.g. to OneDrive)."""
    docs: Optional[Path] = None
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes

            class _GUID(ctypes.Structure):
                _fields_ = [("d1", wintypes.DWORD), ("d2", wintypes.WORD), ("d3", wintypes.WORD), ("d4", ctypes.c_ubyte * 8)]

            # FOLDERID_Documents {FDD39AD0-238F-46AF-ADB4-6C85480369C7}
            fid = _GUID(0xFDD39AD0, 0x238F, 0x46AF, (ctypes.c_ubyte * 8)(0xAD, 0xB4, 0x6C, 0x85, 0x48, 0x03, 0x69, 0xC7))
            out = ctypes.c_wchar_p()
            if ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(fid), 0, None, ctypes.byref(out)) == 0:
                docs = Path(out.value)
                ctypes.windll.ole32.CoTaskMemFree(out)
        except Exception:
            docs = None
    if docs is None:
        docs = Path.home() / "Documents"
    return str(docs / "Second Brain")


def _profile_home(profile: str = "chief") -> Path:
    try:
        return persona.profile_home(profile)
    except persona.PersonaError as exc:
        raise SecondBrainError(str(exc)) from exc


def _clean_path(raw: str) -> Path:
    text = str(raw or "").strip().strip('"')
    if not text or "\0" in text:
        raise SecondBrainError("Choose a folder.")
    path = Path(os.path.expandvars(os.path.expanduser(text)))
    if not path.is_absolute():
        raise SecondBrainError("Use a full folder path, like C:\\Users\\you\\Documents\\Second Brain.")
    path = Path(os.path.normpath(str(path)))
    if path.parent == path:
        raise SecondBrainError("Choose a folder, not a whole drive.")
    resolved = path.resolve(strict=False)
    system = [Path(os.environ[e]) for e in ("SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramData") if os.environ.get(e)]
    for root, block_ancestors in [(data.install_root(), True), (data.chief_home(), True)] + [(p, False) for p in system]:
        try:
            root = root.resolve(strict=False)
        except OSError:
            continue
        inside = resolved == root or root in resolved.parents
        if inside or (block_ancestors and resolved in root.parents):
            raise SecondBrainError("That folder belongs to the system or to Chief itself. Choose one of your own folders.")
    return path


def _manifest() -> dict[str, Any]:
    return json.loads((TEMPLATE / "manifest.json").read_text(encoding="utf-8"))


def _plan(mode: str) -> tuple[list[str], list[str]]:
    manifest = _manifest()
    if mode == "new":
        return list(manifest["folders"]), list(manifest["files"])
    keep = manifest["keepExisting"]
    return list(keep["folders"]), list(keep["files"])


# ---------------------------------------------------------------- state


def _state_path(home: Path) -> Path:
    return home / STATE_FILE


def _read_state(home: Path) -> dict[str, Any]:
    try:
        value = json.loads(_state_path(home).read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _env_paths(home: Path) -> dict[str, str]:
    from hermes_cli.config import load_env

    with persona.profile_scope(home):
        env = load_env()
    return {"OBSIDIAN_VAULT_PATH": env.get("OBSIDIAN_VAULT_PATH", ""), "WIKI_PATH": env.get("WIKI_PATH", "")}


def _skill_path(home: Path) -> Path:
    return home / "skills" / SKILL_DIR[0] / SKILL_DIR[1] / "SKILL.md"


def status(profile: str = "chief") -> dict[str, Any]:
    home = _profile_home(profile)
    env = _env_paths(home)
    state = _read_state(home)
    path = env["OBSIDIAN_VAULT_PATH"]
    return {
        "ok": True,
        "contract": CONTRACT,
        "configured": bool(path),
        "path": path,
        "exists": bool(path) and Path(path).is_dir(),
        "wiki_path": env["WIKI_PATH"],
        "mode": state.get("mode") if state.get("path") == path else None,
        "set_up_at": state.get("set_up_at") if state.get("path") == path else None,
        "skill_installed": _skill_path(home).is_file(),
        "default_path": default_folder(),
    }


# ---------------------------------------------------------------- inspect


def _survey(path: Path) -> dict[str, Any]:
    notes = files = 0
    folders: set[str] = set()
    truncated = False
    for current, dirs, names in os.walk(path):
        dirs[:] = [d for d in dirs if d not in _HIDDEN and not d.startswith(".")]
        rel = Path(current).relative_to(path)
        if rel.parts:
            folders.add(rel.parts[0])
        for name in names:
            files += 1
            if name.lower().endswith(".md"):
                notes += 1
        if files >= _SCAN_LIMIT:
            truncated = True
            break
    return {"notes": notes, "files": files, "top_folders": sorted(folders), "truncated": truncated}


def _writable(path: Path) -> bool:
    probe = path if path.is_dir() else next((p for p in path.parents if p.is_dir()), None)
    if probe is None:
        return False
    return os.access(probe, os.W_OK)


def _would_create(path: Path, mode: str) -> dict[str, list[str]]:
    folders, files = _plan(mode)
    return {
        "folders": [f for f in folders if not (path / f).is_dir()],
        "files": [f for f in files if not (path / f).exists()],
        "existing": [f for f in files if (path / f).exists()],
    }


def inspect(raw_path: str) -> dict[str, Any]:
    path = _clean_path(raw_path)
    exists = path.is_dir()
    if path.exists() and not exists:
        raise SecondBrainError("That's a file, not a folder.")
    survey = _survey(path) if exists else {"notes": 0, "files": 0, "top_folders": [], "truncated": False}
    empty = survey["files"] == 0 and not survey["top_folders"]
    ours = exists and all((path / f).is_file() for f in ("AGENTS.md", "40 Knowledge/SCHEMA.md"))
    if not exists or empty:
        choices = ["new"]
    elif ours:
        choices = ["new"]  # our own layout: fill in anything missing
    else:
        choices = ["keep", "reorganize"]
    return {
        "ok": True,
        "path": str(path),
        "exists": exists,
        "empty": empty,
        "writable": _writable(path),
        "obsidian": exists and (path / ".obsidian").is_dir(),
        "ours": ours,
        **survey,
        "choices": choices,
        "plans": {mode: _would_create(path, mode) for mode in choices},
    }


# ---------------------------------------------------------------- setup


def _render(text: str, layout: str, today: date) -> str:
    values = {
        "today": today.isoformat(),
        "in3days": (today + timedelta(days=3)).isoformat(),
        "in14days": (today + timedelta(days=14)).isoformat(),
        "layout": layout,
    }
    return _PLACEHOLDER.sub(lambda m: values[m.group(1)], text)


def _write_new(target: Path, text: str) -> bool:
    """Create-only: an existing file is left exactly as it is."""
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        with open(target, "x", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        return True
    except FileExistsError:
        return False


def install_skill(home: Path, vault: Path) -> Path:
    text = SKILL_SOURCE.read_text(encoding="utf-8").replace("{{vault}}", str(vault))
    dest = _skill_path(home)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".tmp")
    tmp.write_text(text, encoding="utf-8", newline="\n")
    os.replace(tmp, dest)
    return dest


def _configure(home: Path, vault: Path) -> None:
    from hermes_cli.config import save_env_value

    with persona.profile_scope(home):
        save_env_value("OBSIDIAN_VAULT_PATH", str(vault))
        save_env_value("WIKI_PATH", str(vault / "40 Knowledge"))
    install_skill(home, vault)


def setup(raw_path: str, mode: str, profile: str = "chief", today: Optional[date] = None) -> dict[str, Any]:
    mode = str(mode or "").strip().lower()
    if mode not in MODES:
        raise SecondBrainError("Choose how to set up the folder.")
    home = _profile_home(profile)
    found = inspect(raw_path)
    path = Path(found["path"])
    if mode not in found["choices"]:
        if mode == "new":
            raise SecondBrainError("This folder already has notes. Choose to keep its folders or to reorganize it.")
        raise SecondBrainError("This folder is empty; set it up as a new Second Brain.")
    if not found["writable"]:
        raise SecondBrainError("Chief can't write to that folder. Choose another one.")

    plan_mode = "new" if mode == "new" else "keep"
    folders, files = _plan(plan_mode)
    layout = _LAYOUT_NEW if plan_mode == "new" else _LAYOUT_KEEP
    today = today or date.today()
    created: list[str] = []
    kept: list[str] = []
    path.mkdir(parents=True, exist_ok=True)
    for folder in folders:
        target = path / folder
        if not target.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            created.append(folder + "/")
    for rel in files:
        source = TEMPLATE / "files" / rel
        text = _render(source.read_text(encoding="utf-8"), layout, today)
        (created if _write_new(path / rel, text) else kept).append(rel)

    _configure(home, path)
    state = {"path": str(path), "mode": mode, "template": _manifest().get("version", 1),
             "set_up_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "created": created}
    _state_path(home).write_text(json.dumps(state, indent=2), encoding="utf-8")
    logger.info("Second Brain set up (%s): %d created, %d kept", mode, len(created), len(kept))
    prompt = _KEEP_PROMPT if mode == "keep" else _REORGANIZE_PROMPT if mode == "reorganize" else ""
    return {"ok": True, "path": str(path), "mode": mode, "created": created, "kept": kept, "next_prompt": prompt}


# ---------------------------------------------------------------- default persona


def seed_soul(profile: str = "chief") -> dict[str, Any]:
    """Replace Hermes's untouched stock SOUL with Chief's default. Anything else is left alone."""
    home = _profile_home(profile)
    soul = home / "SOUL.md"
    try:
        current = soul.read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        current = ""
    from hermes_cli.default_soul import DEFAULT_SOUL_MD, _normalize_soul, is_legacy_template_soul

    stock = not current.strip() or _normalize_soul(current) == _normalize_soul(DEFAULT_SOUL_MD) or is_legacy_template_soul(current)
    if not stock:
        return {"ok": True, "seeded": False}
    result = persona.write_soul(profile, SOUL_SOURCE.read_text(encoding="utf-8"), persona._hash(current))
    return {"ok": bool(result.get("ok")), "seeded": bool(result.get("ok"))}
