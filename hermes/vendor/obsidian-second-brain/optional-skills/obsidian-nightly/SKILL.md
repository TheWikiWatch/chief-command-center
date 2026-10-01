---
name: obsidian-nightly
description: "Sleeptime consolidation - the vault gets smarter overnight. The cron-native counterpart to the Claude PostCompact maintenance pass. Schedule: daily at 10:00 PM."
version: 0.17.0
author: "Eugeniu Ghelbur"
license: MIT
metadata:
  hermes:
    tags: [obsidian-second-brain, scheduled]
    blueprint:
      schedule: "0 22 * * *"
      deliver: origin
      prompt: "Run the obsidian-nightly scheduled vault maintenance. Follow the procedure below exactly; do not ask questions; save and stop."
      no_agent: false
---

## When to use

Runs on its blueprint schedule (daily at 10:00 PM) once armed. Can also be run on demand. Opt-in: arming is explicit - Hermes blueprints never schedule silently. Arm with `hermes cron create "0 22 * * *" "Run the obsidian-nightly scheduled vault maintenance. Follow the skill procedure exactly; do not ask questions; save and stop." --skill obsidian-nightly --workdir <vault>`, or accept the suggested job from `/suggestions` after a registry `hermes skills install`.

## Procedure

Read `_CLAUDE.md`. This is a sleeptime consolidation pass - the vault should be smarter when the user wakes up.

Phase 1 - Close the day:
- Read today's daily note. Append a ## End of Day section with a 3-5 bullet summary.
- Move any completed kanban tasks to Done.

Phase 2 - Reconcile:
- First resolve the entities, concepts, and decisions folders per `references/folder-map.md` (at the install root,
  `$HOME/.hermes/skills/obsidian-second-brain/references/folder-map.md`): the vault's `_CLAUDE.md` Folder Map wins, else wiki-style
  `wiki/entities/` + `wiki/concepts/` + `wiki/decisions/`, else Obsidian-style `People/` + `Knowledge/` (and `Ideas/`) + `Knowledge/`.
  A resolved folder that does not exist is a skip, not an error. Never scan a hardcoded `wiki/` path on a vault with no `wiki/` folder -
  unattended, that is three tool failures a night with nothing to show for them.
- Scan the entities folder for outdated roles, companies, or descriptions that conflict with newer daily notes.
- Scan the concepts folder for claims contradicted by recently ingested sources.
- Flag EVERY contradiction as a `type: conflict` note with `status: open` in the decisions folder. Do NOT rewrite any existing page -
  resolving a contradiction rewrites the outdated note, which is destructive and irreversible while the user sleeps. Leave that to an
  interactive obsidian-reconcile run.

Phase 3 - Synthesize:
- Scan sources ingested today and yesterday. Find concepts that appear in 2+ unrelated sources.
- If patterns found: create `Synthesis - Title.md` in the concepts folder resolved in Phase 2, with evidence and interpretation.

Phase 4 - Heal:
- Find notes created today with no incoming links. Add links from relevant existing pages.
- Close entity timeline entries missing an "until" date that should be closed.
- Rebuild `index.md` to reflect today's changes.

Phase 5 - Log:
- Append an operation-log entry: if `Logs/` exists write `**HH:MM** - nightly | End of day + X flagged, Y synthesized, Z orphans linked`
  to `Logs/YYYY-MM-DD.md`; otherwise append `## [YYYY-MM-DD] nightly | ...` to `log.md`.

Do not ask questions. Do not fix anything destructive - only add, update, link. Save and stop.
