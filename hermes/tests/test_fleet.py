"""The workforce (fleet.py): roster, mint and retire guards, archives and restore, model pinning and the chief's tools."""

import contextlib
import importlib
import json
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
package = types.ModuleType("test_fleet_plugin")
package.__path__ = [str(PLUGIN)]
sys.modules.setdefault(package.__name__, package)
if "hermes_constants" not in sys.modules:
    constants = types.ModuleType("hermes_constants")
    constants.get_default_hermes_root = lambda: str(RUNTIME / "hermes")
    constants.named_profile_is_deleted = lambda _: False
    sys.modules["hermes_constants"] = constants
data = importlib.import_module("test_fleet_plugin.data")
persona = importlib.import_module("test_fleet_plugin.persona")
providers = importlib.import_module("test_fleet_plugin.providers")
second_brain = importlib.import_module("test_fleet_plugin.second_brain")
fleet = importlib.import_module("test_fleet_plugin.fleet")

_MISSING = object()
SOUL = "You are Nova, the planner. You keep the week on track."


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


def write_yaml(path: Path, value: dict) -> None:
    path.write_text(yaml.safe_dump(value), encoding="utf-8")


class FleetTestCase(unittest.TestCase):
    def setUp(self):
        RUNTIME.mkdir(parents=True, exist_ok=True)
        temp = tempfile.TemporaryDirectory(dir=RUNTIME)
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.profiles = self.root / "profiles"
        self.chief = self.profiles / "chief"
        self.chief.mkdir(parents=True)
        write_yaml(self.chief / "config.yaml", {"model": {"provider": "nova", "default": "nova-small"}})
        self.ada = self.profiles / "ada"
        self.ada.mkdir()
        write_yaml(self.ada / "profile.yaml", {"description": "Finds sources", "ui_meta": {"hermes-bots": {"title": "Ada - Research"}}})
        write_yaml(self.ada / "config.yaml", {"model": {"provider": "nova", "default": "nova-small"}, "terminal": {"cwd": "D:/work/ada"}})
        for name in (".hidden", "default", "gone"):
            (self.profiles / name).mkdir()
        self.busy: set[str] = set()
        for target, name, value in (
            (data, "install_root", lambda: self.root),
            (data, "named_profile_is_deleted", lambda path: Path(path).name == "gone"),
            (data, "chief_config_scope", contextlib.nullcontext),
            (persona, "profile_scope", lambda home: contextlib.nullcontext()),
            (fleet, "_busy", lambda name: name in self.busy),
        ):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.hermes_calls: list[tuple] = []

    def sections(self) -> dict:
        return json.loads((self.root / "bot-sections.json").read_text(encoding="utf-8"))


class RosterTests(FleetTestCase):
    def test_only_real_workers_are_listed(self):
        result = fleet.roster()
        self.assertEqual(result["contract"], fleet.CONTRACT)
        self.assertEqual(
            result["workers"],
            [
                {
                    "id": "ada",
                    "title": "Ada - Research",
                    "description": "Finds sources",
                    "model": {"provider": "nova", "model": "nova-small"},
                    "cwd": "D:/work/ada",
                    "working": False,
                }
            ],
        )
        self.assertEqual(result["archives"], [])

    def test_a_bare_profile_is_described_by_its_folder(self):
        bare = self.profiles / "vega"
        bare.mkdir()
        self.busy.add("vega")
        worker = next(w for w in fleet.roster()["workers"] if w["id"] == "vega")
        self.assertEqual(worker, {"id": "vega", "title": "vega", "description": "", "model": {"provider": "", "model": ""}, "cwd": "", "working": True})


