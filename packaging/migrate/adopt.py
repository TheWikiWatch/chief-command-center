"""Hand an existing Hermes install over to the installed Chief Command Center app (PLAN §5 "Existing install").

    python packaging/migrate/adopt.py --plan     --backup-dir <dir>   # what would happen; changes nothing
    python packaging/migrate/adopt.py --apply    --backup-dir <dir>   # do it (journaled)
    python packaging/migrate/adopt.py --verify   --backup-dir <dir>   # check the app runs the adopted Chief
    python packaging/migrate/adopt.py --rollback --backup-dir <dir>   # undo, from the journal

The install stays where it is (profiles, conversations, memory, SOUL, skills, routines, bots, paths all keep
working); the app supervises its gateway instead of the old launchers. Steps, each recorded with its inverse in
`<backup-dir>\\journal.json`:

1. Refuse while Chief is working, a question or an approval is open, or a worker runs (unless --even-if-busy).
2. Stop the installed app (its own small home is left as it is).
3. Disable the scheduled tasks and rename the Startup items that start this profile's gateway.
4. Stop the old dashboard on the UI port and the old gateway (Hermes's planned-stop marker, scoped to its pid;
   never `hermes gateway stop`, which is machine-wide on Windows).
5. Back up the install (everything but caches, logs, crash dumps and the Hermes checkout) and the app's settings.
6. Move the old `command-center` plugin aside (the app's bridge registers that platform itself) and take it out
   of `plugins.enabled`. The bridge plugin itself is replaced by the app at start; the backup keeps the old one.
7. Hand the bridge token to the app (phones and scripts stay authorized), point the app at the install
   (`hermesRoot`, shared gateway lock, the owner's PATH, the old ports, `adopted`), and start it.

Rollback stops the app, restores the app's settings and the profile files the app changed (config.yaml, .env,
the bridge plugin) from the backup, removes what the app added, puts the plugin and launchers back, and lets the
old guard start the old gateway again. The old dashboard is restarted with the command line it had.

Personal paths stay out of the repo: everything is found at run time or passed as arguments.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "upstream"))
from compat import Payload  # noqa: E402

APP_PACKAGE = "ChiefCommandCenter"
APP_EXE = "Chief Command Center.exe"
MIN_APP = (0, 1, 8)  # the first version that runs an adopted install (desktop.json `adopted`, provision --adopted)
EXCLUDE_DIRS = ["crash-dumps", "hermes-agent", "tools", "cache", "image_cache", "audio_cache", "logs", "models",
                "node_modules", "__pycache__", "pm-runtime", "uv-cache", ".deleted", "lsp"]


# ---------------------------------------------------------------- small helpers


def ps(script: str, timeout: int = 120) -> str:
    out = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], capture_output=True,
                         text=True, encoding="utf-8", errors="replace", timeout=timeout)
    if out.returncode:
        raise RuntimeError(f"PowerShell failed: {out.stderr.strip()[:500]}")
    return out.stdout.strip()


def ps_json(script: str) -> list[dict]:
    raw = ps(f"@({script}) | ConvertTo-Json -Depth 4 -Compress")
    if not raw:
        return []
    value = json.loads(raw)
    return value if isinstance(value, list) else [value]


def http_json(url: str, token: str = "", timeout: float = 5) -> dict:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"} if token else {})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read())


def say(line: str) -> None:
    print(line, flush=True)


class Journal:
    def __init__(self, folder: Path):
        self.file = folder / "journal.json"
        self.steps: list[dict] = json.loads(self.file.read_text(encoding="utf-8"))["steps"] if self.file.is_file() else []

    def add(self, kind: str, **undo) -> None:
        self.steps.append({"kind": kind, "at": time.strftime("%Y-%m-%dT%H:%M:%S"), **undo})
        self.file.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.file.with_suffix(".tmp")
        tmp.write_text(json.dumps({"steps": self.steps}, indent=2), encoding="utf-8")
        os.replace(tmp, self.file)


# ---------------------------------------------------------------- what is there


class Install:
    def __init__(self, args):
        self.root = Path(args.hermes_root)
        self.profile = self.root / "profiles" / args.profile
        self.profile_name = args.profile
        self.backup = Path(args.backup_dir)
        self.ui_port, self.bridge_port = args.ui_port, args.bridge_port
        self.app_data = Path(os.environ["LOCALAPPDATA"]) / APP_PACKAGE
        self.desktop_json = self.app_data / "app" / "desktop.json"
        self.args = args

    def package(self) -> dict:
        found = ps_json(f"Get-AppxPackage -Name {APP_PACKAGE} | Select-Object Version, InstallLocation, PackageFamilyName")
        if not found:
            raise SystemExit("The Chief Command Center app isn't installed for this user. Install it first.")
        return found[0]

    def require_adoption_support(self) -> None:
        version = tuple(int(x) for x in str(self.package()["Version"]).split(".")[:3])
        if version < MIN_APP:
            raise SystemExit(f"The installed app ({self.package()['Version']}) can't adopt an install yet: install "
                             f"{'.'.join(map(str, MIN_APP))} or later first.")

    def payload(self) -> Payload:
        """Hermes's own helpers (the planned-stop marker, config writes) run on a payload of the same commit. The
        installed package's can't be run from outside the app (WindowsApps), so a build payload is used."""
        if self.args.payload_dir:
            return Payload(Path(self.args.payload_dir))
        return Payload(Path(self.package()["InstallLocation"]) / "app" / "resources" / "payload")

    def token(self) -> str:
        for folder in (self.profile / "plugins" / "chief-dashboard-bridge", self.root / "plugins" / "chief-dashboard-bridge"):
            if (folder / ".token").is_file():
                return (folder / ".token").read_text(encoding="utf-8").strip()
        return ""

    def gateway_pid(self, profile_home: Path | None = None) -> int:
        try:
            pid = int(json.loads(((profile_home or self.profile) / "gateway.pid").read_text(encoding="utf-8")).get("pid") or 0)
        except (OSError, ValueError):
            return 0
        return pid if pid and ps(f"[bool](Get-Process -Id {pid} -ErrorAction SilentlyContinue)") == "True" else 0

    def guard_tasks(self) -> list[dict]:
        needle = str(self.profile / "gateway-service").replace("\\", "\\\\")
        return ps_json("Get-ScheduledTask | Where-Object { ($_.Actions | ForEach-Object { \"$($_.Execute) $($_.Arguments)\" }) -match "
                       f"'{needle}' }} | Select-Object TaskName, TaskPath, State")

    def startup_items(self) -> list[Path]:
        folder = Path(os.environ["APPDATA"]) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"
        marker = str(self.profile / "gateway-service").lower()
        out = []
        for item in folder.glob("*.vbs"):
            try:
                if marker in item.read_text(encoding="utf-8", errors="replace").lower():
                    out.append(item)
            except OSError:
                pass
        return out

    def old_dashboard(self) -> list[dict]:
        """The process on the UI port when it's the old Next dashboard, and its respawn loop (a `for /l` cmd)."""
        rows = ps_json(f"$c = Get-NetTCPConnection -LocalPort {self.ui_port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; "
                       "if ($c) { $p = Get-CimInstance Win32_Process -Filter \"ProcessId=$($c.OwningProcess)\"; "
                       "$q = Get-CimInstance Win32_Process -Filter \"ProcessId=$($p.ParentProcessId)\"; "
                       "[pscustomobject]@{pid=$p.ProcessId; cmd=$p.CommandLine; parent=$q.ProcessId; parentCmd=$q.CommandLine; cwd=''} }")
        if not rows or APP_EXE.lower() in str(rows[0].get("cmd") or "").lower() or "next" not in str(rows[0].get("cmd") or ""):
            return []
        return rows

    def app_processes(self) -> list[int]:
        return [int(r["Id"]) for r in ps_json(f"Get-Process -Name '{APP_EXE[:-4]}' -ErrorAction SilentlyContinue | Select-Object Id")]

    def busy(self) -> list[str]:
        token = self.token()
        try:
            snap = http_json(f"http://127.0.0.1:{self.bridge_port}/snapshot", token)
        except Exception as exc:  # the gateway may simply be down
            return [] if not self.gateway_pid() else [f"the bridge didn't answer ({type(exc).__name__})"]
        reasons = []
        if snap.get("generating"):
            reasons.append("Chief is working on a reply")
        if snap.get("approval"):
            reasons.append("an approval is waiting")
        if snap.get("workers"):
            reasons.append(f"{len(snap['workers'])} worker(s) running")
        return reasons


