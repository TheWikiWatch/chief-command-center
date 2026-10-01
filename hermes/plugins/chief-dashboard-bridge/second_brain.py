"""The owner's Second Brain folder (contract `chief.second_brain.v1`).

- `inspect(path)`: what a candidate folder holds (notes, folders, an Obsidian vault, a Second Brain we made) and
  exactly what each setup choice would create there, so the app can show it before anything is written.
- `setup(path, mode)`: writes the template once, create-only (an existing file is never overwritten), then
  points Chief at the folder: `OBSIDIAN_VAULT_PATH` and `WIKI_PATH` in the profile `.env` (the upstream
  `obsidian` and `llm-wiki` skills read them), the `second-brain` skill (the folder's path and its
  `CRITICAL_FACTS.md`, auto-loaded into every conversation) and the `second-brain-writes` write gate, and the
  scheduled routines (morning, nightly, weekly, health check) from the bundled toolkit.
- `upgrade()`: a Second Brain set up by an earlier version gets what is new (create-only files, the skills,
  auto-load and the routines). Run by the bridge at start.
- `sync_critical_facts()`: re-renders the `second-brain` skill when `CRITICAL_FACTS.md` changes.
- `routines()` / `set_routine()`: the scheduled routines, on or off and at what time.
  Formats: `para` (Organized: PARA folders, a small wiki in `40 Knowledge`, `📅` tasks in notes, rules in
  `AGENTS.md`) and `wiki` (Agent-first wiki, the toolkit's wiki-style layout: `raw/` sources, `wiki/`, Kanban
  `boards/` with task notes, a `drop/` folder, rules in `_CLAUDE.md`).
  Modes: `new` (the full layout, empty or new folder), `keep` (an existing folder keeps its layout; the format's
  rules file and system folders are added) and `reorganize` (as `keep` now; Chief then proposes a move plan in
  chat for the owner to approve). A folder that already has its own rules file (`_CLAUDE.md`, or an
  `AGENTS.md` the app didn't write) is used as it is: nothing is added, and Chief follows that file.
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
FORMATS = ("para", "wiki")
TEMPLATES = {"para": TEMPLATE, "wiki": _HERE / "template-wiki"}
SKILL_SOURCE = _HERE / "skill" / "SKILL.md"
WRITES_SOURCE = _HERE / "skill-writes" / "SKILL.md"
SKILL_SOURCES = {
    "para": (SKILL_SOURCE, WRITES_SOURCE),
    "wiki": (_HERE / "skill-wiki" / "SKILL.md", _HERE / "skill-writes-wiki" / "SKILL.md"),
}
# The wiki format's own routines' skills: drop folder, morning brief, Current Analysis.
WIKI_SKILLS = {
    "second-brain-drop": _HERE / "skill-drop" / "SKILL.md",
    "second-brain-brief": _HERE / "skill-brief" / "SKILL.md",
    "second-brain-analysis": _HERE / "skill-analysis" / "SKILL.md",
}
RULES_FILE = {"para": "AGENTS.md", "wiki": "_CLAUDE.md"}
DROP_GATE = _HERE / "drop_gate.py"
DROP_GATE_NAME = "second_brain_drop_gate.py"
WRITES_DIR = ("note-taking", "second-brain-writes")
TOOLKIT = "obsidian-second-brain"
TEMPLATE_VERSION = 2  # the PARA template's version (the wiki template has its own, in its manifest)
_FACTS_MAX = 1500
SOUL_SOURCE = _HERE / "SOUL.md"
SKILL_DIR = ("note-taking", "second-brain")
STATE_FILE = "second_brain.json"
MODES = ("new", "keep", "reorganize")
_SCAN_LIMIT = 20_000
_HIDDEN = {".obsidian", ".git", ".trash", ".stfolder", "node_modules", "__pycache__"}
_PLACEHOLDER = re.compile(r"\{\{(today|in3days|in14days|layout|foldermap)\}\}")

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

_FOLDERMAP_NEW = """## Folder Map

Where each kind of note goes. The Second Brain skills read this table; it wins over their own defaults.

| Note type | Folder |
| --- | --- |
| Quick capture, anything without a home yet | `00 Inbox/` |
| Project | `10 Projects/` |
| Area (ongoing responsibility), recurring obligation | `20 Areas/` |
| Person | `30 Resources/People/` |
| Company, tool (entity) | `40 Knowledge/entities/` |
| Idea, concept, framework, synthesis | `40 Knowledge/concepts/` |
| Decision record | `40 Knowledge/decisions/` (`ADR-YYYY-MM-DD - Title.md`) |
| Raw source (never edited) | `40 Knowledge/raw/` |
| Research output | `30 Resources/Research/` |
| Daily note | `Journal/Daily/` |
| Weekly or monthly review | `Journal/Weekly/` |
| Meeting note | `Journal/Meetings/` |
| Work log | `Journal/Logs/` |
| Kanban board | `30 Resources/Boards/` |
| Standalone task | a checkbox in the project, area or daily note it belongs to; else `00 Inbox/` |
| Finished or inactive note | `90 Archive/` |"""

_FOLDERMAP_KEEP = """## Folder Map

Where each kind of note goes. The Second Brain skills read this table; it wins over their own defaults.

