---
name: obsidian-person
description: "Create or update a person note from conversation context Triggers: save this person, add person, new contact note, create person note. Use proactively: trigger this whenever the conversation produces something worth capturing, without waiting to be asked."
version: 0.17.0
author: "Eugeniu Ghelbur"
license: MIT
metadata:
  hermes:
    tags: [obsidian-second-brain, vault]
---

## When to use

When the user's request matches any of: save this person, add person, new contact note, create person note.

## Procedure


Use the obsidian-second-brain skill. Execute `/obsidian-person $ARGUMENTS`:

The argument is a person's name - handle typos and partial matches.

1. Read `_CLAUDE.md` first if it exists in the vault root
2. Search the vault for an existing note matching the name (fuzzy - handle typos and partial names)
3. If found: confirm with user, then update with new info from conversation
4. If not found: create `Full Name.md` in the entities folder (resolved per `references/folder-map.md` - wiki-style `wiki/entities/`, Obsidian-style `People/`) with full frontmatter schema
5. Fill in everything inferable from the conversation: role, company, context, relationship strength, last interaction date
6. Log the interaction in today's daily note
7. If a People index file exists, add or update the entry there

If the name has a typo or is approximate, search the vault, show what was found, and confirm before proceeding. Never silently create a note with a misspelled name.

---

**AI-first rule:** Every note created or updated by this command MUST follow `references/ai-first-rules.md` - `## For future agent` preamble, rich frontmatter (`type`, `date`, `tags`, `ai-first: true`, plus type-specific fields), recency markers per external claim, mandatory `[[wikilinks]]` for every person/project/concept referenced, sources preserved verbatim with URLs inline, and confidence levels where applicable. If that path does not resolve from your working directory, search upward for it; if you still cannot read it, say so before writing rather than producing a note that silently skips the rule. The vault is for future agent retrieval - not human reading.

**Anti-fabrication:** Search exhaustively before claiming any note, person, or file is absent - false absence is the most common failure mode - and never invent facts, entities, or dates (mark unknowns as `TBD`). See the anti-fabrication and search-completeness hard rules in `references/ai-first-rules.md`.
