"""Team & Routines: every scheduled routine, for the chief and every bot (contract `chief.routines.v1`).

A routine is a Hermes cron job in the store of the bot that runs it, so it runs as that bot: its SOUL, model
and skills. Hermes's in-process ticker visits every live profile's store. A routine reports into a thread
of the chief's chat. The chief's routines deliver there themselves (`command_center:<thread chat>`; the main
thread is the platform's home channel). A bot's profile doesn't serve the Command Center, and Hermes blocks
a job whose delivery platform its profile doesn't know, so a bot's routine is saved as `local` and the
bridge relays each new run's answer into the chosen thread (`relay()`, on the watch loop). The thread a
bot's routine reports to, and the last run relayed, live in the chief's profile.

Built-in routines (`Second Brain: …`, `Fleet: …`) are the app's: they can be retimed, moved to another
thread and switched off, but not deleted or rewritten, because the app would arm them again.
"""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

from . import data, threads

logger = logging.getLogger("chief-dashboard-bridge")

CONTRACT = "chief.routines.v1"
BUILT_IN = ("Second Brain:", "Fleet:")
_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
_TIME = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")
_PROFILE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_MAX_PROMPT = 4000
_THREADS_FILE = "routine_threads.json"
_RELAYED_FILE = "routine_relayed.json"


class RoutineError(ValueError):
    pass


def _homes() -> list[tuple[str, Path]]:
    chief = data.chief_home()
    out = [("chief", chief)]
    if chief.parent.is_dir():
        for home in sorted(p for p in chief.parent.iterdir() if p.is_dir() and p != chief and (p / "config.yaml").is_file()):
            out.append((home.name, home))
    return out


def _home(profile: str) -> Path:
    profile = (profile or "chief").strip().lower()
    if not _PROFILE.match(profile):
        raise RoutineError("Unknown bot.")
    for name, home in _homes():
        if name == profile:
            return home
    raise RoutineError("Unknown bot.")


def _cron():
    from cron import jobs

    return jobs


def _bot_name(profile: str, home: Path) -> str:
    from .usage import _title

    return _title(profile, home)


# ---------------------------------------------------------------- schedules in plain words


def describe_schedule(schedule: dict[str, Any]) -> dict[str, Any]:
    """{kind, time, days, every, cron, text} from a Hermes schedule record."""
    schedule = schedule or {}
    if schedule.get("kind") == "interval":
        minutes = int(schedule.get("minutes") or 0)
        if minutes and minutes % 60 == 0:
            hours = minutes // 60
            return {"kind": "hourly", "every": hours, "text": "Every hour" if hours == 1 else f"Every {hours} hours"}
        return {"kind": "custom", "cron": schedule.get("display") or f"every {minutes}m",
                "text": f"Every {minutes} minutes" if minutes else str(schedule.get("display") or "")}
    expr = str(schedule.get("expr") or "").split()
    text = " ".join(expr) or str(schedule.get("display") or "")
    if len(expr) == 5 and expr[2] == "*" and expr[3] == "*":
        minute, hour, _dom, _mon, dow = expr
        if minute.isdigit() and hour.isdigit():
            at = f"{int(hour):02d}:{int(minute):02d}"
            if dow == "*":
                return {"kind": "daily", "time": at, "text": f"Every day at {at}"}
            if dow == "1-5":
                return {"kind": "weekdays", "time": at, "text": f"Weekdays at {at}"}
            if re.fullmatch(r"[0-6](,[0-6])*", dow):
                days = sorted({int(d) for d in dow.split(",")})
                return {"kind": "weekly", "time": at, "days": days, "text": f"{', '.join(_DAYS[d] for d in days)} at {at}"}
        if minute.isdigit() and re.fullmatch(r"\*/\d+", hour) and dow == "*":
            hours = int(hour[2:])
            return {"kind": "hourly", "every": hours, "text": "Every hour" if hours == 1 else f"Every {hours} hours"}
    if len(expr) == 5 and expr[2].isdigit() and expr[3] == "*" and expr[4] == "*" and expr[0].isdigit() and expr[1].isdigit():
        return {"kind": "custom", "cron": text, "text": f"Monthly on the {int(expr[2])}{_ordinal(int(expr[2]))} at {int(expr[1]):02d}:{int(expr[0]):02d}"}
    return {"kind": "custom", "cron": text, "text": text}


