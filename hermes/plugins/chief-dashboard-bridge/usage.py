"""Token use and cost for the chief and every bot (contract `chief.usage.v1`), and the owner's monthly budget.

Read-only on Hermes's own records: each profile's `state.db` has one row per session (input, output, cached
and reasoning tokens, API calls, estimated cost from Hermes's pricing snapshot, actual cost when the provider
reports it), and `session_model_usage` adds the background tasks (titles, compression, background review)
that never touch the session counters. A session whose provider has no price is counted as unpriced, never
as free.

The budget (`usage_budget.json` in the chief's profile) is advisory: the app turns amber at 80 % and sends one
notification when a month passes 100 %. Nothing is ever stopped.
"""
from __future__ import annotations

import json
import logging
import sqlite3
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Optional

from . import data

logger = logging.getLogger("chief-dashboard-bridge")

CONTRACT = "chief.usage.v1"
PERIODS = ("today", "7d", "30d", "month")
BUDGET_FILE = "usage_budget.json"
WARN_AT = 0.8


def _since(period: str, now: Optional[datetime] = None) -> float:
    now = now or datetime.now()
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    if period == "today":
        start = midnight
    elif period == "7d":
        start = midnight - timedelta(days=6)
    elif period == "30d":
        start = midnight - timedelta(days=29)
    else:
        start = midnight.replace(day=1)
    return start.timestamp()


def _profiles() -> list[tuple[str, Path]]:
    """The chief first, then every bot that has a session store."""
    chief = data.chief_home()
    out = [("chief", chief)]
    pdir = chief.parent
    if pdir.is_dir():
        for home in sorted(p for p in pdir.iterdir() if p.is_dir() and p != chief and (p / "state.db").is_file()):
            out.append((home.name, home))
    return out


def _title(profile: str, home: Path) -> str:
    try:
        meta = data.load_yaml(home / "profile.yaml") if (home / "profile.yaml").is_file() else {}
        ui = meta.get("ui_meta") if isinstance(meta.get("ui_meta"), dict) else {}
        bots = ui.get("hermes-bots") if isinstance(ui.get("hermes-bots"), dict) else {}
        title = str(bots.get("title") or "")
    except Exception:
        title = ""
    if not title and profile == "chief":
        from . import identity

        return identity.assistant_name()
    return title.split(" - ")[0].strip() or profile


def _cost(estimated: Any, actual: Any) -> float:
    a = float(actual or 0)
    return a if a > 0 else float(estimated or 0)


def _read(home: Path, since: float) -> dict[str, Any]:
    """One profile's sessions and background calls since `since`, grouped."""
    db = home / "state.db"
    empty = {"sessions": [], "aux": []}
    if not db.is_file():
        return empty
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
        conn.row_factory = sqlite3.Row
    except sqlite3.Error:
        return empty
    try:
        sessions = conn.execute(
            "SELECT id, model, started_at, COALESCE(input_tokens,0) AS input, COALESCE(output_tokens,0) AS output, "
            "COALESCE(cache_read_tokens,0) AS cache_read, COALESCE(cache_write_tokens,0) AS cache_write, "
            "COALESCE(reasoning_tokens,0) AS reasoning, COALESCE(api_call_count,0) AS calls, "
            "estimated_cost_usd AS estimated, actual_cost_usd AS actual, cost_status "
            "FROM sessions WHERE started_at >= ?", (since,)).fetchall()
        try:
            aux = conn.execute(
                "SELECT model, task, first_seen AS started_at, COALESCE(input_tokens,0) AS input, COALESCE(output_tokens,0) AS output, "
                "COALESCE(cache_read_tokens,0) AS cache_read, COALESCE(cache_write_tokens,0) AS cache_write, "
                "COALESCE(reasoning_tokens,0) AS reasoning, COALESCE(api_call_count,0) AS calls, "
                "estimated_cost_usd AS estimated, actual_cost_usd AS actual, cost_status "
                "FROM session_model_usage WHERE COALESCE(task,'') != '' AND first_seen >= ?", (since,)).fetchall()
        except sqlite3.Error:
            aux = []
        return {"sessions": [dict(r) for r in sessions], "aux": [dict(r) for r in aux]}
    except sqlite3.Error:
        logger.debug("usage read failed for %s", home.name, exc_info=True)
        return empty
    finally:
        conn.close()


def _blank() -> dict[str, Any]:
    return {"cost": 0.0, "input": 0, "output": 0, "cacheRead": 0, "reasoning": 0, "tokens": 0, "calls": 0, "sessions": 0, "unpriced": 0}


