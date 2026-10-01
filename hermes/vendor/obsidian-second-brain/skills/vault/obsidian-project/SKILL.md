---
name: obsidian-project
description: "Create or update a project note - adds to board and daily note automatically Triggers: new project, create project note, project setup, start a project. Use only when the user explicitly asks for it."
version: 0.17.0
author: "Eugeniu Ghelbur"
license: MIT
metadata:
  hermes:
    tags: [obsidian-second-brain, vault]
---

## When to use

When the user's request matches any of: new project, create project note, project setup, start a project.

## Procedure


Use the obsidian-second-brain skill. Execute `/obsidian-project $ARGUMENTS`:

The argument is a project name. Handle typos and partial matches.

1. Read `_CLAUDE.md` first if it exists in the vault root
2. Search the vault for an existing project matching the name (fuzzy - handle typos)
3. If found: show what was found, confirm with user, then update with new info from conversation
4. If not found: create `Project Name.md` in the projects folder (resolved per `references/folder-map.md` - wiki-style `wiki/projects/`, Obsidian-style `Projects/`) with the full `type: project` schema from `references/ai-first-rules.md` (`type: project`, `date`, `updated`, `status: active`, `tags: [project]`, `related-people`, `related-projects`, optional `job`, `ai-first: true`)
5. Fill in everything inferable from the conversation: description, goals, key people, current status
6. Add a card to the relevant kanban board in the `📥 Backlog` or `🔨 In Progress` column
7. Link from today's daily note

If the name has a typo or is approximate, search the vault, show what was found, and confirm before proceeding. Never silently create a note with a misspelled name.

---

**AI-first rule:** Every note created or updated by this command MUST follow `references/ai-first-rules.md` - `## For future agent` preamble, rich frontmatter (`type`, `date`, `tags`, `ai-first: true`, plus type-specific fields), recency markers per external claim, mandatory `[[wikilinks]]` for every person/project/concept referenced, sources preserved verbatim with URLs inline, and confidence levels where applicable. If that path does not resolve from your working directory, search upward for it; if you still cannot read it, say so before writing rather than producing a note that silently skips the rule. The vault is for future agent retrieval - not human reading.

**Anti-fabrication:** Search exhaustively before claiming any note, person, or file is absent - false absence is the most common failure mode - and never invent facts, entities, or dates (mark unknowns as `TBD`). See the anti-fabrication and search-completeness hard rules in `references/ai-first-rules.md`.
