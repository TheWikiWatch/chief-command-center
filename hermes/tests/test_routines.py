"""Team & Routines (routines.py): schedules in plain words, cron expressions, validation, built-in guards and relaying bot runs."""

import contextlib
import importlib
import json
import os
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import yaml

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "hermes/plugins/chief-dashboard-bridge"
RUNTIME = ROOT / "hermes/tests/.runtime"
package = types.ModuleType("test_routines_plugin")
package.__path__ = [str(PLUGIN)]
sys.modules.setdefault(package.__name__, package)
if "hermes_constants" not in sys.modules:
    constants = types.ModuleType("hermes_constants")
    constants.get_default_hermes_root = lambda: str(RUNTIME / "hermes")
    constants.named_profile_is_deleted = lambda _: False
    sys.modules["hermes_constants"] = constants
data = importlib.import_module("test_routines_plugin.data")
routines = importlib.import_module("test_routines_plugin.routines")
threads = importlib.import_module("test_routines_plugin.threads")
outbox = importlib.import_module("test_routines_plugin.outbox")

_MISSING = object()


class FakeJobs:
    """Hermes's cron.jobs: one store per profile home, chosen by use_cron_store."""

    def __init__(self):
        self.stores: dict[Path, dict[str, dict]] = {}
        self.current: Path | None = None
        self.calls: list[tuple] = []
        self.extras: list[dict] = []
        self.next_id = 0

    @contextlib.contextmanager
    def use_cron_store(self, home):
        previous, self.current = self.current, Path(home)
        try:
            yield
        finally:
            self.current = previous

    def _store(self) -> dict[str, dict]:
        assert self.current is not None, "cron store used outside use_cron_store"
        return self.stores.setdefault(self.current, {})

    def add(self, home: Path, **job) -> dict:
        self.next_id += 1
        job = {"id": f"job{self.next_id}", "enabled": True, "state": "scheduled", **job}
        self.stores.setdefault(home, {})[job["id"]] = job
        return job

    def list_jobs(self, include_disabled=False):
        return list(self._store().values())

    def get_job(self, job_id):
        return self._store().get(job_id)

    def create_job(self, prompt, schedule, name, deliver, **extra):
        self.calls.append(("create", self.current.name, name, schedule, deliver))
        self.extras.append(extra)
        self.next_id += 1
        job = {"id": f"job{self.next_id}", "name": name, "prompt": prompt, "schedule": {"kind": "cron", "expr": schedule}, "deliver": deliver, "enabled": True}
        if extra.pop("paused", False):
            job.update(enabled=False, state="paused")
        job.update(extra)
        self._store()[job["id"]] = job
        return job

    def update_job(self, job_id, changes):
        self.calls.append(("update", job_id, dict(changes)))
        if isinstance(changes.get("schedule"), str):  # Hermes stores the parsed schedule
            changes = {**changes, "schedule": self.parse_schedule(changes["schedule"])}
        self._store()[job_id].update(changes)

    def pause_job(self, job_id, reason=""):
        self.calls.append(("pause", job_id))
        self._store()[job_id]["state"] = "paused"

    def resume_job(self, job_id):
        self.calls.append(("resume", job_id))
        self._store()[job_id].update(state="scheduled", enabled=True)

    def trigger_job(self, job_id):
        self.calls.append(("trigger", job_id))
        if self._store()[job_id].get("state") == "completed":
            raise ValueError(f"Cannot run: job '{job_id}' is completed (terminal). Create a new occurrence with 'hermes cron resume {job_id} --run-now'.")

    def remove_job(self, job_id):
        self.calls.append(("remove", job_id))
        del self._store()[job_id]

    def _job_output_dir(self, job_id):
        return self.current / "cron" / "output" / job_id

    def parse_schedule(self, expr):
        if "bad" in expr:
            raise ValueError("unrecognised field")
        return {"kind": "cron", "expr": expr}


def fake_module(test: unittest.TestCase, name: str, **attrs) -> types.ModuleType:
    """Put a fake Hermes module in sys.modules for one test; whatever was there comes back afterwards."""
    module = types.ModuleType(name)
    module.__dict__.update(attrs)
    old = sys.modules.get(name, _MISSING)
    sys.modules[name] = module

    def restore():
        if old is _MISSING:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = old

    test.addCleanup(restore)
    return module


