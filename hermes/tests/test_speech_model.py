"""The on-device speech model (speech_model.py): id checks, the download job (resume, checksums, refusals, cancel) and status."""

import contextlib
import hashlib
import importlib
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "hermes/plugins/chief-dashboard-bridge"
RUNTIME = ROOT / "hermes/tests/.runtime"
package = types.ModuleType("test_speech_model_plugin")
package.__path__ = [str(PLUGIN)]
sys.modules.setdefault(package.__name__, package)
if "hermes_constants" not in sys.modules:
    constants = types.ModuleType("hermes_constants")
    constants.get_default_hermes_root = lambda: str(RUNTIME / "hermes")
    constants.named_profile_is_deleted = lambda _: False
    sys.modules["hermes_constants"] = constants
data = importlib.import_module("test_speech_model_plugin.data")
speech_model = importlib.import_module("test_speech_model_plugin.speech_model")

_MISSING = object()
WEIGHTS = bytes(range(256)) * 40  # 10 240 bytes
VOCAB = b"synthetic vocabulary\n" * 10


def sha(blob: bytes) -> str:
    return hashlib.sha256(blob).hexdigest()


SPEC = {
    "label": "Synthetic",
    "repo": "example/synthetic-whisper",
    "revision": "0123456789abcdef",
    "files": [("model.bin", len(WEIGHTS), sha(WEIGHTS)), ("vocabulary.txt", len(VOCAB), sha(VOCAB))],
}
BODIES = {"model.bin": WEIGHTS, "vocabulary.txt": VOCAB}


def fake_module(test: unittest.TestCase, name: str, module=_MISSING, **attrs):
    """Put a fake module (or None, which makes importing it fail) in sys.modules for one test."""
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


class FakeResponse:
    def __init__(self, status_code: int, body: bytes, chunk: int = 4096, on_chunk=None):
        self.status_code = status_code
        self.body = body
        self.chunk = chunk
        self.on_chunk = on_chunk
        self.closed = False

    def iter_content(self, _n):
        for i in range(0, len(self.body), self.chunk):
            if self.on_chunk:
                self.on_chunk(i)
            yield self.body[i : i + self.chunk]

    def close(self):
        self.closed = True


class SpeechModelTestCase(unittest.TestCase):
    def setUp(self):
        RUNTIME.mkdir(parents=True, exist_ok=True)
        temp = tempfile.TemporaryDirectory(dir=RUNTIME)
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        (self.root / "profiles" / "chief").mkdir(parents=True)
        for target, name, value in (
            (data, "install_root", lambda: self.root),
            (data, "chief_config_scope", contextlib.nullcontext),
        ):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        models = patch.dict(speech_model.MODELS, {"synthetic": SPEC})
        models.start()
        self.addCleanup(models.stop)
        env = patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("HF_ENDPOINT", None)
        speech_model._job = None
        self.addCleanup(setattr, speech_model, "_job", None)
        self.requests: list[tuple[str, dict]] = []
        self.responses: dict[str, object] = {}
        speech_model._http_get = self.fetch
        self.addCleanup(setattr, speech_model, "_http_get", None)
        self.config: list[tuple] = []
        self.config_ok = True
        fake_module(self, "cli", save_config_value=lambda key, value: self.config.append((key, value)) or self.config_ok)

    def fetch(self, url, headers, timeout):
        name = url.rsplit("/", 1)[-1]
        self.requests.append((url, dict(headers)))
        answer = self.responses.get(name)
        if isinstance(answer, Exception):
            raise answer
        if callable(answer):
            return answer(headers)
        return FakeResponse(200, BODIES[name])

    @property
    def folder(self) -> Path:
        return speech_model.model_dir("synthetic")

    def download(self) -> dict:
        self.assertTrue(speech_model.download("synthetic", wait=True)["ok"])
        return speech_model._job.view()


