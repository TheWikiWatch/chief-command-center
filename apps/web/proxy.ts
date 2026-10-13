import { NextResponse, type NextRequest } from "next/server";

import { makeSessionCookie, sessionCookieName, sessionCookieValid, sessionExempt, sessionSecret, TICKET_PARAM, ticketValid } from "@/lib/loopback-session";
import { DEVICE_COOKIE, deviceAllowed } from "@/lib/server/phone-devices";
import { allowRemoteLogin, decodeTailscaleLogin, isDirectLoopback, phoneAccess, tailscaleAllowlist, viaPhoneServe } from "@/lib/tailnet-guard";

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
  // Another site (or another port on 127.0.0.1, which browsers count as the same site) never calls the API. A
  // browser always says where a request came from; the desktop app's own requests and a typed address say nothing or "none".
  const site = req.headers.get("sec-fetch-site");
  if (req.nextUrl.pathname.startsWith("/api/") && (site === "cross-site" || site === "same-site")) {
    return NextResponse.json({ ok: false, error: "Not allowed from another site." }, { status: 403 });
  }
  if (isDirectLoopback(req.headers)) {
    // The desktop app's per-launch secret (lib/loopback-session.ts): loopback alone proves nothing.
    const secret = sessionSecret();
    if (!secret || sessionExempt(req.nextUrl.pathname)) return NextResponse.next();
    const name = sessionCookieName(req.headers.get("host"));
    if (await sessionCookieValid(req.cookies.get(name)?.value || "", secret)) return NextResponse.next();
    const ticket = req.nextUrl.searchParams.get(TICKET_PARAM) || "";
    if (ticket && (await ticketValid(ticket, secret))) {
      // Back to the same host the browser used (nextUrl says "localhost" for 127.0.0.1, a different cookie jar).
      const params = new URLSearchParams(req.nextUrl.search);
      params.delete(TICKET_PARAM);
      const query = params.toString();
      const res = NextResponse.redirect(new URL(`${req.nextUrl.pathname}${query ? `?${query}` : ""}`, `http://${req.headers.get("host")}`));
      res.cookies.set(name, await makeSessionCookie(secret), { httpOnly: true, sameSite: "strict", path: "/" });
      return res;
    }
    return refused(req, "Open Chief from its desktop app on this PC.", "In the tray, right-click Chief and choose Open in browser to use it in a browser here.");
  }

  // Not this PC's own window: only a request that came through phone access (Tailscale Serve) for this PC's name.
  const phone = phoneAccess();
  if (!viaPhoneServe(req.headers, phone.host)) {
    return refused(req, "Open Chief in its desktop app on this PC.", "To use it on your phone, turn on phone access on the PC: Settings, then Phone.");
  }
  const login = decodeTailscaleLogin(req.headers.get("tailscale-user-login"));
  const allowlist = tailscaleAllowlist();
  if (allowRemoteLogin(login, allowlist, phone.tailnet)) {
    // A paired phone (lib/server/phone-devices.ts): Serve's headers can be sent by any program on this PC, so the
    // phone also shows the device cookie it got once from a code on the PC. Unpaired, it may only reach the pairing page.
    if (req.nextUrl.pathname === "/pair" || deviceAllowed(req.cookies.get(DEVICE_COOKIE)?.value)) return NextResponse.next();
    if (req.nextUrl.pathname.startsWith("/api/")) {
      return NextResponse.json({ ok: false, error: "Pair this phone first: open Chief here and enter the code from the PC." }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/pair", `https://${req.headers.get("host")}`));
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
