"""Team & Routines (routines.py): schedules in plain words, cron expressions, validation, built-in guards and relaying bot runs."""

import contextlib
import importlib
import json
import os
import sys
import tempfile
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

    def create_job(self, prompt, schedule, name, deliver):
        self.calls.append(("create", self.current.name, name, schedule, deliver))
        self.next_id += 1
        job = {"id": f"job{self.next_id}", "name": name, "prompt": prompt, "schedule": {"kind": "cron", "expr": schedule}, "deliver": deliver, "enabled": True}
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
        self.assertTrue(rows[0]["message"].startswith("Routine: Papers (Ada)"))
        self.assertTrue(rows[0]["message"].endswith("Three new papers."))
        self.assertEqual({r["source"] for r in rows}, {"cron"})
        self.assertEqual(routines.relay(), 0, "already relayed")

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
