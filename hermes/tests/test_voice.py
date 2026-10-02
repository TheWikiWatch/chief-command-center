"""Voice relay (voice.py): upload checks and limits, transcription and speech results, temp-file cleanup and provider lookup."""

import base64
import contextlib
import importlib
import json
import os
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "hermes/plugins/chief-dashboard-bridge"
RUNTIME = ROOT / "hermes/tests/.runtime"
package = types.ModuleType("test_voice_plugin")
package.__path__ = [str(PLUGIN)]
sys.modules.setdefault(package.__name__, package)
if "hermes_constants" not in sys.modules:
    constants = types.ModuleType("hermes_constants")
    constants.get_default_hermes_root = lambda: str(RUNTIME / "hermes")
    constants.named_profile_is_deleted = lambda _: False
    sys.modules["hermes_constants"] = constants
voice = importlib.import_module("test_voice_plugin.voice")
speech_model = importlib.import_module("test_voice_plugin.speech_model")

_MISSING = object()
AUDIO = b"RIFF synthetic audio bytes"


def data_url(blob: bytes = AUDIO, mime: str = "audio/webm") -> str:
    return f"data:{mime};base64,{base64.b64encode(blob).decode('ascii')}"


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


class VoiceTestCase(unittest.TestCase):
    def setUp(self):
        scope = patch.object(voice, "chief_config_scope", contextlib.nullcontext)
        scope.start()
        self.addCleanup(scope.stop)
        fake_module(self, "tools")
        fake_module(self, "agent")


class TranscribeTests(VoiceTestCase):
    def setUp(self):
        super().setUp()
        missing = patch.object(voice, "_local_model_missing", return_value=False)
        self.model_missing = missing.start()
        self.addCleanup(missing.stop)
        self.seen: list[tuple[str, bytes]] = []
        self.result: object = {"success": True, "transcript": "  remind me at noon ", "provider": "local"}

        def transcribe_recording(path):
            self.seen.append((path, Path(path).read_bytes()))
            if isinstance(self.result, Exception):
                raise self.result
            return self.result

        fake_module(self, "tools.voice_mode", transcribe_recording=transcribe_recording)

    def test_payloads_that_are_not_base64_audio_are_refused(self):
        cases = [
            ({}, "Invalid audio payload"),
            ({"data_url": "https://example.test/a.webm"}, "Invalid audio payload"),
            ({"data_url": "data:audio/webm;base64"}, "Invalid audio payload"),
            ({"data_url": "data:audio/webm,plain"}, "must be base64 encoded"),
            ({"data_url": data_url(mime="image/png")}, "must be an audio recording"),
            ({"data_url": data_url(), "mime_type": "text/plain"}, "must be an audio recording"),
            ({"data_url": "data:audio/webm;base64,not*base64!"}, "not valid base64"),
            ({"data_url": "data:audio/webm;base64,"}, "Audio recording is empty"),
        ]
        for body, message in cases:
            with self.subTest(body=str(body)[:50]):
                result = voice.transcribe(body)
                self.assertFalse(result["ok"])
                self.assertIn(message, result["error"])
        self.assertEqual(self.seen, [])

    def test_a_recording_over_the_limit_is_refused(self):
        with patch.object(voice, "MAX_UPLOAD_BYTES", len(AUDIO) - 1):
            self.assertEqual(voice.transcribe({"data_url": data_url()}), {"ok": False, "error": "Audio recording is too large"})
        with patch.object(voice, "MAX_UPLOAD_BYTES", len(AUDIO)):
            self.assertTrue(voice.transcribe({"data_url": data_url()})["ok"], "exactly the limit is fine")

    def test_a_missing_speech_model_is_reported_before_hermes_downloads_one(self):
        self.model_missing.return_value = True
        result = voice.transcribe({"data_url": data_url()})
        self.assertEqual(result["code"], "model_missing")
        self.assertEqual(self.seen, [])

    def test_the_recording_reaches_hermes_and_its_temp_file_is_removed(self):
        result = voice.transcribe({"dataUrl": data_url(mime="audio/ogg;codecs=opus")})
        self.assertEqual(result, {"ok": True, "transcript": "remind me at noon", "provider": "local", "filtered": False, "no_speech": False})
        [(path, blob)] = self.seen
        self.assertEqual(blob, AUDIO)
        self.assertTrue(path.endswith(".ogg"), path)
        self.assertFalse(os.path.exists(path))

    def test_the_explicit_mime_type_picks_the_extension(self):
        for mime, ext in (("audio/mp4", ".mp4"), ("audio/x-m4a", ".m4a"), ("video/webm", ".webm"), ("audio/unknown", ".webm")):
            with self.subTest(mime=mime):
                self.seen.clear()
                self.assertTrue(voice.transcribe({"data_url": data_url(mime="audio/webm"), "mimeType": mime})["ok"])
                self.assertTrue(self.seen[0][0].endswith(ext))

    def test_an_empty_transcript_is_not_an_error(self):
        self.result = {"success": False, "error": "Empty transcript returned", "provider": "local"}
        self.assertEqual(voice.transcribe({"data_url": data_url()}), {"ok": True, "transcript": "", "provider": "local"})

    def test_hermes_failures_are_reported_and_the_temp_file_still_goes(self):
        self.result = {"success": False, "error": "No STT provider configured"}
        self.assertEqual(voice.transcribe({"data_url": data_url()}), {"ok": False, "error": "No STT provider configured"})
        self.result = RuntimeError("decoder crashed")
        with self.assertLogs("chief-dashboard-bridge", level="WARNING"):
            self.assertEqual(voice.transcribe({"data_url": data_url()}), {"ok": False, "error": "Transcription failed"})
        self.assertFalse(any(os.path.exists(path) for path, _ in self.seen))


