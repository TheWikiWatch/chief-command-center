"""VoiceStudio TTS plugin and the bridge's plugin-voice seams. No Hermes, no VoiceStudio, no network."""
import importlib
import json
import sys
import tempfile
import time
import types
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]

vs_pkg = types.ModuleType("test_voicestudio_plugin")
vs_pkg.__path__ = [str(ROOT / "hermes/plugins/voicestudio-tts")]
sys.modules[vs_pkg.__name__] = vs_pkg
provider = importlib.import_module("test_voicestudio_plugin.provider")


class FakeHttp:
    def __init__(self, audio=b"ID3" + b"\0" * 200, profiles=None, fail=None):
        self.audio = audio
        self.profiles = profiles if profiles is not None else []
        self.fail = fail
        self.calls = []

    def __call__(self, method, url, body, timeout):
        self.calls.append((method, url, json.loads(body) if body else None, timeout))
        if self.fail:
            raise self.fail
        if url.endswith("/profiles"):
            return json.dumps(self.profiles).encode()
        return self.audio


class VoiceStudioProviderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.out = str(Path(self.temp.name) / "speech.mp3")
        self.edge_calls = []

    def make(self, http, cfg=None):
        return provider.VoiceStudioTTS(http=http, config=lambda: dict(cfg or {}), edge=lambda text, path, voice: self._edge(text, path, voice))

    def _edge(self, text, path, voice):
        self.edge_calls.append((text, path, voice))
        Path(path).write_bytes(b"edge-mp3")

    def test_identity_is_a_plugin_name_with_no_keys(self):
        p = self.make(FakeHttp())
        self.assertEqual(p.name, "voicestudio")
        self.assertEqual(p.get_setup_schema()["env_vars"], [])
        self.assertTrue(p.is_available())
        self.assertTrue(p.voice_compatible)

    def test_designed_voice_sends_instruct_and_a_fixed_seed(self):
        http = FakeHttp()
        p = self.make(http, {"voice": "design:female, young adult, moderate pitch, american accent", "seed": 11})
        written = p.synthesize("Morning Sam.", self.out)
        self.assertEqual(written, self.out)
        self.assertEqual(Path(written).read_bytes()[:3], b"ID3")
        method, url, body, _ = http.calls[-1]
        self.assertEqual((method, url), ("POST", "http://127.0.0.1:3900/v1/audio/speech"))
        self.assertEqual(body["voice"], "default")
        self.assertEqual(body["instruct"], "female, young adult, moderate pitch, american accent")
        self.assertEqual(body["seed"], 11)
        self.assertEqual(body["response_format"], "mp3")
        self.assertEqual(self.edge_calls, [])

    def test_profile_voice_uses_the_profile_id_and_no_instruct(self):
        http = FakeHttp()
        p = self.make(http, {"voice": "profile:052b49ad", "num_step": 12})
        p.synthesize("Hello.", self.out)
        body = http.calls[-1][2]
        self.assertEqual(body["voice"], "052b49ad")
        self.assertNotIn("instruct", body)
        self.assertEqual(body["num_step"], 12)

    def test_own_voice_beats_the_generic_top_level_voice(self):
        http = FakeHttp()
        self.make(http, {"voice": "profile:mine"}).synthesize("Hi.", self.out, voice="en-GB-RyanNeural")
        self.assertEqual(http.calls[-1][2]["voice"], "mine")
        self.make(http).synthesize("Hi.", self.out, voice="en-GB-RyanNeural")
        self.assertIn("instruct", http.calls[-1][2])  # an Edge voice name is ignored: our default design
        self.make(http).synthesize("Hi.", self.out, voice="profile:passed")
        self.assertEqual(http.calls[-1][2]["voice"], "passed")

    def test_default_voice_when_nothing_is_configured(self):
        http = FakeHttp()
        self.make(http).synthesize("Hello.", self.out)
        self.assertEqual(http.calls[-1][2]["instruct"], provider.DEFAULT_VOICE.split(":", 1)[1])

    def test_backend_down_falls_back_to_edge_and_records_it(self):
        down = urllib.error.URLError(ConnectionRefusedError())
        p = self.make(FakeHttp(fail=down), {"fallback_voice": "en-GB-SoniaNeural"})
        before = time.time()
        written = p.synthesize("Morning.", str(Path(self.temp.name) / "x.wav"), format="wav")
        self.assertTrue(written.endswith(".mp3"))
        self.assertEqual(self.edge_calls[-1][2], "en-GB-SoniaNeural")
        status = p.fallback_status()
        self.assertIsNotNone(status)
        self.assertGreaterEqual(status["at"], before)
        self.assertEqual(status["reason"], "not running")

    def test_fallback_off_raises_so_hermes_reports_the_error(self):
        p = self.make(FakeHttp(fail=urllib.error.HTTPError("u", 500, "x", {}, None)), {"fallback": False})
        with self.assertRaises(RuntimeError):
            p.synthesize("Hi.", self.out)
        self.assertEqual(self.edge_calls, [])

    def test_empty_audio_counts_as_a_failure(self):
        p = self.make(FakeHttp(audio=b""))
        p.synthesize("Hi.", self.out)
        self.assertEqual(len(self.edge_calls), 1)

    def test_text_never_leaves_the_pc(self):
        http = FakeHttp()
        self.make(http, {"base_url": "https://voices.example.com"}).synthesize("Secret.", self.out)
        self.assertTrue(http.calls[-1][1].startswith("http://127.0.0.1:3900/"))
        self.assertEqual(provider.loopback_base("http://localhost:4000/"), "http://localhost:4000")

    def test_voice_list_groups_designed_and_saved_voices(self):
        http = FakeHttp(profiles=[{"id": "abc", "name": "Nova clone", "kind": "clone"}, {"id": "def", "name": "Warm", "kind": "design"}])
        voices = self.make(http).list_voices()
        groups = {v["group"] for v in voices}
        self.assertEqual(groups, {"Designed · fast", "Your VoiceStudio voices"})
        ids = [v["id"] for v in voices]
        self.assertIn("profile:abc", ids)
        self.assertIn("default", ids)
        labels = {v["id"]: v["display"] for v in voices}
        self.assertEqual(labels["profile:abc"], "Nova clone (cloned)")
        self.assertEqual(labels["profile:def"], "Warm (designed)")

    def test_voice_list_survives_a_stopped_backend(self):
        voices = self.make(FakeHttp(fail=urllib.error.URLError("down"))).list_voices()
        self.assertTrue(any(v["id"].startswith("design:") for v in voices))

    def test_long_text_goes_to_edge_instead_of_a_400(self):
        http = FakeHttp()
        self.make(http).synthesize("x" * (provider.MAX_CHARS + 1), self.out)
        self.assertEqual(http.calls, [])
        self.assertEqual(len(self.edge_calls), 1)


