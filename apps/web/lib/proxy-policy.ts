const bridgeGet = new Set(["health", "snapshot", "transcript", "approvals", "voice-config", "settings", "file", "preview", "thumb", "events", "push/vapidPublicKey", "push/subscriptions","setup/status", "setup/providers", "setup/models", "setup/second-brain", "voice/model", "persona", "persona/soul/version", "fleet", "fleet/models", "second-brain/routines", "usage", "about", "threads", "routines", "tools"]);
const bridgePost = new Set(["send", "stop", "steer", "queue", "approve", "transcribe", "speak", "push/subscribe", "push/unsubscribe", "push/test", "setup/key", "setup/model", "setup/endpoint/check", "setup/endpoint/save", "setup/test", "setup/second-brain", "setup/second-brain/inspect", "setup/soul/seed", "voice/model/download", "voice/model/cancel", "voice/model/delete", "persona/soul", "persona/soul/restore", "persona/memory", "fleet/model", "fleet/retire", "fleet/restore", "fleet/archive/remove", "setup/key/remove", "clarify", "second-brain/routines", "profile/rename", "usage/budget", "threads", "threads/rename", "threads/archive", "threads/fresh", "routines", "routines/update", "routines/run", "routines/delete", "tools/test"]);
const bridgePatch = new Set(["settings", "tools"]);
const opsGet = new Set(["health", "meta", "boards", "focus", "today", "pulse", "attention", "settings"]);

export function permittedOperation(service: "bridge" | "ops", method: string, path: string[]): boolean {
  if (!path.length || path.some(p => !p || p === "." || p === ".." || /[\\/?#%]/.test(p))) return false;
  const route = path.join("/");
  if (service === "ops") return method === "GET" ? opsGet.has(route) : method === "POST" ? route === "launch" : method === "PUT" && route === "settings";
  if (method === "GET") return bridgeGet.has(route) || (path.length === 2 && ["profile", "avatar"].includes(path[0]) && /^[\w-]+$/.test(path[1]));
  if (method === "POST") return bridgePost.has(route);
  return method === "PATCH" && bridgePatch.has(route);
}

/**
 * Paths the proxy refuses before an older installed bridge sees them: the token,
 * Hermes SQLite files (state.db-wal holds recent chat) and NTFS stream paths (file::$DATA).
 */
export function deniedFilePath(raw: string): boolean {
  if (/(^|[\\/])\.token(?:$|[\\/])/i.test(raw)) return true;
  if (/\.(db|sqlite3?)(-wal|-shm|-journal)?$/i.test(raw)) return true;
  return raw.replace(/^[A-Za-z]:/, "").includes(":");
}

/** Browser writes must carry the exact origin of the addressed dashboard host. */
export function validMutationOrigin(headers: Headers, requestUrl: string): boolean {
  if (headers.get("sec-fetch-site") === "cross-site") return false;
  const raw = headers.get("origin");
  if (!raw || raw === "null") return false;
  try {
    const origin = new URL(raw);
    const target = new URL(requestUrl);
    const host = headers.get("host") || target.host;
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host);
    return origin.origin === raw && origin.host.toLowerCase() === host.toLowerCase() &&
      (local ? ["http:", "https:"].includes(origin.protocol) : origin.protocol === "https:");
  } catch { return false; }
}

export function protectFileHeaders(headers: Headers, route = "file"): void {
  headers.set("Content-Security-Policy", "sandbox; default-src 'none'; frame-ancestors 'none'");
  headers.set("X-Content-Type-Options", "nosniff");
  // Originals are never cached on the phone. Thumbnails are small derived frames, so a
  // PWA relaunch should not refetch every video poster in the history.
  headers.set("Cache-Control", route === "thumb" ? "private, max-age=3600" : "private, no-store");
  const type = (headers.get("content-type") || "").split(";")[0].toLowerCase();
  const inline = /^(image\/(png|jpeg|gif|webp|bmp)|audio\/[\w.+-]+|video\/[\w.+-]+|application\/pdf)$/.test(type);
  if (!inline) headers.set("Content-Disposition", (headers.get("content-disposition") || "attachment").replace(/^inline/i, "attachment"));
}