# ---------------------------------------------------------------- steps


def stop_gateway(inst: Install, pay: Payload, profile_home: Path) -> bool:
    """Hermes's planned-stop marker for this gateway's own pid, then its process tree if it lingers."""
    pid = inst.gateway_pid(profile_home)
    if not pid:
        return False
    marker = "import sys\nfrom gateway.status import write_planned_stop_marker\nsys.exit(0 if write_planned_stop_marker(int(sys.argv[1])) else 1)"
    subprocess.run([str(pay.python), "-B", "-c", marker, str(pid)], env=pay.env(HERMES_HOME=str(profile_home)), timeout=60)
    for _ in range(40):
        if not inst.gateway_pid(profile_home):
            return True
        time.sleep(1)
    subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)
    return True


def stop_app(inst: Install, pay: Payload) -> None:
    pids = inst.app_processes()
    if not pids:
        return
    current = json.loads(inst.desktop_json.read_text(encoding="utf-8")) if inst.desktop_json.is_file() else {}
    app_root = Path(current.get("hermesRoot") or inst.app_data / "hermes")
    stop_gateway(inst, pay, app_root / "profiles" / "chief")
    for pid in pids:
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)
    time.sleep(2)


def start_app(inst: Install) -> None:
    pfn = inst.package()["PackageFamilyName"]
    subprocess.Popen(["explorer.exe", f"shell:AppsFolder\\{pfn}!{APP_PACKAGE}"])


