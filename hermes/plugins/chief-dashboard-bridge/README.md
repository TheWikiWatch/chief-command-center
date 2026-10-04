# chief-dashboard-bridge

The Hermes plugin behind Chief Command Center. It runs inside the chief profile's gateway (`hermes -p chief gateway run`) and:

- registers the **Command Center** messaging platform, the app's chat, as a first-class Hermes platform (session identity, typing, outbox, cron delivery with `deliver: command_center`);
- serves a **loopback HTTP API** for the app's server: roster, kanban work, transcript, approvals, voice, settings, files and phone alerts;
- sends **phone alerts** (Web Push) for replies, approvals and optional fleet flags;
- gives each of the chief's new conversations the owner's `CRITICAL_FACTS.md` from the Second Brain (a system prompt section, `chief-critical-facts`, read when the conversation starts). This one runs in every chief process (gateway, scheduled jobs, terminal), not only where the API binds.

It has no tools, no model and no SOUL. It binds **127.0.0.1 only**; never expose its port.

## When it binds

- argv contains `gateway run` (it always skips `hermes serve`);
- the gateway's `HERMES_HOME` is `<root>/profiles/chief`;
- a bearer token is configured (otherwise it refuses to bind).

The socket is exclusive (`SO_EXCLUSIVEADDRUSE` on Windows), so two processes can never share the port.

## Configuration

Token, in order: plugin config `token`, `CHIEF_DASHBOARD_TOKEN`, or a `.token` file next to the plugin (never committed). The app's server sends the same value as `Authorization: Bearer …`. The plugin removes `CHIEF_DASHBOARD_TOKEN` from the gateway's environment once it has read it (`bridge_token.py`): Hermes builds each child's environment from it, and its secret scrub doesn't know the name, so the agent's own commands would otherwise inherit the token.

| Setting | Default | Meaning |
| --- | --- | --- |
| `port` / `CHIEF_DASHBOARD_PORT` | `7790` | Loopback port |
| `session_key` / `CHIEF_DASHBOARD_SESSION_KEY` | empty | Force a session key (a Command Center DM is preferred) |
| `COMMAND_CENTER_HOME_CHANNEL` | `owner` | The owner's chat id; part of the session key `agent:main:command_center:dm:<id>` |
| `CHIEF_OWNER_NAME` | empty | How the chief sees the owner |
| `CHIEF_PUSH_CONTACT` | project URL | VAPID contact (`mailto:` or `https:`) |
| `CHIEF_FILE_ROOTS` | none | Extra folders `/file` may serve, separated by `;` |
| `CHIEF_ROSTER_FILE` | none | Optional Markdown roster table with per-bot status notes |
| `CHIEF_LEARNING_DIR` | none | Optional learning-ledger folder; new flags in its `report.json` become phone alerts |

The chief's display name (in alerts and messages) comes from its profile title (`ui_meta.hermes-bots.title`, "Name - Role"), falling back to "Chief".

## Endpoints

