import { NextRequest } from "next/server";

import { validMutationOrigin } from "@/lib/proxy-policy";
import { runLedger } from "@/lib/server/fleet";

import { ledgerConfig } from "@/lib/server/app-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let running: Promise<string> | null = null;

/** Run the ledger now (snapshot + report) instead of waiting for the 30-minute cron. */
export async function POST(req: NextRequest) {
  if (!ledgerConfig()) return Response.json({ ok: false, error: "Fleet Health is not set up on this install.", setup: true }, { status: 404, headers: { "Cache-Control": "no-store" } });
  if (!validMutationOrigin(req.headers, req.url)) return Response.json({ ok: false, error: "Invalid request origin" }, { status: 403 });
  try {
    running ??= runLedger(["run"], 120_000).finally(() => {
      running = null;
    });
    await running;
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "Refresh failed" }, { status: 500 });
  }
}
