# Plan: a calm update, bots you can dress, and Hermes that never falls behind

Status: **proposed** (2026-10-07). Three asks from the owner, researched against the code and upstream.

## 0. Decisions (interview, 2026-10-07)

| Topic | Decision |
|---|---|
| Update flow | **Prepare while running.** Download, back up and unpack in the background with progress in the app; Chief keeps working. On *Restart*, a small branded popup covers a ~10–20 s close-and-reopen. |
| Bot looks | **All four:** a new *Bubble* style (Dots-inspired, our own design), Hermes's built-in faces (blob faces, 7 shapes × 10 colours), photo / AI portrait, pixel-pet companion. |
| Self-styling | **Chief may restyle itself and its bots** through a validated tool; the owner can always override in the editor. |
| Hermes pace | **Every stable release, after a 1–2 day soak on the owner's install**, then to testers with a plain-English "what's new". |

---

## 1. Updates: from "looks crashed" to a calm, branded progress

### 1.1 What happens today (root cause)

`apps/desktop/src/install-package.ts` hands the install to a PowerShell started by WMI (`Win32_Process.Create`) so it survives
`Add-AppxPackage -ForceApplicationShutdown`, then the app `app.exit(0)`s 1.5 s later. Three things make it look like a crash:

1. **The terminal.** Node's `windowsHide` only hides the *outer* PowerShell. The WMI-created inner one gets a fresh console
   (no `Win32_ProcessStartup.ShowWindow`), and on Windows 11 that console is handed to **Windows Terminal**, which
   `-WindowStyle Hidden` can't hide. It shows PowerShell's raw "Deployment operation progress" for the whole install.
2. **The gap.** Unpacking the ~3 GB package takes **84–102 s** (`update-install.log`), all of it *after* Chief has gone.
   Nothing branded is on screen; the relaunch appears behind other windows unless `bringToFront` wins.
3. **Silence on failure.** If `Add-AppxPackage` fails, the old version reopens with no card: the UI that would report it
   was gone before the result existed. Also: `spawnSync` freezes the main thread for up to 30 s before quitting
   (PROGRESS.md "not changed"), and the pre-update backup shows a static "Backing up…" with no progress.

### 1.2 Options considered

| Option | Verdict |
|---|---|
| Hide the console only (`Win32_ProcessStartup.ShowWindow=0` / `conhost --headless`) | Necessary as the **fallback**, not enough: still 90 s of nothing. |
| App Installer (`.appinstaller`) | Rejected: can't authenticate to the private releases repo, and drops our backup / busy / rollback logic. |
| `DeferRegistrationWhenPackagesAreInUse` / manifest `uap17:UpdateWhileInUse="defer"` | Rejected for now. `UpdateWhileInUse` needs Windows 11 24H2+ and Windows decides when it applies; deferred registration has a documented failure where forcing registration while the old Desktop AppX container is still alive leaves the app unlaunchable (`0x80070020`) until sign-out (see the Claude Desktop MSIX report in Sources). We take the lesson instead: **register only once the package is verifiably quiet.** |
| **Stage while running, register on restart, with a small native helper window** | **Chosen.** The slow part (staging: unpack, hash, lay down files) runs while Chief works and reports real `DeploymentProgress`. Downtime shrinks to stop → register (seconds) → relaunch. |

### 1.3 Design

```
 Chief running ─────────────────────────────────────────────┐  close ─ register ─ reopen
 [Download ▓▓▓▓] → [Back up ▓▓▓] → [Prepare ▓▓▓▓▓▓] → Ready │  ╭──────────────────────╮
   (card in Settings + a slim pill in the shell)            │  │ (face) Updating Chief│ → new Chief boot screen
                                                            │  │ 0.1.30 → 0.1.31  ▓▓▓▓ │
                                    "Restart now" / "When   │  ╰──────────────────────╯
                                     Chief's done"          │   Chief Updater.exe (outside the package)
```

**New: `apps/desktop/updater-helper/` → `Chief Updater.exe`.** C# on **.NET Framework 4.8 + WPF** (built into every
Windows 11, so no runtime to ship; ~100 KB). It calls `Windows.Management.Deployment.PackageManager` directly, so we get
typed progress and errors instead of scraping PowerShell. It has two modes:

| Mode | How it runs | What it does |
|---|---|---|
| `stage --job <json>` | Hidden child of the app; prints JSON lines on stdout | `StagePackageByUriAsync(msix, {ForceUpdateFromAnyVersion, TargetVolume})` → `{"phase":"staging","pct":62}`. Staging doesn't touch the running package. |
| `apply --job <json>` | Copied to `%LOCALAPPDATA%\ChiefCommandCenter\updater\` and started through WMI with `ShowWindow=SW_SHOWNORMAL` (a GUI exe, so there's no console) | Shows the popup → waits for the app to exit → **waits until no process runs from the package folder** (20 s, then force) → `RegisterPackageByFullNameAsync(staged, ForceApplicationShutdown \| ForceUpdateFromAnyVersion)` → if the staged copy is gone, falls back to `AddPackageByUriAsync(msix)` *with progress in the same popup* → launches through `IApplicationActivationManager` (comes to the front properly) → waits for the new app's **ready signal**, then fades out. |

**The job file** (written by the app into `<data>\updates\job-<version>.json`): msix path, staged full name, family name +
AUMID, target volume, from/to versions, the app window's bounds (to centre over it), the chief's colour, a PNG of the
chief's face captured from the dashboard at hand-off (so the popup shows *Chief's own face*), and the log path.

**The ready signal:** the new app writes `<data>\updates\ready-<version>` (and sets a named event
`Local\ChiefCommandCenter.Ready`) once its window is shown. If nothing arrives in 120 s, the popup says
"Chief is taking longer than usual" with *Open log* and *Try again*. If the AppModel refuses to start it (`0x80070020`
class), the popup says "Windows needs a restart to finish the update"; it doesn't pretend.

**Failure is never silent:** the helper writes `update-result.json` (ok / failed + message + which step). The next boot
reads it and shows a proper card ("The update to 0.1.31 didn't finish. You're still on 0.1.30. *Try again* /
*Details*"). The old version always reopens on failure.

**Fallback path** (helper missing, blocked by Smart App Control or antivirus, `ReturnValue ≠ 0`, or no "window shown"
heartbeat within 10 s): today's `Add-AppxPackage` script, but launched with `Win32_ProcessStartup.ShowWindow=0` under
`conhost.exe --headless`, so **no terminal ever appears**, and the card says beforehand "Chief will close for about a
minute and reopen by itself."

**App-side changes** (`updater.ts`, `main.ts`, `install-package.ts`, `update-card.tsx`):
- States become: `available → downloading → backing-up → preparing → ready-to-restart → handing-off`, plus `busy` /
  `error`. The pre-update backup moves into *preparing* and passes `onProgress` (real %). It runs while Chief works; the
  first-start backup on boot stays only as a safety net.
- `spawnSync` → async spawn (no more frozen window).
- The app exits *itself*, gracefully, after the helper reports its window is shown, instead of a blind 1.5 s timer.
- A slim **update pill** in the shell header ("Update ready · Restart") so it isn't buried in Settings; restart choices:
  *Restart now* / *When Chief's done* (reuses the existing busy logic).
- `prune()` also clears staged-but-abandoned packages (`RemovePackageAsync` on a staged-only full name) when a newer one
  supersedes them.

### 1.4 Look of the popup (design spec)

- 380 × 176, borderless, Windows 11 rounded corners (`DWMWA_WINDOW_CORNER_PREFERENCE`), **Mica dark** backdrop
  (`DWMWA_SYSTEMBACKDROP_TYPE`) with `#0F0F12` as the fallback, a 1 px `rgb(255 255 255 / .10)` rim, and a soft shadow.
  It's centred on the app's last window position, and it takes no focus from what you're typing elsewhere.
- Left: Chief's face (56 px) from the hand-off PNG, breathing gently (±1.5 %, 4.5 s). Right: **"Updating Chief"**
  (Inter Semibold 15, embedded under the OFL licence so it matches the dashboard) / "0.1.30 → 0.1.31" (Geist Mono 12,
  `#A1A1AA`).
