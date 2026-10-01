# Chief Command Center — Visual Overhaul Plan

Status: **proposal, awaiting approval.** Nothing below is implemented yet.
Branch: `visual-overhaul` (local only; commit per phase, never push).

## 0. Decisions from the interview (2026-09-22)

| Topic | Decision |
| --- | --- |
| Direction | **A · Obsidian** — Linear-grade precision + Apple Liquid Glass layering. One crimson accent. Discord look goes. |
| Bots | Hermes brand sync is optional now. Priority: **spectacular, alive bot animation, the chief above all.** |
| Motion | **4 of 5.** Springy and choreographed, short of cinematic fly-throughs. Keep the always-on ambience and make it richer. |
| Sacred | **Hold-to-talk.** **An orbit** survives (desktop and a phone version). |
| Status lines | May collapse into one indicator, as long as degraded state is still shown honestly. |
| Platform | **Android, phone-first** (Chrome PWA over Tailscale). Desktop second. |
| Theme | **Dark only.** |
| Type | My call. Text size must stay adjustable. |
| Sound / haptics | All of it: send, reply, approval, voice, connection. **Every sound and every haptic has its own switch.** |
| Signature moments | All six: The chief presence reacting to voice + live waveform; send lift; approval sheet with hold-to-confirm; specialist dispatch beam + toast; morning Today; outage dim + reconnect shimmer. |
| Fleet churn | The chief mints and retires bots on its own. **The dashboard must support any bot appearing or disappearing at any time.** New bots don't need to match Hermes or any pattern. See §12. |

## 1. Where we start

Before gallery: `docs/visual-overhaul/before/` (27 captures, phone 390×844 @2x and desktop 1440×900; untracked because they contain real chat and tasks). Capture tool: `docs/visual-overhaul/capture-ui.mjs` (headless Edge over CDP, no dependencies, all write endpoints blocked in the browser).

Gap summary (full list was given in chat on 2026-09-22):

