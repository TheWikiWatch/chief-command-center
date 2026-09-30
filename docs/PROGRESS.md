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

**Phase 3: editing SOUL and memory in the app.**

- Added `persona.py` in the bridge (contract `chief.persona.v1`), for any profile.
  - SOUL: stale-write conflicts are detected and offered as a choice. Hermes's own scan is shown as warnings; a user's own SOUL still loads, as in Hermes. The truncation limit is shown, and there is version history (every save keeps the previous text; hand-made `SOUL.md.bak*` files are listed too) with view and restore.
  - Memory: goes through Hermes's `MemoryStore.apply_batch`, so its lock, strict injection/exfiltration scan and limits apply. Each edit is pinned to the exact entry shown, so an entry the agent changed meanwhile is a conflict with refreshed entries. Deleting every entry is allowed.
- The editor is in Settings ("Chief's identity and memory") and behind the Look drawer's **Edit** button for every bot. It has three tabs: Identity, the bot's notes, and About you, plus a live character meter.
- Contract run against the real Hermes payload: 19 checks passed. In the browser on a fresh home, an added note landed in `MEMORY.md` through Hermes (its lock file beside it).
- The DeepSeek pricing chip now shows only when the chief runs on DeepSeek. That is still true for the existing install, so it is unchanged there.
- To do in Phase 4: a fresh home's SOUL is Hermes's stock "You are Hermes Agent…"; new installs should get a Chief SOUL during onboarding.
- Tests: web 233 passed (4 live skipped), Python 56 passed, privacy scan clean.

**Phase 4: the Second Brain.**

- Template (`hermes/plugins/chief-dashboard-bridge/second_brain/template/`, moved from `templates/` so it ships with the bridge): PARA folders, Inbox, `Journal/Daily` and `Journal/Weekly`, the upstream llm-wiki layout under `40 Knowledge` (`SCHEMA.md`, `index.md`, `log.md`, `raw/`), seven note templates, two Obsidian Bases views, `Home.md`, and `AGENTS.md` as the operating manual (archive, never delete; capture to Inbox; raw sources immutable; log every change; ask before big moves; Obsidian Tasks date syntax).
- Added `second_brain.py` in the bridge (contract `chief.second_brain.v1`):
  - `inspect` reports what a folder holds (notes, folders, Obsidian vault, one of ours) and exactly what each choice would create. It refuses drive roots, system folders and Chief's own data.
  - `setup` writes create-only (an existing file is never replaced). It sets `OBSIDIAN_VAULT_PATH` and `WIKI_PATH` in the profile `.env` through Hermes's own `save_env_value`, and installs a `second-brain` skill rendered with the folder's path. Hermes lists that skill alongside the upstream `obsidian`, `llm-wiki` and `weekly-review-planning` skills.
  - Modes: `new` (full layout), `keep` (only `AGENTS.md`, Inbox, Knowledge and Templates; the chief then drafts the "Where things go" section for the owner to review) and `reorganize` (the same files now; the chief proposes a move plan in chat and moves nothing without approval).
  - `seed_soul` gives a fresh profile Chief's neutral default SOUL. It replaces only Hermes's untouched stock text (or its legacy scaffolds) and keeps the old text in SOUL history.
- Built-in Today: `lib/server/today-index.ts` reads open tasks from the vault's Markdown in the Ops API's shapes. Boards are project/area notes or top-level folders, and columns come from dates, `[/]` and `#waiting`. Ranking puts overdue, due today, in progress, top priority and due soon first. Templates, Archive, Attachments, Bases and raw sources are skipped, and a file is re-read only when its mtime changes. "Hand off to Chief" composes a chat message naming the exact file and line; the app never writes the vault. An install that sets `CHIEF_OPS_URL` keeps using its Ops service, unchanged.
- The web server finds the Second Brain as `CHIEF_VAULT_PATH`, else the folder Chief was set up with (read from the bridge, cached 15 s, cleared on setup). Vault and Today both use it.
- UI: onboarding step 2 "Your Second Brain" (skippable). It has a folder field with the real Documents folder (OneDrive-aware) as default, a Browse button when the desktop shell provides one, a preview of what will be created, and the three plainly described choices for a folder with notes, including "Use a different folder" and "What's the difference?". There is also a Settings → Second Brain group (Change / Set up), a "Set up my Second Brain" button on Today and Vault, and "Ask Chief to describe my folders / for a move plan" after setup. Vault opens `Home.md` when present.
- Behavior change on the existing adopted install: none. It sets `CHIEF_OPS_URL`, so Today still reads SecondBrainOps; the proxy test that expected "no call at all without Ops" now expects only the bridge lookup.
- Evidence:
  - Second Brain contract against the real Hermes payload: 33 checks passed. Covered: path refusals, new/keep/re-run create-only, placeholders, `.env` paths, skill frontmatter, a synthetic Obsidian vault in keep mode, and SOUL seeding (custom SOUL untouched, stock replaced, history kept, idempotent).
  - Browser end to end on the throwaway e2e home: Today → "Set up my Second Brain" → Create. Today then showed the template's tasks immediately. "Mark complete" put `Please mark this task done… (00 Inbox/Welcome.md, line 17)…` into chat.
  - Editing the files as the agent would updated Today within one poll: the ticked task left, and a new overdue daily-note task ranked first. Vault browsed the folder and opened Home.
  - `hermes skills list` showed `second-brain` enabled, and the `.env` held both paths.
