"use client";

import { useEffect, useState } from "react";
import { Sheet } from "@/components/ui/sheet";
import { ops } from "@/lib/ops";
import { useAssistantName } from "@/lib/identity";
import { LAYER } from "@/lib/layers";
import { field } from "@/components/ui/field";
import { btn } from "@/components/ui/button";

/* Today → the folder its boards are read from (an Ops service install). */

export function SettingsSheet({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const assistant = useAssistantName();
  return (
    <Sheet open={open} onClose={onClose} title="Vault" subtitle={`Boards are read from this folder. ${assistant} writes the vault.`} scope="container" zIndex={LAYER.paneSheet}>
      <VaultBody onSaved={onSaved} />
    </Sheet>
  );
}

export function VaultBody({ onSaved }: { onSaved: () => void }) {
  const [vaultPath, setVaultPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    ops
      .settings()
      .then((s) => setVaultPath(s.vault_path))
      .catch((e: Error) => setErr(e.message));
  }, []);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await ops.saveSettings({ vault_path: vaultPath.trim() });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save settings.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="px-4 pb-6">
      <label className="block text-callout text-fg-2">
        Vault path
        <input
          value={vaultPath}
          onChange={(e) => setVaultPath(e.target.value)}
          placeholder="D:\Notes\Second Brain"
          className={field({ mono: true, extra: "mt-1.5 w-full py-2" })}
        />
      </label>
      <button
        type="button"
        disabled={busy || !vaultPath.trim()}
        className={btn("primary", "md", "mt-4 w-full")}
        onClick={() => void save()}
      >
        {busy ? "Saving…" : "Save settings"}
      </button>
      {err ? (
        <p role="alert" className="mt-3 text-callout text-danger">
          {err}
        </p>
      ) : null}
    </div>
  );
}
