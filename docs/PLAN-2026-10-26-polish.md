# Plan: polish pass before wider testing

Status: **in progress** (2026-10-26). A read-only review of the whole app (chat, settings and onboarding, the shell
and its panes, the desktop shell, the bridge) plus screenshots of every main screen in dark and light, phone and
desktop, found about a hundred problems. This plan fixes them in one pass and ships one early release.

The intent the polish serves: a non-technical owner on a phone or the PC should never see jargon, a raw error, a dead
button or a stuck spinner; the new light mode must be as finished as the dark one; and nothing the app does should
lose a message, hammer a service or fight the owner's own actions.

## 1. Things that lose work or get stuck (first)

Chat:
- Quick replies, follow-ups, Connect cards and Today's "send to chief" took the composer's pending photos with them
  (`sendBody`'s default). They send only what they say.
- "Send after" retried a refused message forever with an error chime each second: only a retryable failure goes back
  in the queue; otherwise its text returns to the box.
- Drafts are kept per thread (one thread's draft appeared in the next); queued "send after" messages survive a reload.
- Stop stays visible (busy) while stopping; quick replies say "Sent"; a helper's empty log says so; the previous
  conversation sheet can't show another conversation's messages; a failed thread rename keeps the form open.

Settings and onboarding:
- Restoring a backup in first run no longer leaves Continue dead.
- Report a problem keeps its diagnostics error; About shows "unknown" instead of shimmering forever.
- "Back up now", "Try again" (model test) and pairing can't be pressed twice; phone access and restore show their
  failures instead of sticking on "Turning off…" / "Restoring…".
- The Models page refreshes everywhere after any model change; pairing says when a phone has paired.

Shell:
- Team & Routines opens from anywhere (palette, chat's Manage, Second Brain), not only while Fleet is showing; picking
  a bot in the palette while Fleet Health shows opens it.
- Shortcuts: "/" on Today stays in Today's search; Ctrl+Shift+V pastes plain text again; AltGr+N types "ń"; nothing
  fires behind an open sheet.
- The Status sheet says it can't check while offline (and checks again when back); toasts show above the Look drawer;
  Vault's "Open index" only shows when there is one; the shortcuts sheet slides out.

Desktop:
- Chief recovering by itself no longer throws the dashboard out for the boot page (it lost drafts).
- The new-message notifier no longer loops on an empty conversation, and a second notifier loop can't start.
- Tray "Restart Chief" respects "use the other launcher's gateway".
- The boot page: "Go back to …" shows its progress and its failure; advice never points to Settings it can't open; a
  "Save diagnostics" button where the app can't start.
- Quitting: one quit at a time, "Waiting for Chief to finish… Quit now", and a launch during quitting reopens.
- Every quit path takes the same shutdown (phone access is paused, not left pointing at a dead port).
- Saving diagnostics reads only the end of each log, off the main thread.

Bridge:
- A send that fails after its id was claimed (a full disk while saving a photo) is released, so the retry goes
  through instead of being dropped as a duplicate; half-saved uploads are removed.
- A bot's provider for a local endpoint with dots in its name ("local-127.0.0.1:8283") no longer corrupts the bot's
  config; config writes report failure instead of "saved".
- Proxy timeouts match what each client waits for (fleet, local models, threads/fresh, routines); "Fresh start"
  doesn't wait 8 s when Hermes doesn't ask to confirm.
- The routine relay can't post a run twice or lose a thread change (a lock, unique temp files, saved per post); bot
  routine cards carry their last report.
- The Nous sign-in reports "expired"; old sign-in sessions are forgotten.
- Thinking level and the models folder are written through Hermes's own locked writer.

## 2. Light mode, finished

- Every elevation shadow follows the mode (Tailwind wrote the dark ones into the classes).
- The desktop orbit, its stars and bot names; glows, the presence bloom, the chat aurora and celebration sparks mix
  with the current canvas, not the dark one.
- Panels with `bg-black/20` (Tools, Voice), the video play button, the forced-dark date field, `fg-4` text that
  carries information.
- Outside the dashboard: the boot page, the quit screen, the update window, the error page, the phone pairing page
  and the web manifest follow light/dark (and the boot page's heading says what's happening: "Closing Chief").

## 3. Plain words

- One `friendlyError` for the dashboard: network failures, timeouts and server errors become plain sentences
  everywhere a raw `e.message` was shown (chat, settings, Today, Vault, Fleet, local models, notifications).
- One bridge helper for the same: known errors keep their sentence, anything else is "That didn't work. Try again."
  (the type goes to the log), and the bridge's own short codes become sentences ("bad choice", "no session bound").
- Jargon replaced: gateway, bridge, token, Kanban, Flavor, SOUL.md, endpoint, Web Push, profile, runtime, toolsets,
  "Fleet stale", "Vault write lock", "chat-wide rail", "this computer's time" on the phone, step labels and raw exit
  codes on the boot page. Voice's developer leftovers go ("Linked to Hermes chief profile", "Save to Hermes (chief)").
- The assistant's own name everywhere it was hard-coded "Chief" (notifications, phone pages, shortcuts).
- Consistent badges ("In use", "Needs a key", "Recommended"), "Couldn't", "email", full stops, retry times in the
  owner's clock format ("Retry tomorrow at 3:00 PM").
- Settings search finds Appearance, local models, thinking, pairing, encryption, licence/license and more.
- A bot's routine report shows as a routine card (its name and bot in the title, Manage), not its raw header.

## 4. Consistent, accessible controls

- Pressed states on every control (tab bar, Switch, Segmented, Look tabs, menu items); `btn()` instead of hand-rolled
  buttons; danger actions in the danger style (the solid red ones failed contrast).
- One confirm row for destructive actions; those that acted instantly ask first (remove a paired phone, phone access
  off, sign out of Nous).
- 44 px touch targets on the phone for the small buttons the review listed.
- Screen readers: timers outside live regions; dialogs named; the Look drawer's tabs work with arrow keys; the "+"
  menu closes on Escape and focus moves sensibly; the search pills get the accent focus ring.
- Appearance's "Changed by Chief · Undo" only when a bot changed it.

## 5. Leftovers

Dead code, stray section comments, duplicated status-line and refresh-button components, unused routes (`/outbox`,
which also exposed a path), the `hermes_api.py` list's gaps (`cli.save_config_value`, `cron.jobs.parse_schedule`),
watch-loop waste (`head_id` instead of a 240-row transcript every 5 s), one kanban read per roster.

## 6. Ship

`npm run check`; the e2e home and the desktop window for the live parts; PROGRESS; one early release.
