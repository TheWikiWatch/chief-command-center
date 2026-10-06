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
- An adopted install keeps its own report folder and jobs, but runs the app's ledger: `ensure()` copies it into
  `scripts/` and points the install's own ledger job at it (the old script name is kept in
  `<learning>/ledger-switch.json`). With CHIEF_OWN_LEDGER=1 (desktop.json `ownLedger`) the old script comes back.
- `run_now()`: one ledger run, so Fleet Health has a report before the first scheduled one.
"""

from __future__ import annotations

import importlib.util
import json
import logging
import os
import re
import shutil
import threading
import time
from pathlib import Path
from typing import Any

from . import data

logger = logging.getLogger("chief-dashboard-bridge")

CONTRACT = "chief.learning.v1"
LEDGER_SOURCE = Path(__file__).resolve().parent / "ledger" / "learning_ledger.py"
SCRIPT_NAME = "learning_ledger.py"
SWITCH_FILE = "ledger-switch.json"
_LEDGER_SCRIPT = re.compile(r"learning[_-]?ledger", re.I)
_run_lock = threading.Lock()


def folder() -> Path:
    """Fleet Health's data folder: CHIEF_LEARNING_DIR, else <root>/learning."""
    explicit = (os.environ.get("CHIEF_LEARNING_DIR") or "").strip()
    return Path(explicit) if explicit else data.install_root() / "learning"


def _jobs_spec(learning: Path) -> tuple[dict[str, Any], ...]:
    where = str(learning)
    return (
        {
            "name": "Fleet: learning ledger",
            "schedule": "every 30m",
            "script": SCRIPT_NAME,
            "no_agent": True,
            "deliver": "local",
            "prompt": None,
            "skills": None,
        },
        {
            "name": "Fleet: lessons distill (weekly)",
            "schedule": "0 17 * * 0",
            "deliver": "command_center",
            "skills": ["fleet-lessons-distill", "fleet-ops"],
            "prompt": (
                f"Run the weekly lessons distill with the fleet-lessons-distill skill. Fleet Health's folder is {where}: read "
                f"report.json, decisions.json and proposals.json there; write proposals.json and append the week to "
                f"LEARNINGS.md, nothing else. Never apply a change. "
                "Finish with one short screen for the owner."
            ),
        },
        {
            "name": "Fleet: roster review (monthly)",
            "schedule": "0 17 1 * *",
            "deliver": "command_center",
            "skills": ["fleet-ops"],
            "prompt": (
                f"Run the monthly roster review from the fleet-ops skill. Fleet Health's report is {where}\\report.json. "
                "Change nothing; report one screen to the owner with at most three proposed changes."
            ),
        },
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


def _switch_record() -> Path:
    return folder() / SWITCH_FILE


def adopt_ledger(home: Path) -> dict[str, Any]:
    """An adopted install's own ledger job runs the app's ledger (same report folder, same history), so every
    ledger fix reaches it with app updates. Jobs running another `learning_ledger` script are pointed at the app's
    copy, and their old script is recorded so CHIEF_OWN_LEDGER=1 can put it back. No ledger job at all: the app's
    30-minute job is armed (the distill and roster jobs stay the owner's business)."""
    from cron import jobs

    record = _switch_record()
    try:
        switched = json.loads(record.read_text(encoding="utf-8")).get("jobs") or []
    except (OSError, ValueError):
        switched = []
    own = os.environ.get("CHIEF_OWN_LEDGER") == "1"
    changed: list[str] = []
    with jobs.use_cron_store(home):
        listed = jobs.list_jobs(include_disabled=True)
        if own:
            previous = {str(j.get("id")): str(j.get("previous") or "") for j in switched}
            for job in listed:
                old = previous.get(str(job.get("id")))
                if old and job.get("script") == SCRIPT_NAME:
                    jobs.update_job(job["id"], {"script": old})
                    changed.append(str(job.get("name") or job["id"]))
            if switched:
                record.unlink(missing_ok=True)
            if changed:
                logger.info("Fleet Health: back to the install's own ledger for %s", ", ".join(changed))
            return {"ledger": "own", "switched": changed}
        install_script(home)
        ledger_jobs = [j for j in listed if _LEDGER_SCRIPT.search(Path(str(j.get("script") or "")).name)]
        for job in ledger_jobs:
            if job.get("script") != SCRIPT_NAME:
                switched = [j for j in switched if str(j.get("id")) != str(job["id"])]
                switched.append({"id": job["id"], "name": job.get("name"), "previous": job.get("script"), "at": time.time()})
                jobs.update_job(job["id"], {"script": SCRIPT_NAME})
                changed.append(str(job.get("name") or job["id"]))
        if not ledger_jobs:
            spec = _jobs_spec(folder())[0]
            jobs.create_job(spec["prompt"], spec["schedule"], name=spec["name"], deliver=spec["deliver"], script=spec["script"], no_agent=True)
            changed.append(spec["name"])
    if changed:
        folder().mkdir(parents=True, exist_ok=True)
        tmp = record.with_suffix(".tmp")
        tmp.write_text(json.dumps({"jobs": switched}, indent=1), encoding="utf-8")
        os.replace(tmp, record)
        logger.info("Fleet Health: %s now run%s the app's ledger", ", ".join(changed), "s" if len(changed) == 1 else "")
    return {"ledger": "app", "switched": changed}


def ensure(home: Path | None = None) -> dict[str, Any]:
    """The ledger script in place and the three jobs armed (missing ones only). An adopted install keeps its own
    report folder (CHIEF_LEARNING_DIR) and jobs, with its ledger job running the app's ledger (`adopt_ledger`)."""
    home = Path(home or data.chief_home())
    if os.environ.get("CHIEF_ADOPTED") == "1":
        result = adopt_ledger(home)
        return {"ok": True, "contract": CONTRACT, "folder": str(folder()), "script": result["ledger"] == "app", "jobs": [], "adopted": True, **result}
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
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Fleet Health's ledger isn't loadable from {LEDGER_SOURCE}")
    module: Any = importlib.util.module_from_spec(spec)
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