class ScheduleWordsTests(unittest.TestCase):
    def test_cron_expressions_in_plain_words(self):
        cases = [
            ({"expr": "30 7 * * *"}, {"kind": "daily", "time": "07:30", "text": "Every day at 07:30"}),
            ({"expr": "0 9 * * 1-5"}, {"kind": "weekdays", "time": "09:00", "text": "Weekdays at 09:00"}),
            ({"expr": "15 18 * * 5,1,1"}, {"kind": "weekly", "time": "18:15", "days": [1, 5], "text": "Mon, Fri at 18:15"}),
            ({"expr": "0 */3 * * *"}, {"kind": "hourly", "every": 3, "text": "Every 3 hours"}),
            ({"expr": "0 */1 * * *"}, {"kind": "hourly", "every": 1, "text": "Every hour"}),
            ({"expr": "15 9 1 * *"}, {"kind": "custom", "cron": "15 9 1 * *", "text": "Monthly on the 1st at 09:15"}),
            ({"expr": "*/5 * * * *"}, {"kind": "custom", "cron": "*/5 * * * *", "text": "*/5 * * * *"}),
            ({"display": "every 2h"}, {"kind": "custom", "cron": "every 2h", "text": "every 2h"}),
            (None, {"kind": "custom", "cron": "", "text": ""}),
        ]
        for schedule, expected in cases:
            with self.subTest(schedule=schedule):
                self.assertEqual(routines.describe_schedule(schedule), expected)

    def test_intervals(self):
        self.assertEqual(routines.describe_schedule({"kind": "interval", "minutes": 60}), {"kind": "hourly", "every": 1, "text": "Every hour"})
        self.assertEqual(routines.describe_schedule({"kind": "interval", "minutes": 180})["text"], "Every 3 hours")
        self.assertEqual(routines.describe_schedule({"kind": "interval", "minutes": 45}), {"kind": "custom", "cron": "every 45m", "text": "Every 45 minutes"})
        self.assertEqual(routines.describe_schedule({"kind": "interval", "minutes": 0, "display": "odd"})["text"], "odd")

    def test_monthly_ordinals(self):
        for day, suffix in ((2, "2nd"), (3, "3rd"), (11, "11th"), (12, "12th"), (13, "13th"), (21, "21st"), (22, "22nd"), (31, "31st")):
            with self.subTest(day=day):
                self.assertIn(f"on the {suffix} at", routines.describe_schedule({"expr": f"0 6 {day} * *"})["text"])


class ScheduleExprTests(unittest.TestCase):
    def test_plain_parts_become_cron(self):
        cases = [
            ({"kind": "daily", "time": "8:05"}, "5 8 * * *"),
            ({"kind": "weekdays", "time": "23:59"}, "59 23 * * 1-5"),
            ({"kind": "weekly", "time": "07:00", "days": [5, "1", 1, 7, -1, "x", "0"]}, "0 7 * * 0,1,5"),
            ({"kind": "hourly", "every": 1}, "0 * * * *"),
            ({"kind": "hourly", "every": "6"}, "0 */6 * * *"),
        ]
        for spec, expected in cases:
            with self.subTest(spec=spec):
                self.assertEqual(routines.schedule_expr(spec), expected)

    def test_every_expression_reads_back_as_what_was_chosen(self):
        for spec in (
            {"kind": "daily", "time": "06:45"},
            {"kind": "weekdays", "time": "12:00"},
            {"kind": "weekly", "time": "21:30", "days": [0, 6]},
            {"kind": "hourly", "every": 4},
        ):
            with self.subTest(spec=spec):
                described = routines.describe_schedule({"expr": routines.schedule_expr(spec)})
                self.assertEqual({k: described[k] for k in spec}, spec)

    def test_refusals(self):
        cases = [
            ({"kind": "daily", "time": "24:00"}, "Pick a time"),
            ({"kind": "daily", "time": "8:5"}, "Pick a time"),
            ({"kind": "daily"}, "Pick a time"),
            ({"kind": "weekly", "time": "08:00", "days": [9, "x"]}, "Pick at least one day"),
            ({"kind": "hourly", "every": 0}, "Every 1 to 24 hours"),
            ({"kind": "hourly", "every": 25}, "Every 1 to 24 hours"),
            ({"kind": "custom", "cron": "   "}, "Write a schedule"),
            ({"kind": "yearly"}, "Choose when it runs"),
            ({}, "Choose when it runs"),
        ]
        for spec, message in cases:
            with self.subTest(spec=spec):
                with self.assertRaises(routines.RoutineError) as caught:
                    routines.schedule_expr(spec)
                self.assertIn(message, str(caught.exception))

    def test_custom_schedules_are_checked_by_hermes(self):
        jobs = FakeJobs()
        fake_module(self, "cron", jobs=jobs)
        self.assertEqual(routines.schedule_expr({"kind": "custom", "cron": "  30  7 * *   1-5 "}), "30 7 * * 1-5")
        with self.assertRaises(routines.RoutineError) as caught:
            routines.schedule_expr({"kind": "custom", "cron": "bad schedule"})
        self.assertEqual(str(caught.exception), "That schedule isn't valid: unrecognised field")