class MintTests(FleetTestCase):
    def setUp(self):
        super().setUp()

        def create_profile(name, no_alias, no_skills, description):
            self.hermes_calls.append(("create", name, no_alias, no_skills, description))
            home = self.profiles / name
            home.mkdir()
            write_yaml(home / "config.yaml", {"display": {"compact": True}})
            write_yaml(home / "profile.yaml", {"ui_meta": "not a mapping"})
            return str(home)

        self.saved_config: list[tuple] = []
        fake_module(self, "hermes_cli")
        fake_module(self, "hermes_cli.profiles", create_profile=create_profile, launch_model_seed=lambda raw: {"model": dict(raw["model"])})
        fake_module(self, "hermes_cli.config", read_user_config_raw=lambda path: yaml.safe_load(Path(path).read_text(encoding="utf-8")))
        fake_module(self, "cli", save_config_value=lambda key, value: self.saved_config.append((key, value)) or True)
        for target, name, value in (
            (providers, "grant_provider", lambda slug, home: self.hermes_calls.append(("grant", slug, Path(home).name)) or {"ok": True, "keys": 1}),
            (second_brain, "share_with", lambda home: self.hermes_calls.append(("share", Path(home).name)) or False),
        ):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def mint(self, **overrides):
        args = {"name": "nova", "display_name": "Nova", "role": "Planner", "description": "Plans the week.", "soul": SOUL, "owner_signed": True}
        args.update(overrides)
        return fleet.mint(
            args["name"], args["display_name"], args["role"], args["description"], args["soul"], owner_signed=args["owner_signed"], cwd=args.get("cwd", "")
        )

    def test_mint_needs_sign_off_and_valid_parts(self):
        cases = [
            ({"owner_signed": False}, "sign-off"),
            ({"name": "n"}, "lowercase id"),
            ({"name": "1nova"}, "lowercase id"),
            ({"name": "nova desk"}, "lowercase id"),
            ({"name": "../nova"}, "lowercase id"),
            ({"name": "n" * 33}, "lowercase id"),
            ({"name": "chief"}, "lowercase id"),
            ({"name": "default"}, "lowercase id"),
            ({"display_name": "  "}, "first name"),
            ({"display_name": "N" * 41}, "first name"),
            ({"role": ""}, "first name"),
            ({"role": "r" * 61}, "first name"),
            ({"soul": " \n "}, "SOUL is empty or too long"),
            ({"soul": "s" * 20_001}, "SOUL is empty or too long"),
            ({"name": "ada"}, "already exists"),
        ]
        for overrides, message in cases:
            with self.subTest(overrides={k: str(v)[:12] for k, v in overrides.items()}):
                with self.assertRaises(fleet.FleetError) as caught:
                    self.mint(**overrides)
                self.assertIn(message, str(caught.exception))
        self.assertEqual(self.hermes_calls, [])

    def test_mint_makes_a_worker_on_the_chiefs_model(self):
        result = self.mint(name=" Nova ", soul=SOUL + "\r\n")
        home = self.profiles / "nova"
        self.assertEqual(self.hermes_calls, [("create", "nova", True, True, "Plans the week."), ("grant", "nova", "nova"), ("share", "nova")])
        self.assertEqual(result["keys_granted"], 1)
        self.assertEqual(result["worker"]["title"], "Nova - Planner")
        self.assertEqual(result["worker"]["model"], {"provider": "nova", "model": "nova-small"})
        config = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))
        self.assertEqual(config["display"], {"compact": True}, "Hermes's own settings are kept")
        meta = yaml.safe_load((home / "profile.yaml").read_text(encoding="utf-8"))
        self.assertEqual(meta, {"ui_meta": {"hermes-bots": {"title": "Nova - Planner"}}, "description": "Plans the week."})
        self.assertEqual((home / "SOUL.md").read_text(encoding="utf-8"), SOUL + "\n")
        workdir = self.root / "workspaces" / "nova"
        self.assertTrue(workdir.is_dir())
        self.assertEqual(self.saved_config, [("terminal.cwd", str(workdir))])
        self.assertEqual(self.sections(), {"sections": [fleet.TEAM_SECTION], "assign": {"nova": fleet.TEAM_SECTION}})

    def test_a_failure_part_way_removes_the_half_made_profile(self):
        def broken(key, value):
            raise OSError("config locked")

        fake_module(self, "cli", save_config_value=broken)
        with self.assertLogs("chief-dashboard-bridge", level="WARNING"), self.assertRaises(OSError):
            self.mint()
        self.assertFalse((self.profiles / "nova").exists())
        self.assertFalse((self.root / "bot-sections.json").exists())