class IdTests(SpeechModelTestCase):
    def test_unknown_ids_are_refused(self):
        for model_id in ("", "large", "../base", None):
            for call in (speech_model.download, speech_model.delete, speech_model.total_bytes):
                with self.subTest(call=call.__name__, model_id=model_id):
                    with self.assertRaises(speech_model.SpeechModelError):
                        call(model_id)
            self.assertFalse(speech_model.installed(model_id))
            self.assertEqual(speech_model.use(model_id), "That speech model isn't downloaded yet.")
        self.assertEqual((self.requests, self.config), ([], []))

    def test_the_shipped_models_add_up(self):
        self.assertEqual(speech_model.total_bytes("base"), sum(size for _, size, _ in speech_model.MODELS["base"]["files"]))
        for spec in speech_model.MODELS.values():
            for name, size, digest in spec["files"]:
                self.assertRegex(digest, r"^[0-9a-f]{64}$", name)
                self.assertGreater(size, 0)
        self.assertEqual(speech_model.model_dir("tiny"), self.root / "profiles" / "chief" / "models" / "faster-whisper-tiny")


class DownloadTests(SpeechModelTestCase):
    def test_a_download_verifies_each_file_and_points_hermes_at_it(self):
        job = self.download()
        self.assertEqual(job, {"id": "synthetic", "state": "done", "received": len(WEIGHTS) + len(VOCAB), "total": len(WEIGHTS) + len(VOCAB), "error": ""})
        self.assertEqual([url for url, _ in self.requests], [f"https://huggingface.co/example/synthetic-whisper/resolve/0123456789abcdef/{n}" for n in BODIES])
        self.assertTrue(all("Range" not in headers for _, headers in self.requests))
        self.assertEqual((self.folder / "model.bin").read_bytes(), WEIGHTS)
        self.assertEqual(sorted(p.name for p in self.folder.iterdir()), ["chief-model.json", "model.bin", "vocabulary.txt"], "no .part files left")
        self.assertTrue(speech_model.installed("synthetic"))
        self.assertEqual(self.config, [("stt.enabled", True), ("stt.provider", "local"), ("stt.local.model", str(self.folder))])

    def test_a_mirror_endpoint_is_used(self):
        os.environ["HF_ENDPOINT"] = "https://mirror.example.test/"
        self.download()
        self.assertTrue(self.requests[0][0].startswith("https://mirror.example.test/example/"))

    def test_a_stopped_download_resumes_with_a_range(self):
        self.folder.mkdir(parents=True)
        (self.folder / "model.bin.part").write_bytes(WEIGHTS[:3000])
        self.responses["model.bin"] = lambda headers: FakeResponse(206, WEIGHTS[3000:])
        self.assertEqual(self.download()["state"], "done")
        self.assertEqual(self.requests[0][1]["Range"], "bytes=3000-")
        self.assertEqual((self.folder / "model.bin").read_bytes(), WEIGHTS)

    def test_a_server_that_ignores_the_range_starts_the_file_over(self):
        self.folder.mkdir(parents=True)
        (self.folder / "model.bin.part").write_bytes(WEIGHTS[:3000])
        self.responses["model.bin"] = lambda headers: FakeResponse(200, WEIGHTS)
        self.assertEqual(self.download()["state"], "done")
        self.assertEqual((self.folder / "model.bin").read_bytes(), WEIGHTS)

    def test_a_good_file_on_disk_is_not_fetched_again_a_bad_one_is(self):
        self.folder.mkdir(parents=True)
        (self.folder / "vocabulary.txt").write_bytes(VOCAB)
        (self.folder / "model.bin").write_bytes(bytes(len(WEIGHTS)))  # right size, wrong bytes
        self.assertEqual(self.download()["state"], "done")
        self.assertEqual([url.rsplit("/", 1)[-1] for url, _ in self.requests], ["model.bin"])
        self.assertEqual((self.folder / "model.bin").read_bytes(), WEIGHTS)

    def test_a_checksum_mismatch_is_discarded(self):
        self.responses["model.bin"] = lambda headers: FakeResponse(200, bytes(len(WEIGHTS)))
        job = self.download()
        self.assertEqual(job["state"], "error")
        self.assertIn("didn't match its checksum", job["error"])
        self.assertFalse((self.folder / "model.bin.part").exists())
        self.assertFalse(speech_model.installed("synthetic"))
        self.assertEqual(self.config, [])

    def test_a_larger_file_than_expected_is_discarded(self):
        self.responses["model.bin"] = lambda headers: FakeResponse(200, WEIGHTS + b"extra" * 5000)
        job = self.download()
        self.assertIn("larger than expected", job["error"])
        self.assertFalse((self.folder / "model.bin.part").exists())

    def test_a_short_answer_keeps_the_part_for_next_time(self):
        self.responses["model.bin"] = lambda headers: FakeResponse(200, WEIGHTS[:5000])
        job = self.download()
        self.assertEqual(job["state"], "error")
        self.assertIn("resumes where it stopped", job["error"])
        self.assertEqual((self.folder / "model.bin.part").stat().st_size, 5000)

    def test_server_errors_and_network_failures_are_plain_words(self):
        class ReadTimeout(Exception):
            pass

        cases = [
            (lambda headers: FakeResponse(503, b""), "answered 503"),
            (ConnectionError("synthetic"), "Couldn't reach huggingface.co"),
            (ReadTimeout("synthetic"), "huggingface.co stopped answering"),
        ]
        for answer, message in cases:
            with self.subTest(message=message):
                speech_model._job = None
                self.responses["model.bin"] = answer
                job = self.download()
                self.assertEqual(job["state"], "error")
                self.assertIn(message, job["error"])
                self.assertNotIn("Traceback", job["error"])

    def test_cancel_stops_the_download(self):
        def stop_after_first_chunk(offset):
            if offset:
                speech_model.cancel()

        self.responses["model.bin"] = lambda headers: FakeResponse(200, WEIGHTS, on_chunk=stop_after_first_chunk)
        job = self.download()
        self.assertEqual(job["state"], "cancelled")
        self.assertEqual((self.folder / "model.bin.part").stat().st_size, 4096, "what arrived is kept for a resume")
        self.assertFalse(speech_model.installed("synthetic"))

    def test_hermes_refusing_the_settings_is_an_error(self):
        self.config_ok = False
        job = self.download()
        self.assertEqual((job["state"], job["error"]), ("error", "Couldn't update Hermes's voice settings."))


