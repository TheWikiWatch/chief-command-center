"use client";

import { useCallback, useEffect, useState } from "react";

import { CheckIcon, CircleAlertIcon, HardDriveIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { field } from "@/components/ui/field";
import { Group } from "@/components/ui/settings-group";
import { desktop } from "@/lib/desktop";
import { useAssistantName } from "@/lib/identity";
import { localModels, progressLine, type LocalJob, type LocalModel, type LocalStatus } from "@/lib/local-models";

/*
 * Settings → Models & keys → Models on this PC: Hermes's managed llama.cpp runtime (local_ai.py). One click sets up
 * this machine's build of the recommended model (the engine, the download, the server, and Chief on it); each model
 * says whether it fits and how big it is. The folder is the owner's choice, made before the first download.
 */

const POLL_MS = 2000;
const gb = (n: number | null | undefined) => (n ? `${Math.round(n / 1024 ** 3)} GB` : "");

export function LocalModelsGroup() {
  const chief = useAssistantName();
  const [state, setState] = useState<LocalStatus | null>(null);
  const [models, setModels] = useState<LocalModel[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async (withCatalog = false) => {
    try {
      const next = await localModels.status();
      setState(next);
      if (withCatalog) setModels((await localModels.catalog()).models);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't read local models");
    }
  }, []);

  useEffect(() => {
    let live = true;
    Promise.all([localModels.status(), localModels.catalog()])
      .then(([next, list]) => {
        if (!live) return;
        setState(next);
        setModels(list.models);
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : "Couldn't read local models"));
    return () => {
      live = false;
    };
  }, []);

  const running = state?.jobs.find((j) => j.status === "running" || j.status === "paused");
  // While something runs, follow it; when it ends, read the catalog again (downloaded, active).
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => void load(false), POLL_MS);
    return () => {
      clearInterval(timer);
      void load(true);
    };
  }, [running?.job_id, load]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError("");
    try {
      await fn();
      await load(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      setBusy("");
    }
  }

  if (!state) {
    return (
      <Group icon={<HardDriveIcon className="size-4" />} title="Models on this PC">
        <p className="px-3.5 py-3 text-callout text-fg-3" role="status">
          {error || "Reading this PC…"}
        </p>
      </Group>
    );
  }

  const needsFolder = state.folder.supported && !state.folder.chosen;
  // Hermes's recommendation, or (it makes none when every model is bigger than the graphics card) the smallest that runs.
  const recommended = models?.find((m) => m.recommended && m.fits);
  const pick = recommended || [...(models || [])].filter((m) => m.fits && !m.needs_engine).sort((a, b) => (a.size_bytes || 0) - (b.size_bytes || 0))[0];
  const anyDownloaded = state.models.length > 0;
  const lastError = state.jobs.find((j) => j.status === "error" && j.error);

  return (
    <Group
      icon={<HardDriveIcon className="size-4" />}
      title="Models on this PC"
      hint={`${chief} can think with a model running on this PC’s graphics card: free, private, no account. It needs a strong card and 16 GB or more of space.`}
    >
      <div className="space-y-3 px-3.5 py-3">
        <p className="text-callout text-fg-2">
          {state.machine.gpu ? `${state.machine.gpu}${state.machine.vram ? ` · ${state.machine.vram}` : ""}` : "No graphics card found: models would run on the processor, slowly."}
          {state.engine.installed ? ` · engine ${state.engine.version || ""} (${state.engine.backend})` : ""}
          {state.engine.installed ? (state.server.running ? " · running" : " · stopped") : ""}
        </p>

        {needsFolder ? (
          <FolderChoice state={state} busy={!!busy} onChoose={(path) => void act("folder", () => localModels.setFolder(path))} />
        ) : (
          <p className="text-caption text-fg-3">
            Models go in {state.folder.path}
            {state.folder.freeBytes ? ` · ${gb(state.folder.freeBytes)} free` : ""}
          </p>
        )}

        {running ? <JobLine job={running} busy={busy} onPause={() => void act("pause", () => localModels.pause(running.job_id))} onResume={() => void act("resume", () => localModels.resume(running.job_id))} /> : null}
        {!running && lastError ? (
          <p role="alert" className="flex items-start gap-1.5 text-callout text-danger">
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
            <span>
              {lastError.target}: {lastError.error}
            </span>
          </p>
        ) : null}

        {!anyDownloaded && !running && pick ? (
          <div className="flex flex-wrap items-center gap-2 rounded-ctl bg-fill-1 px-3 py-2.5">
            <p className="min-w-0 flex-1 text-callout text-fg-2">
              Set up {pick.display_name} ({pick.size_label}) for {chief}: the engine, the download, and {chief} on it.
              {pick.spilled ? " It’s bigger than this graphics card’s memory, so it answers slower than a cloud model." : ""}
            </p>
            <Button variant="primary" size="sm" disabled={needsFolder || !!busy} onClick={() => void act("quickstart", () => localModels.quickstart(recommended ? "" : pick.id))}>
              {busy === "quickstart" ? "Starting…" : "Set it up"}
            </Button>
          </div>
        ) : null}
      </div>

      {(models || []).map((m) => (
        <ModelRow
          key={m.id}
          model={m}
          active={!!m.downloaded_model_id && m.downloaded_model_id === state.active}
          disabled={!!busy || !!running || needsFolder}
          busy={busy}
          chief={chief}
          onDownload={() => void act(`dl:${m.id}`, () => localModels.download(m.id))}
          onUse={() => void act(`use:${m.id}`, () => localModels.activate(m.downloaded_model_id || m.id))}
          onRemove={() => void act(`rm:${m.id}`, () => localModels.remove(m.downloaded_model_id || m.id))}
        />
      ))}

      {state.engine.installed ? (
        <div className="flex items-center gap-3 px-3.5 py-3">
          <p className="min-w-0 flex-1 text-caption text-fg-3">
            {state.server.running ? "The local server holds graphics memory while a model is loaded." : "The local server is off: nothing local runs until it starts."}
          </p>
          <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void act("server", () => localModels.server(state.server.running ? "stop" : "start"))}>
            {busy === "server" ? "…" : state.server.running ? "Stop server" : "Start server"}
          </Button>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="px-3.5 pb-3 text-callout text-danger">
          {error}
        </p>
      ) : null}
    </Group>
  );
}

