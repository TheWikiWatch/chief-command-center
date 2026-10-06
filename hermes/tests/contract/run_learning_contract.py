"""Contract check for learning.py (Fleet Health's bundled ledger) against a real Hermes runtime.

    set HERMES_HOME=<temp>\\profiles\\chief
    <payload python> hermes\\tests\\contract\\run_learning_contract.py <payload dir>

Throwaway home only. Exit 0 = the contract holds.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import types
from pathlib import Path

payload = Path(sys.argv[1]).resolve()
sys.path[:0] = [str(payload / "hermes-agent"), str(payload / "venv" / "Lib" / "site-packages")]
home = Path(os.environ["HERMES_HOME"]).resolve()
assert home.parent.name == "profiles" and home.name == "chief", "HERMES_HOME must be <root>/profiles/chief"
root = home.parent.parent
home.mkdir(parents=True, exist_ok=True)
os.environ.pop("CHIEF_LEARNING_DIR", None)

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
data.chief_home = lambda root_=None: home
data.install_root = lambda: root
learning = load("learning")

failures: list[str] = []


def check(name: str, cond: bool, detail: object = "") -> None:
    print(("ok   " if cond else "FAIL ") + name + (f"  ({str(detail)[:300]})" if detail and not cond else ""))
    if not cond:
        failures.append(name)


# A team: the chief and one bot, each with a skill.
skill = home / "skills" / "devops" / "deploy" / "SKILL.md"
skill.parent.mkdir(parents=True)
skill.write_text("---\nname: deploy\n---\nv1\n", encoding="utf-8")
bot = root / "profiles" / "research-desk"
(bot / "skills" / "research" / "sources").mkdir(parents=True)
(bot / "config.yaml").write_text("model:\n  default: x\n", encoding="utf-8")
(home / "config.yaml").write_text("model:\n  default: x\n", encoding="utf-8")
(bot / "skills" / "research" / "sources" / "SKILL.md").write_text("---\nname: sources\n---\nfind\n", encoding="utf-8")

made = learning.ensure(home)
check("the ledger lands in the chief's scripts folder", (home / "scripts" / "learning_ledger.py").is_file() and made["script"], made)
jobs = json.loads((home / "cron" / "jobs.json").read_text(encoding="utf-8"))
jobs = {j["name"]: j for j in (jobs.get("jobs", jobs) if isinstance(jobs, dict) else jobs)}
ledger_job = jobs.get("Fleet: learning ledger") or {}
check(
    "a silent 30-minute ledger job",
    ledger_job.get("no_agent") is True
    and ledger_job.get("script") == "learning_ledger.py"
    and ledger_job.get("deliver") == "local"
    and (ledger_job.get("schedule") or {}).get("minutes") == 30,
    ledger_job,
)
distill = jobs.get("Fleet: lessons distill (weekly)") or {}
check(
    "a weekly distill with the distill skill, reporting to the app",
    "fleet-lessons-distill" in (distill.get("skills") or [])
    and distill.get("deliver") == "command_center"
    and str(root / "learning") in (distill.get("prompt") or ""),
    distill,
)
check("a monthly roster review", "fleet-ops" in ((jobs.get("Fleet: roster review (monthly)") or {}).get("skills") or []))
check("arming twice adds nothing", learning.ensure(home)["jobs"] == [])

first = learning.run_now()
report_path = root / "learning" / "report.json"
report = json.loads(report_path.read_text(encoding="utf-8"))
check("a first report is written", first["ok"] and report_path.is_file() and {d["desk"] for d in report["desks"]} == {"chief", "research-desk"}, first)
skill.write_text("---\nname: deploy\n---\nv1\nnew rule\n", encoding="utf-8")
second = learning.run_now()
report = json.loads(report_path.read_text(encoding="utf-8"))
check(
    "a skill edit is recorded with its scope",
    second["changes"] == 1
    and report["changes"][0]["scope"] == "chief"
    and report["changes"][0]["skill"] == "devops/deploy"
    and report["changes"][0]["canRevert"],
    report["changes"][:1],
)

# The cron job runs the copied script with the profile as HERMES_HOME and no arguments.
skill.write_text("---\nname: deploy\n---\nv2\n", encoding="utf-8")
env = {**os.environ, "HERMES_HOME": str(home), "PYTHONIOENCODING": "utf-8"}
env.pop("CHIEF_HERMES_ROOT", None)
out = subprocess.run([sys.executable, str(home / "scripts" / "learning_ledger.py")], env=env, capture_output=True, text=True, timeout=120)
report = json.loads(report_path.read_text(encoding="utf-8"))
check(
    "the script finds the root from the profile and records the edit",
    out.returncode == 0 and report["changes"][0]["skill"] == "devops/deploy" and len([c for c in report["changes"] if c["skill"] == "devops/deploy"]) == 2,
    out.stderr[-300:],
)
check("the report speaks of the chief, not a name", "(the chief)" in (root / "learning" / "report.md").read_text(encoding="utf-8"))

# An adopted install whose own ledger job runs its own script: the job is pointed at the app's ledger (same report
# folder), and ownLedger (CHIEF_OWN_LEDGER=1) puts the old script back.
from cron import jobs as cron_jobs


def ledger_job_script() -> str:
    with cron_jobs.use_cron_store(home):
        return next(j.get("script") for j in cron_jobs.list_jobs(include_disabled=True) if j.get("name") == "Fleet: learning ledger")


(home / "scripts" / "owner_learning_ledger_cron.py").write_text("print('the owner ledger')\n", encoding="utf-8")
with cron_jobs.use_cron_store(home):
    job_id = next(j["id"] for j in cron_jobs.list_jobs(include_disabled=True) if j.get("name") == "Fleet: learning ledger")
    cron_jobs.update_job(job_id, {"script": "owner_learning_ledger_cron.py"})
(home / "scripts" / "learning_ledger.py").unlink()
os.environ["CHIEF_ADOPTED"] = "1"
adopted = learning.ensure(home)
record = root / "learning" / "ledger-switch.json"
check(
    "an adopted install's ledger job runs the app's ledger",
    ledger_job_script() == "learning_ledger.py" and (home / "scripts" / "learning_ledger.py").is_file() and adopted["ledger"] == "app",
    adopted,
)
check("the old script is recorded", json.loads(record.read_text(encoding="utf-8"))["jobs"][0]["previous"] == "owner_learning_ledger_cron.py")
check("switching twice changes nothing", learning.ensure(home)["switched"] == [])
os.environ["CHIEF_OWN_LEDGER"] = "1"
back = learning.ensure(home)
check("ownLedger puts the old script back", ledger_job_script() == "owner_learning_ledger_cron.py" and not record.exists() and back["ledger"] == "own", back)
os.environ.pop("CHIEF_OWN_LEDGER")
os.environ.pop("CHIEF_ADOPTED")

print(json.dumps({"failures": failures}))
sys.exit(1 if failures else 0)
