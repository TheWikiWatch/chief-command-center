"""The Second Brain folder (second_brain.py): routine times, folder checks, format detection, create-only setup and routine changes."""

import contextlib
import importlib
import json
import sys
import tempfile
import types
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "hermes/plugins/chief-dashboard-bridge"
RUNTIME = ROOT / "hermes/tests/.runtime"
package = types.ModuleType("test_second_brain_plugin")
package.__path__ = [str(PLUGIN)]
sys.modules.setdefault(package.__name__, package)
if "hermes_constants" not in sys.modules:
    constants = types.ModuleType("hermes_constants")
    constants.get_default_hermes_root = lambda: str(RUNTIME / "hermes")
    constants.named_profile_is_deleted = lambda _: False
    sys.modules["hermes_constants"] = constants
data = importlib.import_module("test_second_brain_plugin.data")
persona = importlib.import_module("test_second_brain_plugin.persona")
second_brain = importlib.import_module("test_second_brain_plugin.second_brain")

_MISSING = object()
POINTER_TO_AGENTS = "# Rules for agents\n\nThis Second Brain's rules are in [[AGENTS]].\n"


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


class TimeOfTests(unittest.TestCase):
    def test_time_of_day_from_cron(self):
        cases = [
            ({"expr": "0 22 * * *"}, "22:00"),
            ({"expr": "5 8 * * 1-5"}, "08:05"),
            ({"expr": "30 18 * * 5"}, "18:30"),
            ({"expr": "5,35 * * * *"}, ""),
            ({"expr": "*/15 * * * *"}, ""),
            ({"expr": "0 8 * *"}, ""),
            ({"expr": ""}, ""),
            ({}, ""),
            (None, ""),
        ]
        for schedule, expected in cases:
            with self.subTest(schedule=schedule):
                self.assertEqual(second_brain._time_of(schedule), expected)

    def test_every_built_in_routine_but_the_drop_folder_has_a_time(self):
        for routine in second_brain.ROUTINES + second_brain.WIKI_ROUTINES:
            with self.subTest(routine=routine["id"]):
                self.assertEqual(bool(second_brain._time_of({"expr": routine["schedule"]})), routine["id"] != "drop")


class SecondBrainTestCase(unittest.TestCase):
    def setUp(self):
        RUNTIME.mkdir(parents=True, exist_ok=True)
        temp = tempfile.TemporaryDirectory(dir=RUNTIME)
        self.addCleanup(temp.cleanup)
        base = Path(temp.name).resolve()
        self.root = base / "hermes"
        self.chief = self.root / "profiles" / "chief"
        self.chief.mkdir(parents=True)
        self.vault = base / "Second Brain"
        for target, name, value in (
            (data, "install_root", lambda: self.root),
            (persona, "profile_scope", lambda home: contextlib.nullcontext()),
            (second_brain, "default_folder", lambda: str(base / "Documents" / "Second Brain")),
        ):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.env: dict[str, str] = {}
        self.config: dict = {}
        self.config_writes: list[tuple] = []
        fake_module(self, "hermes_cli")
        fake_module(
            self,
            "hermes_cli.config",
            load_env=lambda: dict(self.env),
            save_env_value=lambda key, value: self.env.__setitem__(key, value),
            remove_env_value=lambda key: self.env.pop(key, None),
            load_config=lambda: self.config,
        )

        def save_config_value(key, value):
            self.config_writes.append((key, value))
            section, _, leaf = key.partition(".")
            self.config.setdefault(section, {})[leaf] = value
            return True

        fake_module(self, "cli", save_config_value=save_config_value)


class CleanPathTests(SecondBrainTestCase):
    def refused(self, raw: str, message: str):
        with self.assertRaises(second_brain.SecondBrainError) as caught:
            second_brain._clean_path(raw)
        self.assertIn(message, str(caught.exception))

    def test_empty_relative_and_drive_paths_are_refused(self):
        self.refused("", "Choose a folder")
        self.refused('  ""  ', "Choose a folder")
        self.refused("notes\0evil", "Choose a folder")
        self.refused("relative/notes", "full folder path")
        self.refused(self.vault.anchor, "not a whole drive")

    def test_chiefs_own_folders_and_their_parents_are_refused(self):
        self.refused(str(self.chief / "notes"), "belongs to the system or to Chief")
        self.refused(str(self.root), "belongs to the system or to Chief")
        self.refused(str(self.root.parent), "belongs to the system or to Chief")

    def test_a_folder_of_the_owners_is_accepted(self):
        self.assertEqual(second_brain._clean_path(f'  "{self.vault}"  '), self.vault)
        self.assertEqual(second_brain._clean_path(str(self.vault / "sub" / ".." / "notes")), self.vault / "notes")


