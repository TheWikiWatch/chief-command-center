#!/usr/bin/env python3
"""learning_ledger - oversight for the team's self-editing skills (Fleet Health).

Hermes' background review patches skills automatically after conversations, with no record of whether
they helped. This tool keeps that record without touching how Hermes works:

  snapshot   record every skill file whose content changed since the last run (read-only on skills); a file
             new to us whose exact content is already recorded for another file was copied in (a new bot gets
             the bundled skill library) and is stored as 'copied', never counted as an edit; a file holding
             exactly what the app recorded writing there (.chief-bundled.json, .chief-generated.json), or
             changed only in the app's versioned install folder, is the app's own write: 'installed', not counted
  report     write report.json / report.md: desk scorecards, skills grouped with churn, size and
             episodes judged before/after, flags for the owner, runtime health, proposals with the
             owner's decisions (decisions.json, written by the dashboard)
  run        snapshot + report (what the 30-minute cron runs; silent on success)
  diff ID [--from M]
             unified diff of change ID against the version before it, or the net change from the
             version before M to ID (same file)
  revert ID [--discard-newer N]
             put back the version before change ID (the current file is backed up first). When the
             file was edited again after ID, the revert would undo those N edits too, so it refuses
             unless N matches the current count of later edits.

Where: the Hermes root is CHIEF_HERMES_ROOT, else the root above HERMES_HOME (a profile home), else the
root above this file when it runs from a profile's scripts/ folder (the app's 30-minute cron job). The
data folder is CHIEF_LEARNING_DIR, else <root>/learning: ledger.db (SQLite), report.json, report.md,
proposals.json (the weekly distill) and decisions.json (the owner's Approve / Dismiss, from the dashboard).
Standard library only. Ported from the owner's original fleet tooling; bundled with the app.
"""

from __future__ import annotations

import calendar
import difflib
import hashlib
import json
import os
import re
import sqlite3
import statistics
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path


def _hermes_root() -> Path:
    explicit = os.environ.get("CHIEF_HERMES_ROOT", "").strip()
    if explicit:
        return Path(explicit)
    home = os.environ.get("HERMES_HOME", "").strip()
    if home:
        p = Path(home)
        return p.parent.parent if p.parent.name == "profiles" else p
    here = Path(__file__).resolve()
    if here.parent.name == "scripts" and here.parent.parent.parent.name == "profiles":
        return here.parent.parent.parent.parent
    return Path(os.environ.get("LOCALAPPDATA", "")) / "hermes"


HERMES = _hermes_root()
OUT = Path(os.environ.get("CHIEF_LEARNING_DIR", "").strip() or HERMES / "learning")
DB = OUT / "ledger.db"
KANBAN = HERMES / "kanban.db"
SKIP_PARTS = {".archive", ".curator_backups", "__pycache__", ".git", "node_modules"}
DAY = 86400.0
IMPACT_WINDOW = 14 * DAY
MIN_EVENTS = 3

# --------------------------------------------------------------------------- skills


def skill_roots() -> list[tuple[str, Path]]:
    roots = [("shared", HERMES / "skills")]
    profiles = HERMES / "profiles"
    if profiles.is_dir():
        for p in sorted(profiles.iterdir()):
            if (p / "skills").is_dir():
                roots.append((p.name, p / "skills"))
    return roots


def skill_files() -> list[tuple[str, str, Path]]:
    """(scope, skill name relative to its root, file) for every SKILL.md and references/*.md."""
    out = []
    for scope, root in skill_roots():
        for f in root.rglob("*.md"):
            rel = f.relative_to(root)
            if any(part in SKIP_PARTS or ".bak" in part for part in rel.parts):
                continue
            if f.name != "SKILL.md" and "references" not in rel.parts:
                continue
            skill_dir = rel.parent if f.name == "SKILL.md" else Path(*rel.parts[: rel.parts.index("references")])
            out.append((scope, skill_dir.as_posix(), f))
    return out


def connect() -> sqlite3.Connection:
    OUT.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS versions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scope TEXT NOT NULL, skill TEXT NOT NULL, file TEXT NOT NULL,
          sha TEXT, size INTEGER, mtime REAL, seen_at REAL NOT NULL,
          content TEXT, change TEXT NOT NULL, source TEXT
        );
        CREATE INDEX IF NOT EXISTS versions_file ON versions(file, id);
        CREATE INDEX IF NOT EXISTS versions_sha ON versions(sha);
        """
    )
    cols = {r[1] for r in conn.execute("PRAGMA table_info(versions)")}
    for col in ("added", "removed"):
        if col not in cols:
            conn.execute(f"ALTER TABLE versions ADD COLUMN {col} INTEGER")
    return conn


def latest(conn: sqlite3.Connection, file: str):
    return conn.execute("SELECT * FROM versions WHERE file = ? ORDER BY id DESC LIMIT 1", (file,)).fetchone()


_REVIEW_RE = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+ INFO \[([^\]]+)\] agent\.background_review: Background review complete:.*result=([a-z,]+)")


def review_events() -> list[tuple[float, str, str]]:
    """(time, profile, session) of background reviews that changed a skill, from each profile's agent.log."""
    events = []
    for p in (HERMES / "profiles").iterdir() if (HERMES / "profiles").is_dir() else []:
        for log in sorted((p / "logs").glob("agent.log*")):
            try:
                with open(log, encoding="utf-8", errors="replace") as fh:
                    for line in fh:
                        if "background_review" not in line:
                            continue
                        m = _REVIEW_RE.match(line)
                        if m and "skill" in m.group(3):
                            t = time.mktime(time.strptime(m.group(1), "%Y-%m-%d %H:%M:%S"))
                            events.append((t, p.name, m.group(2)))
            except OSError:
                continue
    return events


