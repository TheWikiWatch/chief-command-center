# Plan: Second Brain parity, Fleet Health and self-improvement, and a chat that never hides a question

Status: approved 2026-09-30 from the owner's notes on 0.1.1. Decisions below are the owner's answers. Every section is built and tested: §3.0 shipped as 0.1.2, the rest as 0.1.3.

**Decisions (owner, 2026-09-30):**
1. **Second Brain: bundle upstream.** Ship a pinned, unmodified release of the public `obsidian-second-brain` toolkit (MIT, Eugeniu Ghelbur, Hermes build) with attribution. Add a generic write-gate skill written for the app. Adapt the vault template to the toolkit's conventions.
2. **Second Brain first, every time.** Chief, every bot and every scheduled job get the Second Brain skill and a short critical-facts note auto-loaded. The SOUL says to check the Second Brain first and follow its full rules for every write.
3. **Fleet Health: bundle a generic ledger.** Port the learning ledger into the app, with no personal data. It tracks the app's own skills and bots, and Fleet Health is on by default. Generic weekly lessons-distill and monthly roster-review routines come with it.
4. **Speed: show live steps.** The thinking row says what Chief is doing and for how long. Tool search stays as Hermes ships it, and background tasks stay on the main model (not chosen).

## 1. What the review found

**Chief "thinking" for 15+ minutes (the real bug).**
- Chief's first turn took 17 s over 5 model calls: 1–5 s each, prompt cache 88–99 %, no provider errors.
- It ended by calling Hermes's `clarify` tool (a multiple-choice question). The gateway delivered the question through the adapter's `send()`, which writes the bridge outbox (`command_center_outbox.jsonl`).
- **Neither dashboard shows the bridge outbox.** The proxy forbids `GET outbox`, and no UI reads it. So the question was invisible.
- Hermes waits `clarify_timeout` (1 h) for the answer, and its "⏳ Working — N min" notices, the "no home channel" notice and the question all sat unseen.
- The main install has the same gap. Its Chief rarely calls `clarify`. The new fleet-builder skill says "interview the owner", so the new Chief used it at once.
- A typed reply already answers it: the gateway routes the next message to a pending clarify.

**Missing home channel.**
- The main install sets `COMMAND_CENTER_HOME_CHANNEL`. The app doesn't, so Hermes posts "/sethome" notices into the invisible outbox.
- Scheduled jobs that deliver to the default channel then have nowhere to go.

**Second Brain.**
- The app ships one 3 KB skill and a template `AGENTS.md`.
- The main Chief has the ~45-skill toolkit, plus its own write gate (`second-brain-writes`) and a rules file. Its SOUL says:
  - reading is always fine;
  - writing needs the full rules, read before the first write of a session;
  - writes go through a write gate and a verification afterwards;
  - chat-only application of a settled fact is a failed write.

**Routines.**
- The main Chief runs 17 scheduled jobs. The new Chief has none.
- The Second Brain jobs: morning daily note, nightly consolidation, weekly review, weekly health check, drop-folder ingest, human feedback brief.
- The self-improvement jobs: learning ledger every 30 min, weekly lessons distill, monthly roster review.

**Fleet Health.**
- It's built in the app, but switched off: it's an optional connector that turns on only when `CHIEF_LEARNING_DIR` points at a learning ledger.
- The ledger lives in the owner's separate fleet repository (standard library, 827 lines, 10 tests). It isn't bundled.

**Self-improvement, Hermes built-ins.** These are the same in both installs, on Hermes defaults:
- the post-turn background review that saves memory and patches skills;
- the curator, which marks unused agent-made skills stale and archives them;
- the skill mutation log with rollback.

The main Chief also has larger memory limits (4400 / 2750 characters) and `reasoning_effort: max`. These are owner choices, not defaults.

**Smaller items.**
- **Hidden plugin tools.** Hermes always hides plugin tools (the fleet tools) behind tool search, which cost Chief two calls. One was wasted when it batched two deferred calls, which Hermes refuses.
- **"Config migration skipped."** At first start, provisioning wrote `config.yaml` before Hermes stamped `_config_version`. It was harmless that time; fix the ordering.
- **"Stays standalone."** The gateway warns about a machine-wide scheduled task `Hermes_Gateway_chief`, which belongs to the main install. It's harmless: the app never multiplexes. Documented as a fragile seam.

