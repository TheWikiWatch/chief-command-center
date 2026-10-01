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
