# Install on Hermes Agent

The obsidian-second-brain commands are emitted here as native Hermes skills
under `skills/<category>/<name>/SKILL.md` (agentskills.io-compatible).

`hermes plugins install <repo-url>` does not work for this repo: its root is
not a Hermes plugin (no `plugin.yaml`), and Hermes reports success while
registering nothing (#298). Use one of the options below instead.

## Option A - install from this built tree

```bash
# From the repo root, after `bash scripts/build.sh --platform hermes`:
mkdir -p ~/.hermes/skills/obsidian-second-brain
cp -R dist/hermes/skills/. ~/.hermes/skills/obsidian-second-brain/
# Shared specs + Python helpers the skills reference:
cp -R dist/hermes/references ~/.hermes/skills/obsidian-second-brain/references
cp -R dist/hermes/scripts    ~/.hermes/skills/obsidian-second-brain/scripts
```

## Option B - add as a tap (when published to a skills repo)

```bash
hermes skills tap add <owner>/<repo>
```

Then in Hermes:

- Browse with `hermes skills browse` / the `/skills` command, or just describe
  the task and let Hermes select a skill from its description.
- Skills run in your Hermes session. The AI-first vault rule lives in
  `references/ai-first-rules.md` - it is non-negotiable for every note a skill
  writes (`## For future agent` preamble, rich frontmatter, `[[wikilinks]]`,
  recency markers, sources verbatim, confidence levels). That path is relative
  to the install root, which is load-bearing: start Hermes elsewhere and it does
  not resolve. A skill that cannot read it must search upward for it, and say so
  before writing if it still cannot - the requirements in parentheses are the
  floor either way.
- Python helpers under `scripts/` run via
  `uv run --directory ~/.hermes/skills/obsidian-second-brain -m scripts.research.<name>`.
  The install root ships a `pyproject.toml`, so modules and dependencies both
  resolve there. Name it explicitly rather than relying on the working
  directory: Hermes is pointed at your *vault* as the working directory (and a
  cron job is armed with `--workdir <vault>`), so a bare `uv run -m scripts.X`
  looks for `scripts/` inside the vault and fails with `No module named
  'scripts'`.

## Scheduled agents (opt-in)

The four scheduled maintenance agents are emitted as native Hermes blueprint
skills under `optional-skills/` (morning / nightly / weekly / health-check).
They are NOT auto-armed - a Hermes blueprint never schedules anything silently.
Install them like any other skill, then arm each schedule explicitly:

```bash
# skills land in ~/.hermes/skills/ (Hermes discovers <category>/<name>/SKILL.md)
cp -R dist/hermes/optional-skills/. ~/.hermes/skills/obsidian-second-brain/
# arm the 10pm consolidation pass (repeat per agent - schedules in HOOKS.md)
hermes cron create "0 22 * * *" "Run the obsidian-nightly scheduled vault maintenance. Follow the skill procedure exactly; do not ask questions; save and stop." --skill obsidian-nightly --name obsidian-nightly --workdir /path/to/vault
```

Verify with `hermes cron list`. (When installed from a registry or URL via
`hermes skills install`, the blueprint is instead registered as a suggested
cron job you accept from `/suggestions` - a local built tree has no
installable identifier, so the cp + `hermes cron create` route above is the
default.)

See `HOOKS.md` for the full schedule table and the PostCompact-analog story.

Point Hermes at your vault as the working directory, or pair these skills with
the MCP connector (`integrations/obsidian-mcp-server/`) for bounded vault data
access.
