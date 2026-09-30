import { spawn } from "node:child_process";

/**
 * Applying a staged restore (PLAN §16 steps 4–7), which only the shell can do because Chief must be stopped:
 * stop the gateway, `chief_backup apply` (safety backup + journaled swap + remap), start the gateway, wait
 * for health, then `finish` through the dashboard (which also merges the restored app settings). If Chief
 * doesn't come back healthy, `rollback` puts the previous data back and Chief is started again.
 */
export type EngineRunner = (args: string[]) => Promise<{ ok: boolean; error?: string; [key: string]: unknown }>;

export function engineRunner(python: string, engineDir: string, env: Record<string, string>): EngineRunner {
  return (args) =>
    new Promise((resolve) => {
      let out = "";
      const child = spawn(python, ["-B", "-m", "chief_backup", ...args], { cwd: engineDir, env: { ...env, PYTHONPATH: engineDir, PYTHONIOENCODING: "utf-8" }, windowsHide: true });
      child.stdout.setEncoding("utf8").on("data", (c: string) => (out += c));
      child.on("error", () => resolve({ ok: false, error: "The backup tool couldn't start." }));
      child.on("close", () => {
        try {
          resolve(JSON.parse(out.trim().split(/\r?\n/).pop() || ""));
        } catch {
          resolve({ ok: false, error: "The backup tool stopped unexpectedly." });
        }
      });
      child.stdin.end();
    });
}

export type RestoreDeps = {
  engine: EngineRunner;
  stateDir: string;
  safetyDir: string;
  appVersion: string;
  stopGateway: () => Promise<void>;
  startGateway: () => Promise<void>;
  gatewayHealthy: () => Promise<boolean>;
  finishInDashboard: () => Promise<{ ok: boolean; error?: string }>;
  progress?: (step: string) => void;
};

export type RestoreReport = { remapped: string[]; review: { file: string; line: number; text: string }[]; missing_secrets: string[] };

export async function applyRestore(deps: RestoreDeps): Promise<{ ok: boolean; error?: string; report?: RestoreReport }> {
  deps.progress?.("Stopping Chief…");
  await deps.stopGateway();
  deps.progress?.("Restoring…");
  const applied = await deps.engine(["apply", "--state-dir", deps.stateDir, "--safety-dir", deps.safetyDir, "--app-version", deps.appVersion]);
  if (!applied.ok) {
    await deps.startGateway().catch(() => undefined);
    return { ok: false, error: applied.error || "The restore couldn't be applied; nothing was changed." };
  }
  deps.progress?.("Starting Chief…");
  let healthy = false;
  try {
    await deps.startGateway();
    healthy = await deps.gatewayHealthy();
  } catch {
    healthy = false;
  }
  if (!healthy) {
    deps.progress?.("Chief didn't start cleanly; putting the previous setup back…");
    await deps.stopGateway().catch(() => undefined);
    await deps.engine(["rollback", "--state-dir", deps.stateDir]);
    await deps.startGateway().catch(() => undefined);
    return { ok: false, error: "Chief didn't start with the restored data, so the previous setup was put back. The backup may be from an incompatible setup." };
  }
  const finished = await deps.finishInDashboard();
  if (!finished.ok) return { ok: false, error: finished.error || "The restore finished, but tidying up failed." };
  return { ok: true, report: { remapped: (applied.remapped as string[]) || [], review: (applied.review as RestoreReport["review"]) || [], missing_secrets: (applied.missing_secrets as string[]) || [] } };
}
