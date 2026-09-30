import { bridgeUrl } from "@/lib/server/app-config";

/** A server-side JSON call to the chief gateway's bridge. The token never leaves the server. */
export async function bridgeJson<T>(path: string, init: RequestInit = {}, timeoutMs = 4000): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${process.env.CHIEF_DASHBOARD_TOKEN || ""}`);
  const res = await fetch(`${bridgeUrl()}${path}`, { ...init, headers, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`bridge ${res.status}`);
  return (await res.json()) as T;
}