def _ordinal(n: int) -> str:
    return "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")


def schedule_expr(spec: dict[str, Any]) -> str:
    """A Hermes schedule string from the app's plain parts."""
    kind = str(spec.get("kind") or "")
    if kind in ("daily", "weekdays", "weekly"):
        m = _TIME.match(str(spec.get("time") or ""))
        if not m:
            raise RoutineError("Pick a time, like 08:30.")
        hour, minute = int(m.group(1)), int(m.group(2))
        if kind == "daily":
            return f"{minute} {hour} * * *"
        if kind == "weekdays":
            return f"{minute} {hour} * * 1-5"
        days = sorted({int(d) for d in (spec.get("days") or []) if str(d).isdigit() and 0 <= int(d) <= 6})
        if not days:
            raise RoutineError("Pick at least one day.")
        return f"{minute} {hour} * * {','.join(str(d) for d in days)}"
    if kind == "hourly":
        every = int(spec.get("every") or 0)
        if not 1 <= every <= 24:
            raise RoutineError("Every 1 to 24 hours.")
        return f"0 */{every} * * *" if every > 1 else "0 * * * *"
    if kind == "custom":
        expr = " ".join(str(spec.get("cron") or "").split())
        if not expr:
            raise RoutineError("Write a schedule, like '30 7 * * 1-5' or 'every 2h'.")
        try:
            _cron().parse_schedule(expr)
        except Exception as exc:
            raise RoutineError(f"That schedule isn't valid: {exc}") from None
        return expr
    raise RoutineError("Choose when it runs.")


# ---------------------------------------------------------------- reading


def _deliver_for(thread: str) -> str:
    thread = thread or threads.MAIN
    if thread != threads.MAIN and not (threads.valid(thread) and threads.exists(thread)):
        raise RoutineError("Unknown thread.")
    return "command_center" if thread == threads.MAIN else f"command_center:{threads.chat_id(thread)}"


def _read(name: str) -> dict[str, Any]:
    try:
        value = json.loads((data.chief_home() / name).read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def _write(name: str, value: dict[str, Any]) -> None:
    path = data.chief_home() / name
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(value, indent=2, sort_keys=True), encoding="utf-8")
    tmp.replace(path)


def _key(profile: str, job_id: str) -> str:
    return f"{profile}/{job_id}"


def _set_bot_thread(profile: str, job_id: str, thread: str | None) -> None:
    """Where a bot's routine reports (None forgets it). A new routine relays from its first run on."""
    key = _key(profile, job_id)
    mapping, relayed = _read(_THREADS_FILE), _read(_RELAYED_FILE)
    if thread is None:
        mapping.pop(key, None)
        relayed.pop(key, None)
    else:
        mapping[key] = thread
        relayed.setdefault(key, "")
    _write(_THREADS_FILE, mapping)
    _write(_RELAYED_FILE, relayed)


def _thread_of(deliver: Any) -> str | None:
    text = str(deliver or "")
    if text == "command_center":
        return threads.MAIN
    if text.startswith("command_center:"):
        return threads.thread_of(text.split(":", 1)[1])
    return None


def _last_output(jobs: Any, job_id: str, limit: int = 1500) -> str:
    try:
        folder = jobs._job_output_dir(job_id)
        files = sorted((p for p in folder.glob("*") if p.is_file()), key=lambda p: p.stat().st_mtime)
        if not files:
            return ""
        text = files[-1].read_text(encoding="utf-8", errors="replace").strip()
        return text if len(text) <= limit else text[:limit].rstrip() + "…"
    except Exception:
        return ""


