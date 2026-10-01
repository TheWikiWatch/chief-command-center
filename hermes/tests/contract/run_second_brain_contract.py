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
second_brain._profile_home = lambda profile="chief": home

# The bundled toolkit, installed as provisioning does (its routines are armed at setup).
spec = importlib.util.spec_from_file_location("provision", plugin.parents[2] / "apps" / "desktop" / "python" / "provision.py")
provision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provision)
provision.install_toolkit(plugin.parents[1] / "vendor" / "obsidian-second-brain", home / "skills" / "obsidian-second-brain", sys.executable, "")
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
check("default folder is Documents, then Second Brain", second_brain.default_folder().endswith("Second Brain"), second_brain.default_folder())
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
check("the preview lists every template file", len(seen["plans"]["new"]["files"]) == 21 and "CRITICAL_FACTS.md" in seen["plans"]["new"]["files"], seen["plans"])
check("keep mode is refused for an empty folder", "empty" in raises(lambda: second_brain.setup(str(fresh), "keep")))
made = second_brain.setup(str(fresh), "new", today=date(2026, 10, 1))
check("setup creates the layout", made["ok"] and (fresh / "40 Knowledge" / "raw" / "articles").is_dir() and (fresh / "Journal" / "Daily").is_dir(), made)
agents = (fresh / "AGENTS.md").read_text(encoding="utf-8")
check("placeholders are filled", "date: 2026-10-01" in agents and "{{layout}}" not in agents and "{{foldermap}}" not in agents and "| `10 Projects/` |" in agents)
check("the rules carry a Folder Map the toolkit reads", "## Folder Map" in agents and "| Person | `30 Resources/People/` |" in agents)
check("the toolkit's files are there", all((fresh / f).is_file() for f in ("_CLAUDE.md", "CRITICAL_FACTS.md", "index.md", "log.md")))
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
text = skill.read_text(encoding="utf-8")
check("the skill carries the critical facts", "**Owner:**" in text and "{{critical_facts}}" not in text and "{{toolkit}}" not in text and "## For future agent" not in text)
writes = home / "skills" / "note-taking" / "second-brain-writes" / "SKILL.md"
check("the write gate is installed", writes.is_file() and str(fresh) in writes.read_text(encoding="utf-8") and parse_frontmatter(writes.read_text(encoding="utf-8"))[0].get("name") == "second-brain-writes")
import yaml
cfg = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8")) or {}
check("the skill loads into every conversation", "second-brain" in ((cfg.get("skills") or {}).get("auto_load") or []), cfg.get("skills"))
check("the toolkit's settings file stays in the profile", "OBSIDIAN_ENV_FILE=" in (home / ".env").read_text(encoding="utf-8"))

# Routines
jobs = json.loads((home / "cron" / "jobs.json").read_text(encoding="utf-8"))
jobs = jobs.get("jobs", jobs) if isinstance(jobs, dict) else jobs
ours = {j["name"]: j for j in jobs if str(j.get("name", "")).startswith("Second Brain:")}
check("setup arms the four routines", len(ours) == 4 and made.get("routines") is None or len(ours) == 4, list(ours))
night = ours.get("Second Brain: nightly") or {}
check("a routine runs the toolkit's skill in the folder and reports to the app",
      night.get("deliver") == "command_center" and Path(night.get("workdir") or "") == fresh and "obsidian-nightly" in (night.get("skills") or [])
      and (night.get("schedule") or {}).get("expr") == "0 22 * * *", night)
listed = second_brain.routines()
check("routines are listed for the app", [r["id"] for r in listed["routines"]] == ["morning", "nightly", "weekly", "health"] and all(r["enabled"] for r in listed["routines"]), listed)
off = second_brain.set_routine("nightly", enabled=False)
check("a routine can be turned off", next(r for r in off["routines"] if r["id"] == "nightly")["enabled"] is False)
moved = second_brain.set_routine("nightly", at="21:30", enabled=True)
row = next(r for r in moved["routines"] if r["id"] == "nightly")
check("and moved to another time, then back on", row["enabled"] and row["time"] == "21:30", row)
check("a bad time is refused", "08:30" in raises(lambda: second_brain.set_routine("morning", at="8pm")))
check("an unknown routine is refused", raises(lambda: second_brain.set_routine("hourly", enabled=True)) != "")
again_made = second_brain.ensure_routines(home, fresh)
check("arming twice adds nothing", again_made == [], again_made)

