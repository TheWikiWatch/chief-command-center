---
name: second-brain-writes
description: "The write-gate for the owner's Second Brain (agent-first wiki): load before the first write in a conversation, and follow it for every write, scheduled routines included."
version: 1.1.0
author: Chief Command Center
license: MIT
platforms: [windows, macos, linux]
metadata:
  hermes:
    tags: [second-brain, notes, write-rules, write-gate]
    category: note-taking
    related_skills: [second-brain]
---

# Writing to the Second Brain

The Second Brain is `{{vault}}`. Every write that settles a fact passes the gate below, however small. Reading needs none of it.

## 0. The manual

Read `{{vault}}\{{rules}}` once per conversation, before the first write: the Folder Map, sources, tasks and boards, the write-gate. If it differs from anything here, the manual wins.

## 1. Search before you create

Read `index.md`, then search the folder for an existing page on the same subject, by every plausible name. One canonical page per subject: add to it rather than creating a near-duplicate.

## 2. Source first

An answer the owner gives you (in chat, or in reply to the morning brief) and every new outside claim is saved under `raw/` before the wiki changes: answers to `raw/conversations/YYYY-MM-DD - Title.md` with the reply verbatim. `raw/` is never edited afterwards. Documents an agent writes are not sources: they go in `wiki/`.

## 3. Primary page

Update the page that owns the fact: the entity, project, decision or task. Put each note where the manual's Folder Map says; never invent a folder.

## 4. Fan-out

After changing a number, a date or a claim, search `wiki/` for the **old** value and update every page that still states it. An entity updated while a concept page keeps the old number is an incomplete write.

## 5. Board and task note together

A due date or status changes on the board card (`@{YYYY-MM-DD}`, its column) and in the task note (`due:`, `status:`) in the same write. Done: tick, strike through, `✅ YYYY-MM-DD`, move to `✅ Done`. "I'll do it today" is In Progress, not Done.

## 6. Write it properly

- Properties first: `date`, `type`, `tags` (include the type), `ai-first: true`, plus the type's fields (see `templates/`).
- A `## For future agent` section right after the properties: what the note is, why it exists, what may go stale.
- `[[wikilinks]]` for every person, project, concept and decision; a short stub when the target doesn't exist.
- Dated claims `(as of YYYY-MM-DD)`; sources inline; a changed fact gets a new dated line and the old one is marked superseded.

## 7. Daily, log, index

- Today's daily note (`wiki/daily/YYYY-MM-DD.md`) says what changed, with links.
- `log.md` gets one entry listing **every** path written, `raw/` included.
- `index.md` gets a line for each new page, and its counts stay true.
- A question that still needs the owner goes under "Open for the owner" in `wiki/reviews/Current Analysis.md`; a settled one comes off.

## 8. Ask before big changes

Never delete: archive to `wiki/archive/` or soft-delete to `_trash/`. Moving, renaming or merging more than a couple of notes needs the owner's yes, with the list shown first.

## 9. Verify, then report

Read back every path you claim to have written. Then end with `write-gate: PASS`, or `write-gate: PARTIAL` and exactly what is missing. Tell the owner in one line where things went, with full paths in backticks. Never report success you haven't verified.

## Scheduled routines

Routines follow the same gate, never stop to ask questions, and end by logging what they changed.
