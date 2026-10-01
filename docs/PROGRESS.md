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

**Phase 6: backup and restore.**

- Engine `backup/chief_backup` (Python, runs on the payload's Python; see `backup/README.md`).
  - Parts: setup (the Hermes root, every profile, plus the app's shared settings) and Second Brain.
  - Never included: caches, logs, locks, the speech model, launchers, install records.
  - SQLite is copied with the online backup API. Every file is SHA-256'd into the manifest and verified before the file is renamed into place.
  - Secrets go in only when encrypted: scrypt plus a passphrase check value, then AES-256-GCM chunks bound to their index and a final flag. Unencrypted backups keep settings like paths and ports and list the key names left out.
  - Restore steps: inspect (a newer app's backup is refused), stage (next to each target; unsafe paths refused; every hash verified), apply (refused while a gateway runs), finish, rollback, recover.
  - Apply takes a local safety backup, then does a journaled swap.
  - It remaps OBSIDIAN_VAULT_PATH, WIKI_PATH, the Second Brain record and the skill; other old paths are listed for review.
  - It carries over secrets a backup left out when this PC has them, and carries machine-local pieces (speech model, launchers) across a same-PC restore and back on rollback.
- Web:
  - `lib/server/app-settings.ts` holds shared app settings in `CHIEF_APP_DATA/settings.json`.
  - `lib/server/backup.ts` runs the engine (passphrase on stdin; one job at a time; progress) and the weekly schedule. The schedule runs from `instrumentation.ts` and does nothing until a folder is chosen.
  - `/api/backup/*` covers status, list, settings, run, inspect, and restore stage/discard/finish; every write is origin-checked.
- UI:
  - Settings → Backup & restore: last backup and a 30-day reminder; the folder the owner chooses (a suggestion is shown, applied only on click; Browse in the desktop app); weekly, keeping N; Everything / Setup / Second Brain; optional passphrase (the "can't be recovered" warning is shown); Back up now with progress; the folder's backups with Restore.
  - Restore flow: file, passphrase, preview (date, versions, bots, notes, size), parts, where the Second Brain goes, verified staging. The desktop app then applies it; a browser says so.
  - Onboarding's first screen has "New PC? Restore from a backup".
- Also fixed: fields with a Browse button now keep the button outside their `<label>`, in Second Brain setup, backup and restore. Labels had given those buttons a wrong accessible name and could activate the input.
- Evidence:
  - Engine: 20 tests pass on Python 3.13 and on the payload's 3.14. Covered:
    - What's excluded, and secrets only when encrypted.
    - Tamper and truncation detection.
    - Round trip to a new PC with other paths, with remapping, a review list and missing keys.
    - Same-PC restore with a safety backup, secret carry-over, machine-local carry-over and rollback.
    - Second Brain only into a new folder (a non-empty other folder is refused).
    - An encrypted restore, and a wrong passphrase.
    - A corrupted file changes nothing; a newer app's backup is refused; zip-slip is refused.
    - Refused while the gateway runs.
    - Failure mid-swap rolls back, and a process killed mid-swap (`os._exit`) is recovered at the next start.
    - Disk full leaves no partial file, and a backup taken during continuous SQLite writes passes `integrity_check`.
    - Retention never removes manual backups, and the CLI keeps passphrases off argv.
  - Web: two route tests drive the real engine: no schedule without a folder, 403 on a foreign origin, manual and encrypted backups (the passphrase never lands in settings), a wrong passphrase, the weekly run a week later, "off", and restore staging and discard. Four UI tests cover the panel and restore flow.
  - Live on the e2e home with its gateway running:
    - Backup: Settings → folder → Back up now gave 1.3 MB, 414 files and 5 databases, with auth and alert keys left out.
    - Restore: the SOUL was changed, the restore was staged from the UI, and the gateway was stopped with me standing in for Phase 7's supervisor. Apply, then rollback (live), then re-apply with the carry-over fix. After the gateway restarted: health ok, model ready, voice typing ready, and a chat message answered. Finish removed the old folders and kept this PC's backup folder setting.
- Not yet done: applying a restore from the app itself (Phase 7 supervisor, `window.chiefDesktop.applyRestore`); restore under another Windows user in Windows Sandbox (with the Phase 8 package); real disk-full (simulated in tests).
- Tests: web 263 passed (4 live skipped), Python 56 + 20 passed, privacy scan clean.

**Phase 7: the desktop shell (unpackaged, throwaway data).**

- `apps/desktop` (Electron 44, TypeScript; see its README) is the only supervisor.
  - Single instance, with `--hidden` and `--quit`, and a boot screen showing each step with Try again and Open logs.
  - First-run provisioning through Hermes's own config code (`python/provision.py`: bundled plugin sync, enable, port and platform env; idempotent).
  - The gateway runs in the foreground with an explicit HERMES_HOME and its own lock folder, supervised with 1/5/30 s backoff and a crash-loop limit (5 in 10 minutes).
  - A gateway run by another launcher gets Take over / Use it as is; our own orphans are ended.
  - The Next standalone server runs under Electron's Node (`utilityProcess`).
  - Child processes get a curated environment (no ambient keys, tokens or HERMES_*; PATH = payload tools + system).
  - Ports: saved, with free-port fallback.
  - The bridge token is sealed with DPAPI (`safeStorage`).
  - Tray, hide-on-close, graceful quit with an active-work prompt, and native notifications while hidden.
  - `window.chiefDesktop` exposes folder/file pickers and applyRestore (stop, apply, start, health check, then finish or roll back).
- `apps/web`: `npm run build:standalone` builds and copies static assets next to `server.js`. The output was checked for leaked values: no `.env` files, and no dev token.
- Evidence:
  - 18 unit tests: supervisor backoff, crash-loop limit and window, stale exits, intentional stops, launch/ready failures; environment allow-list (drops OPENAI/GH/ANTHROPIC/HERMES_HOME/NODE_OPTIONS; keeps proxies); ports; active-work reasons; notifier (history never announced; replies and approvals only while hidden); restore sequence (success, rollback when Chief doesn't come back, refused apply); gateway ownership; DPAPI token; settings.
  - The real app, on a throwaway data folder, with this PC's live install still running on 3000/7790:
    - Boot: it picked 3001/7792, provisioned a fresh profile and started both processes (gateway in about 5 s, dashboard in 162 ms).
    - Onboarding: the full three steps in the browser against the app-managed runtime (local test model, a new Second Brain, system check skipped). Today then showed the template's tasks.
    - The default Chief SOUL replaced the stock one, which was kept in history, and the install used its own gateway lock folder.
    - Chat round trip.
    - Killing the gateway: the supervisor restarted it after 1 s, and it was healthy again.
    - A second launch exited in 1 s with no second gateway.
    - Hard-killing Electron's main process left no orphaned gateway or server.
    - Relaunch reused the saved ports.
    - `--quit`: Hermes logged "Gateway stopped", the pid file was removed, and the app exited in 5 s.
- Not verified yet, because they need hands on the desktop or come with packaging: clicking the tray and the busy-quit dialog, the Windows notification appearing, applyRestore from the real window, the microphone in the Electron window, start at sign-in (registered only when packaged). These are on the Phase 8/13 checklist.
- Test note: the in-app browser used for checks pauses `requestAnimationFrame` while its pane is hidden, which holds onboarding's step animation until it paints. Not an app bug; a visible window always paints.
- Tests: web 263 passed (4 live skipped), desktop 18, Python 56 + 20, privacy scan clean.

**Incident, 2026-09-30 ~15:53: a test stopped the live install's gateway.**

- What happened: the first version of the compatibility suite (below) stopped its throwaway gateway with `hermes -p chief gateway stop`. On Windows that command isn't scoped to `HERMES_HOME`. It ends the per-user scheduled task named after the profile (`Hermes_Gateway_chief`) and sweeps gateway processes. It stopped the live install's gateway and an unrelated test gateway.
- Impact: the live install's guard restarted its gateway at 15:54:18, about 1–2 minutes of downtime. It had been idle since 11:18, so no turn was cut off. Cron jobs due in that window may have run late.
- Fix: nothing in this repo calls `gateway stop` any more. The desktop shell and the compatibility suite write Hermes's own planned-stop marker in their own profile home for their own gateway pid (waiting for `gateway.pid`, which appears after `/health`). Only then, if needed, do they end their own process tree. Takeover of another launcher's gateway uses the same scoped marker.
- Verified: a clean drain ("Gateway stopped", exit 0) on a throwaway home, twice, with the live install as control. Its `gateway-starts.log` count stayed at 40 and it stayed healthy. Written up in `docs/FRAGILE_SEAMS.md`.

**Phase 8: packaging (partly done; needs your go-ahead for the rest).**

- `apps/desktop/electron-builder.config.cjs` builds an MSIX: Electron app plus resources (the Hermes payload without its offline uv cache, the dashboard standalone server, bundled plugins, backup engine, provisioning script).
  - Signing is an allow-list (`build/sign.cjs`): only the app's own executable and the package are signed. Every payload binary stays as its publisher shipped it, as SignPath will require.
  - The test certificate is made with OpenSSL (`packaging/msix/make-test-cert.sh`) into a `.pfx` outside the repo. Nothing is added to a Windows certificate store.
- The shell now runs the payload's own Python with its site-packages on PYTHONPATH (upstream's approach), not the venv's `python.exe`, whose `pyvenv.cfg` names the build folder and would break once installed.
- Built: `Chief Command Center 0.1.0.appx`, 836 MB (from about 1.9 GB of payload). The app executable carries the test signature.
- Blocked: electron-builder's bundled `signtool` (2017) can't sign an MSIX on this Windows 11 PC ("A required function is not present"). A current `signtool` from Microsoft's SDK build tools on nuget.org is needed; that download is waiting for your OK. An unsigned MSIX can't be installed at all.
- Blocked: the clean-install test (Acceptance 1) needs Windows Sandbox (not enabled here), or this PC trusting the test certificate. Both are admin/security changes for you to make.
- Found and noted: electron-builder prints the certificate password in its failure output. The local log was deleted, and the test certificate will be regenerated before any build is shared.

**Phase 10: updater and signed release manifest (code and tests; the install hand-off needs the packaged app).**

- `packaging/release/release-tool.mjs`: `keygen` (Ed25519, private key refused inside the repo), `make` and `verify`.
  - `make` writes `release.json`: version, package size and SHA-256, Electron, the Hermes pin and patch hashes, plugin versions, and data schema and minimum reader. It signs over the exact bytes into `release.json.sig`.
  - The closed-phase public key is pinned in `apps/desktop/src/release-key.ts`. It is to be replaced by your offline key before going public.
- `apps/desktop/src/updater.ts`:
  - Check: a folder feed. A failed check says why and never claims "up to date".
  - Signature check: verified against the pinned key before anything is downloaded.
  - Download: with resume, SHA-256 verified; a mismatch or an oversize file is deleted. Disk space is checked first.
  - Install: never interrupts a turn unless the owner picks "Install now". A backup comes first and a failed backup stops the install. Then Chief is stopped, and the hand-off to Windows is `Add-AppxPackage` plus relaunch, via `-EncodedCommand`.
- First start of a new version: a local backup before Hermes starts (`chief_backup --kind pre-update --local`), and `lastVersion`/`dataSchema` are recorded. An older app refuses data with a newer schema and points to the pre-update backup.
- UI: the "Update available — install?" card (versions, size, notes; Install / Later / Skip this version; busy choices: wait, Install now, Later) floats over the dashboard and sits in Settings → Updates with the update source. It is shown only in the desktop app.
- Tests: updater 10 cases (success, up to date, skip, offline, bad signature, tampered manifest, truncated then resumed, checksum mismatch deleted, oversize, disk full, busy policy, failed backup, failed Windows install); update card 5.
- Not yet shown: the real Windows install and relaunch, and locked-file or interrupted-apply behavior. These need the signed package installed (see Phase 8).

**Phase 11: upstream tracking (tooling and workflow; no upstream release newer than the pin yet).**

- Adjusted from the plan: no public fork while the repo is closed. A GitHub fork of a public repo is public, so this repo's `hermes/pin.json` plus `hermes/patches/` act as the fork.
- Tools:
  - `packaging/upstream/candidate.py`: the latest upstream stable release versus the pin.
  - `prepare_source.py --commit`: a candidate plus the patch queue; a failing patch exits 3 and is named.
  - `packaging/upstream/compat.py`: the compatibility suite on a built payload. It covers plugin import (with private Hermes names listed for review), the providers, persona, Second Brain and speech-model contracts, the bridge unit tests on the payload interpreter, and a gateway smoke on a free port with its own lock (health, snapshot, transcript, setup, voice, persona, token enforcement, scoped graceful stop).
  - `update_pin.py`.
- `.github/workflows/upstream.yml`: a daily poll. A newer release that no PR or issue covers yet is patched, built on Windows, and run through the suite. It passes as a candidate PR moving the pin, or fails as a "Blocked Hermes upgrade" issue that keeps the last good pin.
- Evidence: the suite passed 8/8 on the current payload. The one private name used is `hermes_cli.default_soul._normalize_soul`, listed for review. `candidate.py` reports v2026.9.24 = the pinned base, so nothing is newer.
- Tests: web 268 passed (4 live skipped), desktop 28, Python 56 + 20, privacy scan clean.


**Phase 9: migration, read-only preflight only.**

- `packaging/migrate/preflight.py` reads an existing install and changes nothing. It covers profiles and databases, backup size against free space, scheduled tasks, Startup items and processes, ports, plugin copies the bundled ones would replace, and absolute paths in config and routines. The report names personal paths, so the tool refuses to write it inside the repo.
- Run against the existing install (report kept outside the repo):
  - 15 profiles; the live gateway is up.
  - One guard task and four Startup items to hand over.
  - About 2.2 GB to back up. E: has room; C: is tight at about 11 GB free.
  - A 12.4 GB `crash-dumps` folder, now always left out of backups (machine-local diagnostics; not touched).
- The migration itself waits for a time the owner picks. It starts with a full backup and changes supervision only with consent.

**Phase 8 continued (2026-09-30, with the owner's go-ahead for the SDK tools).**

- Signing uses `signtool` from Microsoft's `Microsoft.Windows.SDK.BuildTools` 10.0.28000.2705 (nuget.org, Microsoft-signed), via `SIGNTOOL_PATH`. The hook builds its own arguments: one timestamped SHA-256 signature, on the app executable and the package only. Its errors never echo the command line.
- The test certificate was regenerated, because the old password had reached a local log. The new build log contains no password.
- `apps/desktop/build/appxmanifest.xml`: file and registry write virtualization are off (`unvirtualizedResources`), so the app's data lives in the real `%LOCALAPPDATA%\ChiefCommandCenter` and survives an uninstall (PLAN §5). Upstream Hermes Desktop does the same.
- Built `Chief Command Center 0.1.0.appx` (835 MB). The signature verifies apart from the untrusted test root, which is the owner's one-time trust step.
- Held by the owner: migrating the existing install (Phase 9) and going public (Phase 12). The installed app is used as a separate fresh build for testing.
- Installed on this PC (the owner trusted the test certificate).
  - The first install found electron-builder had dropped the standalone server's `.next` and `node_modules` (it skips them inside a resource folder silently); they are now listed explicitly. The payload was checked file by file: complete.
  - `--quit` stopped the installed app cleanly ("Gateway stopped").
  - Remove and reinstall kept the app's data (write virtualization off works).
  - The installed app runs: dashboard 200 on 3001, and its own gateway healthy on 7791 with `profile: chief`, waiting for a model (onboarding).
  - The existing install was untouched throughout: 401 on 7790, its gateway start count unchanged at 40, no new log lines.

**First-use fixes: chat controls, fleet management, models and keys (2026-09-30, plan `PLAN-2026-09-30-fleet-and-chat-controls.md`).**

- Two UI fixes. The message box no longer shows a red focus ring. The ElevenLabs key box opens only when you click it.
- Chat controls, through Hermes's own gateway commands:
  - **Stop** button (and Esc) ends the chief's current turn (`/stop`).
  - While the chief works, **Enter adds to the current work** (Hermes's steer mode, set at provisioning only if the owner hasn't chosen a mode). The text lands after the chief's next tool call.
  - **Send after** (Alt+Enter, or the clock button) holds a message until the turn ends. Held messages show as chips with "Add now" and "Remove".
  - Messages added mid-turn are marked "Added while working" in the thread.
  - In the first minute after start, the bridge waits up to 15 s for the chat adapter instead of failing a send.
  - Contract: `run_chat_controls_contract.py`, 16 checks on a real gateway with a scripted model. Covered: stop mid-tool, steer lands mid-turn, queue runs after.
- Fleet management for every chief (`fleet.py`, contract `chief.fleet.v1`):
  - The chief has tools for its team: `fleet_roster`, `fleet_models`, `fleet_mint`, `fleet_set_model`, `fleet_retire` and `fleet_restore`. Bundled skills `fleet-builder` and `fleet-ops` carry the doctrine: interview the owner, draft a SOUL, get it signed before minting, hand work over through kanban.
  - A mint refuses without the owner's sign-off. The new bot gets the chief's model and its own working folder, and is placed on the team.
  - Retire refuses while the bot is working. It archives the profile with Hermes's `export_profile` (no keys in the archive), then removes it. Restore brings it back; "Remove for good" deletes the archive after a second confirmation.
  - Hermes's `delete_profile` and command wrappers are never used: they act on names machine-wide (`FRAGILE_SEAMS.md`).
- In the app:
  - Each bot's Look drawer, under Job, has a **Model** dropdown listing every model of every connected provider. Expensive models ask first.
  - Workers have **Retire…** with a confirmation.
  - Fleet has a **Team** sheet. It holds "Propose a specialist" (sends the request to the chief) and the retired bots, with Restore and Remove.
  - Settings has **Models & keys**:
    - It lists the connected providers and marks the one the chief uses.
    - **Add or replace a key**, or add a local endpoint, without switching the chief's model.
    - A saved key can be removed, except the chief's own. A sign-in Hermes finds elsewhere on the PC (for example GitHub Copilot through the GitHub CLI) is labelled as such and isn't offered for removal.
- Evidence:
  - The compatibility suite passed 10/10 on the payload, now including the fleet contract (about 40 checks) and chat controls.
  - Checked in the browser against a throwaway gateway: mint, model dropdown, retire, Team sheet, restore, Models & keys.
  - Tests: web 279 passed (4 live skipped), desktop 28, Python 57 + 20, privacy scan clean.
  - The existing install was untouched: same process on 7790, gateway start count still 40.
- Built `Chief Command Center 0.1.1.appx` (about 896 MB). The signature verifies (SHA-256, timestamped), and the build log contains no password. The package was checked for the fleet plugin, both skills, the Models & keys UI and the standalone server's `next`. The owner installs it themselves, as a fresh build.

**Hotfix: nothing the gateway sends is hidden (2026-09-30, plan `PLAN-2026-09-30-second-brain-fleet-health.md` §3.0).**

- The bug: the owner saw Chief "thinking" for over 15 minutes.
  - Chief's turn had finished in 17 s. It ended by asking a multiple-choice question with Hermes's `clarify` tool, then waited (up to an hour) for the answer.
  - The question went to the adapter outbox, which no dashboard shows. So did Hermes's "⏳ Working" notices and its "no home channel" notice.
- The chief's questions now show as a card in the chat.
  - Tap a choice, pick several and Send (multi-select), or "Something else…" to answer in your own words.
  - Typing in the message box answers it too. The box says "Answer Chief…", and the header says "Has a question for you".
  - The phone gets a push, and voice mode reads the question out.
  - Answered questions stay in the thread as the question and its answer.
  - Bridge: the open question comes with the transcript long-poll, and `POST /clarify` answers it through Hermes's own resolver.
- Notices (scheduled-job results and gateway notices) show in the thread in time order, labelled. A busy notice is never shown and never pushes to the phone.
- Live steps: the thinking row says what Chief is doing ("Checking the team…", "Reading your Second Brain…"), from Hermes's per-tool status hook, with a fallback to the database.
- The owner's chat is the home channel (provisioning and the adapter default), so scheduled jobs have a place to deliver.
- A new profile's config gets Hermes's schema version before anything else is written, so the first-start migration no longer skips.
- Evidence:
  - The real-gateway contract passes 28/28, now including questions (a choice, a stale id refused, a typed answer, the question and answer kept) and live steps.
  - The web UI was checked in the browser on desktop and phone against a throwaway gateway.
  - Tests: web 287, desktop 28, Python 68 + 20, privacy clean.

**Second Brain first, and Second Brain parity (plan §3.1, §3.2).**

- **Bundled toolkit.** The public `obsidian-second-brain` toolkit v0.17.0 (MIT, Eugeniu Ghelbur) is vendored, with LICENSE, NOTICE and `vendor.json`, and built with its own Hermes build.
  - Provisioning installs it into the chief's profile: 36 skills plus the four routine blueprints. A file the owner edited is never overwritten.
  - Its helper scripts run on the app's own Python. `uv` would download packages, so it is never used.
  - The research skills (paid keys, large downloads) are left out.
- **Vault template v2.**
  - `AGENTS.md` gains a Folder Map (every kind of note to an app folder), the rules for notes agents write, and "search before you create, verify after you write".
  - The toolkit's files are added: `_CLAUDE.md` (a pointer to `AGENTS.md`), `CRITICAL_FACTS.md`, `index.md` and `log.md`.
  - Templates carry `date`, `tags`, `ai-first` and a "For future agent" section.
  - Today and Vault are unchanged.
- **Second Brain first.**
  - The `second-brain` skill is pinned into every conversation (`skills.auto_load`) with `CRITICAL_FACTS.md` inside it. It says to look in the Second Brain before answering from memory, and maps requests to the toolkit's skills.
  - A new `second-brain-writes` skill is the write gate: rules first, search, the Folder Map, properties, ask before big changes, log, read back and report. "Settled in chat but not written" counts as a failed write.
  - The default SOUL has a "Your Second Brain" section. An unedited earlier default is replaced; an edited SOUL is kept.
- **Routines.** Setting up the Second Brain arms morning note, nightly tidy, weekly review and health check as cron jobs that report to the app. Settings, then Second Brain, lists them with an on/off switch and a time.
- **Bots.** Minted bots get the same skills, auto-loaded, plus the folder and the chief's toolkit.
- **Upgrade.** A Second Brain set up by 0.1.1 is brought up to date when the bridge starts. Files are created only if missing, the Folder Map is appended to an app-made `AGENTS.md`, and the change is logged in the vault.
- **Evidence:**
  - The Second Brain contract passes on the payload. It covers setup v2, both skills, auto-load, routines (created, off, moved, recreated idempotently), the facts sync, upgrade from v1, sharing with a bot, and the SOUL refresh.
  - A rewritten toolkit script ran a real health scan on the app's Python.
  - Tests: web 289, desktop 28, Python 73 + 20, privacy clean.

**Fleet Health and self-improvement parity (plan §3.3).**

- The learning ledger is ported into the app (`hermes/plugins/chief-dashboard-bridge/ledger/learning_ledger.py`, standard library) with its 10 tests. It finds the Hermes root from the environment or from where it runs. The owner's and the chief's names are gone; proposal statuses say "the chief".
- `learning.py` arms three jobs in the chief's profile:
  - `Fleet: learning ledger`, every 30 minutes, script only;
  - `Fleet: lessons distill (weekly)`, the new generic `fleet-lessons-distill` skill: up to five proposals, never applied, plus a week's entry in `learning/LEARNINGS.md`;
  - `Fleet: roster review (monthly)`, a new section in `fleet-ops`.
  The bridge runs a first report at start, so Fleet Health has data at once.
- Fleet Health is on by default. The desktop app passes the report folder, the ledger and its Python to the dashboard, and the folder to the gateway, which pushes new flags to the phone.
- The chief gets twice Hermes's default memory (4400 / 2750 characters), as in the original install, unless the owner chose otherwise.
- `docs/SELF-IMPROVEMENT.md` compares every self-improvement piece in the original install with the app, and lists the original's one-person integrations that aren't bundled.
- Evidence:
  - The Fleet Health contract passes 9/9 on the payload: jobs armed once, a first report, a skill edit recorded, and the copied script run the way the cron job runs it. It is in the compatibility suite.
  - Tests: web 289, desktop 28, Python 83 + 20, privacy clean.

**End-to-end check on a throwaway gateway, and what it turned up.**

- **Upgrade from the old template.** A home set up under template 1 was upgraded at bridge start:
  - the new vault files and the Folder Map were added;
  - the unedited old default SOUL was refreshed;
  - the four routines and three Fleet jobs were armed;
  - a first Fleet Health report was written.
- **A fresh conversation's prompt**, captured at the scripted model, carries:
  - the SOUL's "Your Second Brain" section;
  - the auto-loaded `second-brain` skill (folder path, "Look here first", the critical facts, the write-gate rule).
  The system prompt grew from about 14.5k to 24.1k characters, mostly cached after the first turn.
- **Hermes's scheduler ran the ledger job** on its own (`status ok`), and a routine switched off in Settings paused its cron job.
- **Found and fixed: command confirmations.** Hermes asks before commands like `/new`, with a text fallback ("reply `/approve`, `/always`, or `/cancel`"). The newest such notice now shows those answers as buttons.
- **Found and fixed: stuck command bubbles.** A typed slash command is never a stored message, so it no longer leaves a "Sent" bubble waiting forever.
- **Found and fixed: unrelated crashes.** Fleet Health's runtime section counts only the app's own processes (Python, Hermes, Node, the app), not every program that crashed on the PC.
- **Polish:** the routine rows were restacked for the narrow Settings sheet.
- **Evidence:**
  - Compatibility suite 11/11 on the payload.
  - Tests: web 291, desktop 28, Python 83 + 20, privacy clean.
- Built `Chief Command Center 0.1.3.appx` (about 896 MB). The signature verifies, and the build log holds no password. The package was checked for the toolkit (`resources/vendor`), the ledger, the write gate, the distill skill, the command buttons and the crash filter. It installs over 0.1.1 or 0.1.2 with data kept; the bridge upgrades the Second Brain and arms the jobs at first start.

## 2026-10-01

**Threads with Chief, Team & Routines, a calmer Settings, names, and usage (plan `PLAN-2026-10-01-threads-routines-settings-usage.md`).**

- **Threads.** The chat header has a thread switcher. Each thread is a second chat id on the Command Center platform (`owner.t-<hex>`), so Hermes gives it its own session; memory, skills and the Second Brain are shared.
  - The menu shows each thread's state (working, a question waiting, unread) and offers New thread, Rename, Fresh start and Archive.
  - Sending, stop, steer, queue, questions and approvals all carry the thread. Replies push to the phone with the thread, and tapping the alert opens it.
- **Fresh start, history kept.** A fresh start sends Hermes's `/new` in that thread and answers its confirmation for the owner (the app asks first). The earlier conversation is listed under "Earlier in this thread" and opens read-only. It is refused while the thread is working.
- **Team & Routines.** The Team button became Team & Routines, with a Routines tab (bridge contract `chief.routines.v1`):
  - every routine for the chief and every bot, the app's own listed apart;
  - New routine: what it does, when (daily, weekdays, weekly with days, every N hours, or custom), who runs it, which thread it reports to;
  - edit, switch off, run now, delete (confirmed). The app's own routines can be retimed, moved or switched off, but not rewritten or deleted;
  - the last run's result, why it failed, and the latest report.
  Settings → Second Brain links to it.
- **Found and fixed: a bot's routine never ran.** Hermes blocks a job whose delivery platform its own profile doesn't serve, and bots don't serve the Command Center. A bot's routine is now saved as `local`. The bridge relays each new run's answer into the chosen thread, labelled with the bot ("Routine: Sam check-in (Sam)"); silent runs are skipped.
- **Settings** is one centred window. On desktop it has a category sidebar (General, Models & keys, Voice, Second Brain, Notifications, Usage, Backup & updates, About). On the phone it is a category list that drills into each page. It remembers the last category.
- **Names.** Chief and every bot can be renamed (name and role) from the pencil on the Look drawer, and Chief also from Settings → General. The SOUL's opening "You are …" follows unless unticked; the earlier SOUL stays in history.
- **Usage** (bridge contract `chief.usage.v1`):
  - a strip under the galaxy, switched on from the Fleet header: today, the month against the budget, and the top spenders;
  - Settings → Usage: period, spend, tokens, cache share, spend per day (with a table for screen readers), and breakdowns by bot and by model;
  - a monthly budget. The strip turns amber at 80 %, and one phone notification is sent per month at 100 %. Nothing is stopped. Sessions without a known price are counted as unpriced, not as free.
- **Polish found in the browser:**
  - bot faces in the galaxy no longer draw over Settings (the galaxy is its own stacking context);
  - the phone Fleet header keeps its controls on one line;
  - "Load earlier" no longer shows in a conversation with nothing earlier;
  - built-in routine names are capitalized and grouped ("Fleet Health", "Second Brain");
  - times are 24-hour, like the schedules.
- **Evidence:**
  - Chat-controls contract on the payload, all passing. It covers two threads working at once with separate transcripts; a question belonging to its thread; a fresh start with the earlier conversation readable; rename, archive and refusals; a bot's routine reporting into the main thread; and the chief's routine reporting into its thread only.
  - Routines contract on the payload, 24 checks passing, added to the compatibility suite.
  - Browser, on the throwaway gateway (7795):
    - created "Sam check-in" for Sam and ran it; its report arrived in the chat as a scheduled job;
    - a new thread answered separately and kept its title;
    - renamed Sam to Ada, with the profile title and the SOUL updated;
    - Settings window, Usage page and strip checked at desktop and phone sizes.
  - Compatibility suite 12/12 on the payload.
  - Tests: web 316, desktop 28, Python 88 + 20, privacy clean.
- Built `Chief Command Center 0.1.4.appx` (about 896 MB). The signature verifies, the build log holds no password, and the package holds the new bridge modules (threads, routines, usage) and the new app. It installs over 0.1.3 with data kept.
- **0.1.5:** the thread switcher moved from beside the name to the right of the chat header, next to the voice button. Its menu opens right-aligned. A long thread title truncates rather than the name or the status line (on the phone, the pill gives way first).
- **0.1.6:** the thread menu was cut off when the chat pane was narrow. It now sizes and places itself inside the pane's visible area. The pill keeps a minimum width, and a narrow pane's header tightens its spacing and drops the full-screen button (also in Settings), so nothing is pushed out.

**Two Second Brain formats; an existing vault is used as it is; Today reads Kanban boards (plan `PLAN-2026-10-01-second-brain-formats.md`).**

- **Setup asks for the format first,** then whether to start a new folder or use an existing one:
  - **Organized:** PARA folders, `📅` tasks in notes, rules in `AGENTS.md`;
  - **Agent-first wiki:** the toolkit's wiki-style layout. `raw/` sources, `wiki/` pages, Kanban `boards/` with task notes, a `drop/` folder, and the operating manual and write-gate in `_CLAUDE.md`.
  The same flow runs in onboarding and Settings. Settings → Second Brain shows the format and the rules file Chief follows.
- **A folder with its own rules file is used as it is** (`_CLAUDE.md`, or an `AGENTS.md` the app didn't write). Nothing is added, its format is detected and preselected, and a folder in the other format is pointed out with a one-click switch. Its routines are offered but left off. Chief's first task is to read its rules and say how he'll work with it.
- **Chief follows the format.** The always-loaded `second-brain` skill and the write gate come in two variants, and both name the vault's actual rules file. The wiki variant brings the full write-gate: sources first, fan-out, board ↔ task note, verify, `write-gate: PASS | PARTIAL`. The default SOUL now says "the folder's rules file". `WIKI_PATH` is set only for Organized.
- **New built-in routines for the wiki format**, written generically:
  - **Drop folder,** every 30 minutes. A script gate checks `drop/` first, so an empty folder never calls the model. It files one file per run with local readers only; anything that would need a download or a paid service is quarantined with a reason.
  - **Morning brief,** weekdays at 08:30, with up to five numbered questions. It is copied into the chat session, so Chief knows the questions when the owner answers. The chat hides that copy and shows the brief once, as a scheduled notice.
  - **Current Analysis,** as the last step of the nightly routine.
  Existing routines follow a folder or format change (prompt, skills, folder), and keep their times.
- **Today reads Kanban boards:**
  - columns from the headings;
  - `@{date}` due dates and 🔴🟡🟢 priorities;
  - the card's task note, plus its notes and blockers;
  - Done and cancelled cards.
  For the wiki format it reads boards only; `raw/`, `drop/` and templates are never task sources. Done, move and block from Today ask Chief to update the board and the task note together.
- **Earlier installs upgrade quietly:** a Second Brain set up before formats existed learns its format and rules file from the folder.
- **Evidence:**
  - Second Brain contract on the payload, all passing:
    - PARA as before;
    - a new wiki vault (layout, manual, boards, skills, six routines, the drop gate silent when empty and naming a waiting file);
    - an adopted wiki vault and an owner's own `AGENTS.md` vault, both byte-identical after setup;
    - switching back to PARA removes the wiki-only routines;
    - an earlier install upgrading to the right format.
  - A scratch copy of a real agent-first vault (782 files), set up in the browser:
    - "This folder has its own rules", nothing added (identical fingerprint before and after);
    - Chief's skill pointing at its `_CLAUDE.md`;
    - Today showing 44 open, 22 overdue and 1 waiting, the same as the vault's existing task service, board by board.
    The copy was deleted afterwards.
  - Browser: a new Agent-first wiki created from Settings, with Today showing its starter cards and Settings its six routines.
  - The brief, run on the throwaway gateway, reached the chat session and showed once, as a scheduled notice.
  - Compatibility suite 12/12 on the payload.
  - Tests: web 326, desktop 28, Python 89 + 20, privacy clean.
- Built `Chief Command Center 0.1.7.appx`. The signature verifies, the build log holds no password, and the package carries the wiki template, its five skills and the drop gate. It installs over 0.1.6 with data kept; an existing Second Brain learns its format at first start.

**Adopting an existing install (PLAN §5 "Existing install", the migration).**

- **The app can take over an existing Hermes install in place.** Its profiles, conversations, memory, SOUL, skills, routines, bots and absolute paths keep working; nothing is copied or moved. New desktop settings carry it: `adopted`, `learningDir`, `learningTool` (the install's own Fleet Health) and `backupDir` (keeps backups off a full system drive).
- **In an adopted install the app adds nothing beside the owner's own:**
  - provisioning keeps the install's own copy of the Second Brain toolkit (no profile copy shadowing it);
  - a bundled skill whose name the owner already uses anywhere is not installed (this now applies to every install);
  - the vault is recorded as using its own rules, with the app's routines off and not created, and no generic brief, drop or analysis skills;
  - the owner's write gate and `.env` settings are left alone;
  - Fleet Health arms no jobs;
  - bots keep their own setup.
  Turning one routine on later creates just that one, with its skill.
- **`packaging/migrate/adopt.py`** does the handover, journaled, with `--plan`, `--apply`, `--verify` and `--rollback`:
  - it refuses while Chief is working;
  - stops the app, disables the gateway's scheduled task and Startup item, and stops the old dashboard and the old gateway (planned-stop marker, scoped to its pid);
  - backs up the install;
  - moves the old `command-center` plugin aside and hands the bridge token over;
  - points the app at the install on the same ports, and starts it.
  Rollback restores the profile files the app changed from the backup, puts the plugin and launchers back, and restarts the old dashboard with its exact command line.
- **Evidence:**
  - Dress rehearsal on a full copy of a real install and its vault (2.7 GB, on another drive), running what the app runs at start. Only the bridge plugin, the `fleet-builder` and `second-brain` skills, `second_brain.json`, and three config values (the `fleet` toolset, auto-loading `second-brain`, steer while busy) changed. The 17 cron jobs, the SOUL and the vault (byte for byte) were unchanged; a second start changed nothing.
  - `--plan` on the live install read it correctly and changed nothing.
  - The Second Brain contract's new adopted section and two provisioning tests pass.
- Built `Chief Command Center 0.1.8.appx`. The signature verifies, the build log holds no password, and the package carries the adoption code (provision `--adopted`).

**The handover, done on the owner's install (2026-10-01).**

- `adopt.py --apply` ran with Chief idle:
  - backup to another drive;
  - launchers handed over;
  - old dashboard and gateway stopped;
  - old `command-center` plugin moved aside;
  - token handed over;
  - app pointed at the install.
  A dangling link in a language-server folder failed the first backup copy. That folder is now excluded, and `--resume` continues a part-done run from its journal.
- **Found and fixed: a fresh install's gateway was refused on a clean PC.** Hermes refuses a named profile's own gateway ("does not get a gateway of its own", exit 78) unless a Hermes launcher for that profile is registered on the Windows account. That check is per user, not per install, so the app had only worked on PCs where an older Hermes launcher existed. Provisioning now sets Hermes's documented opt-out, `gateway.standalone: true`, on the chief profile. Reproduced on a fresh home without it (exit 78), and the compatibility suite passes 12/12 with it.
- **Also found:** the packaged payload can't be run from outside the app (WindowsApps), so `adopt.py` takes `--payload-dir` (a build payload of the same commit). Windows reports a disabled task's state as `1`.
- **`--verify`, all passing:**
  - the app's gateway on the old port with the same token, running the app's Hermes;
  - chat bound, the team of 14 on the roster, history there;
  - the Second Brain used as it is;
  - no app routines added, and all 17 of the owner's on;
  - the dashboard on the old port, with Today at 44 open and 22 overdue from the boards;
  - Fleet Health reading the install's own ledger;
  - the old launchers off.

**Updates for a few testers: a private releases repository and a key per person (`docs/DISTRIBUTION.md`).**

- **Two release sources.** The updater now reads from either a folder or a private GitHub repository that holds only releases (`apps/desktop/src/release-source.ts`). A GitHub source:
  - finds the latest release's files;
  - downloads them through GitHub's redirect without passing the key on to the download host;
  - resumes partial downloads.

  Every release is still verified against the pinned Ed25519 key and the package against its signed digest, so a leaked key can't deliver a forged update.
- **The key** is a fine-grained, read-only token for that one repository, one per tester. It is pasted once in Settings → Backup & updates, sealed with Windows DPAPI in the app's secrets, and never shown again. A refused, expired or missing key gets a plain message saying what to do.
- **Downloads** go beside the backups when those were moved off a full system drive.
- **`release-tool.mjs publish`** uploads a made release (manifest, signature, package) to the releases repository as the latest release, with the `gh` login.
- **The releases repository was created,** private, and holds no source.
- **Tests:** desktop 33 (parsing; reading through the redirect without the key; refused, missing and empty-release messages; resume; a full check, download and verify from a fake GitHub), and the Settings key field.
- **Found and fixed: every update started with a minutes-long backup.** On the owner's install it was 2.5 GB and about six minutes, on each update. The backup before a new version guards against Hermes migrating the data, which can only happen when the bundled Hermes changes. The app now records the Hermes build that last opened the data (the payload's install stamp) and takes that backup only when the build differs. It keeps the two newest backups of that kind.
- **0.1.9 published** to the releases repository. With the app's own code against GitHub: the latest release found, its manifest verified against the pinned key, and the end of the package downloaded as a resumed range through GitHub's redirect.
- Built and published `0.1.10` (signature verified, no password in the logs) as the latest release in the releases repository; the owner's 0.1.9 offers it once its update key is set.

**The first in-app update, and what it turned up (0.1.11).**

- **Found and fixed: an in-app install could leave the app closed.**
  - 0.1.10 was downloaded from the releases repository with a key, and its backup ran. Then the app stopped Chief and handed the package to Windows, but the package wasn't installed and the app wasn't reopened.
  - The installer had been started as the app's own child process. Windows shuts the app's processes down to replace the package, and that took the installer with it.
  - The installer is now started through WMI (`Win32_Process.Create`), so it runs as its own process, confirmed under `WmiPrvSE.exe`.
  - It logs to `logs\update-install.log`, and in a `finally` it always reopens the app, updated or not.
  - The same package installed by hand without trouble.
- **The backup before installing is skipped when the release carries the same upstream Hermes** (`release.hermes.commit`). Different app patches on the same Hermes are still backed up at first start.
- **Settings → About shows the Hermes build** from the payload's install stamp ("2026.9.24 · upstream 41cd311 · 3 app patches"). The desktop app passes it, and the bridge reports it for development builds. A new row explains Hermes updates: Hermes is built into the app and never updates itself; a newer Hermes arrives as an app update after the compatibility suite passes, with a backup before its first start. About also finds an adopted install's own toolkit version.
- **The floating update card** has its own surface and sits at the top right, clear of the message box. Before, its "installing" line was drawn as bare text over the composer.
- Built 0.1.11 (signature verified, no password in the logs), installed it on the owner's PC by hand (0.1.10's own installer still had the flaw), checked About and Chief, then published it as the latest release.

**One-command releases and working notes (2026-10-01).**

- `npm run release -- --notes "…"` (`scripts/release.mjs`) does the whole release: checks, version bump, dashboard and signed MSIX builds, signature and password-in-log checks, signed manifest, commit and push, publish to the releases repository. `npm run release:plan` checks the setup without changing anything. Machine paths live in the git-ignored `release.local.json`.
- It refuses a payload whose Hermes (its install stamp) differs from `hermes/pin.json`, since the manifest describes Hermes from the pin while the package carries the payload.
- `CLAUDE.md` holds the rules, the release steps and the Hermes upgrade path for anyone (or any agent) working in the repo; this PC's specifics go in the git-ignored `CLAUDE.local.md`.

**Settings scrolls, usage follows the model, and a setup zip for testers (2026-10-01).**

- **Found: Chief "thinking" for a long time.** A one-word test sat for over 15 minutes. DeepSeek had an open incident: it accepted requests and sent only keep-alives. Hermes waits 600 s for a first token before retrying, up to 3 times. No app bug; switching Chief's model in the picker took effect on the next message. (Chief has no fallback model configured.)
- **Fixed: Settings couldn't be scrolled.**
  - The page's scroll area sat in a flex row whose height was never bounded (`flex-1` inside a block parent), so it never overflowed. Its `overscroll-behavior: contain` stopped the wheel reaching the Sheet's outer scroller.
  - The window's root is now `h-full`, the pattern the Look drawer uses. Desktop and phone both scroll the page under a fixed title and category list.
  - A click inside the page now focuses it, so Page Down, End and the arrow keys scroll it too, without a focus ring (`data-scroll-region`). A new category starts at the top, and the phone header gets a divider once the page has moved.
  - Checked in the browser at 1024×768 and 375×812 against a throwaway gateway.
- **Fixed: usage stayed under DeepSeek after switching Chief's model.**
  - The picker switches the live conversation, but Hermes's `sessions` row keeps the model the session started on. The usage page bucketed the whole conversation by it.
  - Usage now reads Hermes's per-model ledger (`session_model_usage`), which records each call under the model it used. Remainders beyond the ledger stay with the session's model. Rows are dated by their last call instead of the session's start, so a long conversation's recent spend no longer lands on (or before) its first day.
  - "By model" shows each model with its provider ("glm-5.3-flash · Z.AI / GLM").
  - The picker now says "Saved. It answers with this model from the next message." instead of "from the next conversation".
  - New contract `run_usage_contract.py` (in the compatibility suite) drives a mid-conversation switch through the real Hermes session store: 7 checks passed on the shipped payload.
- **Sharing with testers:**
  - Every release writes `Chief-Command-Center-setup-<version>.zip` (`npm run tester-kit` makes one for any build). It holds `Install Chief.cmd`, which checks the package's signature against the bundled certificate, trusts that certificate after one administrator prompt, installs or updates the app, and opens it.
  - Release builds now carry their update source, so a tester only pastes their key. `install-chief.ps1 -CheckOnly` checks a kit without changing anything: a good kit passed, and a mismatched certificate was refused.
- Tests: Python usage 5 (3 new: a switch, last-call dating, the remainder), desktop 35 (2 new: the built-in update source).
- **Released 0.1.12** with `release.mjs` (signature verified, no password in the logs) as the latest release, and its setup zip (844 MB). Found: in PowerShell, `npm run release -- --notes …` loses its flags in npm's wrapper; CLAUDE.md and DISTRIBUTION.md now say to run `node scripts/release.mjs` there.

**Settings → Phone, and the update history (2026-10-01).**

- **Found: phone access only worked by hand.** The owner's phone reached the app through a Tailscale Serve entry set up under the old install; the app never set one up. A new user would need about seven manual steps, including editing `desktop.json` to restrict who could open it. With no allow-list (the default), any login on the tailnet could open the dashboard. If port 3000 was busy at start, the dashboard moved and the phone's address pointed nowhere, silently.
- **Settings → Phone on the PC** is a guided setup that checks each step live (on focus, and every few seconds until done):
  - Tailscale on this PC (installed, running, signed in; Get Tailscale opens its download page);
  - a secure address (HTTPS certificates on; opens Tailscale's DNS page);
  - phone access: Turn on adds one Serve entry for the dashboard's port, leaving other entries alone, and returns Tailscale's consent link when the tailnet hasn't allowed Serve yet. Turn off removes only that entry. A moved port gets a Fix it.
  - Then the address with a QR code, the five phone steps (Tailscale from Google Play or the App Store, the same account, scan, home screen, alerts), who can open it ("Only you", the default the first time it's turned on, or anyone on the tailnet), and phone alerts (how many devices get them, Send a test alert).
- **Settings → Phone on the phone:** a real Install app button on Android Chrome (`beforeinstallprompt`), the Share → Add to Home Screen steps on iPhone (alerts stay off until it's opened from there, as iPhone requires), and turning alerts on or off for this phone.
- **Update history.** The app keeps every release description it has seen, exactly as signed (verified before it's kept), and fetches the rest of the published list with the update key. It records when each version first started on this PC. A small **History** pill in Settings → Backup & updates (and About) opens a timeline: version, release date, install date here, a Hermes tag when the bundled Hermes changed, and the notes. The phone shows the same list. After an update, a **What's new** note beside the update card shows that version's notes once per device, for two weeks.
- Fixed on the way: the not-allowed page told people to edit `.env.local` (a developer file); it now points to Settings → Phone. Removed mentions of `npm run doctor`, which belonged to the old install.
- Checked in the browser at desktop and phone sizes (with the desktop functions stood in): each setup step, Turn on, the QR code, who can open it, the History timeline (side panel and bottom sheet), and What's new.
- Tests: desktop 48 (13 new: Tailscale parsing, port choice, consent link, only-our-entry; the release cache, forged and tampered entries, install records, GitHub sync without sending the key on), web 341 (13 new: the Phone page on the PC and the phone, the history list and reader, What's new; plus the new proxy routes).
- Released 0.1.13.

**No chief's name in the code (2026-10-01).**

- **Found:** 476 mentions of the owner's own chief's name in 78 files: code names (the roster flag, the chat component and its file, the presence component, a CSS variable and a color token), comments, tests and docs. None was text shown on screen: every visible name already came from the chief's own profile. Two were real bugs for anyone else:
  - the bridge recognised the chief's row in an optional roster-notes file only when it carried that one name;
  - Fleet Health read an older ledger's "waiting on <name>" status correctly only for that name. It now reads either status with any name as the chief.
- **Renamed** to the chief throughout, with a typecheck catching every use: `isChief` in the bridge's roster and the dashboard together, `ChiefChat` (`chief-chat.tsx`, moved with its history), `ChiefPresence`, `--chief`, `text-chief`, `chat_inject` (the built-in Today ignores it). Comments say "the chief" (and "it"), and the tests use a sample chief named Nova, so a hard-coded name would fail them.
- **Saved values move over:** the last-known chief is kept under `chief-last-known`, and the record an earlier version saved is moved there once (recognised by its id). Phone alerts are tagged `chief-reply`.
- **Guard:** the name is on the private denylist, so `npm run privacy` (part of `npm run check` and every release) fails if it reappears; checked with a planted word.
- The owner's own chief is still called by its own name: that comes from its Hermes profile and SOUL, not the code.
- Checked in the browser: the chat's styles, the chief's color in its presence and the chat aurora, Fleet with the chief at the centre; no element or text mentions the old name.
- Tests: web 344 (3 new: the old status with any name, moving the saved chief record), desktop 48, Python 94 + 21.