| Note type | Folder |
| --- | --- |
| Quick capture, anything without a home yet | `00 Inbox/` |
| Idea, concept, synthesis, decision record, company or tool | `40 Knowledge/` (see `40 Knowledge/SCHEMA.md`) |
| Raw source (never edited) | `40 Knowledge/raw/` |

<!-- Chief: add a row for each kind of note the owner keeps in their own folders (projects, areas, people,
     daily notes, meetings, reviews), and ask the owner to review the table before saving it. -->"""

_WIKI_LAYOUT_KEEP = """## The owner's own folders

This folder had notes before it became a Second Brain, and they stay where they are. The app added only this
manual, `index.md`, `log.md`, `CRITICAL_FACTS.md`, the `drop/` folder, the boards and the templates.

<!-- Chief: add a row to the Folder Map below for each of the owner's existing folders (what kind of note lives
     there), and ask the owner to review the rows before saving them. -->"""

_KEEP_PROMPT_WIKI = ("I've connected my existing notes folder as my Second Brain in the agent-first wiki format and kept my "
                     "folders as they are. Please look around it, then draft Folder Map rows in _CLAUDE.md for my existing "
                     "folders. Show me the draft before you save it.")
_ADOPT_PROMPT = ("I've connected my existing Second Brain. Please read its rules file ({rules}) and index.md, then tell me in "
                 "a few lines how it's organized and how you'll work with it. Don't change anything yet.")

_KEEP_PROMPT = ("I've connected my existing notes folder as my Second Brain and kept my folders as they are. Please look "
                "around it, then draft the \"Where things go\" section of AGENTS.md describing where my projects, areas, "
                "reference notes and journals live. Show me the draft before you save it.")
_REORGANIZE_PROMPT = ("I've connected my existing notes folder as my Second Brain and I'd like it reorganized into Projects, "
                      "Areas, Resources and Archive. Please look around and propose a move plan: every move from -> to, and "
                      "which links would change. Don't move anything until I approve, keep links working, and log each move.")


_REORGANIZE_PROMPT_WIKI = ("I've connected my existing notes folder as my Second Brain and I'd like it reorganized into the agent-first "
                           "wiki layout in _CLAUDE.md (raw/ sources, wiki/ pages, boards/ with task notes). Please look around and "
                           "propose a move plan: every move from -> to, which notes become sources in raw/ and which become wiki "
                           "pages, and which links would change. Don't move anything until I approve, keep links working, and "
                           "log each move.")


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


def adopted() -> bool:
    """An existing install the app took over (`CHIEF_ADOPTED`, set by the desktop app): its own skills, routines,
    toolkit and settings are kept, and the app adds none of its own alongside them."""
    return os.environ.get("CHIEF_ADOPTED") == "1"


def _format(value: Any) -> str:
    fmt = str(value or "").strip().lower()
    return fmt if fmt in FORMATS else "para"


def _manifest(fmt: str = "para") -> dict[str, Any]:
    return json.loads((TEMPLATES[_format(fmt)] / "manifest.json").read_text(encoding="utf-8"))


def _plan(mode: str, fmt: str = "para") -> tuple[list[str], list[str]]:
    manifest = _manifest(fmt)
    if mode == "new":
        return list(manifest["folders"]), list(manifest["files"])
    keep = manifest["keepExisting"]
    return list(keep["folders"]), list(keep["files"])


# ---------------------------------------------------------------- what a folder already is


def _is_pointer(file: Path, target: str) -> bool:
    """The app's short "the rules are in [[target]]" file (each format writes one for the other name)."""
    try:
        text = file.read_text(encoding="utf-8-sig")
    except OSError:
        return False
    return len(text) < 800 and f"[[{target}]]" in text and text.lstrip().startswith("# Rules for agents")


def manual(path: Path) -> str:
    """The folder's own rules file: `_CLAUDE.md` unless it is the app's pointer to `AGENTS.md`, else `AGENTS.md`
    unless it is the app's pointer to `_CLAUDE.md`. "" when there is none."""
    claude, agents = path / "_CLAUDE.md", path / "AGENTS.md"
    if claude.is_file() and not _is_pointer(claude, "AGENTS"):
        return "_CLAUDE.md"
    if agents.is_file() and not _is_pointer(agents, "_CLAUDE"):
        return "AGENTS.md"
    return ""


def detect_format(path: Path, rules: str = "") -> Optional[str]:
    """Which format a folder already uses: `wiki` (the toolkit's wiki-style layout: `wiki/` and `raw/`, or a
    `_CLAUDE.md` describing them), `para` (the app's PARA layout), or None."""
    if not path.is_dir():
        return None
    if (path / "wiki").is_dir() and (path / "raw").is_dir():
        return "wiki"
    if (path / "AGENTS.md").is_file() and (path / "40 Knowledge" / "SCHEMA.md").is_file():
        return "para"
    if rules == "_CLAUDE.md":
        try:
            text = (path / rules).read_text(encoding="utf-8-sig")
        except OSError:
            text = ""
        if "wiki/" in text and "raw/" in text:
            return "wiki"
    if any((path / f).is_dir() for f in ("00 Inbox", "10 Projects", "20 Areas")):
        return "para"
    return None