class BridgePluginVoiceTests(unittest.TestCase):
    """settings.py / voice.py branches for a plugin provider that lists voices."""

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(Path(__file__).parent))
        import test_bridge  # noqa: F401 — sets up the bridge package and Hermes stubs

        cls.settings = importlib.import_module("test_bridge_plugin.settings")
        cls.voice = importlib.import_module("test_bridge_plugin.voice")

    def plugin(self):
        p = provider.VoiceStudioTTS(http=FakeHttp(profiles=[{"id": "abc", "name": "Clone", "kind": "clone"}]), config=lambda: {"voice": "profile:abc"}, edge=lambda *a: None)
        return p

    def test_plugin_voices_are_listed_with_groups_and_a_label(self):
        p = self.plugin()
        with patch.object(self.voice, "plugin_tts_provider", return_value=p):
            voices = self.settings._plugin_voices("voicestudio")
            self.assertEqual(self.settings._plugin_display("voicestudio"), "VoiceStudio")
            self.assertEqual(self.settings._plugin_current_voice("voicestudio"), "profile:abc")
        self.assertTrue(all("label" in v for v in voices))
        self.assertIn({"id": "profile:abc", "label": "Clone (cloned)", "group": "Your VoiceStudio voices"}, voices)

    def test_builtin_engines_are_not_plugins(self):
        with patch.object(self.voice, "plugin_tts_provider", return_value=None):
            self.assertIsNone(self.settings._plugin_voices("edge"))

    def test_voice_config_reports_a_recent_fallback(self):
        p = self.plugin()
        p.last_fallback = time.time()
        p.last_error = "timed out"
        with patch.object(self.voice, "plugin_tts_provider", return_value=p):
            status = self.voice._fallback_status("voicestudio")
        self.assertEqual(status["reason"], "timed out")
        p.last_fallback = time.time() - 3600
        with patch.object(self.voice, "plugin_tts_provider", return_value=p):
            self.assertIsNone(self.voice._fallback_status("voicestudio"))


if __name__ == "__main__":
    unittest.main()