function FolderChoice({ state, busy, onChoose }: { state: LocalStatus; busy: boolean; onChoose: (path: string) => void }) {
  const [path, setPath] = useState(state.folder.suggested);
  const pick = desktop()?.pickFolder;
  return (
    <div className="space-y-2 rounded-ctl border border-line bg-well px-3 py-3">
      <p className="text-callout text-fg">Where should models go?</p>
      <p className="text-caption text-fg-3">Each model is 16 GB or more. A drive with plenty of space is best; you can’t move them later without removing them.</p>
      <div className="flex flex-wrap gap-2">
        <input value={path} onChange={(e) => setPath(e.target.value)} aria-label="Folder for models" spellCheck={false} className={field({ mono: true, extra: "min-w-0 flex-1" })} />
        {pick ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() =>
              void pick({ title: "Folder for local models", defaultPath: path }).then((chosen) => {
                if (chosen) setPath(chosen);
              })
            }
          >
            Browse…
          </Button>
        ) : null}
        <Button variant="primary" size="sm" disabled={busy || !path.trim()} onClick={() => onChoose(path.trim())}>
          Use this folder
        </Button>
      </div>
    </div>
  );
}

function JobLine({ job, busy, onPause, onResume }: { job: LocalJob; busy: string; onPause: () => void; onResume: () => void }) {
  const line = progressLine(job);
  return (
    <div className="space-y-1.5 rounded-ctl bg-fill-1 px-3 py-2.5" role="status" aria-live="polite">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-callout text-fg">
          {job.status === "paused" ? "Paused" : job.detail || "Working…"} <span className="text-fg-3">· {job.target}</span>
        </p>
        {job.can_pause ? (
          <Button variant="ghost" size="sm" disabled={!!busy} onClick={onPause}>
            Pause
          </Button>
        ) : null}
        {job.can_resume ? (
          <Button variant="secondary" size="sm" disabled={!!busy} onClick={onResume}>
            Resume
          </Button>
        ) : null}
      </div>
      {typeof job.percent === "number" ? (
        <div className="h-1.5 overflow-hidden rounded-full bg-fill-3" aria-hidden>
          <div className="h-full rounded-full bg-accent transition-[width] duration-base" style={{ width: `${job.percent}%` }} />
        </div>
      ) : null}
      {line ? <p className="text-caption tabular-nums text-fg-3">{line}</p> : null}
    </div>
  );
}

function ModelRow({
  model,
  active,
  disabled,
  busy,
  chief,
  onDownload,
  onUse,
  onRemove,
}: {
  model: LocalModel;
  active: boolean;
  disabled: boolean;
  busy: string;
  chief: string;
  onDownload: () => void;
  onUse: () => void;
  onRemove: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="border-t border-line px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-1.5 text-body text-fg">
            {model.display_name}
            {model.recommended ? <span className="rounded-chip bg-accent/15 px-1.5 py-px text-micro text-accent-text">recommended</span> : null}
            {model.vision ? <span className="rounded-chip bg-fill-2 px-1.5 py-px text-micro text-fg-3">sees images</span> : null}
            {active ? (
              <span className="inline-flex items-center gap-1 rounded-chip bg-ok/15 px-1.5 py-px text-micro text-ok">
                <CheckIcon className="size-3" strokeWidth={3} /> {chief} uses it
              </span>
            ) : null}
          </p>
          <p className="mt-0.5 text-caption text-fg-3">
            {[model.size_label, model.fits ? model.fit_summary : model.fit_detail || model.fit_summary].filter(Boolean).join(" · ")}
          </p>
          {model.description ? <p className="mt-0.5 text-caption text-fg-3">{model.description}</p> : null}
        </div>
        {model.downloaded ? (
          <>
            {active ? null : (
              <Button variant="secondary" size="sm" disabled={disabled} onClick={onUse}>
                {busy === `use:${model.id}` ? "Switching…" : `Use for ${chief}`}
              </Button>
            )}
            <Button variant="ghost" size="sm" disabled={disabled || active} onClick={() => setConfirm((v) => !v)}>
              Remove
            </Button>
          </>
        ) : model.fits && !model.needs_engine ? (
          <Button variant="secondary" size="sm" disabled={disabled} onClick={onDownload}>
            {busy === `dl:${model.id}` ? "Starting…" : "Download"}
          </Button>
        ) : (
          <span className="text-caption text-fg-3">{model.needs_engine ? "Needs a newer engine" : "Too big for this PC"}</span>
        )}
      </div>
      {confirm ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-ctl bg-fill-1 px-3 py-2">
          <p className="min-w-0 flex-1 text-callout text-fg-2">
            Remove {model.display_name}? It frees {model.size_label}; downloading it again takes a while.
          </p>
          <Button variant="danger" size="sm" disabled={disabled} onClick={() => (setConfirm(false), onRemove())}>
            Remove
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirm(false)}>
            Keep
          </Button>
        </div>
      ) : null}
    </div>
  );
}
