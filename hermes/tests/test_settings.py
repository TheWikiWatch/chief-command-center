"""Voice settings (settings.py): provider catalog shaping, patch validation and API key handling, against fake Hermes modules."""

import contextlib
import importlib
import io
import json
import sys
import types
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "hermes/plugins/chief-dashboard-bridge"
package = types.ModuleType("test_settings_plugin")
package.__path__ = [str(PLUGIN)]
sys.modules.setdefault(package.__name__, package)
if "hermes_constants" not in sys.modules:
    constants = types.ModuleType("hermes_constants")
    constants.get_default_hermes_root = lambda: str(ROOT / "hermes/tests/.runtime/hermes")
    constants.named_profile_is_deleted = lambda _: False
    sys.modules["hermes_constants"] = constants
settings = importlib.import_module("test_settings_plugin.settings")

_MISSING = object()


def fake_module(test: unittest.TestCase, name: str, module=_MISSING, **attrs):
    """Put a fake Hermes module (or None, which makes importing it fail) in sys.modules for one test."""
    if module is _MISSING:
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


class SettingsTestCase(unittest.TestCase):
    def setUp(self):
        scope = patch.object(settings, "chief_config_scope", contextlib.nullcontext)
        scope.start()
        self.addCleanup(scope.stop)
        settings._forget_el_voices()
        self.addCleanup(settings._forget_el_voices)
        self.secrets: dict[str, str] = {}
        fake_module(self, "tools")
        fake_module(self, "tools.tool_backend_helpers", resolve_provider_secret=lambda env, provider: self.secrets.get(env, ""))


class CatalogTests(SettingsTestCase):
    def install(self, rows, categories=None):
        fake_module(self, "hermes_cli")
        fake_module(
            self,
            "hermes_cli.tools_config",
            TOOL_CATEGORIES=categories if categories is not None else {"tts": {"name": "Speaking"}, "stt": {"name": "Hearing"}},
            get_nous_subscription_features=lambda config, force_fresh: None,
        )
        fake_module(
            self,
            "hermes_cli.tools_config_providers",
            _visible_providers=lambda cat, config, features: rows,
            provider_readiness_status=lambda row, config, features: row["_status"],
        )

    def test_one_row_per_provider_the_readiest_wins(self):
        self.install(
            [
                {"tts_provider": "nova-voice", "name": "Nova (managed)", "managed_nous_feature": True, "_status": "needs_auth"},
                {"tts_provider": "nova-voice", "name": "Nova", "_status": "needs_setup"},
                {"tts_provider": "edge", "name": "Edge", "_status": "ready"},
                {"tts_provider": "", "name": "No slug", "_status": "ready"},
            ]
        )
        rows = settings._catalog("tts", {})
        self.assertEqual([(r["id"], r["name"], r["status"]) for r in rows], [("nova-voice", "Nova", "needs_setup"), ("edge", "Edge", "ready")])
        self.assertEqual(rows[0]["hint"], "Needs setup in Hermes")
        self.assertEqual(rows[1]["hint"], "")

    def test_an_unmanaged_row_replaces_a_managed_one_of_equal_rank(self):
        self.install(
            [
                {"tts_provider": "aurora", "name": "Aurora via Nous", "managed_nous_feature": True, "_status": "ready"},
                {"tts_provider": "aurora", "name": "Aurora", "_status": "ready"},
            ]
        )
        self.assertEqual(settings._catalog("tts", {})[0]["name"], "Aurora")

    def test_a_saved_key_makes_a_needs_keys_row_ready(self):
        self.install(
            [
                {"stt_provider": "aurora", "name": "Aurora", "env_vars": [{"key": "AURORA_KEY", "url": "https://keys.example.test"}], "_status": "needs_keys"},
                {"stt_provider": "vega", "name": "Vega", "env_vars": [("VEGA_KEY", "prompt")], "_status": "needs_keys"},
                {"stt_provider": "elevenlabs", "name": "ElevenLabs", "env_vars": ["ELEVENLABS_API_KEY"], "_status": "needs_keys"},
            ]
        )
        self.secrets["AURORA_KEY"] = "synthetic-key"
        rows = {r["id"]: r for r in settings._catalog("stt", {})}
        self.assertEqual(
            rows["aurora"], {"id": "aurora", "name": "Aurora", "status": "ready", "hint": "", "env_key": "AURORA_KEY", "key_url": "https://keys.example.test"}
        )
        self.assertEqual((rows["vega"]["status"], rows["vega"]["env_key"]), ("needs_keys", "VEGA_KEY"))
        self.assertEqual(rows["vega"]["hint"], "Add this key to the chief’s profile")
        self.assertIn("ElevenLabs", rows["elevenlabs"]["hint"])
        self.assertNotIn("synthetic-key", json.dumps(rows))

    def test_an_unknown_category_or_missing_hermes_gives_nothing(self):
        self.install([{"tts_provider": "edge", "_status": "ready"}], categories={})
        self.assertEqual(settings._catalog("tts", {}), [])
        fake_module(self, "hermes_cli.tools_config", None)
        self.assertEqual(settings._catalog("tts", {}), [])


