import { NextRequest } from "next/server";

import { runLedger } from "@/lib/server/fleet";

import { ledgerConfig } from "@/lib/server/app-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One recorded skill change as a unified diff (`?id=`), or the net change of several edits to the same
 * file (`?id=<latest>&from=<first>`). Recorded versions never change, so the answer can be cached.
 */
export async function GET(req: NextRequest) {
  if (!ledgerConfig()) return Response.json({ ok: false, error: "Fleet Health is not set up on this install.", setup: true }, { status: 404, headers: { "Cache-Control": "no-store" } });
  const params = new URL(req.url).searchParams;
  const id = Number(params.get("id"));
  const from = params.has("from") ? Number(params.get("from")) : null;
  if (!Number.isInteger(id) || id <= 0 || (from !== null && (!Number.isInteger(from) || from <= 0 || from > id))) {
    return Response.json({ ok: false, error: "id (and from) must be change numbers" }, { status: 400 });
  }
  try {
    const diff = await runLedger(["diff", String(id), ...(from !== null && from !== id ? ["--from", String(from)] : [])], 20_000);
    return Response.json({ ok: true, diff }, { headers: { "Cache-Control": "private, max-age=86400" } });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "The ledger failed" }, { status: 500 });
  }
}