def _ours(path: Path) -> Optional[str]:
    """The format of a Second Brain the app made, or None."""
    if (path / "AGENTS.md").is_file() and (path / "40 Knowledge" / "SCHEMA.md").is_file():
        return "para"
    if _is_pointer(path / "AGENTS.md", "_CLAUDE") and (path / "_CLAUDE.md").is_file() and (path / "drop").is_dir():
        return "wiki"
    return None


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
        "format": _format(state.get("format")) if state.get("path") == path and path else None,
        "rules": state.get("rules") if state.get("path") == path else None,
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


def _would_create(path: Path, mode: str, fmt: str = "para") -> dict[str, list[str]]:
    if mode != "new" and manual(path):
        return {"folders": [], "files": [], "existing": []}
    folders, files = _plan(mode, fmt)
    return {
        "folders": [f for f in folders if not (path / f).is_dir()],
        "files": [f for f in files if not (path / f).exists()],
        "existing": [f for f in files if (path / f).exists()],
    }


def inspect(raw_path: str, fmt: Optional[str] = None) -> dict[str, Any]:
    """What a folder holds, which format it already uses, and what setting it up in `fmt` would create
    (`fmt` defaults to the detected format, else PARA)."""
    path = _clean_path(raw_path)
    exists = path.is_dir()
    if path.exists() and not exists:
        raise SecondBrainError("That's a file, not a folder.")
    survey = _survey(path) if exists else {"notes": 0, "files": 0, "top_folders": [], "truncated": False}
    empty = survey["files"] == 0 and not survey["top_folders"]
    rules = manual(path) if exists else ""
    detected = detect_format(path, rules) if exists else None
    made = _ours(path) if exists else None
    ours = made is not None
    fmt = _format(fmt or made or detected)
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
        "format": fmt,
        "format_detected": made or detected,
        "manual": rules,
        "choices": choices,
        "plans": {mode: _would_create(path, mode, fmt) for mode in choices},
    }


# ---------------------------------------------------------------- setup


def _render(text: str, layout: str, today: date, foldermap: str = _FOLDERMAP_NEW) -> str:
    values = {
        "today": today.isoformat(),
        "in3days": (today + timedelta(days=3)).isoformat(),
        "in14days": (today + timedelta(days=14)).isoformat(),
        "layout": layout,
        "foldermap": foldermap,
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


def critical_facts(vault: Path) -> str:
    """The body of the vault's `CRITICAL_FACTS.md` (no properties, no preamble), capped: what every
    conversation is given."""
    try:
        text = (vault / "CRITICAL_FACTS.md").read_text(encoding="utf-8-sig")
    except OSError:
        return "_(No `CRITICAL_FACTS.md` yet: create it from what you know, and keep it to about 120 tokens.)_"
    text = re.sub(r"\A---\n.*?\n---\n", "", text, flags=re.S)
    text = re.sub(r"## For future agent\n.*?(?=\n## |\n- |\Z)", "", text, flags=re.S).strip()
    if len(text) > _FACTS_MAX:
        text = text[:_FACTS_MAX].rsplit("\n", 1)[0] + "\n_(cut: keep `CRITICAL_FACTS.md` short)_"
    return text or "_(`CRITICAL_FACTS.md` is empty.)_"


def _atomic_write(dest: Path, text: str) -> bool:
    """Write `text` to `dest` unless it already says exactly that. True when it changed."""
    try:
        if dest.read_text(encoding="utf-8") == text:
            return False
    except OSError:
        pass
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".tmp")
    tmp.write_text(text, encoding="utf-8", newline="\n")
    os.replace(tmp, dest)
    return True


def _layout_of(home: Path, vault: Path) -> tuple[str, str]:
    """(format, rules file) for the profile's Second Brain: what setup recorded, else what the folder shows."""
    state = _read_state(home)
    if state.get("format") and state.get("path") and Path(state["path"]) == vault:
        fmt = _format(state["format"])
        return fmt, str(state.get("rules") or RULES_FILE[fmt])
    rules = manual(vault)
    fmt = _ours(vault) or detect_format(vault, rules) or "para"
    return fmt, rules or RULES_FILE[fmt]


def _external_dirs(home: Path) -> list[Path]:
    try:
        import yaml

        config = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8")) or {}
    except (OSError, ValueError):
        return []
    skills = config.get("skills") if isinstance(config.get("skills"), dict) else {}
    return [Path(str(d)) for d in skills.get("external_dirs") or []]


def toolkit_dir(home: Path) -> Path:
    """The toolkit this profile uses: its own copy, else one in its `skills.external_dirs` (an adopted install's)."""
    own = home / "skills" / TOOLKIT
    if own.is_dir():
        return own
    for folder in _external_dirs(home):
        if (folder / TOOLKIT).is_dir():
            return folder / TOOLKIT
    return own


def _owner_skill(home: Path, name: str, ours: Path) -> bool:
    """A skill of the owner's with this name (anywhere in the profile's skills or its external dirs, not written by
    the app): the app's same-named skill would shadow it, so it isn't installed."""
    for root in [home / "skills", *_external_dirs(home)]:
        if not root.is_dir():
            continue
        for found in root.rglob(f"{name}/SKILL.md"):
            if found.resolve() == ours.resolve():
                continue
            try:
                head = found.read_text(encoding="utf-8")[:600]
            except OSError:
                continue
            if "author: Chief Command Center" not in head:
                return True
    return False