class VoiceListTests(SettingsTestCase):
    def test_edge_voices_keep_a_custom_current_voice(self):
        ids = [v["id"] for v in settings._edge_voices("en-IE-EmilyNeural")]
        self.assertEqual(ids[-1], "en-IE-EmilyNeural")
        self.assertEqual(len(settings._edge_voices("en-US-AriaNeural")), len(settings.EDGE_VOICES))

    def test_elevenlabs_without_a_key_offers_the_default_voice(self):
        voices, err = settings._elevenlabs_voices("")
        self.assertEqual((voices, err), ([{"id": settings.DEFAULT_ELEVENLABS_VOICE_ID, "label": "Adam"}], "missing"))

    def test_elevenlabs_voices_are_listed_sorted_and_cached(self):
        self.secrets["ELEVENLABS_API_KEY"] = "synthetic-el-key"
        payload = {"voices": [{"voice_id": "v2", "name": "Zed", "category": "premade"}, {"voice_id": "v1", "name": "ada"}, {"voice_id": ""}, "junk"]}
        calls = []

        def urlopen(req, timeout):
            calls.append(req.get_header("Xi-api-key"))
            return contextlib.nullcontext(io.BytesIO(json.dumps(payload).encode()))

        with patch("urllib.request.urlopen", urlopen):
            voices, err = settings._elevenlabs_voices("custom-voice")
            again, again_err = settings._elevenlabs_voices("v2")
        self.assertIsNone(err)
        self.assertEqual(voices, [{"id": "v1", "label": "ada"}, {"id": "v2", "label": "Zed (premade)"}, {"id": "custom-voice", "label": "custom-voice"}])
        self.assertEqual((again[:2], again_err), (voices[:2], None))
        self.assertEqual(calls, ["synthetic-el-key"], "the second call is served from the cache")

    def test_a_rejected_elevenlabs_key_is_remembered_a_network_error_is_not(self):
        self.secrets["ELEVENLABS_API_KEY"] = "synthetic-el-key"

        def rejected(req, timeout):
            raise urllib.error.HTTPError(req.full_url, 401, "Unauthorized", {}, None)

        with patch("urllib.request.urlopen", rejected):
            self.assertEqual(settings._elevenlabs_voices("")[1], "unauthorized")
        self.assertEqual(settings._elevenlabs_voices("")[1], "unauthorized", "served from the cache")
        settings._forget_el_voices()

        def offline(req, timeout):
            raise OSError("no route")

        with patch("urllib.request.urlopen", offline), self.assertLogs("chief-dashboard-bridge", level="WARNING"):
            self.assertEqual(settings._elevenlabs_voices("")[1], "network")
        self.assertIsNone(settings._el_voice_cache)

    def test_plugin_voices_are_shaped_and_bad_rows_dropped(self):
        plugin = types.SimpleNamespace(
            list_voices=lambda: [{"id": "studio-1", "display": "Studio One", "group": "Custom"}, {"id": "studio-2"}, {"label": "no id"}, "junk"],
            display_name="VoiceStudio (local)",
            current_voice=lambda: "studio-2",
        )
        with patch.object(settings.voice, "plugin_tts_provider", return_value=plugin):
            self.assertEqual(
                settings._plugin_voices("voicestudio"), [{"id": "studio-1", "label": "Studio One", "group": "Custom"}, {"id": "studio-2", "label": "studio-2"}]
            )
            self.assertEqual(settings._plugin_display("voicestudio"), "VoiceStudio")
            self.assertEqual(settings._plugin_current_voice("voicestudio"), "studio-2")
        with patch.object(settings.voice, "plugin_tts_provider", return_value=None):
            self.assertIsNone(settings._plugin_voices("voicestudio"))