def _add(total: dict[str, Any], row: dict[str, Any], *, session: bool) -> None:
    tokens = int(row["input"]) + int(row["output"]) + int(row["cache_read"]) + int(row["cache_write"])
    cost = _cost(row.get("estimated"), row.get("actual"))
    total["cost"] += cost
    total["input"] += int(row["input"])
    total["output"] += int(row["output"])
    total["cacheRead"] += int(row["cache_read"])
    total["reasoning"] += int(row["reasoning"])
    total["tokens"] += tokens
    total["calls"] += int(row["calls"])
    if session:
        total["sessions"] += 1
    if tokens and not cost and str(row.get("cost_status") or "") not in ("included", "free"):
        total["unpriced"] += 1


def summary(period: str = "month", now: Optional[datetime] = None) -> dict[str, Any]:
    """Totals, per bot, per model and per day for `period` (today, 7d, 30d, month), plus today and this month."""
    period = period if period in PERIODS else "month"
    now = now or datetime.now()
    since = _since(period, now)
    month_since = _since("month", now)
    today_since = _since("today", now)
    earliest = min(since, month_since)
    totals, today, month = _blank(), _blank(), _blank()
    bots, models, days = [], {}, {}
    for profile, home in _profiles():
        rows = _read(home, earliest)
        mine = _blank()
        for kind in ("sessions", "aux"):
            for row in rows[kind]:
                started = float(row.get("started_at") or 0)
                is_session = kind == "sessions"
                if started >= month_since:
                    _add(month, row, session=is_session)
                if started >= today_since:
                    _add(today, row, session=is_session)
                if started < since:
                    continue
                _add(totals, row, session=is_session)
                _add(mine, row, session=is_session)
                model = str(row.get("model") or "unknown")
                bucket = models.setdefault(model, {**_blank(), "model": model})
                _add(bucket, row, session=is_session)
                day = date.fromtimestamp(started).isoformat()
                d = days.setdefault(day, {"day": day, "cost": 0.0, "tokens": 0, "byBot": {}})
                cost = _cost(row.get("estimated"), row.get("actual"))
                d["cost"] += cost
                d["tokens"] += int(row["input"]) + int(row["output"]) + int(row["cache_read"]) + int(row["cache_write"])
                d["byBot"][profile] = d["byBot"].get(profile, 0.0) + cost
        bots.append({"id": profile, "name": _title(profile, home), **mine})
    # Every day of the period, including empty ones, so a chart has no gaps.
    start_day = date.fromtimestamp(since)
    span = (now.date() - start_day).days + 1
    daily = [days.get((start_day + timedelta(days=i)).isoformat(), {"day": (start_day + timedelta(days=i)).isoformat(), "cost": 0.0, "tokens": 0, "byBot": {}})
             for i in range(max(span, 1))]
    bots.sort(key=lambda b: (-b["cost"], -b["tokens"]))
    budget = read_budget()
    limit = budget.get("monthly")
    ratio = (month["cost"] / limit) if limit else None
    return {
        "ok": True, "contract": CONTRACT, "period": period, "since": since, "generatedAt": time.time(),
        "totals": totals, "today": today, "month": month,
        "bots": bots, "models": sorted(models.values(), key=lambda m: (-m["cost"], -m["tokens"])), "daily": daily,
        "budget": {"monthly": limit, "spent": month["cost"], "ratio": ratio,
                   "state": "none" if ratio is None else "over" if ratio >= 1 else "warn" if ratio >= WARN_AT else "ok"},
    }


# ---------------------------------------------------------------- budget


def _budget_path() -> Path:
    return data.chief_home() / BUDGET_FILE


def read_budget() -> dict[str, Any]:
    try:
        value = json.loads(_budget_path().read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def set_budget(monthly: Any) -> dict[str, Any]:
    """Set the monthly budget in US dollars (None or 0 clears it)."""
    if monthly in (None, "", 0, "0"):
        amount = None
    else:
        try:
            amount = round(float(monthly), 2)
        except (TypeError, ValueError):
            return {"ok": False, "error": "Enter an amount in dollars, like 20."}
        if not 0 < amount <= 100_000:
            return {"ok": False, "error": "Enter an amount between $0.01 and $100,000."}
    budget = read_budget()
    budget["monthly"] = amount
    path = _budget_path()
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(budget, indent=2), encoding="utf-8")
    tmp.replace(path)
    return {"ok": True, "budget": {"monthly": amount}}


def check_budget(now: Optional[datetime] = None) -> Optional[dict[str, Any]]:
    """Once per month, when spend passes the budget: return what to tell the owner (and remember it)."""
    budget = read_budget()
    limit = budget.get("monthly")
    if not limit:
        return None
    now = now or datetime.now()
    month = now.strftime("%Y-%m")
    if budget.get("alerted") == month:
        return None
    spent = summary("today", now)["month"]["cost"]
    if spent < limit:
        return None
    budget["alerted"] = month
    path = _budget_path()
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(budget, indent=2), encoding="utf-8")
    tmp.replace(path)
    return {"month": month, "spent": spent, "limit": limit}