def install_skill(home: Path, vault: Path, fmt: Optional[str] = None, rules: Optional[str] = None,
                  extras: Optional[bool] = None) -> Path:
    """The `second-brain` skill (the folder, its rules file, its critical facts, which skill does what) and the
    `second-brain-writes` write gate, in the variant for the folder's format, rendered for this folder. The wiki
    format also gets its routines' skills (drop folder, morning brief, Current Analysis), unless the folder has its
    own rules (and so, likely, its own versions of them) and none of the app's routines is on: `extras`."""
    if fmt is None or rules is None:
        found_fmt, found_rules = _layout_of(home, vault)
        fmt, rules = fmt or found_fmt, rules or found_rules
    fmt = _format(fmt)
    toolkit = toolkit_dir(home).as_posix()

    def render(source: Path) -> str:
        return (source.read_text(encoding="utf-8").replace("{{vault}}", str(vault)).replace("{{rules}}", rules)
                .replace("{{toolkit}}", toolkit).replace("{{critical_facts}}", critical_facts(vault)))

    def put(target: Path, source: Path) -> None:
        if not _owner_skill(home, target.parent.name, target):
            _atomic_write(target, render(source))

    skill, writes = SKILL_SOURCES[fmt]
    dest = _skill_path(home)
    put(dest, skill)
    put(home / "skills" / WRITES_DIR[0] / WRITES_DIR[1] / "SKILL.md", writes)
    if extras is None:
        state = _read_state(home)
        extras = not (state.get("own_rules") and state.get("routines_off"))
    if fmt == "wiki" and extras:
        for name, source in WIKI_SKILLS.items():
            put(home / "skills" / "note-taking" / name / "SKILL.md", source)
    return dest


def _auto_load(home: Path) -> bool:
    """Pin the `second-brain` skill into every new conversation (Hermes's `skills.auto_load`). Added to
    whatever the owner already pins; never removed."""
    from cli import save_config_value
    from hermes_cli.config import load_config

    with persona.profile_scope(home):
        skills = (load_config() or {}).get("skills")
        current = list((skills or {}).get("auto_load") or []) if isinstance(skills, dict) else []
        if SKILL_DIR[1] in current:
            return False
        save_config_value("skills.auto_load", current + [SKILL_DIR[1]])
    return True


def _wiki_path(home: Path, vault: Path, fmt: str) -> None:
    """`WIKI_PATH` (the upstream llm-wiki skill's folder) is `40 Knowledge` in the PARA format. The wiki format
    keeps its own `wiki/` and `raw/` at the root, which llm-wiki's layout doesn't match, so it is unset."""
    from hermes_cli.config import load_env, remove_env_value, save_env_value

    with persona.profile_scope(home):
        if fmt == "para":
            save_env_value("WIKI_PATH", str(vault / "40 Knowledge"))
        elif (load_env() or {}).get("WIKI_PATH"):
            remove_env_value("WIKI_PATH")


def _configure(home: Path, vault: Path, fmt: Optional[str] = None, rules: Optional[str] = None) -> None:
    from hermes_cli.config import save_env_value

    if fmt is None or rules is None:
        found_fmt, found_rules = _layout_of(home, vault)
        fmt, rules = fmt or found_fmt, rules or found_rules
    with persona.profile_scope(home):
        save_env_value("OBSIDIAN_VAULT_PATH", str(vault))
        if not adopted():
            # The toolkit's own settings file stays in the profile, never in the user's home folder.
            save_env_value("OBSIDIAN_ENV_FILE", str(home / "obsidian-second-brain.env"))
    if not adopted():
        _wiki_path(home, vault, _format(fmt))
    install_skill(home, vault, fmt, rules)
    _auto_load(home)


def share_with(bot_home: Path, profile: str = "chief") -> bool:
    """Give a bot the owner's Second Brain the way the chief has it: the `second-brain` skill (auto-loaded)
    and the write gate, rendered for the same folder; the folder paths; and the chief's copy of the toolkit
    through Hermes's `skills.external_dirs`. False when no Second Brain is set up yet."""
    home = _profile_home(profile)
    vault = _env_paths(home).get("OBSIDIAN_VAULT_PATH") or ""
    if not vault or not Path(vault).is_dir() or Path(bot_home).resolve() == home.resolve():
        return False
    from cli import save_config_value
    from hermes_cli.config import load_config, save_env_value

    bot_home = Path(bot_home)
    fmt, rules = _layout_of(home, Path(vault))
    with persona.profile_scope(bot_home):
        save_env_value("OBSIDIAN_VAULT_PATH", vault)
        skills = (load_config() or {}).get("skills")
        skills = skills if isinstance(skills, dict) else {}
        toolkit = str(home / "skills" / TOOLKIT)
        external = list(skills.get("external_dirs") or [])
        if toolkit not in external:
            save_config_value("skills.external_dirs", external + [toolkit])
    _wiki_path(bot_home, Path(vault), fmt)
    install_skill(bot_home, Path(vault), fmt, rules)
    _auto_load(bot_home)
    return True


def _share_with_team(profile: str = "chief") -> list[str]:
    """Every bot on the chief's team gets the Second Brain (an upgrade of bots minted before it was shared)."""
    home = _profile_home(profile)
    shared = []
    for bot in sorted(p for p in home.parent.iterdir() if p.is_dir() and p.name != home.name and (p / "config.yaml").is_file()):
        try:
            if share_with(bot, profile):
                shared.append(bot.name)
        except Exception:
            logger.debug("sharing the Second Brain with %s failed", bot.name, exc_info=True)
    return shared


