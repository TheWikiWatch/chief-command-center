"""Fleet Health's learning ledger, run by the app (contract `chief.learning.v1`).

The ledger (`ledger/learning_ledger.py`, standard library) records every change to the team's skills,
judges each burst of edits by the cards before and after it, and writes `<root>/learning/report.json`, which
Fleet Health shows. This module keeps it running:

- `ensure()`: copies the ledger into the chief's `scripts/` folder (Hermes runs cron scripts only from
  there) and arms three jobs in the chief's profile:
  - `Fleet: learning ledger` every 30 minutes, script only, silent;
  - `Fleet: lessons distill (weekly)`, Sunday 17:00, the `fleet-lessons-distill` skill: proposals the
    owner approves or dismisses in Fleet Health;
  - `Fleet: roster review (monthly)`, the 1st at 17:00, the `fleet-ops` skill's roster review.
  A job the owner paused or retimed is left as it is.
- `run_now()`: one ledger run, so Fleet Health has a report before the first scheduled one.
"""
from __future__ import annotations

import importlib.util
import logging
import os
import shutil
import threading
from pathlib import Path
from typing import Any

from . import data

logger = logging.getLogger("chief-dashboard-bridge")

CONTRACT = "chief.learning.v1"
LEDGER_SOURCE = Path(__file__).resolve().parent / "ledger" / "learning_ledger.py"
SCRIPT_NAME = "learning_ledger.py"
_run_lock = threading.Lock()


def folder() -> Path:
    """Fleet Health's data folder: CHIEF_LEARNING_DIR, else <root>/learning."""
    explicit = (os.environ.get("CHIEF_LEARNING_DIR") or "").strip()
    return Path(explicit) if explicit else data.install_root() / "learning"


def _jobs_spec(learning: Path) -> tuple[dict[str, Any], ...]:
    where = str(learning)
    return (
        {"name": "Fleet: learning ledger", "schedule": "every 30m", "script": SCRIPT_NAME, "no_agent": True, "deliver": "local",
         "prompt": None, "skills": None},
        {"name": "Fleet: lessons distill (weekly)", "schedule": "0 17 * * 0", "deliver": "command_center",
         "skills": ["fleet-lessons-distill", "fleet-ops"],
         "prompt": (f"Run the weekly lessons distill with the fleet-lessons-distill skill. Fleet Health's folder is {where}: read "
                    f"report.json, decisions.json and proposals.json there; write proposals.json and append the week to "
                    f"LEARNINGS.md, nothing else. Never apply a change. "
                    "Finish with one short screen for the owner.")},
        {"name": "Fleet: roster review (monthly)", "schedule": "0 17 1 * *", "deliver": "command_center", "skills": ["fleet-ops"],
         "prompt": (f"Run the monthly roster review from the fleet-ops skill. Fleet Health's report is {where}\\report.json. "
                    "Change nothing; report one screen to the owner with at most three proposed changes.")},
    )


def install_script(home: Path) -> bool:
    """Copy the ledger into the profile's scripts/ folder when it differs. True when it was (re)written."""
    target = home / "scripts" / SCRIPT_NAME
    try:
        if target.is_file() and target.read_bytes() == LEDGER_SOURCE.read_bytes():
            return False
    except OSError:
        pass
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".tmp")
    shutil.copyfile(LEDGER_SOURCE, tmp)
    os.replace(tmp, target)
    return True


def ensure(home: Path | None = None) -> dict[str, Any]:
    """The ledger script in place and the three jobs armed (missing ones only)."""
    home = Path(home or data.chief_home())
    learning = folder()
    learning.mkdir(parents=True, exist_ok=True)
    wrote = install_script(home)
    from cron import jobs

    made = []
    with jobs.use_cron_store(home):
        names = {j.get("name") for j in jobs.list_jobs(include_disabled=True)}
        for spec in _jobs_spec(learning):
            if spec["name"] in names:
                continue
            kwargs: dict[str, Any] = {"name": spec["name"], "deliver": spec["deliver"]}
            if spec.get("script"):
                kwargs.update(script=spec["script"], no_agent=True)
            if spec.get("skills"):
                kwargs["skills"] = spec["skills"]
            jobs.create_job(spec["prompt"], spec["schedule"], **kwargs)
            made.append(spec["name"])
    if made or wrote:
        logger.info("Fleet Health: ledger %s; jobs %s", "installed" if wrote else "current", ", ".join(made) or "already armed")
    return {"ok": True, "contract": CONTRACT, "folder": str(learning), "script": wrote, "jobs": made}


def _ledger_module():
    spec = importlib.util.spec_from_file_location("chief_learning_ledger", LEDGER_SOURCE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.HERMES = data.install_root()
    module.OUT = folder()
    module.DB = module.OUT / "ledger.db"
    module.KANBAN = module.HERMES / "kanban.db"
    return module


def run_now() -> dict[str, Any]:
    """Snapshot the skills and write a fresh report (what the 30-minute job does)."""
    if not _run_lock.acquire(blocking=False):
        return {"ok": True, "skipped": "already running"}
    try:
        ledger = _ledger_module()
        changed = ledger.snapshot()
        report = ledger.report()
        return {"ok": True, "changes": changed, "flags": len(report.get("flags") or []), "folder": str(folder())}
    finally:
        _run_lock.release()
