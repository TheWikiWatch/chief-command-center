---
name: second-brain-writes
description: "The write gate for the owner's Second Brain: load before the first write in a conversation, and follow it for every write, scheduled routines included."
version: 1.0.0
author: Chief Command Center
license: MIT
platforms: [windows, macos, linux]
metadata:
  hermes:
    tags: [second-brain, notes, write-rules]
    category: note-taking
    related_skills: [second-brain]
---

# Writing to the Second Brain

The Second Brain is `{{vault}}`. Every write follows these steps, however small it is. Reading needs none of them.

## 1. Rules

Read `{{vault}}\AGENTS.md` once per conversation, before the first write: the Folder Map, "Notes agents write", Tasks and Properties. If the owner has changed it, their version wins over anything here.

## 2. Search before you create

Look in `index.md` and search the folder for an existing note on the same thing. Prefer adding to it over creating a near-duplicate.

## 3. The right place

Put the note where the Folder Map in `AGENTS.md` says. Never invent a folder; if a kind of note isn't listed, ask. Anything with no obvious home goes to `00 Inbox/`.

## 4. Write it properly

- Properties first: `date`, `type`, `tags` (include the type) and `ai-first: true`, plus the type's own fields from `AGENTS.md`.
- A `## For future agent` section right after the properties: what the note is, why it was saved, what may go stale.
- `[[wikilinks]]` for every person, project, idea and decision. Create a short stub when the linked note doesn't exist.
- Facts that change carry `(as of YYYY-MM-DD)`; sources keep their full URL. A changed fact gets a new dated line and the old one is marked superseded, never silently overwritten.
- Tasks use the exact syntax in `AGENTS.md` (`- [ ] … 📅 YYYY-MM-DD`; done: `- [x] … ✅ YYYY-MM-DD`). The app's Today tab reads them straight from the files.

## 5. Ask before big changes

Never delete a note: archive it to `90 Archive/`. Moving, renaming or merging more than a couple of notes needs the owner's yes, with the list of changes shown first.

## 6. Log it

Append one line per change to `{{vault}}\log.md`: `YYYY-MM-DD — what changed — where`. Add a line to `index.md` for a new note worth finding again.

## 7. Verify, then report

Read back what you wrote. Check that the change is there, the properties parse and the links point at real notes. Then tell the owner in one line where it went, with the full path in backticks.

A fact settled in conversation but never written is a failed write: write it, or say plainly that you didn't and why.

## Scheduled routines

Routines that run on a schedule follow the same steps, never stop to ask questions, and end by logging what they changed.