def set_plugin_enabled(pay: Payload, profile: Path, name: str, enabled: bool) -> bool:
    code = ("import sys\nfrom cli import save_config_value\nfrom hermes_cli.config import load_config\n"
            "name, on = sys.argv[1], sys.argv[2] == '1'\n"
            "cfg = load_config() or {}\nplugins = cfg.get('plugins') if isinstance(cfg.get('plugins'), dict) else {}\n"
            "cur = list(plugins.get('enabled') or [])\n"
            "new = (cur + [name]) if on and name not in cur else [p for p in cur if p != name] if not on else cur\n"
            "if new != cur: save_config_value('plugins.enabled', new)\nprint('changed' if new != cur else 'same')\n")
    out = subprocess.run([str(pay.python), "-B", "-c", code, name, "1" if enabled else "0"], env=pay.env(HERMES_HOME=str(profile)),
                         capture_output=True, text=True, timeout=120)
    if out.returncode:
        raise RuntimeError(out.stderr[-500:])
    return "changed" in out.stdout


def backup(inst: Install) -> Path:
    dest = inst.backup / "hermes"
    cmd = ["robocopy", str(inst.root), str(dest), "/E", "/COPY:DAT", "/DCOPY:T", "/R:1", "/W:1", "/NFL", "/NDL", "/NJH", "/NP", "/XD", *EXCLUDE_DIRS]
    code = subprocess.run(cmd, capture_output=True, text=True).returncode
    if code >= 8:
        raise RuntimeError(f"The backup copy failed (robocopy {code}).")
    if inst.desktop_json.is_file():
        (inst.backup / "app").mkdir(parents=True, exist_ok=True)
        shutil.copy2(inst.desktop_json, inst.backup / "app" / "desktop.json")
    return dest


def backup_size(root: Path) -> int:
    total = 0
    for current, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        for name in files:
            try:
                total += os.path.getsize(os.path.join(current, name))
            except OSError:
                pass
    return total


def adopted_settings(inst: Install, before: dict) -> dict:
    a = inst.args
    web_env = dict(before.get("webEnv") or {})
    web_env.update(dict(kv.split("=", 1) for kv in a.web_env))
    return {**before, "hermesRoot": str(inst.root), "sharedGatewayLock": True, "inheritUserPath": True, "adopted": True,
            "ports": {"ui": inst.ui_port, "bridge": inst.bridge_port}, "learningDir": a.learning_dir or "", "learningTool": a.learning_tool or "",
            "backupDir": str(inst.backup / "app-backups"), "webEnv": web_env, "closeNoticeShown": True}


