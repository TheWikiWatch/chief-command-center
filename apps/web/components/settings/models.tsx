"use client";

import { useEffect, useState } from "react";
import { ZapIcon, KeyRoundIcon } from "@/components/icons";
import { Group, Row } from "@/components/ui/settings-group";
import { useAssistantName } from "@/lib/identity";
import { ConnectModel } from "@/components/onboarding/connect-model";
import { ModelsKeys } from "@/components/fleet/models-keys";
import { ModelPicker } from "@/components/fleet/model-picker";
import { setup, type SetupStatus } from "@/lib/setup-client";
import { LoadingLine } from "@/components/ui/surface";
import { MODELS_CHANGED_EVENT, modelsChanged } from "@/lib/app-events";
import { friendlyError } from "@/lib/request";

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
      .catch((e: unknown) => setError(friendlyError(e, "Couldn't read the connection.")));
  };
  useEffect(load, []);
  // Any model change elsewhere on the page (Models on this PC, a provider removed) shows here at once.
  useEffect(() => {
    window.addEventListener(MODELS_CHANGED_EVENT, load);
    return () => window.removeEventListener(MODELS_CHANGED_EVENT, load);
  }, []);
  return (
    <Group
      icon={<ZapIcon className="size-4" />}
      title="Connection"
      hint={`The model ${assistant} thinks with. A change applies from the next message.`}
      action={
        <button type="button" onClick={() => setChanging((v) => !v)} className="press min-h-9 rounded-full border border-line-2 px-3 text-callout text-fg-2 hover:text-fg [@media(hover:none)]:min-h-11">
          {changing ? "Close" : status && !status.ready ? "Set up" : "Change"}
        </button>
      }
    >
      {changing ? (
        <div className="px-1 py-2">
          <ConnectModel
            inSettings
            onDone={(s) => {
              setStatus(s);
              setChanging(false);
              modelsChanged();
            }}
          />
        </div>
      ) : status?.ready ? (
        <div className="px-3.5 py-3">
          <ModelPicker profile="chief" provider={status.provider} model={status.model} onChanged={modelsChanged} />
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
    <Group icon={<KeyRoundIcon className="size-4" />} title="Models & keys" hint="Providers your bots can use. Pick a bot's model from its card in Fleet.">
      <ModelsKeys />
    </Group>
  );
}

/* ------------------------------------------------------------------ Updates (desktop app only) */