def _describe(profile: str, home: Path, job: dict[str, Any], jobs: Any) -> dict[str, Any]:
    name = str(job.get("name") or "")
    built_in = name.startswith(BUILT_IN)
    thread = _thread_of(job.get("deliver"))
    if profile != "chief" and thread is None:
        thread = _read(_THREADS_FILE).get(_key(profile, str(job.get("id") or "")))
    return {
        "id": str(job.get("id") or ""),
        "profile": profile,
        "bot": _bot_name(profile, home),
        "name": name,
        "prompt": str(job.get("prompt") or ""),
        "schedule": describe_schedule(job.get("schedule") or {}),
        "enabled": bool(job.get("enabled")) and job.get("state") != "paused",
        "state": str(job.get("state") or ""),
        "nextRun": job.get("next_run_at"),
        "lastRun": job.get("last_run_at"),
        "lastStatus": job.get("last_status"),
        "lastError": job.get("last_error"),
        "lastOutput": _last_output(jobs, str(job.get("id") or "")),
        "thread": thread,
        "silent": thread is None,
        "kind": "script" if job.get("no_agent") else "agent",
        "builtIn": built_in,
        "skills": list(job.get("skills") or []),
    }


def list_routines() -> dict[str, Any]:
    jobs = _cron()
    items = []
    for profile, home in _homes():
        try:
            with jobs.use_cron_store(home):
                for job in jobs.list_jobs(include_disabled=True):
                    items.append(_describe(profile, home, job, jobs))
        except Exception:
            logger.debug("routines read failed for %s", profile, exc_info=True)
    items.sort(key=lambda r: (r["builtIn"], r["profile"] != "chief", r["name"].lower()))
    bots = [{"id": p, "name": _bot_name(p, h)} for p, h in _homes()]
    return {"ok": True, "contract": CONTRACT, "routines": items, "bots": bots}


def _find(profile: str, routine_id: str) -> tuple[Path, dict[str, Any]]:
    home = _home(profile)
    jobs = _cron()
    with jobs.use_cron_store(home):
        job = jobs.get_job(str(routine_id or ""))
    if not job:
        raise RoutineError("That routine no longer exists.")
    return home, job


# ---------------------------------------------------------------- changing


def create(profile: str, name: str, prompt: str, schedule: dict[str, Any], thread: str = threads.MAIN) -> dict[str, Any]:
    home = _home(profile)
    name, prompt = " ".join(str(name or "").split()), str(prompt or "").strip()
    if not name or len(name) > 60:
        raise RoutineError("Give it a short name (up to 60 characters).")
    if name.startswith(BUILT_IN):
        raise RoutineError("Those names belong to the app's own routines.")
    if not prompt or len(prompt) > _MAX_PROMPT:
        raise RoutineError(f"Say what it should do (up to {_MAX_PROMPT:,} characters).")
    expr = schedule_expr(schedule)
    deliver = _deliver_for(thread)
    profile = home.name if home != data.chief_home() else "chief"
    jobs = _cron()
    with jobs.use_cron_store(home):
        job = jobs.create_job(prompt, expr, name=name, deliver=deliver if profile == "chief" else "local")
    if profile != "chief":
        _set_bot_thread(profile, job["id"], thread or threads.MAIN)
    logger.info("routines: %s created for %s (%s)", name, profile, expr)
    return {"ok": True, "routine": _describe(profile, home, job, jobs)}


def update(profile: str, routine_id: str, *, name: str | None = None, prompt: str | None = None,
           schedule: dict[str, Any] | None = None, thread: str | None = None, enabled: bool | None = None) -> dict[str, Any]:
    home, job = _find(profile, routine_id)
    profile = home.name if home != data.chief_home() else "chief"
    built_in = str(job.get("name") or "").startswith(BUILT_IN)
    changes: dict[str, Any] = {}
    if name is not None and not built_in:
        clean = " ".join(str(name).split())
        if not clean or len(clean) > 60 or clean.startswith(BUILT_IN):
            raise RoutineError("Give it a short name (up to 60 characters).")
        changes["name"] = clean
    if prompt is not None and not built_in:
        text = str(prompt).strip()
        if not text or len(text) > _MAX_PROMPT:
            raise RoutineError(f"Say what it should do (up to {_MAX_PROMPT:,} characters).")
        changes["prompt"] = text
    if schedule is not None:
        changes["schedule"] = schedule_expr(schedule)
    if thread is not None and not job.get("no_agent"):
        deliver = _deliver_for(thread)
        if profile == "chief":
            changes["deliver"] = deliver
        else:
            _set_bot_thread(profile, job["id"], thread or threads.MAIN)
    jobs = _cron()
    with jobs.use_cron_store(home):
        if changes:
            jobs.update_job(job["id"], changes)
        if enabled is True:
            jobs.resume_job(job["id"])
        elif enabled is False:
            jobs.pause_job(job["id"], reason="Turned off in the app.")
        job = jobs.get_job(job["id"]) or job
    return {"ok": True, "routine": _describe(profile, home, job, jobs)}