class JobTests(SpeechModelTestCase):
    def test_one_download_at_a_time(self):
        running = speech_model._Job("synthetic")
        speech_model._job = running
        self.assertEqual(speech_model.download("synthetic"), {"ok": True, "job": running.view()})
        self.assertEqual(speech_model.download("tiny")["error"], "Another speech model is downloading. Cancel it first.")
        self.assertEqual(speech_model.delete("synthetic"), {"ok": False, "error": "Cancel the download first."})
        self.assertEqual(speech_model.cancel(), {"ok": True})
        self.assertTrue(running.cancel.is_set())
        self.assertEqual(self.requests, [])

    def test_cancel_without_a_job_is_harmless(self):
        self.assertEqual(speech_model.cancel(), {"ok": True})
        speech_model._job = speech_model._Job("synthetic")
        speech_model._job.state = "done"
        speech_model.cancel()
        self.assertFalse(speech_model._job.cancel.is_set())

    def test_delete_removes_the_folder(self):
        self.download()
        self.assertEqual(speech_model.delete("synthetic"), {"ok": True})
        self.assertFalse(self.folder.exists())
        self.assertEqual(speech_model.delete("synthetic"), {"ok": True}, "deleting twice is fine")


class InstalledTests(SpeechModelTestCase):
    def install(self, revision=SPEC["revision"]):
        self.folder.mkdir(parents=True)
        for name, blob in BODIES.items():
            (self.folder / name).write_bytes(blob)
        (self.folder / "chief-model.json").write_text(json.dumps({"revision": revision}), encoding="utf-8")

    def test_installed_needs_the_marker_the_revision_and_every_file(self):
        self.assertFalse(speech_model.installed("synthetic"))
        self.install(revision="older")
        self.assertFalse(speech_model.installed("synthetic"))
        (self.folder / "chief-model.json").write_text(json.dumps({"revision": SPEC["revision"]}), encoding="utf-8")
        self.assertTrue(speech_model.installed("synthetic"))
        (self.folder / "vocabulary.txt").write_bytes(b"short")
        self.assertFalse(speech_model.installed("synthetic"))
        (self.folder / "chief-model.json").write_text("{broken", encoding="utf-8")
        self.assertFalse(speech_model.installed("synthetic"))

    def test_use_needs_a_downloaded_model(self):
        self.assertEqual(speech_model.use("synthetic"), "That speech model isn't downloaded yet.")
        self.assertEqual(self.config, [])

    def test_local_model_ready(self):
        fake_module(self, "huggingface_hub", None)
        self.assertFalse(speech_model.local_model_ready({"local": {"model": str(self.folder)}}))
        self.install()
        self.assertTrue(speech_model.local_model_ready({"local": {"model": str(self.folder)}}))
        self.assertFalse(speech_model.local_model_ready({"local": {"model": "base"}}), "a Hub name needs the Hub's cache")
        self.assertFalse(speech_model.local_model_ready({}))
        fake_module(self, "huggingface_hub", try_to_load_from_cache=lambda repo, name: str(self.folder / name) if repo.endswith("-base") else None)
        self.assertTrue(speech_model.local_model_ready({"local": {"model": "base"}}))
        self.assertFalse(speech_model.local_model_ready({"local": {"model": "tiny"}}))


