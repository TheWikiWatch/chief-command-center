import { requestJson } from "@/lib/request";

/** Settings → About: the app's and Hermes's versions, and the bundled toolkit's. */
export type AboutInfo = { app: string; hermes: string; toolkit: { version: string; source: string } | null };

export async function fetchAbout(): Promise<AboutInfo> {
  const [config, bridge] = await Promise.all([
    requestJson<{ versions?: { app?: string; hermes?: string } }>("/api/app/config", { cache: "no-store" }, 10_000).catch(() => ({ versions: undefined })),
    requestJson<{ ok: boolean; toolkit?: { version?: string; source?: string } | null }>("/api/bridge/about", { cache: "no-store" }, 10_000).catch(() => null),
  ]);
  const toolkit = bridge?.toolkit?.version ? { version: bridge.toolkit.version, source: bridge.toolkit.source || "" } : null;
  return { app: config.versions?.app || "development build", hermes: config.versions?.hermes || "", toolkit };
}
