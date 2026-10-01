# Plan: threads with Chief, Team & Routines, a calmer Settings, names, and a usage tracker

Status: approved 2026-10-01 from the owner's notes on 0.1.3; built and verified 2026-10-01 (PROGRESS, 2026-10-01). A bot's routine delivery took the fallback described in §1: Hermes blocks it, so the bridge relays it.

**Decisions (owner, 2026-10-01):**
1. **Threads: a switcher.** The chat header shows the thread's title with a menu: threads newest first, each with its state (working, a question waiting, unread), plus New thread, Rename and Archive.
2. **Clearing a thread is a fresh start, and history is kept.** Chief starts a new context in that thread (Hermes `/new`). The earlier conversation folds into "Previous conversation", which can be expanded. Nothing is deleted. Memory and the Second Brain carry over.
3. **Team & Routines, any bot.** The Team button becomes **Team & Routines**, with two tabs. The Routines tab lists everything scheduled (Second Brain, Fleet, the owner's own), and supports:
   - add a routine;
   - edit what it does and when it runs;
   - choose which bot runs it and which thread it reports to;
   - run it now, pause it, delete it.
4. **Usage: tokens, cost and a budget.** A strip under the galaxy, switched on or off, plus a Usage page in Settings. A monthly budget turns the strip amber at 80 % and sends one notification at 100 %. Nothing is ever stopped automatically.

Not asked, so settled by current practice:
- **Settings layout.** One window with a category list:
  - On desktop: a sidebar of categories with labels and icons, the page beside it, at most two levels deep ([UX Planet](https://uxplanet.org/best-ux-practices-for-designing-a-sidebar-9174ee0ecaa2?gi=87da876539ec), [Alf Design Group](https://www.alfdesigngroup.com/post/improve-your-sidebar-design-for-web-apps)).
  - On the phone: the category list, then the page, with a back button.
- **Names.** Any bot, Chief included, is renamed from its Look drawer: name and role. The SOUL's "You are …" line follows, unless the owner unticks that.

## 1. What the review found

- **Threads are safe in Hermes.**
  - The gateway runs one live turn per session, and sessions run in parallel (an unbounded executor, no admission cap by default).
  - Memory, skills and the Second Brain belong to the profile, so every thread shares them.
  - The app pins the chat to one session key, `agent:main:command_center:dm:owner`. A thread is a second chat id on the same Command Center platform (`owner.t-<id>`), so it gets its own session key.
  - Hermes already keys everything per chat id or session key: the busy state, questions (`clarify`), live steps (`set_status_text`), `/stop`, `/queue` and steering. Nothing in the bridge has to guess which thread a step belongs to.
- **`/new` asks for confirmation** (`tools.slash_confirm`, text fallback `/approve`). A fresh start from a menu answers it for the owner, after the app's own confirmation.
- **Routines can run as any bot.** Hermes's in-process ticker visits every live profile's cron store (`profiles_to_serve(multiplex=True)` is re-enumerated each cycle), so a job in a bot's store runs as that bot: its SOUL, model and skills. Delivery from a bot's job into the app is checked before it is relied on; if Hermes can't route it, the bridge shows the job's latest output as a notice in the chosen thread.
- **Usage data exists.**
  - Every session row in each profile's `state.db` carries input, output, cache and reasoning tokens, API calls, and estimated cost; actual cost when the provider reports it.
  - `session_model_usage` adds the background tasks (title generation, compression, background review).
  - Costs come from Hermes's pricing snapshot (`cost_status: estimated`). A provider without pricing has unknown cost; the app says so, never shows $0.
- **Names live in each profile's `profile.yaml`** (`ui_meta.hermes-bots.title`, "Name - Role"). Nothing in the app writes them yet. The chief's name in the app follows the roster title.
- **Settings is one long scroll of 12 groups** in a side sheet.

## 2. Design

### 2.1 Threads

**Bridge (`threads.py`):**
- `command_center_threads.json` in the chief's profile: id, title (the owner's, else Hermes's session title), created, archived.
- The main thread is `main` (chat id `owner`, today's session key, so nothing moves). Every other thread is `owner.t-<8 hex>`.
- Endpoints: `GET /threads` (each thread's state: working, a question waiting, last activity, title), `POST /threads` (new), `POST /threads/rename`, `/archive`, `/restore`, `/fresh` (sends `/new` and answers the confirmation).
- `/transcript`, `/send`, `/stop`, `/steer`, `/queue` and `/clarify` take `thread` (default `main`).
- The adapter queues a message on the thread's chat id. Its sends and notices carry the chat id, so notices land in the right thread. Push notifications open the thread they came from.
- "Previous conversation": the transcript lists the thread's earlier sessions (same key, older session ids), and `GET /transcript?thread=&session=` reads one.

**Web:**
- A `ThreadSwitcher` in the chat header: the title and a ▾ menu.
  - Each thread shows a spinner while working, an amber dot for a question, and an accent dot for unread (per device).
  - Menu actions: New thread, Rename, Fresh start (confirmed), Archive. Archived threads sit at the bottom, folded.
- The chat remounts per thread. A light `/threads` poll keeps the other threads' dots current.
- "Send to Chief" from Today, Team or Fleet Health goes to the open thread.

### 2.2 Team & Routines

**Bridge (`routines.py`):** every cron job in the chief's and the bots' stores.
- Each job carries: who runs it, name, what it does (prompt), when (a schedule in words, plus the cron expression), on/off, next and last run, last status, last output, the thread it reports to, and whether it is built in.
- Create and update take a schedule in plain parts: daily at a time, weekdays, chosen days of the week, every N hours, or a custom cron expression.
- Run now (`trigger_job`), pause, resume, delete.
- Built-in routines (`Second Brain: …`, `Fleet: …`) can be retimed, moved to another thread and switched off, but not deleted: the app would arm them again.

**Web:** the Team sheet becomes **Team & Routines** with two tabs.
- **Routines** lists every routine with its bot's face, title, when it runs, next run, last result, and an on/off switch.
- Opening one shows its editor:
  - **What:** the instructions.
  - **When:** Daily, Weekdays, Weekly with day chips, Every N hours, or Custom.
  - **Who runs it:** a bot picker.
  - **Report to:** a thread picker.
  - Actions: Run now, Pause, Delete (confirmed), and the last output.
- "New routine" opens the same editor, empty.

### 2.3 Settings

**`SettingsWindow`:**
- On desktop, a centred window about 960 × 85 % high, with a category sidebar and the page beside it.
- On the phone, full screen: categories, then the page, with a back button.
- The selected category is remembered per device. Other parts of the app can open a category directly (the usage strip opens Usage).

**Categories**, built from the existing groups (each keeps its own behaviour):

| Category | Holds |
| --- | --- |
| General | Your name, Chief's name and role, this app (fullscreen, text and interface size, motion, ambience) |
| Models & keys | Connection, providers and keys |
| Voice | Chief's voice, speech recognition, Check my system |
| Second Brain | The folder, and a link to its routines in Team & Routines |
| Notifications | Notifications, sounds, haptics |
| Usage | The usage page and the budget |
| Backup & updates | Backup and restore, updates |
| About | Version, the bundled Hermes, the toolkit's licence and notices |

### 2.4 Names

- `POST /profile/rename {profile, name, role, update_soul}` writes the profile's title.
- The SOUL's first "You are <old name>" becomes the new name when `update_soul` is set (the default). An edited SOUL whose first line says something else is left alone, and the reply says so.
- The Look drawer's header gets a pencil next to the name, with an inline name and role form. Settings, then General, has the same for Chief.

### 2.5 Usage

**Bridge (`usage.py`):** reads every profile's `state.db`, read-only.
- Totals, per bot, per model and per day, for today, 7 days, 30 days and this month.
- Tokens: input, output, cached, reasoning. Costs: estimated and actual. Plus session and call counts.
- Costs a provider has no price for are counted as unknown.

**Budget:** `usage_budget.json` in the chief's profile.
- The watch loop checks it every few minutes: amber at 80 %, one push at 100 %, at most once per month for each.

**Web:**
- **Strip.** A slim bar at the bottom of the galaxy, switched on or off from the Fleet header (per device). It shows:
  - today's spend and tokens;
  - this month's spend against the budget, as a bar;
  - the top bots by spend, as faces with amounts.
  Tapping it opens Settings, then Usage.
- **Usage page.** A period switch, three totals (spend, tokens, cache share), a daily spend chart, a per-bot table, a per-model table, and the budget editor.

## 3. Order of work

1. Names (bridge and drawer).
2. Settings window and categories (the existing groups move, unchanged in behaviour). About page with licences.
3. Usage: bridge, strip, page, budget alerts.
4. Threads: bridge, switcher, fresh start, previous conversations, per-thread notices and pushes.
5. Team & Routines: bridge (including a real check of a bot's routine reporting into the app) and the tabbed sheet with the editor.
6. Tests at every layer, contracts on the payload, browser checks on desktop and phone, then build 0.1.4.

## 4. Risks

- **Parallel threads double the spend when both work.** The usage strip makes that visible.
- **A bot's routine delivering into the app** is unproven until checked. The fallback is to show its output as a notice.
- **Moving every Settings group** risks dropped behaviour. Each group keeps its component, and the existing settings tests must pass unchanged, apart from where things are found.