- No type scale (≈12 ad-hoc sizes), system fonts differ per device.
- 7 hand-picked near-black surfaces, Discord palette, ad-hoc semantic colors, no elevation.
- Telemetry chrome ("Fleet: updated 0s ago" ×3) eats ~60px on the phone.
- Composer is five equal boxes; tab bar is text-only.
- Zero transitions; the only motion is infinite pulses.
- No pressed or focus states; many labels below WCAG AA contrast (white/25–/45 ≈ 2.2–4.4:1).
- Every geometric face calls `setState` every frame (~700 React renders/s on Fleet); orbit stacks 3 WebGL shaders.
- Defects: the header shows the raw text `Reconnecting\u2026` (JSX text doesn't process escapes); `border-white/12` (not a Tailwind 3 class) falls back to a bright default border on the mic button, Today sheets and Settings.

## 2. Design tokens

All tokens live as CSS custom properties in `app/globals.css` and are mapped into `tailwind.config.ts` (`colors`, `fontSize`, `borderRadius`, `boxShadow`, `transitionTimingFunction`, `transitionDuration`) so components use names, never hex.

### 2.1 Color (dark only)

Neutral scale is a cool zinc tuned in the Radix 12-step spirit. Contrast ratios are computed against the surface they sit on (WCAG 2.x relative luminance).

| Token | Value | Use |
| --- | --- | --- |
| `--bg-0` | `#09090B` | App canvas |
| `--bg-1` | `#0F0F12` | Panes, desktop split sides |
| `--bg-2` | `#151518` | Cards, media frames, list hover |
| `--bg-3` | `#1B1B1F` | Sheets, drawers, popovers |
| `--bg-4` | `#232328` | Your chat bubble, pressed rows, inputs |
| `--glass` | `rgb(22 22 26 / 0.72)` + `backdrop-filter: blur(20px) saturate(140%)` | Floating composer and tab bar only |
| `--line-1` | `rgb(255 255 255 / 0.06)` | Hairlines, dividers |
| `--line-2` | `rgb(255 255 255 / 0.10)` | Card and field borders |
| `--line-3` | `rgb(255 255 255 / 0.16)` | Hover / emphasized borders |
| `--fg-1` | `#EDEDEF` | Primary text (≈17:1 on bg-0) |
| `--fg-2` | `#A1A1AA` | Secondary text (7.8:1 on bg-0) |
| `--fg-3` | `#85858E` | Tertiary / meta (≥4.69:1 on bg-0…bg-3) |
| `--fg-4` | `#5A5A63` | Disabled and decorative only, never informational text |
| `--accent` | `#E5484D` | The chief crimson: glows, rings, active indicators, icons |
| `--accent-solid` | `#CE2C31` | Filled accent buttons (white label 5.2:1) |
| `--accent-text` | `#FF9592` | Accent-colored text on dark |
| `--accent-tint` | `rgb(229 72 77 / 0.14)` | Accent washes |
| `--ok` / `--ok-tint` | `#3DD68C` / `rgb(61 214 140 / 0.14)` | Online, allowed, done |
| `--warn` / `--warn-tint` | `#FFC53D` / `rgb(255 197 61 / 0.14)` | Approval needed, waiting, stale |
| `--danger` / `--danger-tint` | `#FF6369` / `rgb(255 99 105 / 0.14)` | Overdue, errors, deny |
| `--scrim` | `rgb(0 0 0 / 0.55)` | Behind sheets and dialogs |

Rules: one accent per view. Status is never color alone (always a word or icon too). Crimson means "The chief / active"; amber means "needs you"; red text means "late or failed".

**Bot identity colors.** A curated set of 10 hues at equal perceived lightness (LCH, L≈72, C≈55), so the fleet looks like one family. A bot keeps its Hermes `ui_meta` color only when marked `custom`; otherwise its hue is hashed from the profile id into this set. The chief keeps its teal hexagon body with the crimson halo that marks the chief.

### 2.2 Typography

Fonts, self-hosted and bundled (no runtime requests):

- **Inter Variable** (with optical sizing: large sizes use the Display cut automatically) for everything.
- **Geist Mono** for code, commands, numbers in stat tiles and telemetry.

| Style | Size / line | Tracking | Weight | Use |
| --- | --- | --- | --- | --- |
| `display` | 28 / 32 | −0.022em | 600 | "Today", Look drawer hero name |
| `title` | 20 / 26 | −0.017em | 600 | Sheet titles, area names |
| `headline` | 16 / 22 | −0.011em | 600 | Section headers, the chief's name in the header |
| `body` | 15 / 22 | −0.006em | 400 | UI text (desktop 14 / 20) |
| `chat` | user setting, default 16 / 24 | −0.006em | 400 | Message text |
| `callout` | 13 / 18 | 0 | 500 | Meta, chips, buttons |
| `caption` | 12 / 16 | +0.01em | 500 | Timestamps, tab labels, badges |
| `mono` | 12.5 / 18 | 0 | 450 | Code, commands, counters |

Adjustable size, two controls:

- **Chat text** keeps the existing 13–20px steps (`chief-chat-font`).
- **Interface size** (new): Compact 0.94 / Default 1.0 / Large 1.08. It scales the root rem, so all tokens scale together and 44px targets stay ≥44px.

Sentence case everywhere; no ALL CAPS labels (today's `CONTEXT` / `STATUS` go away).

### 2.3 Spacing, radii, elevation

- Spacing: 4px base — 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64.
- Radii: `xs` 6 (chips, badges), `sm` 10 (buttons, inputs), `md` 14 (cards, bubbles, media), `lg` 20 (sheet top corners, composer capsule), `xl` 28 (floating tab bar), `full`.
- Elevation:
  - **e0** canvas `bg-0`.
  - **e1** panes `bg-1`.
  - **e2** cards: `bg-2` + `line-1`.
  - **e3** floating (composer, tab bar, toasts): `--glass` + `line-2` + `0 8px 32px rgb(0 0 0 / .45)`.
  - **e4** sheets and dialogs: `bg-3` + `line-2` + `0 −12px 48px rgb(0 0 0 / .6)` over `--scrim`.
- Maximum two floating layers on screen at once. `backdrop-filter` on at most two elements (composer, tab bar); it's turned off entirely when Ambient is "Low" or "Off".

### 2.4 Iconography

`lucide-react` (tree-shaken, 1.75px stroke, 20px default, 24px in the tab bar). It replaces today's text buttons, emoji buttons and ad-hoc SVGs (paperclip, gear, play, pause, stop).

## 3. Motion system

### 3.1 Tokens (`lib/motion.ts` + CSS vars)

| Token | Value | Use |
| --- | --- | --- |
| `--dur-press` | 80ms | Press-down feedback |
| `--dur-fast` | 140ms | Color, opacity, hover |
| `--dur-base` | 220ms | Small enters (chips, messages, tab content) |
| `--dur-medium` | 320ms | Composer morphs, list reorders |
| `--dur-sheet` | 480ms | Sheet and drawer travel (iOS/Vaul feel) |
| `--ease-out` | `cubic-bezier(0.22, 1, 0.36, 1)` | Default for anything entering |
| `--ease-exit` | `cubic-bezier(0.3, 0, 0.8, 0.15)` | Anything leaving (Material 3 emphasized-accelerate) |
| `--ease-inout` | `cubic-bezier(0.65, 0, 0.35, 1)` | On-screen travel (beams, shimmer) |
| `--ease-sheet` | `cubic-bezier(0.32, 0.72, 0, 1)` | Sheets (Vaul / iOS sheet curve) |
| `spring.snappy` | `{ type: "spring", duration: 0.3, bounce: 0.15 }` | Indicators, toggles, press release |
| `spring.bouncy` | `{ type: "spring", duration: 0.45, bounce: 0.3 }` | Send lift, badges, celebrations |
| `spring.gentle` | `{ type: "spring", duration: 0.6, bounce: 0 }` | Layout changes, presence size changes |

Rules:

- Interface motion ≤ 320ms except sheets (480ms) and deliberate signature moments.
- Exits run at about 70% of the matching enter.
- Staggers are 30ms, capped at 6 items.
- Animate only `transform`, `opacity` and `filter`; layout changes go through Motion's FLIP (`layout`, `layoutId`).
- Every animation is interruptible, and a new gesture wins.
- Loops exist only for ambience and genuine in-progress states.

### 3.2 Choreography per interaction

| Interaction | Choreography |
| --- | --- |
| Any press | Scale 1 → 0.96 in 80ms `ease-out`, release on `spring.snappy`; optional tap haptic. |
| Phone tab switch | Active pill slides via shared `layoutId` (`spring.snappy`). Icon pops 1 → 1.12 → 1. Content cross-fades with a 12px slide in the travel direction, 220ms `ease-out`; outgoing fades in 140ms. |
| Send | Draft text lifts out of the capsule into the thread as your bubble (`layoutId` flight, `spring.bouncy`). Capsule collapses back (`spring.gentle`). Send sound + haptic. The chief's presence glances at you and pulses once ("received"). |
| Reply arrives | Message fades in from 8px below, blur 4px → 0, 260ms `ease-out`; paragraphs stagger 40ms (max 6). Reply sound + haptic. "Jump to latest" pill bounces in if you're scrolled up, with an unread count. |
| The chief thinking | Header presence enters **thinking** (below). Thread row shows a shimmer label "The chief is thinking" (gradient sweep, 1.6s linear loop), with a mono elapsed timer after 5s. |
| Tool call | Chip appears (scale 0.96 → 1, fade, 180ms) with a tool icon; long chains collapse into "4 tools · show". |
| Approval arrives | Scrim fades in (220ms), sheet rises (480ms `ease-sheet`), card border glows amber twice (1.2s) then settles. Chime + haptic. On Today and Fleet: an amber dot badge on the Chat tab and a floating "Approval needed" pill above the tab bar. |
| Always allow | **Press and hold 900ms.** A radial amber fill runs around the button; release early and it springs back. On completion: check-morph, haptic, sheet exits (300ms `ease-exit`). This replaces today's two-tap confirm and keeps the same protection. |
| Hold-to-talk | Press: the mic expands into a full-width recording bar (`spring.snappy`). Live waveform from your mic (canvas, 30fps), elapsed time, "slide left to cancel" with rubber-band resistance; crossing the cancel threshold flips the bar red with a haptic tick. Release: bar collapses into a "Transcribing" shimmer, then the send-lift. The chief listens while you talk (below). |
| The chief speaking (TTS) | Presence becomes amplitude-reactive to the actual audio (Web Audio `AnalyserNode` on the player). Header shows "Speaking" with a mini waveform and Pause / Stop. |
| Sheets (settings, intent, look, approval) | Enter 480ms `ease-sheet` over a fading scrim. Drag the handle to dismiss (velocity-aware). Exit 300ms `ease-exit`. Desktop: side panels slide 24px + fade, 320ms. |
| Specialist dispatched (ring idle → working) | Beam travels from the chief to the specialist with a comet head (1.2s `ease-inout`). Seat pops (`spring.bouncy`) and starts its working halo. Top toast: "Ada picked up <task title>" (auto-dismiss 3.5s, swipe up to dismiss). |
| Specialist finishes | Little hop + sparkle burst (600ms). Ring settles to idle. |
| Morning Today | First open each day (local date key): stat tiles count up (600ms `ease-out`), ranked rows cascade in (30ms stagger), area chips slide in. Later opens are instant. |
| The chief mints a bot | The new id appears in the snapshot. The chief's presence flares, a beam shoots from the chief to an empty spot, and the new face **materializes**: scale 0.2 → 1 with `spring.bouncy`, a sparkle burst, then a first blink. The other seats glide to their new positions (`layout`, `spring.gentle`). Toast: "The chief added Ivy · Research Assistant". Sound + haptic. |
| The chief retires a bot | The face gives a small wave, then shrinks and drifts into the chief (500ms `ease-exit`) as the remaining seats close the gap. Toast: "The chief retired Scout". If its Look drawer is open, the drawer shows "Scout was retired", then closes. |
| Outage | App desaturates and dims (`saturate(.55) brightness(.85)`, 600ms). The chief's presence goes to sleep (eyes closed, slow breathing). Header dot pulses amber. Recovery: a shimmer sweeps the header (800ms), the dot pops green, and a "Back online" toast shows. |
| Image open | Shared-element zoom from thumbnail to lightbox (`layoutId`, `spring.gentle`); swipe down to close. |

### 3.3 Reduced motion

A new in-app **Motion** setting (System / Full / Reduced) overrides `prefers-reduced-motion`. When reduced:

- All transforms become opacity fades of 120ms or less.
- Loops stop, and presences show static state colors.
- The waveform becomes a single level dot.
- Beams become a brief highlight.
- Shaders are replaced by the static starfield.

The existing reduced-motion CSS is extended to cover everything `motion`-driven (via `MotionConfig reducedMotion`) and the face rig.

## 4. Signature: living bots and the chief's presence

### 4.1 One animation clock, zero React renders

A new `lib/face-clock.ts` runs one `requestAnimationFrame` loop for every face on screen:

- Each face registers a DOM ref and a state; the loop writes CSS variables and transforms directly. No `setState` per frame.
- Pauses when the page is hidden and for faces scrolled offscreen (`IntersectionObserver`).
- Runs at 60fps while you interact and 30fps when idle on the phone.

This recovers the ~700 renders/s spent today and funds everything below.

### 4.2 Face rig (all bots)

| State | Trigger | Behavior |
| --- | --- | --- |
| idle | default | Breathing scale (±1.5%, 4–6s, phase-shifted per bot), natural blinks (occasional double), glances toward activity (a working neighbor, the composer when you type). |
| listening | you are recording | The chief only: leans in, pupils widen, halo breathes with **your** mic level. |
| thinking | `generating` or pending reply | Eyes drift up and aside; 6–10 particles orbit the halo; ring shimmer rotates (8s). |
| speaking | TTS playing | The chief only: halo radius and brightness, and the eye squint, follow audio amplitude; soft mouth line appears. |
| working | ring `working` | Specialists: an orbiting tool glyph plus a sweeping progress arc in the bot's hue; gentle bob. |
| waiting | approval pending | The chief looks straight at you; amber halo pulse. |
| failed | ring `failed` | Sad pose (as today), desaturated, slow sway. |
| celebrating | working → idle with task done | Hop + sparkle burst, once. |
| asleep | gateway down | Eyes closed, slow deep breathing, "z" drift. |

Shapes stay (hexagon, triangle, squircle, pill, cloud, drop, circle, Blobatar blobs). Each gets soft top-light shading (inner gradient) and a 1px rim so they read as objects rather than flat stickers.

### 4.3 the chief's presence (the chief)

The chief's hexagon sits inside a layered halo, drawn in SVG plus CSS (GPU transforms, no WebGL):

1. **Aurora ring:** a conic gradient in crimson → the chief's teal → transparent. Rotates slowly (20s) when idle; speeds up and brightens when thinking.
2. **Bloom:** a soft radial glow whose opacity tracks state and voice amplitude.
3. **Particle orbit:** up to 10 motes on two tilted ellipses (thinking and working).
4. **Voice ring:** an amplitude-driven outline (listening and speaking).

Sizes: chat header 40px; Fleet center 112px (desktop) / 88px (phone mini-orbit); empty-chat hero 120px.

**Stretch (optional, Phase 3b):** tap the chief in the chat header to open a full-screen **Voice mode**, a big presence with hold-to-talk underneath (like ChatGPT's voice screen). It uses the same endpoints as today.

### 4.4 Ambience ("always on, cooler")

The Ambient setting has three levels: Full / Low / Off.

- **Chat:** a faint aurora behind the top of the thread in the chief's two colors, drifting on a 24s loop. Its intensity rises while it thinks or speaks. CSS only.
- **Desktop Fleet orbit:** the three stacked shaders consolidate into **one** GodRays shader plus a canvas starfield with slow parallax. Seats sit on a tilted ellipse, with scale and brightness by depth for a pseudo-3D look, and drift slightly. Beams get comet heads.
- **Phone Fleet mini-orbit:** the chief at the center with specialists on a slowly rotating ellipse (a 260px hero above the list). Canvas2D starfield at 30fps; optional tilt parallax from Android `DeviceOrientation`. No WebGL on the phone.
- **Low:** no blur, 30fps ambient, no particles. **Off:** static.

## 5. Component-by-component

| # | Component | Before | After intent |
| --- | --- | --- | --- |
| 1 | App shell (phone) | Two status lines, a text tab bar with a gear, brown approval bar | Clean header per surface with a **connection dot**. Tap the dot for the status sheet: per-resource ages, DeepSeek peak/off-peak, bridge and Ops health. It turns amber and shows an inline "Fleet stale 12s" chip automatically when degraded. Floating e3 **tab bar** (icons + labels, sliding pill, amber badge). Settings opens from the gear in each header. |
| 2 | Desktop shell | Status strip, thin grabber | Same header system; restyled grabber (glass pill with orbit/rail icon); split stays 60/40 with click-to-toggle. |
| 3 | Chat header | Avatar, "The chief - Chief of Staff", voice label, DeepSeek chip, gear | Presence (40px) + "The chief" + a live state line ("Thinking · 0:07", "Speaking", "Listening", "Needs your approval", "Online"). The DeepSeek chip shows only during Peak; otherwise it lives in the status sheet. |
| 4 | Thread | Discord-style grey bubbles for the chief, blurple for you, equal spacing | The chief: **no bubble**, full-width readable text with an avatar gutter at group starts. You: right-aligned `bg-4` bubbles with a 6px tail corner. Grouping gaps of 4px within a group and 16px between groups. Day separators. Timestamps on tap (phone) or hover (desktop). |
| 5 | Markdown | Heavy bold blocks, code clipped horizontally | Tuned heading and list rhythm; inline code in `bg-4` mono; code blocks in e2 cards with horizontal scroll, language label and a copy button; tables scroll. |
| 6 | Notes and tools | Boxed "CONTEXT / TOOL" rows in teal and amber | Compact icon chips in sentence case ("Tool · write_file", "Context compacted"); chains collapse; errors in danger-tint with details on expand. |
| 7 | Media | Native `<video>` with controls, underlined "Full quality" | Poster card with a large play glyph and a mono duration badge; tap to play inline (controls fade in); an HD icon button for full quality. Image lightbox with shared-element zoom and swipe-to-close. File chips with type icon, name and size. Audio as a mini waveform player. |
| 8 | Composer | Five boxes (clip, mic, text, emoji, Send) | One glass capsule: `+` opens a small menu (Attach, Photo, Emoji); an auto-growing field of 1–6 lines; on the right, **mic ↔ send morph** (mic when empty, arrow when there's text or files, 180ms cross-rotate). Pending files as a thumbnail row above the capsule. The recording bar takes over the capsule (§3.2). |
| 9 | Approval | Inline amber card with four equal buttons; phone brown banner | Bottom sheet: "The chief wants to run" + mono command block + reason. Buttons: **Allow once** (primary, white solid), **This session** (secondary), **Always allow** (press-and-hold, amber ring), **Deny** (danger outline). Can be minimized to the floating pill. |
| 10 | Empty and error states | Grey sentences | Empty chat: large idle presence, "Say hi to the chief", and three suggestion chips that fill the composer (never auto-send). Gateway down: presence asleep, "The chief's gateway is offline — it will reconnect on its own", last-seen time. Ops down: same pattern on Today. |
| 11 | Today | Status line, ranked list with red labels, bordered chips, "Settings" text link | `display` "Today" + date. Three stat tiles (Open, Overdue, Waiting) with mono count-up. Search pill with icon. Ranked rows: mono rank numeral, title, area dot and label, urgency pill (Overdue = danger tint, Waiting on you = warn tint, Due today = accent tint). Horizontal area chip rail. Vault settings in the header menu. |
| 12 | Intent sheet | Absolutely positioned box, small chips | Real bottom sheet: segmented intent control, context field, conditional date and blocker fields, primary "Send to the chief", secondary "Mark complete". |
| 13 | Area drill-down | Plain columns | `title` + focus line + a small progress summary; column sections with counts; the same row component. |
| 14 | Fleet (phone) | Plain list of "Name - Title" rows | Mini-orbit hero (§4.4), then rows: face 44px, **name** (bold) and role (secondary) split from the Hermes title, a status pill ("Working · task…" / "Idle" / "Blocked"), grouped by section with counts. |
| 15 | Fleet orbit (desktop) | Three shaders, flat seats, straight beams | One shader + depth ellipse + drift + comet beams + dispatch toasts; hover tip restyled as an e3 card. |
| 16 | Look drawer | CAPS key/value, raw `pre` Soul/Memory | Hero presence (96px) in its live state, name + role, status pill, segmented tabs; Soul and Memory rendered as markdown; Job as a clean definition list; Tools as chip clouds. |
| 17 | Settings | Long flat list, "current" in red | Grouped e2 cards: **the chief's voice** (Hearing / Speaking pickers as sheet lists with radio + status badges; current marked with an accent check, not red), **This app** (Interface size, Chat text with live preview, Motion, Ambient, Speak replies, Stay awake, Compact chat), **Sound** (master + per event), **Haptics** (master + per event), **Notifications**. Real switches with spring thumbs. |
| 18 | Toasts (new) | — | Top-center e3 toasts with icon; stack of at most 2; swipe to dismiss; screen readers get `aria-live`. |
| 19 | Emoji picker | Grey grid box | e3 popover from the `+` menu with category tabs; staggered enter. |

## 6. Sound and haptics

**Sounds** are synthesized with Web Audio at runtime: no audio files, 0 bytes of network.

- They play only while the page is visible, and duck 50% while the chief is speaking.
- Default volume is low. Master switch plus a switch per event.

| Event | Sound | Haptic (Android `navigator.vibrate`) |
| --- | --- | --- |
| Send | Short soft tick (1.2kHz sine, 40ms, fast decay) | 12ms |
| Reply arrives | Two-note soft marimba (660 → 880Hz FM, 180ms) | `[8, 40, 8]` |
| Approval needed | Rising three-note chime (400ms) | `[20, 60, 20, 60, 40]` |
| Hold-to-talk start / stop | Low click in, higher click out | 15ms / 10ms |
| Crossing the cancel threshold | — | 10ms |
| Always-allow hold complete | Bright confirm ping | 30ms |
| Error | Low double tone | `[30, 40, 30]` |
| Connection lost / back | Soft falling / rising pair | 20ms / `[10, 30, 10]` |
| Bot minted / retired | Sparkle up-sweep / soft down-sweep | `[10, 30, 20]` / 15ms |
| Any press (off by default) | — | 6ms |

The settings live in `lib/dashboard-prefs.ts` under one new key, `chief-fx`:

- sounds: master + per event
- haptics: master + per event
- motion: System / Full / Reduced
- ambient: Full / Low / Off
- interface scale

Haptics are skipped automatically when `navigator.vibrate` is missing (desktop, iOS).

## 7. Performance budget (Android mid-range over Tailscale)

| Budget | Target | How we measure |
| --- | --- | --- |
| React renders from animation | **0 commits/s** while idle on Fleet (today about 700) | React Profiler; a vitest guard on the face clock |
| Frame time | 60fps during interactions; ambient ≤ 4ms/frame on the main thread; ambient at 30fps on the phone | Chrome remote DevTools on the phone (`chrome://inspect`); CDP trace with 4× CPU throttle via the capture tool |
| WebGL | ≤ 1 context on desktop orbit, **0 on phone** | Code rule plus review |
| Blur | ≤ 2 `backdrop-filter` elements; 0 in Low / Off | Code rule |
| JS added (gzip) | ≤ 60KB total over today | `next build` output compared before and after (build only for measuring; dev stays the daily runtime) |
| Fonts | ≤ 110KB woff2, latin subset, preloaded, `font-display: swap` | Network panel |
| Network | No new requests or polling changes; sounds synthesized | Network panel |
| Responsiveness | INP < 200ms for send, tab switch and sheet open | PerformanceObserver event timing in a dev-only overlay |
| Loops | Every loop pauses on `visibilitychange` hidden and when offscreen | Code review plus a test |

## 8. Accessibility

- All text tokens meet WCAG AA 4.5:1 on their surfaces (§2.1); `fg-4` is never used for information.
- A visible `:focus-visible` ring on every interactive element: 2px `--accent` + 2px offset.
- Touch targets stay ≥ 44px (Interface size never shrinks them below 44).
- Motion honors the OS setting and the in-app Motion override (§3.3).
- Status never relies on motion, color or sound alone; every state has text.
- Hold gestures always have an alternative: typing for voice. For "Always allow", keyboard users hold Space/Enter; the screen-reader label explains the hold.
- `aria-live` announces thinking, speaking, approval and connection changes (extending today's).

## 9. Verification

1. **Tests stay green every phase:** `npm test`, `npm run typecheck`, `npm run test:python`.
2. **Expected test updates** (behavior-preserving):
   - `chat-actions` "second tap" becomes the press-and-hold path.
   - Selectors that match text-only buttons move to accessible names.
   - Mic lifecycle tests keep passing unchanged: the recording logic in `mic-button.tsx` is kept and only its presentation changes.
3. **New tests:**
   - fx prefs (sound and haptic gating, per-event switches)
   - the face clock renders zero React commits
   - reduced-motion paths
   - approval hold-to-confirm (early release cancels)
   - the status dot shows a degraded state
   - mic/send morph keeps sending
   - roster churn: bots minted and retired mid-session (§12)
4. **After gallery:** `node docs/visual-overhaul/capture-ui.mjs docs/visual-overhaul/after` produces the same 27 scenarios plus new ones: recording, speaking, toast, lightbox, reconnect. A generated `docs/visual-overhaul/gallery.html` shows before and after side by side, locally.
5. **Phone check per phase** on your Android over the Tailscale URL: send, hold-to-talk, approval (a real one when it happens), tab switches, Settings switches. Also toggle Airplane mode for the outage state.
6. **Hard rules:**
   - No changes under `hermes-plugin/` and no bridge-protocol changes.
   - No gateway restarts. Port 3000 unchanged. Tailscale path checked in Settings → Phone.

## 10. Phases, effort and risk

Effort assumes agent-driven implementation with verification. Each phase is one or more local commits on `visual-overhaul` and is shippable on its own.

| Phase | Scope | Effort | Risk | Notes |
| --- | --- | --- | --- | --- |
| **0 · Foundations** | Fix the `\u2026` escape and `border-white/12`. Tokens (CSS vars + Tailwind mapping), fonts, icons, `lib/motion.ts`, `chief-fx` prefs store, `MotionConfig`, reduced-motion hook. Capture tool and gallery generator. Gitignore the private galleries. | S–M (½ day) | Low | Visual change is small but global (new font and palette). Fixes land first. |
| **1 · Shell and navigation** | Floating tab bar, headers, connection dot + status sheet, sheet primitive (drag-to-dismiss), toast system, tab transitions, desktop grabber. | M (1 day) | Low–med | Touches `command-shell`, `phone-nav`, `surface-tabs`; status honesty must stay equivalent. |
| **2 · Chat** | Thread layout, message enter animations, markdown and code styling, notes and tool chips, media cards + lightbox, composer capsule + mic/send morph, recording bar + live waveform, jump-to-latest, empty and error states, approval sheet + hold-to-confirm. | L (2 days) | Med | The highest-traffic surface. Keeps all `chief-chat` logic (polling, speech, optimistic sends, retry ids); presentation is split into subcomponents. |
| **3 · Living faces and the chief's presence** | Face clock, rig states, shading, the chief halo layers, listening/speaking amplitude via `AnalyserNode` on the mic and TTS player, sleep and celebrate. Zero-setup identity for any new bot, and safe unregistering when one is removed (§12). | L (2 days) | Med–high | The biggest wow. Risks: Blobatar blobs inside the rig; analyser wiring must not change speech-queue behavior (tests guard it). **3b stretch:** Voice mode (+1 day). |
| **4 · Fleet and orbit** | Phone mini-orbit hero, rows with status pills, desktop orbit (one shader, depth ellipse, comet beams), dispatch beam + toast, celebrate on finish, Look drawer. Mint and retire moments, count-scaling layouts (1–2 rings, +N chip), roster-churn test (§12). | M–L (1½ days) | Med | Shader consolidation must hold the perf budget. |
| **5 · Today** | Header stats + count-up, row and pill styles, area rail, intent sheet, area drill, morning moment. | M (1 day) | Low | Ops API contract untouched. |
| **6 · Sound and haptics** | Synth sound kit, vibrate patterns, per-event switches, ducking under TTS. | S–M (½ day) | Low | Needs you on the phone to tune volumes. |
| **7 · Settings, polish and audit** | Settings redesign, ambient Full/Low/Off, contrast and focus audit, perf pass on the phone, after gallery. | M (1 day) | Low | Final verification pass. |

**Total:** about 9–10 working days; about 11 with Voice mode.

**Cut-scope options:**
- **Minimum wow:** Phases 0 + 1 + 2 + 3 (≈5½ days). The chat and the chief feel brand new; Fleet and Today get tokens only.
- **Cheaper the chief:** Phase 3 without speaking/listening amplitude (halo reacts to state only). Saves about half a day and removes the audio-analyser risk.
- **Skip Voice mode (3b)** first if time is tight.

## 11. Proposed new runtime dependencies

| Package | Why | Size (gzip, used parts) | License |
| --- | --- | --- | --- |
| `lucide-react` | Consistent icon set, tree-shaken | ~8–12KB for ~40 icons | ISC |
| `@fontsource-variable/inter` | Self-hosted Inter Variable with optical sizing; no runtime requests | Fonts only (≈60–75KB woff2 latin) | OFL |
| `geist` | Self-hosted Geist Mono for code and telemetry | Fonts only (≈30KB woff2) | OFL |

Deliberately **not** added: sheets and toasts are built on the already-installed `motion` (its drag gives velocity-aware dismiss) instead of `vaul` or `sonner`. Sound is synthesized with Web Audio. Haptics use `navigator.vibrate`. `@paper-design/shaders-react`, `blobatar` and `motion` stay.

## 12. Dynamic roster: minting and retiring bots

The chief is the fleet manager and mints or retires bots whenever it needs to. **This is a hard requirement for every phase.**

**How it works today (unchanged by this plan):**
- The bridge rescans Hermes's `profiles/` folder on every `/snapshot`, skipping deleted profiles, so a new bot reaches the dashboard within one poll (≤2.5s).
- No component hard-codes bot names, ids or counts. The only special case is the chief, identified by `isChief` (profile id `chief`).
- The overhaul adds no bot list, no per-bot assets and no bot-specific code.

**Rules the new UI must keep:**

1. **Every bot gets a face with zero setup.** A freshly minted profile with empty `ui_meta` gets a unique, stable identity derived from its profile id:
   - shape: hashed from the 7 geometric shapes, with Blobatar still supported
   - hue: hashed into the curated 10-hue palette
   - personality: breathing phase, blink cadence and glance habits, also hashed

   The same bot looks the same on every device and every reload. Hermes styling is used only when it's present and marked custom, never required. Unknown or malformed shape strings fall back to the hashed shape instead of breaking.
2. **Any text is survivable.** Missing title or description, very long names, emoji, or a title without the "Name - Role" dash all render cleanly:
   - the name/role split falls back to the whole title as the name
   - long names truncate with the full name in the Look drawer
   - photo avatars (`imageKind: photo`) use the same rig
3. **Layouts scale with the count.**
   - **Desktop orbit:** one ring up to 12 specialists; a second, outer ring beyond that (tested up to 30). Seats animate to their new positions whenever the count changes.
   - **Phone mini-orbit:** shows up to 10 faces plus a "+N" chip.
   - **Lists:** grow without limit. Unknown or empty sections fall under "Specialists", and new sections appear automatically in a stable order.
4. **Arrivals and departures are detected by diffing roster ids between snapshots.** They're never announced on first load, after a reconnect, or after the app returns from the background, so a restart or outage never triggers a flood of toasts. The mint and retire moments (§3.2) have their own sound and haptic switches, plus a "Fleet changes" toast switch.
5. **Removal is always safe.**
   - The face clock unregisters removed faces (no leaks).
   - Beams and dispatch animations aimed at a removed bot cancel cleanly.
   - An open Look drawer shows the retired message and then closes.
   - A bot that is minted and starts working in the same snapshot plays the mint first, then the dispatch beam.

**Verification for §12:**
- **New vitest roster-churn test:** render Fleet (orbit and list) and step through 3 bots → 6 → 2 → 14. The additions include an empty-meta bot, an unknown shape, a 60-character emoji name and a photo avatar; the removals include the bot whose Look drawer is open. Assert:
  - no errors and every face rendered
  - mint and retire toasts fire exactly once per change and never on the first snapshot
  - face-clock registrations equal the faces actually mounted
  - the drawer closes after the retired message
- **Capture tool:** new scenarios that patch `/api/bridge/snapshot` inside the headless browser, adding a synthetic bot and removing one, so the mint and retire moments appear in the after gallery. Nothing is written to Hermes.
- **Live check on the phone** the next time the chief mints or retires a bot.

## 13. What does not change

- Every existing behavior:
  - polling and honest degraded states
  - approvals resolving the same Hermes queue
  - optimistic sends with retry-safe ids
  - speech queue, Stop and Pause
  - Compact chat, Stay awake, Speak replies
  - Today → the chief handoff
  - 60/40 split
  - bots appearing and disappearing whenever the chief mints or retires them (§12)
- Hold-to-talk and its gesture (press, slide to cancel, release to send).
- Bridge protocol, Python plugin, Hermes gateway, port 3000, Tailscale Serve, loopback trust model.
