"""Token use and cost for the chief and every bot (contract `chief.usage.v1`), and the owner's monthly budget.

Hermes keeps running totals, not a history. Each profile's `state.db` has `session_model_usage` (one row per
session, model, provider and task, added to on every API call with the model that call used; task '' is the
conversation, titles and compression have their own) and `sessions` (lifetime totals under the model the
session started on). A long conversation's row covers its whole life, so no single date fits it: dating it by
its start or its last call puts weeks of use on one day.

So the bridge keeps a journal (`usage_journal.db` in the chief's profile):

- **Marks:** the last totals seen for every row. A sync reads Hermes's rows and adds only what each grew since
  its mark, on the day of the row's latest call. Syncs run when usage is read and every few minutes from the
  watch loop (the budget check), so from the journal's first day the split by day is exact to a few minutes.
- **First sight of a row** (the journal's first sync, or a session that started and ran between two syncs): its
  totals are spread over the days it was active, in proportion to the chief's replies (assistant messages) each
  day. Days before the journal started are therefore estimates, and the summary says from when it is exact.
- **Remainders:** whatever a session's totals hold beyond its ledger rows (sessions from before the ledger,
  counters Hermes set as absolute totals) is journalled the same way under the session's own model.

Usage stays in the journal after Hermes prunes old sessions. A row with tokens and no cost is counted as unpriced,
never as free.

The budget (`usage_budget.json` in the chief's profile) is advisory: the app turns amber at 80 % and sends one
notification when a month passes 100 %. Nothing is ever stopped.
"""
from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from . import data
from .util import subdict

logger = logging.getLogger("chief-dashboard-bridge")

CONTRACT = "chief.usage.v1"
PERIODS = ("today", "7d", "30d", "month")
BUDGET_FILE = "usage_budget.json"
JOURNAL_FILE = "usage_journal.db"
WARN_AT = 0.8
COUNTERS = ("input", "output", "cache_read", "cache_write", "reasoning", "calls")
REST = "~rest"  # the task name for a session's remainder beyond its ledger rows

_lock = threading.Lock()


def _since(period: str, now: datetime | None = None) -> float:
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


def _day(ts: float) -> str:
    return date.fromtimestamp(ts).isoformat()


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
        ui = subdict(meta, "ui_meta")
        bots = subdict(ui, "hermes-bots")
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


def _provider_name(slug: str) -> str:
    """Hermes's display name for a provider ("Z.AI / GLM" for zai), or the slug itself."""
    if not slug:
        return ""
    try:
        from hermes_cli.auth import PROVIDER_REGISTRY

        return str(getattr(PROVIDER_REGISTRY.get(slug), "name", "") or slug)
    except Exception:
        return slug


# ---------------------------------------------------------------- reading Hermes


_COUNTER_SQL = ("COALESCE(input_tokens,0) AS input, COALESCE(output_tokens,0) AS output, "
                "COALESCE(cache_read_tokens,0) AS cache_read, COALESCE(cache_write_tokens,0) AS cache_write, "
                "COALESCE(reasoning_tokens,0) AS reasoning, COALESCE(api_call_count,0) AS calls, "
                "estimated_cost_usd AS estimated, actual_cost_usd AS actual, cost_status")


def _has(conn: sqlite3.Connection, table: str) -> set[str]:
    return {str(r[1]) for r in conn.execute(f"PRAGMA table_info({table})")}