- Not yet verified: a real agent round-trip (capture → Inbox, daily note, tick a task). The e2e model is a stub that cannot call tools; this needs a real provider and is in the Phase 13 acceptance sweep.
- Tests: web 247 passed (4 live skipped), Python 56 passed, privacy scan clean.

**Phase 5: voice defaults and Check my system.**

- Spoken replies: Hermes's own default for a new profile is already Edge with `en-US-AriaNeural` (no key), so nothing is written for new installs and existing voice choices are untouched.
- Voice typing (Q3 option 3): added `speech_model.py` in the bridge (contract `chief.speech_model.v1`).
  - It manages Systran's faster-whisper `base` (148 MB, default) and `tiny` (78 MB), pinned to a commit with a SHA-256 for every file.
  - Downloads are resumable (Range), cancellable, and verified; a corrupt file is discarded.
  - On completion it sets `stt.provider: local` and `stt.local.model: <folder>`, so Hermes loads from disk.
  - Models live in `<chief home>/models/`.
- No silent downloads: with local STT and no model on disk, `/transcribe` answers `model_missing` before Hermes's first-use Hub download can start. A model already in the Hugging Face cache (an existing install) still counts as ready.
- Check my system (`components/voice/check-my-system.tsx`), step 3 of onboarding (skippable) and in Settings → Voice ("Run", with the last result on this device):
  - Microphone: a device picker, saved per device and now used by the mic button too; access; a live level; silence after 4 s.
  - Speakers: a test phrase through `/speak`, then "Did you hear it?".
  - Voice typing: consent with the size and source, progress, Cancel/Resume, and a smaller-model option. After that, "Say a short phrase" goes through `/transcribe`, which never reaches the conversation.
  - Error states for denied, missing and busy mics (with the Windows `ms-settings:privacy-microphone` link), unsupported browser, playback blocked or voice service failing, no speech, and a missing model. Voice problems never block text chat.
- Evidence:
  - Speech-model contract against the real Hermes payload: 20 checks passed. Covered: the guard refuses instead of downloading; checksum mismatch; cancel then resume with a Range request; a server that ignores Range; idempotent re-download; Hermes config; delete.
  - With the network on, the real `tiny` model downloaded and verified (78 MB). Edge spoke "Please remind me to call the plumber tomorrow morning." with no key, and the local model transcribed it word for word, offline. This answers the no-key STT checkpoint.
  - Browser, on the e2e gateway with an empty Hugging Face cache: status "not ready", then Download in Settings → Check my system. The 148 MB model was verified, and `config.yaml` then had `stt.provider: local`. "Play a test phrase" reached "Did you hear it?".
  - Through the app's own proxy, Edge audio for "Add oat milk to my shopping list for Saturday." came back from the gateway's local model exactly (2.8 s).
  - The in-app browser blocks microphones, so the live mic check showed the denied state with the settings link. A real microphone test waits for the desktop shell (Phase 7) and the phone.
- Unit tests: nine for Check my system (every error state, consent, progress, cancel/resume, smaller model, Not now, no-speech, missing model) and one for the three-step onboarding (model required; Second Brain and Check my system skippable; SOUL seeded once; nothing downloads without a tap).
- Tests: web 257 passed (4 live skipped), Python 56 passed, privacy scan clean.

