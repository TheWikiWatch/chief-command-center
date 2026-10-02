# Architecture and design review: the plan (2026-10-01)

Status: **proposal, awaiting approval.** Nothing below is implemented yet.

A whole-codebase review: the dashboard (`apps/web`), the desktop shell (`apps/desktop`), the bridge plugin
(`hermes/plugins/chief-dashboard-bridge`), backup, packaging, release and CI. It also looks at the running app
(phone and desktop captures from the throwaway e2e home) and checks the stack against current (Oct 2026) versions and
practice.

Decisions from the interview:

| Topic | Decision |
| --- | --- |
| Design priority | **Equal weight** for phone and desktop. Every visual change is designed and checked on both. |
| Theme | **Dark only** (unchanged). |
| Modernization | **Aggressive.** Current majors, a headless primitive library, a new data layer. The Vite rewrite was considered and rejected; see §2.6. |
| Release timing | **Testers only for now.** Real security holes first, then UX and visuals, then reliability. Public-release work (signing, SBOM, smaller updates) comes last. |

## 1. Verdict

The base is strong. The parts that are hard to get right are done carefully and are well tested:

- Process supervision and gateway isolation (scoped stop, its own lock folder, a curated environment).
- Backup crypto and journaled restore, and the signed release manifest.
- No shell spawning, and safe vault paths.
- The face clock (one rAF loop, zero React commits), and an honest degraded state everywhere.

Measured on the captures: 60 fps with no long tasks, even with the CPU slowed 4×.

The weaknesses are of four kinds:

1. **A few real security holes** at the trust boundaries: the Electron origin checks, the agent seeing the bridge token, the IPC calls, and what the loopback trusts.
2. **Efficiency debt in the live-data path.** Everything is polled. The bridge re-reads files and databases on timers. Every new message re-renders the whole thread.
3. **Organization debt.** Four god components of 700–1,500 lines, a thin `ui/` folder (29 copies of the primary button and 31 of the input), no lint, and a 750-line `main.ts`.
4. **A visual layer that is clean but flat.** It repeats the same bordered card, leaves desktop width unused, keeps the stock Windows title bar, and shows raw cron headers and Discord-era leftovers.

## 2. Findings

Severity: **H** high, **M** medium, **L** low. Evidence is `file:line` at commit `741aec0`.

### 2.1 Security

