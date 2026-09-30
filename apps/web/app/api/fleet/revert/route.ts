import { NextRequest } from "next/server";

import { validMutationOrigin } from "@/lib/proxy-policy";
import { runLedger } from "@/lib/server/fleet";

import { ledgerConfig } from "@/lib/server/app-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Put back the version before one recorded skill change (the ledger backs up the current file first).
 * `discardNewer` is the number of later edits the viewer was shown; the ledger refuses unless it still matches.
 */
export async function POST(req: NextRequest) {
  if (!ledgerConfig()) return Response.json({ ok: false, error: "Fleet Health is not set up on this install.", setup: true }, { status: 404, headers: { "Cache-Control": "no-store" } });
  if (!validMutationOrigin(req.headers, req.url)) return Response.json({ ok: false, error: "Invalid request origin" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { id?: unknown; discardNewer?: unknown };
  const id = Number(body.id);
  const discard = Number(body.discardNewer ?? 0);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ ok: false, error: "Which change? (id)" }, { status: 400 });
  if (!Number.isInteger(discard) || discard < 0) return Response.json({ ok: false, error: "discardNewer must be a count" }, { status: 400 });
  try {
    const message = await runLedger(["revert", String(id), ...(discard ? ["--discard-newer", String(discard)] : [])]);
    return Response.json({ ok: true, message: message.split(/\r?\n/)[0] });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "Revert failed" }, { status: 500 });
  }
}
