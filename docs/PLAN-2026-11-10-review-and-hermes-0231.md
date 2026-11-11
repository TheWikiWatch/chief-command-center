# Plan: a deep review, and Hermes v0.23.1

Status: **done** (2026-11-10), shipped as an early release. Everything below is done unless it says otherwise.

Two jobs in one release. First, five read-only reviews of the app, each verified against the code: the dashboard,
the desktop shell, the bridge, packaging and CI, and what Hermes v0.22.6 to v0.23.1 changed. Second, the upgrade to
Hermes v0.23.1, which upstream released on 2026-11-10. v0.22.6 to v0.23.1 had all been blocked here by patch 0002.
Upstream's main is about 950 commits further on but unreleased, and the app ships only stable releases.

Paths are this repository's unless they say otherwise.

## 1. Hermes v0.23.1

Done:
- The patch queue was re-anchored (0002 and 0003); 0001, 0004, 0006 and 0007 still apply and still do their job.
  `gateway.standalone` is still supported (and still "a temporary shim"), so 0007 stays.
- The payload is built (`E:\ChiefBuild\payload-0.23.1`) and the compatibility suite passed all 16 checks.

Every bridge call still worked, but behaviour moved (all fixed):

| | What | Where |
|---|---|---|
| H1 | A turn the safety filter refuses is now archived (`content_refused`): the owner's message vanished, and the long-poll looped because the head fell below the cursor | data.py, the chat |
| H2 | Approval descriptions arrive with invisible characters escaped, so the mail guard's mark and the sheet's hidden-character warning stop working | mail_guard.py, lib/mail-approval.ts |
| H3 | An image in a streamed reply is sent again as a separate text message | adapter.py (`send_image`, `send_animation`) |
| H4 | `llm-wiki` left the built-in skills, and the Second Brain skill still routes to it | second_brain skill |
| H5 | Nous subscription models show as "Free" | providers.py, lib/plan-usage.ts |
| H6 | A finished background task reads as "didn't finish" ("API calls" became optional) | lib/background-report.ts |
| H7 | Questions now expire after 90 s instead of an hour: provisioning keeps a longer time unless the owner chose | provision.py |
| H8 | Routines: a stopped run shows as "Failed"; the latest report starts with Hermes's run-time line; stopping a bot's running routine looks in the wrong home | routines.py, routines UI |
| H9 | New raw notices (a refusal, "Hermes did not answer this message", a missing key with CLI steps) get the app's own words | chat_state.py |

Features adopted (small, and they matter to one owner on one PC):

| | Feature | Hermes API |
|---|---|---|
| F1 | Stop a running routine, shown as "Stopped" | `cron.jobs.cancel_job_run` |
| F2 | A routine missed while the PC was off: run it once later, or skip it | `catch_up`, `grace_minutes` |
| F3 | A personality, critical facts or skill edit reaches the open chat without starting fresh | `request_prompt_refresh` |
| F4 | "Back to my usual model" after a one-tap switch pinned the chat to another | `/model reset` |
| F5 | The app's own skills are locked against rewrites by the agent and the curator | `skill_usage.set_locked` |

F5 is skipped: a lock refuses the owner's own edits too, and the app's rule is that the owner may edit its skills
(provisioning never overwrites an edited one). H1 holds in a long chat only up to a point: there Hermes 0.23.1
reads a refusal as a full context and compacts instead of archiving, so the message stays and the notice is the same.

Skipped: the Webapp (our dashboard and phone access cover it, and it stays off by default), group chat rooms,
multi-gateway Desktop, catalog plugins, vault backends.

## 2. Review fixes

**Security**
- S1 Global security headers replaced the file routes' own (Next applies the config's headers first and a handler's
  only where none is set): a vault SVG opened in a tab could run script, and the PDF preview was refused. The file
  routes get their own complete headers; SVGs download unless shown as images.
- S2 Network (UNC) and NT-namespace paths are refused by the bridge's file server and the dashboard's proxy: a reply
  naming `\\host\share\x.png` made Windows connect to that host with the owner's credentials.
- S3 The app's Python processes ignore the per-user site-packages (`-s`), so a planted `.pth` can't run in the gateway.
- S4 An edited copy of the bridge plugin in the profile is put back at the next start.
- S5 The image provider's URL is fetched only over https from a public host.
- S6 The boot page's IPC answers only the boot page; a rollback offer ends when a start succeeds; the installed app
  ignores developer overrides; downloads follow at most 5 redirects, https only; Tailscale only from Program Files.
- S7 CI: the untrusted build job can't write the cache; the bots trust only their own PRs and issues; the radar runs
  only after a build.

**Correctness**
- C1 A message queued offline is sent to the thread it was written in.
- C2 The dashboard supervisor learns its child's pid (it never did, so a restart could loop).
- C3 Restore is crash-safe and a rollback that couldn't put the data back says so; backups stage beside their
  destination, not as plaintext on C:, skip junctions, and refuse when owner-only permissions fail.
- C4 A running backup isn't killed by a dashboard restart; going back to a version can't race the background prepare.
- C5 Non-ASCII file names download; JSON-looking text isn't parsed as a message; a non-ASCII token is a 401.
- C6 The OSV exceptions that expire on 2026-11-12, the backspace bytes in `osb_vendor.py`, Update Chief.cmd on a path
  with an apostrophe, the SBOM (Electron and hashes), and the release tools' signal handling and re-hash.

**Speed**
- P1 A streamed reply no longer wakes every other poller each frame; the backup panel stops starting Python every
  second; the per-poll queries use their index again; uploads get time in proportion to their size.

**Accessibility and the look**
- A1 One persistent status region for screen readers; the thread switcher is a dialog, not a menu; each message says
  who wrote it; light-mode warning and success colours pass AA; "Always allow" works without holding.
- A2 No flash of the wrong thread at start; your own message doesn't animate in twice.
- A3 (found in the final visual pass) Status text passes AA on every surface in both modes and on the /10 and /15
  tints its chips use; the routines list re-reads itself while a run is due or running, so "Running now" and
  "Stop this run" appear without reopening it; quiet notices show Hermes's Markdown as plain words; an approval
  that timed out is said in the app's words (Hermes's tells you to edit config.yaml).
- M1 The dashboard's server modules (`lib/server/`) are marked `server-only`, so a client import fails the build;
  Vitest resolves the `@/` paths itself (Vite 8) instead of through a plugin.

Not done: the offline outbox has no cap on its count (each entry expires after a day, and only the owner's own
sends go in).

## 3. For the owner (not done here)

- The release key and the signing password live on the account that runs Chief. Move to a passphrase-protected key
  and a non-exportable certificate in the Windows store; tighten `E:\ChiefBuild`'s permissions.
- GitHub settings: Dependabot security updates (or the Renovate app), private vulnerability reporting, immutable
  releases, CodeQL.
- Child processes of the gateway can outlive a crashed app (no kill-on-close job of our own). A job object around the
  gateway is a project of its own.

## 4. Ship

Checks, the e2e home on the new payload, the smoke test, then one early release; the blocked-upgrade issues close.