class FormatTests(SecondBrainTestCase):
    def setUp(self):
        super().setUp()
        self.vault.mkdir()

    def test_an_empty_or_missing_folder_has_no_format(self):
        self.assertIsNone(second_brain.detect_format(self.vault))
        self.assertIsNone(second_brain.detect_format(self.vault / "missing"))
        self.assertEqual(second_brain.manual(self.vault), "")
        self.assertIsNone(second_brain._ours(self.vault))

    def test_wiki_and_para_layouts_are_recognised(self):
        (self.vault / "wiki").mkdir()
        (self.vault / "raw").mkdir()
        self.assertEqual(second_brain.detect_format(self.vault), "wiki")
        other = self.vault.parent / "para"
        (other / "10 Projects").mkdir(parents=True)
        self.assertEqual(second_brain.detect_format(other), "para")

    def test_a_rules_file_describing_a_wiki_counts(self):
        (self.vault / "_CLAUDE.md").write_text("Sources go in raw/, pages in wiki/.", encoding="utf-8")
        self.assertEqual(second_brain.manual(self.vault), "_CLAUDE.md")
        self.assertEqual(second_brain.detect_format(self.vault, "_CLAUDE.md"), "wiki")

    def test_the_apps_pointer_file_is_not_the_folders_own_rules(self):
        (self.vault / "_CLAUDE.md").write_text(POINTER_TO_AGENTS, encoding="utf-8")
        self.assertEqual(second_brain.manual(self.vault), "")
        (self.vault / "AGENTS.md").write_text("# House rules\n", encoding="utf-8")
        self.assertEqual(second_brain.manual(self.vault), "AGENTS.md")
        (self.vault / "40 Knowledge").mkdir()
        (self.vault / "40 Knowledge" / "SCHEMA.md").write_text("schema", encoding="utf-8")
        self.assertEqual(second_brain._ours(self.vault), "para")

    def test_a_long_file_mentioning_the_target_is_not_a_pointer(self):
        (self.vault / "_CLAUDE.md").write_text(POINTER_TO_AGENTS + "x" * 900, encoding="utf-8")
        self.assertEqual(second_brain.manual(self.vault), "_CLAUDE.md")


class InspectTests(SecondBrainTestCase):
    def test_a_new_folder_offers_the_full_layout(self):
        found = second_brain.inspect(str(self.vault))
        manifest = second_brain._manifest("para")
        self.assertFalse(found["exists"])
        self.assertTrue(found["empty"] and found["writable"])
        self.assertEqual((found["format"], found["choices"]), ("para", ["new"]))
        self.assertEqual(found["plans"]["new"], {"folders": manifest["folders"], "files": manifest["files"], "existing": []})

    def test_a_folder_with_notes_is_kept_or_reorganised(self):
        (self.vault / "Projects").mkdir(parents=True)
        (self.vault / "Projects" / "Garden.md").write_text("# Garden", encoding="utf-8")
        (self.vault / "index.md").write_text("# Mine", encoding="utf-8")
        (self.vault / "photo.png").write_bytes(b"png")
        (self.vault / ".obsidian").mkdir()
        (self.vault / ".obsidian" / "app.json").write_text("{}", encoding="utf-8")
        found = second_brain.inspect(str(self.vault), "wiki")
        self.assertEqual((found["notes"], found["files"], found["top_folders"]), (2, 3, ["Projects"]), "hidden folders aren't counted")
        self.assertTrue(found["obsidian"])
        self.assertEqual(found["choices"], ["keep", "reorganize"])
        self.assertEqual(found["format"], "wiki")
        self.assertIn("index.md", found["plans"]["keep"]["existing"])
        self.assertNotIn("index.md", found["plans"]["keep"]["files"])

    def test_a_folder_with_its_own_rules_gets_nothing_added(self):
        self.vault.mkdir()
        (self.vault / "AGENTS.md").write_text("# How I file things\n", encoding="utf-8")
        found = second_brain.inspect(str(self.vault))
        self.assertEqual(found["manual"], "AGENTS.md")
        self.assertEqual(found["plans"]["keep"], {"folders": [], "files": [], "existing": []})

    def test_a_file_is_not_a_folder(self):
        self.vault.parent.mkdir(parents=True, exist_ok=True)
        self.vault.write_text("not a folder", encoding="utf-8")
        with self.assertRaises(second_brain.SecondBrainError):
            second_brain.inspect(str(self.vault))


