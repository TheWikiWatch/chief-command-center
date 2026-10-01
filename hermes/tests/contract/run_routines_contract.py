"""Contract check for routines.py (Team & Routines) against a real Hermes runtime.

    set HERMES_HOME=<temp>\\profiles\\chief
    <payload python> hermes\\tests\\contract\\run_routines_contract.py <payload dir>

Throwaway home only. Exit 0 = the contract holds.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import types
from pathlib import Path

payload = Path(sys.argv[1]).resolve()
sys.path[:0] = [str(payload / "hermes-agent"), str(payload / "venv" / "Lib" / "site-packages")]
home = Path(os.environ["HERMES_HOME"]).resolve()
assert home.parent.name == "profiles" and home.name == "chief", "HERMES_HOME must be <root>/profiles/chief"
home.mkdir(parents=True, exist_ok=True)
(home / "config.yaml").write_text("model:\n  default: x\n", encoding="utf-8")
bot = home.parent / "research-desk"
bot.mkdir(exist_ok=True)
(bot / "config.yaml").write_text("model:\n  default: x\n", encoding="utf-8")
(bot / "profile.yaml").write_text("ui_meta:\n  hermes-bots:\n    title: Sam - Researcher\n", encoding="utf-8")

plugin = Path(__file__).resolve().parents[2] / "plugins" / "chief-dashboard-bridge"
package = types.ModuleType("bridge")
package.__path__ = [str(plugin)]
sys.modules["bridge"] = package


def load(name: str):
    spec = importlib.util.spec_from_file_location(f"bridge.{name}", plugin / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[f"bridge.{name}"] = module
    spec.loader.exec_module(module)
    return module


data = load("data")
data.chief_home = lambda root=None: home
load("identity")
threads = load("threads")
threads.chief_home = lambda: home
load("usage")
routines = load("routines")
failures: list[str] = []


def check(name: str, cond: bool, detail: object = "") -> None:
    print(("ok   " if cond else "FAIL ") + name + (f"  ({str(detail)[:300]})" if detail and not cond else ""))
    if not cond:
        failures.append(name)


def raises(fn) -> str:
    try:
        fn()
    except routines.RoutineError as exc:
        return str(exc)
    return ""


# Schedules in plain words, both ways
for spec, text in (
    ({"kind": "daily", "time": "08:30"}, "Every day at 08:30"),
    ({"kind": "weekdays", "time": "07:05"}, "Weekdays at 07:05"),
    ({"kind": "weekly", "time": "18:00", "days": [5, 1]}, "Mon, Fri at 18:00"),
    ({"kind": "hourly", "every": 3}, "Every 3 hours"),
):
    expr = routines.schedule_expr(spec)
    from cron.jobs import parse_schedule

    shown = routines.describe_schedule(parse_schedule(expr))
    check(f"schedule round-trip: {text}", shown["text"] == text and shown["kind"] == spec["kind"], (expr, shown))
check("a custom schedule is checked by Hermes", "isn't valid" in raises(lambda: routines.schedule_expr({"kind": "custom", "cron": "every banana"})))
check("a weekly routine needs a day", "day" in raises(lambda: routines.schedule_expr({"kind": "weekly", "time": "08:00", "days": []})))
check("a time is needed", "time" in raises(lambda: routines.schedule_expr({"kind": "daily", "time": "8pm"})))

# Create for the chief and for a bot
thread = threads.create("Research")["thread"]["id"]
mine = routines.create("chief", "Morning brief", "Summarize what's due today.", {"kind": "weekdays", "time": "07:30"})["routine"]
check("the chief's routine is created", mine["profile"] == "chief" and mine["schedule"]["text"] == "Weekdays at 07:30" and mine["thread"] == "main", mine)
sams = routines.create("research-desk", "Source sweep", "Look for new papers on solar storage.", {"kind": "weekly", "time": "09:00", "days": [1]}, thread)["routine"]
check("a bot's routine lives in its own store and reports to the chosen thread", sams["profile"] == "research-desk" and sams["bot"] == "Sam" and sams["thread"] == thread
      and (bot / "cron" / "jobs.json").is_file(), sams)
from cron import jobs as cron_jobs

with cron_jobs.use_cron_store(bot):
    stored = cron_jobs.get_job(sams["id"])
    out_dir = cron_jobs._job_output_dir(sams["id"])
check("a bot's routine is saved as local (Hermes can't deliver from a bot's profile)", stored["deliver"] == "local", stored)

# Relaying a bot's run into its thread
out_dir.mkdir(parents=True, exist_ok=True)
(out_dir / "2026-10-01_08-00-00.md").write_text("# Cron Job: Source sweep\n\n## Prompt\n\nx\n\n## Response\n\nThree new papers.\n", encoding="utf-8")
(out_dir / "2026-10-01_09-00-00.md").write_text("# Cron Job: Source sweep\n\n## Response\n\n[SILENT]\n", encoding="utf-8")
outbox = load("outbox")
check("a new run is relayed once, a silent one isn't", routines.relay() == 1 and routines.relay() == 0)
row = [r for r in outbox.read_outbox(limit=1000) if "Three new papers" in r.get("message", "")]
check("into the chosen thread, labelled with the bot", len(row) == 1 and row[0]["chat_id"] == threads.chat_id(thread) and "(Sam)" in row[0]["message"]
      and row[0]["source"] == "cron", row)
listed = routines.list_routines()
check("the list has both, with who runs them", {(r["profile"], r["name"]) for r in listed["routines"]} >= {("chief", "Morning brief"), ("research-desk", "Source sweep")}
      and {b["id"] for b in listed["bots"]} == {"chief", "research-desk"}, listed)
check("an unknown bot is refused", raises(lambda: routines.create("nobody", "x", "y", {"kind": "daily", "time": "08:00"})) != "")
check("an unknown thread is refused", raises(lambda: routines.create("chief", "x", "y", {"kind": "daily", "time": "08:00"}, "t-ffffffff")) != "")
check("a name of the app's own is refused", raises(lambda: routines.create("chief", "Fleet: mine", "y", {"kind": "daily", "time": "08:00"})) != "")

# Edit, pause, run, delete
edited = routines.update("research-desk", sams["id"], prompt="Look for new papers on grid batteries.", schedule={"kind": "daily", "time": "06:45"}, thread="main")["routine"]
check("a routine can be rewritten, retimed and moved", edited["prompt"].endswith("grid batteries.") and edited["schedule"]["text"] == "Every day at 06:45" and edited["thread"] == "main", edited)
off = routines.update("research-desk", sams["id"], enabled=False)["routine"]
check("switched off", off["enabled"] is False)
ran = routines.run_now("research-desk", sams["id"])["routine"]
check("run now turns it back on and due now", ran["enabled"] is True and ran["nextRun"] is not None, ran)
check("deleted", routines.delete("research-desk", sams["id"])["ok"] and not any(r["id"] == sams["id"] for r in routines.list_routines()["routines"]))
check("deleting forgets where it reported", sams["id"] not in (home / "routine_threads.json").read_text(encoding="utf-8"))

# Built-in routines
with cron_jobs.use_cron_store(home):
    built = cron_jobs.create_job("Run the nightly tidy.", "0 22 * * *", name="Second Brain: nightly", deliver="command_center")
check("a built-in routine is marked", next(r for r in routines.list_routines()["routines"] if r["id"] == built["id"])["builtIn"] is True)
check("a built-in can't be deleted", "switched off" in raises(lambda: routines.delete("chief", built["id"])))
kept = routines.update("chief", built["id"], prompt="something else", name="Mine now", schedule={"kind": "daily", "time": "21:30"})["routine"]
check("a built-in keeps its words but can be retimed", kept["prompt"] == "Run the nightly tidy." and kept["name"] == "Second Brain: nightly" and kept["schedule"]["time"] == "21:30", kept)

print(json.dumps({"failures": failures}))
sys.exit(1 if failures else 0)
