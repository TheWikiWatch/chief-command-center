"""Token use and cost for the chief and every bot (contract `chief.usage.v1`), and the owner's monthly budget.

Read-only on Hermes's own records in each profile's `state.db`. `session_model_usage` is the per-model ledger:
one row per session, model, provider and task, added to on every API call with the model that call really used
(task '' is the conversation itself; titles, compression and background review have their own task). The
`sessions` row holds lifetime totals under the model the session *started* on, so a model switch mid-conversation
(which the dashboard's picker does) would put every later token under the old model if it were read alone. Spend
comes from the ledger; whatever a session's totals hold beyond its ledger rows (sessions from before the ledger,
or counters Hermes set as absolute totals) stays with the session's own model. A ledger row is dated by its last
call, a remainder by the session's start. A session whose provider has no price is counted as unpriced, never as
free.

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


_COUNTERS = ("input", "output", "cache_read", "cache_write", "reasoning", "calls")
_COUNTER_SQL = ("COALESCE(input_tokens,0) AS input, COALESCE(output_tokens,0) AS output, "
                "COALESCE(cache_read_tokens,0) AS cache_read, COALESCE(cache_write_tokens,0) AS cache_write, "
                "COALESCE(reasoning_tokens,0) AS reasoning, COALESCE(api_call_count,0) AS calls, "
                "estimated_cost_usd AS estimated, actual_cost_usd AS actual, cost_status")


def _has(conn: sqlite3.Connection, table: str) -> set[str]:
    return {str(r[1]) for r in conn.execute(f"PRAGMA table_info({table})")}


def _read(home: Path, since: float) -> list[dict[str, Any]]:
    """One profile's spend since `since`: one line per ledger row (session, model, provider, task), plus each
    recent session's remainder beyond its ledger. Every line has `session`, `model`, `provider`, `task`, `when`,
    the counters and the cost fields."""
    db = home / "state.db"
    if not db.is_file():
        return []
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
        conn.row_factory = sqlite3.Row
    except sqlite3.Error:
        return []
    try:
        cols = _has(conn, "sessions")
        sprov = "COALESCE(billing_provider,'')" if "billing_provider" in cols else "''"
        sessions = [dict(r) for r in conn.execute(
            f"SELECT id AS session, COALESCE(model,'') AS model, {sprov} AS provider, started_at AS \"when\", "
            f"{_COUNTER_SQL} FROM sessions WHERE started_at >= ?", (since,))]
        ledger: list[dict[str, Any]] = []
        covered: dict[str, dict[str, float]] = {}
        lcols = _has(conn, "session_model_usage")
        if {"session_id", "model", "task", "first_seen"} <= lcols:
            lprov = "COALESCE(billing_provider,'')" if "billing_provider" in lcols else "''"
            when = "COALESCE(last_seen, first_seen)" if "last_seen" in lcols else "first_seen"
            ledger = [dict(r) for r in conn.execute(
                f"SELECT session_id AS session, model, {lprov} AS provider, COALESCE(task,'') AS task, {when} AS \"when\", "
                f"{_COUNTER_SQL} FROM session_model_usage WHERE {when} >= ?", (since,))]
            # What the ledger already holds for each recent session's conversation, over its whole life.
            ids = [s["session"] for s in sessions]
            for i in range(0, len(ids), 500):
                chunk = ids[i:i + 500]
                for r in conn.execute(
                        f"SELECT session_id AS session, {_COUNTER_SQL} FROM session_model_usage "
                        f"WHERE COALESCE(task,'') = '' AND session_id IN ({','.join('?' * len(chunk))})", chunk):
                    got = covered.setdefault(r["session"], {k: 0.0 for k in (*_COUNTERS, "cost")})
                    for k in _COUNTERS:
                        got[k] += float(r[k] or 0)
                    got["cost"] += _cost(r["estimated"], r["actual"])
    except sqlite3.Error:
        logger.debug("usage read failed for %s", home.name, exc_info=True)
        return []
    finally:
        conn.close()
    lines = list(ledger)
    for s in sessions:
        got = covered.get(s["session"])
        if got is None:
            lines.append({**s, "task": ""})
            continue
        rest = {k: max(0, int(s[k] or 0) - int(got[k])) for k in _COUNTERS}
        if any(rest.values()):
            cost = max(0.0, _cost(s["estimated"], s["actual"]) - got["cost"])
            lines.append({**s, **rest, "task": "", "estimated": cost, "actual": None})
    return lines


def _blank() -> dict[str, Any]:
    return {"cost": 0.0, "input": 0, "output": 0, "cacheRead": 0, "reasoning": 0, "tokens": 0, "calls": 0,
            "sessions": 0, "unpriced": 0, "_ids": set(), "_unpriced": set()}


def _add(total: dict[str, Any], line: dict[str, Any], key: tuple[str, str]) -> None:
    """Add one line; `key` (profile, session) counts each conversation once, and background tasks never."""
    tokens = int(line["input"]) + int(line["output"]) + int(line["cache_read"]) + int(line["cache_write"])
    cost = _cost(line.get("estimated"), line.get("actual"))
    total["cost"] += cost
    total["input"] += int(line["input"])
    total["output"] += int(line["output"])
    total["cacheRead"] += int(line["cache_read"])
    total["reasoning"] += int(line["reasoning"])
    total["tokens"] += tokens
    total["calls"] += int(line["calls"])
    if not line["task"]:
        total["_ids"].add(key)
    if tokens and not cost and str(line.get("cost_status") or "") not in ("included", "free"):
        total["_unpriced"].add(key)


def _done(total: dict[str, Any]) -> dict[str, Any]:
    ids, unpriced = total.pop("_ids"), total.pop("_unpriced")
    total["sessions"], total["unpriced"] = len(ids), len(unpriced)
    return total


def _provider_name(slug: str) -> str:
    """Hermes's display name for a provider ("Z.ai" for zai), or the slug itself."""
    if not slug:
        return ""
    try:
        from hermes_cli.auth import PROVIDER_REGISTRY

        return str(getattr(PROVIDER_REGISTRY.get(slug), "name", "") or slug)
    except Exception:
        return slug


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
        mine = _blank()
        for line in _read(home, earliest):
            when = float(line.get("when") or 0)
            key = (profile, str(line["session"]))
            if when >= month_since:
                _add(month, line, key)
            if when >= today_since:
                _add(today, line, key)
            if when < since:
                continue
            _add(totals, line, key)
            _add(mine, line, key)
            model, provider = str(line.get("model") or "unknown"), str(line.get("provider") or "")
            bucket = models.setdefault((model, provider), {**_blank(), "model": model, "provider": provider,
                                                           "providerName": _provider_name(provider)})
            _add(bucket, line, key)
            day = date.fromtimestamp(when).isoformat()
            d = days.setdefault(day, {"day": day, "cost": 0.0, "tokens": 0, "byBot": {}})
            cost = _cost(line.get("estimated"), line.get("actual"))
            d["cost"] += cost
            d["tokens"] += int(line["input"]) + int(line["output"]) + int(line["cache_read"]) + int(line["cache_write"])
            d["byBot"][profile] = d["byBot"].get(profile, 0.0) + cost
        bots.append({"id": profile, "name": _title(profile, home), **_done(mine)})
    for total in (totals, today, month, *models.values()):
        _done(total)
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