- A 4 px progress track (`#232328`) with the fill in **Chief's own colour**. It eases toward the real percentage and
  never moves backward; it shows an indeterminate shimmer while Windows reports 0 %. The step line reads
  "Closing Chief…", "Installing…", "Opening Chief…".
- Taskbar progress through `ITaskbarList3` (the bar shows on the taskbar icon too); Chief's icon is in the taskbar and
  Alt-Tab.
- Accessible: UI Automation names, and progress announced as it changes. Honours "Animation effects" off (no breathing,
  no shimmer).
- The in-app parts use the existing tokens and components (`components/ui/*`, `lib/motion.ts`); the popup's colours are
  the same token values.

### 1.5 Build, sign, test

- `release.mjs` builds the helper (`dotnet build -c Release`, .NET 8 SDK targeting `net48`, already on the release PC),
  **Authenticode-signs it** with the package certificate via the configured signtool, and puts it in `extraResources`.
  The password stays out of logs (the existing guard covers the new call).
- **Note:** testers trust our certificate only in `TrustedPeople` (enough for MSIX, not for a standalone exe), so on a PC
  with Smart App Control on, the copied helper may be blocked. That's what the fallback is for. It's recorded as a
  fragile seam.
- **Tests:**
  - desktop vitest for the orchestration state machine with fakes (stage progress, busy, hand-off, helper-failed →
    fallback, `update-result.json` read on boot);
  - a test that the fallback launcher passes `ShowWindow=0`;
  - web tests for the new card states and pill;
  - the helper's own `--simulate` mode (fake deployment, real window), used by `npm run smoke` for a screenshot of every
    popup state;
  - a **real end-to-end update in Windows Sandbox** (this PC is Windows 11 Pro): install N, update to N+1 through the
    helper, assert the version and `ready`, never touching the live install.
- **Rollout caveat:** an installed app updates with the code it already has. The release that *contains* the new updater
  still installs the old way; the calm flow appears from the update **after** that one. Release notes say so. Ship the
  helper together with the release channels (§3.6) so both reach testers in one hop.

---

## 2. Bot looks: an appearance editor on Hermes's own metadata

### 2.1 What Hermes already gives us (in scope, no patch needed)

