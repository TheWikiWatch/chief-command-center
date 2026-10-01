# ChiefDashboard fragile seams (test map)

| Seam | Failure mode we hit | Covered by |
|------|---------------------|------------|
| Thinking vs tools+text | Assistant bubble with tools[] never cleared wait | `chat-tone.test.ts`, `thinking-chrome.test.ts` |
| Idle orphan Thinking | Status? unanswered after APPCRASH still showed Thinking | `chat-tone.test.ts`, `thinking-chrome.test.ts` |
| First-send race | busy cleared before generating; no optimistic timestamp | `thinking-chrome.test.ts` |
| pendingReply stick | Never cleared if Chief dropped turn | `thinking-chrome.test.ts` |
| Compact chat | Must not filter thinking transcript | `compact-filter.test.ts` |
| UTF-8 mojibake | TOOL Â· / Voice Â· / chevrons | `encoding-source.test.ts` |
| Prefs keys | Compact + font localStorage | `dashboard-prefs.test.ts` |
| Bridge /events | Pasted handler shadowed SSE → 404 | `bridge-contract.test.ts` (live) |
| Bridge auth | 401 without bearer | `bridge-contract.test.ts` (live) |
| generating flag | UI must trust bridge idle | `bridge-contract.test.ts` + chrome unit |
| Gateway APPCRASH mid-turn | Status? accepted then unclean exit | documented; soak via ops inject |
| Double `gateway run` | Job-object / duplicate process risk | manual/ops note in PROGRESS |
| Blobatar mouth | `blobatar._layout` is internal; React replaces the blob's markup on an expression change, so the injected mouth must re-attach | `mouth.test.tsx` (layout contract, re-attach); blobatar pinned to an exact version |
| Face clock measure/draw | Layout reads interleaved with transform writes thrash layout per face | `pointer-attention.test.tsx` (measure before draw) |
| Cursor attention | Eyes that lock onto a parked cursor, or flap at the edge of the radius | `pointer-attention.test.tsx`, `attentive-gaze.test.tsx` (decay, hysteresis) |
| VoiceStudio plugin | Backend down or slow must never silence Chief (Edge fallback); text must stay on loopback | `tests/python/test_voicestudio.py` |
| Phone alerts | Gateway's Python 3.14 can't load pywebpush (compiled 3.11 deps): every push failed silently; `ttl=0` dropped alerts to a dozing phone; a blocking send on Chief's event loop | `test_bridge.py` PushTests (ttl/timeout/Topic, helper fallback, never blocks), `npm run doctor` (Push library) |
| Service worker | Navigating the open app reloads it (lost state, unspoken replies); a push while the app is visible | `service-worker.test.ts`, `open-target.test.ts` |
| Skill revert | Reverting an older change wrote back the version before it, silently discarding every later edit | `test_learning_ledger.py` (refuses without `--discard-newer N`), `fleet-health.test.tsx` (arms first), `fleet-routes.test.ts` |
| Ledger output | Diffs with `→` crashed a Windows child's cp1252 stdout (500 on /api/fleet/diff) | ledger forces UTF-8; `runLedger` sets `PYTHONIOENCODING` |
| Outbox | A retry that doubles a message; a queued bubble matched by an arriving copy; the flush loop cancelled by its own commits | `chat-actions.test.tsx` (same id, reload, Cancel), `outbox.test.ts` |
| Long-poll | A bridge that answers at once turns the poll into a tight loop; header marks Chat stale during a 25s hold | client backs off after 3 quick returns; stale window 40s while long-polling; `transcript-live.test.tsx`, `LivePathTests`, live contract |
| Load earlier | History before a compaction is archived (`active = 0`); each compaction's copies duplicate its tail; a page of filtered rows repeats forever | `LivePathTests` (archived rows, all windows flagged, cursor moves on), `transcript-live.test.tsx` |

## Commands

```text
npm test             # unit/regression; live bridge checks stay skipped
npm run doctor       # read-only service, auth, and capability report
npm run test:bridge  # three live checks; see README "Check" for the enable flag
```

Live checks need `CHIEF_BRIDGE_SMOKE=1` and `CHIEF_BRIDGE_TOKEN` (same secret as `CHIEF_DASHBOARD_TOKEN`, process environment only). Optional `CHIEF_BRIDGE_URL` overrides `http://127.0.0.1:7790`.

## Stopping a gateway when more than one Hermes install is on the PC

`hermes -p <profile> gateway stop` on Windows is not scoped to `HERMES_HOME`. It ends the per-user scheduled task named after the profile (`Hermes_Gateway_<profile>`), and it sweeps gateway processes. On 2026-09-30 a test run of it, against a throwaway home, stopped the live install's gateway on the same PC; its guard restarted it within about a minute.

This app never calls it. To stop its own gateway, it writes Hermes's own planned-stop marker in its own profile home for its own gateway pid; the gateway drains and exits. Only then, if needed, does it end its own process tree. The code is `requestScopedStop` in `apps/desktop/src/gateway.ts`, and `gateway_smoke` in `packaging/upstream/compat.py`.