# Critical facts follow the file
facts = fresh / "CRITICAL_FACTS.md"
facts.write_text(facts.read_text(encoding="utf-8").replace("- **Owner:** (name, and how they like to be addressed)", "- **Owner:** Sam, call me Sam"), encoding="utf-8")
check("a changed CRITICAL_FACTS.md re-renders the skill", second_brain.sync_critical_facts() and "Sam, call me Sam" in skill.read_text(encoding="utf-8"))
check("an unchanged one doesn't", second_brain.sync_critical_facts() is False)

# Upgrade from a version-1 Second Brain
state_path = home / "second_brain.json"
state = json.loads(state_path.read_text(encoding="utf-8"))
state["template"] = 1
state_path.write_text(json.dumps(state), encoding="utf-8")
for name in ("_CLAUDE.md", "CRITICAL_FACTS.md"):
    (fresh / name).unlink()
cut = agents.index("## Folder Map")
(fresh / "AGENTS.md").write_text(agents[:cut] + agents[agents.index("## Notes agents write"):], encoding="utf-8")
up = second_brain.upgrade()
check("an earlier Second Brain gets the new files", up["upgraded"] and (fresh / "_CLAUDE.md").is_file() and (fresh / "CRITICAL_FACTS.md").is_file(), up)
check("and a Folder Map in its rules", (fresh / "AGENTS.md").read_text(encoding="utf-8").count("## Folder Map") == 1)
check("the update is logged", "Second Brain updated by the app" in (fresh / "log.md").read_text(encoding="utf-8"))
check("upgrading twice changes nothing", second_brain.upgrade()["upgraded"] is False)

# A bot gets the Second Brain the way the chief has it
bot = home.parent / "research-desk"
bot.mkdir(exist_ok=True)
(bot / "config.yaml").write_text("model:\n  default: x\n", encoding="utf-8")
check("a bot is given the Second Brain", second_brain.share_with(bot) is True)
bot_cfg = yaml.safe_load((bot / "config.yaml").read_text(encoding="utf-8")) or {}
bot_skill = bot / "skills" / "note-taking" / "second-brain" / "SKILL.md"
check("with the skill loaded into its conversations", bot_skill.is_file() and str(fresh) in bot_skill.read_text(encoding="utf-8")
      and "second-brain" in (bot_cfg.get("skills") or {}).get("auto_load", []), bot_cfg.get("skills"))
check("the write gate, the folder and the chief's toolkit", (bot / "skills" / "note-taking" / "second-brain-writes" / "SKILL.md").is_file()
      and "OBSIDIAN_VAULT_PATH=" in (bot / ".env").read_text(encoding="utf-8")
      and any(d.endswith("obsidian-second-brain") for d in (bot_cfg.get("skills") or {}).get("external_dirs", [])), bot_cfg)
check("sharing twice changes nothing", second_brain.share_with(bot) is True and (yaml.safe_load((bot / "config.yaml").read_text(encoding="utf-8")) or {}) == bot_cfg)
check("the chief isn't shared with itself", second_brain.share_with(home) is False)

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
v1 = (plugin.parents[1] / "tests" / "fixtures" / "soul_default_v1.md").read_text(encoding="utf-8")
(home / "SOUL.md").write_text(v1.replace("\n", "\r\n"), encoding="utf-8", newline="")
refreshed = second_brain.seed_soul()
check("an unedited earlier default becomes the current one", refreshed["seeded"] and "Your Second Brain:" in (home / "SOUL.md").read_text(encoding="utf-8"), refreshed)
(home / "SOUL.md").write_text(v1 + "\nOne line of my own.\n", encoding="utf-8")
check("an edited earlier default is kept", second_brain.seed_soul()["seeded"] is False and "One line of my own." in (home / "SOUL.md").read_text(encoding="utf-8"))

print(json.dumps({"failures": failures}))
sys.exit(1 if failures else 0)