def attribute(scope: str, mtime: float, events: list[tuple[float, str, str]]) -> str:
    """Best guess at what changed a file: a background review that finished within a few minutes."""
    near = [e for e in events if -300 <= e[0] - mtime <= 600 and (scope == "shared" or e[1] == scope)]
    if near:
        t, prof, session = min(near, key=lambda e: abs(e[0] - mtime))
        return f"background review ({prof}, {session})"
    return "edited outside background review"


def snapshot() -> int:
    conn = connect()
    try:
        return _snapshot(conn)
    finally:
        conn.close()


def _snapshot(conn: sqlite3.Connection) -> int:
    first_run = conn.execute("SELECT COUNT(*) FROM versions").fetchone()[0] == 0
    events = None
    apps = None
    seen = set()
    changes = 0
    now = time.time()
    with conn:
        for scope, skill, f in skill_files():
            key = str(f)
            seen.add(key)
            try:
                data = f.read_bytes()
                st = f.stat()
            except OSError:
                continue
            sha = hashlib.sha256(data).hexdigest()
            prev = latest(conn, key)
            if prev and prev["sha"] == sha:
                continue
            if apps is None:
                apps = app_records()
            text = data.decode("utf-8", "replace")
            if first_run:
                kind, source = "baseline", "first snapshot"
            elif sha in apps.get(key, ()):
                # Exactly what the app says it wrote there (an update's skills, its Second Brain skills): the app's
                # own write, not an edit. Counting these cried wolf after every update.
                kind, source = "installed", APP_SOURCE
            elif prev is not None and prev["change"] not in ("removed", "dropped") and only_install_folder_changed(prev["content"], text):
                kind, source = "installed", MOVED_SOURCE
            elif (prev is None or prev["change"] in ("removed", "dropped")) and known_content(conn, sha, key):
                # New to us, but the same bytes are already recorded for another file: a copy, not authorship.
                # Minting a bot replicates the whole bundled skill library (one row per file), and counting
                # those as edits invented churn that never happened.
                kind, source = "copied", COPIED_SOURCE
            else:
                kind = "changed" if prev and prev["change"] not in ("removed", "dropped") else "added"
                if events is None:
                    events = review_events()
                source = attribute(scope, st.st_mtime, events)
                changes += 1
            conn.execute(
                "INSERT INTO versions (scope, skill, file, sha, size, mtime, seen_at, content, change, source) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (scope, skill, key, sha, len(data), st.st_mtime, now, text, kind, source),
            )
        for row in conn.execute("SELECT file, scope, skill, change FROM versions v WHERE id = (SELECT MAX(id) FROM versions WHERE file = v.file)").fetchall():
            if row["file"] not in seen and row["change"] not in ("removed", "dropped"):
                # An untouched copy going away (a retired bot's bundled skills) is no more an edit than its arrival.
                copy = row["change"] == "copied"
                conn.execute(
                    "INSERT INTO versions (scope, skill, file, sha, size, mtime, seen_at, content, change, source) VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (
                        row["scope"],
                        row["skill"],
                        row["file"],
                        None,
                        0,
                        now,
                        now,
                        None,
                        "dropped" if copy else "removed",
                        "an unedited copy went away (a retired bot, or a skill removed)" if copy else "file gone (archived by the curator or deleted)",
                    ),
                )
                if not copy:
                    changes += 1
        reclassify_copies(conn)
        reclassify_app_writes(conn, apps if apps is not None else app_records())
    return changes


COPIED_SOURCE = "copied in (the same content is already recorded for another file)"


def known_content(conn: sqlite3.Connection, sha: str, file: str) -> bool:
    return conn.execute("SELECT 1 FROM versions WHERE sha = ? AND file != ? LIMIT 1", (sha, file)).fetchone() is not None


def reclassify_copies(conn: sqlite3.Connection) -> int:
    """Rows recorded as 'added' before copies were recognised, whose content was already recorded for another
    file: relabel them 'copied' so their churn flags clear. Idempotent; returns how many were relabelled."""
    cur = conn.execute(
        "UPDATE versions SET change = 'copied', source = ? WHERE change = 'added' AND sha IS NOT NULL AND EXISTS "
        "(SELECT 1 FROM versions o WHERE o.sha = versions.sha AND o.file != versions.file AND o.id < versions.id)",
        (COPIED_SOURCE + "; relabelled",),
    )
    return cur.rowcount or 0


APP_SOURCE = "installed by the app (an update, or its Second Brain skills)"
MOVED_SOURCE = "the app moved to a new version's folder; nothing else changed"
# The records the app keeps beside the skills it writes: {path under the record's folder: sha256 of what it wrote}.
# .chief-bundled.json: its bundled skills and the Second Brain toolkit (provision.py); .chief-generated.json: the
# skills it renders for the Second Brain (second_brain.py).
APP_RECORDS = (".chief-bundled.json", ".chief-generated.json")
# An installed app's folder is named for its version (ChiefCommandCenter_0.1.24.0_x64__<publisher>), and older
# toolkit skills named that folder, so every update rewrote them.
_INSTALL_FOLDER = re.compile(r"ChiefCommandCenter_\d+(?:\.\d+){3}_[A-Za-z0-9]+__[A-Za-z0-9]+")


