---
name: second-brain-brief
description: "The morning brief from the Second Brain (agent health, what changed, the focus for today, blockers, up to five numbered questions for the owner), and applying the owner's answers to it through the write-gate. Triggers: morning brief, human brief, my answers to the brief, numbered replies after a brief."
version: 1.0.0
author: Chief Command Center
license: MIT
platforms: [windows, macos, linux]
metadata:
  hermes:
    tags: [second-brain, brief, questions, write-gate]
    category: note-taking
    related_skills: [second-brain, second-brain-writes, second-brain-analysis]
---

# Morning brief

The Second Brain `{{vault}}` keeps the owner's world; the brief is how it asks them what only they know. Read `{{vault}}\{{rules}}` first. Two modes.

## Mode A: write the brief (the scheduled routine)

1. Read `wiki/reviews/Current Analysis.md`, today's daily note (`wiki/daily/YYYY-MM-DD.md`), every board in `boards/`, and the recent end of `log.md` (failed or missed routines).
2. If `Current Analysis.md` is missing or its `as_of` is older than yesterday, say so under Agent health and build the open questions from the boards and the latest daily notes instead.
3. Write the brief:

```
# Morning brief (YYYY-MM-DD)

## Agent health
(the last nightly, the drop folder, anything failing: one line each)

## What changed
(since the last brief, with [[links]])

## Focus today
(one recommendation, and why)

## Blockers and open loops
(what waits on whom; anything due or overdue)

## Questions for you
1. ...
2. ...

Reply here with any of them (numbers help). Partial answers are fine; I'll file them in the Second Brain.
```

   **Questions:** three to five, numbered, one ask each, easy to answer. Only real decisions or facts the owner must supply, taken from "Open for the owner" in `Current Analysis.md` and from the boards. Never as numbered questions: system status (that's Agent health), reminders already on a board, or anything already settled in the notes. More than five open: ask the five with the most pressure (due soon, money, obligations) and list the rest under Blockers as "also open".
4. Save the brief, questions included, in today's daily note under `## Morning brief`, so the answers can be matched later.
5. **The final response is the whole brief**, starting with `# Morning brief`. A final response that only says the brief was sent is a failed run.

## Mode B: apply the owner's answers

When the owner answers the brief in chat (numbered or not):

1. Find the brief they're answering: in the conversation, or under `## Morning brief` in today's (or yesterday's) daily note. Map each answer to its question **by topic**, not only by number; an answer that doesn't clearly match stays open, and you ask.
2. **Source first:** save `raw/conversations/YYYY-MM-DD - Morning brief answers.md` with the owner's reply verbatim, the questions, and a table: question, answer, how you're applying it, confidence. Never skip it.
3. For each settled answer, follow the `second-brain-writes` gate in full: the primary page (entity, project, decision, task), the fan-out search for the old value, the board card and task note together, then the daily note, `log.md` (every path) and `index.md`.
4. Take settled questions off "Open for the owner" in `Current Analysis.md`.
5. Common answers and how to apply them:

| The owner says | Apply as | Not as |
| --- | --- | --- |
| "Done", "ordered", "sent" | Task done (card to Done, `✅ date`, note `status: done`) | Left open |
| "I'll do it today", "buying it today" | In Progress | Done |
| A new date | Card `@{date}` and note `due:` | One side only |
| "Move all of those" (no date) | Pick a sensible date for each, say which, record why | Moving only one |
| "Not urgent" | Backlog, lower priority, noted on the project | New pressure tasks |
| "Wait for X" | Waiting On, with who and what | In Progress |
| A correction ("that's wrong, it's…") | Fix the live pages, note the correction | Editing anything in `raw/` |

6. Verify every path you claim, then answer the owner with what was applied (a short table with paths), what's still open, and `write-gate: PASS` or `PARTIAL` and what's missing.

**Answers that only live in chat are a failed run.**
