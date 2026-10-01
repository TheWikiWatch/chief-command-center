"""Chat controls against a real gateway: Stop, Add (steer) and Send after (queue).

    python hermes/tests/contract/run_chat_controls_contract.py <payload dir> [<work dir>]

Starts the scriptable fake model (hermes/tests/fixtures/fake_model.py) and a gateway on a throwaway home with
the bundled bridge, then through the bridge's HTTP API:
- steer: a CTX marker sent while the chief works reaches the SAME turn (the final answer names it);
- stop: a running turn ends without its final answer;
- queue: a message sent with "send after" is answered after the running turn finishes.
The gateway is stopped with Hermes's planned-stop marker for its own home only.
"""
from __future__ import annotations

import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "packaging" / "upstream"))
import compat  # noqa: E402

failures: list[str] = []


def check(name: str, cond: bool, detail: object = "") -> None:
    print(("ok   " if cond else "FAIL ") + name + (f"  ({str(detail)[:400]})" if detail and not cond else ""), flush=True)
    if not cond:
        failures.append(name)


def main() -> int:
    p = compat.Payload(Path(sys.argv[1]).resolve())
    work = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else Path(tempfile.mkdtemp(prefix="chief-controls-"))
    shutil.rmtree(work, ignore_errors=True)
    root = work / "home"
    profile = root / "profiles" / "chief"
    profile.mkdir(parents=True)
    model_port, bridge_port = compat.free_port(), compat.free_port()
    token = secrets.token_urlsafe(32)

    fake = subprocess.Popen([sys.executable, str(REPO / "hermes" / "tests" / "fixtures" / "fake_model.py"), str(model_port)],
                            env={**os.environ, "WORK_STEP_S": "3"})
    gateway = None
    try:
        ok, out = compat.run([str(p.python), "-B", str(REPO / "apps" / "desktop" / "python" / "provision.py"), "--plugins-src",
                              str(REPO / "hermes" / "plugins"), "--bridge-port", str(bridge_port)], p.env(HERMES_HOME=str(profile)))
        check("profile provisioned", ok, out)
        connect = (
            "import sys, types, importlib.util, pathlib\n"
            "plugin = pathlib.Path(sys.argv[1])\n"
            "pkg = types.ModuleType('bridge'); pkg.__path__ = [str(plugin)]; sys.modules['bridge'] = pkg\n"
            "def load(n):\n"
            "    spec = importlib.util.spec_from_file_location('bridge.' + n, plugin / (n + '.py')); m = importlib.util.module_from_spec(spec); sys.modules['bridge.' + n] = m; spec.loader.exec_module(m); return m\n"
            "load('data'); providers = load('providers')\n"
            "r = providers.save_endpoint('Local model', sys.argv[2], 'tiny-local', '')\n"
            "print(r); sys.exit(0 if r.get('ok') else 1)\n"
        )
        ok, out = compat.run([str(p.python), "-B", "-c", connect, str(REPO / "hermes" / "plugins" / "chief-dashboard-bridge"),
                              f"http://127.0.0.1:{model_port}/v1"], p.env(HERMES_HOME=str(profile)))
        check("fake model connected", ok, out)

        env = p.env(HERMES_HOME=str(root), HERMES_GATEWAY_LOCK_DIR=str(work / "locks"), CHIEF_DASHBOARD_TOKEN=token,
                    CHIEF_DASHBOARD_PORT=str(bridge_port), HERMES_BIN=str(p.launcher))
        log = open(work / "gateway.log", "w", encoding="utf-8")
        gateway = subprocess.Popen([str(p.launcher), "-p", "chief", "gateway", "run"], env=env, cwd=profile, stdout=log, stderr=subprocess.STDOUT)
        base = f"http://127.0.0.1:{bridge_port}"

        def call(path: str, body: dict | None = None, timeout: float = 30) -> dict:
            data = None if body is None else json.dumps(body).encode()
            req = urllib.request.Request(base + path, data=data, headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                                         method="POST" if body is not None else "GET")
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return json.loads(res.read())

        deadline = time.time() + 120
        while time.time() < deadline:
            try:
                if call("/health", timeout=3).get("ok"):
                    break
            except Exception:
                time.sleep(1)
        check("gateway healthy", call("/health").get("ok") is True)
        # /health answers before the Command Center adapter is attached; the first send waits for it.
        attached = None
        end = time.time() + 60
        while time.time() < end and not attached:
            attached = call("/snapshot").get("bind", {}).get("sessionKey")
            if not attached:
                time.sleep(1)
        check("chat channel attached", bool(attached))

        def messages() -> list[dict]:
            return call("/transcript?after=0").get("messages") or []

        def wait(pred, seconds: float, every: float = 0.5):
            end = time.time() + seconds
            while time.time() < end:
                value = pred()
                if value:
                    return value
                time.sleep(every)
            return pred()

        def generating() -> bool:
            return bool(call("/transcript?after=0").get("generating"))

        def assistant_after(n: int, needle: str):
            return next((m for m in messages()[n:] if m.get("role") == "assistant" and needle in str(m.get("content"))), None)

        # Steer: context reaches the running turn.
        start = len(messages())
        first = call("/send", {"text": "WORK on the report", "client_id": "c-steer"})
        check("send starts a long turn", first.get("ok") is True, first)
        check("chief is working", wait(generating, 30))
        # Steer once the turn is really running (Hermes holds early arrivals until the agent exists). The
        # transcript records tool rows only when a turn ends, so wait on time: the fixture's first tool call
        # comes 3 s in, and the turn lasts about 9 s.
        time.sleep(4)
        steered = call("/steer", {"text": "CTX-alpha use the blue template"})
        check("steer accepted while working", steered.get("ok") is True and steered.get("action") == "steer", steered)
        final = wait(lambda: assistant_after(start, "Work finished"), 90)
        check("the steered context reached the same turn", final is not None and "CTX-alpha" in str(final.get("content")), final)

        # Stop: the running turn ends without its answer.
        wait(lambda: not generating(), 30)
        start = len(messages())
        call("/send", {"text": "WORK on the slides", "client_id": "c-stop"})
        check("second turn working", wait(generating, 30))
        stopped = call("/stop", {})
        check("stop accepted", stopped.get("ok") is True, stopped)
        check("the turn stops within 20 s", wait(lambda: not generating(), 20))
        time.sleep(8)
        check("the stopped turn never finishes its work", assistant_after(start, "Work finished") is None, messages()[start:])

        # Queue: runs after the current turn.
        start = len(messages())
        call("/send", {"text": "WORK on the budget", "client_id": "c-queue"})
        check("third turn working", wait(generating, 30))
        queued = call("/queue", {"text": "and after that, say thanks"})
        check("queue accepted", queued.get("ok") is True, queued)
        done = wait(lambda: assistant_after(start, "Work finished"), 90)
        after = wait(lambda: assistant_after(start, "say thanks"), 60)
        rows = messages()
        check("the queued message is answered after the turn",
              done is not None and after is not None and rows.index(after) > rows.index(done),
              [(m.get("id"), m.get("role"), str(m.get("content"))[:70], m.get("tools")) for m in rows[start:]])
        check("controls refuse junk", call("/steer", {"text": "  "}).get("ok") is False and call("/queue", {"text": ""}).get("ok") is False)
    finally:
        if gateway is not None:
            try:
                pid = int(json.loads((profile / "gateway.pid").read_text(encoding="utf-8")).get("pid") or 0)
                if pid:
                    compat.run([str(p.python), "-B", "-c", "import sys\nfrom gateway.status import write_planned_stop_marker\nwrite_planned_stop_marker(int(sys.argv[1]))", str(pid)],
                               p.env(HERMES_HOME=str(profile)), timeout=30)
                gateway.wait(timeout=40)
            except Exception:
                subprocess.run(["taskkill", "/T", "/F", "/PID", str(gateway.pid)], capture_output=True)
        fake.terminate()
    print(json.dumps({"failures": failures}))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
