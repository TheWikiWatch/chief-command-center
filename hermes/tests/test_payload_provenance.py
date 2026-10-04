"""Payload provenance: what a build records in its stamp, and the checks a release runs against it."""

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("payload_provenance", ROOT / "packaging" / "payload" / "provenance.py")
assert spec and spec.loader
provenance = importlib.util.module_from_spec(spec)
sys.modules["payload_provenance"] = provenance
spec.loader.exec_module(provenance)


def make_repo(root: Path) -> Path:
    repo = root / "repo"
    (repo / "hermes" / "patches").mkdir(parents=True)
    (repo / "packaging" / "payload").mkdir(parents=True)
    (repo / "hermes" / "patches" / "0001-fix.patch").write_text("--- a\n+++ b\n", encoding="utf-8")
    (repo / "hermes" / "pin.json").write_text(
        json.dumps({"commit": "abc", "baseVersion": "2026.9.24", "patches": [{"file": "0001-fix.patch"}]}), encoding="utf-8"
    )
    (repo / "packaging" / "payload" / "selection.json").write_text('{"extras": ["voice"]}', encoding="utf-8")
    return repo


def make_payload(root: Path) -> Path:
    payload = root / "payload"
    (payload / "hermes-agent" / "tools" / "__pycache__").mkdir(parents=True)
    (payload / "bin").mkdir()
    (payload / "hermes-agent" / "tools" / "approval.py").write_text("def ok():\n    return True\n", encoding="utf-8")
    (payload / "hermes-agent" / "tools" / "__pycache__" / "approval.cpython-314.pyc").write_bytes(b"\x00compiled")
    (payload / "bin" / "hermes.exe").write_bytes(b"MZ" + b"\x00" * 64)
    (payload / "hermes-agent" / "install-stamp.json").write_text(json.dumps({"commit": "def", "upstreamCommit": "abc"}), encoding="utf-8")
    return payload


class ProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.repo, self.payload = make_repo(root), make_payload(root)

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_payload_without_a_record_is_refused_with_the_fix(self):
        problems = provenance.check(self.payload, self.repo)
        self.assertEqual(len(problems), 1)
        self.assertIn("--write", problems[0])

    def test_recorded_then_unchanged_passes(self):
        recorded = provenance.record(self.payload, self.repo)
        self.assertEqual(set(recorded), {"patches", "selection", "builder", "tree"})
        self.assertEqual(provenance.check(self.payload, self.repo), [])
        stamp = json.loads((self.payload / "hermes-agent" / "install-stamp.json").read_text(encoding="utf-8"))
        self.assertEqual(stamp["upstreamCommit"], "abc")  # the rest of the stamp is kept

    def test_compiled_python_and_the_stamp_itself_dont_count(self):
        provenance.record(self.payload, self.repo)
        (self.payload / "hermes-agent" / "tools" / "__pycache__" / "other.cpython-314.pyc").write_bytes(b"new")
        # The command shims Hermes writes for itself when the suite or the smoke test runs it from the folder.
        (self.payload / "hermes-agent" / ".hermes" / "bin").mkdir(parents=True)
        (self.payload / "hermes-agent" / ".hermes" / "bin" / "hermes.cmd").write_text("@echo off\n", encoding="utf-8")
        self.assertEqual(provenance.check(self.payload, self.repo), [])

    def test_a_changed_file_a_changed_patch_or_selection_is_named(self):
        provenance.record(self.payload, self.repo)
        (self.payload / "hermes-agent" / "tools" / "approval.py").write_text("def ok():\n    return False\n", encoding="utf-8")
        self.assertTrue(any("files changed" in p for p in provenance.check(self.payload, self.repo)))
        provenance.record(self.payload, self.repo)
        (self.repo / "hermes" / "patches" / "0001-fix.patch").write_text("--- a\n+++ c\n", encoding="utf-8")
        self.assertTrue(any("0001-fix.patch" in p for p in provenance.check(self.payload, self.repo)))
        (self.repo / "packaging" / "payload" / "selection.json").write_text('{"extras": []}', encoding="utf-8")
        self.assertTrue(any("selection.json" in p for p in provenance.check(self.payload, self.repo)))

    def test_the_tree_digest_doesnt_depend_on_where_the_payload_is(self):
        first = provenance.tree_digest(self.payload)
        moved = self.payload.rename(self.payload.with_name("payload-moved"))
        self.assertEqual(provenance.tree_digest(moved), first)


if __name__ == "__main__":
    unittest.main()