## 2. Current practice (researched 2026-09-30)

- `obsidian-second-brain` v0.15 (September 2026, MIT):
  - It has a native Hermes build (`scripts/build.sh --platform hermes`, then `dist/hermes/INSTALL.md`) and 45 commands.
  - It expects a rules file (`_CLAUDE.md` or `AGENTS.md`), `index.md`, `log.md` and `CRITICAL_FACTS.md`, the last always injected at about 120 tokens.
  - It schedules four agents: morning 8:00, nightly 22:00, weekly Friday 18:00, health Sunday 21:00.
  - Its write rules ("timeless, dated or a pointer") are linted by its health pass.
  - Optional research features need paid keys (xAI, Perplexity) and downloads (Whisper with PyTorch, Ollama `bge-m3`). They degrade gracefully when absent. ([repo](https://github.com/eugeniughelbur/obsidian-second-brain), [README](https://github.com/eugeniughelbur/obsidian-second-brain/blob/main/README.md))
- Hermes supports the pieces this needs natively:
  - `skills.auto_load` pins skills in every new session: CLI, gateway, cron.
  - `send_clarify` is the adapter hook for a native question card. Answers resolve through `tools.clarify_gateway.resolve_gateway_clarify`, and "Other" through `mark_awaiting_text`.
  - `display.tool_progress` and the busy-status notices are the adapter's view of live steps.

## 3. Design

### 3.0 Hotfix: nothing the gateway sends is ever hidden (first, ships alone as 0.1.2)

**Clarify card.**
- The adapter overrides `send_clarify`. The pending question (id, question, choices, multi-select) is kept by the bridge and returned with the transcript long-poll, like approvals.
- New `POST /clarify {id, answer}` resolves it through Hermes's own `resolve_gateway_clarify`. "Other" uses `mark_awaiting_text`, and the composer's next message answers.
- The thread shows a card under Chief's message: the question, one button per choice, "Other…", and "Waiting for your answer" in place of "thinking".
- On the phone it's the same card. A push notification goes out when the app is in the background.
- When the question ends without an answer (timeout, superseded), `retire_clarify_card` marks the card "No longer needed".

**Every other adapter send is visible.**
- Messages that aren't transcript rows: scheduled-job results, notices, and messages from other platforms.
- The bridge merges them into the long-poll as notice rows, by time, labelled "From a scheduled job" or "Notice". `read` is marked when shown.
- "⏳ Working" busy notices are not rows. They feed the live-steps row.

**Live steps.**
- The thinking row shows the current step in plain words ("Checking the team", "Reading your Second Brain", "Searching the web"), from the tool names of the running turn, plus the elapsed time.
- Unknown tools show as "Using <tool>". Steps come from the adapter's tool-progress events, not from parsing text.

**Home channel.** Provisioning sets `COMMAND_CENTER_HOME_CHANNEL` to the owner's chat. Only when unset.

**Config ordering.** Provisioning stamps nothing itself. It runs after Hermes's own first-run config write, so migrations aren't skipped.

**Tests.**
- Bridge unit tests for clarify (register, deliver, resolve, retire) and for notice merging.
- A contract on a real gateway: the scripted model calls `clarify`, the card appears, a button answers, and the turn finishes.
- Web tests for the card, Other, the phone layout and the live-steps labels.

### 3.1 Second Brain parity

**Bundled toolkit.**
- A pinned upstream release is vendored under `hermes/vendor/obsidian-second-brain/<version>` with its LICENSE and a NOTICE.
- It's built for Hermes at payload staging and installed by provisioning the same way as the fleet skills: a hash record, never overwriting owner-edited skills.
- The upstream pin moves through the same compatibility suite as the Hermes pin (`packaging/upstream`).

**Safety defaults.**
- No research command that needs a paid key or a model download runs until the owner adds the key or approves the download in Settings.
- The toolkit's `.env` lives inside the app's data folder (`OBSIDIAN_ENV_FILE`), never `~/.config`.

**Vault template.** It moves to the toolkit's Obsidian-style layout:
- `AGENTS.md` (rules), `index.md`, `log.md` and `CRITICAL_FACTS.md`, plus the toolkit's folders.
- "Keep my folders" and "Reorganize" keep working.
- Today, Vault and the task syntax stay compatible. Today reads tasks, and the toolkit uses the same Tasks-plugin syntax; verified in tests.

**Write gate.**
- A new generic `second-brain-writes` skill, written for the app (the owner's own isn't copied).
- Read `AGENTS.md` before the first write of a session.
- Search before creating.
- Write with frontmatter and links.
- Append to `log.md`.
- Re-read what was written and confirm it in one line.
- "Settled in chat but not written" counts as a failed write.

**Routines.** Setting up the Second Brain creates the toolkit's four schedules: morning, nightly, weekly, health.
- They deliver to the app, and Settings → Second Brain lists them with on/off and time.
- The drop folder and the human feedback brief are opt-in.

### 3.2 Second Brain first

- The SOUL's Second Brain paragraph becomes a section:
  - The Second Brain is the first place to look for context about the owner, their work and their decisions: before answering from memory, before asking them.
  - Reading is always fine.
  - Every write follows the full rules (the `second-brain-writes` skill), with no exceptions for small edits.
- `skills.auto_load: [second-brain]` for Chief. Minted bots get it too: read access always; writes follow the same gate.
- `CRITICAL_FACTS.md` (about 120 tokens) is injected through the same skill.
- An existing install keeps the owner's SOUL. Provisioning updates only an unedited default section, recorded by hash like skills, and otherwise offers the new text in the SOUL editor as a suggestion.

### 3.3 Fleet Health and self-improvement

**Ledger.**
- `learning_ledger.py` is ported into the plugin (`hermes/plugins/chief-dashboard-bridge/learning/`), standard library, with its tests.
- The app's paths replace fixed ones: `<root>/profiles`, the shared skills, the kanban db, and `<root>/learning/{report.json,report.md,decisions.json,ledger.db}`.
- Personal names and paths are removed. The privacy scan covers it.

**Schedule.** A script-only cron job (no agent, silent) runs it every 30 minutes.

**Fleet Health on by default.**
- The desktop app sets `CHIEF_LEARNING_DIR` and runs the ledger on the payload's Python.
- An external ledger can still be configured, as today.
- New flags push to the phone once, as in the main install.

**Distill and roster review.**
- Generic `fleet-lessons-distill` (weekly; writes `proposals.json`, reads the owner's decisions) and roster-review (monthly) skills and schedules, deliver to the app.
- Proposals show in Fleet Health with Approve / Dismiss, as today.

**Fleet notes.**
- `<root>/fleet-notes/LEARNINGS.md` is the distill's running log, linked from Fleet Health.

**Parity table.** It goes into `docs/INVENTORY-unified-app.md`: every self-improvement piece, main install vs app, with status.

## 4. Order of work

1. **Hotfix (0.1.2):**
   - clarify card;
   - visible notices;
   - live steps;
   - home channel;
   - config ordering.
   Contract on a real gateway, then build. The owner reinstalls.
2. **Second Brain first:** SOUL section, auto-load, critical facts.
3. **Second Brain parity:**
   - vendored toolkit and its pin;
   - vault template;
   - write gate;
   - routines;
   - Settings → Second Brain routines list.
4. **Fleet Health:** ledger port and tests, schedule, on by default, distill and roster review, parity table.
5. **Build 0.1.3.** Then an end-to-end check on a fresh install:
   - set up the Second Brain;
   - routines exist;
   - a capture goes through the write gate;
   - the ledger report appears;
   - a skill edit shows in Fleet Health;
   - a clarify question can be answered from the phone.

## 5. Risks

- **Upstream layout vs the app's Today and Vault views.** Verified with tests before the template changes. If they conflict, the app keeps its folders and the toolkit is configured to them, since both read `AGENTS.md`.
- **Upstream size and its Python dependencies.** Only standard-library scripts run by default. Anything heavier waits for the owner's approval.
- **Auto-loading adds about 1–2k tokens per turn.** Mostly cached. Measured before and after on the scripted model.
