# Plan: seven features from Hermes 0.22.0

Status: **in progress** (2026-10-18). The owner picked the top seven of the 0.22.0 review. Decisions: local models
go in a folder the owner chooses (default on E: on the owner's PC); Chief may change the accent and light/dark/system
mode; everything ships in **one early release at the end**, then a promote after use.

Findings come from reading Hermes 0.22.0 (`E:\ChiefBuild\hermes-src-0.22.0`) and our code; paths below are Hermes's
unless they start with `hermes/plugins/` or `apps/`.

## 0. Fixes found on the way (first)

- **Connections create a Nous guest identity just by opening the page.** In 0.22, `managed_client()` calls
  `ensure_guest_identity()`, and our `_quick_status` runs it on every overview. Status reads go through a path that
  never creates one (`portal_accounts()` only when an identity exists, else "not signed in"); a guest is made only by
  an explicit connect, with `initiator=DESKTOP_PAGE`.
- **A bot's routine could send its failure alerts outside the app without asking.** `routines.approval_for` checks
  `deliver` but not the new `failure_deliver`; it now applies `destination()` to both.
- **Asana's direct (MCP) route needs a developer app** (`ASANA_CLIENT_ID/SECRET`): offered only through the hosted
  connector.

## 1. Model picker that knows your plans

Hermes's `build_model_options_payload` (already called by `providers.catalog`) carries `capabilities` (reasoning,
fast), `usage` (windows with `used_percent`, `resets_at`) and `limit` (when a rate limit lifts); our `_row()` drops them.

- Bridge: pass `capabilities`, `usage`, `limit` through; reasoning levels per model from
  `agent.reasoning_effort.route_supported_efforts` (fallback `EFFORT_LADDER`), labels from `effort_display_label`.
- Effort: global `agent.reasoning_effort`, per model `agent.reasoning_overrides[model]` (written with load/save_config;
  dotted keys). Bots: the same keys in the bot's own config.
- Favourites: Hermes keeps them only in its desktop's browser storage, so the bridge stores them
  (`<chief home>/chief_model_favorites.json`, `provider::model`).
- Usage cache warms in the background (`refresh_account_usage_async`); the picker shows what's cached.
- UI: one `ModelPicker` for Settings → Models and a bot's drawer: favourites first (star), effort control when the
  model reasons, chip "17% left · resets 3:00 PM" (shown under 20%, amber under 10%), "rate limited until …".

## 2. See, steer and stop each helper

`tools.delegate_tool_registry` holds live children (`_active_subagents`: goal, started_at, tool_count, last_tool,
delegation_id, owner_agent_session_id, agent._live_transcript_path); `steer_subagent(id, text)` and
`interrupt_subagent(id)` act on one child; stopped children hand back partial work by themselves.

- Bridge: `chat_state.background` joins each unit's tasks to their live child (by `delegation_id`, or the unit id's
  `-k` prefix), adding `subagentId`, `startedAt`, `toolCount`, `acceptingSteer`. New routes `GET /background/tail`
  (last ~16 KB of the child's live log, redacted by Hermes), `POST /background/steer`, `POST /background/stop`; every
  one checks the child belongs to this chat's session.
- UI: each task in Background work expands to its live transcript, with Steer (a short message) and Stop.

## 3. Connected apps: more apps, several accounts each

Portal client: `catalog()` (the app directory with logos and categories), `list_accounts()`,
`rename_account(id, alias)`, `delete_account(id)`; connect a named account with
`account.find_or_start_operation(names, action=, alias=, repair_id=, initiator=DESKTOP_PAGE)`; names match
`^[a-z0-9][a-z0-9-]{0,31}$`.

- Bridge: rows get `accounts[]` (`id, alias, label, status, active`); connect takes an optional name; rename, remove
  and reconnect act on one account; the hosted directory adds apps such as Linear and Notion; the `connections`
  tool's status names each account so bots can pass `connector_alias`.
- UI: Connections lists a service's accounts with Add another, Rename, Remove; an app directory to browse more.

## 4. Clearer usage-limit errors

The gateway sends the failure only as text ("Limit resets at HH:MM (in …)") and logs `api_request_error` with a
reason; "schedule a retry" is a client timer in Hermes's desktop, not an API.

- Bridge: an `api_request_error` hook records the last reason per session; failed-turn messages become a structured
  `failure {code, sentence, resetsAt}` (parsed from Hermes's own sentence), like routine failures already are.
- UI: a failure card in the chat: what happened in plain words, when the limit resets, and "Retry at 3:00 PM"
  (a timer that resends the last message once, cancelled by any new message).

## 5. Routine options

`create_job(paused=, paused_reason=)`, `update_job(id, {pinned, model, provider, failure_deliver})`,
`pause_job/resume_job`; unpinned jobs use the main model when they fire; `failure_deliver: local` mutes failure notices.

- Create paused ("Start schedule" later). Model: "follows the main model" (and which) or "pinned to …"; for a bot's
  routine the pin is the bot's own model (Hermes's `pinned=True` would read the chief's config).
- Failure alerts: tell me / mute; bot routines already report through `relay()`, which honours the mute.
- Show the failure streak.

## 6. "Make it violet": Chief styles the app

Hermes's `set_theme` works only in its desktop (a JSON-RPC callback); our sessions are a messaging platform, so the
bridge provides its own `set_app_look` tool. The dashboard is dark-only today: light mode is new design work.

- Look stored on the bridge (`<chief home>/chief_app_look.json`: accent, mode, previous) so every device follows; a
  `cc_app_look` broadcast restyles open windows at once.
- Accent: Hermes's swatches (mono, green, cyan, nous, violet, pink, red, orange) or `#rrggbb`, applied to the accent
  tokens; mode: dark, light, system. A full light palette for the tokens, fills, lines and glass.
- Settings → General: Accent and Appearance, "Changed by Chief · Undo", Reset. Desktop: `nativeTheme.themeSource`
  follows the mode (title bar, system mode), window background per mode.
- Tool: cosmetic and reversible, so no approval; it says what it changed.

## 7. Local models

`hermes_cli/local_runtime/` (engine install via PM with pinned SHA-256s, hardware probe, catalog with fit ratings,
supervisor on 127.0.0.1:18434) and `hermes_cli/web_routers/local_models.py` (plain functions plus an in-memory job
registry, the same ones Hermes's CLI calls in process).

- **Folder:** Hermes has no setting for it (models under `<hermes root>/models`, partials under `cache/partials`,
  engine under `tools`). Hermes patch 0006 adds `local_runtime.models_dir` (models, assets and partials there;
  the engine stays in Hermes's store). The owner chooses it in Settings; default on the owner's PC `E:\Chief models`.
- **Catalog:** fixed to the one in the payload (the 6-hourly refresh from upstream main is unsigned).
- Bridge routes mirror Hermes's: status, hardware, catalog (fits, recommended), install engine, download (pause,
  resume), delete, activate (Chief's model, or a bot's), start/stop; jobs polled. The server starts with the gateway
  when local models are on (it otherwise boots on the first request and that request fails).
- UI: Settings → Local models: the machine, the engine (install/update), recommended and fitting models with size,
  download with progress and pause, "Use for Chief", remove; the folder.

## 8. Ship

Tests for every bridge route and UI piece; the throwaway e2e home on 7795 for the live parts (helpers, failure card,
local models on a small model); `npm run check`; PROGRESS and FRAGILE_SEAMS; one early release; the owner tries it;
promote on the owner's word.
