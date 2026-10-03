import { requestJson } from "@/lib/request";

/** Settings → About: the app's and Hermes's versions, and the bundled toolkit's. */
export type AboutInfo = { app: string; hermes: string; toolkit: { version: string; source: string } | null; reportEmail: string };

export async function fetchAbout(): Promise<AboutInfo> {
  const [config, bridge] = await Promise.all([
    requestJson<{ versions?: { app?: string; hermes?: string }; reportEmail?: string }>("/api/app/config", { cache: "no-store" }, 10_000).catch(() => ({
      versions: undefined,
      reportEmail: "",
    })),
    requestJson<{ ok: boolean; hermes?: string; toolkit?: { version?: string; source?: string } | null }>("/api/bridge/about", { cache: "no-store" }, 10_000).catch(() => null),
  ]);
  const toolkit = bridge?.toolkit?.version ? { version: bridge.toolkit.version, source: bridge.toolkit.source || "" } : null;
  // The desktop app knows its bundled Hermes; a development build asks the running bridge.
  return { app: config.versions?.app || "development build", hermes: config.versions?.hermes || bridge?.hermes || "", toolkit, reportEmail: config.reportEmail || "" };
}