def app_records() -> dict[str, set[str]]:
    """file -> the contents (sha256) the app says it wrote there, from its records in every skills folder."""
    out: dict[str, set[str]] = {}
    for _scope, root in skill_roots():
        for name in APP_RECORDS:
            for record in root.rglob(name):
                if any(part in SKIP_PARTS for part in record.relative_to(root).parts):
                    continue
                try:
                    data = json.loads(record.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    continue
                for rel, digest in data.items() if isinstance(data, dict) else []:
                    if isinstance(digest, str):
                        out.setdefault(str(record.parent / rel), set()).add(digest)
    return out


def only_install_folder_changed(old: str | None, new: str) -> bool:
    return old is not None and old != new and _INSTALL_FOLDER.sub("", old) == _INSTALL_FOLDER.sub("", new)


def reclassify_app_writes(conn: sqlite3.Connection, apps: dict[str, set[str]]) -> int:
    """Rows recorded as edits before the app's own writes were recognised: a file now holding exactly what the app
    wrote there, or a change that only moved the install folder. Relabelled 'installed' so their churn flags clear.
    Idempotent; returns how many were relabelled."""
    count = 0
    for file, digests in apps.items():
        marks = ",".join("?" * len(digests))
        cur = conn.execute(
            f"UPDATE versions SET change = 'installed', source = ? WHERE file = ? AND change IN ('added','changed') AND sha IN ({marks})",
            (APP_SOURCE + "; relabelled", file, *sorted(digests)),
        )
        count += cur.rowcount or 0
    for row in conn.execute("SELECT * FROM versions WHERE change = 'changed' AND content LIKE '%ChiefCommandCenter\\_%' ESCAPE '\\'").fetchall():
        before = previous_version(conn, row)
        if before is not None and only_install_folder_changed(before["content"], row["content"]):
            conn.execute("UPDATE versions SET change = 'installed', source = ? WHERE id = ?", (MOVED_SOURCE + "; relabelled", row["id"]))
            count += 1
    return count


def previous_version(conn: sqlite3.Connection, row) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM versions WHERE file = ? AND id < ? ORDER BY id DESC LIMIT 1", (row["file"], row["id"])).fetchone()


def diff_text(conn: sqlite3.Connection, row, limit: int | None = None, since=None) -> str:
    before = previous_version(conn, since if since is not None else row)
    a = (before["content"] or "") if before else ""
    b = row["content"] or ""
    lines = list(difflib.unified_diff(a.splitlines(), b.splitlines(), "before", "after", lineterm="", n=2))
    text = "\n".join(lines)
    return text if limit is None or len(text) <= limit else text[:limit] + "\n…"


def later_versions(conn: sqlite3.Connection, row) -> int:
    """Versions of the same file recorded after `row` (edits, removals and reverts)."""
    return conn.execute("SELECT COUNT(*) FROM versions WHERE file = ? AND id > ?", (row["file"], row["id"])).fetchone()[0]


def revert(version_id: int, discard_newer: int = 0) -> str:
    conn = connect()
    try:
        # Record an edit made since the last run first, so it counts as a later edit and is never lost unseen.
        _snapshot(conn)
        return _revert(conn, version_id, discard_newer)
    finally:
        conn.close()


def _revert(conn: sqlite3.Connection, version_id: int, discard_newer: int = 0) -> str:
    row = conn.execute("SELECT * FROM versions WHERE id = ?", (version_id,)).fetchone()
    if not row:
        raise SystemExit(f"no change #{version_id}")
    before = previous_version(conn, row)
    if not before or before["content"] is None:
        raise SystemExit(f"change #{version_id} has no earlier version to go back to")
    newer = later_versions(conn, row)
    # Going back to the version before an older change also throws away every edit after it.
    # Only when the caller saw exactly that many (the dashboard shows the count before the hold).
    if newer and newer != discard_newer:
        edits = "edit" if newer == 1 else "edits"
        raise SystemExit(
            f"change #{version_id} has {newer} later {edits} to this file; reverting it would undo them too (pass --discard-newer {newer} to go ahead)"
        )
    target = Path(row["file"])
    stamp = time.strftime("%Y%m%d-%H%M%S")
    if target.exists():
        backup = target.with_name(f"{target.name}.bak-ledger-{stamp}")
        backup.write_bytes(target.read_bytes())
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(before["content"], encoding="utf-8", newline="")
    data = target.read_bytes()
    with conn:
        conn.execute(
            "INSERT INTO versions (scope, skill, file, sha, size, mtime, seen_at, content, change, source) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                row["scope"],
                row["skill"],
                row["file"],
                hashlib.sha256(data).hexdigest(),
                len(data),
                target.stat().st_mtime,
                time.time(),
                before["content"],
                "reverted",
                f"revert of #{version_id}",
            ),
        )
    return f"reverted #{version_id}: {row['scope']}/{row['skill']} is back to the version from {time.strftime('%Y-%m-%d %H:%M', time.localtime(before['seen_at']))}"


# --------------------------------------------------------------------------- desks


def desks() -> list[str]:
    p = HERMES / "profiles"
    return sorted(d.name for d in p.iterdir() if (d / "config.yaml").exists()) if p.is_dir() else []


def memory_fill(profile: str) -> dict:
    home = HERMES / "profiles" / profile
    limits = {"memory": 2200, "user": 1375}
    try:
        cfg = (home / "config.yaml").read_text(encoding="utf-8", errors="replace")
        m = re.search(r"^\s+memory_char_limit:\s*(\d+)", cfg, re.M)
        u = re.search(r"^\s+user_char_limit:\s*(\d+)", cfg, re.M)
        if m:
            limits["memory"] = int(m.group(1))
        if u:
            limits["user"] = int(u.group(1))
    except OSError:
        pass

    def chars(name: str) -> int:
        try:
            return len((home / "memories" / name).read_text(encoding="utf-8", errors="replace"))
        except OSError:
            return 0

    return {"memory": chars("MEMORY.md"), "memoryLimit": limits["memory"], "user": chars("USER.md"), "userLimit": limits["user"]}