def sync_critical_facts(profile: str = "chief") -> bool:
    """Re-render the `second-brain` skill when `CRITICAL_FACTS.md` changed. True when it was rewritten."""
    home = _profile_home(profile)
    vault = _env_paths(home).get("OBSIDIAN_VAULT_PATH") or ""
    if not vault or not Path(vault).is_dir():
        return False
    before = _skill_path(home).read_text(encoding="utf-8") if _skill_path(home).is_file() else ""
    install_skill(home, Path(vault))
    return _skill_path(home).read_text(encoding="utf-8") != before


# ---------------------------------------------------------------- scheduled routines

# The toolkit's four scheduled agents (its HOOKS.md), armed for the owner's folder. Each is a cron job in the
# chief's profile that runs the toolkit's blueprint skill in the Second Brain and reports to the app.
ROUTINES = (
    {"id": "morning", "name": "Second Brain: morning", "skill": "obsidian-morning", "schedule": "0 8 * * *",
     "title": "Morning note", "about": "Today's daily note with what's due and overdue."},
    {"id": "nightly", "name": "Second Brain: nightly", "skill": "obsidian-nightly", "schedule": "0 22 * * *",
     "title": "Nightly tidy", "about": "Closes the day: reconciles contradictions, links orphans, notes patterns."},
    {"id": "weekly", "name": "Second Brain: weekly review", "skill": "obsidian-weekly", "schedule": "0 18 * * 5",
     "title": "Weekly review", "about": "Friday evening: the week's review, Inbox and projects checked."},
    {"id": "health", "name": "Second Brain: health check", "skill": "obsidian-health-check", "schedule": "0 21 * * 0",
     "title": "Health check", "about": "Sunday evening: duplicates, stale facts, broken links, untagged notes."},
)
# The wiki format adds its own three: the drop folder (gated by a script, so an empty folder never calls the
# model), the morning brief (mirrored into the chat session, so the owner's answers have their questions), and
# Current Analysis as the last step of the nightly routine.
WIKI_ROUTINES = (
    {"id": "drop", "name": "Second Brain: drop folder", "skill": "second-brain-drop", "schedule": "5,35 * * * *",
     "title": "Drop folder", "about": "Files one file from drop/ every half hour; silent when it's empty.",
     "prompt": "Run the second-brain-drop routine: file at most one file from the Second Brain's drop/ folder, following "
               "the skill and the second-brain-writes gate exactly. Do not ask questions. If there is nothing to file, "
               "your whole final response is exactly [SILENT]."},
    {"id": "brief", "name": "Second Brain: morning brief", "skill": "second-brain-brief", "schedule": "30 8 * * 1-5",
     "title": "Morning brief", "about": "Weekdays: what changed, today's focus, and up to five questions for you.",
     "prompt": "Write today's morning brief (second-brain-brief, Mode A). Do not ask anything outside the brief. Your final "
               "response is the whole brief, starting with '# Morning brief'."},
)
_WIKI_NIGHTLY = ("Run the obsidian-nightly scheduled Second Brain routine, then the second-brain-analysis skill to rewrite "
                 "wiki/reviews/Current Analysis.md. Follow the skills and the second-brain-writes gate exactly; do not ask "
                 "questions; log what you changed, then stop with a short summary ending in the write-gate line.")
_ROUTINE_PROMPT = ("Run the {skill} scheduled Second Brain routine. Follow the skill's procedure and the second-brain-writes "
                   "rules exactly; do not ask questions; log what you changed, then stop with a short summary.")


def _routines_for(fmt: str) -> tuple[dict[str, Any], ...]:
    return ROUTINES + WIKI_ROUTINES if _format(fmt) == "wiki" else ROUTINES


def _install_drop_gate(home: Path) -> str:
    """Hermes runs cron scripts only from the profile's scripts/ folder."""
    target = home / "scripts" / DROP_GATE_NAME
    _atomic_write(target, DROP_GATE.read_text(encoding="utf-8"))
    return DROP_GATE_NAME


def _cron(home: Path):
    from cron import jobs

    return jobs, jobs.use_cron_store(home)


def _routine_jobs(home: Path) -> dict[str, dict[str, Any]]:
    jobs, store = _cron(home)
    names = {r["name"]: r["id"] for r in ROUTINES + WIKI_ROUTINES}
    with store:
        return {names[j["name"]]: j for j in jobs.list_jobs(include_disabled=True) if j.get("name") in names}


def _job_args(routine: dict[str, Any], fmt: str, home: Path) -> tuple[str, dict[str, Any]]:
    skills = [routine["skill"], SKILL_DIR[1], WRITES_DIR[1]]
    kwargs: dict[str, Any] = {}
    prompt = routine.get("prompt") or _ROUTINE_PROMPT.format(skill=routine["skill"])
    if routine["id"] == "nightly" and _format(fmt) == "wiki":
        prompt, skills = _WIKI_NIGHTLY, [routine["skill"], "second-brain-analysis", SKILL_DIR[1], WRITES_DIR[1]]
    if routine["id"] == "drop":
        kwargs["script"] = _install_drop_gate(home)
    if routine["id"] == "brief":
        kwargs["attach_to_session"] = True
    return prompt, {"skills": skills, **kwargs}