class SetupTests(SecondBrainTestCase):
    def test_bad_modes_and_formats_are_refused(self):
        for mode, fmt in (("", None), ("wipe", None), ("new", "zettel")):
            with self.subTest(mode=mode, fmt=fmt):
                with self.assertRaises(second_brain.SecondBrainError):
                    second_brain.setup(str(self.vault), mode, fmt=fmt)
        self.assertFalse(self.vault.exists())

    def test_the_mode_must_suit_the_folder(self):
        with self.assertRaises(second_brain.SecondBrainError) as caught:
            second_brain.setup(str(self.vault), "keep")
        self.assertIn("empty", str(caught.exception))
        self.vault.mkdir()
        (self.vault / "Ideas.md").write_text("# Ideas", encoding="utf-8")
        with self.assertRaises(second_brain.SecondBrainError) as caught:
            second_brain.setup(str(self.vault), "new")
        self.assertIn("already has notes", str(caught.exception))

    def test_a_new_second_brain_is_written_once_and_chief_pointed_at_it(self):
        result = second_brain.setup(str(self.vault), "new", today=date(2026, 3, 1))
        manifest = second_brain._manifest("para")
        self.assertEqual((result["format"], result["rules"], result["own_rules"], result["routines_on"]), ("para", "AGENTS.md", False, True))
        self.assertEqual(sorted(result["created"]), sorted([f + "/" for f in manifest["folders"]] + manifest["files"]))
        self.assertEqual(result["kept"], [])
        self.assertEqual(result["next_prompt"], "")
        facts = (self.vault / "CRITICAL_FACTS.md").read_text(encoding="utf-8")
        self.assertIn("date: 2026-03-01", facts)
        self.assertNotIn("{{", facts)
        self.assertEqual(self.env["OBSIDIAN_VAULT_PATH"], str(self.vault))
        self.assertEqual(self.env["WIKI_PATH"], str(self.vault / "40 Knowledge"))
        self.assertEqual(self.env["OBSIDIAN_ENV_FILE"], str(self.chief / "obsidian-second-brain.env"))
        skill = second_brain._skill_path(self.chief).read_text(encoding="utf-8")
        self.assertIn(str(self.vault), skill)
        self.assertNotIn("{{", skill)
        self.assertIn(("skills.auto_load", ["second-brain"]), self.config_writes)
        state = json.loads((self.chief / second_brain.STATE_FILE).read_text(encoding="utf-8"))
        self.assertEqual((state["path"], state["mode"], state["format"], state["routines"]), (str(self.vault), "new", "para", []))
        self.assertEqual(second_brain._ours(self.vault), "para")

        (self.vault / "CRITICAL_FACTS.md").write_text("- **Owner:** Ada\n", encoding="utf-8")
        again = second_brain.setup(str(self.vault), "new")
        self.assertEqual(again["created"], [])
        self.assertEqual(sorted(again["kept"]), sorted(manifest["files"]))
        self.assertEqual((self.vault / "CRITICAL_FACTS.md").read_text(encoding="utf-8"), "- **Owner:** Ada\n", "an existing file is never overwritten")
        self.assertEqual(self.config_writes.count(("skills.auto_load", ["second-brain"])), 1, "auto-load is added once")

    def test_a_folder_with_its_own_rules_is_used_as_it_is(self):
        self.vault.mkdir()
        (self.vault / "AGENTS.md").write_text("# How I file things\n", encoding="utf-8")
        (self.vault / "Notes.md").write_text("# Notes", encoding="utf-8")
        result = second_brain.setup(str(self.vault), "keep")
        self.assertEqual((result["rules"], result["own_rules"], result["routines_on"], result["created"]), ("AGENTS.md", True, False, []))
        self.assertIn("AGENTS.md", result["next_prompt"])
        self.assertEqual(sorted(p.name for p in self.vault.iterdir()), ["AGENTS.md", "Notes.md"])


class CriticalFactsTests(SecondBrainTestCase):
    def test_missing_empty_and_trimmed(self):
        self.vault.mkdir()
        self.assertIn("No `CRITICAL_FACTS.md` yet", second_brain.critical_facts(self.vault))
        facts = self.vault / "CRITICAL_FACTS.md"
        facts.write_text("---\ntype: critical-facts\n---\n", encoding="utf-8")
        self.assertIn("is empty", second_brain.critical_facts(self.vault))
        facts.write_text("---\ntype: x\n---\n\n## For future agent\nKeep this short.\n\n- **Owner:** Ada\n- **Where:** UTC\n", encoding="utf-8")
        self.assertEqual(second_brain.critical_facts(self.vault), "- **Owner:** Ada\n- **Where:** UTC")

    def test_long_facts_are_cut_at_a_line(self):
        self.vault.mkdir()
        (self.vault / "CRITICAL_FACTS.md").write_text("".join(f"- fact number {i:04d}\n" for i in range(400)), encoding="utf-8")
        text = second_brain.critical_facts(self.vault)
        self.assertTrue(text.endswith("_(cut: keep `CRITICAL_FACTS.md` short)_"))
        self.assertLess(len(text), second_brain._FACTS_MAX + 60)
        self.assertTrue(text.splitlines()[-2].startswith("- fact number"))