The gateway's `gateway.pid` appears a few seconds after `/health` answers, so a stop right after start must wait for it. A test that stops its own gateway should check that a live install on the same PC is unaffected: its `gateway-starts.log` line count doesn't change.


## Creating and removing worker profiles

Two Hermes profile helpers reach outside the profile they are given:

- `hermes_cli.profiles.create_profile` writes a command wrapper (`<name>.cmd`) into a user-wide folder on `PATH`, unless it is called with `no_alias=True`. A second install's wrapper would shadow the first's. `fleet.mint` always passes `no_alias=True`.
- `hermes_cli.profiles.delete_profile` disables the per-user scheduled task `Hermes_Gateway_<name>` and deletes the wrapper, both by name, so it can break a profile of the same name in another install. `fleet.retire` never calls it: it exports the profile (Hermes's own `export_profile`, which leaves out keys), refuses while the bot is working, and then removes only that profile's folder itself.

`hermes/tests/contract/run_fleet_contract.py` checks that minting writes no wrapper and that the archive holds no `.env` or `auth.json`.

## What the chat shows besides transcript rows

`hermes/plugins/chief-dashboard-bridge/chat_state.py`; test map: `hermes/tests/test_chat_state.py`, and the questions and live-steps checks in `hermes/tests/contract/run_chat_controls_contract.py`.

- **The chief's questions (`clarify`).** The adapter overrides Hermes's `send_clarify`, so no text prompt goes to the outbox. The bridge reads the open question from `tools.clarify_gateway` (`get_pending_for_session(..., include_choice_prompts=True)`) and answers through `resolve_gateway_clarify`. The adapter marks every question as accepting free text (`mark_awaiting_text`), so a typed message answers it too. If Hermes renames these, the contract fails at "the question comes with the transcript".
- **Notices.** Every adapter send is written to the outbox, replies included. A notice is an outbox row whose text isn't a transcript reply, or a piece of one. Hermes saves a reply's row before it sends it; if that order ever flips, a reply could flash as a notice. "⏳ Working" busy lines are never notices and never push to the phone.
- **Live steps.** A turn's rows reach `state.db` only when the turn ends. The adapter declares `supports_status_text`, so Hermes calls `set_status_text` as each tool starts. To label steps in the app's words, the plugin wraps `agent.display.build_status_phrase` (`chat_state.install_status_capture`). The wrapper notes the tool and arguments on the same thread, just before `set_status_text`. Without the wrapper, the bridge falls back to Hermes's own phrase, tidied. Deferred tools (Hermes's `tool_search` defer list) that the model calls directly are refused before they start, so they show no step. The test model uses `skills_list` for that reason.

## The bundled Second Brain toolkit

`hermes/vendor/obsidian-second-brain/` is a pinned release of the public `obsidian-second-brain` toolkit (MIT), built with its own Hermes build. It is re-vendored with `packaging/upstream/osb_vendor.py --tag <tag>`. Test map: `hermes/tests/test_provision_toolkit.py` and `hermes/tests/contract/run_second_brain_contract.py`.

- **Script calls.** The toolkit's skills run its helper scripts with `uv run --directory "$HOME/.hermes/skills/obsidian-second-brain" …`. That would make `uv` download the toolkit's dependency set, and it names the wrong folder. `provision.install_toolkit` rewrites each call to `PYTHONPATH="<site-packages>" "<the app's Python>" "<install root>/scripts/<script>.py"`. A new upstream form of the call that the rewrite doesn't match leaves a `uv run` behind; the test "never call uv" fails.
- **Left out.** The research skills (paid keys, Whisper and PyTorch downloads), `create-command` and `obsidian-retrieval-eval` (Ollama). `vendor.json` lists them.
- **Folders.** The toolkit finds folders through a `## Folder Map` table in the vault's rules file. It looks for `_CLAUDE.md`, which in this app is a pointer to `AGENTS.md`. The app's template writes the map, and `second_brain.upgrade()` appends it to an app-made `AGENTS.md` that lacks one.
- **Routines** are cron jobs in the chief's profile named `Second Brain: …`; the app finds them by name. Renaming one in Hermes makes the app create it again.
- **Second Brain first.** `skills.auto_load: [second-brain]` pins the skill into every new session, with `CRITICAL_FACTS.md` embedded; `sync_critical_facts()` re-renders it about once a minute when the file changes. Bots get the same through `share_with()`, and the toolkit through `skills.external_dirs`.
- **The default SOUL.** `seed_soul()` replaces an unedited earlier default. It recognizes those by digest (`_PREVIOUS_DEFAULT_SOULS`). When `second_brain/SOUL.md` changes, a unit test fails until the old digest is recorded.

## Threads, routines and usage

`threads.py`, `routines.py` and `usage.py` in `hermes/plugins/chief-dashboard-bridge/`. Test map: `hermes/tests/test_threads.py`, `hermes/tests/test_usage.py`, `hermes/tests/contract/run_routines_contract.py`, and the thread and routine checks in `hermes/tests/contract/run_chat_controls_contract.py`.

