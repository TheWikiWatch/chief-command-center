"""Prepare a Hermes profile for the app, idempotently, through Hermes's own config code.

Run by the desktop app with the payload's Python, HERMES_HOME set to the profile folder:

    python provision.py --plugins-src <dir> --bridge-port 7790 [--plugin chief-dashboard-bridge]

- Copies each bundled plugin into the profile's `plugins/` when its files differ (a `.token` file there is kept).
  Hermes's own override for bundled plugins would replace upstream's whole plugins folder, so the app's
  plugins are user plugins that the app keeps current.
- Enables them in config.yaml, with gateway injection allowed (the bridge's chat platform needs it).
- Sets the bridge port and turns on the Command Center platform in the profile .env.

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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plugins-src", required=True)
    parser.add_argument("--bridge-port", type=int, required=True)
    parser.add_argument("--plugin", action="append", default=[])
    args = parser.parse_args()
    home = Path(os.environ["HERMES_HOME"])
    home.mkdir(parents=True, exist_ok=True)
    names = args.plugin or ["chief-dashboard-bridge"]
    changed: list[str] = []

    for name in names:
        if sync_plugin(Path(args.plugins_src) / name, home / "plugins" / name):
            changed.append(f"plugin {name}")

    from cli import save_config_value
    from hermes_cli.config import load_config, load_env, save_env_value

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

    env = load_env()
    for key, value in (("COMMAND_CENTER_ENABLED", "true"), ("COMMAND_CENTER_ALLOW_ALL_USERS", "true"), ("CHIEF_DASHBOARD_PORT", str(args.bridge_port))):
        if env.get(key) != value:
            save_env_value(key, value)
            changed.append(key)

    print(json.dumps({"ok": True, "changed": changed}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # the app shows this; never a traceback with paths or values
        print(json.dumps({"ok": False, "error": f"Preparing Hermes failed ({type(exc).__name__}: {str(exc)[:200]})"}))
        sys.exit(1)