def kanban_events(conn: sqlite3.Connection, since: float) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT e.kind, e.created_at, t.assignee, t.id AS task, t.started_at, t.completed_at "
        "FROM task_events e JOIN tasks t ON t.id = e.task_id "
        "WHERE e.kind IN ('completed','crashed','gave_up','spawned') AND e.created_at > ?",
        (since,),
    ).fetchall()


def window_stats(rows: list[sqlite3.Row]) -> dict:
    done = [r for r in rows if r["kind"] == "completed"]
    crashed = sum(1 for r in rows if r["kind"] == "crashed")
    gave_up = sum(1 for r in rows if r["kind"] == "gave_up")
    spawned = sum(1 for r in rows if r["kind"] == "spawned")
    minutes = [(float(r["completed_at"]) - float(r["started_at"])) / 60 for r in done if r["completed_at"] and r["started_at"]]
    attempts = len(done) + crashed + gave_up
    return {
        "done": len(done),
        "crashed": crashed,
        "gaveUp": gave_up,
        "spawned": spawned,
        "medianMinutes": round(statistics.median(minutes), 1) if minutes else None,
        "success": round(len(done) / attempts, 3) if attempts else None,
    }


def scorecards(kconn: sqlite3.Connection | None, now: float) -> list[dict]:
    cards = []
    events = kanban_events(kconn, now - 42 * DAY) if kconn else []
    for desk in desks():
        mine = [r for r in events if r["assignee"] == desk]
        weeks = []
        for w in range(6, 0, -1):
            lo, hi = now - w * 7 * DAY, now - (w - 1) * 7 * DAY
            weeks.append(sum(1 for r in mine if r["kind"] == "completed" and lo <= r["created_at"] < hi))
        last7 = window_stats([r for r in mine if r["created_at"] >= now - 7 * DAY])
        last30 = [r for r in mine if r["created_at"] >= now - 30 * DAY]
        blocked = 0
        if kconn:
            blocked = kconn.execute("SELECT COUNT(*) FROM tasks WHERE assignee = ? AND status = 'blocked'", (desk,)).fetchone()[0]
        cards.append(
            {
                "desk": desk,
                "weeks": weeks,
                "last7": last7,
                "cards30": sum(1 for r in last30 if r["kind"] == "completed"),
                "blocked": blocked,
                "memory": memory_fill(desk),
            }
        )
    return cards