- **A thread is a chat id.** The main thread is the home channel (`owner`). Others are `owner.t-<8 hex>`, so their session keys are `agent:main:command_center:dm:owner.t-…`. `data.resolve_session_key` skips those keys when it looks for the main chat. If Hermes changes how it builds session keys from chat ids, the contract fails at "their transcripts stay apart".
- **Fresh start answers Hermes's confirmation.** `/new` asks through `tools.slash_confirm`. The bridge waits up to 8 s for `get_pending(session_key)` and then sends `/approve`. If Hermes stops asking, the fresh start still works; if it renames the module, the bridge never approves and the contract fails at "a fresh start is accepted".
- **A bot's routine can't deliver into the app itself.** Hermes's pre-run check blocks a job whose delivery platform the job's profile doesn't serve (`cron/scheduler_preflight.py`), and bots don't serve the Command Center. A bot's routine is saved with `deliver: local`. Its thread is kept in the chief's profile (`routine_threads.json`), and `routines.relay()` (watch loop, about every 10 s) posts each new run's `## Response` from the job's output folder into that thread. The last run relayed is in `routine_relayed.json`. If Hermes changes its output file layout, nothing is relayed, and the contract fails at "a bot's routine runs and reports into the main thread". The chief's own routines still deliver through Hermes (`command_center:<chat>`).
- **Built-in routines are found by name** (`Second Brain: …`, `Fleet: …`), as before.
- **Usage cost** is a session's actual cost when Hermes has one, else its estimate. A session with tokens and no cost is counted as unpriced, not as free. Auxiliary model calls (`session_model_usage` rows with a task) are added on top, because Hermes doesn't count them in the session row. The budget lives in the chief's profile (`usage_budget.json`). One notification is sent per month, and nothing is ever stopped.

## Second Brain formats

`second_brain.py`, `second_brain/template-wiki/`, the `skill-*` folders beside it, `drop_gate.py`, and `apps/web/lib/server/today-index.ts`. Test map: `hermes/tests/contract/run_second_brain_contract.py` (the wiki section), `apps/web/tests/today-kanban.test.ts`, `apps/web/tests/second-brain-setup.test.tsx`.

- **The rules file decides.** `manual()` treats `_CLAUDE.md` as the folder's own manual unless it is the app's short pointer (`# Rules for agents` … `[[AGENTS]]`), then `AGENTS.md` unless it is the pointer the other way. If those pointer texts change, an app-made vault looks like an owner's own manual, and keep-mode setup adds nothing to it.
- **Format detection:** `wiki/` plus `raw/`, or a `_CLAUDE.md` mentioning both, means the wiki format. A PARA vault with a `wiki/` and a `raw/` folder of its own would be detected as wiki; setup then offers a one-click switch back.
- **Folder Map.** The toolkit's skills read the `## Folder Map` table in `_CLAUDE.md` (`references/folder-map.md`); the wiki template's manual has one. Without it, the toolkit falls back to its wiki-style defaults, which match.
- **The drop gate** is a cron `script` in the profile's `scripts/` (Hermes runs scripts only from there). It runs from the vault (the job's `workdir`) and prints `{"wakeAgent": false}` when there is nothing to file. If Hermes changes the wake-gate contract (`cron/scheduler_prompt.py`), the contract fails at "an empty drop folder never wakes the model".
- **The morning brief is mirrored into the chat session** (`attach_to_session`). Hermes stores the copy as a user row starting `[Cron delivery:`; `data.transcript` hides those rows, and the notice shows the brief once. If Hermes changes that prefix, the brief appears twice, once as if the owner had sent it. `test_bridge` covers the filter.
- **Kanban boards** are recognized by `kanban-plugin:` in the properties block only. The column mapping is by keywords (Backlog, This Week, In Progress, Waiting On, Next Week, Done; unknown headings count as Backlog), and reading stops at `%%`.

## Adopted installs

`apps/desktop/src/store.ts` (`adopted`), `apps/desktop/python/provision.py --adopted`, `second_brain.adopted()` and `learning.ensure()` (both read `CHIEF_ADOPTED`), and `packaging/migrate/adopt.py`. Test map: the adopted section of `run_second_brain_contract.py`, `AdoptedInstallTests` in `test_provision_toolkit.py`.

- **The owner's skills win by name.** The app looks for a same-named skill anywhere in the profile's skills and its `skills.external_dirs`. A skill counts as the app's only if its frontmatter says `author: Chief Command Center`; anything else is the owner's and is never shadowed. Renaming that author line in a bundled skill makes the app treat its own skill as the owner's.
- **The toolkit is the owner's** when an external skills dir holds `obsidian-second-brain`. The always-loaded skill's `{{toolkit}}` then points there. If the owner deletes it later, the app reinstalls its own only when not adopted.
- **The old `command-center` plugin must stay off:** the app's bridge registers the same platform. `adopt.py` moves it aside and removes it from `plugins.enabled`.
- **The old launchers** (the guard task and Startup VBS that start this profile's gateway) are found by their reference to `profiles\<profile>\gateway-service`. `adopt.py --rollback` turns them back on.
