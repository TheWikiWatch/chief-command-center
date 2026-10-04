---
name: second-brain
description: "The owner's Second Brain: the first place to look for context about them, and the rules every write follows."
version: 2.1.0
author: Chief Command Center
license: MIT
platforms: [windows, macos, linux]
metadata:
  hermes:
    tags: [second-brain, notes, tasks, memory, obsidian]
    category: note-taking
    related_skills: [second-brain-writes, obsidian-find, obsidian-save, obsidian-daily, llm-wiki]
---

# Second Brain

The owner's Second Brain is the folder `{{vault}}`. It is the long-term record of their projects, people, decisions, plans, tasks and notes, and it outlasts any conversation.

## Look here first

- For anything about the owner (their work, people, plans, preferences, past decisions or anything they wrote down), check the Second Brain **before** answering from memory and before asking them. Start with `index.md`, then search the folder (the `obsidian-find` skill).
- If the Second Brain and your memory disagree, say so and prefer the dated note.
- Never say something isn't there without having searched.
- Reading is always fine.

## Critical facts

The owner's most important facts (who they are, where, their work, current focus, key people) live in `CRITICAL_FACTS.md` at the top of the Second Brain, kept short. That file is the only copy: the chief is given it at the start of every conversation, and anyone else reads it when a task is about the owner. Don't copy the facts into a skill or another note.

When you learn a fact that belongs there and the line is blank or out of date, update `CRITICAL_FACTS.md`, following the write rules below.

## Every write follows the full rules

Before your first write to the Second Brain in a conversation, load the **`second-brain-writes`** skill and read `{{vault}}\{{rules}}`. Every write follows them, including small ones and scheduled routines. A fact settled in conversation but never written down is a failed write.

## Which skill for what

| The owner wants… | Use |
| --- | --- |
| "remember this", "save that" | `obsidian-save`, or `obsidian-capture` for a quick idea |
| a task, a reminder, a due date | `obsidian-task` (task syntax in `{{rules}}`; the app's Today tab reads it) |
| today's plan, what's overdue | `obsidian-daily`, `obsidian-catchup` |
| to find something | `obsidian-find` |
| a person, a project | `obsidian-person`, `obsidian-project`, `obsidian-projects` |
| a decision thought through | `obsidian-decide`, `obsidian-challenge` |
| a weekly review | `obsidian-review` (template: `Templates/Weekly review.md`) |
| patterns, links between notes | `obsidian-connect`, `obsidian-synthesize`, `obsidian-emerge` |
| a source or article kept | `llm-wiki` into `40 Knowledge/` (raw sources are never edited) |
| a health check of the folder | `obsidian-health` |

These skills read the Folder Map in `{{rules}}` to choose folders. The toolkit's own rules are in `{{toolkit}}/references/` (`ai-first-rules.md`, `write-rules.md`). This folder is already set up: never run `obsidian-init` on it.

When you mention a note to the owner, give its full path in backticks or a `[[wikilink]]`, so the app can open it.