class RoutineTestCase(unittest.TestCase):
    def setUp(self):
        RUNTIME.mkdir(parents=True, exist_ok=True)
        temp = tempfile.TemporaryDirectory(dir=RUNTIME)
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.chief = self.root / "profiles" / "chief"
        self.ada = self.root / "profiles" / "ada"
        for home in (self.chief, self.ada):
            home.mkdir(parents=True)
            (home / "config.yaml").write_text("model: {}\n", encoding="utf-8")
        (self.ada / "profile.yaml").write_text(yaml.safe_dump({"ui_meta": {"hermes-bots": {"title": "Ada - Research"}}}), encoding="utf-8")
        (self.root / "profiles" / "loose-folder").mkdir()  # no config.yaml: not a bot
        root = patch.object(data, "install_root", lambda: self.root)
        root.start()
        self.addCleanup(root.stop)
        env = patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("COMMAND_CENTER_HOME_CHANNEL", None)
        outbox._cache.update(path="", offset=0, rows=[], times=[])
        self.jobs = FakeJobs()
        fake_module(self, "cron", jobs=self.jobs)

    def thread(self) -> str:
        return threads.create("Research")["thread"]["id"]

    def mapping(self, name=routines._THREADS_FILE) -> dict:
        return json.loads((self.chief / name).read_text(encoding="utf-8"))


class BotTests(RoutineTestCase):
    def test_bots_are_profiles_with_a_config(self):
        self.assertEqual([name for name, _ in routines._homes()], ["chief", "ada"])
        self.assertEqual(routines._home(" ADA "), self.ada)
        self.assertEqual(routines._home(""), self.chief)
        for name in ("loose-folder", "../chief", "ghost"):
            with self.subTest(name=name):
                with self.assertRaises(routines.RoutineError):
                    routines._home(name)


