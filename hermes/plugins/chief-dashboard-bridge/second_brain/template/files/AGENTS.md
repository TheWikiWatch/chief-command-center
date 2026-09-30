---
type: guide
created: {{today}}
---

# How this Second Brain works

This folder is a Second Brain: plain Markdown notes, organized by what they are for right now. Any agent working here (the chief, or any other AI tool) follows these rules. People can open it in Obsidian or any editor.

{{layout}}

## Rules for agents

1. **Never delete a note.** Finished or no longer relevant → move it to `90 Archive/`, keeping its folder name as a prefix if helpful.
2. **Capture first, organize later.** Anything the owner asks you to remember that has no obvious home goes to `00 Inbox/` as its own note. Triage the Inbox when asked, or during the weekly review.
3. **One project, one note** in `10 Projects/`. A project has an outcome and an end. Ongoing responsibilities without an end are areas (`20 Areas/`).
4. **Raw sources are immutable.** Files in `40 Knowledge/raw/` are never edited after they are saved. Summaries and synthesis go in the rest of `40 Knowledge/` (see `40 Knowledge/SCHEMA.md`).
5. **Link, don't duplicate.** Use `[[wikilinks]]` to connect notes. Prefer adding to an existing note over creating a near-duplicate.
6. **Log what you change.** Append one line per change you make to the vault to `40 Knowledge/log.md`: date, what, where.
7. **Ask before big moves.** Reorganizing many notes, renaming folders or merging notes needs the owner's go-ahead, with the list of changes shown first.

## Tasks

Tasks are Markdown checkboxes inside project, area and daily notes (this format also works with Obsidian's Tasks plugin):

```
- [ ] Call the plumber 📅 2026-10-02
- [ ] Draft the budget ⏫ 📅 2026-10-05
- [ ] Waiting on Sam's quote #waiting
- [x] Book flights ✅ 2026-09-30
```

- `📅 YYYY-MM-DD` due date, `⏳ YYYY-MM-DD` scheduled date, `✅ YYYY-MM-DD` done date.
- Priority: `🔺` highest, `⏫` high, `🔼` medium, `🔽` low.
- `#waiting` marks a task that waits on someone else.
- When a task is done, tick it and add `✅` with today's date. Don't delete finished tasks.

## Properties

Notes start with YAML properties so they can be listed and filtered (see `Bases/`):

- Projects: `type: project`, `status: active | paused | done`, `area: "[[Area name]]"`, `due: YYYY-MM-DD`
- Areas: `type: area`
- Daily notes: `type: daily`, `date: YYYY-MM-DD`
- Sources and knowledge pages: see `40 Knowledge/SCHEMA.md`

Keep tags few (status and stage, not topics). Topics are links.

## Routines

- **Daily note** in `Journal/Daily/YYYY-MM-DD.md` from `Templates/Daily note.md`.
- **Weekly review** in `Journal/Weekly/YYYY-Www.md` from `Templates/Weekly review.md`: empty the Inbox, check every active project has a next step, archive what's done.