class FakeCron:
    def __init__(self, jobs):
        self.jobs = {j["id"]: j for j in jobs}
        self.calls: list[tuple] = []

    def use_cron_store(self, home):
        return contextlib.nullcontext()

    def list_jobs(self, include_disabled=False):
        return list(self.jobs.values())

    def update_job(self, job_id, changes):
        self.calls.append(("update", job_id, changes))
        if "schedule" in changes:
            self.jobs[job_id]["schedule"] = {"expr": changes["schedule"]}

    def pause_job(self, job_id, reason=""):
        self.calls.append(("pause", job_id))
        self.jobs[job_id]["state"] = "paused"

    def resume_job(self, job_id):
        self.calls.append(("resume", job_id))
        self.jobs[job_id]["state"] = "scheduled"


class RoutineTests(SecondBrainTestCase):
    def setUp(self):
        super().setUp()
        self.cron = FakeCron(
            [
                {"id": "j1", "name": "Second Brain: nightly", "schedule": {"expr": "15 23 * * *"}, "enabled": True, "state": "scheduled", "last_status": "ok"},
                {"id": "j2", "name": "Second Brain: weekly review", "schedule": {"expr": "0 18 * * 5"}, "enabled": True, "state": "paused"},
                {"id": "j3", "name": "Second Brain: drop folder", "schedule": {"expr": "5,35 * * * *"}, "enabled": True, "state": "scheduled"},
                {"id": "j4", "name": "Someone else's job", "schedule": {"expr": "0 1 * * *"}, "enabled": True},
            ]
        )
        fake_module(self, "cron", jobs=self.cron)

    def test_routines_show_their_state_and_time(self):
        items = {r["id"]: r for r in second_brain.routines()["routines"]}
        self.assertEqual(list(items), ["morning", "nightly", "weekly", "health"], "no vault set up: the PARA routines")
        self.assertEqual((items["nightly"]["time"], items["nightly"]["enabled"], items["nightly"]["last_status"]), ("23:15", True, "ok"))
        self.assertFalse(items["weekly"]["enabled"], "paused")
        self.assertEqual((items["morning"]["exists"], items["morning"]["time"], items["morning"]["days"]), (False, "08:00", "Every day"))
        self.assertEqual(items["health"]["days"], "Sundays")

    def test_a_wiki_vault_lists_its_own_routines(self):
        self.vault.mkdir()
        (self.vault / "wiki").mkdir()
        (self.vault / "raw").mkdir()
        self.env["OBSIDIAN_VAULT_PATH"] = str(self.vault)
        items = {r["id"]: r for r in second_brain.routines()["routines"]}
        self.assertEqual(list(items), ["morning", "nightly", "weekly", "health", "drop", "brief"])
        self.assertEqual((items["drop"]["time"], items["drop"]["days"]), ("", "Every 30 minutes"))
        self.assertIn("Current Analysis", items["nightly"]["about"])

    def test_set_routine_checks_its_input(self):
        cases = [
            (("dawn",), {}, "Unknown routine"),
            (("drop",), {"at": "09:00"}, "every half hour"),
            (("nightly",), {"at": "25:00"}, "Use a time like 08:30"),
            (("nightly",), {"at": "late"}, "Use a time like 08:30"),
            (("morning",), {"enabled": True}, "Set up the Second Brain first"),
        ]
        for args, kwargs, message in cases:
            with self.subTest(args=args, kwargs=kwargs):
                with self.assertRaises(second_brain.SecondBrainError) as caught:
                    second_brain.set_routine(*args, **kwargs)
                self.assertIn(message, str(caught.exception))
        self.assertEqual(self.cron.calls, [])

    def test_a_new_time_keeps_the_days(self):
        result = second_brain.set_routine("weekly", at=" 7:05 ", enabled=True)
        self.assertEqual(self.cron.calls, [("update", "j2", {"schedule": "5 7 * * 5"}), ("resume", "j2")])
        weekly = next(r for r in result["routines"] if r["id"] == "weekly")
        self.assertEqual((weekly["time"], weekly["enabled"]), ("07:05", True))

    def test_switching_off(self):
        second_brain.set_routine("nightly", enabled=False)
        self.assertEqual(self.cron.calls, [("pause", "j1")])


if __name__ == "__main__":
    unittest.main()
