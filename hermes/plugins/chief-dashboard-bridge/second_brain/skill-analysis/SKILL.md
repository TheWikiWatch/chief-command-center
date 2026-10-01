---
name: second-brain-analysis
description: "The nightly Current Analysis: re-derive where things stand from the Second Brain and fully rewrite wiki/reviews/Current Analysis.md (agent health, what changed, trajectory, execution, hygiene, carry forward, Open for the owner, stats). Triggers: current analysis, refresh the analysis, where do things stand, what's open for me."
version: 1.0.0
author: Chief Command Center
license: MIT
platforms: [windows, macos, linux]
metadata:
  hermes:
    tags: [second-brain, nightly, analysis, review]
    category: note-taking
    related_skills: [second-brain, second-brain-writes, second-brain-brief]
---

# Current Analysis

`wiki/reviews/Current Analysis.md` in the Second Brain `{{vault}}` is the one page that says where things stand today. The nightly routine rewrites it after its synthesis and reconciliation; the morning brief reads it. Read `{{vault}}\{{rules}}` first.

## Procedure

1. Read `index.md`, the current `Current Analysis.md`, the last seven daily notes, every board in `boards/`, the active projects in `wiki/projects/`, the recent end of `log.md`, and the latest weekly review if there is one.
2. **Re-derive, don't copy yesterday:**
   - what changed in the last day (from the log and daily notes);
   - where effort is going, and what is being neglected;
   - execution: overdue cards, cards stuck in the same column, Waiting On without a follow-up;
   - hygiene: a card and its task note disagreeing on due date or status, boards with no posture, duplicate pages;
   - Open for the owner: keep only questions that still need them. For each carried-over item, read the page that would settle it; if it's settled there, drop it.
3. When you fix a fact on the way, follow the `second-brain-writes` gate in full (source, primary page, fan-out, board and task note together).
4. **Rewrite the whole page** (never patch yesterday's) with properties `date` and `as_of` set to today, `type: review`, `status: nightly`, `ai-first: true`, a `## For future agent` section, then:
   - `## Agent health`: the routines' last runs, the drop folder, anything failing;
   - `## What changed (24h)`;
   - `## Trajectory`: where things are heading, per area or project;
   - `## Execution`: due, overdue, stuck;
   - `## Integrity`: hygiene findings, fixed or flagged;
   - `## Carry forward`: what tomorrow should pick up;
   - `## Open for the owner`: numbered, each a single answerable question, with links;
   - `## Stats`: open and overdue cards per board, pages per kind.
5. Add `## Current Analysis` to today's daily note with the open-question count and a link to [[Current Analysis]]; add one `log.md` entry listing the paths; update `index.md` if its counts drifted.
6. **Verify:** read the page back and check that `as_of` is today and that at least two items you judged settled are not in Open for the owner. End with the open-question count and `write-gate: PASS` or `PARTIAL` and what's missing.

## Rules

- No new board tasks in bulk: propose them under Carry forward or Open for the owner.
- One rolling page; dated weekly reviews are the archive.
- Never edit anything in `raw/`.
