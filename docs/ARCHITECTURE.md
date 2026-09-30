# Architecture

## Processes

The desktop app (Electron main process) is the only supervisor. It starts and watches:

| Process | What it runs | Lifetime |
| --- | --- | --- |
| Window | A BrowserWindow on `http://127.0.0.1:<ui port>` (a loopback client) | Closing it hides to the tray |
| Web server | The Next.js standalone server (`apps/web`), under Electron's Node | While the app runs |
| Chief gateway | `hermes -p chief gateway run` from the bundled payload, with this repo's plugins | In the background until Quit (cron jobs and phone alerts depend on it) |

The browser UI never sees a credential. The web server holds the bridge token in its environment and proxies `/api/bridge/*` to the gateway's loopback bridge (`hermes/plugins/chief-dashboard-bridge`).

## Data

| Where | What |
| --- | --- |
| The installed package (read-only) | Electron, the web server build, the Hermes payload (pinned upstream commit + patch queue), plugins |
| `%LOCALAPPDATA%\ChiefCommandCenter\hermes` | Chief's home (`HERMES_HOME`): each bot's SOUL, memory, skills, routines, chat history, config and API keys |
| `%LOCALAPPDATA%\ChiefCommandCenter\app` | App settings, logs, the downloaded speech model |
| The Second Brain folder (the user's choice) | Notes, tasks, the knowledge wiki |
| A backup folder (the user's choice) | `.chiefbackup` files |

Nothing personal is ever in this repository or the installer.

## Hermes: pinned, patched, app-owned

`hermes/pin.json` names the upstream commit; `hermes/patches` holds the few local patches, each with its reason and upstream status. `packaging/payload` builds the runtime with upstream's own native bundle builder, selecting only the tools and Python extras the app needs, and writes an install stamp that makes the app the payload's steward: `hermes update` refuses to modify it. Updates reach users only through app releases, after the compatibility suite passes on the new pin.

Isolation from other Hermes installs on the same PC:

- `HERMES_HOME` is always set explicitly for app processes (a machine-wide `HERMES_HOME` from an older installer is never inherited).
- New installs use their own `HERMES_GATEWAY_LOCK_DIR`, because Hermes allows one gateway per lock directory ("one per host").
- An existing install that is adopted in place keeps the shared lock directory, so an old launcher can never start a second gateway beside the app's.

## Configuration

The web server reads only its environment (`apps/web/lib/server/app-config.ts`); the plugin reads the chief profile's environment (`hermes/plugins/chief-dashboard-bridge/README.md`). Optional integrations are off unless configured:

- Today can read an Ops-compatible task service (`CHIEF_OPS_URL`) or, by default, the Second Brain folder.
- Fleet Health can read a learning ledger's report (`CHIEF_LEARNING_DIR`).
- Phone access uses Tailscale Serve when the user sets it up.

## Phone alerts

The bridge implements Web Push itself (`webpush.py`: RFC 8291 encryption, RFC 8292 VAPID) on the `cryptography` package Hermes already ships, so alerts need no extra dependency or interpreter.
