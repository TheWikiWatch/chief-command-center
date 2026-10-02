"""Installing the vendored Second Brain toolkit (apps/desktop/python/provision.py), without Hermes."""

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("provision", ROOT / "apps/desktop/python/provision.py")
provision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provision)
VENDOR = ROOT / "hermes/vendor/obsidian-second-brain"


class ToolkitInstallTests(unittest.TestCase):
    def setUp(self):
        scratch = ROOT / "hermes/tests/.runtime"
        scratch.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=scratch)
        self.addCleanup(self.temp.cleanup)
        self.dest = Path(self.temp.name) / "my skills" / "obsidian-second-brain"  # a space, as in many user folders

    def install(self):
        return provision.install_toolkit(VENDOR, self.dest, sys.executable, "C:/py/site-packages")

    def test_the_vendored_release_is_complete_and_attributed(self):
        meta = json.loads((VENDOR / "vendor.json").read_text(encoding="utf-8"))
        self.assertEqual(meta["license"], "MIT")
        self.assertTrue((VENDOR / "LICENSE").read_text(encoding="utf-8").startswith("MIT License"))
        self.assertIn("Eugeniu Ghelbur", (VENDOR / "NOTICE.md").read_text(encoding="utf-8"))
        self.assertEqual(sorted(meta["routines"]), ["obsidian-health-check", "obsidian-morning", "obsidian-nightly", "obsidian-weekly"])
        self.assertFalse((VENDOR / "skills/research").exists(), "research skills need paid keys and downloads: left out")

    def test_skills_land_where_hermes_finds_them_and_never_call_uv(self):
        self.assertTrue(self.install())
        self.assertTrue((self.dest / "vault/obsidian-daily/SKILL.md").is_file())
        self.assertTrue((self.dest / "obsidian-nightly/SKILL.md").is_file())
        self.assertTrue((self.dest / "scripts/vault_health.py").is_file())
        self.assertTrue((self.dest / "references/ai-first-rules.md").is_file())
        for skill in self.dest.rglob("SKILL.md"):
            text = skill.read_text(encoding="utf-8")
            self.assertNotRegex(text, r"uv run --directory", skill)
            self.assertNotIn(".hermes/skills/obsidian-second-brain", text, skill)

    def test_a_rewritten_call_runs_on_this_python(self):
        self.install()
        text = (self.dest / "meta/obsidian-health/SKILL.md").read_text(encoding="utf-8")
        import re

        m = re.search(r'PYTHONPATH="[^"]+" "([^"]+)" "([^"]+/scripts/vault_health\.py)"', text)
        self.assertIsNotNone(m, "the health skill names the interpreter and the quoted script path")
        vault = Path(self.temp.name) / "vault"
        (vault / "Notes").mkdir(parents=True)
        (vault / "Notes" / "a.md").write_text("---\ntype: note\n---\n# A\n", encoding="utf-8")
        out = subprocess.run([m.group(1), m.group(2), "--path", str(vault), "--json"], capture_output=True, text=True, encoding="utf-8", timeout=120)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn('"total_notes": 1', out.stdout)

    def test_owner_edits_are_kept_and_unedited_files_update(self):
        self.install()
        edited = self.dest / "vault/obsidian-daily/SKILL.md"
        edited.write_text("my own daily routine\n", encoding="utf-8")
        untouched = self.dest / "vault/obsidian-capture/SKILL.md"
        untouched.write_text(untouched.read_text(encoding="utf-8"), encoding="utf-8")
        self.assertEqual(self.install(), [])
        self.assertEqual(edited.read_text(encoding="utf-8"), "my own daily routine\n")


if __name__ == "__main__":
    unittest.main()


class AdoptedInstallTests(unittest.TestCase):
    """An existing install the app takes over keeps its own skills and its own toolkit."""

    def setUp(self):
        scratch = ROOT / "hermes/tests/.runtime"
        scratch.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=scratch)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "profiles" / "chief"
        self.shared = self.root / "skills"
        (self.home / "skills").mkdir(parents=True)
        (self.home / "config.yaml").write_text(f"skills:\n  external_dirs:\n    - {self.shared.as_posix()}\n", encoding="utf-8")
        self.bundled = self.root / "bundled"
        for name in ("fleet-ops", "fleet-builder"):
            (self.bundled / "autonomous-ai-agents" / name).mkdir(parents=True)
            (self.bundled / "autonomous-ai-agents" / name / "SKILL.md").write_text(f"---\nname: {name}\nauthor: Chief Command Center\n---\n", encoding="utf-8")

    def test_a_same_named_skill_elsewhere_is_never_shadowed(self):
        mine = self.shared / "agents" / "fleet-ops" / "SKILL.md"
        mine.parent.mkdir(parents=True)
        mine.write_text("---\nname: fleet-ops\n---\nmine\n", encoding="utf-8")
        changed = provision.install_bundled_skills(self.bundled, self.home / "skills", provision.external_skill_dirs(self.home))
        self.assertEqual(changed, ["skill fleet-builder"])
        self.assertFalse((self.home / "skills" / "autonomous-ai-agents" / "fleet-ops").exists())
        self.assertEqual(mine.read_text(encoding="utf-8"), "---\nname: fleet-ops\n---\nmine\n")

    def test_the_install_s_own_toolkit_is_found(self):
        self.assertIsNone(provision.owner_toolkit(self.home))
        (self.shared / "obsidian-second-brain").mkdir(parents=True)
        self.assertEqual(provision.owner_toolkit(self.home), self.shared / "obsidian-second-brain")