# ---------------------------------------------------------------- commands


def plan(inst: Install) -> None:
    pkg = inst.package()
    say(f"App: {APP_PACKAGE} {pkg['Version']}")
    say(f"Install: {inst.root} (profile {inst.profile_name}); gateway pid {inst.gateway_pid() or 'not running'}")
    busy = inst.busy()
    say("Chief is idle." if not busy else "Busy now: " + "; ".join(busy) + " (apply waits for idle)")
    say(f"App processes to stop: {inst.app_processes() or 'none running'}")
    for t in inst.guard_tasks():
        say(f"Disable scheduled task: {t['TaskPath']}{t['TaskName']} ({t['State']})")
    for item in inst.startup_items():
        say(f"Rename Startup item: {item.name} -> {item.name}.chief-app-off")
    for d in inst.old_dashboard():
        say(f"Stop the old dashboard on {inst.ui_port}: pid {d['pid']} and its loop pid {d['parent']}")
    cc = inst.profile / "plugins" / "command-center"
    say(f"Move aside: {cc}" if cc.is_dir() else "No old command-center plugin.")
    say(f"Back up to: {inst.backup}  (needs about {backup_size(inst.root) / 1e9:.1f} GB)")
    say(f"Bridge token handed over: {'yes' if inst.token() else 'none found (the app makes a new one)'}")
    before = json.loads(inst.desktop_json.read_text(encoding="utf-8")) if inst.desktop_json.is_file() else {}
    after = adopted_settings(inst, before)
    say("App settings: " + json.dumps({k: after[k] for k in ("hermesRoot", "sharedGatewayLock", "inheritUserPath", "adopted", "ports", "learningDir", "backupDir")}))


def apply(inst: Install) -> None:
    inst.backup.mkdir(parents=True, exist_ok=True)
    journal = Journal(inst.backup)
    if journal.steps and not inst.args.resume:
        raise SystemExit(f"{journal.file} already has steps: this backup folder was used for an earlier run. Roll it back, use a "
                         "new folder, or --resume to continue it.")
    done = {s["kind"] for s in journal.steps}
    inst.require_adoption_support()
    pay = inst.payload()
    if "gateway-stopped" not in done:  # a resumed run is past the point where Chief could be working
        for _ in range(60 if inst.args.wait_idle else 1):
            busy = [] if inst.args.even_if_busy else inst.busy()
            if not busy:
                break
            say("Waiting: " + "; ".join(busy))
            time.sleep(10)
        else:
            raise SystemExit("Chief is busy: " + "; ".join(busy) + ". Nothing was changed. Try again when he's idle.")

    say("1/8 Stopping the app…")
    stop_app(inst, pay)
    if "stopped-app" not in done:
        journal.add("stopped-app")

    say("2/8 Handing over the launchers…")
    for t in inst.guard_tasks():
        if t["State"] in (1, "Disabled"):
            continue
        ps(f"Disable-ScheduledTask -TaskPath '{t['TaskPath']}' -TaskName '{t['TaskName']}' | Out-Null")
        journal.add("task-disabled", path=t["TaskPath"], name=t["TaskName"])
    for item in inst.startup_items():
        off = item.with_name(item.name + ".chief-app-off")
        item.rename(off)
        journal.add("startup-renamed", original=str(item), renamed=str(off))

    say("3/8 Stopping the old dashboard and the old gateway…")
    for d in inst.old_dashboard():
        journal.add("dashboard-stopped", command=d.get("parentCmd") or d.get("cmd") or "")
        subprocess.run(["taskkill", "/PID", str(d["parent"]), "/T", "/F"], capture_output=True)
        subprocess.run(["taskkill", "/PID", str(d["pid"]), "/T", "/F"], capture_output=True)
    if stop_gateway(inst, pay, inst.profile):
        journal.add("gateway-stopped")

    if "backed-up" not in done:
        say("4/8 Backing up the install (this takes a few minutes)…")
        dest = backup(inst)
        journal.add("backed-up", folder=str(dest))

    say("5/8 Moving the old command-center plugin aside…")
    cc = inst.profile / "plugins" / "command-center"
    if cc.is_dir():
        aside = inst.backup / "moved" / "profile-plugins" / "command-center"
        aside.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(cc), str(aside))
        journal.add("moved", original=str(cc), moved=str(aside))
    if set_plugin_enabled(pay, inst.profile, "command-center", False):
        journal.add("plugin-disabled", profile=str(inst.profile), name="command-center")

    say("6/8 Handing the bridge token to the app…")
    token = inst.token()
    if token:
        handover = inst.app_data / "app" / "adopt-token.txt"
        handover.parent.mkdir(parents=True, exist_ok=True)
        handover.write_text(token, encoding="utf-8")
        journal.add("token-handover", file=str(handover))

    say("7/8 Pointing the app at the install…")
    if "desktop-json" not in done:
        before_text = inst.desktop_json.read_text(encoding="utf-8") if inst.desktop_json.is_file() else ""
        before = json.loads(before_text) if before_text else {}
        inst.desktop_json.parent.mkdir(parents=True, exist_ok=True)
        inst.desktop_json.write_text(json.dumps(adopted_settings(inst, before), indent=2), encoding="utf-8")
        journal.add("desktop-json", previous=before_text)

    say("8/8 Starting the app…")
    start_app(inst)
    journal.add("started-app")
    say(f"Done. Journal: {journal.file}. Run --verify in a minute or two.")


