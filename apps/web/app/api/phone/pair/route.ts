import { NextResponse, type NextRequest } from "next/server";

import { validMutationOrigin } from "@/lib/proxy-policy";
import { createPairingCode } from "@/lib/server/phone-devices";
import { isDirectLoopback } from "@/lib/tailnet-guard";

// A one-time code for pairing a phone (lib/server/phone-devices.ts). Only the PC's own window may ask for one: a phone
// that could make codes could pair any other device.
export const dynamic = "force-dynamic";

export function POST(req: NextRequest) {
  if (!isDirectLoopback(req.headers)) return NextResponse.json({ ok: false, error: "Pair phones from the PC." }, { status: 403 });
  if (!validMutationOrigin(req.headers, req.url)) return NextResponse.json({ ok: false, error: "Refused." }, { status: 403 });
  return NextResponse.json({ ok: true, ...createPairingCode() }, { headers: { "cache-control": "no-store" } });
}