class ModelTests(FleetTestCase):
    def setUp(self):
        super().setUp()
        groups = {"ok": True, "groups": [{"provider": "nova", "models": ["nova-small", "nova-large"]}, {"provider": "orbit", "models": ["orbit-1"]}]}
        for target, name, value in (
            (providers, "connected_models", lambda refresh=False: groups),
            (providers, "grant_provider", lambda slug, home: self.hermes_calls.append(("grant", slug, Path(home).name)) or {"keys": 2}),
            (
                providers,
                "choose_model",
                lambda slug, model, confirm_expensive=False, home=None: self.hermes_calls.append(("choose", slug, model, home)) or {"ok": True},
            ),
        ):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_only_offered_models_can_be_pinned(self):
        for provider, model in (("nova", "orbit-1"), ("ghost", "nova-small"), ("nova", "")):
            with self.subTest(provider=provider, model=model):
                with self.assertRaises(fleet.FleetError):
                    fleet.set_model("ada", provider, model)
        self.assertEqual(self.hermes_calls, [])

    def test_the_chief_is_pinned_directly(self):
        self.assertEqual(fleet.set_model("chief", "orbit", "orbit-1"), {"ok": True})
        self.assertEqual(self.hermes_calls, [("choose", "orbit", "orbit-1", None)])

    def test_a_bot_gets_the_providers_key_with_its_model(self):
        result = fleet.set_model("ADA", "nova", "nova-large")
        self.assertEqual(result, {"ok": True, "keys_granted": 2})
        self.assertEqual(self.hermes_calls, [("grant", "nova", "ada"), ("choose", "nova", "nova-large", self.ada)])

    def test_an_unknown_bot_is_refused(self):
        with self.assertRaises(persona.PersonaError):
            fleet.set_model("ghost", "nova", "nova-small")