class LocalModelProbeTests(VoiceTestCase):
    def stt(self, provider):
        fake_module(self, "tools.transcription_tools", _load_stt_config=lambda: {"local": {"model": "base"}}, _get_provider=lambda cfg: provider)

    def test_only_the_local_provider_needs_the_model(self):
        self.stt("aurora")
        self.assertFalse(voice._local_model_missing())
        self.stt("local")
        with patch.object(speech_model, "local_model_ready", return_value=False):
            self.assertTrue(voice._local_model_missing())
        with patch.object(speech_model, "local_model_ready", return_value=True):
            self.assertFalse(voice._local_model_missing())

    def test_without_hermes_nothing_is_blocked(self):
        fake_module(self, "tools.transcription_tools", None)
        self.assertFalse(voice._local_model_missing())


class SpeakTests(VoiceTestCase):
    def setUp(self):
        super().setUp()
        RUNTIME.mkdir(parents=True, exist_ok=True)
        temp = tempfile.TemporaryDirectory(dir=RUNTIME)
        self.addCleanup(temp.cleanup)
        self.dir = Path(temp.name)
        self.result: object = {}
        self.spoken: list[str] = []

        def text_to_speech_tool(text):
            self.spoken.append(text)
            if isinstance(self.result, Exception):
                raise self.result
            return json.dumps(self.result) if isinstance(self.result, dict) else self.result

        fake_module(self, "tools.tts_tool", text_to_speech_tool=text_to_speech_tool)
        lookup = patch.object(voice, "plugin_tts_provider", return_value=None)
        self.lookup = lookup.start()
        self.addCleanup(lookup.stop)

    def clip(self, name: str, blob: bytes = AUDIO) -> str:
        path = self.dir / name
        path.write_bytes(blob)
        return str(path)

    def test_empty_text_is_refused(self):
        self.assertEqual(voice.speak("   "), {"ok": False, "error": "Text is required"})
        self.assertEqual(voice.speak(None), {"ok": False, "error": "Text is required"})
        self.assertEqual(self.spoken, [])

    def test_failures_are_reported(self):
        self.result = RuntimeError("engine down")
        with self.assertLogs("chief-dashboard-bridge", level="WARNING"):
            self.assertEqual(voice.speak("hi"), {"ok": False, "error": "Speech synthesis failed"})
        self.result = {"success": False, "error": "Voice not found"}
        self.assertEqual(voice.speak("hi"), {"ok": False, "error": "Voice not found"})
        self.result = "not json"
        with self.assertLogs("chief-dashboard-bridge", level="WARNING"):
            self.assertEqual(voice.speak("hi"), {"ok": False, "error": "Speech synthesis failed"})
        self.result = {"success": True}
        self.assertEqual(voice.speak("hi"), {"ok": False, "error": "Audio file missing"})
        self.result = {"success": True, "file_path": str(self.dir / "never-written.mp3")}
        self.assertEqual(voice.speak("hi"), {"ok": False, "error": "Audio file missing"})

    def test_clips_come_back_as_data_urls_and_the_files_are_removed(self):
        first, second = self.clip("a.ogg", b"one"), self.clip("b.ogg", b"two")
        self.result = {"success": True, "provider": "edge", "file_path": first, "file_paths": [second, first, ""]}
        result = voice.speak("  Good morning  ")
        self.assertEqual(self.spoken, ["Good morning"])
        self.assertEqual(result["data_urls"], [f"data:audio/ogg;base64,{base64.b64encode(b).decode()}" for b in (b"two", b"one")])
        self.assertEqual(result["data_url"], result["data_urls"][0])
        self.assertEqual((result["mime_type"], result["provider"]), ("audio/ogg", "edge"))
        self.assertNotIn("fallback", result)
        self.assertFalse(os.path.exists(first) or os.path.exists(second))

    def test_the_main_file_goes_first_and_unknown_extensions_are_mp3(self):
        main, extra = self.clip("main.xyz"), self.clip("extra.wav")
        self.result = {"success": True, "file_path": main, "file_paths": [extra]}
        result = voice.speak("hi")
        self.assertTrue(result["data_urls"][0].startswith("data:audio/mpeg;base64,"))
        self.assertEqual(result["mime_type"], "audio/wav", "the last clip's type")

    def test_one_missing_clip_fails_the_reply_and_removes_the_rest(self):
        kept = self.clip("a.mp3")
        self.result = {"success": True, "file_paths": [kept, str(self.dir / "gone.mp3")]}
        self.assertEqual(voice.speak("hi"), {"ok": False, "error": "Audio file missing"})
        self.assertFalse(os.path.exists(kept))

    def test_a_plugin_fallback_during_this_call_is_reported(self):
        plugin = types.SimpleNamespace(fallback_status=lambda: {"at": time.time() + 1, "reason": "VoiceStudio is not running"})
        self.lookup.return_value = plugin
        self.result = {"success": True, "provider": "voicestudio", "file_path": self.clip("a.mp3")}
        result = voice.speak("hi")
        self.assertEqual((result["fallback"], result["fallback_reason"]), (True, "VoiceStudio is not running"))
        plugin.fallback_status = lambda: {"at": time.time() - 3600, "reason": "earlier"}
        self.result = {"success": True, "provider": "voicestudio", "file_path": self.clip("b.mp3")}
        self.assertNotIn("fallback", voice.speak("hi"), "an older fallback isn't this reply's")