def verify(inst: Install) -> int:
    token = inst.token()
    failures = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        say(("ok   " if ok else "FAIL ") + name + ("" if ok or not detail else f"  ({detail})"))
        if not ok:
            failures.append(name)

    health = {}
    for _ in range(90):
        try:
            health = http_json(f"http://127.0.0.1:{inst.bridge_port}/health", token)
            if health.get("ok"):
                break
        except Exception:
            pass
        time.sleep(2)
    check("the app's gateway answers on the bridge port with the same token", bool(health.get("ok")))
    owner = ps(f"(Get-CimInstance Win32_Process -Filter \"ProcessId={inst.gateway_pid() or 0}\").CommandLine") if inst.gateway_pid() else ""
    check("Chief runs on the app's Hermes", "WindowsApps" in owner or APP_PACKAGE in owner, owner[:160])
    try:
        snap = http_json(f"http://127.0.0.1:{inst.bridge_port}/snapshot", token)
        check("the chat is bound and the team is there", bool((snap.get("bind") or {}).get("sessionKey")) and len(snap.get("roster") or []) > 1,
              f"{len(snap.get('roster') or [])} on the roster")
        tr = http_json(f"http://127.0.0.1:{inst.bridge_port}/transcript?after=0", token)
        check("the conversation history is there", len(tr.get("messages") or []) > 0)
        sb = http_json(f"http://127.0.0.1:{inst.bridge_port}/setup/second-brain", token)
        check("the Second Brain is used as it is", sb.get("configured") and sb.get("rules") and sb.get("mode") == "keep", json.dumps(sb)[:200])
    except Exception as exc:
        check("the bridge reads", False, f"{type(exc).__name__}: {exc}")
    jobs = json.loads((inst.profile / "cron" / "jobs.json").read_text(encoding="utf-8"))
    jobs = jobs.get("jobs", jobs) if isinstance(jobs, dict) else jobs
    added = [j["name"] for j in jobs if str(j.get("name", "")).startswith(("Second Brain:", "Fleet:"))]
    check("no app routines were added beside the owner's", not added, ", ".join(added))
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{inst.ui_port}/", timeout=10) as res:
            check("the app's dashboard serves the UI port", res.status == 200)
    except Exception as exc:
        check("the app's dashboard serves the UI port", False, str(exc))
    check("the old launchers stay off", not inst.startup_items() and all(t["State"] in (1, "Disabled") for t in inst.guard_tasks()))
    say(json.dumps({"failures": failures}))
    return 1 if failures else 0