class StatusTests(SpeechModelTestCase):
    def stt(self, cfg: dict, provider: str, enabled: bool = True):
        fake_module(self, "tools")
        fake_module(self, "tools.transcription_tools", _load_stt_config=lambda: cfg, _get_provider=lambda c: provider, is_stt_enabled=lambda c: enabled)

    def test_status_shape(self):
        self.stt({"provider": "local", "local": {"model": str(self.folder)}}, "local")
        result = speech_model.status()
        self.assertEqual(result["contract"], speech_model.CONTRACT)
        self.assertEqual(result["default"], "base")
        ids = [m["id"] for m in result["models"]]
        self.assertEqual(ids[-1], "synthetic")
        synthetic = result["models"][-1]
        self.assertEqual(
            synthetic,
            {
                "id": "synthetic",
                "label": "Synthetic",
                "bytes": len(WEIGHTS) + len(VOCAB),
                "installed": False,
                "source": "huggingface.co/example/synthetic-whisper",
            },
        )
        self.assertIsNone(result["job"])
        self.assertEqual(result["stt"], {"provider": "local", "enabled": True, "local": True, "ready": False})

    def test_ready_when_the_local_model_is_on_disk_or_a_keyed_provider_is_set(self):
        self.download()
        self.stt({"local": {"model": str(self.folder)}}, "local")
        status = speech_model.status()
        self.assertTrue(status["stt"]["ready"])
        self.assertEqual(status["job"]["state"], "done")
        self.stt({}, "aurora")
        self.assertTrue(speech_model.status()["stt"]["ready"])
        self.stt({}, "aurora", enabled=False)
        self.assertFalse(speech_model.status()["stt"]["ready"])
        self.stt({}, "none")
        self.assertEqual(speech_model.status()["stt"]["provider"], "none")
        self.assertFalse(speech_model.status()["stt"]["ready"])


if __name__ == "__main__":
    unittest.main()
