---
date: {{today}}
type: operating-manual
tags: [operating-manual]
ai-first: true
---

## For future agent
The operating manual for this Second Brain: an agent-first wiki. It says where every kind of note goes (the Folder Map), how sources, tasks and boards work, and the write-gate every write passes. Read it before the first read or write of a session. It is the single source of truth; update it when the layout or the rules change.

# Operating manual

This Second Brain is written for agents to read and reason over, so the owner can ask instead of browse. Sources are kept untouched in `raw/`; everything learned from them is maintained in `wiki/`; tasks live on Kanban boards in `boards/` with a note per task in `wiki/tasks/`.

{{layout}}

## Section 0 - Every note is written for the next agent

1. **Self-contained.** A note explains itself; the next agent may read it alone.
2. **`## For future agent` first.** Right after the properties: two or three plain sentences saying what the note is, why it exists, and what may go stale.
3. **Properties.** `date`, `type`, `tags` (including the type), `ai-first: true`, plus the type's own fields (see the templates in `templates/`).
4. **Dated claims.** Anything that can change carries its date: "(as of YYYY-MM-DD)".
5. **Sources kept.** Every outside claim keeps its URL or its `raw/` source inline.
6. **Links.** Every person, project, concept and decision is a `[[wikilink]]`; create a short stub if the note doesn't exist yet.
7. **Confidence** where it matters: `stated | high | medium | speculation`.

**Never invent absence.** Search by every plausible name before saying a note, person or fact isn't here. Unknowns are written as `TBD`, never guessed.

## Section 1 - Folder Map

Where each kind of note goes. The Second Brain skills read this table; it wins over their own defaults. Never invent a folder: if a kind of note isn't listed, ask the owner.

| Note type | Folder |
| --- | --- |
| Inbound files to file away (one per routine run) | `drop/` (system: `drop/_processing/`, `drop/needs-review/`) |
| Source text (article, PDF, transcript, image description, conversation), never edited | `raw/articles/`, `raw/pdfs/`, `raw/transcripts/`, `raw/images/`, `raw/videos/`, `raw/conversations/` |
| Original file a source came from | `raw/originals/` |
| Person, company, tool (entity) | `wiki/entities/` |
| Idea, concept, framework, synthesis | `wiki/concepts/` |
| Project | `wiki/projects/` |
| Daily note | `wiki/daily/` (`YYYY-MM-DD.md`) |
| Work log | `wiki/logs/` |
| Weekly or monthly review, and `Current Analysis.md` | `wiki/reviews/` |
| Standalone task note | `wiki/tasks/` |
| Decision record | `wiki/decisions/` |
| Meeting note | `wiki/meetings/` |
| Kanban board | `boards/` |
| Finished or inactive note | `wiki/archive/` |
| Soft-deleted note | `_trash/` |
| Note template | `templates/` |

**Key files:** `index.md` (the catalog, read it first), `log.md` (one line per change), `CRITICAL_FACTS.md` (the few facts every conversation needs), `wiki/reviews/Current Analysis.md` (where things stand, rewritten nightly).

## Section 2 - Sources and the drop folder

- **`raw/` is immutable.** A source is saved once and never edited. Corrections go in `wiki/`, which links back to the source.
- **`raw/` holds outside sources only:** articles, documents, transcripts, photos, conversations with the owner. Documents an agent writes (analysis, plans, reports) belong in `wiki/`.
- **Ingest rewrites the wiki.** Each new source updates the pages it touches (the primary entity or project, related concepts, people) and `index.md`. The vault should be different after an ingest, not only bigger.
- **The drop folder** is the owner's inbox for files. The drop routine takes exactly one file per run: it waits until the file has finished copying, claims it into `drop/_processing/`, extracts it, saves the text under `raw/` and the original under `raw/originals/`, rewrites the wiki, and updates the daily note, `log.md` and `index.md`. Anything unclear, too large, a container (`.zip` and the like), or needing a download or a paid service goes to `drop/needs-review/` with a `.reason.md` note. Files are never bulk-ingested.

## Section 3 - Tasks and boards

Boards are Kanban boards (`kanban-plugin: board` in their properties), one per area of life or work, each with these columns:

`## 📥 Backlog` · `## 📋 This Week` · `## 🔨 In Progress` · `## ⏳ Waiting On` · `## 📅 Next Week` · `## ✅ Done`

A card is one line, with optional indented notes under it:

```
- [ ] Call the plumber 🟡 @{2026-10-02} [[wiki/tasks/Call the plumber]]
    - Quote expected by Friday
- [x] ~~Book flights~~ 🟢 ✅ 2026-09-30
```

- `@{YYYY-MM-DD}` is the due date; 🔴 high, 🟡 medium, 🟢 low priority.
- A task with more than a line of context gets a note in `wiki/tasks/` (properties: `type: task`, `status`, `priority`, `due`, `board`), linked from its card.
- **Board and task note always agree:** a due date or status changed on one is changed on the other in the same write.
- Done: tick it, strike it through, add `✅ YYYY-MM-DD`, and move it to `✅ Done`. Finished tasks are never deleted.
- A new board is a new file in `boards/`; no other change is needed.

## Section 4 - The write-gate

Every write that settles a fact passes all of these, small writes and scheduled routines included:

1. **Source first.** An answer the owner gives, or a new outside claim, is saved under `raw/` (answers: `raw/conversations/`) before the wiki changes.
2. **Primary page.** The page that owns the fact (entity, project, decision, task) is updated.
3. **Fan-out.** After changing a number or a claim, search `wiki/` for the old value and update every page that still states it.
4. **Board and task note together** for due dates and status.
5. **Daily, log, index.** The daily note says what changed; `log.md` lists every path written; `index.md` is updated when the catalog changes. Open questions for the owner live in `wiki/reviews/Current Analysis.md`.
6. **Verify.** Read back every path claimed, then state `write-gate: PASS`, or `write-gate: PARTIAL` with exactly what is missing. A fact settled in conversation but never written down is a failed write.

**Ask before big changes.** Moving, renaming or merging more than a couple of notes needs the owner's yes, with the list shown first. Never delete: archive to `wiki/archive/`, or soft-delete to `_trash/`.

## Section 5 - Scheduled routines

The owner turns each routine on or off, and sets its time, in the app (Team & Routines, or Settings, then Second Brain). Every routine reads this file first and follows the write-gate.

| Routine | When | What |
| --- | --- | --- |
| Drop folder | every 30 minutes | One file from `drop/`, fully ingested; silent when `drop/` is empty |
| Morning note | 08:00 | Today's daily note: what's due and overdue on every board |
| Morning brief | weekdays 08:30 | What changed, the recommended focus, and up to five questions for the owner; answers are applied through the write-gate |
| Nightly | 22:00 | Synthesize and reconcile the day, link orphans, then rewrite `Current Analysis.md` |
| Weekly review | Friday 18:00 | A dated review in `wiki/reviews/` |
| Health check | Sunday 21:00 | Broken links, duplicates, stale facts; reported, not auto-fixed |

## Naming

- Daily notes `YYYY-MM-DD.md`; sources `YYYY-MM-DD - Title.md`; originals `raw/originals/YYYY-MM-DD - name.ext`.
- Entities by their full name; one canonical page per subject.
- A wikilink matches its file name exactly.
