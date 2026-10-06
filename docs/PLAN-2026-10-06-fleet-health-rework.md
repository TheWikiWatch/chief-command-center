# Fleet Health: flags that mean something (2026-10-06)

## The problem

"<skill> keeps being rewritten" flags never went away. Read against a live ledger, none of them were faults:

1. **Hermes edits skills by design.** Its background review is told to be active ("most sessions produce at least
   one skill update"). The churn rule (5 edits in 48 h or 10 in 7 days) flagged every skill in regular use.
2. **One save counted several times.** An edit was one row per file, so a save that touched SKILL.md and two
   references counted 3. A new skill being written on its first afternoon looked like 8 edits.
3. **Growth was called "fighting itself".** Almost every edit added lines (+56, +17/−3, +12/−1). Moving detail into
   `references/`, which Hermes and the slimming flag both ask for, also counted.
4. **The cure fed the symptom.** "Ask the chief" asked for a rewrite, which is an edit, which kept the flag up. The
   skill the chief uses to handle flags was itself flagged, mostly by its own flag handling.
5. **Nothing could switch a flag off.** No acknowledgement, and the 7-day count kept a quiet skill flagged for days.
   The phone was pushed again every week (the flag id carried the ISO week).
6. **An adopted install ran an older ledger.** Its cron job ran the owner's original tool, so none of the app's
   ledger fixes reached it.

Decisions (owner, 2026-10-06): warn only on rework; "Looks fine" plus a 48-hour auto-clear; "Ask" reviews first and
tidies once, and its tidy-up doesn't count; adopted installs switch to the app's ledger.

## The rule: rework, not volume

- **A save** is a skill's file changes less than 10 minutes apart. Edit counts are saves.
- **Reworked lines** in a save are lines it removes or rewrites that an *earlier save* added within 14 days.
  Not counted:
  - the YAML front matter (version bumps);
  - a line moved to another file of the same skill in the same save;
  - lines that came from the app, a copy or a revert.
- **A rework save** reworks at least 2 lines. Saves are excluded if they fall in a skill's first 3 days, or within
  6 hours after the owner asked the chief about that skill (the tidy-up they asked for).
- **Flag:** 3 or more rework saves in 7 days, the latest within 48 hours. The detail quotes one reworked line, so
  the owner sees what is being fought over.
- **Flag id:** the first save of the current run of rework saves (no gap over 48 h). A run that continues keeps its
  id, so the phone is told once per run, not once a week.

On the live ledger this turns 5 standing flags into 1 today, and at most 2 at any point in the past week.

## Looking at a flag

- **Looks fine** hides a flag on every device until something new happens: a new rework save, a skill edit
  (size flags), or 7 days for a memory flag. It's stored in `flag-acks.json` next to the report.
- **Ask the chief** sends a review-first message, records an "asked" acknowledgement (hidden the same way), and the
  chief's tidy-up within 6 hours is labelled "the tidy-up you asked for" and never counts as rework.
- Hidden flags stay one tap away ("2 hidden"), each with **Show again**.
- The report carries `subject` and `evidenceAt` on every flag. The dashboard applies acknowledgements at once,
  before the next ledger run.

## Adopted installs use the app's ledger

- `ownLedger` in desktop.json (default false). When false, the adopted install's dashboard runs the bundled
  ledger. At start, the bridge copies the ledger into the chief's `scripts/` and points any job running another
  `learning_ledger` script at it. The previous script name is kept in `ledger-switch.json` in the learning folder.
- The data folder (`learningDir`) and its history are unchanged.
- Setting `ownLedger: true` puts the old script back at the next start.

## Checks

Ledger unit tests (saves, rework, front matter, moves, new-skill grace, asked tidy-ups, acknowledgements, ids);
route and UI tests (Looks fine, Ask, hidden list, Show again); the e2e home; the privacy scan.
