"use client";

import { useEffect, useState } from "react";
import { ZapIcon, KeyRoundIcon } from "@/components/icons";
import { Group, Row } from "@/components/ui/settings-group";
import { useAssistantName } from "@/lib/identity";
import { ConnectModel } from "@/components/onboarding/connect-model";
import { ModelsKeys } from "@/components/fleet/models-keys";
import { setup, type SetupStatus } from "@/lib/setup-client";
import { LoadingLine } from "@/components/ui/surface";

/* Settings → Models & keys. */

export function ConnectionGroup() {
  const assistant = useAssistantName();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [error, setError] = useState("");
  const [changing, setChanging] = useState(false);
  const load = () => {
    setError("");
    setup
      .status()
      .then(setStatus)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Couldn't read the connection."));
  };
  useEffect(load, []);
  return (
    <Group
      icon={<ZapIcon className="size-4" />}
      title="Connection"
      hint={`The model ${assistant} thinks with. Changes apply to new conversations.`}
      action={
        <button type="button" onClick={() => setChanging((v) => !v)} className="press min-h-9 rounded-full border border-line-2 px-3 text-callout text-fg-2 hover:text-fg">
          {changing ? "Close" : "Change"}
        </button>
      }
    >
      {changing ? (
        <div className="px-1 py-2">
          <ConnectModel
            onDone={(s) => {
              setStatus(s);
            }}
          />
        </div>
      ) : (
        <Row label={status?.model || (status ? "No model chosen" : <LoadingLine className="w-36" />)} hint={error || (status ? (status.ready ? `via ${status.provider}` : status.error || "Not connected") : "")}>
          {status ? (
            <span className={`rounded-full px-2 py-0.5 text-caption ${status.ready ? "bg-ok/15 text-ok" : "bg-warn/15 text-warn"}`}>{status.ready ? "Ready" : "Needs setup"}</span>
          ) : null}
        </Row>
      )}
    </Group>
  );
}

/** Every provider this install can use; their models fill each bot's model list. */
export function ModelsKeysGroup() {
  return (
    <Group icon={<KeyRoundIcon className="size-4" />} title="Models & keys" hint="Providers your bots can use. Pick each bot's model from its Look drawer, under Job.">
      <ModelsKeys />
    </Group>
  );
}

/* ------------------------------------------------------------------ Updates (desktop app only) */