def _rows(home: Path) -> list[dict[str, Any]]:
    """Every running total in one profile's store.

    Each total has `key`, `session`, `model`, `provider`, `task`, the counters, `cost`, `cost_status`, and the
    span it covers (`first`, `last`)."""
    db = home / "state.db"
    if not db.is_file():
        return []
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
        conn.row_factory = sqlite3.Row
    except sqlite3.Error:
        return []
    try:
        scols = _has(conn, "sessions")
        sprov = "COALESCE(billing_provider,'')" if "billing_provider" in scols else "''"
        ends = [c for c in ("last_activity_at", "ended_at") if c in scols]
        slast = f"MAX(started_at, {', '.join(f'COALESCE({c}, started_at)' for c in ends)})" if ends else "started_at"
        sessions = [dict(r) for r in conn.execute(
            f"SELECT id AS session, COALESCE(model,'') AS model, {sprov} AS provider, started_at AS first, "
            f"{slast} AS last, {_COUNTER_SQL} FROM sessions")]
        ledger: list[dict[str, Any]] = []
        lcols = _has(conn, "session_model_usage")
        if {"session_id", "model", "task", "first_seen"} <= lcols:
            lprov = "COALESCE(billing_provider,'')" if "billing_provider" in lcols else "''"
            llast = "COALESCE(last_seen, first_seen)" if "last_seen" in lcols else "first_seen"
            ledger = [dict(r) for r in conn.execute(
                f"SELECT session_id AS session, model, {lprov} AS provider, COALESCE(task,'') AS task, "
                f"first_seen AS first, {llast} AS last, {_COUNTER_SQL} FROM session_model_usage")]

    except sqlite3.Error:
        logger.debug("usage read failed for %s", home.name, exc_info=True)
        return []
    finally:
        conn.close()

    out: list[dict[str, Any]] = []
    covered: dict[str, dict[str, float]] = {}
    for r in ledger:
        out.append({**r, "cost": _cost(r["estimated"], r["actual"])})
        if r["task"] == "":
            got = covered.setdefault(r["session"], {k: 0.0 for k in (*COUNTERS, "cost")})
            for k in COUNTERS:
                got[k] += int(r[k] or 0)
            got["cost"] += _cost(r["estimated"], r["actual"])
    for s in sessions:
        got = covered.get(s["session"], {k: 0.0 for k in (*COUNTERS, "cost")})
        rest = {k: max(0, int(s[k] or 0) - int(got[k])) for k in COUNTERS}
        if any(rest.values()):
            out.append({**s, **rest, "task": REST, "cost": max(0.0, _cost(s["estimated"], s["actual"]) - got["cost"])})
    for r in out:
        r["key"] = "\x1f".join((str(r["session"]), str(r["model"] or ""), str(r["provider"] or ""), str(r["task"])))
        r["first"] = float(r.get("first") or 0) or float(r.get("last") or 0)
        r["last"] = max(float(r.get("last") or 0), r["first"])
    return out


def _replies(home: Path, sessions: list[str]) -> dict[str, dict[str, int]]:
    """The chief's replies (assistant messages) per day, for the sessions whose totals need spreading."""
    out: dict[str, dict[str, int]] = {}
    if not sessions:
        return out
    try:
        conn = sqlite3.connect(f"file:{home / 'state.db'}?mode=ro", uri=True, timeout=5)
    except sqlite3.Error:
        return out
    try:
        if not {"session_id", "role", "timestamp"} <= _has(conn, "messages"):
            return out
        for i in range(0, len(sessions), 500):
            chunk = sessions[i:i + 500]
            for sid, day, n in conn.execute(
                    "SELECT session_id, date(timestamp, 'unixepoch', 'localtime'), COUNT(*) FROM messages "
                    f"WHERE role = 'assistant' AND session_id IN ({','.join('?' * len(chunk))}) GROUP BY 1, 2", chunk):
                out.setdefault(str(sid), {})[str(day)] = int(n)
    except sqlite3.Error:
        logger.debug("usage replies read failed for %s", home.name, exc_info=True)
    finally:
        conn.close()
    return out


# ---------------------------------------------------------------- the journal


