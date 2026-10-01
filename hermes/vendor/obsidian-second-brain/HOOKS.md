# Hermes: scheduled maintenance and the PostCompact analog

The Claude Code build maintains the vault two ways: opt-in scheduled agents
(`/schedule`) and an opt-in PostCompact hook (`hooks/obsidian-bg-agent.sh`) that
propagates conversation context into the vault after the context is compacted.
This documents the Hermes equivalents.

## Scheduled maintenance (cron) - shipped

The four scheduled agents are emitted as native Hermes blueprint skills under
`optional-skills/`:

| Skill | Schedule | Does |
|---|---|---|
| `obsidian-morning` | `0 8 * * *` | Create today's daily note, surface due/overdue + stale projects |
| `obsidian-nightly` | `0 22 * * *` | Sleeptime consolidation: close day, reconcile, synthesize, heal, log |
| `obsidian-weekly` | `0 18 * * 5` | Generate the weekly review note |
| `obsidian-health-check` | `0 21 * * 0` | Vault health report (report only) |

They live in `optional-skills/` (not `skills/`) on purpose: the scheduled
agents are opt-in by design, so INSTALL.md's bulk `skills/` copy never ships
them implicitly. Installing a skill does not schedule anything - a Hermes
blueprint never arms silently. Copy them into `~/.hermes/skills/` like any
other skill (see INSTALL.md), then arm each schedule explicitly:

```bash
hermes cron create "0 22 * * *" "Run the obsidian-nightly scheduled vault maintenance. Follow the skill procedure exactly; do not ask questions; save and stop." --skill obsidian-nightly --name obsidian-nightly --workdir /path/to/vault
```

(A registry `hermes skills install` instead registers the blueprint as a
suggested cron job you accept from `/suggestions`.) Verify with
`hermes cron list`; run outputs land in `~/.hermes/cron/output/<job_id>/`.
None of them delete or archive - they only add, update, link.

## PostCompact analog (lifecycle hook) - shipped

The Claude PostCompact hook fires on context compaction to propagate the session
into the vault. Hermes's analog is the `on_session_end` event hook (declared
under the `hooks:` block of `~/.hermes/config.yaml`). This build ships it:

- **`hooks/obsidian-hermes-session-end.sh`** - an `on_session_end` hook that, on
  a completed (non-interrupted) session, runs the `obsidian-nightly`
  consolidation pass and prints `{}` (the observer-hook contract). It mirrors the
  Claude bg-agent's trust model exactly: OPT-IN, ships INERT, no-ops unless BOTH
  `OBSIDIAN_VAULT_PATH` and `OBSIDIAN_HERMES_HOOK_ENABLED=1` are set; add/update
  /link only, never delete or archive.
- **`hooks/hermes-hooks.config.example.yaml`** - the paste-in
  `hooks:` block for `~/.hermes/config.yaml` registering the hook.

Install:

```bash
mkdir -p ~/.hermes/agent-hooks
cp hooks/obsidian-hermes-session-end.sh ~/.hermes/agent-hooks/
chmod +x ~/.hermes/agent-hooks/obsidian-hermes-session-end.sh
# merge hooks/hermes-hooks.config.example.yaml into your ~/.hermes/config.yaml,
# then: export OBSIDIAN_VAULT_PATH=... OBSIDIAN_HERMES_HOOK_ENABLED=1
```

The consolidation runs headlessly via `hermes -z` (one-shot mode: prompt passed
as the argument, only the final response printed). Override the command with
`OBSIDIAN_HERMES_CONSOLIDATE_CMD` if your build differs; the script appends the
prompt as the command's final argument. The `obsidian-nightly` cron job covers
the same maintenance on a daily cadence regardless.
