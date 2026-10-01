# Plan: fleet management for every chief, and chat controls (stop, add context)

Status: approved 2026-09-30, from the owner's first-use notes on the installed app. Steps 1 to 3 of §6 are built and tested; step 4 is the 0.1.1 build for the owner's reinstall.

**Decisions (owner, 2026-09-30):**
1. **Enter while Chief works = Add to current work** (steer). Send after (queue) is the second action; Stop is its own button.
2. **New workers get Chief's model** by default. **Every bot has a model dropdown** next to its SOUL and memory (the Look drawer), listing every model from the connected providers. Adding models and keys gets a clean manager in the app (Settings → Models & keys).
3. **Retire = archive, then remove.** The Fleet tab lists retired workers with **Restore** and a permanent **Remove** (deletes the archive, after confirmation).
4. The installed test app is uninstalled in full (its data moved aside, not deleted), and a fixed version is built for a fresh reinstall.

## 1. What the notes found

| Note | Cause | Evidence |
| --- | --- | --- |
| Chief has no fleet-management personality; can't mint, retire or adjust workers | The fresh chief got none of the pieces that make the existing chief a fleet manager. Those pieces are personal to the existing install and were deliberately not copied. | The existing chief's ability comes from four things. (1) Its SOUL: mission "grow and manage a fleet", sign-off gates, model pin and working folder per worker. (2) A general `botmaker` skill (MIT) carrying many site-specific paths. (3) A personal `fleet-ops` doctrine with a desk table. (4) The **kanban toolset**, which Hermes doesn't enable by default (`toolsets: [hermes-cli]`). The fresh profile has none of the four. |
| The ElevenLabs key box is always open | `ProviderList` auto-opens the key field of `preferOpen="elevenlabs"` whenever ElevenLabs lacks a key. The existing install always had one, so the box never showed there. | `apps/web/components/settings-panel.tsx` (`preferOpen`, `prefer`, `useEffect`) |
| A red ring around "Message Chief" on click | The global `:focus-visible` rule draws a 2 px **accent** outline (red), and text fields always match `:focus-visible`. The composer already shows its own focus border. | `app/globals.css` `:focus-visible`. The existing repo has this exact fix, uncommitted: `focus-visible:outline-none` on the composer textarea. |
| No way to stop the chief's current work | The gateway supports it (`/stop`: "stop what's running in this chat"), but the dashboard never exposes it. | `gateway/run_busy.py`, `gateway/run_inbound.py` |
| No way to add context without stopping | Hermes supports **steer**: "inject a message after the next tool call without interrupting", with fan-out to running sub-agents and a fallback to the queue so nothing is lost. It also supports **queue** for the next turn. But the chief runs in `busy_input_mode: interrupt` (the default and the existing install's setting), so **a message sent while it works today stops the current turn**. | `hermes_cli/commands.py` (`/steer`, `/queue`), `gateway/run_busy.py` |

## 2. Current practice (researched 2026-09-30)

- Agent UIs have converged on three verbs during a run: **Queue** (after this turn), **Steer** (into this turn, at the next safe point, keeping progress) and **Stop** (cancel; partial output kept and marked interrupted) ([zylos research](https://zylos.ai/research/2026-08-25-agent-message-preemption-queueing-single-loop/), [Hermes /busy](https://aiprofitboardroom.com/blog/hermes-busy-command/)).
- Codex CLI's steer mode: **Enter steers** the running turn, **Tab queues** for after it; no more Ctrl+C to stop a mistake ([Codex CLI shortcuts](https://codex.danielvaughan.com/2026/04/08/codex-cli-tui-shortcuts-slash-commands/), [Ian Nuttall](https://x.com/iannuttall/status/2012081161279848450)).
- Chat apps show **queued messages as visible chips** with steer-now / remove per message, and **Stop + Escape** ([piem #296](https://github.com/YoungSx/piem/pull/296), [codemux #399](https://github.com/Zeus-Deus/codemux/pull/399), [archestra #7884](https://github.com/archestra-ai/archestra/pull/7884)). A Hermes front end asks to choose Queue, Steer or Stop & send per message ([hermex #858](https://github.com/uzairansaruzi/hermex/issues/858)).
- The send button becomes a **Stop (square)** button while the agent is working (ChatGPT, Claude); **Esc** stops.

## 3. Chat controls: design

**While the chief is working** (the bridge already reports `generating`):

- The composer stays usable, with the placeholder "Add to what Chief is doing…".
- **Enter = Add** (steer): the message goes in at the next safe point. The bubble shows a small "added while working" tag. If the turn ends first, Hermes queues it, so nothing is lost.
- **A second action, "Send after"** (queue), on Tab or the send button's menu: the message appears as a chip above the composer. Each chip has **Add now** and **Remove** until the turn ends.
- **Stop**: a square button next to Send, plus **Esc** while the composer is focused. One tap stops the current turn. The partial reply stays, marked "Stopped". Pending approvals are cancelled, and queued chips are kept (shown, not auto-sent).
- The phone gets the same controls: Stop in the header area while working, and Add vs Send-after through a long-press on Send.

**Plumbing**
- New bridge routes `/stop`, `/steer` and `/queue` (and `/queue` list/remove). They inject Hermes's own `/stop`, `/steer <text>` and `/queue <text>` into the chief's chat session through the Command Center adapter. These are command events, not user bubbles, and they never touch other chats or profiles.
- A message sent while working uses the chosen verb explicitly, so the profile's `busy_input_mode` no longer decides silently. For new installs, the app sets `busy_input_mode: steer`, so Hermes's own default in other front ends matches. The existing install is not changed without your say-so.
- Tests: bridge contract against a real gateway (a long fake-model turn: stop mid-run; steer lands in the same turn; queue runs after), UI unit tests, and an end-to-end check on the installed app.

## 4. Fleet management for every chief: design

Goal: a fresh chief can propose, **mint**, **revise**, **pause**, **retire (unmint)** and **delegate to** specialist workers, with the existing chief's discipline. It must not carry anyone's personal desks, paths or names.

**Skills, bundled with the app and installed into the chief at provisioning:**
- `fleet-builder` (the generic successor of `botmaker`):
  - Interview: one-sentence job, what it isn't, failure the brain must survive, home folder.
  - A one-screen SOUL draft, then the **owner signs**.
  - `hermes profile create NAME --no-skills --description "…"`, then model pin, `terminal.cwd`, display name ("Name - Role") and section, signed SOUL.
  - First job on the kanban, then "certified". No memory written for the child.
  - **Revise:** SOUL rewrite with sign-off; model or folder change. **Pause:** stop assigning it. **Retire:** archive the profile (restorable), then `hermes profile delete`, with sign-off.
- `fleet-ops` (generic doctrine): the three moves (do it, delegate, propose a mint). Route by `hermes profile` descriptions (which Hermes's kanban orchestrator also uses). Kanban cards with subscriptions. "No vaporware": a promise is backed by a parked job.

**Safe model access for workers:**
- A small script ships with the skill: `grant-model NAME --provider P --model M`. It pins the worker's model and copies **only that provider's key** from the chief's profile into the worker's, through Hermes's own credential code, without printing it. The agent never reads or echoes a key.
- Default: the worker gets the chief's current provider and model (decision 2). The owner can change it any time from the bot's model dropdown.

**Chief's default SOUL** gains a short "Your fleet" section. The mission includes growing a team for recurring work. Mint, rewrite or retire only with the owner's sign-off. Propose instead of minting silently. Workers get their own model pin and working folder.

**Provisioning (desktop app):** enable the `kanban` toolset for the chief; install the two skills (re-synced when they change, never overwriting an owner's edits to their own copies); set `busy_input_mode: steer`.

**Models & keys (decision 2):**
- Settings → **Models & keys** lists every provider Hermes knows, with its status: connected, needs key, or local/custom. It has **Add key / Replace key / Remove key** and **Add a local or custom endpoint**, through the existing `providers.py`, which uses Hermes's own credential lifecycle. Keys are never shown again.
- Keys can be shared with workers: a provider connected for the chief can be granted to any bot, so a worker on that provider gets the key in its own profile through Hermes's credential code.
- **Per-bot model dropdown** in the Look drawer (with Identity / Notes / About you). It lists all models of connected providers (Hermes's model inventory) and shows the current pin. Changing it pins `model.provider` and `model.default` for that profile, and grants the key if needed. It shows the expensive-model confirmation Hermes already has.

**Dashboard:**
- The Fleet tab already lists every profile.
- Added there: **"Propose a specialist"**, which sends Chief a structured prompt. Each card gets **Edit SOUL** (the existing persona editor), **Pause / Resume**, and **Retire…**. Retire runs the archive + delete through the chief, or directly with a confirmation that lists what's kept.
- A retired worker's archive is listed with **Restore**.

**Existing install:** untouched. Its own `botmaker`, `fleet-ops` and SOUL stay. The bundled skills don't replace same-named ones.

**Tests:** contract on a real payload. Mint from a signed spec on a throwaway home: profile exists, pinned, kanban card delivered by the dispatcher, key not echoed in transcript or logs. Then revise, pause and retire with archive and restore. The persona editor works on a worker.

## 5. Small fixes (no decisions needed)

1. Composer: `focus-visible:outline-none` on the textarea (the existing repo's uncommitted fix).
2. Voice settings: the key box opens only when the user picks a provider that needs a key.
3. Port the existing repo's other uncommitted changes: the session-start status showed only `components/chat/composer.tsx` and `docs/PROGRESS.md`; both are checked.

## 6. Order of work

1. The small fixes, then a new test build. Same day.
2. Chat controls: bridge routes, composer and phone UI, steer default, tests.
3. Fleet: skills, grant-model script, SOUL section, provisioning, Fleet tab actions, contract tests.
4. A new MSIX (version 0.1.1, so it installs as an upgrade with data kept), then an end-to-end check: mint a worker, hand it a card, steer, stop, retire, restore.
