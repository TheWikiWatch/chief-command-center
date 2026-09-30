# Desktop shell

The Windows app around the dashboard. It is the only supervisor of the chief's Hermes gateway and the dashboard server, and the window is a loopback client of that server, just like a browser tab (PLAN §4).

## What it does

**Starting up**
- Single instance. A second launch shows the window; `--quit` asks the running app to quit cleanly, and `--hidden` starts in the tray.
- The boot screen shows each step: runtime, preparing Chief, Chief, dashboard. A failed step shows the reason, **Try again** and **Open logs**.

**Preparing Hermes** (`python/provision.py`, run with the payload's Python through Hermes's own config code)
- Copies the bundled bridge plugin into the profile when it has changed.
- Enables it in `config.yaml` and sets the bridge port in the profile `.env`.
- Before that, an interrupted restore is rolled back (`chief_backup recover`).

**Running the gateway**
- Launches `hermes -p chief gateway run` in the foreground with an explicit `HERMES_HOME`, this install's own gateway lock folder, the bridge port and token, and `HERMES_BIN`.
- Supervised with restarts after 1 s, 5 s and 30 s. After 5 restarts in 10 minutes it stops trying and shows the error with Retry.
- A gateway started by another launcher gets a choice: **Take over** or **Use it as is**. An orphan from a crashed run of this app is ended.

**Running the dashboard server**
- The Next.js standalone server runs under Electron's Node (`utilityProcess`), on 127.0.0.1, with the same restart rules.

**Environment**
- Children get a short allow-list of Windows variables and a PATH made of the payload's tools plus the system folders. No ambient API keys, tokens or `HERMES_*` from the user's session.

**Ports**
- The defaults are 3000 and 7790; if something else holds one, the next free port. The choice is saved, and a port held by something else is never taken over.

**Secrets**
- The bridge token is sealed with `safeStorage` (DPAPI) in `app\secrets\`. It reaches the gateway and the server through their environment, never the page.

**The window and tray**
- Closing the window hides it to the tray; the first time, a notification says Chief keeps running.
- The tray menu has Open, Restart Chief, Open logs and Quit.
- A crashed page reloads.

**Quitting**
- Quit checks for work in progress: a reply being written, a pending approval, a specialist working. It then offers Wait for Chief, Quit now or Cancel.
- The gateway is stopped through `hermes gateway stop` (25 s), and only then is the process tree ended.

**Notifications**
- While the window is hidden or unfocused, a new reply or approval request becomes a Windows notification. Electron has no Web Push; the phone still uses it.

**Page bridge** (`window.chiefDesktop`)
- Folder and file pickers.
- `applyRestore`: stop Chief, run `chief_backup apply`, start Chief, check health, then finish, or roll back if Chief doesn't come back.

## Running it unpackaged

The desktop app needs a built Hermes payload and the dashboard's standalone build:

```bash
npm --prefix apps/web run build:standalone
```

```bash
npm --prefix apps/desktop install
```

Point `CHIEF_PAYLOAD_DIR` at a payload built by `packaging/payload/stage.py`. Set `CHIEF_DESKTOP_DATA` to a throwaway folder unless you want the real `%LOCALAPPDATA%\ChiefCommandCenter`. Then run:

```bash
npm --prefix apps/desktop start
```

## Tests

```bash
npm --prefix apps/desktop run check
```

The tests cover the supervisor state machine, the environment allow-list, ports, the quit decision, notifications, the restore sequence (including its rollback), gateway ownership, secrets and settings.
