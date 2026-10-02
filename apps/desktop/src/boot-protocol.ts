import { readFileSync } from "node:fs";
import path from "node:path";

import { BOOT_SCHEME, isBootPage } from "./guards";

type ProtocolApi = {
  registerSchemesAsPrivileged: (schemes: { scheme: string; privileges: Record<string, boolean> }[]) => void;
  handle: (scheme: string, handler: (req: Request) => Response | Promise<Response>) => void;
};

/** Before the app is ready: the boot page's scheme behaves like a secure, standard origin. */
export function registerBootScheme(protocol: ProtocolApi) {
  protocol.registerSchemesAsPrivileged([{ scheme: BOOT_SCHEME, privileges: { standard: true, secure: true } }]);
}

/** Once ready: serve static/boot.html (read by the main process, which can read inside app.asar) and nothing else. */
export function serveBootPage(protocol: ProtocolApi, staticDir: string) {
  protocol.handle(BOOT_SCHEME, (req) => {
    if (!isBootPage(req.url)) return new Response("Not found", { status: 404 });
    const html = readFileSync(path.join(staticDir, "boot.html"));
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        // The boot page only shows steps and calls the preload; it loads nothing from anywhere.
        "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:",
      },
    });
  });
}
