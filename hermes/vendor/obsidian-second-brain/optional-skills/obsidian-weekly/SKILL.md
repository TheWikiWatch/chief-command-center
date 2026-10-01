---
name: obsidian-weekly
description: "Generate a weekly review note from the vault. Runs unattended on schedule. Schedule: every Friday at 6:00 PM."
version: 0.17.0
author: "Eugeniu Ghelbur"
license: MIT
metadata:
  hermes:
    tags: [obsidian-second-brain, scheduled]
    blueprint:
      schedule: "0 18 * * 5"
      deliver: origin
      prompt: "Run the obsidian-weekly scheduled vault maintenance. Follow the procedure below exactly; do not ask questions; save and stop."
      no_agent: false
---

## When to use

Runs on its blueprint schedule (every Friday at 6:00 PM) once armed. Can also be run on demand. Opt-in: arming is explicit - Hermes blueprints never schedule silently. Arm with `hermes cron create "0 18 * * 5" "Run the obsidian-weekly scheduled vault maintenance. Follow the skill procedure exactly; do not ask questions; save and stop." --skill obsidian-weekly --workdir <vault>`, or accept the suggested job from `/suggestions` after a registry `hermes skills install`.

## Procedure

Read `_CLAUDE.md`. Run the obsidian-recap skill for the week to gather this week's activity.
Generate a weekly review note using the Review template (or standard structure if none exists).
Save to `Reviews/YYYY-MM-DD - Weekly Review.md`.
Link it from this week's last daily note.
Do not ask questions. Save and stop.