class RetireTests(FleetTestCase):
    def setUp(self):
        super().setUp()

        def export_profile(name, base):
            self.hermes_calls.append(("export", name))
            archive = Path(base + ".tar.gz")
            archive.write_bytes(b"synthetic archive")
            return str(archive)

        def import_profile(file, name):
            self.hermes_calls.append(("import", Path(file).name, name))
            home = self.profiles / name
            home.mkdir()
            write_yaml(home / "config.yaml", {"model": {"provider": "orbit", "default": "orbit-1"}})
            return str(home)

        fake_module(self, "hermes_cli")
        fake_module(self, "hermes_cli.profiles", export_profile=export_profile, import_profile=import_profile)
        patcher = patch.object(providers, "grant_provider", lambda slug, home: self.hermes_calls.append(("grant", slug, Path(home).name)) or {"keys": 1})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_retire_needs_the_owners_go_ahead_and_a_real_idle_bot(self):
        with self.assertRaises(fleet.FleetError):
            fleet.retire("ada", owner_confirmed=False)
        for name in ("chief", "default", "../ada", ""):
            with self.subTest(name=name):
                with self.assertRaises(fleet.FleetError):
                    fleet.retire(name, owner_confirmed=True)
        with self.assertRaises(persona.PersonaError):
            fleet.retire("ghost", owner_confirmed=True)
        self.busy.add("ada")
        with self.assertRaises(fleet.FleetError) as caught:
            fleet.retire("ada", owner_confirmed=True)
        self.assertIn("working on a task", str(caught.exception))
        self.assertEqual(self.hermes_calls, [])
        self.assertTrue(self.ada.is_dir())

    def test_retire_archives_then_removes_and_restore_brings_it_back(self):
        fleet._sections_assign("ada", fleet.TEAM_SECTION)
        result = fleet.retire("ada", owner_confirmed=True)
        self.assertEqual(result["title"], "Ada - Research")
        self.assertFalse(self.ada.exists())
        self.assertEqual(self.sections()["assign"], {})
        [archive] = fleet.archives()
        self.assertEqual(archive["id"], result["archive"])
        self.assertRegex(archive["id"], r"^ada-\d{8}-\d{6}$")
        self.assertEqual((archive["title"], archive["model"]["provider"]), ("Ada - Research", "nova"))

        self.ada.mkdir()
        with self.assertRaises(fleet.FleetError) as caught:
            fleet.restore(archive["id"])
        self.assertIn("exists again", str(caught.exception))
        self.ada.rmdir()

        restored = fleet.restore(archive["id"])
        self.assertEqual(restored["worker"]["id"], "ada")
        self.assertEqual(restored["keys_granted"], 1)
        self.assertEqual(self.hermes_calls[-2:], [("import", Path(archive["file"]).name, "ada"), ("grant", "orbit", "ada")])
        self.assertEqual(fleet.archives(), [], "the archive and its note are gone")
        self.assertEqual(self.sections()["assign"], {"ada": fleet.TEAM_SECTION})

    def test_archive_ids_are_checked(self):
        for archive_id in ("", "ada", "../ada-20261001-120000", "ADA-20261001-120000", "ada-20261001-120000"):
            with self.subTest(archive_id=archive_id):
                with self.assertRaises(fleet.FleetError):
                    fleet.remove_archive(archive_id)

    def test_archives_skip_broken_notes_and_missing_files(self):
        folder = self.root / "fleet-archive"
        folder.mkdir()
        (folder / "vega-20261001-120000.json").write_text(json.dumps({"id": "vega", "file": str(folder / "missing.tar.gz")}), encoding="utf-8")
        (folder / "orion-20261001-120000.json").write_text("{not json", encoding="utf-8")
        kept = folder / "lyra-20261002-080000.tar.gz"
        kept.write_bytes(b"x")
        (folder / "lyra-20261002-080000.json").write_text(json.dumps({"id": "lyra", "file": str(kept)}), encoding="utf-8")
        self.assertEqual([a["id"] for a in fleet.archives()], ["lyra-20261002-080000"])
        self.assertEqual(fleet.remove_archive("lyra-20261002-080000"), {"ok": True})
        self.assertFalse(kept.exists())
        self.assertEqual(fleet.archives(), [])


class ToolTests(FleetTestCase):
    def test_tool_errors_come_back_as_json_never_a_traceback(self):
        def refuse(args):
            raise fleet.FleetError("Ask the owner first.")

        def crash(args):
            raise KeyError("synthetic-secret-value")

        self.assertEqual(json.loads(fleet._tool(refuse)({})), {"ok": False, "error": "Ask the owner first."})
        with self.assertLogs("chief-dashboard-bridge", level="WARNING"):
            answer = fleet._tool(crash)(None)
        self.assertEqual(json.loads(answer), {"ok": False, "error": "That didn't work (KeyError)."})
        self.assertNotIn("synthetic-secret-value", answer)

    def test_tools_refuse_without_sign_off(self):
        tools = {name: handler for name, _schema, handler, _emoji in fleet.TOOLS}
        minted = json.loads(tools["fleet_mint"]({"id": "nova", "display_name": "Nova", "role": "Planner", "description": "d", "soul": SOUL}))
        self.assertFalse(minted["ok"])
        self.assertIn("sign-off", minted["error"])
        retired = json.loads(tools["fleet_retire"]({"profile": "ada"}))
        self.assertIn("go-ahead", retired["error"])
        self.assertTrue(self.ada.is_dir())

    def test_tool_schemas_are_consistent(self):
        for name, schema, handler, _emoji in fleet.TOOLS:
            with self.subTest(name=name):
                self.assertEqual(schema["name"], name)
                self.assertTrue(callable(handler))
                params = schema["parameters"]
                self.assertLessEqual(set(params["required"]), set(params["properties"]))


if __name__ == "__main__":
    unittest.main()