class CreateTests(RoutineTestCase):
    def test_names_prompts_and_threads_are_checked(self):
        daily = {"kind": "daily", "time": "08:00"}
        cases = [
            (("chief", "", "Do it", daily), "short name"),
            (("chief", "n" * 61, "Do it", daily), "short name"),
            (("chief", "Second Brain: mine", "Do it", daily), "app's own routines"),
            (("chief", "Fleet: check", "Do it", daily), "app's own routines"),
            (("chief", "Digest", "  ", daily), "Say what it should do"),
            (("chief", "Digest", "p" * (routines._MAX_PROMPT + 1), daily), "Say what it should do"),
            (("chief", "Digest", "Do it", {"kind": "daily"}), "Pick a time"),
            (("ghost", "Digest", "Do it", daily), "Unknown bot"),
        ]
        for args, message in cases:
            with self.subTest(args=[str(a)[:20] for a in args]):
                with self.assertRaises(routines.RoutineError) as caught:
                    routines.create(*args)
                self.assertIn(message, str(caught.exception))
        with self.assertRaises(routines.RoutineError):
            routines.create("chief", "Digest", "Do it", daily, thread="t-abcdef12")  # well-formed but unknown
        with self.assertRaises(routines.RoutineError):
            routines.create("chief", "Digest", "Do it", daily, thread="../main")
        self.assertEqual(self.jobs.calls, [])

    def test_a_chief_routine_delivers_to_its_thread(self):
        main = routines.create("chief", "  Morning   digest ", "Summarise the inbox.", {"kind": "weekdays", "time": "07:30"})
        self.assertEqual(self.jobs.calls[-1], ("create", "chief", "Morning digest", "30 7 * * 1-5", "command_center"))
        self.assertEqual(main["routine"]["thread"], "main")
        self.assertEqual(main["routine"]["schedule"]["text"], "Weekdays at 07:30")
        thread = self.thread()
        result = routines.create("chief", "Evening digest", "Summarise.", {"kind": "daily", "time": "18:00"}, thread=thread)
        self.assertEqual(self.jobs.calls[-1][-1], f"command_center:owner.{thread}")
        self.assertEqual(result["routine"]["thread"], thread)
        self.assertFalse(result["routine"]["silent"])

    def test_a_bot_routine_is_local_and_relayed_into_its_thread(self):
        thread = self.thread()
        result = routines.create("ada", "Papers", "Find new papers.", {"kind": "hourly", "every": 6}, thread=thread)
        self.assertEqual(self.jobs.calls[-1], ("create", "ada", "Papers", "0 */6 * * *", "local"))
        routine = result["routine"]
        self.assertEqual((routine["profile"], routine["bot"], routine["thread"]), ("ada", "Ada", thread))
        key = f"ada/{routine['id']}"
        self.assertEqual(self.mapping(), {key: thread})
        self.assertEqual(self.mapping(routines._RELAYED_FILE), {key: ""})


class OptionsTests(RoutineTestCase):
    """Hermes 0.22's routine options: made paused, pinned to a model, failure alerts muted."""

    def setUp(self):
        super().setUp()
        (self.ada / "config.yaml").write_text("model:\n  provider: openrouter\n  default: example/model-a\n", encoding="utf-8")
        (self.chief / "config.yaml").write_text("model:\n  provider: anthropic\n  default: example/chief-model\n", encoding="utf-8")
        data.forget_yaml(self.ada / "config.yaml")
        data.forget_yaml(self.chief / "config.yaml")

    def test_a_routine_follows_the_bots_model_unless_pinned(self):
        made = routines.create("ada", "Papers", "Find papers.", {"kind": "daily", "time": "08:00"})["routine"]
        self.assertEqual(self.jobs.extras[-1], {})
        self.assertEqual(made["model"], {"pinned": False, "model": "example/model-a", "provider": "openrouter"})
        self.assertEqual((made["enabled"], made["failureAlerts"]), (True, "on"))

    def test_a_bots_routine_pins_the_bots_own_model_not_the_chiefs(self):
        made = routines.create("ada", "Papers", "Find papers.", {"kind": "daily", "time": "08:00"}, paused=True, pin=True, alerts="muted")["routine"]
        extra = self.jobs.extras[-1]
        self.assertEqual((extra["model"], extra["provider"], extra["failure_deliver"]), ("example/model-a", "openrouter", "local"))
        self.assertIn("start it when you're ready", extra["paused_reason"])
        self.assertEqual(made["model"], {"pinned": True, "model": "example/model-a", "provider": "openrouter"})
        self.assertEqual((made["enabled"], made["failureAlerts"]), (False, "muted"))
        self.assertIn("start it", made["pausedReason"])

    def test_pin_release_and_alerts_change_later(self):
        job = routines.create("ada", "Papers", "Find papers.", {"kind": "daily", "time": "08:00"})["routine"]
        pinned = routines.update("ada", job["id"], pin=True)["routine"]
        self.assertEqual(self.jobs.calls[-1], ("update", job["id"], {"model": "example/model-a", "provider": "openrouter"}))
        self.assertTrue(pinned["model"]["pinned"])
        routines.update("ada", job["id"], pin=False, alerts="muted")
        self.assertEqual(self.jobs.calls[-1], ("update", job["id"], {"model": None, "provider": None, "failure_deliver": "local"}))
        routines.update("ada", job["id"], alerts="on")
        self.assertEqual(self.jobs.calls[-1], ("update", job["id"], {"failure_deliver": None}))
        with self.assertRaises(routines.RoutineError):
            routines.update("ada", job["id"], alerts="loud")

    def test_nothing_to_pin_without_a_model(self):
        (self.ada / "config.yaml").write_text("model: {}\n", encoding="utf-8")
        data.forget_yaml(self.ada / "config.yaml")
        with self.assertRaisesRegex(routines.RoutineError, "nothing to pin"):
            routines.create("ada", "Papers", "Find papers.", {"kind": "daily", "time": "08:00"}, pin=True)

    def test_the_failure_streak_and_alerts_a_bot_sent_elsewhere_show(self):
        job = self.jobs.add(
            self.chief, name="Digest", prompt="p", schedule={"expr": "0 8 * * *"}, deliver="command_center", failure_deliver="telegram:5", failure_streak=3
        )
        shown = next(r for r in routines.list_routines()["routines"] if r["id"] == job["id"])
        self.assertEqual((shown["failureAlerts"], shown["failureStreak"]), ("elsewhere", 3))