def ensure_routines(home: Path, vault: Path, fmt: Optional[str] = None, paused: bool = False,
                    switch: Optional[bool] = None, only: Optional[str] = None) -> list[str]:
    """Create each of the format's routines that doesn't exist yet (none while `paused`). An existing one keeps
    its time and on/off state, but follows the folder and the format (prompt, skills, workdir, gate). A wiki-only
    routine left from an earlier format is removed. `switch` (setup only) turns them all on or off. Returns the ids
    created. A routine that would start switched off isn't created (it is listed as off, and created when turned on);
    `only` creates just that one."""
    if not toolkit_dir(home).is_dir():
        return []
    fmt = _format(fmt or _layout_of(home, vault)[0])
    try:
        existing = _routine_jobs(home)
        jobs, store = _cron(home)
        made = []
        wanted = {r["id"] for r in _routines_for(fmt)}
        with store:
            for routine in _routines_for(fmt):
                job = existing.get(routine["id"])
                if job is not None:
                    prompt, extra = _job_args(routine, fmt, home)
                    want = {"prompt": prompt, "skills": extra["skills"], "workdir": str(vault)}
                    for key in ("script", "attach_to_session"):
                        if key in extra:
                            want[key] = extra[key]
                    changes = {k: v for k, v in want.items() if job.get(k) != v}
                    if changes:
                        jobs.update_job(job["id"], changes)
                    if switch is True and not (job.get("enabled") and job.get("state") != "paused"):
                        jobs.resume_job(job["id"])
                    elif switch is False and job.get("enabled") and job.get("state") != "paused":
                        jobs.pause_job(job["id"], reason="Off until the owner turns it on.")
                    continue
                if (paused or switch is False) or (only and routine["id"] != only):
                    continue
                if fmt == "wiki" and routine["skill"] in WIKI_SKILLS:
                    install_skill(home, vault, fmt, None, extras=True)  # its skill, before its job
                prompt, extra = _job_args(routine, fmt, home)
                jobs.create_job(prompt, routine["schedule"], name=routine["name"], deliver="command_center",
                                workdir=str(vault), **extra)
                made.append(routine["id"])
            for rid, job in existing.items():
                if rid not in wanted:
                    jobs.remove_job(job["id"])
        if made:
            logger.info("Second Brain routines created (%s%s): %s", fmt, ", off" if paused else "", ", ".join(made))
        return made
    except Exception:
        logger.warning("Second Brain routines not created", exc_info=True)
        return []


def _time_of(schedule: dict[str, Any]) -> str:
    """HH:MM of a daily or weekly cron expression ("0 22 * * *" -> "22:00"), else "" (e.g. every half hour)."""
    expr = str((schedule or {}).get("expr") or "").split()
    if len(expr) == 5 and expr[0].isdigit() and expr[1].isdigit():
        return f"{int(expr[1]):02d}:{int(expr[0]):02d}"
    return ""


def routines(profile: str = "chief") -> dict[str, Any]:
    """The routines with their state: on or off, time, next and last run."""
    home = _profile_home(profile)
    try:
        jobs = _routine_jobs(home)
    except Exception as exc:
        logger.info("routines read failed: %s", type(exc).__name__)
        jobs = {}
    vault = _env_paths(home).get("OBSIDIAN_VAULT_PATH") or ""
    fmt = _layout_of(home, Path(vault))[0] if vault and Path(vault).is_dir() else "para"
    items = []
    for routine in _routines_for(fmt):
        job = jobs.get(routine["id"])
        about = routine["about"]
        if routine["id"] == "nightly" and fmt == "wiki":
            about = "Closes the day: reconciles, links orphans, then rewrites Current Analysis."
        items.append({
            "id": routine["id"], "title": routine["title"], "about": about,
            "exists": job is not None,
            "enabled": bool(job and job.get("enabled") and job.get("state") != "paused"),
            "time": _time_of(job.get("schedule") if job else {}) or _time_of({"expr": routine["schedule"]}),
            "days": {"weekly": "Fridays", "health": "Sundays", "brief": "Weekdays", "drop": "Every 30 minutes"}.get(routine["id"], "Every day"),
            "next_run": (job or {}).get("next_run_at"), "last_run": (job or {}).get("last_run_at"),
            "last_status": (job or {}).get("last_status"),
        })
    return {"ok": True, "contract": CONTRACT, "routines": items}


_TIME = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")


def set_routine(routine_id: str, enabled: Optional[bool] = None, at: Optional[str] = None, profile: str = "chief") -> dict[str, Any]:
    """Turn a routine on or off, or move it to another time of day (same days)."""
    home = _profile_home(profile)
    routine = next((r for r in ROUTINES + WIKI_ROUTINES if r["id"] == routine_id), None)
    if routine is None:
        raise SecondBrainError("Unknown routine.")
    job = _routine_jobs(home).get(routine_id)
    if job is None:
        vault = _env_paths(home).get("OBSIDIAN_VAULT_PATH") or ""
        if not vault:
            raise SecondBrainError("Set up the Second Brain first.")
        ensure_routines(home, Path(vault), only=routine_id)
        job = _routine_jobs(home).get(routine_id)
        if job is None:
            raise SecondBrainError("That routine couldn't be created.")
    jobs, store = _cron(home)
    with store:
        if at is not None and not _time_of({"expr": routine["schedule"]}):
            raise SecondBrainError("That routine runs every half hour; it has no time of day.")
        if at is not None:
            m = _TIME.match(str(at).strip())
            if not m:
                raise SecondBrainError("Use a time like 08:30.")
            parts = routine["schedule"].split()
            parts[0], parts[1] = str(int(m.group(2))), str(int(m.group(1)))
            jobs.update_job(job["id"], {"schedule": " ".join(parts)})
        if enabled is True:
            jobs.resume_job(job["id"])
        elif enabled is False:
            jobs.pause_job(job["id"], reason="Turned off in the app.")
    return routines(profile)