| # | Sev | Finding | Evidence |
| --- | --- | --- | --- |
| S1 | H | **Electron origin checks compare string prefixes.** `http://127.0.0.1:<port>@evil.example/` and `http://127.0.0.1:<port>1/` both pass. An allowed popup inherits the preload, so the remote page gets the whole `chiefDesktop` API (phone access, update feed, including UNC paths that leak NTLM hashes, restore, install). The permission handler has the same flaw. | `apps/desktop/src/main.ts:416-421,731` |
| S2 | H | **The agent's own commands inherit the bridge token.** `CHIEF_DASHBOARD_TOKEN` stays in the gateway's environment. Hermes's child scrub doesn't know the name, which was checked against the pinned Hermes: `_sanitize_subprocess_env` and `hermes_subprocess_env` both keep it. A prompt-injected agent can `curl /approve` on its own dangerous-command prompt, defeating approvals. It can also call `/setup/key`, `/settings` and `/fleet/retire`. | `apps/desktop/src/main.ts:147`, `hermes/plugins/chief-dashboard-bridge/__init__.py:63-66` |
| S3 | H | **IPC handlers never check the sender, and arguments are barely checked.** For example, `phone:enable` accepts any port, `updates:setFeed` accepts any path or share, and `will-navigate` allows any `file:` URL. | `apps/desktop/src/main.ts:421,582-650` |
| S4 | M | **No Electron fuses and no ASAR integrity.** RunAsNode, `NODE_OPTIONS` and `--inspect` are all live. | `apps/desktop/electron-builder.config.cjs` |
| S5 | M | **Loopback trust.** Any local process (including another Windows user's session) can drive `/api/bridge/approve` and similar routes through the dashboard without the token. | `apps/web/middleware.ts:6-8` |
| S6 | M | **No content security policy and no `frame-ancestors`.** Over Tailscale, any site open on the phone can frame the dashboard and trick a tap on "Allow". | `apps/web/next.config.ts:44-51` |
| S7 | M | **`/file` is too broad.** Any path that appears in model output becomes servable, and the allow-list includes the Hermes root (`config.yaml`, `sessions/`, logs). `/profile/<name>` and `/avatar/<name>` aren't validated (`/profile/..`). | `data.py:754-777,820-849,1055`, `server.py:945-951` |
| S8 | M | **The phone can call backup routes that take PC file paths** (create folders, inspect and stage arbitrary files). | `apps/web/app/api/backup/[...op]/route.ts:36-135` |
| S9 | M | **The tester installer's signature check is circular.** It compares the signer to the `.cer` shipped in the same zip and never requires `Status -eq 'Valid'`. | `packaging/tester/install-chief.ps1:36-41` |
| S10 | L | **"Tailnet" mode admits any login**, including users of tailnets the node is shared with. | `apps/web/lib/tailnet-guard.ts:64` |
| S11 | L | **Small exposures:** the token is passed to backup and ledger Python children, the signtool password is on the command line, `vault/tree` returns the absolute root, `adopt.py` interpolates task names into PowerShell, and a Discord CDN request is made for custom emoji. | `backup.ts:65`, `fleet.ts:36`, `sign.cjs:38`, `adopt.py:320,453`, `lib/emoji.ts:15` |

Checked and fine:

- spawning (argument arrays, base64 PowerShell)
- the Ed25519 and SHA-256 update checks (the key is never sent across a redirect)
- vault traversal (realpath, drive letters, ADS)
- the bridge's loopback bind and `compare_digest`
- the backup crypto and zip-slip guard
- `contextIsolation`, `sandbox` and no `nodeIntegration`

### 2.2 Correctness and reliability

| # | Sev | Finding | Evidence |
| --- | --- | --- | --- |
| R1 | H | **A failed update install leaves Chief stopped.** `install()` failing after `stopChief()` never restarts it, and the WMI launch ignores `ReturnValue`, so a failed launch still quits the app. | `updater.ts:226-229`, `main.ts:342-346` |
| R2 | M | **Retry can start a second gateway.** `Supervisor.start()` launches over a running child, and `boot:retry` can re-run `boot()` concurrently. | `supervisor.ts:54-60`, `main.ts:607` |
| R3 | M | **No liveness probing.** A hung gateway or web server is never restarted. After 5 crashes the state is `failed` for good. | `supervisor.ts:91-97` |
| R4 | M | **Failures after boot are invisible.** No `did-fail-load` handling (a reload during a web restart sticks on a Chromium error page), and `render-process-gone` reloads without limit. | `main.ts:425,682` |
| R5 | M | **Backups run inside the web server**, which restarts for routine reasons (phone settings, updates). Children are orphaned and the job lock is lost. | `backup.ts:57-96`, `main.ts:528-532` |
| R6 | M | **Logs:** gateway logs rotate only at launch, and dashboard, desktop and update logs never rotate. No `unhandledRejection` handler and no crash reporter. | `gateway.ts:35`, `web.ts:29`, `main.ts:390-399` |
| R7 | M | **The outbox JSONL grows forever** and is fully re-read and parsed on almost every transcript response. | `outbox.py:21-63`, `chat_state.py:161-174` |
| R8 | M | **Blocking calls on the gateway's event loop:** a synchronous `urlopen` in async `_standalone_send`, file appends, and vault status I/O in the status callback. | `adapter.py:101,250-282`, `chat_state.py:309-371` |
| R9 | L | **Bridge request handling:** exceptions outside `_guarded` drop the connection, there's no socket timeout, `Range: bytes=-N` is misparsed, and there's an unbounded, unlocked media-path set. | `server.py:985-996`, `data.py:60,803` |
| R10 | L | **Wrong port in the status sheet.** It always says "Connected on 127.0.0.1:7790". | `apps/web/components/connection-status.tsx:94` |
| R11 | L | **The web health check depends on the gateway** (`/api/app/config` calls the bridge with a 3 s timeout, against a 2.5 s probe). | `web.ts:61`, `second-brain.ts:25` |

### 2.3 Efficiency

| # | Sev | Finding | Evidence |
| --- | --- | --- | --- |
| E1 | H | **Every new message re-renders every row.** `buildRows` makes fresh objects, so `memo(MessageRow)` never hits. Each row re-runs the Streamdown pipeline, up to 600 rows. | `chat/thread.tsx:71-127,182,400` |
| E2 | M | **Polling everywhere.** The health ping and the snapshot both run every 2.5 s, and the thread switcher and usage strip bypass `poll()` (and visibility). Hidden phone tabs keep polling, and Today alone sends 5 requests every 8–15 s. The bridge already has an SSE `/events` that nothing uses. | `command-shell.tsx:254-275`, `thread-switcher.tsx:70`, `server.py:415` |
| E3 | M | **The long-poll checks storage on a timer.** Every waiter checks every 0.5 s with new SQLite connections, although the adapter sees every event. `/snapshot` runs one SQL query per thread for a yes/no flag. | `server.py:243-259,533`, `threads.py:91-147` |
| E4 | M | **Today walks the whole vault three times per poll.** | `today-routes.ts:45`, `today-index.ts:295-330` |
| E5 | M | **Each keystroke re-renders the whole chat** (the draft lives in ChiefChat). | `chief-chat.tsx:100,260-270` |
| E6 | M | **No code splitting.** WebGL shaders, Settings, Onboarding, Usage, Fleet Health, the Vault and restore all ship in the first bundle. | `app/page.tsx`, `orbit-space.tsx:3` |
| E7 | M | **Uploads are buffered whole** in the proxy and in the bridge (an 80 MB send uses about 160–240 MB). | `app/api/bridge/[...path]/route.ts:39-41`, `server.py:1050` |
| E8 | M | **Updates:** every update downloads the full ~850 MB package, the update folder is never pruned, and progress is sent over IPC on every chunk. | `updater.ts:147,175` |
| E9 | L | **Cold start:** three Python cold starts run one after another before the gateway, the web server waits for the gateway, and Python likely recompiles every module each start (read-only MSIX, `__pycache__` excluded). | `main.ts:237-239`, `electron-builder.config.cjs:31,37` |
| E10 | L | **The payload carries dead weight:** `ffplay.exe` (158 MB, unused), static GPL ffmpeg ×3 (~470 MB), the `all` extra, and Google, Bedrock and Vertex. | `packaging/payload/selection.json:4` |

### 2.4 Code organization and quality

- **God components:**
  - `chief-chat.tsx`: 1,169 lines, 26 state, 31 refs, 23 effects.
  - `command-shell.tsx`: 23 state, 17 effects.
  - `settings-panel.tsx`: 1,465 lines, about 25 components in one file.
  - Also `today-pane`, `vault-pane` and `fleet-health`.
  - Many refs are written during render, which also blocks the React Compiler.
- **`ui/` is thin.** It has Switch/Segmented, Group/Row, Sheet, HoldButton and toasts. Repeated patterns: 29 primary buttons, 31 inputs, 45 cards, four local button components, 127 `bg-white/*` fills over seven unnamed steps, and ad hoc z-index values (40, 45, 60, 70, 75, 80, 90).
- **No lint at all**, but 16 `eslint-disable` comments. No Python lint or type checking.
- **The desktop `main.ts`** (753 lines) mixes boot, IPC, phone, tray, quit, install and env building, and none of it is unit-tested. "Run Python, parse the last JSON line" exists three times.
- **The bridge** has `server.py` at 1,298 lines with two if-chains of about 100 routes. The dashboard's proxy allow-list is a hand-kept duplicate of it. About 60 lazy imports reach Hermes internals (private modules, FastAPI handlers called directly, a monkeypatch, raw SQL). Most are wrapped in `except Exception: return None`, so a rename silently becomes "no data". For example, a missed approval prompt.
- **The real-Hermes contract tests (about 1.7k lines) never run in CI on plugin changes**, only when upstream moves.
- **The release script:**
  - The version bump is written before the build, and the push happens before publishing, so a failure leaves a half-released state.
  - There are no tags.
  - There's an undocumented `--skip-checks` flag.
  - The payload is checked against the repo only by upstream commit, not by patch hashes or the selection.

### 2.5 Accessibility

- **46 inputs, textareas and selects use `outline-none`**, so their focus is a faint border change (WCAG 2.4.7 and 1.4.11).
- **Voice mode, the lightbox and onboarding are `aria-modal` with no focus trap or restore.** The Sheet doesn't set `inert` behind itself.
- **Ten `role="tab"` buttons have no arrow-key navigation or `aria-controls`.**
- 11 ALL-CAPS labels remain, against the design system's rule.

### 2.6 Stack versus current practice (researched 2026-10-01)

| Area | Now | Current | Call |
| --- | --- | --- | --- |
| Electron | 44.5.1 | 44.5.1; 45 due ~Nov | Stay. Adopt `windowStatePersistence`, fuses and permission handlers. Check preloads for 44's clipboard change. |
| Next.js | 15.5 | 16.3 (Turbopack builds, cached builds, `proxy.ts`, +22% SSR throughput, much less dev memory) | **Upgrade.** |
| Rewrite to Vite SPA + small server | n/a | electron-vite 5 / Vite 8 | **Rejected.** The app needs a real server for the phone (bridge proxy, vault, push, backups, Tailscale identity). A rewrite would rebuild 30-plus API routes for little gain. Bundle size is better fixed with code splitting and a server-component page. |
| Tailwind | 3.4 | 4.3 (CSS-first `@theme`, OKLCH, Oxide) | **Upgrade.** All current component sources assume v4. |
| Primitives | hand-rolled | shadcn on **Base UI 1.8** (the default since Jul 2026), and React Aria | **Adopt Base UI** for dialog, menu, tabs, autocomplete, tooltip, select. Copy the source in, shadcn style. |
| Animation | motion 12 | Motion 13.5 (`LazyMotion`/`m`, `AnimateView`) | Upgrade. |
| Transitions | none | React 19.3 `<ViewTransition>` (stable) | Use it for surface and panel changes. |
| Chat UI kits | own | AI Elements (Tool, Confirmation, Reasoning), assistant-ui, shadcn `MessageScroller` | Borrow patterns and source pieces. Hermes isn't an AI SDK backend, so no runtime swap. |
| Markdown | streamdown 1.x | Streamdown 2.x loads Shiki and other assets **from a CDN** | Stay on 1.x until 2.x can be fully self-hosted under our CSP. |
| Command palette | none | `cmdk` is unmaintained, with open accessibility issues. Base UI Autocomplete in a Dialog is the 2026 pattern. | Build on Base UI. |
| Live data | hand-rolled polling | TanStack Query 5, plus one SSE stream (Tailscale Serve drops WebSockets every 10–40 s) | **Adopt both.** |
| Lint | none | ESLint flat config + `eslint-plugin-react-hooks` v6 (compiler rules) + jsx-a11y; `next lint` removed in 16 | Add it to `npm run check`. |
| Python tooling | none | Ruff 0.16, pyright, `uv audit`/pip-audit | Add. |
| Deps and supply chain | none | Renovate with `minimumReleaseAge`; OSV-Scanner; syft SBOM + `attest-sbom`; actions pinned by SHA | Add. SBOM and attestation wait until the public release. |
| E2E | none for the shell | Playwright `_electron` | Add a boot → chat → approval → quit smoke test. |
| Logs and crashes | ad hoc files | electron-log v5 rotation; `crashReporter` with `uploadToServer:false`; no remote telemetry | Adopt. |
| Signing (later) | self-signed | Azure Artifact Signing ($9.99/mo), SignPath Foundation (free; needs CI builds and public releases), or the Microsoft Store | A decision for the public-release phase. |

## 3. The visual and UX review

What works: the token system, Inter and Geist Mono, the approval sheet with hold-to-confirm, the phone tab bar, the chief's living face, the honest offline states, and the morning count-up.

What holds it back (from the captures):

1. **The window doesn't feel native.** It has the stock Windows title bar and a hidden menu bar. The app's own header sits under a second, grey header.
2. **Desktop width goes unused.** Today fills the top half of the left pane and leaves the rest empty. The Fleet orbit with one bot is a near-empty starfield.
3. **Box soup.** Stat tiles, rows, notices, scheduled jobs and settings rows are all the same bordered card, so nothing leads the eye.
4. **Machine text in the chat:**
   - The upstream "Cronjob Response: Fleet: roster review (monthly) (job_id: 87d1…)" is shown as a heavy heading.
   - Every delivery repeats "To stop or manage this job, send me a new message…".
   - Hermes restart notices stack as full cards.
5. **The header is crowded and technical.** "Voice · local / edge" gets truncated on the phone, and the waveform, dot, fullscreen and gear icons have no labels or shortcuts.
6. **Color identity is muddled.** The design system says "one crimson accent", but the chief's body is cyan and the orbit's rays are crimson.
7. **Leftover copy:**
   - "Does not change Discord" in Settings.
   - "System follows Android's remove-animations setting" on the desktop.
   - An owner-specific production strip hard-coded into Today (it ships to testers).
8. **No power-user layer:** no command palette, no keyboard shortcuts, no shortcut hints.
9. **Loading states differ:** skeletons in Vault and Fleet Health, "Reading vault…" in Today, a bare "…" in Settings.

## 4. The plan

Ten phases. Each step lands with its tests, `npm run check`, a `docs/PROGRESS.md` entry for anything a user sees, and a `docs/FRAGILE_SEAMS.md` line for any new trap. Visual steps also get before-and-after captures (phone and desktop) from the capture tool against the throwaway e2e home. Nothing touches the live install. Releases happen only when the owner says "ship it".

The order matters:

- Phase 0 closes the holes now.
- Phase 2 moves the platform *before* the design work, so new components aren't built twice (once on Tailwind 3 and again on 4).
- Phase 3 can run beside Phase 4.

Effort is in agent working days, with verification.

### Phase 0: Urgent fixes (≈1 day)

Small, contained changes that close the high-severity holes and the visible bugs.

1. **S1:** compare `new URL(url).origin === origin()` exactly in the window-open handler, `will-navigate` and the permission handler. Allow `file:` only for the boot page. Add tests with the `@` and port-suffix URLs.
2. **S2:**
   - Remove the token from the gateway's environment once the plugin has read it, and keep it in the module.
   - Register it in Hermes's terminal strip registry as a second guard.
   - Add a contract check that a terminal child doesn't see it.
   - Confirm the agent's file tools can't read it from disk (the plugin `.token` file), and deny that path if they can.
3. **S3:** one IPC wrapper `handle(channel, validate, fn)`. It checks `senderFrame` against the UI origin (or the boot page for boot channels) and validates arguments (Serve port in the allowed set; update feed is `github:` or a local absolute path, no UNC).
4. **R1:** after a failed install, restart Chief. Check WMI's `ReturnValue`.
5. **S7:** `/file` remembers transcript paths only under the media caches or with media extensions. Deny `logs/`, `sessions/` and `*.yaml` under the Hermes root. Validate profile names on `/profile` and `/avatar`.
6. **Leftovers:**
   - Remove the owner-specific Today strip. A pinned-metric idea can come later if wanted.
   - Fix the Discord and Android copy (motion text follows the platform).
   - Render Discord custom-emoji syntax as text, with no CDN request.
   - Show the real bridge port in the status sheet.
   - Fix the `plugin.yaml` description and version.
   - Mark `docs/design/VISUAL-OVERHAUL.md` as implemented and fix the paths that point at it.
7. **S9:** the tester installer requires `Status Valid` and an out-of-band thumbprint (shown with each person's key).
8. **Capture tool:** mock approvals through the transcript patch. Approvals now ride the transcript, so today's desktop approval capture shows nothing.

### Phase 1: Hardening in depth (≈1.5 days)

1. **S4:** electron-builder `electronFuses`:
   - `runAsNode:false`
   - `enableNodeOptionsEnvironmentVariable:false`
   - `enableNodeCliInspectArguments:false`
   - `enableEmbeddedAsarIntegrityValidation:true`
   - `onlyLoadAppFromAsar:true`
   - `enableCookieEncryption:true`
   - `grantFileProtocolExtraPrivileges:false`

   `utilityProcess` is unaffected. Verify with a packaged build on the throwaway data folder.
2. **Permission handlers:** default-deny request and check handlers on the session before the first window. Allow microphone and notifications only for the exact UI origin.
3. **S6:** a CSP (nonce from the proxy) plus `frame-ancestors 'none'` and `X-Frame-Options: DENY` on every response. Check that Streamdown, the shaders, media and the service worker still work.
4. **S5:** a per-launch session secret. The desktop sets it as an httpOnly cookie on the window's session, and the proxy requires it for direct-loopback requests. The phone keeps Tailscale identity.
5. **S8:** routes that take PC paths are desktop-only (direct loopback plus the cookie). **S10:** tailnet mode warns and offers "same tailnet domain only".
6. **S11:** curated environments for backup and ledger children (no token), the signtool password through the environment instead of argv, no absolute root in `vault/tree`, and quoting in `adopt.py`.
7. Electron 44 `windowStatePersistence` in place of any hand-rolled bounds. Check preloads for the async clipboard change.

### Phase 2: Platform modernization (≈3.5 days)

1. **Next.js 15.5 → 16.3:**
   - Run the codemod, rename `middleware.ts` to `proxy.ts` (Node runtime), make the remaining dynamic APIs async, and review the image config (loopback sources).
   - Make `page.tsx` a server component that lazy-loads the client shell.
   - Leave Cache Components off.
   - Measure the standalone size, cold start and dev memory before and after.
2. **Tailwind 3.4 → 4.3:**
   - Run `@tailwindcss/upgrade`, and move the token map from `tailwind.config.ts` into `@theme` in `globals.css`.
   - Convert colors to OKLCH with the same perceived values.
   - Handle the renames (`outline-hidden`, `shadow-xs`…) and the default changes (border color, ring width).
   - Diff every capture scenario before and after; the target is pixel-equivalent.
3. **Motion 12 → 13** with `LazyMotion` and `m`.
4. **ESLint:** flat config with `react-hooks` v6 (compiler rules), `jsx-a11y` and `@next/eslint-plugin-next`, added to `npm run check`. Clear the 16 suppressions or justify them.
5. **React Compiler:** turn it on once lint is clean, starting in annotation mode on leaf components, then app-wide after the Phase 4 split removes the render-phase ref writes.
6. **Streamdown:** stay on 1.x. Re-evaluate 2.x only if its assets can be bundled locally.

### Phase 3: Live data, end to end (≈3 days)

Bridge:

1. **Event-driven waits.** Adapter hooks (`send`, `send_clarify`, `set_status_text`, approvals, generating changes) notify a `threading.Condition`. Long-poll waiters wake at once, with a 2–5 s fallback check using `PRAGMA data_version` on one connection per thread.
2. **Outbox:** rotate or compact it (30 days or about 5k rows), read backwards from the end of the file, keep an in-memory index, and lock appends.
3. **`/snapshot`:** compute thread busy flags from memory, not SQL. Add a short snapshot cache invalidated by mtime and `data_version`. Run the usage journal sync only from the watch loop.
4. **SSE `/events`, done properly:** bounded queues, 15 s heartbeats, `Last-Event-ID` resume, and one multiplexed stream (snapshot changes, approvals, transcript head, notices, activity).
5. **Request handling:** non-blocking `_standalone_send` (`asyncio.to_thread`), a top-level JSON 500, `Handler.timeout`, suffix ranges, and a bounded, locked media-path set.

Dashboard:

1. **TanStack Query v5** as the one cache. A single SSE subscription (through the proxy, streamed) writes into it. Polling stays as the fallback when the stream drops.
2. **Polling cleanup:**
   - Remove the separate health ping.
   - Move the thread switcher and usage strip into the cache.
   - Hidden phone tabs suspend.
   - The visibility and online rules from `lib/poll.ts` carry over.
3. **Today:** one combined endpoint over a single cached vault walk.
4. **Streamed uploads** in the proxy (`duplex: "half"`). The bridge decodes base64 in chunks.

Proof: the request count per minute while idle on each surface, before and after; the existing long-poll, outbox and live contract tests; new tests for SSE resume and fallback.

### Phase 4: Front-end architecture and design-system foundation (≈4 days)

1. **`components/ui/` on Base UI** (source in the repo, shadcn style, styled with our tokens):
   - Button and IconButton (primary, secondary, ghost, danger; 36 and 44 px)
   - Input, Textarea, Select, Field (with a visible focus ring)
   - Card, Banner, EmptyState, Skeleton
   - Tabs (roving focus), Badge/StatusPill, Disclosure, Menu, Tooltip (with the shortcut hint)
   - Dialog and Sheet with a shared `useModal` (trap, restore, `inert` behind)
2. **Tokens:**
   - `fill-1/2/3` (hover, pressed, selected) in place of the 127 `bg-white/*`
   - a `micro` type step
   - a z-index scale
   - three icon sizes behind one API
   - delete the legacy color aliases
   - enforce the blur budget and the no-caps rule with a lint rule or test
3. **Migrate** the 29 buttons, 31 inputs, 45 cards and the four local button components. Voice mode, the lightbox and onboarding move onto Dialog.
4. **Decompose:**
   - **ChiefChat:** `useTranscriptFeed`, `useReplySpeech`, `useChatSender`, `useDraft`. The draft moves into Composer, so typing re-renders only the composer.
   - **CommandShell:** `useBridgeLink`, `useApprovals`, `useShellNav`, an overlays store in place of the window CustomEvents, and `usePersistentState` in place of the copy-pasted localStorage loaders.
   - **The panes:** `settings-panel` becomes one file per group under `components/settings/`, and today, vault and fleet-health get the same split.
5. **Performance:**
   - Stable row objects or a memo comparator, plus `content-visibility: auto` on rows.
   - A render-count test (one appended message renders one row).
   - Lazy-load OrbitSpace, Settings, Onboarding, Second Brain setup, Voice mode, Usage, Fleet Health, the Vault, backup/restore and the QR code.
   - The phone or desktop layout is chosen without a post-hydration flip.
6. **Tests** for Sheet and Dialog focus, HoldButton and ApprovalSheet, VaultPane, and tabs keyboard behavior.

Behavior is unchanged in this phase. Every existing test stays green, and the captures should look the same.

### Phase 5: The visual and UX pass (≈5 days)

Dark only, with equal weight for phone and desktop. Each item is captured before and after on both.

**Desktop feels native.**

1. **Integrated title bar:**
   - `titleBarStyle: "hidden"` with `titleBarOverlay` in the canvas color, so the native minimize, maximize and close controls sit in the app's own header.
   - Headers become drag regions, and interactive controls opt out.
   - Snap layouts keep working (overlay, not frameless).
   - Mica is left out: the UI is opaque, and Electron's Mica has known minimize and flicker bugs.
2. **Command palette (Ctrl+K)** on Base UI Autocomplete in a Dialog:
   - Go to Today, Fleet, Vault, a thread, a bot or a settings section.
   - Search the Vault.
   - Actions: new thread, voice mode, check for updates, open logs.
   - Recent items first.
3. **Keyboard map** with a `?` cheat sheet:
   - Ctrl+1/2/3 switch surfaces, Ctrl+N starts a thread, Ctrl+, opens settings, `/` focuses the message box.
   - Esc closes the top layer.
   - Shortcut hints appear in tooltips.
   - "Always allow" keeps its hold (Space or Enter held), with no single-key shortcut.
4. **Taskbar jump list and tray:** New thread, Voice mode, Today.
5. **Use the width:**
   - **Today** becomes two columns from about 1100 px: Do first on the left, Waiting / Due this week / Areas on the right.
   - **Fleet** gets a side roster and activity feed beside the orbit.
   - **A one-bot Fleet** gets an invitation: "Ask the chief to bring on a specialist", with suggestions that fill the composer.

**Chat reads like a person, not a log.**

6. **Routine deliveries** become a compact card:
   - routine icon, the routine's name (parsed; job id hidden), time, the response
   - a "Manage routine" link to Team & Routines in place of the boilerplate line
   - Parsing happens in the bridge (one place, tested against upstream's format), with a fallback to today's rendering.
7. **System notices** (restarts, shutdowns) collapse into one quiet line with a count ("Chief restarted twice · 1:28–1:38 PM"), which expands on tap.
8. **Tool steps** become a collapsible timeline (icon, label, duration), adapted from AI Elements' Tool and Reasoning patterns. Errors are tinted, with details on expand.
9. **Message actions** on hover (desktop) or long-press (phone): copy, speak, and retry for a failed send.
10. **The header** shows the presence, the name and a live state line ("Thinking · 0:07", "Speaking", "Needs your approval", "Online"):
    - The voice engine details move into the status sheet.
    - The secondary icons fold into one overflow menu on the phone, with labeled tooltips on the desktop.
    - The phone truncation goes away.

**One visual language.**

11. **Fewer boxes:**
    - Lists become rows on the pane surface with hairline dividers.
    - Cards are kept for things that are objects (a task sheet, a routine delivery, a media frame).
    - Section headers carry the hierarchy.
12. **Color identity:**
    - The chief's own color pair drives the accent ring, the aurora and the orbit's rays, so they always match the chief's face.
    - Crimson stays the "needs you / active" accent.
    - A test checks every pair for contrast.
13. **Surfaces:** `<ViewTransition>` between surfaces and panels (cross-fade plus a 12 px slide), and reduced motion falls back to a fade.
14. **States:** Skeleton and EmptyState everywhere. Empty states feature the chief's face in a fitting pose (asleep offline, curious when empty).
15. **Settings:** a search field (shared with the palette index), and the right-hand pane at a comfortable reading width.
16. **The phone:** the header drops to the presence, state and one overflow. The tab bar and sheets get the same palette and keyboard-free equivalents (long-press menus).

Proof: before-and-after galleries for every scenario (phone and desktop), the perf probes unchanged or better, no new contrast failures, and a manual pass on an Android phone over Tailscale by the owner.

### Phase 6: Reliability and observability (≈2.5 days)

1. **Supervisor:**
   - `start()` is idempotent, and one boot lock serializes boot and retry.
   - A `/health` probe every 30 s while running restarts the process after N failures.
   - After `failed`, a slow retry every 10 minutes, plus a notification.
2. **The page sees supervisor state** (a banner: "Chief's engine restarted", "Chief stopped; retrying in 9 min"). `did-fail-load` shows the boot page with retry, and renderer reloads are capped.
3. **A static `/api/healthz`** for the web readiness check.
4. **Logging:**
   - electron-log v5 (or an equally small module): rotating JSON lines for main, gateway, dashboard and update, with token redaction.
   - Every boot step and supervisor event is logged, plus an `unhandledRejection` handler.
   - Local `crashReporter` minidumps (`uploadToServer:false`).
   - The bridge logs through `RotatingFileHandler`.
5. **Settings → About → Create diagnostics bundle:** logs, dumps and versions in one zip. The owner reviews it and sends it themselves. No remote telemetry.
6. **Backups** move to the desktop main process (or get a lock file plus a PID record), so web restarts don't orphan them.
7. **Startup:**
   - Run `recover` only when restore state exists.
   - Skip `provision` when the plugin and payload stamp hasn't changed.
   - Start the web server in parallel with the gateway.
   - Precompile `__pycache__` into the payload, or point `PYTHONPYCACHEPREFIX` at LocalAppData.
   - Measure time to first paint and to "Chief online" before and after.
8. **Shutdown:** handle `session-end`, and show feedback during a slow quit.
9. **Split `main.ts`** into `boot.ts` (injected dependencies, unit-tested like `Supervisor`), `ipc.ts`, `phone.ts`, `install-package.ts`, `window.ts` and `logger.ts`. Merge the three Python runners and the two version comparisons.

### Phase 7: Bridge code health (≈2.5 days)

1. **`hermes_api.py`**, one facade for every Hermes call. An import-time capability self-check is reported on `/health` and shown in the status sheet. A capability failure logs a warning (never a silent `None`); approvals are the first to get this.
2. **A declarative route table** in `server.py`: method, path, handler, body limit, validator. The dashboard's proxy allow-list is generated from it, or a test asserts they match.
3. **Remove the legacy Discord paths** (`discord_bot`, `inject`, `_quote_from_pc`, `cc_shared_singleton`) once it's confirmed no install still uses them.
4. **Unit tests in CI** for `providers`, `persona`, `settings`, `routines`, `fleet`, `second_brain`, `speech_model` and `voice`, plus outbox growth, ranges and concurrent long-polls.
5. **`pyproject.toml`** with Ruff (lint and format) and pyright (basic, then strict for the plugin), both in `npm run check`.

### Phase 8: CI and testing (≈2 days)

1. **A CI job that runs the real-Hermes contracts and the gateway smoke test** against the pinned, patched Hermes on Windows (cached source install or payload artifact) whenever `hermes/` changes. Upstream-upgrade PRs get CI too (a GitHub App token in place of `GITHUB_TOKEN`).
2. **CI hygiene:** Python 3.14 to match the payload, pinned test dependencies, actions pinned by SHA, `permissions: read-all`, and an incremental privacy history scan.
3. **Renovate:** grouped Electron, Next and Python updates, `minimumReleaseAge` 7 days (14 for majors), and no auto-merge.
4. **OSV-Scanner** (npm and pip) in CI, plus `npm audit --omit=dev` as a warning.
5. **Playwright `_electron` smoke test** (local and in `release.mjs`): boot on a throwaway data folder with the fake model, the dashboard, a chat round trip, an approval, then quit, with a check that the live install's gateway log line count is unchanged.
6. **The capture gallery as a visual check:** a script compares scenarios against a stored baseline (kept untracked, local) and flags changes.

### Phase 9: Release and distribution (≈4 days; later, before going public)

1. **`release.mjs`:**
   - Build, verify and publish a draft first; then commit, tag `vX.Y.Z`, push and un-draft.
   - Restore the files on any failure.
   - Remove `--skip-checks`, or make it loud and refuse to publish with it.
2. **Payload provenance:** `install-stamp.json` records the patch SHA-256s, the `selection.json` hash, the builder's git SHA and a file-tree hash. `release.mjs` compares all of them, and `release.json` carries the tree hash.
3. **Payload diet:**
   - Drop `ffplay` and the ffmpeg docs.
   - Audit the `all` extra and remove the Google, Bedrock, Vertex, Discord and other extras the app doesn't expose.
   - Evaluate a shared-DLL ffmpeg and MinGit.
   - Measure each step. Expect 300–500 MB less uncompressed and a smaller package.
4. **Updates:**
   - Keep only the current and previous package, and throttle progress messages to 4 per second.
   - Rollback: "Go back to X.Y.Z", plus a first-boot-healthy marker that offers it after two failed boots.
   - A key list with `key_id` and `expires` in the manifest, so keys can rotate.
5. **Smaller updates:** prototype one of two options, then pick:
   - Split the Hermes payload into its own MSIX optional or resource package, published only when `pin.json` changes. App-only updates drop from about 850 MB to the Electron and web size.
   - Block-map differential download over HTTP Range.
6. **Public-release readiness:** a third-party notices file and source offer (GPL ffmpeg, Git, Python, Node), a syft SBOM attested with `attest-sbom`, a license gate, OpenSSF Scorecard, and the signing decision (Artifact Signing, SignPath, or the Microsoft Store).

## 5. Totals and order

| Phase | Days | Depends on |
| --- | --- | --- |
| 0 Urgent fixes | 1 | — |
| 1 Hardening | 1.5 | 0 |
| 2 Platform modernization | 3.5 | 0 |
| 3 Live data | 3 | 2 (dashboard half); bridge half any time |
| 4 Front-end foundation | 4 | 2 |
| 5 Visual and UX pass | 5 | 4 |
| 6 Reliability and observability | 2.5 | 1 |
| 7 Bridge code health | 2.5 | 3 (bridge half) |
| 8 CI and testing | 2 | 7 for the Python lint |
| 9 Release and distribution | 4 | 6, 8 |
| **Total** | **≈29** | |

Suggested release points for testers:

- after Phase 1 (security)
- after Phase 3 (faster, lighter)
- after Phase 5 (the new look)
- after Phase 6 (reliability)

## 6. Working rules for the implementation

- Work happens on a branch per phase (`review/phase-N-…`), committed step by step, and is merged to `main` when its checks pass. Nothing is published until the owner says "ship it".
- Testing uses only the throwaway e2e home (bridge 7795, dashboard 3102, the fake model). The live install on 3000/7790 is never stopped, restarted or provisioned, and `hermes gateway stop` is never run.
- Privacy: no personal data in code, tests, fixtures, docs or captures. Galleries stay untracked.
- Every phase ends with a short report: what changed, the evidence (tests, measurements, captures) and anything deferred.

## 7. Small decisions with a default (say if you want otherwise)

| Question | Default |
| --- | --- |
| The owner-specific production strip on Today | Remove it. A generic "pinned metric from the vault" can come later if wanted. |
| Discord custom-emoji syntax in old messages | Show it as `:name:` text, with no outside request. |
| Remote crash reporting | None. Local minidumps and a diagnostics bundle the owner sends by hand. |
| Mica / acrylic window material | Left out (opaque UI; known Electron bugs). |
| Legacy Discord code in the bridge | Removed in Phase 7, after a check that no install still uses it. |