class ListAndChangeTests(RoutineTestCase):
    def setUp(self):
        super().setUp()
        self.daily = self.jobs.add(self.chief, name="Zen digest", prompt="p", schedule={"expr": "0 8 * * *"}, deliver="command_center")
        self.built_in = self.jobs.add(
            self.chief, name="Second Brain: nightly", prompt="p", schedule={"expr": "0 22 * * *"}, deliver="command_center", state="paused"
        )
        self.silent = self.jobs.add(self.chief, name="alpha cleanup", prompt="p", schedule={"expr": "0 3 * * *"}, deliver="local", no_agent=True)
        self.bot = self.jobs.add(self.ada, name="Papers", prompt="p", schedule={"kind": "interval", "minutes": 120}, deliver="local")

    def test_list_orders_and_shapes_routines(self):
        out = self.ada / "cron" / "output" / self.bot["id"]
        out.mkdir(parents=True)
        (out / "2026-10-01_08-00-00.md").write_text("x" * 2000, encoding="utf-8")
        routines._set_bot_thread("ada", self.bot["id"], "main")
        result = routines.list_routines()
        self.assertEqual(result["contract"], routines.CONTRACT)
        self.assertEqual([r["name"] for r in result["routines"]], ["alpha cleanup", "Zen digest", "Papers", "Second Brain: nightly"])
        rows = {r["name"]: r for r in result["routines"]}
        self.assertTrue(rows["alpha cleanup"]["silent"])
        self.assertEqual(rows["alpha cleanup"]["kind"], "script")
        self.assertFalse(rows["Second Brain: nightly"]["enabled"], "a paused job is off")
        self.assertTrue(rows["Second Brain: nightly"]["builtIn"])
        self.assertEqual((rows["Papers"]["bot"], rows["Papers"]["thread"]), ("Ada", "main"))
        self.assertEqual(rows["Papers"]["schedule"]["text"], "Every 2 hours")
        self.assertEqual(len(rows["Papers"]["lastOutput"]), 1501)
        self.assertTrue(rows["Papers"]["lastOutput"].endswith("…"))
        self.assertEqual([b["id"] for b in result["bots"]], ["chief", "ada"])

    def test_a_built_in_routine_keeps_its_name_and_prompt(self):
        result = routines.update(
            "chief", self.built_in["id"], name="Mine now", prompt="Do something else", schedule={"kind": "daily", "time": "23:15"}, enabled=True
        )
        self.assertEqual(self.jobs.calls, [("update", self.built_in["id"], {"schedule": "15 23 * * *"}), ("resume", self.built_in["id"])])
        self.assertEqual(result["routine"]["name"], "Second Brain: nightly")
        self.assertTrue(result["routine"]["enabled"])

    def test_update_checks_its_input(self):
        for kwargs in ({"name": " "}, {"name": "Fleet: sneaky"}, {"prompt": ""}, {"schedule": {"kind": "hourly", "every": 99}}):
            with self.subTest(kwargs=kwargs):
                with self.assertRaises(routines.RoutineError):
                    routines.update("chief", self.daily["id"], **kwargs)
        with self.assertRaises(routines.RoutineError) as caught:
            routines.update("chief", "job-gone", enabled=False)
        self.assertIn("no longer exists", str(caught.exception))
        self.assertEqual(self.jobs.calls, [])

    def test_turning_off_pauses_and_moving_threads(self):
        thread = self.thread()
        routines.update("chief", self.daily["id"], thread=thread, enabled=False)
        self.assertEqual(self.jobs.calls, [("update", self.daily["id"], {"deliver": f"command_center:owner.{thread}"}), ("pause", self.daily["id"])])
        routines.update("ada", self.bot["id"], thread=thread)
        self.assertEqual(self.mapping(), {f"ada/{self.bot['id']}": thread}, "a bot's thread lives in the chief's profile")

    def test_run_now_turns_a_paused_routine_on_first(self):
        routines.run_now("chief", self.built_in["id"])
        self.assertEqual(self.jobs.calls, [("resume", self.built_in["id"]), ("trigger", self.built_in["id"])])
        self.jobs.calls.clear()
        routines.run_now("chief", self.daily["id"])
        self.assertEqual(self.jobs.calls, [("trigger", self.daily["id"])])

    def test_a_pause_hermes_made_itself_is_said_plainly(self):
        for reason in ("Canonical cron unknown; no automatic re-execution", "Cron execution unverified; reconcile C:/x/cron/admissions/a.json: boom"):
            with self.subTest(reason=reason[:20]):
                held = self.jobs.add(self.chief, name="Held", prompt="p", schedule={"kind": "cron", "expr": "0 8 * * *"}, state="paused", paused_reason=reason)
                shown = next(r for r in routines.list_routines()["routines"] if r["id"] == held["id"])
                self.assertIn("couldn't be confirmed", shown["pausedReason"])
                self.assertNotIn("reconcile", shown["pausedReason"])
        mine = self.jobs.add(self.chief, name="Mine", prompt="p", schedule={"kind": "cron", "expr": "0 8 * * *"}, state="paused", paused_reason="Back in May")
        self.assertEqual(next(r for r in routines.list_routines()["routines"] if r["id"] == mine["id"])["pausedReason"], "Back in May")

    def test_a_one_off_that_already_ran_says_so_in_words(self):
        once = self.jobs.add(self.chief, name="Once", prompt="p", schedule={"kind": "once"}, deliver="command_center", state="completed")
        with self.assertRaises(routines.RoutineError) as caught:
            routines.run_now("chief", once["id"])
        self.assertNotIn("hermes cron", str(caught.exception))
        self.assertIn("run once", str(caught.exception))

    def test_a_bots_routine_comes_back_with_its_own_last_report(self):
        out = self.ada / "cron" / "output" / self.bot["id"]
        out.mkdir(parents=True)
        (out / "2026-10-01_08-00-00.md").write_text("## Response\nTwo papers.", encoding="utf-8")
        for changed in (
            routines.run_now("ada", self.bot["id"]),
            routines.update("ada", self.bot["id"], name="Papers daily"),
        ):
            self.assertIn("Two papers.", changed["routine"]["lastOutput"])  # read from the bot's store, not the chief's

    def test_built_in_routines_cannot_be_deleted(self):
        with self.assertRaises(routines.RoutineError):
            routines.delete("chief", self.built_in["id"])
        self.assertEqual(self.jobs.calls, [])

    def test_deleting_a_bot_routine_forgets_its_thread(self):
        routines._set_bot_thread("ada", self.bot["id"], "main")
        self.assertEqual(routines.delete("ada", self.bot["id"]), {"ok": True})
        self.assertEqual(self.mapping(), {})
        self.assertEqual(self.mapping(routines._RELAYED_FILE), {})


