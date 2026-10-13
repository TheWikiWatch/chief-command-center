import { compareVersions } from "./updater";

/*
 * What the shell asks the owner, in its own dialog, before an action the dashboard could otherwise start on its own.
 * The IPC guard only checks which page is asking; a script running in that page (a bad reply that slipped past the
 * renderer's guards, say) could otherwise downgrade the app, change where updates come from, open Chief to a whole
 * Tailscale network or restore someone else's backup. The page doesn't ask first for these: this dialog is the ask.
 * Kept pure (no Electron) so the wording and the decisions are tested.
 */

/** A native confirmation: the dialog's headline, its explanation and the label of the button that goes ahead. */
export type Confirm = { message: string; detail: string; ok: string };

export function confirmInstall(version: string, current: string): Confirm {
  const older = compareVersions(version, current) < 0;
  return older
    ? {
        message: `Go back to Chief ${version}?`,
        detail: `You have ${current}. ${version} is older; your setup is backed up first when its Hermes is different. It gets ready in the background, then you restart into it.`,
        ok: `Go back to ${version}`,
      }
    : {
        message: `Install Chief ${version}?`,
        detail: `You have ${current}. It gets ready in the background, then you restart into it.`,
        ok: `Install ${version}`,
      };
}

export function confirmRollback(version: string, current: string): Confirm {
  return {
    message: `Go back to Chief ${version}?`,
    detail: `You have ${current}. This reinstalls ${version}: your setup is backed up first, and Chief restarts.`,
    ok: `Go back to ${version}`,
  };
}

/** A restart that interrupts work; null when nothing is in progress (then a restart needs no asking). */
export function confirmForcedRestart(busyReasons: string[]): Confirm | null {
  if (!busyReasons.length) return null;
  return {
    message: "Restart now?",
    detail: `Chief is in the middle of something:\n${busyReasons.join("\n")}\n\nRestarting now stops it.`,
    ok: "Restart now",
  };
}

/** A new update source; null when it doesn't change. */
export function confirmFeed(next: string, current: string): Confirm | null {
  if (next.trim() === current.trim()) return null;
  return {
    message: "Get updates from somewhere else?",
    detail: `From now on this app looks for updates at:\n${next || "the source it shipped with"}\n\nUpdates are still checked against Chief's signing key before anything installs.`,
    ok: "Use this source",
  };
}

export function confirmPhoneEnable(): Confirm {
  return {
    message: "Let your phone reach Chief?",
    detail: "Chief becomes reachable over your Tailscale network, for your Tailscale account only. Each phone still has to pair once with a code from this PC.",
    ok: "Turn on phone access",
  };
}

/** Widening who may open Chief; null for narrowing it back to the owner. */
export function confirmPhoneAccess(mode: "owner" | "tailnet"): Confirm | null {
  if (mode === "owner") return null;
  return {
    message: "Let everyone on your Tailscale network open Chief?",
    detail: "Anyone signed in to your tailnet could open Chief from a paired device and act as you: read your chats, approve actions, change settings. Keep it to your own account unless you trust everyone on the tailnet.",
    ok: "Allow the whole tailnet",
  };
}

export function confirmRestore(busyReasons: string[]): Confirm {
  return {
    message: "Restore this backup?",
    detail: `${busyReasons.length ? `Chief is in the middle of something:\n${busyReasons.join("\n")}\n\n` : ""}Restoring replaces Chief's current data with the backup's and restarts Chief. A safety backup of the current state is kept first.`,
    ok: "Restore",
  };
}

/** "Skip this version" only skips the version on offer, so a page can't pre-skip future security releases. */
export function skipAllowed(version: string, offered: string | null | undefined): boolean {
  return /^\d+\.\d+\.\d+$/.test(version) && version === offered;
}
