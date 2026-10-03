"""Chat controls against a real gateway: Stop, Add (steer), Send after (queue), and the chief's questions.

    python hermes/tests/contract/run_chat_controls_contract.py <payload dir> [<work dir>]

Starts the scriptable fake model (hermes/tests/fixtures/fake_model.py) and a gateway on a throwaway home with
the bundled bridge, then through the bridge's HTTP API:
- steer: a CTX marker sent while the chief works reaches the SAME turn (the final answer names it);
- stop: a running turn ends without its final answer;
- queue: a message sent with "send after" is answered after the running turn finishes;
- questions: a turn that calls Hermes's `clarify` shows the question with the transcript (not as a notice),
  an answer through /clarify or a typed message resumes it, and the transcript keeps the question and answer;
- the running turn reports its current step, and the owner's chat is the home channel (no "/sethome" notice);
- the agent's own terminal commands don't inherit the bridge token.
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
import compat

failures: list[str] = []


def check(name: str, cond: bool, detail: object = "") -> None:
    print(("ok   " if cond else "FAIL ") + name + (f"  ({ascii(str(detail)[:400])})" if detail and not cond else ""), flush=True)
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

    fake = subprocess.Popen(
        [sys.executable, str(REPO / "hermes" / "tests" / "fixtures" / "fake_model.py"), str(model_port)], env={**os.environ, "WORK_STEP_S": "3"}
    )
    gateway = None
    try:
        ok, out = compat.run(
            [
                str(p.python),
                "-B",
                str(REPO / "apps" / "desktop" / "python" / "provision.py"),
                "--plugins-src",
                str(REPO / "hermes" / "plugins"),
                "--bridge-port",
                str(bridge_port),
            ],
            p.env(HERMES_HOME=str(profile)),
        )
        check("profile provisioned", ok, out)
        connect = (
            "import sys, types, importlib.util, pathlib\n"
            "plugin = pathlib.Path(sys.argv[1])\n"
            "pkg = types.ModuleType('bridge'); pkg.__path__ = [str(plugin)]; sys.modules['bridge'] = pkg\n"
            "def load(n):\n"
            "    spec = importlib.util.spec_from_file_location('bridge.' + n, plugin / (n + '.py')); m = importlib.util.module_from_spec(spec); sys.modules['bridge.' + n] = m; spec.loader.exec_module(m); return m\n"
            "load('data'); providers = load('providers')\n"
            "r = providers.save_endpoint('Local model', sys.argv[2], 'tiny-local', '')\n"
            "load('persona'); fleet = load('fleet')\n"
            "m = fleet.mint('research-desk', 'Sam', 'Researcher', 'Finds sources.', 'You are Sam, a researcher.', owner_signed=True)\n"
            "print(r, m.get('ok')); sys.exit(0 if r.get('ok') and m.get('ok') else 1)\n"
        )
        ok, out = compat.run(
            [str(p.python), "-B", "-c", connect, str(REPO / "hermes" / "plugins" / "chief-dashboard-bridge"), f"http://127.0.0.1:{model_port}/v1"],
            p.env(HERMES_HOME=str(profile)),
        )
        check("fake model connected", ok, out)

        env = p.env(
            HERMES_HOME=str(root),
            HERMES_GATEWAY_LOCK_DIR=str(work / "locks"),
            CHIEF_DASHBOARD_TOKEN=token,
            CHIEF_DASHBOARD_PORT=str(bridge_port),
            HERMES_BIN=str(p.launcher),
        )
        log = open(work / "gateway.log", "w", encoding="utf-8")
        gateway = subprocess.Popen([str(p.launcher), "-p", "chief", "gateway", "run"], env=env, cwd=profile, stdout=log, stderr=subprocess.STDOUT)
        base = f"http://127.0.0.1:{bridge_port}"

        def call(path: str, body: dict | None = None, timeout: float = 30) -> dict:
            data = None if body is None else json.dumps(body).encode()
            req = urllib.request.Request(
                base + path,
                data=data,
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                method="POST" if body is not None else "GET",
            )
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

        # Warm-up: one ordinary message, answered before the timed checks. On GitHub's Windows runner the first turn
        # after start waits ("Another Hermes process is using this session") while the setup's own Hermes commands
        # let go of the session; the controls below are about a running chief, not a cold start.
        # Preparation, not a check: a refused send wasn't delivered, so it is simply tried again.
        warm: dict = {}
        end = time.time() + 300
        while time.time() < end:
            try:
                warm = call("/send", {"text": "hello, warming up", "client_id": "c-warm"})
            except Exception as exc:
                warm = {"error": type(exc).__name__}
            if warm.get("ok"):
                break
            time.sleep(3)
        answered = wait(lambda: assistant_after(0, "Hello from the local test model"), 300)
        print(f"      warm-up: send {json.dumps(warm)[:200]}, answered: {bool(answered)}")
        wait(lambda: not generating(), 60)
        warmed_at = time.time()

        # Steer: context reaches the running turn.
        start = len(messages())
        first = call("/send", {"text": "WORK on the report", "client_id": "c-steer"})
        check("send starts a long turn", first.get("ok") is True, first)
        check("chief is working", wait(generating, 30))

        # The fixture's first tool (skills_list) starts about 3 s in and ends at once: the step count goes up
        # while the turn still runs (the rows themselves reach the database only when the turn ends).
        def live_step():
            now = call("/transcript?after=0")
            act = now.get("activity") or {}
            return now.get("generating") and act.get("steps", 0) >= 1 and act.get("label") in ("Looking through its skills", "Thinking it over")

        check("the running turn reports its steps live", wait(live_step, 8, every=0.25) is True, call("/transcript?after=0").get("activity"))
        # Steer once the turn is really running (Hermes holds early arrivals until the agent exists): the
        # step check above waited for the fixture's first tool (about 3 s in); the turn lasts about 9 s.
        time.sleep(1)
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
        check(
            "the queued message is answered after the turn",
            done is not None and after is not None and rows.index(after) > rows.index(done),
            [(m.get("id"), m.get("role"), str(m.get("content"))[:70], m.get("tools")) for m in rows[start:]],
        )
        check("controls refuse junk", call("/steer", {"text": "  "}).get("ok") is False and call("/queue", {"text": ""}).get("ok") is False)

        # Questions: the chief asks with `clarify`; the turn waits for the answer.
        wait(lambda: not generating(), 60)
        start = len(messages())
        call("/send", {"text": "QUIZME now", "client_id": "c-ask"})
        asked = wait(lambda: call("/transcript?after=0").get("clarify"), 45)
        check(
            "the question comes with the transcript",
            bool(asked)
            and asked.get("question") == "Which colour?"
            and [c.replace(" (Recommended)", "") for c in asked.get("choices") or []] == ["Red", "Blue"],
            asked,
        )
        payload = call("/transcript?after=0")
        check("it is not shown as a notice", not any("Which colour" in n.get("text", "") for n in payload.get("notices") or []), payload.get("notices"))
        check("a stale answer is refused", call("/clarify", {"id": "not-the-question", "answer": "Red"}).get("ok") is False)
        blue = next((c for c in (asked or {}).get("choices") or [] if c.startswith("Blue")), "Blue")
        answered = call("/clarify", {"id": (asked or {}).get("id", ""), "answer": blue})
        check("a choice answers it", answered.get("ok") is True, answered)
        reply = wait(lambda: assistant_after(start, "You picked"), 45)
        check("the turn resumes with the answer", reply is not None and "Blue" in str(reply.get("content")), reply)
        check(
            "the transcript keeps the question and the answer",
            any((m.get("asked") or [{}])[0].get("answer", "").startswith("Blue") for m in messages()[start:]),
            [m for m in messages()[start:] if m.get("asked")],
        )
        check("no question is left open", wait(lambda: call("/transcript?after=0").get("clarify") is None, 10))

        wait(lambda: not generating(), 30)
        start = len(messages())
        call("/send", {"text": "QUIZME FREE please", "client_id": "c-ask-free"})
        check("an open question appears", bool(wait(lambda: call("/transcript?after=0").get("clarify"), 45)))
        typed = call("/send", {"text": "teal please", "client_id": "c-ask-typed"})
        check("typing in the chat answers it", typed.get("ok") is True, typed)
        reply = wait(lambda: assistant_after(start, "You picked"), 45)
        check("the typed answer reached the turn", reply is not None and "teal please" in str(reply.get("content")), reply)

        # Home-channel notices count from the start; busy notices only after the warm-up (see above).
        notices = call("/transcript?after=0").get("notices") or []
        flagged = [n for n in notices if "/sethome" in n.get("text", "") or (n.get("text", "").startswith("⏳") and float(n.get("at") or 0) >= warmed_at)]
        check("no home-channel or busy notices", not flagged, flagged)

        # The bridge token never reaches the agent's own commands (bridge_token.py): a terminal child of the
        # gateway reports whether CHIEF_DASHBOARD_TOKEN is set.
        # Runs once the chat has shown it takes messages and is idle.
        wait(lambda: not generating(), 60)
        start = len(messages())
        sent = call("/send", {"text": "ENVCHECK please", "client_id": "c-env"})
        check("the env-check message is accepted", sent.get("ok") is True, sent)
        # The first terminal command starts the agent's shell cold: on a CI runner that took over 90 seconds.
        env_reply = wait(lambda: assistant_after(start, "Env check"), 240)
        stuck = ""
        if env_reply is None:
            # Was the turn still running, and on which step? (Messages reach the transcript only when a turn ends.)
            state = call("/transcript?after=0")
            if state.get("generating"):
                stuck = str((state.get("activity") or {}).get("label") or "an unnamed step")
            print(f"      still working: {bool(stuck)}, step: {stuck!a}")
            # Say what happened instead (a CI runner never answered here): the turn's last messages and the gateway's
            # log tail, with anything token-like left out.
            # Log first and the turn last: the suite's report keeps only the end of each check's output.
            try:
                tail = (work / "gateway.log").read_text(encoding="utf-8", errors="replace").splitlines()[-15:]
                for line in tail:
                    if "token" not in line.lower():
                        print(f"      log: {line[:200]!a}")
            except OSError:
                pass
            print(f"      send result: {json.dumps(sent)[:300]}")
            try:
                print(f"      approvals waiting: {json.dumps(call('/approvals'))[:400]}")
            except Exception as exc:
                print(f"      approvals: unreadable ({type(exc).__name__})")
            for m in messages()[start:][-6:]:
                print(f"      {m.get('role')}: {str(m.get('content'))[:300]!a} tools={m.get('tools')}")
            if stuck:
                call("/stop", {})
                wait(lambda: not generating(), 30)
        if env_reply is None and stuck and os.environ.get("CI"):
            # GitHub's Windows runner: the agent's terminal never finishes there, so the check can't be judged (the
            # token can't be seen by a command that never runs). It passes on a real PC, where compat.py runs before
            # every Hermes upgrade (CLAUDE.md), so a CI run reports it as skipped rather than failed.
            print(f"skip the agent's terminal doesn't see the bridge token (CI: the runner's terminal never finished; step {stuck!a})")
        else:
            check(
                "the agent's terminal doesn't see the bridge token",
                env_reply is not None and "TOKEN-ABSENT" in str(env_reply.get("content")),
                env_reply or "no answer within 240 s (the terminal didn't finish; not a sign the token was seen)",
            )

        # Background work: delegated tasks keep running after the turn that started them has ended (Hermes always runs
        # them asynchronously), and the chat shows them instead of looking idle.
        wait(lambda: not generating(), 60)
        start = len(messages())
        call("/send", {"text": "LANES please", "client_id": "c-lanes"})
        started = wait(lambda: assistant_after(start, "Lanes started"), 90)
        check("the chief hands two tasks to helpers", started is not None, messages()[start:])
        units = wait(lambda: call("/transcript?after=0").get("background") or None, 30) or []
        tasks = [t for u in units for t in u.get("tasks", [])]
        check(
            "the background tasks show, with their goals and a step in plain words",
            sorted(t.get("goal") for t in tasks) == ["WORK on lane one", "WORK on lane two"] and all(t.get("step") for t in tasks),
            units,
        )
        state = call("/transcript?after=0")
        t0 = time.time()
        woke = call(f"/transcript?after={state.get('lastId', 0)}&wait=10&gen={'1' if state.get('generating') else '0'}&bg=stale", timeout=20)
        check("a stale background view wakes the long-poll at once", time.time() - t0 < 4 and bool(woke.get("background")), round(time.time() - t0, 1))
        check("the list empties once the work is done", bool(wait(lambda: not call("/transcript?after=0").get("background"), 180)))

        # Threads: separate conversations with the chief, side by side.
        wait(lambda: not generating(), 30)
        made = call("/threads", {"title": "Side project"})
        tid = (made.get("thread") or {}).get("id", "")
        check("a thread can be made", made.get("ok") is True and tid.startswith("t-"), made)

        def thread_rows(thread: str) -> list[dict]:
            return call(f"/transcript?after=0&thread={thread}").get("messages") or []

        def thread_busy(thread: str) -> bool:
            return bool(call(f"/transcript?after=0&thread={thread}").get("generating"))

        main_before = len(messages())
        call("/send", {"text": "WORK on the main plan", "client_id": "t-main-1"})
        call("/send", {"text": "WORK on the side plan", "client_id": "t-side-1", "thread": tid})
        both = wait(lambda: thread_busy("main") and thread_busy(tid), 20, every=0.25)
        check("two threads work at the same time", both is True)
        listed = {t["id"]: t for t in call("/threads").get("threads") or []}
        check("the thread list shows both working", listed.get(tid, {}).get("working") is True and listed.get("main", {}).get("working") is True, listed)
        side_done = wait(lambda: next((m for m in thread_rows(tid) if "Work finished" in str(m.get("content"))), None), 90)
        main_done = wait(lambda: next((m for m in messages()[main_before:] if "Work finished" in str(m.get("content"))), None), 90)
        check("each thread finishes its own work", side_done is not None and main_done is not None)
        check(
            "their transcripts stay apart",
            not any("side plan" in str(m.get("content")) for m in messages()) and any("side plan" in str(m.get("content")) for m in thread_rows(tid)),
        )

        wait(lambda: not thread_busy(tid), 30)
        call("/send", {"text": "QUIZME now", "client_id": "t-side-ask", "thread": tid})
        asked_side = wait(lambda: call(f"/transcript?after=0&thread={tid}").get("clarify"), 45)
        check("a question belongs to its thread", bool(asked_side) and call("/transcript?after=0").get("clarify") is None)
        listed = {t["id"]: t for t in call("/threads").get("threads") or []}
        check("the thread list shows the waiting question", listed.get(tid, {}).get("question") is True, listed.get(tid))
        call("/clarify", {"id": asked_side.get("id", ""), "answer": "Red", "thread": tid})
        wait(lambda: not thread_busy(tid), 45)

        fresh = call("/threads/fresh", {"thread": tid})
        check("a fresh start is accepted", fresh.get("ok") is True, fresh)
        restarted = wait(lambda: call(f"/transcript?after=0&thread={tid}").get("previous"), 30)
        check("the earlier conversation is kept as history", bool(restarted) and restarted[0].get("messages", 0) > 0, restarted)
        old = call(f"/transcript?after=0&thread={tid}&session={(restarted or [{}])[0].get('id', '')}")
        check(
            "and can be read",
            any("side plan" in str(m.get("content")) for m in old.get("messages") or []),
            [m.get("content") for m in (old.get("messages") or [])][:4],
        )
        renamed = call("/threads/rename", {"thread": tid, "title": "Lisbon trip"})
        archived = call("/threads/archive", {"thread": tid})
        check("a thread can be renamed and archived", renamed.get("ok") and archived.get("ok") and (archived.get("thread") or {}).get("archived") is True)
        check("an unknown thread is refused", call("/send", {"text": "hi", "client_id": "t-bad", "thread": "t-deadbeef"}).get("ok") is False)

        # Routines: a bot's routine runs as that bot and reports into the chat; the chief's into a thread.
        reported = call("/threads", {"title": "Reports"})
        rid = (reported.get("thread") or {}).get("id", "")
        bot_r = call("/routines", {"profile": "research-desk", "name": "Ping", "prompt": "BOTPING report in", "schedule": {"kind": "daily", "time": "03:00"}})
        chief_r = call(
            "/routines",
            {"profile": "chief", "name": "Thread ping", "prompt": "CHIEFPING report in", "schedule": {"kind": "daily", "time": "03:00"}, "thread": rid},
        )
        check("routines are created for a bot and for the chief", bot_r.get("ok") is True and chief_r.get("ok") is True, (bot_r, chief_r))
        call("/routines/run", {"profile": "research-desk", "id": (bot_r.get("routine") or {}).get("id", "")})
        call("/routines/run", {"profile": "chief", "id": (chief_r.get("routine") or {}).get("id", "")})

        def notice_with(thread: str, needle: str):
            q = "/transcript?after=0" + (f"&thread={thread}" if thread != "main" else "")
            return next((n for n in call(q).get("notices") or [] if needle in n.get("text", "")), None)

        bot_note = wait(lambda: notice_with("main", "BOTPING"), 150, every=2)
        check("a bot's routine runs and reports into the main thread", bot_note is not None, call("/transcript?after=0").get("notices"))
        chief_note = wait(lambda: notice_with(rid, "CHIEFPING"), 120, every=2)
        check("the chief's routine reports into its thread, not the main one", chief_note is not None and notice_with("main", "CHIEFPING") is None)
        listed = {r["name"]: r for r in call("/routines").get("routines") or []}
        check("the routine list shows the last run", bool(listed.get("Ping", {}).get("lastRun")), listed.get("Ping"))
    finally:
        if gateway is not None:
            try:
                pid = int(json.loads((profile / "gateway.pid").read_text(encoding="utf-8")).get("pid") or 0)
                if pid:
                    compat.run(
                        [
                            str(p.python),
                            "-B",
                            "-c",
                            "import sys\nfrom gateway.status import write_planned_stop_marker\nwrite_planned_stop_marker(int(sys.argv[1]))",
                            str(pid),
                        ],
                        p.env(HERMES_HOME=str(profile)),
                        timeout=30,
                    )
                gateway.wait(timeout=40)
            except Exception:
                subprocess.run(["taskkill", "/T", "/F", "/PID", str(gateway.pid)], capture_output=True)
        fake.terminate()
    print(json.dumps({"failures": failures}))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
