---
name: second-brain
description: "The owner's Second Brain: capture, tasks, projects, daily notes, weekly review."
version: 1.0.0
author: Chief Command Center
license: MIT
platforms: [windows, macos, linux]
metadata:
  hermes:
    tags: [second-brain, notes, tasks, para, obsidian]
    category: note-taking
    related_skills: [obsidian, llm-wiki, weekly-review-planning]
---

# Second Brain

The owner keeps their notes, tasks and projects in a Second Brain folder:

`{{vault}}`

Use this skill whenever the owner asks you to remember, save, capture, track, plan, review, or find something they wrote down, and for anything about their tasks, projects, areas, journal or weekly review.

## First, read the rules

Read `{{vault}}\AGENTS.md` at the start of any Second Brain work. It says where things go, how tasks are written and what never to do. It wins over anything below if they disagree, because the owner may have edited it.

File tools need concrete paths: use the path above, not `$OBSIDIAN_VAULT_PATH`.

## Everyday actions

**Capture** ("remember…", "save this", "note that…")
- A task with a date → add a checkbox task to the right project or area note, or to today's daily note if none fits: `- [ ] Call the plumber 📅 2026-10-02`.
- Anything else without an obvious home → a new note in `00 Inbox/` named after its content.
- Say where you put it, in one line.

**Tasks**
- Syntax: `📅` due, `⏳` scheduled, `✅` done date, priority `🔺 ⏫ 🔼 🔽`, `#waiting` for things that wait on someone.
- Completing: tick `- [x]` and append `✅ YYYY-MM-DD` with today's date. Never delete a finished task.
- Rescheduling: change the `📅` date in place.
- The dashboard's Today tab reads these tasks straight from the files, so keep the syntax exact.

**Projects and areas**
- New project → `10 Projects/<Name>.md` from `Templates/Project.md` with `type: project`, `status: active`, an **Outcome** line and at least one next step.
- Finished project → set `status: done` and move the note to `90 Archive/`.
- Ongoing responsibilities without an end go in `20 Areas/`.

**Daily note**: `Journal/Daily/YYYY-MM-DD.md` from `Templates/Daily note.md`. Create it the first time the owner mentions today's plans or logs something for today.

**Weekly review** (when asked, or when a weekly routine runs): follow `Templates/Weekly review.md` into `Journal/Weekly/YYYY-Www.md`. Empty the Inbox with the owner, check every active project has a next step, surface overdue and `#waiting` tasks, archive what's done. Propose moves; don't make big changes silently.

**Knowledge**: sources and research go through the `llm-wiki` skill into `40 Knowledge/` (`WIKI_PATH`). Raw sources in `40 Knowledge/raw/` are never edited.

## Always

- Never delete notes. Archive instead.
- Ask before moving, renaming or merging more than a couple of notes, and show the list first.
- Append one line per change to `40 Knowledge/log.md`: `YYYY-MM-DD — what — where`.
- Prefer adding to an existing note over creating a near-duplicate; search first.
- The Second Brain is the owner's private data. Don't copy it elsewhere unless asked.