class GetSettingsTests(SettingsTestCase):
    def test_shape_for_the_dashboard(self):
        current = {"stt": {"provider": "local", "enabled": False, "model": "base"}, "tts": {"provider": "edge", "voice": "en-GB-RyanNeural"}}
        fake_module(self, "hermes_cli")
        fake_module(self, "hermes_cli.config", load_config=lambda: {"stt": {"local": {"model": "small"}}})
        fake_module(self, "hermes_cli.tools_config_providers", None)
        with patch.object(settings.voice, "voice_config", return_value=current), patch.object(settings, "_catalog", return_value=[]):
            result = settings.get_settings()
        self.assertEqual(
            result["stt"], {"provider": "local", "enabled": False, "model": "small", "providers": [], "models": ["base", "tiny", "small", "medium", "large-v3"]}
        )
        self.assertEqual((result["tts"]["provider"], result["tts"]["voice"], result["tts"]["voice_label"]), ("edge", "en-GB-RyanNeural", "Edge voice"))
        self.assertEqual(result["source"], "hermes:chief")

    def test_a_rejected_elevenlabs_key_marks_the_rows(self):
        current = {"stt": {"provider": "local"}, "tts": {"provider": "elevenlabs", "voice": ""}}
        rows = [{"id": "elevenlabs", "status": "ready", "hint": ""}]
        fake_module(self, "hermes_cli")
        fake_module(self, "hermes_cli.config", load_config=lambda: {})
        with (
            patch.object(settings.voice, "voice_config", return_value=current),
            patch.object(settings, "_catalog", side_effect=lambda kind, cfg: [dict(r) for r in rows]),
            patch.object(settings, "_elevenlabs_voices", return_value=([{"id": "v1", "label": "Adam"}], "unauthorized")),
        ):
            result = settings.get_settings()
        self.assertEqual(result["tts"]["providers"], [{"id": "elevenlabs", "status": "needs_keys", "hint": "That key was rejected."}])
        self.assertEqual(result["stt"]["providers"][0]["status"], "needs_keys")


