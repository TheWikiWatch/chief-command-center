"""Prepare a Hermes profile for the app, idempotently, through Hermes's own config code.

Run by the desktop app with the payload's Python, HERMES_HOME set to the profile folder:

    python provision.py --plugins-src <dir> --bridge-port 7790 [--plugin chief-dashboard-bridge]

- Copies each bundled plugin into the profile's `plugins/` when its files differ (a `.token` file there is kept).
  Hermes's own override for bundled plugins would replace upstream's whole plugins folder, so the app's
  plugins are user plugins that the app keeps current.
- Enables them in config.yaml, with gateway injection allowed (the bridge's chat platform needs it).
- Sets the bridge port, turns on the Command Center platform and makes the owner's chat its home channel
  (where scheduled jobs and notices go) in the profile .env.
- Stamps a new profile's config with Hermes's current schema version before writing anything else.
- Marks the profile's gateway as standalone (`gateway.standalone: true`): the app runs it, and Hermes otherwise
  refuses a named profile's own gateway on a PC where no Hermes launcher is registered for that profile.
- Gives the chief twice Hermes's default memory (4400 / 2750 characters) unless the owner set their own.
- Gives the chief the `kanban` toolset (delegating to workers) and the bridge's `fleet` toolset (mint, re-pin,
  retire and restore workers), and, unless the owner chose otherwise,
  `display.busy_input_mode: steer`, so a message sent while the chief works is added to that work instead of
  stopping it.

Prints one JSON object: {"ok": true, "changed": [...]}.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

_SKIP = {"__pycache__", ".token"}


def _digest(folder: Path) -> str:
    h = hashlib.sha256()
    if not folder.is_dir():
        return ""
    for path in sorted(p for p in folder.rglob("*") if p.is_file() and not (_SKIP & set(p.relative_to(folder).parts))):
        h.update(path.relative_to(folder).as_posix().encode())
        h.update(path.read_bytes())
    return h.hexdigest()


def sync_plugin(src: Path, dst: Path) -> bool:
    if _digest(src) == _digest(dst):
        return False
    staging = dst.with_name(dst.name + ".updating")
    shutil.rmtree(staging, ignore_errors=True)
    shutil.copytree(src, staging, ignore=shutil.ignore_patterns("__pycache__", ".token"))
    token = dst / ".token"
    if token.is_file():
        shutil.copy2(token, staging / ".token")
    old = dst.with_name(dst.name + ".old")
    shutil.rmtree(old, ignore_errors=True)
    if dst.exists():
        os.replace(dst, old)
    os.replace(staging, dst)
    shutil.rmtree(old, ignore_errors=True)
    return True


def _same_named(name: str, roots: list[Path], target: Path) -> bool:
    """A skill with this name somewhere else in these skill folders (the owner's, at another path)."""
    for root in roots:
        if root.is_dir() and any(p.resolve() != target.resolve() for p in root.rglob(f"{name}/SKILL.md")):
            return True
    return False


def install_bundled_skills(src: Path, dest: Path, external: list[Path] | None = None) -> list[str]:
    """Install the app's skills into the chief's profile. A skill the app installed earlier is updated only if
    the owner hasn't edited it; a same-named skill the app didn't install is never touched, at this path or any
    other in the profile's skills or its `skills.external_dirs` (it would be shadowed or duplicated)."""
    if not src.is_dir():
        return []
    record_path = dest / ".chief-bundled.json"
    try:
        record = json.loads(record_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        record = {}
    changed = []
    for skill in sorted(src.glob("*/*/SKILL.md")):
        rel = skill.relative_to(src).as_posix()
        target = dest / rel
        new = skill.read_text(encoding="utf-8")
        new_hash = hashlib.sha256(new.encode("utf-8")).hexdigest()
        if target.exists():
            current = hashlib.sha256(target.read_bytes()).hexdigest()
            if current == new_hash:
                record[rel] = new_hash
                continue
            if record.get(rel) != current:
                continue  # the owner's own skill, or edited by the owner: keep it
        elif _same_named(skill.parent.name, [dest, *(external or [])], target):
            continue  # the owner has a skill of this name elsewhere: theirs stays the only one
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(new, encoding="utf-8", newline="\n")
        record[rel] = new_hash
        changed.append(f"skill {skill.parent.name}")
    dest.mkdir(parents=True, exist_ok=True)
    record_path.write_text(json.dumps(record, indent=2), encoding="utf-8")
    return changed


TOOLKIT = "obsidian-second-brain"


def external_skill_dirs(home: Path) -> list[Path]:
    try:
        import yaml

        config = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8")) or {}
    except (OSError, ValueError):
        return []
    skills = config.get("skills") if isinstance(config.get("skills"), dict) else {}
    return [Path(str(d)) for d in skills.get("external_dirs") or []]


def owner_toolkit(home: Path) -> Path | None:
    """An adopted install's own copy of the toolkit, in one of its `skills.external_dirs` (a profile copy would
    shadow it, skill by skill, with a different version). None when it has none."""
    try:
        import yaml

        config = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8")) or {}
    except (OSError, ValueError):
        return None
    skills = config.get("skills") if isinstance(config.get("skills"), dict) else {}
    for folder in skills.get("external_dirs") or []:
        candidate = Path(str(folder)) / TOOLKIT
        if candidate.is_dir():
            return candidate
    return None
_UPSTREAM_ROOT = "$HOME/.hermes/skills/obsidian-second-brain"
_TILDE_ROOT = "~/.hermes/skills/obsidian-second-brain"


def _toolkit_layout(src: Path) -> list[tuple[Path, str]]:
    """(source file, path under the install root): skills and the routine blueprints at the root (as the
    toolkit's INSTALL.md lays them out), references and scripts beside them, plus its licence and notices."""
    out: list[tuple[Path, str]] = []
    for base in (src / "skills", src / "optional-skills"):
        for f in sorted(p for p in base.rglob("*") if p.is_file()):
            out.append((f, f.relative_to(base).as_posix()))
    for sub in ("references", "scripts"):
        for f in sorted(p for p in (src / sub).rglob("*") if p.is_file() and "__pycache__" not in p.parts):
            out.append((f, f"{sub}/{f.relative_to(src / sub).as_posix()}"))
    for name in ("LICENSE", "NOTICE.md", "vendor.json", "pyproject.toml"):
        if (src / name).is_file():
            out.append((src / name, name))
    return out


def _toolkit_text(text: str, root: str, python: str, pythonpath: str) -> str:
    """Point the toolkit at its real install folder, and run its helper scripts on the app's own Python
    (its standard-library scripts need nothing else) instead of `uv`, which would download packages."""
    import re

    head = r'uv run --directory "?' + re.escape(_UPSTREAM_ROOT) + r'"?'
    env = f'PYTHONPATH="{pythonpath}" "{python}"'
    text = re.sub(head + r'(?: python)? scripts/([\w./-]+\.py)', lambda m: f'{env} "{root}/scripts/{m.group(1)}"', text)
    text = re.sub(head + r' python -c ', lambda m: f'{env} -c ', text)
    return text.replace(_UPSTREAM_ROOT, root).replace(_TILDE_ROOT, root)


def install_toolkit(src: Path, dest: Path, python: str, pythonpath: str) -> list[str]:
    """Install the vendored Second Brain toolkit into `<profile>/skills/obsidian-second-brain`. Like the
    app's skills: a file the app installed earlier is updated only if the owner hasn't edited it."""
    if not (src / "vendor.json").is_file():
        return []
    root = dest.as_posix()
    record_path = dest / ".chief-bundled.json"
    try:
        record = json.loads(record_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        record = {}
    changed = 0
    for source, rel in _toolkit_layout(src):
        target = dest / rel
        data = source.read_bytes()
        if source.suffix in (".md", ".sh", ".yaml", ".toml"):
            data = _toolkit_text(data.decode("utf-8"), root, python.replace("\\", "/"), pythonpath).encode("utf-8")
        new_hash = hashlib.sha256(data).hexdigest()
        if target.exists():
            current = hashlib.sha256(target.read_bytes()).hexdigest()
            if current == new_hash:
                record[rel] = new_hash
                continue
            if record.get(rel) != current:
                continue  # edited by the owner: keep it
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        record[rel] = new_hash
        changed += 1
    dest.mkdir(parents=True, exist_ok=True)
    record_path.write_text(json.dumps(record, indent=2), encoding="utf-8")
    version = json.loads((src / "vendor.json").read_text(encoding="utf-8")).get("version", "")
    return [f"{TOOLKIT} {version}: {changed} files"] if changed else []


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plugins-src", required=True)
    parser.add_argument("--bridge-port", type=int, required=True)
    parser.add_argument("--plugin", action="append", default=[])
    parser.add_argument("--skills-src", default="", help="bundled skills (default: <plugins-src>/chief-dashboard-bridge/skills)")
    parser.add_argument("--vendor-src", default="", help="the vendored Second Brain toolkit (default: <plugins-src>/../vendor/obsidian-second-brain)")
    parser.add_argument("--adopted", action="store_true",
                        help="an existing install the app took over: its own copy of the toolkit is kept, not shadowed")
    args = parser.parse_args()
    home = Path(os.environ["HERMES_HOME"])
    home.mkdir(parents=True, exist_ok=True)
    names = args.plugin or ["chief-dashboard-bridge"]
    changed: list[str] = []

    for name in names:
        if sync_plugin(Path(args.plugins_src) / name, home / "plugins" / name):
            changed.append(f"plugin {name}")

    skills_src = Path(args.skills_src) if args.skills_src else Path(args.plugins_src) / "chief-dashboard-bridge" / "skills"
    changed += install_bundled_skills(skills_src, home / "skills", external_skill_dirs(home))
    vendor = Path(args.vendor_src) if args.vendor_src else Path(args.plugins_src).parent / "vendor" / TOOLKIT
    pythonpath = os.environ.get("PYTHONPATH") or os.pathsep.join(p for p in sys.path if p.endswith("site-packages"))
    own_toolkit = owner_toolkit(home) if args.adopted else None
    if own_toolkit is None:
        changed += install_toolkit(vendor, home / "skills" / TOOLKIT, sys.executable, pythonpath.replace("\\", "/"))

    from cli import save_config_value
    from hermes_cli.config import load_config, load_env, save_env_value
    from hermes_cli.config_defaults import DEFAULT_CONFIG

    # A new profile: stamp the current schema version before writing anything, or Hermes's start-up
    # migration reads the file as pre-version-12 and skips (it did on the first 0.1.1 start).
    if not (home / "config.yaml").exists():
        save_config_value("_config_version", DEFAULT_CONFIG["_config_version"])
        changed.append("config version")

    config = load_config() or {}
    plugins = config.get("plugins") if isinstance(config.get("plugins"), dict) else {}
    enabled = list(plugins.get("enabled") or [])
    for name in names:
        if name not in enabled:
            enabled.append(name)
            changed.append(f"enabled {name}")
    if enabled != list(plugins.get("enabled") or []):
        save_config_value("plugins.enabled", enabled)
    entries = plugins.get("entries") if isinstance(plugins.get("entries"), dict) else {}
    for name in names:
        entry = entries.get(name) if isinstance(entries.get(name), dict) else {}
        if entry.get("allow_gateway_injection") is not True:
            save_config_value(f"plugins.entries.{name}.allow_gateway_injection", True)
            changed.append(f"{name} gateway injection")
        if "allow_tool_override" not in entry:
            save_config_value(f"plugins.entries.{name}.allow_tool_override", False)

    toolsets = list(config.get("toolsets") or ["hermes-cli"])
    added = [t for t in ("kanban", "fleet") if t not in toolsets]
    if added:
        save_config_value("toolsets", toolsets + added)
        changed.append("toolsets: " + ", ".join(added))
    # load_config() merges Hermes's defaults in, so read the file itself to see what the owner actually set.
    try:
        import yaml

        raw = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8")) or {}
    except (OSError, ValueError):
        raw = {}
    # The app runs one gateway of its own for this profile. Hermes refuses a named profile's gateway unless a
    # launcher for it is registered on this Windows account (a per-user check, not per install) or the profile
    # opts out of the host multiplexer: `gateway.standalone: true`, Hermes's documented opt-out.
    gateway = raw.get("gateway") if isinstance(raw.get("gateway"), dict) else {}
    if gateway.get("standalone") is not True:
        save_config_value("gateway.standalone", True)
        changed.append("gateway: standalone")
    display = raw.get("display") if isinstance(raw.get("display"), dict) else {}
    if not display.get("busy_input_mode"):
        save_config_value("display.busy_input_mode", "steer")
        changed.append("busy input: steer")
    # The chief carries more than a single-job bot: twice Hermes's default memory, unless the owner chose.
    memory = raw.get("memory") if isinstance(raw.get("memory"), dict) else {}
    for key, value in (("memory_char_limit", 4400), ("user_char_limit", 2750)):
        if key not in memory:
            save_config_value(f"memory.{key}", value)
            changed.append(f"memory.{key}")

    env = load_env()
    for key, value in (("COMMAND_CENTER_ENABLED", "true"), ("COMMAND_CENTER_ALLOW_ALL_USERS", "true"), ("CHIEF_DASHBOARD_PORT", str(args.bridge_port))):
        if env.get(key) != value:
            save_env_value(key, value)
            changed.append(key)
    # The owner's chat is the home channel: scheduled-job results and gateway notices go there.
    if not env.get("COMMAND_CENTER_HOME_CHANNEL"):
        save_env_value("COMMAND_CENTER_HOME_CHANNEL", "owner")
        changed.append("COMMAND_CENTER_HOME_CHANNEL")

    print(json.dumps({"ok": True, "changed": changed}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # the app shows this; never a traceback with paths or values
        print(json.dumps({"ok": False, "error": f"Preparing Hermes failed ({type(exc).__name__}: {str(exc)[:200]})"}))
        sys.exit(1)
