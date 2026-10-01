# Plan: two Second Brain formats, existing vaults used as they are, Today reads Kanban boards

Status: approved 2026-10-01 (owner: "plan, then build"; extras as generic built-in routines). Built and verified 2026-10-01 (PROGRESS, 2026-10-01).

## Why

The app's Second Brain template is one layout: PARA folders plus a small wiki under `40 Knowledge`, with tasks as `📅` checkboxes. The bundled toolkit (obsidian-second-brain) supports a second layout, its **wiki-style, agent-first** vault:

- `raw/` holds immutable sources;
- `wiki/` holds what the agent keeps (entities, concepts, projects, daily, tasks, decisions, reviews);
- tasks live on Kanban boards (`boards/`, `@{date}`, 🔴🟡🟢) with a note per task;
- `_CLAUDE.md` is the operating manual.

A test on a real vault of that kind (2026-10-01) found three problems:

- "Keep my folders" added `AGENTS.md`, `00 Inbox/` and `40 Knowledge/`, with a Folder Map that contradicted the vault's own manual.
- The app's skills and SOUL told Chief to follow `AGENTS.md` and `📅` checkboxes.
- Today read every checkbox in daily notes and transcripts (1,055 "tasks", 1 with a date) and none of the boards.

## Decisions

1. **Setup asks for the format first,** with a short explanation of each, then whether to start a new folder or use an existing one.
   - **Organized (PARA):** for people who browse their notes. Folders by what's active, tasks as checkboxes in notes, Obsidian Bases views. This is the current template.
   - **Agent-first wiki:** for people who mostly ask Chief. Sources are kept untouched in `raw/`, Chief maintains `wiki/`, tasks live on Kanban boards with a note each, and every write goes through a strict write-gate. Files dropped into `drop/` are filed automatically.
2. **An existing folder with its own manual is used as it is.** If `_CLAUDE.md` (not the app's pointer) or an `AGENTS.md` the app didn't write is present, nothing is added, and Chief follows that manual. The format is detected and preselected: `wiki/` plus `raw/`, or a `_CLAUDE.md` describing them, means the wiki format.
3. **Chief follows the chosen format.** The always-loaded `second-brain` skill and the write gate come in two variants. Both name the vault's actual rules file:
   - the PARA variant uses `AGENTS.md`, its Folder Map, `📅` tasks and `90 Archive/`;
   - the wiki variant uses `_CLAUDE.md`, the toolkit's wiki-style folder map, boards plus task notes, and the full write-gate (sources first, fan-out, board ↔ task, verify, `write-gate: PASS | PARTIAL`).

   The default SOUL names "the folder's rules file" instead of `AGENTS.md`. `WIKI_PATH` is set only for PARA (the upstream `llm-wiki` layout lives in `40 Knowledge`).
4. **Today reads Kanban boards.** Rules:
   - A file with `kanban-plugin:` in its properties is a board.
   - Columns come from `##` headings (emoji stripped; Backlog, This Week, In Progress, Waiting On, Next Week, Done, and close matches).
   - Cards are top-level checkboxes. `@{YYYY-MM-DD}` (or `📅`) is the due date, 🔴🟡🟢 (or 🔺⏫🔼🔽) the priority, `~~text~~` and `✅ date` mean done.
   - A `[[…tasks/…]]` link is the task note. Indented lines are notes, or blockers when they say "waiting on".
   - Reading stops at the `%%` settings block.
   - For the wiki format, Today reads boards only. For PARA, it reads checkboxes as now, plus any boards.
   - `raw/`, `drop/`, `templates/` and `_trash/` are never task sources.

   Marking done or moving a card from Today asks Chief to update the board and its task note together.
5. **Routines suit the format.** Both formats get the four toolkit routines (morning, nightly, weekly, health check). The wiki format adds three built-in routines, written generically for the app (no personal content):
   - **Drop folder** (`second-brain-drop`), every 30 minutes. A script gate checks `drop/` first, so an empty folder never calls the model. Each run handles one stable file:
     - claim it into `drop/_processing/`;
     - extract it with what is available locally;
     - save the text under `raw/` and the original under `raw/originals/`;
     - rewrite the wiki pages it affects, then update `index.md`, the daily note and `log.md`.
     Anything unclear, too large, a container (`.zip` and similar), or needing a download or paid service goes to `drop/needs-review/` with a reason note.
   - **Morning brief** (`second-brain-brief`), weekdays at 08:30, to the chat. It covers agent health, what changed, the recommended focus, blockers, and up to 5 numbered questions for the owner. When the owner answers in chat, the answers are applied through the write-gate, with the reply kept under `raw/conversations/`.
   - **Current Analysis** (`second-brain-analysis`), the last step of the nightly routine. It fully rewrites `wiki/reviews/Current Analysis.md`: agent health, what changed, trajectory, execution, hygiene, carry forward, Open for the owner, stats.

   For a folder that already has its own manual, setup offers the routines but leaves them off (one switch to turn them on), since such a vault may already have jobs of its own.
6. **Nothing personal.** The wiki template, skills and texts are written for "the owner", like the rest of the app. The privacy scan runs before every commit.

## Order of work

1. **Bridge (`second_brain.py`):**
   - `FORMATS = ("para", "wiki")`, and a second template (`second_brain/template-wiki/`) with its manifest;
   - `inspect()` reports `format_detected`, `manual` and `has_manual`, and a plan per (format, mode);
   - `setup(path, mode, format, routines)`: when a manual exists, keep mode adds nothing;
   - state records `format` and `rules`. Earlier installs migrate: format `para`, rules from what's on disk;
   - format-aware skills, SOUL wording and `WIKI_PATH`; routines per format, including the drop gate script copied to the profile's `scripts/`;
   - `status()` reports format and rules.
2. **New bundled skills** in `second_brain/`: `skill-wiki`, `skill-writes-wiki`, `skill-drop`, `skill-brief` and `skill-analysis`, rendered for the vault, like the existing two.
3. **Web:**
   - setup becomes format → new or existing → folder → review → done, with the same component in onboarding and Settings;
   - Settings → Second Brain shows the format;
   - `today-index.ts` gets the Kanban reader and the per-format task sources. It learns the format from the bridge's status, with auto-detection as a fallback;
   - kickoff texts for board cards.
4. **Tests:**
   - Python units: detection, plans, nothing added to a vault with a manual, skill rendering, routines per format, the drop gate;
   - Second Brain contract on the payload: a new wiki vault, an adopted synthetic wiki vault, then PARA as before;
   - web: the setup flow, the Kanban reader (columns, dates, priorities, done, notes, `%%`), and wiki-format boards-only.
5. **Acceptance on a real vault.** Read a scratch copy of an existing wiki-style vault and compare Today's open and overdue counts with its current task service's numbers. Delete the copy afterwards.
6. **Browser check** of setup (both formats, new and existing) and Today on the throwaway gateway. Then docs (PROGRESS, FRAGILE_SEAMS), privacy, commit, and build the next version.
