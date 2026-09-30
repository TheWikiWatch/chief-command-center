"""Contract check for persona.py (SOUL and memory editing) against a real Hermes runtime.

    set HERMES_HOME=<temp>\\profiles\\chief
    <payload>\\tools\\python-...\\python.exe hermes\\tests\\contract\\run_persona_contract.py <payload dir>

Uses a throwaway home only. Exit 0 = the contract holds.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import types
from pathlib import Path

payload = Path(sys.argv[1]).resolve()
sys.path[:0] = [str(payload / "hermes-agent"), str(payload / "venv" / "Lib" / "site-packages")]
home = Path(os.environ["HERMES_HOME"]).resolve()
assert home.parent.name == "profiles" and home.name == "chief", "HERMES_HOME must be <root>/profiles/chief"
home.mkdir(parents=True, exist_ok=True)
(home.parent / "helper").mkdir(exist_ok=True)

plugin = Path(__file__).resolve().parents[2] / "plugins" / "chief-dashboard-bridge"
package = types.ModuleType("bridge")
package.__path__ = [str(plugin)]
sys.modules["bridge"] = package


def load(name: str):
    spec = importlib.util.spec_from_file_location(f"bridge.{name}", plugin / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[f"bridge.{name}"] = module
    spec.loader.exec_module(module)
    return module


data = load("data")
data.chief_home = lambda root=None: home
data.profiles_dir = lambda root=None: home.parent
persona = load("persona")
second_brain = load("second_brain")
work = Path(sys.argv[2]).resolve()
work.mkdir(parents=True, exist_ok=True)

failures: list[str] = []


def check(name: str, cond: bool, detail: object = "") -> None:
    print(("ok   " if cond else "FAIL ") + name + (f"  ({str(detail)[:300]})" if detail and not cond else ""))
    if not cond:
        failures.append(name)



from datetime import date

def raises(fn) -> str:
    try:
        fn()
    except second_brain.SecondBrainError as exc:
        return str(exc)
    return ""

# Locations
check("default folder is Documents\Second Brain", second_brain.default_folder().endswith("Second Brain"), second_brain.default_folder())
check("relative paths are refused", "full folder path" in raises(lambda: second_brain.inspect("notes")))
check("a drive root is refused", "whole drive" in raises(lambda: second_brain.inspect("C:\\")))
check("Chief's own home is refused", "belongs to" in raises(lambda: second_brain.inspect(str(home / "vault"))))
check("a parent of Chief's home is refused", "belongs to" in raises(lambda: second_brain.inspect(str(home.parent))))
if os.environ.get("SystemRoot"):
    check("the Windows folder is refused", "belongs to" in raises(lambda: second_brain.inspect(os.path.join(os.environ["SystemRoot"], "Notes"))))

status = second_brain.status()
check("status starts unconfigured", status["configured"] is False and status["contract"] == "chief.second_brain.v1", status)

# New folder
fresh = work / "Second Brain"
seen = second_brain.inspect(str(fresh))
check("a new folder offers only a new Second Brain", seen["exists"] is False and seen["choices"] == ["new"] and seen["writable"], seen)
check("the preview lists every template file", len(seen["plans"]["new"]["files"]) == 17 and "AGENTS.md" in seen["plans"]["new"]["files"], seen["plans"])
check("keep mode is refused for an empty folder", "empty" in raises(lambda: second_brain.setup(str(fresh), "keep")))
made = second_brain.setup(str(fresh), "new", today=date(2026, 10, 1))
check("setup creates the layout", made["ok"] and (fresh / "40 Knowledge" / "raw" / "articles").is_dir() and (fresh / "Journal" / "Daily").is_dir(), made)
agents = (fresh / "AGENTS.md").read_text(encoding="utf-8")
check("placeholders are filled", "created: 2026-10-01" in agents and "{{layout}}" not in agents and "| `10 Projects/` |" in agents)
example = (fresh / "10 Projects" / "Example project.md").read_text(encoding="utf-8")
check("relative dates are filled", "due: 2026-10-15" in example and "📅 2026-10-04" in example, example[:200])
daily = (fresh / "Templates" / "Daily note.md").read_text(encoding="utf-8")
check("Obsidian's own template tokens are left alone", "{{date:YYYY-MM-DD}}" in daily)
status = second_brain.status()
check("Hermes paths point at the folder", status["configured"] and Path(status["path"]) == fresh and Path(status["wiki_path"]) == fresh / "40 Knowledge", status)
env_text = (home / ".env").read_text(encoding="utf-8")
check("the profile .env holds both paths", "OBSIDIAN_VAULT_PATH=" in env_text and "WIKI_PATH=" in env_text)
skill = home / "skills" / "note-taking" / "second-brain" / "SKILL.md"
check("the second-brain skill is installed with the real path", skill.is_file() and str(fresh) in skill.read_text(encoding="utf-8") and "{{vault}}" not in skill.read_text(encoding="utf-8"))
from agent.skill_utils import parse_frontmatter
meta, _ = parse_frontmatter(skill.read_text(encoding="utf-8"))
check("the skill's frontmatter parses", meta.get("name") == "second-brain", meta)

# Create-only
(fresh / "Home.md").write_text("My own home page\n", encoding="utf-8")
(fresh / "Templates" / "Project.md").unlink()
again = second_brain.inspect(str(fresh))
check("our own folder is recognized and offers a top-up", again["ours"] and again["choices"] == ["new"] and again["plans"]["new"]["files"] == ["Templates/Project.md"], again["plans"])
topped = second_brain.setup(str(fresh), "new")
check("a re-run only fills what is missing", topped["created"] == ["Templates/Project.md"] and "Home.md" in topped["kept"], topped)
check("an edited file is never overwritten", (fresh / "Home.md").read_text(encoding="utf-8") == "My own home page\n")

# Existing notes (an Obsidian vault)
vault = work / "My Vault"
(vault / ".obsidian").mkdir(parents=True)
(vault / "Work").mkdir()
(vault / "Work" / "Plans.md").write_text("# Plans\n", encoding="utf-8")
(vault / "Diary.md").write_text("# Diary\n", encoding="utf-8")
(vault / "Templates").mkdir()
(vault / "Templates" / "Daily note.md").write_text("mine\n", encoding="utf-8")
seen = second_brain.inspect(str(vault))
check("an existing vault is described", seen["obsidian"] and seen["notes"] == 3 and seen["top_folders"] == ["Templates", "Work"] and seen["choices"] == ["keep", "reorganize"], seen)
check("the keep preview skips files already there", "Templates/Daily note.md" in seen["plans"]["keep"]["existing"] and "10 Projects/Example project.md" not in seen["plans"]["keep"]["files"], seen["plans"]["keep"])
check("new mode is refused for a folder with notes", "already has notes" in raises(lambda: second_brain.setup(str(vault), "new")))
kept = second_brain.setup(str(vault), "keep")
check("keep mode adds only the rules, Inbox, Knowledge and Templates", kept["ok"] and not (vault / "10 Projects").exists() and (vault / "00 Inbox" / "Welcome.md").is_file() and (vault / "40 Knowledge" / "SCHEMA.md").is_file(), kept)
check("keep mode leaves the owner's files alone", (vault / "Templates" / "Daily note.md").read_text(encoding="utf-8") == "mine\n" and (vault / "Work" / "Plans.md").is_file())
check("keep mode asks Chief to describe the layout", "AGENTS.md" in kept["next_prompt"] and "Where things go" in (vault / "AGENTS.md").read_text(encoding="utf-8"), kept)
check("switching folders repoints Hermes", Path(second_brain.status()["path"]) == vault and str(vault) in skill.read_text(encoding="utf-8"))
check("status remembers the mode", second_brain.status()["mode"] == "keep")

# Default persona
(home / "SOUL.md").write_text("You are my custom bot.\n", encoding="utf-8")
check("a customized SOUL is never replaced", second_brain.seed_soul() == {"ok": True, "seeded": False} and "custom" in (home / "SOUL.md").read_text(encoding="utf-8"))
from hermes_cli.default_soul import DEFAULT_SOUL_MD
(home / "SOUL.md").write_text(DEFAULT_SOUL_MD, encoding="utf-8")
seeded = second_brain.seed_soul()
check("Hermes's stock SOUL becomes Chief's default", seeded["seeded"] and (home / "SOUL.md").read_text(encoding="utf-8").startswith("You are Chief"), seeded)
check("the stock text is kept in SOUL history", any("Hermes Agent" in p.read_text(encoding="utf-8") for p in (home / "soul-history").glob("*.md")))
check("seeding twice changes nothing", second_brain.seed_soul()["seeded"] is False)

print(json.dumps({"failures": failures}))
sys.exit(1 if failures else 0)
