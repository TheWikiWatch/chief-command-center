import { NextResponse, type NextRequest } from "next/server";

import { sameSecret, sessionCookieName, sessionExempt, sessionSecret, TICKET_PARAM, ticketValid } from "@/lib/loopback-session";
import { allowRemoteLogin, decodeTailscaleLogin, isDirectLoopback, tailscaleAllowlist } from "@/lib/tailnet-guard";

function refused(req: NextRequest, detail: string, hint: string) {
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ ok: false, error: detail }, { status: 401 });
  }
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chief</title><body style="font-family:system-ui,sans-serif;background:#0c0d10;color:#e8eaed;padding:2rem;line-height:1.5"><h1 style="font-size:1.25rem">Chief Command Center</h1><p>${detail}</p><p style="color:#9aa0a6">${hint}</p></body>`,
    {
      status: 401,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    },
  );
}

/** Next 16's request gate (formerly middleware; runs on Node): who may open the dashboard at all. */
export async function proxy(req: NextRequest) {
  if (isDirectLoopback(req.headers)) {
    // The desktop app's per-launch secret (lib/loopback-session.ts): loopback alone proves nothing.
    const secret = sessionSecret();
    if (!secret || sessionExempt(req.nextUrl.pathname)) return NextResponse.next();
    const name = sessionCookieName(req.headers.get("host"));
    if (sameSecret(req.cookies.get(name)?.value || "", secret)) return NextResponse.next();
    const ticket = req.nextUrl.searchParams.get(TICKET_PARAM) || "";
    if (ticket && (await ticketValid(ticket, secret))) {
      // Back to the same host the browser used (nextUrl says "localhost" for 127.0.0.1, a different cookie jar).
      const params = new URLSearchParams(req.nextUrl.search);
      params.delete(TICKET_PARAM);
      const query = params.toString();
      const res = NextResponse.redirect(new URL(`${req.nextUrl.pathname}${query ? `?${query}` : ""}`, `http://${req.headers.get("host")}`));
      res.cookies.set(name, secret, { httpOnly: true, sameSite: "strict", path: "/" });
      return res;
    }
    return refused(req, "Open Chief from its desktop app on this PC.", "In the tray, right-click Chief and choose Open in browser to use it in a browser here.");
  }

  const login = decodeTailscaleLogin(req.headers.get("tailscale-user-login"));
  const allowlist = tailscaleAllowlist();
  if (allowRemoteLogin(login, allowlist)) {
    return NextResponse.next();
  }

  return refused(
    req,
    login ? "This Tailscale account isn't allowed to open Chief." : "Open Chief through its Tailscale address, or in the desktop app on its PC.",
    "On the PC that runs Chief: Settings, then Phone, then Who can open Chief. Sign in to Tailscale on this device with an account allowed there.",
  );
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|icon.svg|icons/|favicon.ico|manifest.webmanifest).*)"],
};
