---
name: obsidian-board
description: "Show or update a kanban board - flags overdue items, updates from conversation Triggers: show board, kanban, what is on my board, update board. Use only when the user explicitly asks for it."
version: 0.17.0
author: "Eugeniu Ghelbur"
license: MIT
metadata:
  hermes:
    tags: [obsidian-second-brain, vault]
---

## When to use

When the user's request matches any of: show board, kanban, what is on my board, update board.

## Procedure


Use the obsidian-second-brain skill. Execute `/obsidian-board $ARGUMENTS`:

The optional argument is a board name. Handle typos and partial matches.

1. Read `_CLAUDE.md` first if it exists in the vault root
2. If a board name is given, search the boards folder for it (fuzzy match), resolved per `references/folder-map.md` (wiki-style `boards/`, Obsidian-style `Boards/`)
3. If no name given, list available boards and ask which one
4. Read and display the current board state: columns, item counts, overdue items (past `@{date}`)
5. Ask if the user wants to make updates - if yes, infer changes from conversation context
6. Move completed items to ✅ Done with strikethrough, add new items in the right column
7. Flag any items that are overdue (past their `@{date}`), and any in-progress items whose `@{date}` is more than a week past. The board format has no per-column timestamps, so date stamps are the only age signal - do not guess column dwell time

---

**AI-first rule:** Board files follow the kanban exception in `references/ai-first-rules.md`: `kanban-plugin` frontmatter, NO `## For future agent` heading (the plugin would render it as a phantom column). Every NON-board note this command creates or updates (task notes, project notes) MUST follow the full rule - preamble, rich frontmatter (`type`, `date`, `tags`, `ai-first: true`), `[[wikilinks]]`, sources verbatim. If that path does not resolve from your working directory, search upward for it; if you still cannot read it, say so before writing rather than producing a note that silently skips the rule.

**Anti-fabrication:** Search exhaustively before claiming any note, person, or file is absent - false absence is the most common failure mode - and never invent facts, entities, or dates (mark unknowns as `TBD`). See the anti-fabrication and search-completeness hard rules in `references/ai-first-rules.md`.