class PatchTests(SettingsTestCase):
    def setUp(self):
        super().setUp()
        self.current = {
            "ok": True,
            "stt": {
                "provider": "local",
                "providers": [
                    {"id": "local", "status": "ready", "hint": ""},
                    {"id": "aurora", "status": "needs_keys", "hint": "Add this key to the chief’s profile", "env_key": "AURORA_KEY"},
                ],
            },
            "tts": {
                "provider": "edge",
                "voice": "en-US-AriaNeural",
                "providers": [
                    {"id": "edge", "status": "ready", "hint": ""},
                    {"id": "elevenlabs", "status": "ready", "hint": "", "env_key": "ELEVENLABS_API_KEY"},
                    {"id": "studio", "status": "ready", "hint": ""},
                ],
            },
        }
        self.saves: list[tuple[str, object]] = []
        self.save_error = None
        for name, value in (
            ("get_settings", lambda: self.current),
            ("_save", lambda path, value: self.saves.append((path, value)) or self.save_error),
            ("_stt_models", lambda provider: ["base", "small"] if provider == "local" else []),
            ("_stt_model_key", lambda provider: "model"),
        ):
            patcher = patch.object(settings, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_replies_as_written_is_a_switch_on_hermes_streaming(self):
        self.assertIs(settings.patch_settings({"streaming": False}), self.current)
        self.assertEqual(self.saves, [("streaming.enabled", False)])
        self.saves.clear()
        settings.patch_settings({"streaming": "yes"})
        self.assertEqual(self.saves, [])
        self.save_error = "Could not write Hermes config"
        self.assertEqual(settings.patch_settings({"streaming": True})["error"], "Could not write Hermes config")

    def test_bad_or_empty_bodies(self):
        self.assertEqual(settings.patch_settings("nope"), {"ok": False, "error": "Invalid settings payload"})
        self.assertIs(settings.patch_settings({}), self.current)
        self.assertIs(settings.patch_settings({"stt": "x", "tts": [], "secrets": None}), self.current)
        self.assertEqual(self.saves, [])

    def test_providers_must_be_known_and_ready(self):
        self.assertEqual(settings.patch_settings({"stt": {"provider": "ghost"}})["error"], "Unknown hearing provider: ghost")
        self.assertEqual(settings.patch_settings({"stt": {"provider": "aurora"}})["error"], "Add this key to the chief’s profile")
        self.assertEqual(settings.patch_settings({"tts": {"provider": "ghost"}})["error"], "Unknown speaking provider: ghost")
        self.assertEqual(self.saves, [])
        self.assertTrue(settings.patch_settings({"tts": {"provider": "elevenlabs"}})["ok"])
        self.assertEqual(self.saves, [("tts.provider", "elevenlabs")])

    def test_the_current_provider_can_be_saved_even_when_not_ready(self):
        self.current["stt"]["provider"] = "aurora"
        self.assertTrue(settings.patch_settings({"stt": {"provider": "aurora"}})["ok"])
        self.assertEqual(self.saves, [("stt.provider", "aurora")])

    def test_hearing_models_come_from_hermes_catalog(self):
        self.assertEqual(settings.patch_settings({"stt": {"model": "huge"}})["error"], "Unknown hearing model: huge")
        self.assertTrue(settings.patch_settings({"stt": {"model": "small"}})["ok"])
        self.assertEqual(self.saves, [("stt.local.model", "small")])
        self.current["stt"]["provider"] = "aurora"
        self.assertEqual(settings.patch_settings({"stt": {"model": "small"}})["error"], "That hearing provider has no model list")

    def test_edge_voices_must_be_listed(self):
        self.assertEqual(settings.patch_settings({"tts": {"voice": "made-up"}})["error"], "Unknown Edge voice: made-up")
        self.assertTrue(settings.patch_settings({"tts": {"voice": "en-GB-SoniaNeural"}})["ok"])
        self.assertEqual(self.saves, [("tts.edge.voice", "en-GB-SoniaNeural")])

    def test_elevenlabs_voices_are_checked_unless_the_list_is_unreachable(self):
        self.current["tts"]["provider"] = "elevenlabs"
        with patch.object(settings, "_elevenlabs_voices", return_value=([{"id": "v1", "label": "Adam"}], None)):
            self.assertEqual(settings.patch_settings({"tts": {"voice": "v9"}})["error"], "Unknown ElevenLabs voice")
            self.assertTrue(settings.patch_settings({"tts": {"voice": "v1"}})["ok"])
        with patch.object(settings, "_elevenlabs_voices", return_value=([{"id": "v1", "label": "Adam"}], "network")):
            self.assertTrue(settings.patch_settings({"tts": {"voice": "v9"}})["ok"])
        self.assertEqual(self.saves, [("tts.elevenlabs.voice_id", "v1"), ("tts.elevenlabs.voice_id", "v9")])

    def test_plugin_voices_must_be_listed(self):
        self.current["tts"]["provider"] = "studio"
        with patch.object(settings, "_plugin_voices", return_value=None):
            self.assertEqual(settings.patch_settings({"tts": {"voice": "s1"}})["error"], "This speaking engine has no voice list")
        with patch.object(settings, "_plugin_voices", return_value=[{"id": "s1", "label": "One"}]):
            self.assertEqual(settings.patch_settings({"tts": {"voice": "s2"}})["error"], "Unknown voice for this engine")
            self.assertTrue(settings.patch_settings({"tts": {"voice": "s1"}})["ok"])
        self.assertEqual(self.saves, [("tts.studio.voice", "s1")])

    def test_a_failed_write_is_reported(self):
        self.save_error = "Could not write Hermes config"
        self.assertEqual(settings.patch_settings({"tts": {"provider": "edge"}}), {"ok": False, "error": "Could not write Hermes config"})

    def test_only_known_key_names_are_saved(self):
        with patch.object(settings, "_save_secret", wraps=settings._save_secret) as save_secret:
            result = settings.patch_settings({"secrets": {"PATH": "C:/evil", "EMPTY": "  "}})
        self.assertEqual(result, {"ok": False, "error": "Unknown key name"})
        self.assertEqual([c.args[0] for c in save_secret.call_args_list], ["PATH"], "empty values are skipped")

    def test_a_provider_api_key_goes_to_its_variable(self):
        stored = []
        fake_module(self, "hermes_cli")
        fake_module(self, "hermes_cli.credential_lifecycle", save_provider_env_credential=lambda name, value: stored.append((name, value)))
        self.assertTrue(settings.patch_settings({"stt": {"provider": "aurora", "api_key": " synthetic-aurora "}})["error"])
        self.assertEqual(stored, [("AURORA_KEY", "synthetic-aurora")], "the key is saved even when the provider still needs setup")


class SecretTests(SettingsTestCase):
    def setUp(self):
        super().setUp()
        self.stored: list[tuple[str, str]] = []
        fake_module(self, "hermes_cli")
        fake_module(self, "hermes_cli.credential_lifecycle", save_provider_env_credential=lambda name, value: self.stored.append((name, value)))

    def test_refusals(self):
        allowed = {"AURORA_KEY", "lower_key"}
        self.assertEqual(settings._save_secret("", "v", allowed), "API key is empty")
        self.assertEqual(settings._save_secret("AURORA_KEY", "  ", allowed), "API key is empty")
        self.assertEqual(settings._save_secret("OTHER_KEY", "v", allowed), "Unknown key name")
        self.assertEqual(settings._save_secret("lower_key", "v", allowed), "Unknown key name")
        self.assertEqual(self.stored, [])

    def test_allowed_names_are_the_catalog_keys_plus_elevenlabs(self):
        self.assertEqual(settings._allowed_secret_names([{"env_key": "AURORA_KEY"}, {"env_key": " "}, {}]), {"AURORA_KEY", "ELEVENLABS_API_KEY"})

    def test_a_rejected_elevenlabs_key_is_not_saved(self):
        with patch.object(settings, "_probe_elevenlabs_key", return_value="That key was rejected."):
            self.assertEqual(settings._save_secret("ELEVENLABS_API_KEY", "synthetic", {"ELEVENLABS_API_KEY"}), "That key was rejected.")
        self.assertEqual(self.stored, [])

    def test_a_saved_elevenlabs_key_clears_the_voice_cache(self):
        settings._el_voice_cache = (0.0, [], "unauthorized")
        with patch.object(settings, "_probe_elevenlabs_key", return_value=None):
            self.assertIsNone(settings._save_secret("ELEVENLABS_API_KEY", " synthetic ", {"ELEVENLABS_API_KEY"}))
        self.assertEqual(self.stored, [("ELEVENLABS_API_KEY", "synthetic")])
        self.assertIsNone(settings._el_voice_cache)

    def test_a_failed_save_never_logs_the_key(self):
        def fail(name, value):
            raise RuntimeError(f"could not write {value}")

        fake_module(self, "hermes_cli.credential_lifecycle", save_provider_env_credential=fail)
        with self.assertLogs("chief-dashboard-bridge", level="WARNING") as logs:
            self.assertEqual(settings._save_secret("AURORA_KEY", "synthetic-secret-value", {"AURORA_KEY"}), "Could not save API key to Hermes")
        self.assertNotIn("synthetic-secret-value", "\n".join(logs.output))

    def test_probe_only_reports_rejections(self):
        def answer(code):
            def urlopen(req, timeout):
                raise urllib.error.HTTPError(req.full_url, code, "x", {}, None)

            return urlopen

        with patch("urllib.request.urlopen", answer(403)):
            self.assertEqual(settings._probe_elevenlabs_key("synthetic"), "That key was rejected.")
        with patch("urllib.request.urlopen", answer(500)):
            self.assertIsNone(settings._probe_elevenlabs_key("synthetic"))


class SaveTests(SettingsTestCase):
    def test_write_failures_become_one_plain_error(self):
        def boom(path, value):
            raise OSError("disk full")

        with self.assertLogs("chief-dashboard-bridge", level="WARNING"):
            fake_module(self, "cli", None)
            self.assertEqual(settings._save("tts.provider", "edge"), "Could not write Hermes config")
            fake_module(self, "cli", save_config_value=boom)
            self.assertEqual(settings._save("tts.provider", "edge"), "Could not write Hermes config")
        fake_module(self, "cli", save_config_value=lambda path, value: False)
        self.assertEqual(settings._save("tts.provider", "edge"), "Could not write Hermes config")
        written = []
        fake_module(self, "cli", save_config_value=lambda path, value: written.append((path, value)) or True)
        self.assertIsNone(settings._save("tts.provider", "edge"))
        self.assertEqual(written, [("tts.provider", "edge")])


if __name__ == "__main__":
    unittest.main()
