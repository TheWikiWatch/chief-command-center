---
name: obsidian-log
description: "Log this work or dev session to the vault - infers project from context Triggers: log this work, log this session, log this dev session, obsidian log. Use proactively: trigger this whenever the conversation produces something worth capturing, without waiting to be asked."
version: 0.17.0
author: "Eugeniu Ghelbur"
license: MIT
metadata:
  hermes:
    tags: [obsidian-second-brain, vault]
---

## When to use

When the user's request matches any of: log this work, log this session, log this dev session, obsidian log.

## Procedure


Use the obsidian-second-brain skill. Execute `/obsidian-log`:

1. Read `_CLAUDE.md` first if it exists in the vault root
2. Infer the project from conversation context - search the vault if needed to find the right project note
3. Read `Templates/Dev Log.md` (or `Templates/Work Log.md`) if either exists; if neither does, write the sections directly: Context, What changed, Decisions, Next steps
4. Fill in: date, project, what was worked on, problems encountered, decisions made, next steps - all inferred from the conversation
5. Save to the dev-log folder resolved per `references/folder-map.md` (read the vault's `_CLAUDE.md` Folder Map first; wiki-style `wiki/logs/`, Obsidian-style `Dev Logs/`), named `YYYY-MM-DD - Project Name.md`
6. Inject a link into the project note's Recent Activity section
7. Inject a link into today's daily note Work section

---

**AI-first rule:** Every note created or updated by this command MUST follow `references/ai-first-rules.md` - `## For future agent` preamble, rich frontmatter (`type`, `date`, `tags`, `ai-first: true`, plus type-specific fields), recency markers per external claim, mandatory `[[wikilinks]]` for every person/project/concept referenced, sources preserved verbatim with URLs inline, and confidence levels where applicable. If that path does not resolve from your working directory, search upward for it; if you still cannot read it, say so before writing rather than producing a note that silently skips the rule. The vault is for future agent retrieval - not human reading.

**Anti-fabrication:** Search exhaustively before claiming any note, person, or file is absent - false absence is the most common failure mode - and never invent facts, entities, or dates (mark unknowns as `TBD`). See the anti-fabrication and search-completeness hard rules in `references/ai-first-rules.md`.
