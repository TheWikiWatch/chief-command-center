"""Read-only preflight for adopting an existing Hermes install into the app (PLAN §5 "Existing install", step 1).

    python packaging/migrate/preflight.py [--hermes-root <dir>] --report <file.md outside the repo>

Changes nothing: it reads files, lists processes and scheduled tasks, and probes ports. The report names
personal paths, so it must stay outside the repository.

It covers:
- Profiles, their sizes and the databases a backup must capture.
- Disk space on the drives involved, against the backup size.
- The launchers in play: scheduled tasks, Startup scripts, and processes running from the install.
- Ports 3000/7790/8790/3900 and who holds them.
- User plugin copies that the app's bundled plugins would replace.
- Absolute paths in config, routines and skills that must keep working in place.
- Whether the live gateway answers.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import socket
import subprocess
import urllib.error
import urllib.request
from pathlib import Path

APP_PLUGINS = {"chief-dashboard-bridge", "command-center", "voicestudio-tts"}
PORTS = {3000: "dashboard", 7790: "chief bridge", 8790: "Ops API", 3900: "VoiceStudio"}
SKIP_SIZE = {"cache", "image_cache", "audio_cache", "logs", "models", "node_modules", "__pycache__", "hermes-agent", "tools", "venv", "pm-runtime", "uv-cache", "crash-dumps"}


def size_of(path: Path, skip: set[str] = SKIP_SIZE) -> int:
    total = 0
    for current, dirs, files in os.walk(path):
        dirs[:] = [d for d in dirs if d not in skip]
        for name in files:
            try:
                total += os.path.getsize(os.path.join(current, name))
            except OSError:
                pass
    return total


def gb(n: float) -> str:
    return f"{n / 1e9:.1f} GB"


def run(cmd: list[str]) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60).stdout
    except (OSError, subprocess.TimeoutExpired):
        return ""


def port_listening(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hermes-root", default=os.path.join(os.environ.get("LOCALAPPDATA", ""), "hermes"))
    parser.add_argument("--report", required=True)
    args = parser.parse_args()
    root = Path(args.hermes_root)
    report = Path(args.report).resolve()
    repo = Path(__file__).resolve().parents[2]
    if repo in report.parents:
        raise SystemExit("Write the report outside the repository: it names personal paths.")
    out: list[str] = ["# Migration preflight (read-only)", "", f"Hermes root: `{root}`", ""]
    if not root.is_dir():
        out.append("No Hermes install found there.")
        report.write_text("\n".join(out), encoding="utf-8")
        return 1

    # Profiles and data
    profiles = sorted(p for p in (root / "profiles").iterdir() if p.is_dir()) if (root / "profiles").is_dir() else []
    out += ["## Profiles and data", "", "| Profile | Data (excl. caches, logs, models) | Databases |", "| --- | --- | --- |"]
    total = size_of(root, SKIP_SIZE | {"profiles"})
    for prof in profiles:
        n = size_of(prof)
        total += n
        dbs = ", ".join(sorted(p.name for p in prof.glob("*.db")))
        out.append(f"| {prof.name} | {gb(n)} | {dbs or '—'} |")
    big = []
    for child in sorted(root.iterdir()):
        if child.is_dir() and child.name not in SKIP_SIZE and child.name != "profiles":
            n = size_of(child)
            if n > 100e6:
                big.append(f"`{child.name}` {gb(n)}")
    dumps = root / "crash-dumps"
    if dumps.is_dir():
        big.append(f"(not backed up: `crash-dumps` {gb(size_of(dumps, set()))})")
    if big:
        out += ["", f"Largest top-level folders: {', '.join(big)}."]
    root_dbs = ", ".join(sorted(p.name for p in root.glob("*.db")))
    out += ["", f"Root databases: {root_dbs or 'none'}. Estimated backup (before compression): **{gb(total)}**.", ""]

    # Disk space
    out += ["## Disk space", "", "| Drive | Free | Enough for a backup? |", "| --- | --- | --- |"]
    for drive in sorted({root.drive or "C:", "C:", "E:"}):
        try:
            free = shutil.disk_usage(drive + "\\").free
        except OSError:
            continue
        out.append(f"| {drive} | {gb(free)} | {'yes' if free > total * 1.5 + 5e9 else 'tight'} |")
    out.append("")

    # Launchers
    out += ["## Launchers and supervision", ""]
    tasks = run(["schtasks", "/Query", "/FO", "CSV", "/NH"])
    hermes_tasks = sorted({line.split(",")[0].strip('"') for line in tasks.splitlines() if re.search(r"hermes|chief|fleet", line, re.I)})
    out += [f"- Scheduled tasks: {', '.join(f'`{t}`' for t in hermes_tasks) or 'none'} (disabled with consent at migration; restorable)."]
    startup = Path(os.environ.get("APPDATA", "")) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"
    vbs = sorted(p.name for p in startup.glob("*") if re.search(r"hermes|chief|chief|fleet|gateway", p.name, re.I)) if startup.is_dir() else []
    out += [f"- Startup items: {', '.join(f'`{v}`' for v in vbs) or 'none'}."]
    procs = run(["powershell", "-NoProfile", "-Command",
                 "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.ExecutablePath } | Select-Object ProcessId, ExecutablePath, CommandLine | ConvertTo-Json -Compress"])
    try:
        rows = json.loads(procs) if procs.strip() else []
        rows = rows if isinstance(rows, list) else [rows]
    except ValueError:
        rows = []
    root_s = str(root).lower()
    users = [r for r in rows if root_s in str(r.get("ExecutablePath", "")).lower() or root_s in str(r.get("CommandLine", "")).lower()]
    out += [f"- Processes running from this install: **{len(users)}**"]
    for r in users[:25]:
        cmd = re.sub(r"\s+", " ", str(r.get("CommandLine", "")))[:160]
        out.append(f"  - {r.get('ProcessId')}: `{cmd}`")
    out.append("")

    # Ports
    out += ["## Ports", "", "| Port | Role | Listening |", "| --- | --- | --- |"]
    for port, role in PORTS.items():
        out.append(f"| {port} | {role} | {'yes' if port_listening(port) else 'no'} |")
    try:
        urllib.request.urlopen("http://127.0.0.1:7790/health", timeout=3)
        health = "answered without a token (unexpected)"
    except urllib.error.HTTPError as exc:
        health = "up (401 without the token, as expected)" if exc.code == 401 else f"HTTP {exc.code}"
    except OSError:
        health = "not answering"
    out += ["", f"Chief bridge: {health}.", ""]

    # Plugins
    out += ["## Plugin copies the app's bundled plugins replace", ""]
    for plugins_dir in [root / "plugins", *(p / "plugins" for p in profiles)]:
        if plugins_dir.is_dir():
            for plug in sorted(d for d in plugins_dir.iterdir() if d.is_dir()):
                mark = "replaced (moved into the migration backup)" if plug.name in APP_PLUGINS else "kept (user plugin)"
                out.append(f"- `{plug.relative_to(root)}`: {mark}")
    out.append("")

    # Absolute paths that must keep working in place
    out += ["## Absolute paths in config, routines and skills", "", "Adoption keeps the install in place, so these stay valid. Listed for the record.", ""]
    hits = 0
    for path in list(root.glob("profiles/*/config.yaml")) + list(root.glob("profiles/*/cron/*.json")) + list(root.glob("config.yaml")):
        try:
            for number, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                if re.search(r"[A-Za-z]:\\\\|[A-Za-z]:/", line) and "key" not in line.lower():
                    hits += 1
                    if hits <= 40:
                        out.append(f"- `{path.relative_to(root)}:{number}`: `{line.strip()[:140]}`")
        except OSError:
            continue
    env_keys = []
    for env_file in root.glob("profiles/*/.env"):
        for line in env_file.read_text(encoding="utf-8", errors="replace").splitlines():
            m = re.match(r"\s*([A-Z_][A-Z0-9_]*)\s*=", line)
            if m and m.group(1) in {"HERMES_BIN", "OBSIDIAN_VAULT_PATH", "WIKI_PATH", "CHIEF_DASHBOARD_PORT", "COMMAND_CENTER_HOME_CHANNEL"}:
                env_keys.append(f"{env_file.parent.name}: {m.group(1)}")
    out += ["", f"{hits} path line(s) found. Path-type settings in profile .env files (names only): {', '.join(env_keys) or 'none'}.", ""]
    out += ["## What migration would change (not done by this preflight)", "",
            "1. A full backup (Settings → Backup & restore engine), to a folder you choose.",
            "2. With your consent: disable the gateway guard task and the Startup launcher (both restorable).",
            "3. Move the app-owned plugin copies listed above into the backup; the bundled versions take over.",
            "4. `HERMES_BIN` → the app's payload launcher; the bridge token → DPAPI (same value, so phones stay authorized).",
            "5. The app supervises Chief with `sharedGatewayLock` and `hermesRoot` pointing here; ports unchanged.",
            "6. Verify, with a journal to replay backwards for rollback."]
    report.write_text("\n".join(out) + "\n", encoding="utf-8")
    print(f"report: {report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
