"use client";

import { useEffect, useState } from "react";
import { RefreshCwIcon, HardDriveDownloadIcon } from "@/components/icons";
import { BackupPanel } from "@/components/backup/backup-panel";
import { UpdatesPanel, useUpdates } from "@/components/updates/update-card";
import { UpdateHistoryButton } from "@/components/updates/update-history";
import { Group, PillButton, Row } from "@/components/ui/settings-group";
import { LoadingLine } from "@/components/ui/surface";

/* Settings → Backup & updates. */

export function UpdatesGroup() {
  const { api } = useUpdates();
  if (!api) return null;
  return (
    <Group icon={<RefreshCwIcon className="size-4" />} title="Updates" hint="New versions of the app, including its tested Hermes." action={<UpdateHistoryButton />}>
      <div className="px-3 py-3">
        <UpdatesPanel />
      </div>
      <GoBackRow />
    </Group>
  );
}

/**
 * "Go back to X.Y.Z": the previous version, when its package is still on this PC (the app keeps the installed
 * version's package until the next update). It installs like an update: backup first, then Chief restarts.
 */
function GoBackRow() {
  const { api } = useUpdates();
  const [version, setVersion] = useState("");
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void api?.rollbackOptions?.().then((options) => setVersion(options[0]?.version || ""), () => undefined);
  }, [api]);
  if (!api?.rollback || !version) return null;
  return (
    <Row
      label={`Go back to ${version}`}
      hint={error || (asking ? `This reinstalls ${version}. Your setup is backed up first, and Chief restarts.` : "If this version misbehaves, the previous one is still on this PC.")}
    >
      <div className="mt-2 flex gap-2">
        {asking ? (
          <>
            <PillButton
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError("");
                void api.rollback!(version)
                  .then((state) => state.status === "error" && setError(state.error))
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? "Going back…" : `Go back to ${version}`}
            </PillButton>
            <PillButton disabled={busy} onClick={() => setAsking(false)}>
              Cancel
            </PillButton>
          </>
        ) : (
          <PillButton onClick={() => setAsking(true)}>Go back…</PillButton>
        )}
      </div>
    </Row>
  );
}

/* ------------------------------------------------------------------ Backup & restore */

export function BackupGroup() {
  const [open, setOpen] = useState(false);
  return (
    <Group
      icon={<HardDriveDownloadIcon className="size-4" />}
      title="Backup & restore"
      hint="Your setup and Second Brain, to a folder you choose."
      action={
        <button type="button" onClick={() => setOpen((v) => !v)} className="press min-h-9 rounded-full border border-line-2 px-3 text-callout text-fg-2 hover:text-fg">
          {open ? "Close" : "Open"}
        </button>
      }
    >
      {open ? (
        <div className="px-3 py-3">
          <BackupPanel />
        </div>
      ) : (
        <BackupSummaryRow />
      )}
    </Group>
  );
}

export function BackupSummaryRow() {
  const [line, setLine] = useState("");
  useEffect(() => {
    import("@/lib/backup-client").then(({ backups, agoLabel }) =>
      backups
        .status()
        .then((s) =>
          setLine(!s.ok ? s.error || "Not available on this install." : s.lastBackup ? `Last backup: ${agoLabel(s.lastBackup.at)}${s.remind ? " — time for a new one" : ""}` : s.settings.folder ? "No backups yet." : "Not set up yet."),
        )
        .catch(() => setLine("Not available right now.")),
    );
  }, []);
  return <Row label={line || <LoadingLine className="w-44" label="Checking backups" />} />;
}

/* ------------------------------------------------------------------ Check my system */