# ---------------------------------------------------------------- upgrade


def upgrade(profile: str = "chief") -> dict[str, Any]:
    """Bring a Second Brain set up by an earlier version up to this one: files the template now has
    (create-only), the Folder Map in an app-made `AGENTS.md` that lacks one, the skills, auto-load and
    the routines. Nothing the owner wrote is changed."""
    home = _profile_home(profile)
    state = _read_state(home)
    vault = Path(state.get("path") or _env_paths(home).get("OBSIDIAN_VAULT_PATH") or "")
    if not str(vault) or not vault.is_dir():
        return {"ok": True, "upgraded": False}
    done: list[str] = []
    if adopted() and not state.get("path"):
        # Taken over from an existing install: the vault keeps its own rules and its owner's routines.
        rules = manual(vault)
        fmt = detect_format(vault, rules) or "para"
        state = {"path": str(vault), "mode": "keep", "format": fmt, "rules": rules or RULES_FILE[fmt], "own_rules": bool(rules),
                 "routines_off": True, "adopted": True, "template": TEMPLATE_VERSION if fmt == "para" else _manifest(fmt).get("version", 1),
                 "set_up_at": time.strftime("%Y-%m-%dT%H:%M:%S")}
        _state_path(home).write_text(json.dumps(state, indent=2), encoding="utf-8")  # the skills read it
    if not state.get("format"):
        # Set up before formats existed: the app made PARA folders, or the owner's own folder was kept.
        rules = manual(vault)
        fmt = _ours(vault) or ("para" if state.get("mode") == "new" else detect_format(vault, rules)) or "para"
        state.update({"format": fmt, "rules": rules or RULES_FILE[fmt]})
    fmt = _format(state.get("format"))
    if fmt == "para" and int(state.get("template") or 1) < TEMPLATE_VERSION:
        mode = state.get("mode") or "keep"
        plan_mode = "new" if mode == "new" else "keep"
        folders, files = _plan(plan_mode)
        layout = _LAYOUT_NEW if plan_mode == "new" else _LAYOUT_KEEP
        foldermap = _FOLDERMAP_NEW if plan_mode == "new" else _FOLDERMAP_KEEP
        for folder in folders:
            if not (vault / folder).is_dir():
                (vault / folder).mkdir(parents=True, exist_ok=True)
                done.append(folder + "/")
        for rel in files:
            if rel == "AGENTS.md" or rel.startswith("Templates/"):
                continue
            text = _render((TEMPLATE / "files" / rel).read_text(encoding="utf-8"), layout, date.today(), foldermap)
            if _write_new(vault / rel, text):
                done.append(rel)
        agents = vault / "AGENTS.md"
        if plan_mode == "new" and agents.is_file():
            current = agents.read_text(encoding="utf-8")
            if "## Folder Map" not in current:
                agents.write_text(current.rstrip("\n") + "\n\n" + foldermap + "\n", encoding="utf-8", newline="\n")
                done.append("AGENTS.md: Folder Map")
        if done:
            with open(vault / "log.md", "a", encoding="utf-8", newline="\n") as log:
                log.write(f"- {date.today().isoformat()} — Second Brain updated by the app: {', '.join(done)} — whole folder\n")
    _configure(home, vault, fmt, state.get("rules") or RULES_FILE[fmt])
    try:
        if seed_soul(profile).get("seeded"):
            done.append("SOUL: the current default (the earlier one was unedited)")
    except Exception:
        logger.debug("SOUL refresh skipped", exc_info=True)
    made = ensure_routines(home, vault, fmt, paused=bool(state.get("routines_off")))
    if not adopted():
        _share_with_team(profile)  # an adopted install's bots keep their own setup; new bots get it when minted
    state.update({"template": TEMPLATE_VERSION if fmt == "para" else _manifest(fmt).get("version", 1),
                  "routines": sorted(set((state.get("routines") or []) + made))})
    _state_path(home).write_text(json.dumps(state, indent=2), encoding="utf-8")
    if done or made:
        logger.info("Second Brain upgraded: %s; routines %s", ", ".join(done) or "nothing in the folder", ", ".join(made) or "unchanged")
    return {"ok": True, "upgraded": bool(done or made), "changed": done, "routines": made}


