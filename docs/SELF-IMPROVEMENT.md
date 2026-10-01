# How the chief and its team get better, and what checks it

Two layers. Hermes itself improves skills and memory after conversations. The app adds the oversight: a record of every change, a verdict on whether it helped, and a weekly set of proposals the owner decides on.

This table compares the owner's original install (the reference this app reproduces) with the app as shipped. "Original" lists only what the app aims to match; integrations specific to one person's setup are listed at the end.

| Piece | What it does | Original install | The app |
| --- | --- | --- | --- |
| Background review (Hermes) | After a conversation, a background pass saves lasting facts to memory and patches or creates skills | On (Hermes default) | On (Hermes default) |
| Curator (Hermes) | Marks agent-made skills unused for 14 days stale, archives them after 30 (recoverable) | On | On |
| Skill change log (Hermes) | Every skill mutation logged with before/after, `hermes curator rollback` | On | On |
| Memory | A bounded memory and user profile in every prompt | Chief's limits raised to 4400 / 2750 characters | The same for the chief (set at provisioning unless the owner chose); bots keep Hermes's 2200 / 1375. Fleet Health flags a memory 95 % full |
| Learning ledger | Every 30 minutes, records each skill file that changed and what changed it (background review or not) | The owner's own tool, scheduled by hand | Bundled (`ledger/learning_ledger.py`), armed automatically: `Fleet: learning ledger` |
| Episodes and verdicts | Edits within 48 hours are one episode; 14 days after, its desk's cards before and after decide "helped", "worse", "no clear change", "confounded" (crashes) | Yes | Yes (same code) |
| Flags | Churn, bloat, growth, a "worse" episode, a full memory, a stale proposal | Yes, pushed to the phone once each | Yes, pushed to the phone once each |
| Fleet Health view | Flags, skills by churn, episodes, diffs, hold-to-revert with a count of later edits, proposals | Yes | Yes, on by default |
| Weekly lessons distill | Reads the report, the owner's decisions and the week's corrections; writes up to five proposals; never applies anything | The owner's skill, Sundays | Bundled `fleet-lessons-distill` skill and job `Fleet: lessons distill (weekly)`; it also appends the week to `learning/LEARNINGS.md` |
| Approve / Dismiss | The owner's decision on each proposal, shared by every device; an approved one is "applied" once the skill it names changes | Yes | Yes |
| Monthly roster review | Who is busy, who is idle, at most three proposed changes | Yes | `fleet-ops` skill's roster review, job `Fleet: roster review (monthly)` |
| Second Brain routines | Morning note, nightly consolidation, weekly review, health check | Yes (the owner's vault skills) | Yes, from the bundled `obsidian-second-brain` toolkit; on/off and time in Settings |
| Second Brain first | The chief checks the Second Brain before answering from memory; every write follows the full rules | SOUL rule and a write-gate skill | SOUL section, `second-brain` skill auto-loaded in every conversation (with `CRITICAL_FACTS.md`), `second-brain-writes` write gate |
| Reasoning effort | How hard the model thinks | Set to the maximum by the owner | The provider's default (the owner's choice) |

## Not bundled (one person's setup)

Each of these depends on an account, a device or a habit of the original owner. A new owner can ask the chief to set up their own equivalent:

- drop-folder ingest and its integrity recovery;
- a weekday human-feedback brief;
- mail response watches tied to one mail client;
- watchdogs for one machine's gateway and other services;
- health sweeps for named bots.

## Where things are

- Fleet Health data: `<Hermes root>/learning/` (`report.json`, `report.md`, `ledger.db`, `proposals.json`, `decisions.json`, `LEARNINGS.md`).
- Jobs: the chief's cron jobs named `Fleet: …` and `Second Brain: …`. The app recreates a missing one, and leaves one the owner paused or retimed alone.
- Code: `hermes/plugins/chief-dashboard-bridge/learning.py` (jobs), `ledger/learning_ledger.py` (the ledger), `second_brain.py` (routines, auto-load), `skills/autonomous-ai-agents/` (distill, fleet-ops).
