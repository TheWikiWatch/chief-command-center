"""stage.py builds only from what prepare_source.py leaves: the expected upstream commit plus one patch commit, clean."""

import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("payload_stage", ROOT / "packaging" / "payload" / "stage.py")
assert spec and spec.loader
stage = importlib.util.module_from_spec(spec)
sys.modules["payload_stage"] = stage
spec.loader.exec_module(stage)


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", *args], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()


class CheckSourceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.src = Path(self.tmp.name)
        git(self.src, "init", "-q")
        (self.src / "a.py").write_text("upstream\n", encoding="utf-8")
        git(self.src, "add", "-A")
        git(self.src, "commit", "-q", "-m", "upstream")
        self.upstream = git(self.src, "rev-parse", "HEAD")
        (self.src / "a.py").write_text("patched\n", encoding="utf-8")
        git(self.src, "commit", "-q", "-am", "Chief patch queue")

    def tearDown(self):
        self.tmp.cleanup()

    def test_an_upgrade_candidate_builds_from_its_own_commit(self):
        stage.check_source(self.src, self.upstream)  # an upgrade candidate names its commit: no SystemExit
        with self.assertRaises(SystemExit):
            stage.check_source(self.src, "0" * 40)

    def test_uncommitted_changes_are_refused(self):
        (self.src / "a.py").write_text("changed after preparing\n", encoding="utf-8")
        with self.assertRaises(SystemExit) as caught:
            stage.check_source(self.src, self.upstream)
        self.assertIn("uncommitted", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