All require `Authorization: Bearer …` (a `?token=` query is not accepted). Loopback clients only. POST/PATCH bodies must be a JSON object; a cut-off or invalid body gets 400.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | `{ ok, gateway, voice, profile: "chief", longpoll }`: cheap liveness. Any other `profile` is an impostor. |
| GET | `/snapshot` | Roster, sections, binding, live work rings, pending approval, `generating` |
| GET | `/approvals` | Pending exec-approval card (`once` / `session` / `always` / `deny`) |
| GET | `/transcript?after=` | Messages and attachments, plus `generating`, the pending `approval` and `longpoll: true`. `&wait=N&gen=0\|1&approval=<id>` (N ≤ 25) holds the request until something changes (see Long-poll). `?before=<id>` is Load earlier, archived history included, with `more` and `cursor`. |
| POST | `/send` | `{ text, attachments?, client_id? }` queues a user turn. A repeated `client_id` within 24 hours returns `{ ok, duplicate: true }` without a second turn. |
| POST | `/transcribe` | `{ data_url, mime_type }` → Hermes STT: `{ ok, transcript, provider }`. Never touches the conversation. With local STT and no model on disk it answers `code: model_missing` instead of letting Hermes download one. |
| POST | `/speak` | `{ text }` → Hermes TTS: `{ ok, data_url, mime_type, provider }` |
| GET | `/voice-config`, `/settings` | STT/TTS catalog and current choice (never keys) |
| PATCH | `/settings` | `{ stt?, tts?, secrets? }` writes the chief's `config.yaml` / `.env`. Keys are never returned. |
| POST | `/approve` | `{ request_id, choice }` resolves the gateway's approval queue |
| GET | `/file?path=`, `/thumb`, `/preview` | Allow-listed file bytes (Range for A/V), video thumbnails and light previews |
| GET | `/profile/{id}`, `/avatar/{id}` | A bot's profile (soul, memory, tools, job) and photo avatar |
| GET | `/push/vapidPublicKey`, `/push/subscriptions` | Phone-alert key (created on first use) and subscribed-device count |
| POST | `/push/subscribe`, `/push/unsubscribe`, `/push/test` | Manage this device's subscription; `/push/test` sends one alert |
| GET | `/setup/status`, `/setup/providers`, `/setup/models?provider=` | Model connection (`providers.py`, contract `chief.providers.v1`): readiness, Hermes's provider catalog, a provider's models |
| POST | `/setup/key`, `/setup/model`, `/setup/endpoint/check`, `/setup/endpoint/save`, `/setup/test` | Save a key (never echoed), choose a model (expensive-model guard), probe and save a custom/local endpoint, one test completion |
| GET | `/setup/second-brain` | The Second Brain (`second_brain.py`, contract `chief.second_brain.v1`): folder, mode, skill installed, the default `Documents\Second Brain` |
| POST | `/setup/second-brain/inspect` | `{ path }` → what the folder holds and exactly what each setup choice would create. Writes nothing. |
| POST | `/setup/second-brain` | `{ path, mode: new \| keep \| reorganize }` writes the template create-only, sets `OBSIDIAN_VAULT_PATH` / `WIKI_PATH` in the profile `.env` and installs the `second-brain` skill |
| GET | `/voice/model` | The on-device speech model (`speech_model.py`, contract `chief.speech_model.v1`): models with sizes, installed or not, the running download, and whether voice typing is ready without a download |
| POST | `/voice/model/download`, `/voice/model/cancel`, `/voice/model/delete` | `{ id }` starts a resumable, checksum-verified download (then points `stt.local.model` at it); cancel keeps the partial file; delete removes the folder |
| POST | `/setup/soul/seed` | Replaces an untouched stock Hermes SOUL with Chief's default (history kept); an edited SOUL is never touched |
| GET | `/persona?profile=`, `/persona/soul/version?profile=&id=` | SOUL, memory and user profile for editing (`persona.py`, contract `chief.persona.v1`); an older SOUL version |
| POST | `/persona/soul`, `/persona/soul/restore`, `/persona/memory` | Save SOUL against the hash it was read at, restore a version, apply a pinned memory batch |

### Long-poll

`/transcript?after=X&wait=25&gen=…&approval=…` checks the newest row id, the generating state and the pending approval every 0.5 s. It answers as soon as one differs from what the caller knows, or after `wait` seconds. An empty conversation (`after=0`, no rows yet) holds until the first row lands. Each held request holds one bridge thread; `binding()` is cached for 2 s.

### History and compaction

Hermes archives the session at each context compaction (rows go `active = 0`) and re-inserts the kept tail after a `[CONTEXT COMPACTION` marker. `?after=` flags the latest block of copies `replay` (never shown or spoken as new). `?before=` also reads archived rows, flags every compaction's copies, and its `cursor` moves past rows it filtered.

### Phone alerts

`push.py` sends replies (not kanban, system or compaction notes), each new pending approval (high urgency) and optional fleet flags as plain text with a `tag` (a newer alert of a kind replaces the last) and `open` (where a tap leads). Sends run on one worker thread, never on the gateway's event loop, with a 1-hour `ttl` (so a sleeping phone still gets them), a 10 s timeout and a `Topic`.

`webpush.py` implements message encryption (RFC 8291, `aes128gcm`) and VAPID (RFC 8292) with the `cryptography` package Hermes already ships. It is tested against the RFC 8291 example. `vapid.py` keeps the key pair and subscriptions in the chief profile (`command_center_vapid.json`, `command_center_push_subscriptions.json`).

### Work rings and generating

`working` is an open kanban `task_runs` row with a **live** `worker_pid` and a heartbeat younger than one hour. The plugin never writes `kanban.db`. `generating` is true while the session is in the platform adapter's active sessions, so the app keeps its thinking state until the turn really ends.

### `/file` allowlist

Allowed roots: the user's Documents (including a redirected one), Downloads, Pictures and Desktop, the Hermes home, the Second Brain (`OBSIDIAN_VAULT_PATH`), `CHIEF_FILE_ROOTS`, and paths that appeared in recent messages. Denied everywhere: `.env*`, `auth.json`, `credentials.json`, `.netrc`, `.token`, key material (`.pem`, `.key`, `.p12`, `.pfx`, `.kdbx`, `.ssh`, `.gnupg`), SQLite files and their side files, and NTFS stream paths. The app's server applies the same path checks first.

### Approval payload

`GET /approvals` and `snapshot.approval`: `{ requestId, command, reason, patternKey, allowPermanent, allowSession }`. Command text is never logged.
