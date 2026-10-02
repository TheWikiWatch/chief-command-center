# Chief Command Center

One Windows app that gives you a chief of staff: a [Hermes](https://github.com/NousResearch/hermes-agent) agent as the engine, and a fast, living dashboard as the interface. You chat with your chief (typed or by voice), it works through your Second Brain and your tasks, it can run a team of specialist agents, and it learns: its skills, memory and routines improve as you use it.

> Status: in development, not released yet. Windows 11 first.

## What it does

- **Chat** with your chief: attachments and media previews, drafts, an offline outbox that never sends twice, and history across context compactions.
- **Approvals**: the chief asks before running commands. Allow once, for this session, always (press and hold), or deny.
- **Voice**: hold to talk, spoken replies, full-screen voice mode. Free Microsoft Edge voices by default; local and keyed engines in Settings.
- **Second Brain**: a Markdown notes folder (Obsidian-compatible) set up in onboarding, with Today's tasks and a Vault browser.
- **Fleet**: every specialist agent your chief creates appears with its own animated face and live status.
- **Phone**: optional private access from your phone over Tailscale, with phone alerts for replies and approvals.
- **Yours**: your data stays on your PC. SOUL, memory, skills, routines and notes live in your own folders, and backups are one click.

## Repository layout

| Path | What |
| --- | --- |
| `apps/web` | The dashboard: Next.js app with server routes (bridge proxy, vault, config) |
| `apps/desktop` | The Windows shell: Electron, supervises the app's server and the Hermes gateway (in progress) |
| `hermes/plugins/chief-dashboard-bridge` | Hermes plugin: the Command Center chat platform and the app's loopback API |
| `hermes/plugins/voicestudio-tts` | Optional plugin for a local VoiceStudio voice engine (installed separately) |
| `hermes/pin.json`, `hermes/patches` | The exact upstream Hermes commit the app ships, and the small patch queue on top |
| `packaging/payload` | Builds the bundled Hermes runtime (Python, dependencies, tools) with upstream's own builder |
| `scripts/privacy-scan.mjs` | Fails if published files contain personal data |
| `docs` | Architecture, design system, fragile seams |

## Develop

Requirements: Windows 11, Node 22+, Python 3.13+ (3.14 for building the Hermes payload), Git.

```powershell
npm ci; npm --prefix apps/web ci; npm --prefix apps/desktop ci
python -m pip install -r requirements-dev.txt
npm run check          # web and desktop typecheck + tests, Python lint (Ruff, pyright) + tests, privacy scan
npm --prefix apps/web run dev   # http://127.0.0.1:3100
```

The web server reads its configuration from the environment (`apps/web/.env.local` in development). See `apps/web/lib/server/app-config.ts` for every variable. Nothing has a personal default: optional integrations are off until configured.

Build the Hermes runtime payload (downloads pinned Python, Node, Git, ffmpeg and Python packages into the output folder):

```powershell
python packaging/payload/prepare_source.py --dest ..\build\hermes-src
python packaging/payload/stage.py --hermes-src ..\build\hermes-src --out ..\build\payload --cache ..\build\uv-cache
```

## Privacy

Before every commit and in CI, `npm run privacy` scans what would be published for e-mail addresses, home-folder paths, tokens and a private word list (`.privacy-denylist`, never committed). Tests use synthetic data only.

## License

MIT. Hermes Agent is MIT-licensed by Nous Research. Third-party components keep their own licenses.
