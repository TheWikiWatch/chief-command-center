"""Compatibility suite for a built Hermes payload (PLAN §8 "Upstream tracking").

    python packaging/upstream/compat.py --payload <dir> [--work <dir>] [--network] [--report <file.md>]

Runs, against that payload's own Python and launcher, on throwaway homes only:

1. Plugin import: every bridge module imports; imports of Hermes's private (underscore) names are listed.
2. The contract runners: providers, persona, Second Brain, speech model (offline unless --network).
3. The bridge's unit tests under the payload interpreter.
4. Gateway smoke: provision a fresh profile the way the app does, start `hermes -p chief gateway run` on a
   free port with its own lock folder, check /health, /snapshot, /transcript, /setup/status, /voice/model and
   /persona, then stop only that gateway with Hermes's planned-stop marker (never `hermes gateway stop`, which
   on Windows can stop other installs' gateways on the same PC).
5. With --network: Edge TTS speaks without a key (inside the speech-model contract).

Exit 0 when everything passed. The Markdown report is what the candidate PR or blocked-upgrade issue shows.
"""
from __future__ import annotations

import argparse
import ast
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PLUGIN = REPO / "hermes" / "plugins" / "chief-dashboard-bridge"


class Payload:
    def __init__(self, root: Path):
        self.root = root
        manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))["runtime"]
        self.python = root / manifest["storePython"]
        self.site = root / manifest["sitePackages"]
        self.repo = root / manifest["repoDir"]
        self.launcher = root / manifest["commands"]["hermes"]

    def env(self, **extra: str) -> dict[str, str]:
        keep = {k: v for k, v in os.environ.items() if k.upper() in {"SYSTEMROOT", "WINDIR", "TEMP", "TMP", "PATH", "PATHEXT", "COMSPEC",
                                                                      "USERPROFILE", "LOCALAPPDATA", "APPDATA", "HOMEDRIVE", "HOMEPATH", "USERNAME"}}
        keep.update({"PYTHONPATH": os.pathsep.join([str(self.site), str(self.repo)]), "PYTHONIOENCODING": "utf-8"})
        keep.update(extra)
        return keep