class RelayTests(RoutineTestCase):
    def setUp(self):
        super().setUp()
        self.job = self.jobs.add(self.ada, name="Papers", prompt="p", schedule={"expr": "0 8 * * *"}, deliver="local")
        self.out = self.ada / "cron" / "output" / self.job["id"]
        self.out.mkdir(parents=True)

    def run_file(self, name, text):
        (self.out / name).write_text(text, encoding="utf-8")

    def test_answers_from_run_files(self):
        self.assertEqual(routines._answer("# Run\n## Response\n\nThree new papers."), "Three new papers.")
        self.assertIsNone(routines._answer("## Response\n[SILENT] nothing new"))
        self.assertIsNone(routines._answer("## Response\n   "))
        self.assertIn("didn't finish", routines._answer("## Error\nTraceback"))
        # A run Hermes refused before it started (0.22.5) has only its title and the reason.
        self.assertIn("didn't finish", routines._answer("# Cron Job: c3fb20e654a0 (FAILED)\n\nGatewayUnavailableError: Gateway starting\n"))
        self.assertIsNone(routines._answer("# Cron Job: Source sweep\n\nstill running"))
        self.assertIsNone(routines._answer("still running"))

    def test_nothing_to_relay_without_a_mapping(self):
        self.assertEqual(routines.relay(), 0)

    def test_a_routine_known_before_relaying_starts_from_now(self):
        self.run_file("2026-10-01_08-00-00.md", "## Response\nOld answer.")
        (self.chief / routines._THREADS_FILE).write_text(json.dumps({f"ada/{self.job['id']}": "main"}), encoding="utf-8")
        self.assertEqual(routines.relay(), 0)
        self.assertEqual(self.mapping(routines._RELAYED_FILE), {f"ada/{self.job['id']}": "2026-10-01_08-00-00.md"})
        self.assertEqual(outbox.read_outbox(), [])

    def test_new_runs_are_posted_once_into_the_thread(self):
        thread = self.thread()
        routines._set_bot_thread("ada", self.job["id"], thread)
        self.run_file("2026-10-01_08-00-00.md", "## Response\nThree new papers.")
        self.run_file("2026-10-02_08-00-00.md", "## Response\n[SILENT]")
        self.run_file("2026-10-03_08-00-00.md", "## Error\nboom")
        self.assertEqual(routines.relay(), 2)
        rows = outbox.read_outbox()
        self.assertEqual([r["chat_id"] for r in rows], [f"owner.{thread}"] * 2)
        # The answer alone; the chat titles its card from the routine (its name and bot), with Manage and Run again.
        self.assertEqual(rows[0]["message"], "Three new papers.")
        self.assertEqual(rows[0]["routine"], {"name": "Papers", "jobId": self.job["id"], "profile": "ada", "bot": "Ada"})
        self.assertNotIn("failure", rows[0])
        self.assertEqual(rows[1]["failure"]["error"], "it didn't finish")
        self.assertEqual(rows[1]["failure"]["streak"], 1)
        self.assertEqual({r["source"] for r in rows}, {"cron"})
        self.assertEqual(routines.relay(), 0, "already relayed")

    def test_the_newest_failed_run_carries_hermess_count_and_line(self):
        routines._set_bot_thread("ada", self.job["id"], "main")
        self.job.update(failure_streak=3, last_error="RuntimeError: the provider refused")
        self.run_file("2026-10-01_08-00-00.md", "## Error\nboom")
        self.run_file("2026-10-02_08-00-00.md", "## Error\nboom")
        self.assertEqual(routines.relay(), 2)
        older, newest = [r["failure"] for r in outbox.read_outbox()]
        self.assertEqual((older["streak"], newest["streak"]), (1, 3))
        self.assertEqual(newest["detail"], "RuntimeError: the provider refused")

    def test_a_run_posted_before_a_failure_is_not_posted_again(self):
        routines._set_bot_thread("ada", self.job["id"], "main")
        self.run_file("2026-10-01_08-00-00.md", "## Response\nFirst.")
        self.run_file("2026-10-02_08-00-00.md", "## Response\nSecond.")
        real = outbox.append_outbox
        calls = []

        def flaky(*args, **kwargs):
            calls.append(args[1])
            if len(calls) == 2:
                raise OSError("disk full")
            return real(*args, **kwargs)

        with patch.object(outbox, "append_outbox", flaky), self.assertLogs("chief-dashboard-bridge", level="WARNING"):
            self.assertEqual(routines.relay(), 1)
        self.assertEqual(routines.relay(), 1)
        self.assertEqual([r["message"] for r in outbox.read_outbox()], ["First.", "Second."])

    def test_a_thread_change_during_a_relay_is_kept(self):
        key = f"ada/{self.job['id']}"
        routines._set_bot_thread("ada", self.job["id"], "main")
        self.run_file("2026-10-01_08-00-00.md", "## Response\nHello.")
        reading, go_on = threading.Event(), threading.Event()
        get_job = self.jobs.get_job

        def slow(job_id):
            reading.set()
            go_on.wait(5)
            return get_job(job_id)

        other = self.jobs.add(self.ada, name="Digest", prompt="p", schedule={"expr": "0 9 * * *"}, deliver="local")
        with patch.object(self.jobs, "get_job", slow):
            relay = threading.Thread(target=routines.relay)
            relay.start()
            self.assertTrue(reading.wait(5))
            # A request moves another routine while the relay is mid-way: it waits its turn instead of being undone.
            change = threading.Thread(target=routines._set_bot_thread, args=("ada", other["id"], "main"))
            change.start()
            go_on.set()
            relay.join(5)
            change.join(5)
        self.assertEqual(self.mapping(), {key: "main", f"ada/{other['id']}": "main"})
        self.assertEqual(self.mapping(routines._RELAYED_FILE), {key: "2026-10-01_08-00-00.md", f"ada/{other['id']}": ""})

    def test_a_muted_routine_relays_its_answers_but_not_its_failures(self):
        thread = self.thread()
        routines._set_bot_thread("ada", self.job["id"], thread)
        self.job["failure_deliver"] = "local"
        self.run_file("2026-10-01_08-00-00.md", "## Error\nboom")
        self.run_file("2026-10-02_08-00-00.md", "## Response\nTwo new papers.")
        self.assertEqual(routines.relay(), 1)
        self.assertEqual(outbox.read_outbox()[0]["message"], "Two new papers.")

    def test_a_deleted_thread_falls_back_to_the_main_chat(self):
        routines._set_bot_thread("ada", self.job["id"], "t-0000ffff")
        self.run_file("2026-10-01_08-00-00.md", "## Response\nHello.")
        self.assertEqual(routines.relay(), 1)
        self.assertEqual(outbox.read_outbox()[0]["chat_id"], "owner")

    def test_a_malformed_thread_is_skipped(self):
        (self.chief / routines._THREADS_FILE).write_text(json.dumps({f"ada/{self.job['id']}": "../elsewhere"}), encoding="utf-8")
        (self.chief / routines._RELAYED_FILE).write_text(json.dumps({f"ada/{self.job['id']}": ""}), encoding="utf-8")
        self.run_file("2026-10-01_08-00-00.md", "## Response\nHello.")
        self.assertEqual(routines.relay(), 0)


