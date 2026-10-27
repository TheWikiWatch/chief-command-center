"use client";

import { useCallback, useEffect, useState } from "react";

import { CheckIcon, CircleAlertIcon, HardDriveIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ConfirmRow } from "@/components/ui/confirm-row";
import { field } from "@/components/ui/field";
import { Group } from "@/components/ui/settings-group";
import { modelsChanged } from "@/lib/app-events";
import { desktop } from "@/lib/desktop";
import { useAssistantName } from "@/lib/identity";
import { jobFailure, localModels, progressLine, type LocalJob, type LocalModel, type LocalStatus } from "@/lib/local-models";
import { friendlyError } from "@/lib/request";

/*
 * Settings → Models & keys → Models on this PC: Hermes's managed llama.cpp runtime (local_ai.py). One click sets up
 * this machine's build of the recommended model (the engine, the download, the server, and Chief on it); each model
 * says whether it fits and how big it is. The folder is the owner's choice, made before the first download.
 */

const POLL_MS = 2000;
const gb = (n: number | null | undefined) => (n ? `${Math.round(n / 1024 ** 3)} GB` : "");

/** A failed action, kept beside the control that started it ("dl:<id>", "server", "folder", …). */
type Failure = { label: string; text: string };

export function LocalModelsGroup() {
  const chief = useAssistantName();
  const [state, setState] = useState<LocalStatus | null>(null);
  const [models, setModels] = useState<LocalModel[] | null>(null);
  const [error, setError] = useState("");
  const [failed, setFailed] = useState<Failure | null>(null);
  const [busy, setBusy] = useState("");

  const load = useCallback(async (withCatalog = false) => {
    try {
      const next = await localModels.status();
      setState(next);
      setError("");
      if (withCatalog) setModels((await localModels.catalog()).models);
    } catch (e) {
      setError(friendlyError(e, "Couldn't read the models on this PC."));
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
      .catch((e: unknown) => live && setError(friendlyError(e, "Couldn't read the models on this PC.")));
    return () => {
      live = false;
    };
  }, []);

  const running = state?.jobs.find((j) => j.status === "running" || j.status === "paused");
  // While something runs, follow just that job (the full status probes the graphics card each time); when it ends,
  // read everything again (downloaded, active) and tell the rest of the page the model may have changed.
  useEffect(() => {
    if (!running) return undefined;
    const id = running.job_id;
    let live = true;
    const timer = setInterval(() => {
      localModels
        .job(id)
        .then((res) => {
          if (!live) return;
          if (!res.job) return void load(false);
          const job = res.job;
          setState((s) => (s ? { ...s, jobs: s.jobs.map((j) => (j.job_id === id ? job : j)) } : s));
        })
        .catch(() => live && void load(false));
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
      void load(true).then(modelsChanged);
    };
  }, [running?.job_id, load]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(label: string, fn: () => Promise<unknown>, fallback: string, after?: () => void) {
    setBusy(label);
    setFailed(null);
    try {
      await fn();
      await load(true);
      after?.();
    } catch (e) {
      setFailed({ label, text: friendlyError(e, fallback) });
    } finally {
      setBusy("");
    }
  }
  const failure = (label: string) => (failed?.label === label ? failed.text : "");

  if (!state) {
    return (
      <Group icon={<HardDriveIcon className="size-4" />} title="Models on this PC">
        <p className="px-3.5 py-3 text-callout text-fg-3" role={error ? "alert" : "status"}>
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
  const engineName = [state.engine.version, state.engine.backend].filter(Boolean).join(", ");

  return (
    <Group
      icon={<HardDriveIcon className="size-4" />}
      title="Models on this PC"
      hint={`${chief} can think with a model running on this PC’s graphics card: free, private, no account. It needs a strong card and 16 GB or more of space.`}
    >
      <div className="space-y-3 px-3.5 py-3">
        <p className="text-callout text-fg-2">
          {state.machine.gpu ? `${state.machine.gpu}${state.machine.vram ? ` · ${state.machine.vram}` : ""}` : "No graphics card found: models would run on the processor, slowly."}
          {state.engine.installed ? (
            <span title={engineName ? `llama.cpp ${engineName}` : undefined}>{state.server.running ? " · Local engine on" : " · Local engine off"}</span>
          ) : null}
        </p>

        {needsFolder ? (
          <FolderChoice state={state} busy={!!busy} error={failure("folder")} onChoose={(path) => void act("folder", () => localModels.setFolder(path), "That folder can't be used. Pick another.")} />
        ) : (
          <p className="text-caption text-fg-3">
            Models go in {state.folder.path}
            {state.folder.freeBytes ? ` · ${gb(state.folder.freeBytes)} free` : ""}
          </p>
        )}

        {running ? (
          <JobLine
            job={running}
            busy={busy}
            error={failure("pause") || failure("resume")}
            onPause={() => void act("pause", () => localModels.pause(running.job_id), "Couldn't pause it. Try again.")}
            onResume={() => void act("resume", () => localModels.resume(running.job_id), "Couldn't carry on. Try again.")}
          />
        ) : null}
        {!running && lastError ? <Problem text={jobFailure(lastError)} /> : null}

        {!anyDownloaded && !running && pick ? (
          <div className="space-y-2 rounded-ctl bg-fill-1 px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 text-callout text-fg-2">
                Set up {pick.display_name} ({pick.size_label}) for {chief}: the engine, the download, and {chief} on it.
                {pick.spilled ? " It’s bigger than this graphics card’s memory, so it answers slower than a cloud model." : ""}
              </p>
              <Button variant="primary" size="sm" disabled={needsFolder || !!busy} onClick={() => void act("quickstart", () => localModels.quickstart(recommended ? "" : pick.id), "The setup didn't start. Try again.")}>
                {busy === "quickstart" ? "Starting…" : "Set it up"}
              </Button>
            </div>
            {failure("quickstart") ? <Problem text={failure("quickstart")} /> : null}
          </div>
        ) : null}
        {error ? <Problem text={error} /> : null}
      </div>

      {(models || []).map((m) => (
        <ModelRow
          key={m.id}
          model={m}
          active={!!m.downloaded_model_id && m.downloaded_model_id === state.active}
          disabled={!!busy || !!running || needsFolder}
          busy={busy}
          chief={chief}
          error={failure(`dl:${m.id}`) || failure(`use:${m.id}`) || failure(`rm:${m.id}`)}
          onDownload={() => void act(`dl:${m.id}`, () => localModels.download(m.id), "The download didn't start. Try again.")}
          onUse={() => void act(`use:${m.id}`, () => localModels.activate(m.downloaded_model_id || m.id), `Couldn't switch ${chief} to it. Try again.`, modelsChanged)}
          onRemove={() => void act(`rm:${m.id}`, () => localModels.remove(m.downloaded_model_id || m.id), "It wasn't removed. Try again.")}
        />
      ))}

      {state.engine.installed ? (
        <div className="space-y-2 px-3.5 py-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="min-w-0 flex-1 basis-48 text-caption text-fg-3">
              {state.server.running ? "The local engine holds graphics memory while a model is loaded." : "The local engine is off: nothing runs on this PC until it starts."}
              {state.engine.updateAvailable ? " A newer engine is ready to install." : ""}
            </p>
            {state.engine.updateAvailable ? (
              <Button variant="secondary" size="sm" disabled={!!busy || !!running} onClick={() => void act("engine", () => localModels.installEngine(), "The engine wasn't updated. Try again.")}>
                {busy === "engine" ? "Updating…" : "Update engine"}
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void act("server", () => localModels.server(state.server.running ? "stop" : "start"), state.server.running ? "The engine didn't stop. Try again." : "The engine didn't start. Try again.")}>
              {busy === "server" ? (state.server.running ? "Stopping…" : "Starting…") : state.server.running ? "Stop engine" : "Start engine"}
            </Button>
          </div>
          {failure("server") || failure("engine") ? <Problem text={failure("server") || failure("engine")} /> : null}
        </div>
      ) : null}
    </Group>
  );
}

function Problem({ text }: { text: string }) {
  return (
    <p role="alert" className="flex items-start gap-1.5 text-callout text-danger">
      <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
      <span>{text}</span>
    </p>
  );
}

function FolderChoice({ state, busy, error, onChoose }: { state: LocalStatus; busy: boolean; error: string; onChoose: (path: string) => void }) {
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
      {error ? <Problem text={error} /> : null}
    </div>
  );
}

function JobLine({ job, busy, error, onPause, onResume }: { job: LocalJob; busy: string; error: string; onPause: () => void; onResume: () => void }) {
  const line = progressLine(job);
  return (
    <div className="space-y-1.5 rounded-ctl bg-fill-1 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-callout text-fg" role="status">
          {job.status === "paused" ? "Paused" : job.detail || "Working…"} <span className="text-fg-3">· {job.target}</span>
        </p>
        {job.can_pause ? (
          <Button variant="ghost" size="sm" disabled={!!busy} onClick={onPause}>
            {busy === "pause" ? "Pausing…" : "Pause"}
          </Button>
        ) : null}
        {job.can_resume ? (
          <Button variant="secondary" size="sm" disabled={!!busy} onClick={onResume}>
            {busy === "resume" ? "Resuming…" : "Resume"}
          </Button>
        ) : null}
      </div>
      {typeof job.percent === "number" ? (
        <div className="h-1.5 overflow-hidden rounded-full bg-fill-3" role="progressbar" aria-label={job.target} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(job.percent)}>
          <div className="h-full rounded-full bg-accent transition-[width] duration-base" style={{ width: `${job.percent}%` }} />
        </div>
      ) : null}
      {line ? <p className="text-caption tabular-nums text-fg-3">{line}</p> : null}
      {error ? <Problem text={error} /> : null}
    </div>
  );
}

function ModelRow({
  model,
  active,
  disabled,
  busy,
  chief,
  error,
  onDownload,
  onUse,
  onRemove,
}: {
  model: LocalModel;
  active: boolean;
  disabled: boolean;
  busy: string;
  chief: string;
  error: string;
  onDownload: () => void;
  onUse: () => void;
  onRemove: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  return (
    <div data-model={model.id} className="px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-1.5 text-body text-fg">
            {model.display_name}
            {model.recommended ? <span className="rounded-chip bg-accent/15 px-1.5 py-px text-micro text-accent-text">Recommended</span> : null}
            {model.vision ? <span className="rounded-chip bg-fill-2 px-1.5 py-px text-micro text-fg-3">Sees images</span> : null}
            {active ? (
              <span className="inline-flex items-center gap-1 rounded-chip bg-ok/15 px-1.5 py-px text-micro text-ok">
                <CheckIcon className="size-3" strokeWidth={3} /> In use by {chief}
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
            <Button variant="ghost" size="sm" disabled={disabled || active} title={active ? `Switch ${chief} to another model first` : undefined} onClick={() => setConfirm((v) => !v)}>
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
        <ConfirmRow className="mt-2" confirm="Remove" busy={busy === `rm:${model.id}`} busyLabel="Removing…" onConfirm={() => (setConfirm(false), onRemove())} onCancel={() => setConfirm(false)}>
          Remove {model.display_name}? It frees {model.size_label}; downloading it again takes a while.
        </ConfirmRow>
      ) : null}
      {error ? (
        <div className="mt-2">
          <Problem text={error} />
        </div>
      ) : null}
    </div>
  );
}
