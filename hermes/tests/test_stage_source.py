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


class NeutralGitEtcTests(unittest.TestCase):
    def test_the_bundled_git_gets_fixed_network_files_never_the_build_pcs(self):
        with tempfile.TemporaryDirectory() as tmp:
            etc = Path(tmp) / "tools" / "git-2.53.0" / "etc"
            etc.mkdir(parents=True)
            (etc / "hosts").write_text("10.1.2.3 nas.home.example\n", encoding="utf-8")  # what Git would have copied
            (etc / "post-install").mkdir()
            (etc / "post-install" / "06-windows-files.post").write_text("cp /c/Windows/System32/drivers/etc/hosts /etc\n", encoding="utf-8")
            (etc.parent / "post-install.bat").write_text("@echo first run\n", encoding="utf-8")
            stage.neutral_git_etc(Path(tmp))
            # Git's first-run scripts are gone (they'd copy the running PC's files into the package later)...
            self.assertFalse((etc / "post-install").exists())
            self.assertFalse((etc.parent / "post-install.bat").exists())
            self.assertTrue((etc.parent / "dev" / "shm").is_dir())
            hosts = (etc / "hosts").read_text(encoding="utf-8")
            self.assertNotIn("10.1.2.3", hosts)
            addresses = [line.split()[0] for line in hosts.splitlines() if line.strip() and not line.startswith("#")]
            self.assertEqual(addresses, ["127.0.0.1", "::1"])
            self.assertEqual(sorted(p.name for p in etc.iterdir()), ["hosts", "networks", "protocols", "services"])


if __name__ == "__main__":
    unittest.main()
