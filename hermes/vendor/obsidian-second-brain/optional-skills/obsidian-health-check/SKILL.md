---
name: obsidian-health-check
description: "Run the vault health check and log a report (report only, never auto-fixes). Schedule: every Sunday at 9:00 PM."
version: 0.17.0
author: "Eugeniu Ghelbur"
license: MIT
metadata:
  hermes:
    tags: [obsidian-second-brain, scheduled]
    blueprint:
      schedule: "0 21 * * 0"
      deliver: origin
      prompt: "Run the obsidian-health-check scheduled vault maintenance. Follow the procedure below exactly; do not ask questions; save and stop."
      no_agent: false
---

## When to use

Runs on its blueprint schedule (every Sunday at 9:00 PM) once armed. Can also be run on demand. Opt-in: arming is explicit - Hermes blueprints never schedule silently. Arm with `hermes cron create "0 21 * * 0" "Run the obsidian-health-check scheduled vault maintenance. Follow the skill procedure exactly; do not ask questions; save and stop." --skill obsidian-health-check --workdir <vault>`, or accept the suggested job from `/suggestions` after a registry `hermes skills install`.

## Procedure

Read `_CLAUDE.md`. Run: `uv run --directory $HOME/.hermes/skills/obsidian-second-brain scripts/vault_health.py --path <vault> --json`
(the `--directory` is load-bearing: a cron job is armed with `--workdir <vault>`, so the working directory is the vault and a bare
`uv run -m scripts.vault_health` cannot see `scripts/` at all. Substitute the real install root if the tree lives elsewhere.)
Parse the output. Write the health report to the concepts folder resolved per `references/folder-map.md`
(wiki-style `wiki/concepts/`, Obsidian-style `Knowledge/`) as `Vault Health YYYY-MM-DD.md`,
summarizing findings by severity (critical, warning, info).
Do not fix anything autonomously - only report.
Do not ask questions. Save and stop.
