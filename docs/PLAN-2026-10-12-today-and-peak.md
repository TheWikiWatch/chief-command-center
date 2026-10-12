# Today's list and the DeepSeek peak chip (2026-10-12)

## 1. Tasks in the morning brief but not in Today

**Report.** Two tasks the chief added for an upcoming event (due 2026-10-12, 🔴, on one of the work boards) showed
in the 8 AM brief but not in Today.

**Root cause.** Nothing was lost: the cards were on the board, and the built-in reader parsed them. Today's
"Do first" list was `rankToday(…, limit = 12)`. Overdue cards score 100+ and "due today" scores 90, so 16 overdue
cards (several 40–72 days old) took all 12 places and the two due-today cards ranked 17th and 18th. The brief's job
("☀️ Morning Daily Note") lists every card due today or overdue with no limit, so the two disagreed. The Attention
view and the area drill-down showed the cards all along.

**Options considered.**
- A: sections.
- B: due-today above overdue in one list of 12.
- C: a Stale pile.
- D: a one-off clean-up of the data.

The owner chose A + C.

**Built.** `lib/today-sections.ts` + `components/today/sections.tsx`, client-side from the boards Today already
fetches, so the Ops API shape (and an external task service) is unchanged. Read-only: nothing writes a board.

| Section | What | Shown |
|---|---|---|
| Today | due today (waiting ones say so), in progress, a task service's pulse items | all, never cut off |
| Overdue | 1–14 days late, most recent first | 5, then "Show all" |
| Coming up | due in the next 3 days; 🔴 undated cards in This Week or Next Week | 6, then "Show all" |
| Stale | more than 14 days late | folded; "Ask the chief to sort these" sends a list and asks for suggestions, nothing changed without the owner's OK |

Backlog stays out of Coming up (parked on purpose). On the live vault: Today 2 (both event cards), Overdue 7,
Coming up 1, Stale 9.

## 2. DeepSeek peak chip

**Report.**
- The times seemed wrong ("only on Wednesday").
- On the phone the chip crowded the header.
- It said "Peak" at odd times.

**Findings.**
- **The schedule was right.** It matches DeepSeek's page, checked 2026-10-12: 01:00–04:00 and 06:00–10:00 UTC on
  weekdays, Chinese public holidays off, and peak costs twice as much.
  - In US Eastern time that is 9 PM–midnight (Sun–Thu) and 2–6 AM (Mon–Fri): correct, but it looks odd from here.
  - "Only on Wednesday" was Golden Week. Oct 1–7 was a holiday, so the first peak after it was Wed Oct 7, 9 PM EDT.
  - The app never said why it was off-peak, or when peak was in local time.
- **The overlap was a real bug.**
  - The chip was `shrink-0` beside the name, while the name block could shrink to 3.25rem, so the chip spilled over
    the thread switcher.
  - The same pattern was in the phone headers of Today and Vault: a long status label ("Approvals error",
    "Reconnecting…") was `shrink-0` and pushed over the title, which didn't truncate.
- **Freshness.** The chip re-read the clock every 30 s. After the phone app came back it could show the old phase for
  up to 30 s.

**Built.**
- **Schedule (`lib/deepseek-schedule.ts`).**
  - Windows are computed directly (no minute-by-minute scan).
  - Holidays have names.
  - New helpers: `peakWindows`, `currentPeak`, `offPeakReason`, `localWeek`, `shortTime` ("midnight"), `localZoneName`.
- **Header chip (`DeepseekChip`).**
  - Shown during peak only.
  - It is a button: "Peak · 2× until midnight" when the name area is at least 12rem wide (`@container/name`), else
    "Peak 2×".
  - The name row clips instead of spilling.
  - Tapping it opens a sheet with the next 7 days' peak hours in local time.
  - It re-reads the clock exactly at the next flip, once a minute, and on focus, visibility and pageshow.
- **Status sheet (`DeepseekSchedule`).** Always shows the state and why ("Chinese public holiday: National Day"), the
  week in local time, and whether DeepSeek's page still matches.
- **Phone headers.** The status label truncates before a title does (`HeaderStatus` / `ConnectionDot`), and the
  Today and Vault titles truncate with a minimum width.

**Upkeep.** The holiday list covers 2026 only, so a 2027 holiday would show as peak. China publishes the next year's
schedule around November; add it to `HOLIDAYS` in `lib/deepseek-schedule.ts`. The app says when the dates on file
don't cover the year.

## Checks

- `tests/today-sections.test.ts`: the real case (16 overdue vs 2 due today), the order within sections, pulse
  items, and the stale message.
- `tests/deepseek-schedule.test.ts`: windows, Golden Week, the reasons, the copy.
- `tests/deepseek-chip.test.tsx`: hidden off-peak, the pill and sheet, the flip without a poll, the status sheet.
- Browser at 375 px and 1280 px, on a copy of the live boards, with a faked peak clock. Today's sections, the Stale
  pile, the header chip and its sheet, and the Today header with a long status label all render without overlap.
