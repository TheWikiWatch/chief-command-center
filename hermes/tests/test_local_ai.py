"""Local models (local_ai.py): Hermes's local-model handlers reached in the chief's scope, the folder choice that comes
before the first download, the gateway boot, and plain errors. Against a fake Hermes router; synthetic data only."""

import contextlib
import importlib
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import test_bridge  # noqa: F401  (sets up the plugin package and Hermes stand-ins)

local_ai = importlib.import_module("test_bridge_plugin.local_ai")
data = importlib.import_module("test_bridge_plugin.data")

_MISSING = object()


def fake_module(test, name, **attrs):
    module = types.ModuleType(name)
    module.__dict__.update(attrs)
    old = sys.modules.get(name, _MISSING)
    sys.modules[name] = module
    test.addCleanup(lambda: sys.modules.pop(name, None) if old is _MISSING else sys.modules.__setitem__(name, old))
    return module


class HTTPException(Exception):
    def __init__(self, status_code, detail):
        super().__init__(detail)
        self.status_code, self.detail = status_code, detail


class Body:
    def __init__(self, **kw):
        self.__dict__.update(kw)


class LocalModelsTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.config = {"model": {"provider": "openrouter", "default": "some/model"}, "local_runtime": {}}
        self.calls = []
        self.jobs = []
        cfg = self.config
        test = self

        def models_dir():
            chosen = cfg["local_runtime"].get("models_dir")
            return Path(chosen) if chosen else test.root / "hermes" / "models"

        async def jobs():
            return {"jobs": list(test.jobs)}

        async def activate(body, profile=None):
            test.calls.append(("activate", body.model_id, profile))
            return {"job_id": "act1"}

        async def delete(model_id):
            test.calls.append(("delete", model_id))
            if test.locked:
                raise PermissionError(13, "in use", str(test.root / "models" / f"{model_id}.gguf"))
            return {"ok": True}

        def quickstart(body, profile=None):
            test.calls.append(("quickstart", body.model_id, profile))
            if body.model_id == "too-big":
                raise HTTPException(409, "no catalog model fits this machine")
            return {"job_id": "qs1", "model_id": body.model_id or "qwen-x", "needs_runtime": True}

        fake_module(
            self,
            "hermes_cli.web_routers.local_models",
            RuntimeInstallBody=Body,
            QuickstartBody=Body,
            ModelDownloadBody=Body,
            JobIdBody=Body,
            ModelActivateBody=Body,
            ServerActionBody=Body,
            local_models_status=lambda: {
                "enabled": False,
                "runtime_installed": False,
                "tag": "b9000",
                "server_running": False,
                "active_model_id": None,
                "models": [],
                "loaded_models": {},
            },
            local_models_hardware=lambda: {"gpu_name": "Example GPU", "vram_label": "12 GB", "vram_total_bytes": 12 << 30, "uma": False},
            local_models_catalog=lambda: {
                "models": [{"id": "qwen-x", "display_name": "Qwen X", "fits": True, "size_label": "16.5 GB", "recommended": True, "internal": "x"}]
            },
            local_models_jobs=jobs,
            local_models_job=lambda job_id: (_ for _ in ()).throw(HTTPException(404, "job not found")),
            local_models_quickstart=quickstart,
            local_models_download=lambda body: {"job_id": "dl1", "model_id": body.model_id},
            local_models_activate=activate,
            local_models_delete=delete,
            local_models_runtime_install=lambda body, profile=None: {"job_id": "rt1", "backend": "cuda", "tag": "b9000"},
            local_models_server=lambda body: {"ok": True, "action": body.action},
        )
        fake_module(self, "hermes_cli.web_routers")
        fake_module(self, "hermes_cli.local_runtime")
        fake_module(self, "hermes_cli.local_runtime.bootstrap", models_dir=models_dir, partials_dir=lambda: models_dir() / ".partials")
        self.locked = False
        self.saved = []
        self.save_ok = True

        def save_config_value(key, value):
            # Hermes's one-key writer: only the key it is given changes.
            test.saved.append((key, value))
            section, _, name = key.partition(".")
            cfg.setdefault(section, {})[name] = value
            return test.save_ok

        fake_module(self, "cli", save_config_value=save_config_value)
        fake_module(
            self,
            "hermes_cli.config",
            load_config_readonly=lambda: cfg,
            load_config=lambda: cfg,
            get_config_path=lambda: self.root / "config.yaml",
        )
        self.profiles = self.root / "profiles"
        (self.profiles / "chief").mkdir(parents=True)
        for p in (
            patch.object(local_ai, "chief_config_scope", contextlib.nullcontext),
            patch.object(local_ai, "_default_models_dir", lambda: self.root / "hermes" / "models"),
            patch.object(local_ai, "suggested_folder", lambda default: Path("E:/Chief models")),
            patch.object(data, "chief_home", lambda root=None: self.profiles / "chief"),
            patch.object(data, "profiles_dir", lambda root=None: self.profiles),
        ):
            p.start()
            self.addCleanup(p.stop)

    def bot(self, name, title, provider, model):
        home = self.profiles / name
        home.mkdir(parents=True, exist_ok=True)
        (home / "config.yaml").write_text(json.dumps({"model": {"provider": provider, "default": model}}), encoding="utf-8")
        if title:
            (home / "profile.yaml").write_text(json.dumps({"ui_meta": {"hermes-bots": {"title": title}}}), encoding="utf-8")
        data.forget_yaml(home / "config.yaml")
        data.forget_yaml(home / "profile.yaml")

    def test_status_says_what_the_page_needs_and_nothing_else(self):
        state = local_ai.status()
        self.assertEqual((state["engine"]["installed"], state["server"]["running"], state["machine"]["gpu"]), (False, False, "Example GPU"))
        self.assertEqual((state["folder"]["chosen"], state["folder"]["suggested"], state["folder"]["supported"]), (False, str(Path("E:/Chief models")), True))
        self.assertEqual(local_ai.catalog()["models"], [{"id": "qwen-x", "display_name": "Qwen X", "fits": True, "size_label": "16.5 GB", "recommended": True}])

    def test_the_drives_are_measured_only_until_a_folder_is_chosen(self):
        measured = []
        with patch.object(local_ai, "suggested_folder", lambda default: measured.append(default) or Path("E:/Chief models")):
            local_ai.folder()
            self.config["local_runtime"]["models_dir"] = str(self.root / "m")
            chosen = local_ai.folder()
        self.assertEqual(len(measured), 1)
        self.assertEqual(chosen["suggested"], str(self.root / "m"))

    def test_the_first_download_waits_for_a_folder(self):
        with self.assertRaisesRegex(local_ai.LocalModelsError, "Choose a folder"):
            local_ai.quickstart()
        target = self.root / "big drive" / "Chief models"
        self.assertTrue(local_ai.set_folder(str(target))["ok"])
        self.assertEqual(self.saved, [("local_runtime.models_dir", str(target))])  # one key, through Hermes's writer
        self.assertTrue(target.is_dir())
        self.assertEqual(local_ai.quickstart()["job_id"], "qs1")
        self.assertEqual(self.calls[-1], ("quickstart", None, None))  # the machine's recommendation, in the chief's scope

    def test_a_folder_isnt_moved_away_from_models_or_into_the_app(self):
        current = self.root / "hermes" / "models"
        current.mkdir(parents=True)
        (current / "qwen-x-Q4.gguf").write_bytes(b"GGUF")
        with self.assertRaisesRegex(local_ai.LocalModelsError, "Remove them first"):
            local_ai.set_folder(str(self.root / "other"))
        for bad in ("relative\\path", "", "C:\\Program Files\\WindowsApps\\Chief", "\\\\server\\share\\models"):
            with self.assertRaises(local_ai.LocalModelsError, msg=bad):
                local_ai.set_folder(bad)
        self.jobs.append({"job_id": "dl9", "status": "running"})
        (current / "qwen-x-Q4.gguf").unlink()
        with self.assertRaisesRegex(local_ai.LocalModelsError, "Wait for the download"):
            local_ai.set_folder(str(self.root / "other"))

    def test_a_folder_hermes_couldnt_save_says_so(self):
        self.save_ok = False
        with self.assertRaisesRegex(local_ai.LocalModelsError, "Couldn't save"):
            local_ai.set_folder(str(self.root / "big drive"))

    def test_hermes_refusals_are_plain_and_ids_are_checked(self):
        self.config["local_runtime"]["models_dir"] = str(self.root / "m")
        with self.assertRaisesRegex(local_ai.LocalModelsError, "^None of the models fits this PC.$"):
            local_ai.quickstart("too-big")
        with self.assertRaisesRegex(local_ai.LocalModelsError, "^That download has ended.$"):
            local_ai.job("nope")
        for bad in ("../x", "a b", "x" * 200):
            with self.assertRaises(local_ai.LocalModelsError):
                local_ai.download(bad)
        self.assertEqual(local_ai.call(lambda: local_ai.server("explode"))[1], 400)

    def test_what_hermes_says_becomes_a_sentence(self):
        cases = [
            (404, "model not found", "That model isn't downloaded any more."),
            (404, "qwen-x-Q4 is not downloaded", "That model isn't downloaded yet."),
            (404, "unknown download job", "That download has ended."),
            (409, "Qwen X needs llama.cpp b9100 or newer — update the engine first", "That model needs a newer engine. Update the engine first."),
            (
                502,
                "The local server could not start — check the runtime is installed",
                "The local server couldn't start. Check the engine is installed, then try again.",
            ),
            (502, "[WinError 5] Access is denied: 'E:\\private-folder\\models'", "The local server didn't answer. Try again."),
            (500, "Traceback (most recent call last): ...", "That didn't work. Try again."),
        ]
        for status, detail, sentence in cases:
            with self.subTest(detail=detail[:30]):
                self.assertEqual(local_ai.hermes_refusal(status, detail), sentence)

    def test_activate_is_for_the_chief(self):
        local_ai.activate("qwen-x-Q4")
        self.assertEqual(self.calls[-1], ("activate", "qwen-x-Q4", None))
        with self.assertRaises(local_ai.LocalModelsError):
            local_ai.activate("../chief")

    def test_a_model_the_chief_or_a_bot_uses_is_never_removed(self):
        self.bot("chief", "", "llamacpp", "qwen-x-Q4")
        with self.assertRaisesRegex(local_ai.LocalModelsError, "is using this model. Choose another model for"):
            local_ai.remove("qwen-x-Q4")
        self.bot("chief", "", "openrouter", "some/model")
        self.bot("research-desk", "Ada - Research", "llama.cpp", "qwen-x-Q4")
        with self.assertRaisesRegex(local_ai.LocalModelsError, "^Ada is using this model. Choose another model for Ada first.$"):
            local_ai.remove("qwen-x-Q4")
        self.assertNotIn(("delete", "qwen-x-Q4"), self.calls)
        self.bot("research-desk", "Ada - Research", "openrouter", "some/model")
        local_ai.remove("qwen-x-Q4")
        self.assertEqual(self.calls[-1], ("delete", "qwen-x-Q4"))

    def test_a_model_the_server_has_loaded_says_stop_the_server_first(self):
        self.locked = True
        answer = local_ai.call(lambda: local_ai.remove("qwen-x-Q4"))
        self.assertEqual(answer, ({"ok": False, "error": "The local server is using this model. Stop the server first, then remove it."}, 400))

    def test_without_patch_0006_the_folder_is_hermess_and_downloads_dont_wait(self):
        sys.modules["hermes_cli.local_runtime.bootstrap"].__dict__.pop("partials_dir")
        self.assertFalse(local_ai.folder()["supported"])
        self.assertEqual(local_ai.download("qwen-x")["job_id"], "dl1")
        with self.assertRaisesRegex(local_ai.LocalModelsError, "own folder"):
            local_ai.set_folder(str(self.root / "x"))