| Hermes mechanism | What it is | Use here |
|---|---|---|
| **`ui_meta["hermes-bots"]`** in each profile's `profile.yaml` + `assets/avatar.*` (Bot Mode, v0.21) | Per-bot look: `shape` (`blobatar:<seed>:<kind>`, 7 classic shapes…), `color`, `custom`, `imageKind`, `pet`. Written by `profiles.configure`, which merges by key with per-key compare-and-swap revisions, a 64 KB cap and atomic writes. | **The home for looks.** The dashboard already *reads* it (`data.py:list_roster`, `lib/bot-identity.ts`); nothing in Chief *writes* it yet. |
| Pets (`<profile>/pets/<slug>/`, petdex sprite sheets 8 × 9, 1100 ms loops) | A companion sprite per profile | Render beside the face; `Person.pet` already reaches the web app but isn't drawn. |
| Image generation (the bridge already uses Hermes's image tools) | Portraits | "Generate portrait" when an image backend is configured. |
| Skins (`display.skin`, `skins/*.yaml`) | Terminal / desktop **themes** (banner, spinner, colours) | **Not used for faces.** They don't describe a bot's avatar, and `branding.agent_name` changes relay reply prefixes. Left alone. |
| Personalities (`display.personality`) | Tone only | Optional later: a personality picker in the Look drawer. |

### 2.2 Storage and the write path

- **Hermes-native keys** go in `ui_meta["hermes-bots"]`, so Hermes's own Bot Mode shows the same (or the nearest) face.
- **Our extras** go in our own namespace, `ui_meta["chief"] = {"v": 1, "face": {...}}`. `ui_meta` is namespaced by app
  key by design, so this is in scope. A Bubble face is *also* written as its nearest Hermes blob
  (`blobatar:<seed>:<kind>` + colour + `custom: true`), so other Hermes surfaces still show a matching avatar.
- **Writes go through Hermes's own `_configure_ui_meta`**, added to `hermes_api.CAPABILITIES`, with no copy of its
  locking or revision logic. The compat suite flags it as a private name, as for the other private names.
- New bridge routes (token-gated like the rest): `GET /look/<id>` (look + revisions), `POST /look/<id>` (validated
  patch + expected revisions → `409` on conflict), `PUT /look/<id>/avatar` (PNG/JPEG/WebP ≤ 2 MB, re-encoded, written
  as `assets/avatar.*` like Hermes's `set_asset`), `POST /look/<id>/portrait` (generate), `GET /pets/catalog` (cached
  petdex manifest), `POST /look/<id>/pet` (install + select), `GET /pet/<id>/sheet`.
- **One schema** (Python `look_schema.py`, mirrored as a TS type with a parity test): styles, enums, colour format, and
  size limits. Anything unknown or malformed renders the hashed default, never a broken face (VISUAL-OVERHAUL §12).
- Hiring a bot (`fleet.py`) accepts an optional look, so new hires arrive designed.

### 2.3 The new Bubble style (our own, Dots-inspired)

The spirit of OpenAI's dots (a soft, floating, slightly 3D character with minimal eyes) in our own design language.
It doesn't copy their character (no green bean with diamond eyes as a default).

- **Body:** parametric soft silhouettes (bean, round, drop, pebble, cloud, tall), drawn as an SVG superellipse family
  with squash/stretch as one parameter.
- **Material:** a radial body gradient (lit top-left), a specular highlight, a rim light in a lighter tint, an inner
  shadow, and a contact shadow below that shrinks as it floats up. It reads as an *object*, at 0 WebGL (the phone
  budget is preserved).
- **Eyes:** dot, oval, diamond, happy arc, sleepy line; optional cheeks. Pupils follow the existing attentive-gaze and
  cursor logic.
- **Motion** on the shared face clock (zero React renders):
  - idle: float (3–4 s) with natural blinks;
  - thinking: eyes up, and three dots orbit (echoing Hermes's "three animated dots");
  - working: a quicker bob and a lean;
  - speaking: squash to the TTS amplitude;
  - celebrating: a hop with squash-and-stretch;
  - asleep: closed arcs and slow breathing.
  - Reduced motion gives static state colours.
- **Colour:** the 10-hue family palette plus a custom colour with a contrast guard (`glowColor`). The chief keeps its
  crimson halo whatever body it wears.

### 2.4 The editor (Look drawer → *Appearance*)

- A large **live preview** (tap to cycle states: idle / thinking / working / speaking / asleep), shown next to a small
  chat-header-size preview.
- **Style** segmented control: *Bubble · Blob · Shape · Photo*. Each shows only its own controls:
  - silhouette chips;
  - eye chips;
  - colour swatches and a custom picker;
  - *Randomize* and *Lock*;
  - *Upload* / *Generate portrait* (that one is hidden without an image backend).
- A **Companion** row: a pet gallery with thumbnails, or *None*.
- *Save* (optimistic; a conflict shows "Changed elsewhere, showing the latest") and *Reset to default* (removes our keys,
  back to the hashed identity). Every face in the app updates within one poll.

### 2.5 Chief can restyle

- A new fleet tool `set_bot_look(profile, style, color, silhouette, eyes, pet)` registered by the bridge (next to the
  existing fleet tools), validated by the same schema and written through the same path. No approval prompt: it's
  cosmetic and reversible. Each change lands in the fleet activity feed ("Chief gave Ivy a teal bubble"), so it's never
  invisible.
- Hiring also takes an optional look, so Chief can give each new specialist its own.

### 2.6 Tests

- Python:
  - schema validation and its fallbacks;
  - compare-and-swap conflicts through the real `_configure_ui_meta`;
  - the avatar re-encode and size cap;
  - the tool handler;
  - a contract script added to `compat.py` (round-trip a look on a throwaway profile).
- Web:
  - the editor (each style, conflict, reset);
  - Bubble renders every state with zero React commits per frame (the face-clock guard);
  - roster churn with new looks;
  - the reduced-motion path.
- Capture tool: a gallery of every style × state, desktop and phone.

---

## 3. Keeping up with Hermes

### 3.1 Where we stand (2026-10-07)

- **We are on the newest stable Hermes**: v2026.9.24 (v0.21.5). Upstream's stable releases came every 3–7 days in
  September; there's been none for 13 days, while `main` has moved **5,427 commits** past our pin. The next stable will
  be large.
- The daily workflow (`upstream.yml`) runs and works. It has simply never seen a newer release, so **no upgrade has gone
  through it yet** (ROADMAP phase 11's bar, "one real upgrade shipped", is still open).
- **Patch 0004 will break on that release:** upstream rewrote the PATH code it patches (`pm/environments.py`, upstream
  `42941c0a37`), while the bug it fixes is still there.
- **How features reach us:** everything inside Hermes (agent, tools, gateway, cron, models) arrives automatically with
  the pin. **What can be missed are features with a face:** Hermes's own desktop UI gains them, but our dashboard *is*
  the UI, so each needs a deliberate decision. Bot Mode avatars are the example in §2: Hermes shipped them in August,
  and Chief only reads them.

### 3.2 Fix now: refresh patch 0004

Rewrite 0004 against the new `prefix = [...]` code on upstream `main`, keep the old one for the current pin, and check
that it applies on both (`prepare_source.py --commit <main>`). Then open an upstream PR (§3.7).

### 3.3 An early warning, not a release-day surprise

A new nightly job, **`upstream-drift`**, runs against upstream `main` *and* the newest `rc.*` tag:
1. apply our patches;
2. `hermes_api.run_check()` (the names the bridge uses);
3. a fast compat subset.

It keeps **one** pinned issue, "Upstream drift", updated in place: green, or exactly which patch or name broke and the
upstream commit that did it. We fix things in the quiet days before a release, so release day is boring.

### 3.4 Upgrade PRs that explain themselves

The "Upgrade Hermes to <tag>" PR body gains:
- upstream release notes and the compare link;
- **"Touches our seams"**: upstream commits in the range that change files our patches touch, modules in
  `CAPABILITIES`, `state.db` tables we read, or the wording we match (from FRAGILE_SEAMS);
- **"Feature radar"**: user-facing features in the notes, each marked *arrives automatically* / *needs dashboard work* /
  *not relevant*.
  - With an `ANTHROPIC_API_KEY` secret, Claude drafts the radar and a two-line tester note (`claude-sonnet-5-5`, about
    a cent per run).
  - Without the key, the deterministic sections still fill.
- The radar's *needs dashboard work* items become issues, so features with a face aren't missed again.

### 3.5 One command to build an upgrade locally

`npm run hermes:upgrade -- <tag>`:
1. `prepare_source` into `E:\ChiefBuild\hermes-src-<tag>`;
2. `stage` (finds or makes the 3.14 venv from the current payload's own Python);
3. `compat`;
4. point `release.local.json` at the new payload (the old one stays as the fallback);
5. print the release command with drafted notes.

It refuses a dirty tree, so payloads stop being built `dirty: true`.

### 3.6 Release channels: the owner soaks first

- `release.mjs --channel early` publishes as a GitHub **prerelease**. Testers' apps read `/releases/latest`, which
  ignores prereleases, so **they don't see it**.
- The owner's app gets *Settings → Updates → Early updates* (on), which reads `/releases` and takes the newest
  *verified* release, prereleases included.
- After 1–2 days, `npm run release:promote -- 0.1.N` flips it to latest and testers get it. There's no rebuild: the same
  signed bits, the same manifest.
- The release flow becomes: auto PR → merge → `hermes:upgrade` → `release --channel early` → soak → `promote`.

### 3.7 Shrink what can break

- **Send patches upstream.** 0001 (gateway breakaway), 0002 (Bot Chat temp dir) and 0004 (venv launchers) are generic
  Windows bugs. Each accepted upstream PR deletes a patch and a release-day risk. 0003's `HERMES_BIN` may stay ours.
- **Workflow fixes:**
  - compare commits as well as versions, so a forced run can never *downgrade* the pin (the candidate must contain the
    pinned commit);
  - retry a blocked tag automatically when our patch set changes (key the "already seen" check on a hash of the patches);
  - use the uv cache and `requirements-dev.txt`;
  - retry the flaky "chat controls" check once before calling an upgrade blocked;
  - set up the GitHub App so CI runs on upgrade PRs.
- **The long-term direction (not in this plan):** the bridge imports ~84 Hermes internals (some private) and reads
  `state.db` with raw SQL. Hermes now has REST profile routes, typed JSON-RPC contracts and a desktop plugin SDK. As each
  is proven, move bridge calls onto public surfaces; the capability list stays as the tripwire.

### 3.8 Testers see what they got

The release manifest gains `hermes.highlights` (from the radar, edited by the owner). After an update that moved Hermes,
the app shows a one-time **"New in Hermes"** card with two or three highlights.

---

## 4. Order of work

| # | Phase | Scope | Effort | Why this order |
|---|---|---|---|---|
| A | **Hermes readiness** | Refresh 0004 (§3.2), the drift job (§3.3), the downgrade guard and retry fixes (§3.7) | ½–1 day | Time-critical: a 5,000-commit release is imminent and 0004 won't apply. |
| B | **Calm updates + channels** | The helper, staging, hand-off, fallback, card and pill, `update-result`, tests, sandbox end-to-end (§1); release channels and `promote` (§3.6) | 3–4 days | Testers' biggest pain. Both need installed code, so they ship in **one** release. |
| C | **Bot looks** | The write path and schema, editor, Bubble renderer, pets, portrait, Chief's tool (§2) | 3½–4½ days | Builds on the existing face system. |
| D | **Upgrade ergonomics** | PR enrichment and radar (§3.4), `hermes:upgrade` (§3.5), "New in Hermes" card (§3.8), upstream PRs (§3.7) | 1½–2 days | Best landed before the first real upgrade goes through. |

Each phase is shippable on its own, with `npm run check` green, a PROGRESS.md entry, and new seams in FRAGILE_SEAMS.md.

## 5. Risks and new fragile seams

| Risk | Mitigation |
|---|---|
| Smart App Control or antivirus blocks the copied helper exe | Heartbeat timeout → headless PowerShell fallback; the card still explains the restart. |
| Staged package removed by Windows before restart (cleanup, reboot) | `apply` falls back to `AddPackageByUriAsync` from the kept `.msix`, with progress in the popup. |
| Register while the old container is still alive (`0x80070020`) | Quiescence wait for package processes; on AppModel refusal, the popup says to restart Windows. Never a silent loop. |
| Hermes changes `_configure_ui_meta` or the `ui_meta` layout | It's on the capability list (tripwire), with a compat contract round-trip of a look. |
| Hermes desktop sees `ui_meta["chief"]` | It's an unknown namespace, so Hermes ignores it; the Hermes-native fallback keys keep its face sensible. |
| Prerelease channel confuses `/releases` ordering | Pick the highest *verified* version, never the first in the list; tested. |

## 6. Sources

- [Microsoft: MSIX servicing while in use (`uap17:UpdateWhileInUse`)](https://devblogs.microsoft.com/insidemsix/msix-servicing-while-in-use/)
- [Add-AppxPackage (`-Stage`, `-DeferRegistrationWhenPackagesAreInUse`)](https://learn.microsoft.com/en-us/powershell/module/appx/add-appxpackage)
- [PackageManager.AddPackageByUriAsync and DeploymentProgress](https://learn.microsoft.com/en-us/uwp/api/windows.management.deployment.packagemanager.addpackagebyuriasync)
- [Claude Desktop MSIX: forced registration into a live AppX container (0x80070020)](https://github.com/anthropics/claude-code/issues/89687)
- [Hermes: Skins & Themes](https://hermes-agent.nousresearch.com/docs/user-guide/features/skins)
- [Hermes: Bot Mode (avatars, blob faces, pets)](https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode)
- [Hermes releases](https://github.com/NousResearch/hermes-agent/releases)
- [TechCrunch: OpenAI launches Dots](https://techcrunch.com/2026/09/29/openai-launches-dots-its-bubbly-agentic-avatar/)