def _journal() -> sqlite3.Connection:
    conn = sqlite3.connect(data.chief_home() / JOURNAL_FILE, timeout=10, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.executescript(
        "CREATE TABLE IF NOT EXISTS marks (profile TEXT NOT NULL, key TEXT NOT NULL, input INT, output INT, "
        "cache_read INT, cache_write INT, reasoning INT, calls INT, cost REAL, PRIMARY KEY (profile, key));"
        "CREATE TABLE IF NOT EXISTS usage (day TEXT NOT NULL, profile TEXT NOT NULL, session TEXT NOT NULL, "
        "model TEXT NOT NULL, provider TEXT NOT NULL, task TEXT NOT NULL, input INT DEFAULT 0, output INT DEFAULT 0, "
        "cache_read INT DEFAULT 0, cache_write INT DEFAULT 0, reasoning INT DEFAULT 0, calls INT DEFAULT 0, "
        "cost REAL DEFAULT 0, cost_status TEXT, PRIMARY KEY (day, profile, session, model, provider, task));"
        "CREATE INDEX IF NOT EXISTS usage_day ON usage(day);"
        "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);")
    return conn


def _spread(row: dict[str, Any], replies: dict[str, int]) -> list[tuple[str, float]]:
    """Days a row's totals belong to, with weights: the chief's replies per day within the row's span; with
    none on record, the span's days evenly."""
    first, last = _day(row["first"]), _day(row["last"])
    weighted = [(d, float(n)) for d, n in sorted(replies.items()) if first <= d <= last and n > 0]
    if weighted:
        return weighted
    start = date.fromisoformat(first)
    span = (date.fromisoformat(last) - start).days + 1
    return [((start + timedelta(days=i)).isoformat(), 1.0) for i in range(max(1, min(span, 400)))]


def _split(amounts: dict[str, Any], days: list[tuple[str, float]]) -> list[tuple[str, dict[str, Any]]]:
    """Share counters (whole numbers, nothing lost to rounding) and cost over days by weight."""
    total = sum(w for _, w in days) or 1.0
    out: list[tuple[str, dict[str, Any]]] = []
    left = {k: int(amounts[k]) for k in COUNTERS}
    for i, (day, w) in enumerate(days):
        share: dict[str, Any] = {}
        for k in COUNTERS:
            share[k] = left[k] if i == len(days) - 1 else int(int(amounts[k]) * w / total)
            left[k] -= share[k]
        share["cost"] = float(amounts["cost"]) * w / total
        out.append((day, share))
    return out


def _add(conn: sqlite3.Connection, day: str, profile: str, row: dict[str, Any], amounts: dict[str, Any]) -> None:
    if not any(int(amounts[k]) for k in COUNTERS) and not amounts["cost"]:
        return
    conn.execute(
        "INSERT INTO usage (day, profile, session, model, provider, task, input, output, cache_read, cache_write, "
        "reasoning, calls, cost, cost_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
        "ON CONFLICT(day, profile, session, model, provider, task) DO UPDATE SET "
        "input = input + excluded.input, output = output + excluded.output, cache_read = cache_read + excluded.cache_read, "
        "cache_write = cache_write + excluded.cache_write, reasoning = reasoning + excluded.reasoning, "
        "calls = calls + excluded.calls, cost = cost + excluded.cost, cost_status = COALESCE(excluded.cost_status, cost_status)",
        (day, profile, str(row["session"]), str(row["model"] or "unknown"), str(row["provider"] or ""), str(row["task"]),
         *(int(amounts[k]) for k in COUNTERS), float(amounts["cost"]), row.get("cost_status")))


def sync(now: float | None = None) -> None:
    """Bring the journal up to date with every profile's running totals."""
    now = now or time.time()
    with _lock:
        conn = _journal()
        try:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("INSERT OR IGNORE INTO meta (key, value) VALUES ('exact_since', ?)", (str(now),))
            for profile, home in _profiles():
                rows = _rows(home)
                marks = {r["key"]: dict(r) for r in conn.execute("SELECT * FROM marks WHERE profile = ?", (profile,))}
                replies = _replies(home, sorted({str(r["session"]) for r in rows if r["key"] not in marks}))
                for row in rows:
                    current = {**{k: int(row[k] or 0) for k in COUNTERS}, "cost": float(row["cost"] or 0)}
                    mark = marks.get(row["key"])
                    if mark is None:
                        for day, share in _split(current, _spread(row, replies.get(str(row["session"]), {}))):
                            _add(conn, day, profile, row, share)
                    else:
                        delta: dict[str, float] = {k: max(0, current[k] - int(mark[k] or 0)) for k in COUNTERS}
                        delta["cost"] = max(0.0, current["cost"] - float(mark["cost"] or 0))
                        _add(conn, _day(row["last"] or now), profile, row, delta)
                        if all(current[k] == int(mark[k] or 0) for k in COUNTERS) and current["cost"] == float(mark["cost"] or 0):
                            continue
                    conn.execute(
                        "INSERT INTO marks (profile, key, input, output, cache_read, cache_write, reasoning, calls, cost) "
                        "VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(profile, key) DO UPDATE SET input = excluded.input, "
                        "output = excluded.output, cache_read = excluded.cache_read, cache_write = excluded.cache_write, "
                        "reasoning = excluded.reasoning, calls = excluded.calls, cost = excluded.cost",
                        (profile, row["key"], *(current[k] for k in COUNTERS), current["cost"]))
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK") if conn.in_transaction else None
            raise
        finally:
            conn.close()


# ---------------------------------------------------------------- the summary


def _blank() -> dict[str, Any]:
    return {"cost": 0.0, "input": 0, "output": 0, "cacheRead": 0, "reasoning": 0, "tokens": 0, "calls": 0,
            "sessions": 0, "unpriced": 0, "_ids": set(), "_spend": {}}


def _put(total: dict[str, Any], row: sqlite3.Row) -> None:
    tokens = int(row["input"]) + int(row["output"]) + int(row["cache_read"]) + int(row["cache_write"])
    total["cost"] += float(row["cost"])
    total["input"] += int(row["input"])
    total["output"] += int(row["output"])
    total["cacheRead"] += int(row["cache_read"])
    total["reasoning"] += int(row["reasoning"])
    total["tokens"] += tokens
    total["calls"] += int(row["calls"])
    key = (row["profile"], row["session"])
    if row["task"] in ("", REST):
        total["_ids"].add(key)
    spend = total["_spend"].setdefault(key, [0, 0.0, True])
    spend[0] += tokens
    spend[1] += float(row["cost"])
    spend[2] = spend[2] and str(row["cost_status"] or "") not in ("included", "free")


def _done(total: dict[str, Any]) -> dict[str, Any]:
    ids, spend = total.pop("_ids"), total.pop("_spend")
    total["sessions"] = len(ids)
    # Tokens with no cost on a provider that charges: counted as unpriced, never as free.
    total["unpriced"] = sum(1 for tokens, cost, charged in spend.values() if tokens and not cost and charged)
    return total


_SYNC_EVERY = 15.0
_last_sync = 0.0


def summary(period: str = "month", now: datetime | None = None) -> dict[str, Any]:
    """Totals, per bot, per model and per day for `period` (today, 7d, 30d, month), plus today and this month.

    A sync scans every profile's sessions and ledger, so a read syncs at most every 15 seconds (the Usage page
    and its strip both ask; the watch loop keeps the journal current in between). An explicit `now` (tests,
    the budget check) always syncs."""
    global _last_sync
    period = period if period in PERIODS else "month"
    explicit = now is not None
    now = now or datetime.now()
    if explicit or time.monotonic() - _last_sync >= _SYNC_EVERY:
        try:
            sync()
            _last_sync = time.monotonic()
        except Exception:
            logger.warning("usage journal sync failed", exc_info=True)
    since = _since(period, now)
    since_day, month_day, today_day = _day(since), _day(_since("month", now)), _day(_since("today", now))
    totals, today, month = _blank(), _blank(), _blank()
    mine: dict[str, dict[str, Any]] = {}
    models: dict[tuple[str, str], dict[str, Any]] = {}
    days: dict[str, dict[str, Any]] = {}
    conn = _journal()
    try:
        exact_since = float((conn.execute("SELECT value FROM meta WHERE key = 'exact_since'").fetchone() or ["0"])[0])
        for row in conn.execute("SELECT * FROM usage WHERE day >= ? ORDER BY day", (min(since_day, month_day),)):
            day = row["day"]
            if day >= month_day:
                _put(month, row)
            if day >= today_day:
                _put(today, row)
            if day < since_day:
                continue
            _put(totals, row)
            _put(mine.setdefault(row["profile"], _blank()), row)
            model, provider = str(row["model"] or "unknown"), str(row["provider"] or "")
            _put(models.setdefault((model, provider), {**_blank(), "model": model, "provider": provider,
                                                       "providerName": _provider_name(provider)}), row)
            d = days.setdefault(day, {"day": day, "cost": 0.0, "tokens": 0, "byBot": {}})
            d["cost"] += float(row["cost"])
            d["tokens"] += int(row["input"]) + int(row["output"]) + int(row["cache_read"]) + int(row["cache_write"])
            d["byBot"][row["profile"]] = d["byBot"].get(row["profile"], 0.0) + float(row["cost"])
    finally:
        conn.close()
    bots = [{"id": profile, "name": _title(profile, home), **_done(mine.get(profile) or _blank())} for profile, home in _profiles()]
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
        # Days before this are spread from the chief's replies; from it on, each call is on the day it was made.
        "exactSince": exact_since or None,
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


def check_budget(now: datetime | None = None) -> dict[str, Any] | None:
    """Once per month, when spend passes the budget: return what to tell the owner (and remember it)."""
    budget = read_budget()
    limit = budget.get("monthly")
    if not limit:
        # No budget to check, but this runs every few minutes: keep the journal's days exact.
        try:
            sync()
        except Exception:
            logger.debug("usage journal sync failed", exc_info=True)
        return None
    now = now or datetime.now()
    month = now.strftime("%Y-%m")
    if budget.get("alerted") == month:
        try:
            sync()
        except Exception:
            logger.debug("usage journal sync failed", exc_info=True)
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
