---
name: obsidian-morning
description: "Create today's daily note and surface what needs attention. Runs unattended on schedule. Schedule: daily at 8:00 AM."
version: 0.17.0
author: "Eugeniu Ghelbur"
license: MIT
metadata:
  hermes:
    tags: [obsidian-second-brain, scheduled]
    blueprint:
      schedule: "0 8 * * *"
      deliver: origin
      prompt: "Run the obsidian-morning scheduled vault maintenance. Follow the procedure below exactly; do not ask questions; save and stop."
      no_agent: false
---

## When to use

Runs on its blueprint schedule (daily at 8:00 AM) once armed. Can also be run on demand. Opt-in: arming is explicit - Hermes blueprints never schedule silently. Arm with `hermes cron create "0 8 * * *" "Run the obsidian-morning scheduled vault maintenance. Follow the skill procedure exactly; do not ask questions; save and stop." --skill obsidian-morning --workdir <vault>`, or accept the suggested job from `/suggestions` after a registry `hermes skills install`.

## Procedure

Read `_CLAUDE.md`. Create today's daily note in `Daily/` using the Daily Note template.
Pull in any tasks from kanban boards that are due today or overdue.
List any projects with status active that have no recent activity in the last 7 days.
Do not ask questions - infer everything from the vault. Save and stop.
