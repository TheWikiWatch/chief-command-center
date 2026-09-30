# Progress

## 2026-09-30

**Phase 0: feasibility.**

- The Hermes payload builds with upstream's own builder (`packaging/payload/stage.py`) from `hermes/pin.json` plus the patch queue. The tools are Python 3.14, uv, Node, npm, ripgrep, ffmpeg and Git, and the Python extras come from an explicit list, so no compiler is needed. It is about 2.9 GB before trimming the offline uv cache (0.9 GB).
- An install stamp makes the app the payload's steward: `hermes update` answers "managed by chief-command-center" and refuses.
- The payload's gateway runs the bridge on a throwaway home: `/health` ok, voice available, long-poll on.
- Hermes allows one gateway per lock directory. A second install on the same PC must use its own `HERMES_GATEWAY_LOCK_DIR`, or it attaches to the other gateway and exits.
- A machine-wide `HERMES_HOME` left by older installers must never leak into app processes.

**Phase 1: this repository.**

- Imported the dashboard as `apps/web` and the plugins under `hermes/plugins`.
- Every personal default is gone. Names come from the chief's profile and `CHIEF_OWNER_NAME`, and paths and optional integrations from `app-config.ts`. Fleet Health and Today (Ops) are optional connectors that are off unless configured.
- The chat platform, previously a separate plugin, now registers from the bridge. Its session key uses `COMMAND_CENTER_HOME_CHANNEL` (default `owner`).
- Phone alerts are implemented in-process: RFC 8291 encryption and RFC 8292 VAPID on `cryptography`. The encryption matches the RFC example and a reference library byte for byte, and the old helper process is gone.
- Fixed: a long-poll on an empty conversation answered at once instead of holding (fresh installs).
- Privacy scan added, locally and in CI.
- Tests: web 220 passed (4 live skipped), Python 56 passed, privacy scan clean.

**Phase 2: connecting a model.**

- Added `providers.py` in the bridge (contract `chief.providers.v1`). It takes the provider catalog from Hermes's own model inventory and saves keys through Hermes's credential lifecycle. Model choice goes through Hermes's dashboard handler, which includes the expensive-model guard. Custom and local endpoints use Hermes's endpoint probe and save, and the test message uses `call_llm`.
- Added the `/setup/*` bridge routes and proxy permissions.
- Added onboarding: "Connect a model" appears only while the chief has no working model; "Set up later" is available. A Settings → Connection row shows the model and a Change button.
- Today and Vault show a calm "Your Second Brain isn't set up yet" state instead of an error when nothing is configured.
- Contract run against the real Hermes payload: 20 checks passed. Covered: catalog, key storage in the profile `.env` without echo, refusals, and an unreachable endpoint. Also covered: a keyless local endpoint end to end (probe, save, ready, test reply, no Authorization header), and a made-up key against a real provider reported as rejected.
- Browser end to end on a fresh home with the bundled gateway: onboarding, then a local model, "Connected", then the first chat message answered by the chief.
- Found for the supervisor phase: on a fresh home Hermes picks up ambient credentials (the `gh` CLI login appeared as GitHub Copilot). New installs will run the gateway with a curated PATH and environment.
- Tests: web 227 passed (4 live skipped), Python 56 passed, privacy scan clean.