def rollback(inst: Install) -> None:
    journal = Journal(inst.backup)
    if not journal.steps:
        raise SystemExit(f"No journal at {journal.file}: nothing to roll back.")
    pay = inst.payload()
    say("Stopping the app…")
    stop_app(inst, pay)
    backup_root = inst.backup / "hermes" / "profiles" / inst.profile_name
    if backup_root.is_dir():
        say("Restoring the profile files the app changed…")
        for rel in ("config.yaml", ".env"):
            if (backup_root / rel).is_file():
                shutil.copy2(backup_root / rel, inst.profile / rel)
        if (backup_root / "plugins" / "chief-dashboard-bridge").is_dir():
            shutil.rmtree(inst.profile / "plugins" / "chief-dashboard-bridge", ignore_errors=True)
            shutil.copytree(backup_root / "plugins" / "chief-dashboard-bridge", inst.profile / "plugins" / "chief-dashboard-bridge")
        for rel in ("second_brain.json", "skills/.chief-bundled.json", "skills/note-taking/second-brain",
                    "skills/autonomous-ai-agents/fleet-builder"):
            target, kept = inst.profile / rel, backup_root / rel
            if target.exists() and not kept.exists():
                shutil.rmtree(target) if target.is_dir() else target.unlink()
    for step in reversed(journal.steps):
        kind = step["kind"]
        if kind == "desktop-json":
            if step["previous"]:
                inst.desktop_json.write_text(step["previous"], encoding="utf-8")
            say("App settings restored.")
        elif kind == "token-handover":
            Path(step["file"]).unlink(missing_ok=True)
        elif kind == "moved" and Path(step["moved"]).exists() and not Path(step["original"]).exists():
            shutil.move(step["moved"], step["original"])
            say(f"Put back: {step['original']}")
        elif kind == "startup-renamed" and Path(step["renamed"]).exists():
            Path(step["renamed"]).rename(step["original"])
            say(f"Startup item back: {Path(step['original']).name}")
        elif kind == "task-disabled":
            ps(f"Enable-ScheduledTask -TaskPath '{step['path']}' -TaskName '{step['name']}' | Out-Null")
            say(f"Scheduled task on again: {step['name']} (it starts the old gateway within a minute)")
        elif kind == "dashboard-stopped" and step.get("command"):
            # The command line exactly as it ran, detached and windowless like before.
            subprocess.Popen(step["command"], creationflags=subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS | 0x08000000,
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            say("Old dashboard started again.")
    journal.file.rename(journal.file.with_name(f"journal.rolled-back-{time.strftime('%Y%m%d-%H%M%S')}.json"))
    say("Rolled back. The backup folder is kept.")


def main() -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    for flag in ("--plan", "--apply", "--verify", "--rollback"):
        mode.add_argument(flag, action="store_true")
    parser.add_argument("--hermes-root", default=os.path.join(os.environ.get("LOCALAPPDATA", ""), "hermes"))
    parser.add_argument("--profile", default="chief")
    parser.add_argument("--backup-dir", required=True)
    parser.add_argument("--ui-port", type=int, default=3000)
    parser.add_argument("--bridge-port", type=int, default=7790)
    parser.add_argument("--learning-dir", default="", help="the install's own Fleet Health report folder, if any")
    parser.add_argument("--learning-tool", default="", help="the install's own learning ledger script, if any")
    parser.add_argument("--web-env", action="append", default=[], help="NAME=value for the dashboard (connectors; never secrets)")
    parser.add_argument("--payload-dir", default="", help="a built payload of the app's Hermes commit (packaging/payload)")
    parser.add_argument("--wait-idle", action="store_true", help="wait up to 10 minutes for Chief to be idle")
    parser.add_argument("--even-if-busy", action="store_true")
    parser.add_argument("--resume", action="store_true", help="continue an --apply that stopped part way (its journal)")
    args = parser.parse_args()
    inst = Install(args)
    if not inst.profile.is_dir():
        raise SystemExit(f"No profile at {inst.profile}.")
    repo = Path(__file__).resolve().parents[2]
    if repo in inst.backup.resolve().parents or inst.backup.resolve() == repo:
        raise SystemExit("The backup holds personal data: choose a folder outside the repository.")
    if args.plan:
        plan(inst)
    elif args.apply:
        apply(inst)
    elif args.verify:
        return verify(inst)
    else:
        rollback(inst)
    return 0


if __name__ == "__main__":
    sys.exit(main())