class ProviderLookupTests(VoiceTestCase):
    def test_built_in_engines_have_no_plugin(self):
        plugin = object()
        fake_module(self, "tools.tts_command_provider", BUILTIN_TTS_PROVIDERS={"edge", "elevenlabs"})
        fake_module(self, "agent.tts_registry", get_provider=lambda name: plugin if name == "voicestudio" else None)
        self.assertIsNone(voice.plugin_tts_provider("Edge"))
        self.assertIsNone(voice.plugin_tts_provider(""))
        self.assertIs(voice.plugin_tts_provider(" VoiceStudio "), plugin)

    def test_without_hermes_there_is_no_plugin(self):
        fake_module(self, "tools.tts_command_provider", None)
        self.assertIsNone(voice.plugin_tts_provider("voicestudio"))

    def test_voice_config_shape(self):
        fake_module(
            self,
            "tools.transcription_tools",
            _load_stt_config=lambda: {"provider": "elevenlabs", "elevenlabs": {"model_id": "scribe_v1"}},
            _get_provider=lambda cfg: cfg["provider"],
            is_stt_enabled=lambda cfg: True,
        )
        fake_module(
            self,
            "tools.tts_tool",
            _load_tts_config=lambda: {"provider": "voicestudio", "voicestudio": {"voice_id": "studio-2"}},
            _get_provider=lambda cfg: cfg["provider"],
        )
        plugin = types.SimpleNamespace(fallback_status=lambda: {"at": 1.0, "reason": "offline"})
        with patch.object(voice, "plugin_tts_provider", return_value=plugin):
            result = voice.voice_config()
        self.assertEqual(
            result,
            {
                "ok": True,
                "stt": {"provider": "elevenlabs", "enabled": True, "model": "scribe_v1"},
                "tts": {"provider": "voicestudio", "voice": "studio-2", "fallback": {"at": 1.0, "reason": "offline"}},
            },
        )

    def test_voice_config_defaults_without_hermes(self):
        fake_module(self, "tools.transcription_tools", None)
        fake_module(self, "tools.tts_tool", None)
        with patch.object(voice, "plugin_tts_provider", return_value=None):
            self.assertEqual(
                voice.voice_config(), {"ok": True, "stt": {"provider": "local", "enabled": True, "model": ""}, "tts": {"provider": "edge", "voice": ""}}
            )


if __name__ == "__main__":
    unittest.main()