def recent_changes(conn: sqlite3.Connection, now: float, limit: int = 40) -> list[dict]:
    """The latest changes across all skills, without diffs (`diff ID` / the dashboard fetch them)."""
    rows = conn.execute("SELECT * FROM versions WHERE change IN ('added','changed','removed','reverted') ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    out = []
    for r in rows:
        added, removed = line_counts(conn, r)
        before = previous_version(conn, r)
        out.append(
            {
                "id": r["id"],
                "scope": r["scope"],
                "skill": r["skill"],
                "file": Path(r["file"]).name,
                "change": r["change"],
                "at": r["mtime"] or r["seen_at"],
                "source": r["source"],
                "added": added,
                "removed": removed,
                "canRevert": bool(before and before["content"] is not None and r["change"] != "reverted"),
                "newer": later_versions(conn, r),
            }
        )
    return out


# --------------------------------------------------------------------------- oversight (PLAN-2026-09-29)

# Flag thresholds, in one place so they are easy to tune.
CHURN_48H = 5  # edits to one skill in 48 hours
CHURN_7D = 10  # ... or in 7 days
BLOAT_BYTES = 32_000  # a SKILL.md this large costs every prompt that loads it
GROWTH_RATIO = 1.5  # a skill 50% larger than 14 days ago
GROWTH_MIN_BYTES = 8_000
MEMORY_FULL = 0.95  # a desk's MEMORY.md / USER.md this full
PROPOSAL_STALE_DAYS = 3
EPISODE_GAP = 2 * DAY  # edits closer than this are one episode
EDIT_KINDS = ("added", "changed", "removed")
SKILL_CHANGES_SHOWN = 25
SKILL_EPISODES_SHOWN = 6


def _week(t: float) -> str:
    return time.strftime("%G-W%V", time.localtime(t))


def line_counts(conn: sqlite3.Connection, row) -> tuple[int, int]:
    """Lines added / removed by one version, computed once and stored (difflib on 50 KB files is slow)."""
    if row["added"] is not None and row["removed"] is not None:
        return int(row["added"]), int(row["removed"])
    diff = diff_text(conn, row).splitlines()
    added = sum(1 for line in diff if line.startswith("+") and not line.startswith("+++"))
    removed = sum(1 for line in diff if line.startswith("-") and not line.startswith("---"))
    with conn:
        conn.execute("UPDATE versions SET added = ?, removed = ? WHERE id = ?", (added, removed, row["id"]))
    return added, removed


def quality_stats(rows: list) -> dict:
    """Like window_stats, plus quality = done / (done + gave up): crashes are mostly the machine, not the skill."""
    s = window_stats(rows)
    judged = s["done"] + s["gaveUp"]
    s["quality"] = round(s["done"] / judged, 3) if judged else None
    attempts = judged + s["crashed"]
    s["crashRate"] = round(s["crashed"] / attempts, 3) if attempts else None
    return s


def episode_verdict(events: list, desks_for: list[str], start: float, end: float, now: float) -> dict:
    """Before/after verdict for one episode: 14 days before its first edit vs 14 days after its last."""
    judge_at = end + IMPACT_WINDOW
    if now < judge_at:
        days = int((judge_at - now) / DAY) + 1
        return {"label": "too early", "why": f"judged in {days}d (14 days after the last edit)", "judgeAt": judge_at}
    mine = [r for r in events if not desks_for or r["assignee"] in desks_for]
    before = quality_stats([r for r in mine if start - IMPACT_WINDOW <= r["created_at"] < start])
    after = quality_stats([r for r in mine if end <= r["created_at"] < end + IMPACT_WINDOW])
    n_b, n_a = before["done"] + before["gaveUp"], after["done"] + after["gaveUp"]
    base = {"judgeAt": judge_at, "before": before, "after": after}
    if n_b < MIN_EVENTS or n_a < MIN_EVENTS:
        return {"label": "too little work", "why": f"{n_b} finished or abandoned cards before, {n_a} after", **base}
    cb, ca = before["crashRate"] or 0, after["crashRate"] or 0
    crashes = before["crashed"] + after["crashed"]
    why = f"quality {round((before['quality'] or 0) * 100)}% → {round((after['quality'] or 0) * 100)}%"
    mb, ma = before["medianMinutes"], after["medianMinutes"]
    if mb and ma:
        why += f", median {mb:g}m → {ma:g}m"
    # A crash spike on either side swamps anything the skill did.
    if crashes >= 3 and max(cb, ca) >= 0.25 and max(cb, ca) >= 2 * max(min(cb, ca), 0.05):
        return {"label": "confounded", "why": f"{why}; crashes {round(cb * 100)}% → {round(ca * 100)}% of attempts swamp the signal", **base}
    dq = (after["quality"] or 0) - (before["quality"] or 0)
    slower = mb and ma and ma > mb * 1.3
    faster = mb and ma and ma < mb * 0.8
    if dq <= -0.10 or (slower and dq <= 0):
        label = "worse"
    elif dq >= 0.10 or (faster and dq >= 0):
        label = "helped"
    else:
        label = "no clear change"
    return {"label": label, "why": why, **base}


def _episodes(rows: list) -> list[list]:
    """Group a skill's edits into episodes (oldest first): runs with gaps shorter than EPISODE_GAP."""
    out: list[list] = []
    for r in sorted(rows, key=lambda r: r["mtime"] or r["seen_at"]):
        t = r["mtime"] or r["seen_at"]
        if out and t - (out[-1][-1]["mtime"] or out[-1][-1]["seen_at"]) <= EPISODE_GAP:
            out[-1].append(r)
        else:
            out.append([r])
    return out


def _sources(edits: list) -> dict[str, int]:
    review = sum(1 for r in edits if str(r["source"] or "").startswith("background review"))
    return {"review": review, "outside": len(edits) - review}


def _who(sources: dict[str, int]) -> str:
    """Who made a skill's recent edits, for the churn flag: the fix differs (a skill the background review keeps
    rewriting wants consolidating; edits outside it are someone's work in progress)."""
    review, outside = sources.get("review", 0), sources.get("outside", 0)
    if review and not outside:
        return "all by the background review after conversations"
    if outside and not review:
        return "none by the background review (edited by hand, by the chief, or by another tool)"
    return f"{review} by the background review after conversations, {outside} outside it"


def skills_summary(conn: sqlite3.Connection, kconn: sqlite3.Connection | None, now: float) -> list[dict]:
    """Every skill edited in the last 30 days: churn, size trend, episodes with verdicts, recent changes."""
    since = now - 30 * DAY
    rows = conn.execute("SELECT * FROM versions WHERE change IN ('added','changed','removed','reverted') AND seen_at >= ? ORDER BY id ASC", (since,)).fetchall()
    events = kanban_events(kconn, since - 2 * IMPACT_WINDOW) if kconn else []
    all_desks = desks()
    by_skill: dict[tuple[str, str], list] = {}
    for r in rows:
        by_skill.setdefault((r["scope"], r["skill"]), []).append(r)
    out = []
    for (scope, skill), items in by_skill.items():
        edits = [r for r in items if r["change"] in EDIT_KINDS]
        files = sorted({r["file"] for r in items})
        size_now = size_then = 0
        known_then = True
        for f in files:
            cur = latest(conn, f)
            size_now += int(cur["size"] or 0) if cur and cur["change"] != "removed" else 0
            old = conn.execute("SELECT size, change FROM versions WHERE file = ? AND seen_at <= ? ORDER BY id DESC LIMIT 1", (f, now - 14 * DAY)).fetchone()
            if old is None:
                known_then = False
            else:
                size_then += int(old["size"] or 0) if old["change"] != "removed" else 0
        desks_for = [scope] if scope in all_desks else []
        episodes = []
        for group in reversed(_episodes(edits)):
            start, end = group[0]["mtime"] or group[0]["seen_at"], group[-1]["mtime"] or group[-1]["seen_at"]
            episodes.append(
                {
                    "id": f"ep{group[0]['id']}",
                    "start": start,
                    "end": end,
                    "edits": len(group),
                    "firstId": group[0]["id"],
                    "lastId": group[-1]["id"],
                    "verdict": episode_verdict(events, desks_for, start, end, now),
                }
            )
        episode_of = {r["id"]: f"ep{g[0]['id']}" for g in _episodes(edits) for r in g}
        changes = []
        for r in reversed(items[-SKILL_CHANGES_SHOWN:]):
            added, removed = line_counts(conn, r)
            before = previous_version(conn, r)
            changes.append(
                {
                    "id": r["id"],
                    "file": Path(r["file"]).name,
                    "change": r["change"],
                    "at": r["mtime"] or r["seen_at"],
                    "source": r["source"],
                    "added": added,
                    "removed": removed,
                    "canRevert": bool(before and before["content"] is not None and r["change"] != "reverted"),
                    "newer": later_versions(conn, r),
                    "episode": episode_of.get(r["id"]),
                }
            )
        seen = [r["seen_at"] for r in edits]
        out.append(
            {
                "key": f"{scope}/{skill}",
                "scope": scope,
                "skill": skill,
                "name": skill.split("/")[-1],
                "files": len(files),
                "edits48h": sum(1 for t in seen if t >= now - 2 * DAY),
                "edits7d": sum(1 for t in seen if t >= now - 7 * DAY),
                "edits30d": len(seen),
                "size": size_now,
                "size14d": size_then if known_then else None,
                "skillMdSize": max((int((latest(conn, f) or {"size": 0})["size"] or 0) for f in files if f.endswith("SKILL.md")), default=0),
                "lastAt": max((r["mtime"] or r["seen_at"]) for r in items),
                "sources": _sources(edits),
                "sources7d": _sources([r for r in edits if r["seen_at"] >= now - 7 * DAY]),
                "episodes": episodes[:SKILL_EPISODES_SHOWN],
                "changes": changes,
            }
        )
    out.sort(key=lambda s: (-s["edits7d"], -s["lastAt"]))
    return out


def decisions() -> dict[str, dict]:
    """The owner's proposal decisions, written by the dashboard (/api/fleet/decide): {id: {decision, at}}."""
    try:
        data = json.loads((OUT / "decisions.json").read_text(encoding="utf-8"))
        items = data.get("items") if isinstance(data, dict) else None
        return {str(k): v for k, v in (items or {}).items() if isinstance(v, dict) and v.get("decision") in ("approve", "dismiss")}
    except (OSError, ValueError):
        return {}


def proposal_date(p: dict) -> float | None:
    m = re.match(r"(\d{8})", str(p.get("id") or ""))
    if not m:
        return None
    try:
        return time.mktime(time.strptime(m.group(1), "%Y%m%d"))
    except ValueError:
        return None


def decided_proposals(conn: sqlite3.Connection, now: float) -> list[dict]:
    """Proposals with the owner's decision; an approved one is 'applied' once a skill it names changes afterwards."""
    made = decisions()
    names = {r["skill"].split("/")[-1]: r["skill"] for r in conn.execute("SELECT DISTINCT skill FROM versions")}
    out = []
    for p in proposals():
        d = made.get(str(p["id"]))
        item = dict(p)
        if d:
            item["decision"] = d["decision"]
            item["decidedAt"] = d.get("at")
            if d["decision"] == "approve":
                target = str(p.get("target") or "")
                named = [full for short, full in names.items() if short and re.search(rf"(?<![\w-]){re.escape(short)}(?![\w-])", target)]
                applied = None
                if named:
                    marks = ",".join("?" * len(named))
                    applied = conn.execute(
                        f"SELECT MIN(seen_at) FROM versions WHERE skill IN ({marks}) AND change IN ('added','changed','removed') AND seen_at > ?",
                        (*named, float(d.get("at") or 0)),
                    ).fetchone()[0]
                item["status"] = "applied" if applied else ("waiting on the chief" if named else "sent to the chief")
                if applied:
                    item["appliedAt"] = applied
            else:
                item["status"] = "dismissed"
        else:
            item["status"] = "open"
        item["date"] = proposal_date(p)
        out.append(item)
    return out


def flags(skills: list[dict], desk_cards: list[dict], props: list[dict], now: float) -> list[dict]:
    """What needs the owner's eyes. Ids are stable so the bridge pushes each one once."""
    week = _week(now)
    out = []
    for s in skills:
        label = f"{s['name']} ({'shared' if s['scope'] == 'shared' else s['scope']})"
        if s["edits48h"] >= CHURN_48H or s["edits7d"] >= CHURN_7D:
            out.append(
                {
                    "id": f"churn:{s['key']}:{week}",
                    "kind": "churn",
                    "severity": "warn",
                    "skill": s["key"],
                    "title": f"{label} keeps being rewritten",
                    "detail": f"{s['edits7d']} edits in 7 days ({s['edits48h']} in the last 48 hours), {_who(s['sources7d'])}. Rewrites this often usually mean the skill is fighting itself.",
                }
            )
        if s["skillMdSize"] >= BLOAT_BYTES:
            out.append(
                {
                    "id": f"bloat:{s['key']}:{s['skillMdSize'] // 16_000}",
                    "kind": "bloat",
                    "severity": "warn",
                    "skill": s["key"],
                    "title": f"{label} SKILL.md is {round(s['skillMdSize'] / 1000)} KB",
                    "detail": "Every prompt that loads it pays for it. Move history and case notes into references/.",
                }
            )
        elif s["size14d"] and s["size"] >= GROWTH_MIN_BYTES and s["size"] >= s["size14d"] * GROWTH_RATIO:
            out.append(
                {
                    "id": f"growth:{s['key']}:{week}",
                    "kind": "bloat",
                    "severity": "warn",
                    "skill": s["key"],
                    "title": f"{label} grew {round((s['size'] / s['size14d'] - 1) * 100)}% in 14 days",
                    "detail": f"{round(s['size14d'] / 1000)} KB → {round(s['size'] / 1000)} KB.",
                }
            )
        for ep in s["episodes"]:
            if ep["verdict"]["label"] == "worse":
                out.append(
                    {
                        "id": f"worse:{s['key']}:{ep['id']}",
                        "kind": "worse",
                        "severity": "danger",
                        "skill": s["key"],
                        "title": f"{label} got worse after {ep['edits']} {'edit' if ep['edits'] == 1 else 'edits'}",
                        "detail": ep["verdict"].get("why") or "",
                    }
                )
    for d in desk_cards:
        m = d["memory"]
        for which, used, limit in (("memory", m["memory"], m["memoryLimit"]), ("user", m["user"], m["userLimit"])):
            if limit and used / limit >= MEMORY_FULL:
                out.append(
                    {
                        "id": f"memory:{d['desk']}:{which}:{week}",
                        "kind": "memory",
                        "severity": "warn",
                        "desk": d["desk"],
                        "title": f"{d['desk']}'s {'memory' if which == 'memory' else 'user profile'} is {round(used / limit * 100)}% full",
                        "detail": f"{used} of {limit} characters. New lessons will push old ones out.",
                    }
                )
    for p in props:
        if p["status"] == "open" and p.get("date") and now - p["date"] >= PROPOSAL_STALE_DAYS * DAY:
            out.append(
                {
                    "id": f"proposal:{p['id']}",
                    "kind": "proposal",
                    "severity": "info",
                    "proposal": p["id"],
                    "title": f"Proposal waiting {int((now - p['date']) / DAY)} days: {p.get('target') or p['id']}",
                    "detail": str(p.get("change") or "")[:200],
                }
            )
    rank = {"danger": 0, "warn": 1, "info": 2}
    out.sort(key=lambda f: rank.get(f["severity"], 3))
    return out


# --------------------------------------------------------------------------- runtime


# Only the app's own processes count: Python and Hermes (the gateway, bots, tools), Node (the dashboard)
# and the app itself. Other programs' crashes on the PC are none of Fleet Health's business.
RUNTIME_APPS = re.compile(r"^(pythonw?[\d.]*|hermes[\w-]*|node|chief command center|electron)\.exe$", re.I)


def crashes(days: int = 7) -> list[dict]:
    """Application Error events (native crashes) of the app's own processes, from the Windows event log."""
    query = f"*[System[Provider[@Name='Application Error'] and TimeCreated[timediff(@SystemTime) <= {days * 86400000}]]]"
    try:
        raw = subprocess.run(
            ["wevtutil", "qe", "Application", f"/q:{query}", "/f:xml", "/c:500"], capture_output=True, text=True, timeout=30, encoding="utf-8", errors="replace"
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    out = []
    ns = {"e": "http://schemas.microsoft.com/win/2004/08/events/event"}
    for chunk in re.findall(r"<Event .*?</Event>", raw, re.S):
        try:
            ev = ET.fromstring(chunk)
        except ET.ParseError:
            continue
        data = [d.text or "" for d in ev.findall(".//e:EventData/e:Data", ns)]
        created = ev.find(".//e:TimeCreated", ns)
        stamp = created.get("SystemTime", "") if created is not None else ""
        try:
            t = calendar.timegm(time.strptime(stamp[:19], "%Y-%m-%dT%H:%M:%S"))  # event times are UTC
        except ValueError:
            continue
        if len(data) > 7 and RUNTIME_APPS.match(data[0].strip()):
            out.append({"at": t, "app": data[0], "module": data[3], "code": data[6]})
    return out


def compactions_today() -> int:
    db = HERMES / "profiles" / "chief" / "state.db"
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        start = time.mktime(time.strptime(time.strftime("%Y-%m-%d"), "%Y-%m-%d"))
        n = conn.execute("SELECT COUNT(*) FROM messages WHERE content LIKE '[CONTEXT COMPACTION%' AND CAST(timestamp AS REAL) >= ?", (start,)).fetchone()[0]
        conn.close()
        return int(n)
    except sqlite3.Error:
        return 0


def last_run(name_part: str) -> dict | None:
    try:
        data = json.loads((HERMES / "profiles" / "chief" / "cron" / "jobs.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    jobs = data.get("jobs", data) if isinstance(data, dict) else data
    for j in jobs:
        if name_part.lower() in (j.get("name") or "").lower():
            return {"name": j.get("name"), "lastRunAt": j.get("last_run_at"), "lastStatus": j.get("last_status"), "enabled": j.get("enabled")}
    return None


def curator_last() -> dict | None:
    root = HERMES / "profiles" / "chief" / "logs" / "curator"
    runs = sorted(root.glob("*/run.json")) if root.is_dir() else []
    if not runs:
        return None
    try:
        run = json.loads(runs[-1].read_text(encoding="utf-8"))
    except (OSError, ValueError):
        run = {}
    return {"at": runs[-1].parent.name, "checked": run.get("checked") or run.get("auto", {}).get("checked"), "archived": run.get("archived")}


def runtime(now: float) -> dict:
    events = crashes(7)
    day = [e for e in events if e["at"] >= now - DAY]
    groups: dict[str, int] = {}
    for e in events:
        k = f"{e['app']} · {e['module']} · {e['code']}"
        groups[k] = groups.get(k, 0) + 1
    return {
        "crashes24h": len(day),
        "crashes7d": len(events),
        "crashGroups": sorted(({"key": k, "count": v} for k, v in groups.items()), key=lambda g: -g["count"])[:6],
        "lastCrashAt": max((e["at"] for e in events), default=None),
        "compactionsToday": compactions_today(),
        "curator": curator_last(),
        "distill": last_run("lessons distill"),
        "rosterReview": last_run("roster review"),
    }


# --------------------------------------------------------------------------- report


def proposals() -> list[dict]:
    try:
        data = json.loads((OUT / "proposals.json").read_text(encoding="utf-8"))
        items = data.get("items", []) if isinstance(data, dict) else data
        return [i for i in items if isinstance(i, dict) and i.get("id")][:12]
    except (OSError, ValueError):
        return []


def report() -> dict:
    now = time.time()
    conn = connect()
    kconn = None
    try:
        kconn = sqlite3.connect(f"file:{KANBAN}?mode=ro", uri=True)
        kconn.row_factory = sqlite3.Row
    except sqlite3.Error:
        kconn = None
    try:
        data = _collect(conn, kconn, now)
    finally:
        conn.close()
        if kconn:
            kconn.close()
    tmp = OUT / "report.json.tmp"
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, OUT / "report.json")
    (OUT / "report.md").write_text(markdown(data), encoding="utf-8")
    return data


def _collect(conn: sqlite3.Connection, kconn: sqlite3.Connection | None, now: float) -> dict:
    desk_cards = scorecards(kconn, now)
    skills = skills_summary(conn, kconn, now)
    props = decided_proposals(conn, now)
    return {
        "generatedAt": now,
        "desks": desk_cards,
        "skills": skills,
        "changes": recent_changes(conn, now),
        "changes7d": conn.execute("SELECT COUNT(*) FROM versions WHERE change IN ('added','changed') AND seen_at >= ?", (now - 7 * DAY,)).fetchone()[0],
        "runtime": runtime(now),
        "proposals": props,
        "flags": flags(skills, desk_cards, props, now),
        "thresholds": {
            "churn48h": CHURN_48H,
            "churn7d": CHURN_7D,
            "bloatBytes": BLOAT_BYTES,
            "growthRatio": GROWTH_RATIO,
            "memoryFull": MEMORY_FULL,
            "proposalStaleDays": PROPOSAL_STALE_DAYS,
            "episodeGapHours": int(EPISODE_GAP / 3600),
        },
    }


def markdown(data: dict) -> str:
    lines = [f"# Fleet learning report — {time.strftime('%Y-%m-%d %H:%M', time.localtime(data['generatedAt']))}", ""]
    lines.append("## Desk scorecards (last 7 days)")
    lines.append("| Desk | Done | Crashed | Gave up | Median min | Success | Cards 30d | Blocked | Memory |")
    lines.append("|---|---|---|---|---|---|---|---|---|")
    for d in data["desks"]:
        s = d["last7"]
        m = d["memory"]
        mem = f"{m['memory']}/{m['memoryLimit']}"
        succ = f"{round(s['success'] * 100)}%" if s["success"] is not None else "–"
        lines.append(
            f"| {d['desk']} | {s['done']} | {s['crashed']} | {s['gaveUp']} | {s['medianMinutes'] or '–'} | {succ} | {d['cards30']} | {d['blocked']} | {mem} |"
        )
    lines += ["", f"## Flags ({len(data['flags'])})"]
    for f in data["flags"]:
        lines.append(f"- [{f['severity']}] {f['title']} — {f['detail']}")
    lines += ["", f"## Skills changed ({data['changes7d']} edits in the last 7 days; most active first)"]
    lines.append("| Skill | 48h | 7d | 30d | Size | Latest episode |")
    lines.append("|---|---|---|---|---|---|")
    for s in data["skills"][:20]:
        ep = s["episodes"][0] if s["episodes"] else None
        verdict = f"{ep['edits']} edits: {ep['verdict']['label']}" if ep else "–"
        lines.append(f"| {s['key']} | {s['edits48h']} | {s['edits7d']} | {s['edits30d']} | {round(s['size'] / 1000, 1)} KB | {verdict} |")
    rt = data["runtime"]
    lines += ["", "## Runtime", f"- Native crashes: {rt['crashes24h']} in 24h, {rt['crashes7d']} in 7d"]
    for g in rt["crashGroups"]:
        lines.append(f"  - {g['count']}× {g['key']}")
    lines.append(f"- Context compactions today (the chief): {rt['compactionsToday']}")
    lines.append("")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    # Skills are full of arrows and dashes; a Windows child process defaults stdout to cp1252.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    cmd = argv[1] if len(argv) > 1 else "run"
    if cmd == "snapshot":
        print(snapshot())
    elif cmd == "report":
        report()
    elif cmd == "run":
        snapshot()
        report()
    elif cmd == "diff" and len(argv) > 2:
        conn = connect()
        try:
            row = conn.execute("SELECT * FROM versions WHERE id = ?", (int(argv[2]),)).fetchone()
            since = None
            if row and "--from" in argv[3:-1]:
                since = conn.execute("SELECT * FROM versions WHERE id = ? AND file = ?", (int(argv[argv.index("--from") + 1]), row["file"])).fetchone()
                if since is None:
                    print(f"change #{argv[argv.index('--from') + 1]} is not an earlier version of the same file")
                    return 2
            print(diff_text(conn, row, since=since) if row else f"no change #{argv[2]}")
        finally:
            conn.close()
    elif cmd == "revert" and len(argv) > 2:
        discard = int(argv[argv.index("--discard-newer") + 1]) if "--discard-newer" in argv[3:-1] else 0
        print(revert(int(argv[2]), discard))
        report()
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