def run_now(profile: str, routine_id: str) -> dict[str, Any]:
    home, job = _find(profile, routine_id)
    profile = home.name if home != data.chief_home() else "chief"
    jobs = _cron()
    with jobs.use_cron_store(home):
        if not (job.get("enabled") and job.get("state") != "paused"):
            jobs.resume_job(job["id"])
        jobs.trigger_job(job["id"])
        job = jobs.get_job(job["id"]) or job
    return {"ok": True, "routine": _describe(profile, home, job, jobs)}


def delete(profile: str, routine_id: str) -> dict[str, Any]:
    home, job = _find(profile, routine_id)
    if str(job.get("name") or "").startswith(BUILT_IN):
        raise RoutineError("The app's own routines can be switched off, not deleted.")
    jobs = _cron()
    with jobs.use_cron_store(home):
        jobs.remove_job(job["id"])
    if home != data.chief_home():
        _set_bot_thread(home.name, job["id"], None)
    logger.info("routines: %s deleted for %s", job.get("name"), profile)
    return {"ok": True}


# ---------------------------------------------------------------- relaying a bot's runs


def _answer(text: str) -> str | None:
    """What a run said, from its output file: the answer, a short failure line, or None (silent/blocked)."""
    if "## Response" in text:
        answer = text.rpartition("## Response")[2].strip()
        return None if not answer or answer.upper().startswith("[SILENT]") else answer
    if "## Error" in text:
        return "This run didn't finish. Open Team & Routines to see what went wrong."
    return None


def relay(limit: int = 5) -> int:
    """Relay new runs of the bots' routines into their threads. Returns how many were posted."""
    mapping = _read(_THREADS_FILE)
    if not mapping:
        return 0
    from .outbox import append_outbox

    relayed = _read(_RELAYED_FILE)
    homes = dict(_homes())
    jobs = _cron()
    posted, changed = 0, False
    for key, thread in sorted(mapping.items()):
        profile, _, job_id = key.partition("/")
        home = homes.get(profile)
        if home is None or not threads.valid(str(thread)):
            continue
        try:
            with jobs.use_cron_store(home):
                job = jobs.get_job(job_id)
                folder = jobs._job_output_dir(job_id)
            files = sorted(p for p in folder.glob("*.md") if p.is_file()) if folder.is_dir() else []
        except Exception:
            logger.debug("routine relay read failed for %s", key, exc_info=True)
            continue
        if not job or not files:
            continue
        if key not in relayed:
            # Known before relaying existed: start from now, don't replay its history.
            relayed[key], changed = files[-1].name, True
            continue
        fresh = [p for p in files if p.name > str(relayed.get(key) or "")][-limit:]
        for path in fresh:
            answer = _answer(path.read_text(encoding="utf-8", errors="replace"))
            if answer:
                chat = threads.chat_id(thread if threads.exists(thread) else threads.MAIN)
                head = f"Routine: {job.get('name') or 'Routine'} ({_bot_name(profile, home)})"
                append_outbox(chat, f"{head}\n-------------\n\n{answer}", source="cron")
                posted += 1
            relayed[key], changed = path.name, True
    if changed:
        _write(_RELAYED_FILE, relayed)
    if posted:
        logger.info("routines: relayed %d bot routine run(s)", posted)
    return posted
