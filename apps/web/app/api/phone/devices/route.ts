import { NextResponse, type NextRequest } from "next/server";

import { validMutationOrigin } from "@/lib/proxy-policy";
import { listDevices, removeDevice } from "@/lib/server/phone-devices";
import { isDirectLoopback } from "@/lib/tailnet-guard";

// Paired phones (lib/server/phone-devices.ts): listed and removed from the PC only.
export const dynamic = "force-dynamic";

const pcOnly = () => NextResponse.json({ ok: false, error: "Manage paired phones from the PC." }, { status: 403 });

export function GET(req: NextRequest) {
  if (!isDirectLoopback(req.headers)) return pcOnly();
  return NextResponse.json({ ok: true, devices: listDevices() }, { headers: { "cache-control": "no-store" } });
}

export function DELETE(req: NextRequest) {
  if (!isDirectLoopback(req.headers)) return pcOnly();
  if (!validMutationOrigin(req.headers, req.url)) return NextResponse.json({ ok: false, error: "Refused." }, { status: 403 });
  const id = req.nextUrl.searchParams.get("id") || "";
  return NextResponse.json({ ok: removeDevice(id) });
}