if __name__ == "__main__":
    unittest.main()


class RoutineSafetyTests(unittest.TestCase):
    """A job a bot schedules that sends outside the app or runs a script asks the owner; the view says where each goes."""

    def test_where_results_go(self):
        self.assertEqual(routines.destination("command_center:abc"), ("command_center:abc", False))
        self.assertEqual(routines.destination(None), ("local", False))
        self.assertEqual(routines.destination("origin"), ("origin", False))
        self.assertEqual(routines.destination("telegram:123"), ("telegram:123", True))
        self.assertEqual(routines.destination(["command_center", "discord:9"]), ("command_center,discord:9", True))

    def test_only_risky_jobs_ask(self):
        reminder = {"action": "create", "name": "Stretch", "schedule": "every day at 10:00", "prompt": "Remind me to stretch", "deliver": "command_center"}
        self.assertIsNone(routines.approval_for("cronjob_manage", reminder))
        self.assertIsNone(routines.approval_for("cronjob_manage", {"action": "list"}))
        out = routines.approval_for("cronjob_manage", {**reminder, "deliver": "telegram:555", "prompt": "Summarize the inbox"})
        self.assertEqual(out["action"], "approve")
        self.assertIn("sends its results to telegram:555", out["message"])
        self.assertIn("Summarize the inbox", out["message"])
        self.assertTrue(out["rule_key"].startswith("chief:routine:"))
        alerts = routines.approval_for("cronjob_manage", {"action": "update", "job_id": "j1", "failure_deliver": "discord:42"})
        self.assertIn("sends its failure alerts to discord:42", alerts["message"])
        self.assertIsNone(routines.approval_for("cronjob_manage", {"action": "update", "job_id": "j1", "failure_deliver": "local"}))  # muting stays in the app
        scripted = routines.approval_for("cronjob_manage", {"action": "update", "job_id": "j1", "script": "collect.py"})
        self.assertIn("runs the script collect.py", scripted["message"])
        self.assertIsNone(routines.approval_for("terminal", reminder))