def setup(raw_path: str, mode: str, profile: str = "chief", today: Optional[date] = None, fmt: Optional[str] = None,
          routines_on: Optional[bool] = None) -> dict[str, Any]:
    """Set up the folder in a format (default: what it already uses, else PARA). A folder with its own rules file
    gets nothing added. `routines_on` defaults to on, except for a folder with its own rules file."""
    mode = str(mode or "").strip().lower()
    if mode not in MODES:
        raise SecondBrainError("Choose how to set up the folder.")
    if fmt is not None and str(fmt).strip().lower() not in FORMATS:
        raise SecondBrainError("Choose a format: Organized (PARA) or Agent-first wiki.")
    home = _profile_home(profile)
    found = inspect(raw_path, fmt)
    fmt = found["format"]
    path = Path(found["path"])
    if mode not in found["choices"]:
        if mode == "new":
            raise SecondBrainError("This folder already has notes. Choose to keep its folders or to reorganize it.")
        raise SecondBrainError("This folder is empty; set it up as a new Second Brain.")
    if not found["writable"]:
        raise SecondBrainError("Chief can't write to that folder. Choose another one.")

    own_rules = found["manual"] if mode != "new" else ""
    plan_mode = "new" if mode == "new" else "keep"
    folders, files = ([], []) if own_rules else _plan(plan_mode, fmt)
    if fmt == "wiki":
        layout, foldermap = ("" if plan_mode == "new" else _WIKI_LAYOUT_KEEP), ""
    else:
        layout = _LAYOUT_NEW if plan_mode == "new" else _LAYOUT_KEEP
        foldermap = _FOLDERMAP_NEW if plan_mode == "new" else _FOLDERMAP_KEEP
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
        source = TEMPLATES[fmt] / "files" / rel
        text = _render(source.read_text(encoding="utf-8"), layout, today, foldermap)
        (created if _write_new(path / rel, text) else kept).append(rel)

    rules = own_rules or manual(path) or RULES_FILE[fmt]
    routines_on = (not own_rules) if routines_on is None else bool(routines_on)
    state = {"path": str(path), "mode": mode, "format": fmt, "rules": rules, "own_rules": bool(own_rules),
             "template": TEMPLATE_VERSION if fmt == "para" else _manifest(fmt).get("version", 1),
             "set_up_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "created": created, "routines_off": not routines_on}
    _state_path(home).write_text(json.dumps(state, indent=2), encoding="utf-8")
    _configure(home, path, fmt, rules)
    routines_made = ensure_routines(home, path, fmt, paused=not routines_on, switch=routines_on)
    state["routines"] = routines_made
    _state_path(home).write_text(json.dumps(state, indent=2), encoding="utf-8")
    logger.info("Second Brain set up (%s, %s%s): %d created, %d kept", fmt, mode, ", its own rules" if own_rules else "",
                len(created), len(kept))
    if own_rules:
        prompt = _ADOPT_PROMPT.format(rules=rules)
    elif mode == "keep":
        prompt = _KEEP_PROMPT_WIKI if fmt == "wiki" else _KEEP_PROMPT
    else:
        prompt = (_REORGANIZE_PROMPT_WIKI if fmt == "wiki" else _REORGANIZE_PROMPT) if mode == "reorganize" else ""
    return {"ok": True, "path": str(path), "mode": mode, "format": fmt, "rules": rules, "own_rules": bool(own_rules),
            "routines_on": routines_on, "created": created, "kept": kept, "next_prompt": prompt}


# ---------------------------------------------------------------- default persona


# Chief's earlier default SOULs (sha256 of the text, stripped, LF line ends). One of these, unedited, is
# replaced by the current default; a SOUL anyone has edited is never touched.
_PREVIOUS_DEFAULT_SOULS = {
    "c69ef243f159f69442343365723c3a7cf2fec92b69f4a0142e8b1a1dba9859f0",
    "c1bda779469c8ee9c367140a90a24c2f06c8db17c1b1993c483dfc54e323b221",
    "571eb5c010cb979760c09ee7439a852a2aeaf6389927f57da862d6995169e0c7",
}
# The digest of second_brain/SOUL.md as shipped. When that file changes, move this value into
# _PREVIOUS_DEFAULT_SOULS and put the new digest here (a unit test fails until you do).
CURRENT_DEFAULT_SOUL = "baf865d79b735d58784d1989f1024c1852f7755fc671c86e3de226d70240fa88"


def _soul_digest(text: str) -> str:
    import hashlib

    return hashlib.sha256(text.replace("\r\n", "\n").strip().encode("utf-8")).hexdigest()


def seed_soul(profile: str = "chief") -> dict[str, Any]:
    """Replace Hermes's untouched stock SOUL, or an unedited earlier default of Chief's, with Chief's
    current default. Anything else is left alone."""
    home = _profile_home(profile)
    soul = home / "SOUL.md"
    try:
        current = soul.read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        current = ""
    from hermes_cli.default_soul import DEFAULT_SOUL_MD, _normalize_soul, is_legacy_template_soul

    stock = not current.strip() or _normalize_soul(current) == _normalize_soul(DEFAULT_SOUL_MD) or is_legacy_template_soul(current)
    stock = stock or _soul_digest(current) in _PREVIOUS_DEFAULT_SOULS
    if not stock or _soul_digest(current) == _soul_digest(SOUL_SOURCE.read_text(encoding="utf-8")):
        return {"ok": True, "seeded": False}
    result = persona.write_soul(profile, SOUL_SOURCE.read_text(encoding="utf-8"), persona._hash(current))
    return {"ok": bool(result.get("ok")), "seeded": bool(result.get("ok"))}
