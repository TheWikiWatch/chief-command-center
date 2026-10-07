# Sending our Hermes patches upstream

Every patch in `hermes/patches/` is a place a Hermes release can break the app (docs/PLAN-2026-10-07 §3.7). Three of
the four fix plain Windows bugs that any Hermes user on Windows can hit, so they belong upstream, in
[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent). Once a fix is merged and released, its patch
is deleted here (drop the entry from `hermes/pin.json` and the file; the drift check shows when upstream has it).

These are drafts. Opening a PR posts publicly under the maintainer's GitHub account, so the maintainer sends them.
Each needs a fork, a branch on upstream `main`, the patch applied there (`git apply hermes/patches/<file>`, or its
`next` form when upstream has moved), upstream's own tests run (`scripts/run_tests.sh` or `pytest` on the touched
test files), and the text below as the PR description.

## 0002: Bot Chat DMs on Windows can be blocked by a leftover temp folder

**Title:** fix(bot-mode): keep Windows DM payloads under HERMES_HOME instead of a shared %TEMP%\hermes-dm

On Windows, `tools/bot_mode_dm.py` writes DM payload files to `%TEMP%\hermes-dm`. Unlike POSIX (`hermes-dm-<uid>`),
the Windows folder is shared and first-creator-wins: when another process or sandbox has created it with an ACL the
current user can't write to, every Bot Chat DM fails. `chmod(0o700)` is not a privacy control on Windows either.

The fix keeps POSIX unchanged and, on Windows, writes under the calling profile's `HERMES_HOME\tmp\hermes-dm` (then
`%LOCALAPPDATA%\hermes\tmp\hermes-dm`), skips the POSIX-only chmod, and sweeps the old shared folder of its own files.
Test: `test_windows_dm_dir_lives_under_hermes_home_not_shared_temp` (a poisoned shared folder no longer blocks a DM).

Patch: `hermes/patches/0002-bot-mode-dm-windows-temp-dir.patch` (applies to upstream main as of 2026-10-07).

## 0001: a gateway started by the Windows logon launcher dies with the launcher's job

**Title:** fix(gateway-windows): the VBS launcher runs `gateway start` and waits, so the gateway breaks away

The logon/scheduled-task VBS launcher runs `gateway run` detached (`sh.Run …, 0, False`). When the launcher itself runs
inside a job object (Task Scheduler, some remote-management tools), the gateway is part of that job and is killed when
the job ends. `gateway start` already spawns a breakaway, detached gateway; the launcher should use it and wait for it
(`Wait=True`) so the breakaway child is created before wscript exits.

Patch: `hermes/patches/0001-gateway-windows-start-breakaway.patch`. Worth a test that the generated VBS calls
`gateway start` with Wait=True (upstream has VBS-generation tests in `tests/hermes_cli/` to extend).

## 0004: a bare `python` in the agent's terminal isn't the bundled interpreter in a sealed payload

**Title:** fix(pm): put the payload's own interpreter on PATH on Windows, now that the venv's Scripts is left off

Upstream `3383a1d8b3` (2026-10-07) stopped putting a shipped venv's `Scripts` folder on PATH on Windows, because its
redirectors read `pyvenv.cfg` `home`, which names the build machine. That fixed `hermes` itself, but a child that runs
a bare `python` now gets whatever else is on PATH (often nothing, or an unrelated Python without the bundled packages).
Adding the running interpreter's own folder after the payload launchers gives children the bundled Python, which runs
with the PYTHONPATH `activate_dependencies` sets.

Patch: `hermes/patches/0004-payload-venv-launchers-on-another-pc.next.patch` (the form for upstream main).

## 0003 stays ours (for now)

`HERMES_BIN` and the faulthandler log serve this app's process layout (the store Python can't import Hermes once a child
drops its path). Upstream's `_resolve_hermes_bin_dir` work (also `3383a1d8b3`) may make the `HERMES_BIN` half
unnecessary; re-check after the next stable release, and offer the faulthandler half separately if upstream wants it.
