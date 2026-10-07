"""Upstream tracking tooling: the patch queue's `next` forms, promoting them when the pin moves, the drift check's
static reading of Hermes, and the attempt key that lets a blocked upgrade be retried."""

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load(name: str, rel: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / rel)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


prepare_source = load("tooling_prepare_source", "packaging/payload/prepare_source.py")
update_pin = load("tooling_update_pin", "packaging/upstream/update_pin.py")
drift = load("tooling_drift", "packaging/upstream/drift.py")
candidate = load("tooling_candidate", "packaging/upstream/candidate.py")


def git(*args: str, cwd: Path) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout


def diff_for(repo: Path, rel: str, before: str, after: str) -> str:
    """A patch turning `before` into `after` in `rel`, made by git so it applies byte for byte."""
    (repo / rel).write_text(after, encoding="utf-8", newline="\n")
    out = git("diff", "--", rel, cwd=repo)
    (repo / rel).write_text(before, encoding="utf-8", newline="\n")
    return out


class PatchQueueTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.src, self.patches = root / "src", root / "patches"
        self.src.mkdir()
        self.patches.mkdir()
        git("init", "-q", cwd=self.src)
        git("config", "core.autocrlf", "false", cwd=self.src)
        self.old = "def run():\n    path = [venv]\n    return path\n"
        self.new = "def run():\n    prefix = [payload_bin, venv]\n    return prefix\n"
        (self.src / "env.py").write_text(self.old, encoding="utf-8", newline="\n")
        git("add", "-A", cwd=self.src)
        git("-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-qm", "old", cwd=self.src)
        # The patch for the old code, and its `next` form for the new code.
        (self.patches / "0004-x.patch").write_text(
            diff_for(self.src, "env.py", self.old, self.old.replace("[venv]", "[interp]")), encoding="utf-8", newline="\n"
        )
        (self.patches / "0004-x.next.patch").write_text(self._next_patch(), encoding="utf-8", newline="\n")

    def _next_patch(self) -> str:
        """The same fix written against the newer code (committed for the diff, then rolled back)."""
        (self.src / "env.py").write_text(self.new, encoding="utf-8", newline="\n")
        git("-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-qam", "new", cwd=self.src)
        out = diff_for(self.src, "env.py", self.new, self.new.replace("[payload_bin, venv]", "[payload_bin, interp]"))
        git("reset", "-q", "--hard", "HEAD~1", cwd=self.src)
        return out

    def tearDown(self):
        self.tmp.cleanup()

    def test_the_own_form_applies_on_the_code_it_was_written_for(self):
        applied, failure = prepare_source.apply_queue(self.src, [{"file": "0004-x.patch", "next": "0004-x.next.patch"}], self.patches)
        self.assertIsNone(failure)
        self.assertEqual(applied, {"0004-x.patch": "0004-x.patch"})
        self.assertIn("[interp]", (self.src / "env.py").read_text(encoding="utf-8"))

    def test_the_next_form_applies_once_upstream_moved_on(self):
        (self.src / "env.py").write_text(self.new, encoding="utf-8", newline="\n")
        applied, failure = prepare_source.apply_queue(self.src, [{"file": "0004-x.patch", "next": ["0004-x.next.patch"]}], self.patches)
        self.assertIsNone(failure)
        self.assertEqual(applied, {"0004-x.patch": "0004-x.next.patch"})
        self.assertIn("[payload_bin, interp]", (self.src / "env.py").read_text(encoding="utf-8"))

    def test_no_form_applies_names_the_patch_and_every_form_tried(self):
        (self.src / "env.py").write_text("something else entirely\n", encoding="utf-8", newline="\n")
        applied, failure = prepare_source.apply_queue(self.src, [{"file": "0004-x.patch", "next": "0004-x.next.patch"}], self.patches)
        self.assertEqual(applied, {})
        assert failure is not None
        self.assertIn("PATCH FAILED 0004-x.patch", failure)
        self.assertIn("0004-x.next.patch", failure)

    def test_promoting_moves_the_form_that_applied_into_the_entry_and_drops_the_rest(self):
        (self.patches / "0004-x.rc.patch").write_text("rc form\n", encoding="utf-8")
        next_text = (self.patches / "0004-x.next.patch").read_bytes()
        pin = {"patches": [{"file": "0001-y.patch"}, {"file": "0004-x.patch", "next": ["0004-x.next.patch", "0004-x.rc.patch"]}]}
        promoted = update_pin.promote(pin, {"0001-y.patch": "0001-y.patch", "0004-x.patch": "0004-x.next.patch"}, self.patches)
        self.assertEqual(promoted, ["0004-x.patch"])
        self.assertEqual((self.patches / "0004-x.patch").read_bytes(), next_text)
        self.assertFalse((self.patches / "0004-x.next.patch").exists())
        self.assertFalse((self.patches / "0004-x.rc.patch").exists())
        self.assertNotIn("next", pin["patches"][1])

    def test_promoting_leaves_an_entry_that_applied_in_its_own_form(self):
        pin = {"patches": [{"file": "0004-x.patch", "next": "0004-x.next.patch"}]}
        self.assertEqual(update_pin.promote(pin, {"0004-x.patch": "0004-x.patch"}, self.patches), [])
        self.assertEqual(pin["patches"][0]["next"], "0004-x.next.patch")
        self.assertTrue((self.patches / "0004-x.next.patch").exists())

    def test_the_pin_file_is_written_with_lf_endings(self):
        repo = Path(self.tmp.name) / "repo"
        (repo / "hermes" / "patches").mkdir(parents=True)
        (repo / "hermes" / "pin.json").write_text(json.dumps({"commit": "a" * 40, "baseVersion": "2026.9.24", "patches": []}), encoding="utf-8")
        update_pin.main(["--commit", "b" * 40, "--base-version", "v2026.10.2"], repo=repo)
        raw = (repo / "hermes" / "pin.json").read_bytes()
        self.assertNotIn(b"\r\n", raw)
        self.assertEqual(json.loads(raw)["baseVersion"], "2026.10.2")


class DriftStaticCheckTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.src = Path(self.tmp.name)
        (self.src / "tools").mkdir()
        (self.src / "tools" / "__init__.py").write_text("", encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, rel: str, text: str) -> None:
        (self.src / rel).write_text(text, encoding="utf-8")

    def test_defined_imported_and_guarded_names_count(self):
        self.write(
            "tools/a.py",
            "import os\nfrom x import y as z\nA = 1\nB: int = 2\ndef f(): pass\nclass C: pass\n"
            "try:\n    from fast import g\nexcept ImportError:\n    def g(): pass\n",
        )
        caps = {"feat": {"tools.a": ("os", "z", "A", "B", "f", "C", "g", "gone")}}
        self.assertEqual(drift.missing_names(self.src, caps), ["tools.a.gone (feat)"])

    def test_a_missing_module_is_reported_once(self):
        self.assertEqual(drift.missing_names(self.src, {"feat": {"tools.nope": ("x",)}}), ["tools.nope (feat): module gone"])

    def test_modules_that_make_names_at_import_time_are_taken_on_trust(self):
        self.write("tools/reg.py", "_registry = make()\n_registry.export(globals())\n")
        self.write("tools/lazy.py", "def __getattr__(name):\n    return 1\n")
        self.write("tools/star.py", "from elsewhere import *\n")
        caps = {"feat": {"tools.reg": ("get_provider",), "tools.lazy": ("anything",), "tools.star": ("x",)}}
        self.assertEqual(drift.missing_names(self.src, caps), [])

    def test_a_new_or_old_name_is_found_under_either(self):
        self.write("tools/stt.py", "STT_MODEL_CONFIG_KEY = {}\n")
        caps = {"feat": {"tools.stt": ("STT_MODEL_CONFIG_KEY|_STT_MODEL_CONFIG_KEY", "_GONE|_ALSO_GONE")}}
        self.assertEqual(drift.missing_names(self.src, caps), ["tools.stt._GONE|_ALSO_GONE (feat)"])

    def test_the_bridge_capability_list_loads_without_hermes(self):
        caps = drift.capabilities()
        self.assertIn("approvals", caps)


class AttemptKeyTests(unittest.TestCase):
    def test_it_changes_with_the_patches_and_ignores_line_endings_and_caches(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            for rel in candidate.ATTEMPT_INPUTS:
                (repo / rel).parent.mkdir(parents=True, exist_ok=True)
            (repo / "hermes" / "patches").mkdir(parents=True, exist_ok=True)
            (repo / "hermes" / "patches" / "0001.patch").write_bytes(b"a\nb\n")
            first = candidate.attempt_key(repo)
            (repo / "hermes" / "patches" / "0001.patch").write_bytes(b"a\r\nb\r\n")
            (repo / "hermes" / "patches" / "__pycache__").mkdir()
            (repo / "hermes" / "patches" / "__pycache__" / "x.pyc").write_bytes(b"\x00")
            self.assertEqual(candidate.attempt_key(repo), first)
            (repo / "hermes" / "patches" / "0001.patch").write_bytes(b"a\nc\n")
            self.assertNotEqual(candidate.attempt_key(repo), first)


class PinTests(unittest.TestCase):
    def test_every_patch_and_next_form_in_the_pin_exists(self):
        pin = prepare_source.load_pin()
        for patch in pin["patches"]:
            for form in [patch["file"], *prepare_source.next_forms(patch)]:
                self.assertTrue((prepare_source.PATCHES / form).is_file(), form)

    def test_no_patch_file_is_left_unlisted(self):
        pin = prepare_source.load_pin()
        listed = {form for p in pin["patches"] for form in [p["file"], *prepare_source.next_forms(p)]}
        on_disk = {p.name for p in prepare_source.PATCHES.glob("*.patch")}
        self.assertEqual(on_disk - listed, set())


if __name__ == "__main__":
    unittest.main()