def run(cmd: list[str], env: dict[str, str], timeout: int = 900, cwd: Path | None = None) -> tuple[bool, str]:
    try:
        proc = subprocess.run(cmd, env=env, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    except subprocess.TimeoutExpired:
        return False, f"timed out after {timeout}s"
    out = (proc.stdout + proc.stderr).strip()
    return proc.returncode == 0, out[-4000:]


def private_imports() -> list[str]:
    found = []
    for path in sorted(PLUGIN.glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module and not node.module.startswith(".") and node.level == 0:
                for alias in node.names:
                    if alias.name.startswith("_") and node.module.split(".")[0] in {"hermes_cli", "agent", "tools", "gateway", "hermes_constants", "cli", "utils"}:
                        found.append(f"{path.name}: from {node.module} import {alias.name}")
    return found


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def get(url: str, token: str, timeout: float = 5) -> dict:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read())


def gateway_smoke(p: Payload, work: Path) -> tuple[bool, str]:
    root = work / "gateway-home"
    profile = root / "profiles" / "chief"
    profile.mkdir(parents=True, exist_ok=True)
    port = free_port()
    token = secrets.token_urlsafe(32)
    ok, out = run([str(p.python), "-B", str(REPO / "apps" / "desktop" / "python" / "provision.py"), "--plugins-src", str(REPO / "hermes" / "plugins"),
                   "--bridge-port", str(port)], p.env(HERMES_HOME=str(profile)))
    if not ok:
        return False, f"provision failed: {out}"
    env = p.env(HERMES_HOME=str(root), HERMES_GATEWAY_LOCK_DIR=str(work / "locks"), CHIEF_DASHBOARD_TOKEN=token,
                CHIEF_DASHBOARD_PORT=str(port), HERMES_BIN=str(p.launcher))
    log = open(work / "gateway-smoke.log", "w", encoding="utf-8")
    proc = subprocess.Popen([str(p.launcher), "-p", "chief", "gateway", "run"], env=env, cwd=profile, stdout=log, stderr=subprocess.STDOUT)
    lines = []
    try:
        deadline = time.time() + 120
        health = None
        while time.time() < deadline:
            if proc.poll() is not None:
                return False, f"gateway exited early ({proc.returncode}); see gateway-smoke.log"
            try:
                health = get(f"http://127.0.0.1:{port}/health", token)
                if health.get("ok") and health.get("profile") == "chief":
                    break
            except Exception:
                pass
            time.sleep(1)
        else:
            return False, "no healthy /health within 120 s"
        lines.append(f"/health {health}")
        for path in ("/snapshot", "/transcript?after=0", "/setup/status", "/voice/model", "/persona", "/setup/second-brain"):
            body = get(f"http://127.0.0.1:{port}{path}", token, timeout=30)
            if not body.get("ok", True) and path != "/setup/status":
                return False, f"{path} answered {str(body)[:300]}"
            lines.append(f"{path} ok")
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=5)
            return False, "/health answered without the token"
        except urllib.error.HTTPError as exc:
            if exc.code != 401:
                return False, f"/health without a token gave {exc.code}"
        lines.append("/health without token -> 401")
    finally:
        # Never `hermes gateway stop`: on Windows it can stop OTHER installs' gateways on this PC (it ends the
        # per-user task named after the profile and sweeps processes regardless of HERMES_HOME). Ask only this
        # gateway, in this home, to drain, with Hermes's own planned-stop marker.
        # The pid file appears a few seconds after /health answers.
        pid = 0
        for _ in range(60):
            try:
                pid = int(json.loads((profile / "gateway.pid").read_text(encoding="utf-8")).get("pid") or 0)
            except (OSError, ValueError):
                pid = 0
            if pid or proc.poll() is not None:
                break
            time.sleep(1)
        marker = "import sys\nfrom gateway.status import write_planned_stop_marker\nsys.exit(0 if write_planned_stop_marker(int(sys.argv[1])) else 1)"
        for attempt in (1, 2):  # the gateway's marker watcher may not be running yet on the first try
            if not pid or proc.poll() is not None:
                break
            marked, out = run([str(p.python), "-B", "-c", marker, str(pid)], p.env(HERMES_HOME=str(profile)), timeout=30)
            lines.append(f"planned-stop marker {attempt} for pid {pid}: {'written' if marked else 'FAILED ' + out[-300:]}")
            try:
                proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                continue
        try:
            proc.wait(timeout=5)
            lines.append(f"stopped cleanly (exit {proc.returncode})")
        except subprocess.TimeoutExpired:
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True)
            lines.append("did not stop within 40 s; ended its own process tree")
        log.close()
    return proc.returncode == 0 or "stopped cleanly" in lines[-1], "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--payload", required=True)
    parser.add_argument("--work", default="")
    parser.add_argument("--network", action="store_true")
    parser.add_argument("--report", default="")
    args = parser.parse_args()
    p = Payload(Path(args.payload).resolve())
    work = Path(args.work).resolve() if args.work else Path(tempfile.mkdtemp(prefix="chief-compat-"))
    work.mkdir(parents=True, exist_ok=True)
    results: list[tuple[str, bool, float, str]] = []

    def check(name: str, fn) -> None:
        started = time.time()
        try:
            ok, detail = fn()
        except Exception as exc:  # a crash in the suite is a failed check, with its message
            ok, detail = False, f"{type(exc).__name__}: {exc}"
        results.append((name, ok, time.time() - started, detail))
        print(f"{'PASS' if ok else 'FAIL'} {name} ({time.time() - started:.0f}s)", flush=True)

    probe = ("import importlib.util, sys, types, pathlib; p = pathlib.Path(sys.argv[1]); pkg = types.ModuleType('bridge'); "
             "pkg.__path__ = [str(p)]; sys.modules['bridge'] = pkg\n"
             "for f in sorted(p.glob('*.py')):\n"
             "    name = 'bridge.' + ('__init__' if f.stem == '__init__' else f.stem)\n"
             "    if f.stem == '__init__': continue\n"
             "    spec = importlib.util.spec_from_file_location(name, f); m = importlib.util.module_from_spec(spec); sys.modules[name] = m; spec.loader.exec_module(m)\n"
             "print('imported', len(list(p.glob('*.py'))) - 1, 'modules')")
    check("plugin imports", lambda: run([str(p.python), "-B", "-c", probe, str(PLUGIN)], p.env(HERMES_HOME=str(work / "import-home" / "profiles" / "chief"))))
    private = private_imports()
    results.append(("private Hermes names used (review)", True, 0.0, "\n".join(private) or "none"))

    def contract(script: str, *extra: str, network: bool = False):
        home = work / f"home-{script}" / "profiles" / "chief"
        shutil.rmtree(home.parent.parent, ignore_errors=True)
        home.mkdir(parents=True)
        env = p.env(HERMES_HOME=str(home), **({"CONTRACT_NETWORK": "1"} if network else {}))
        return run([str(p.python), "-B", str(REPO / "hermes" / "tests" / "contract" / script), str(p.root), *extra], env)

    check("providers contract", lambda: contract("run_providers_contract.py"))
    check("persona contract", lambda: contract("run_persona_contract.py"))
    check("fleet contract", lambda: contract("run_fleet_contract.py"))
    check("Fleet Health contract", lambda: contract("run_learning_contract.py"))
    check("second brain contract", lambda: contract("run_second_brain_contract.py", str(work / "second-brain-work")))
    check("speech model contract" + (" + network" if args.network else ""), lambda: contract("run_speech_model_contract.py", network=args.network))
    check("bridge unit tests", lambda: run([str(p.python), "-B", "-m", "unittest", "discover", "-s", "hermes/tests"], p.env(), cwd=REPO))
    check("gateway start, bridge, stop", lambda: gateway_smoke(p, work))
    check("chat controls (stop, steer, queue)", lambda: run([str(p.python), "-B", str(REPO / "hermes" / "tests" / "contract" / "run_chat_controls_contract.py"),
                                                           str(p.root), str(work / "controls")], p.env(), timeout=900))

    passed = all(ok for _, ok, _, _ in results)
    report = [f"## Compatibility suite: {'passed' if passed else 'FAILED'}", "", f"Payload: `{p.root.name}`", "", "| Check | Result | Time |", "| --- | --- | --- |"]
    report += [f"| {name} | {'pass' if ok else '**FAIL**'} | {secs:.0f}s |" for name, ok, secs, _ in results]
    report += ["", "<details><summary>Details</summary>", ""]
    for name, ok, _, detail in results:
        report += [f"### {name}", "", "```", detail[-3000:], "```", ""]
    report.append("</details>")
    text = "\n".join(report)
    if args.report:
        Path(args.report).write_text(text, encoding="utf-8")
    print(text if not passed else f"all {len(results)} checks passed")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