class SuggestTests(unittest.TestCase):
    def test_the_biggest_other_fixed_drive_with_room_else_hermess_folder(self):
        drives = [Path("C:\\"), Path("D:\\"), Path("E:\\")]
        # D: is small and empty, E: is the big storage drive: models go on E: (the owner's own choice too).
        disks = {"C:\\": (237, 24), "D:\\": (238, 238), "E:\\": (1625, 113)}
        usage = lambda p: types.SimpleNamespace(total=disks[str(p)][0] << 30, free=disks[str(p)][1] << 30)  # noqa: E731
        with (
            patch.object(local_ai, "_drives", lambda: drives),
            patch.object(local_ai.shutil, "disk_usage", usage),
            patch.dict(local_ai.os.environ, {"SystemDrive": "C:"}),
        ):
            self.assertEqual(local_ai.suggested_folder(Path("C:/hermes/models")), Path("E:\\") / "Chief models")
            disks["E:\\"] = (1625, 5)
            self.assertEqual(local_ai.suggested_folder(Path("C:/hermes/models")), Path("D:\\") / "Chief models")
            disks["D:\\"] = (238, 1)
            self.assertEqual(local_ai.suggested_folder(Path("C:/hermes/models")), Path("C:/hermes/models"))


if __name__ == "__main__":
    unittest.main()
