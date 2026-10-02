"use client";

import { useEffect, useState } from "react";
import { RefreshCwIcon, HardDriveDownloadIcon } from "@/components/icons";
import { BackupPanel } from "@/components/backup/backup-panel";
import { UpdatesPanel, useUpdates } from "@/components/updates/update-card";
import { UpdateHistoryButton } from "@/components/updates/update-history";
import { Group, Row } from "@/components/ui/settings-group";

/* Settings → Backup & updates. */

export function UpdatesGroup() {
  const { api } = useUpdates();
  if (!api) return null;
  return (
    <Group icon={<RefreshCwIcon className="size-4" />} title="Updates" hint="New versions of the app, including its tested Hermes." action={<UpdateHistoryButton />}>
      <div className="px-3 py-3">
        <UpdatesPanel />
      </div>
    </Group>
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
  const [line, setLine] = useState("…");
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
  return <Row label={line} />;
}

/* ------------------------------------------------------------------ Check my system */
