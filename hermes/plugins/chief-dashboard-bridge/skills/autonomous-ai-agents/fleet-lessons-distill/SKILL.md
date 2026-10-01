---
name: fleet-lessons-distill
description: "Weekly: turn the team's week (Fleet Health report, the owner's decisions, corrections in conversations) into a few proposed improvements the owner approves or dismisses. Proposals only; never applies anything."
version: 1.0.0
author: Chief Command Center
license: MIT
metadata:
  hermes:
    tags: [fleet, learning, skills, review]
    category: autonomous-ai-agents
    related_skills: [fleet-ops, fleet-builder]
---

# Weekly lessons distill

Your team's skills and memories change on their own: Hermes reviews conversations and patches them. Fleet Health keeps the record. Once a week you read that record and propose what should change next. **You propose; the owner decides; nothing is applied here.**

The Fleet Health folder is `learning/` under the Hermes root (the folder that holds `profiles/`).

## Inputs (stop when you have the picture)

1. `learning/report.json`:
   - `flags`: churn, bloat, a "worse" episode, a nearly full memory, a stale proposal;
   - `skills`: each skill's edits in 48 h, 7 days and 30 days, its size trend, and episodes with verdicts ("helped", "worse", "no clear change", "too early", "too little work", "confounded");
   - `desks`: each bot's week.
2. `learning/decisions.json` (the owner's Approve / Dismiss, written by the app) and last week's `learning/proposals.json`. Never propose again what the owner dismissed.
3. Corrections: what the week's conversations pushed back on. Use `session_search` with at most six targeted queries ("that's wrong", "not what I asked", "root cause", "lesson").

## Output

Write `learning/proposals.json`, replacing it:

```json
{"items": [
  {"id": "<yyyymmdd>-<n>", "kind": "skill|memory|revert|desk", "target": "<skill name, bot id, or #change id>", "change": "<the exact change, one or two lines>", "why": "<the event or number from the report>"}
]}
```

- At most five items, the strongest first. Keep last week's undecided items that still hold (same id); drop decided ones.
- A revert proposal for a "worse" episode targets `#<the episode's first change id>` and says how many later edits it would also undo.
- Append the week to `learning/LEARNINGS.md` (create it if missing): a `## <yyyy-mm-dd>` heading, then two or three lines on what the team learned, what got worse and what you proposed. Never rewrite earlier weeks.
- Then send the owner one short screen: the week in two lines (edits, verdicts, flags) and the proposals in plain words. They approve or dismiss each one in Fleet Health.

## Rules

- **Never apply anything.** No `skill_manage`, no memory writes, no task cards. The only files you write are `learning/proposals.json` (replaced) and `learning/LEARNINGS.md` (appended). Never write `decisions.json`; it belongs to the owner.
- Base every proposal on a number or an event in the inputs. No proposal without one.
- If the week was quiet, say so in one line and write an empty `items` list.
