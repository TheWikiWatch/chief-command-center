---
name: second-brain
description: "The owner's Second Brain (an agent-first wiki): the first place to look for context about them, and the rules every write follows."
version: 2.2.0
author: Chief Command Center
license: MIT
platforms: [windows, macos, linux]
metadata:
  hermes:
    tags: [second-brain, notes, tasks, memory, obsidian, wiki]
    category: note-taking
    related_skills: [second-brain-writes, obsidian-find, obsidian-save, obsidian-task, obsidian-board, obsidian-daily]
---

# Second Brain

The owner's Second Brain is the folder `{{vault}}`: an agent-first wiki. It is the long-term record of their projects, people, decisions, plans, tasks and sources, and it outlasts any conversation. Its operating manual is `{{vault}}\{{rules}}`.

## Look here first

- For anything about the owner (their work, people, plans, preferences, past decisions or anything they told you before), check the Second Brain **before** answering from memory and before asking them. Start with `index.md`, then `wiki/reviews/Current Analysis.md` for where things stand, then search the folder (the `obsidian-find` skill).
- If the Second Brain and your memory disagree, say so and prefer the dated note.
- Never say something isn't there without having searched by every plausible name.
- Reading is always fine.

## Critical facts

The owner's most important facts (who they are, where, their work, current focus, key people) live in `CRITICAL_FACTS.md` at the top of the Second Brain, kept short. That file is the only copy: the chief is given it at the start of every conversation, and anyone else reads it when a task is about the owner. Don't copy the facts into a skill or another note.

When you learn a fact that belongs there and the line is blank or out of date, update `CRITICAL_FACTS.md`, following the write rules below.

## Every write follows the manual

Before your first write to the Second Brain in a conversation, load the **`second-brain-writes`** skill and read `{{vault}}\{{rules}}`. Its Folder Map says where every kind of note goes and wins over any skill's defaults; its write-gate applies to every write, including small ones and scheduled routines. A fact settled in conversation but never written down is a failed write.

The usual layout (the manual is the authority):

- `raw/` sources, never edited; `raw/originals/` the files they came from;
- `wiki/` what is known: `entities/`, `concepts/`, `projects/`, `daily/`, `tasks/`, `decisions/`, `reviews/`;
- `boards/` Kanban boards; `drop/` files waiting to be filed.

## Tasks live on boards

A task is a card on a board in `boards/` (`- [ ] Title 🟡 @{YYYY-MM-DD} [[wiki/tasks/Title]]`), with a note in `wiki/tasks/` when it needs context. The card and the note always agree on due date and status, changed in the same write. The app's Today tab reads the boards.

## Which skill for what

| The owner wants… | Use |
| --- | --- |
| "remember this", "save that" | `obsidian-save`, or `obsidian-capture` for a quick idea |
| a task, a reminder, a due date, a card moved or done | `obsidian-task`, `obsidian-board` (board ↔ task note together) |
| a tidy board | `obsidian-board-hygiene` |
| today's plan, what's overdue | `obsidian-daily`, `obsidian-catchup` |
| to find something | `obsidian-find` |
| a person, a project | `obsidian-person`, `obsidian-project`, `obsidian-projects` |
| a decision thought through | `obsidian-decide`, `obsidian-challenge` |
| a file or article filed away | put it in `drop/`: the drop routine files one file at a time (its skill is the one the rules file names, else `second-brain-drop`) |
| answers to the morning brief | the brief's skill in reply mode (the one the rules file names, else `second-brain-brief`) |
| where things stand | `wiki/reviews/Current Analysis.md`, rewritten nightly |
| patterns, links between notes | `obsidian-connect`, `obsidian-synthesize`, `obsidian-emerge` |
| a health check of the folder | `obsidian-health` |

The toolkit's own rules are in `{{toolkit}}/references/` (`ai-first-rules.md`, `write-rules.md`, `folder-map.md`). This folder is already set up: never run `obsidian-init` on it.

When you mention a note to the owner, give its full path in backticks or a `[[wikilink]]`, so the app can open it.
