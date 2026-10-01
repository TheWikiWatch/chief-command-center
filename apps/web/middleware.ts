import { NextResponse, type NextRequest } from "next/server";

import { allowRemoteLogin, decodeTailscaleLogin, isDirectLoopback, tailscaleAllowlist } from "@/lib/tailnet-guard";

export function middleware(req: NextRequest) {
  if (isDirectLoopback(req.headers)) {
    return NextResponse.next();
  }

  const login = decodeTailscaleLogin(req.headers.get("tailscale-user-login"));
  const allowlist = tailscaleAllowlist();
  if (allowRemoteLogin(login, allowlist)) {
    return NextResponse.next();
  }

  const api = req.nextUrl.pathname.startsWith("/api/");
  const detail = login
    ? "This Tailscale account isn't allowed to open Chief."
    : "Open Chief through its Tailscale address, or in the desktop app on its PC.";

  if (api) {
    return NextResponse.json({ ok: false, error: detail }, { status: 401 });
  }

  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chief</title><body style="font-family:system-ui,sans-serif;background:#0c0d10;color:#e8eaed;padding:2rem;line-height:1.5"><h1 style="font-size:1.25rem">Chief Command Center</h1><p>${detail}</p><p style="color:#9aa0a6">On the PC that runs Chief: Settings, then Phone, then Who can open Chief. Sign in to Tailscale on this device with an account allowed there.</p></body>`,
    {
      status: 401,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    },
  );
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|icon.svg|icons/|favicon.ico|manifest.webmanifest).*)"],
};
