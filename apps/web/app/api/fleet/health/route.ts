import { readDecisions, readReport, withDecisions } from "@/lib/server/fleet";

import { ledgerConfig } from "@/lib/server/app-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The fleet learning report (read-only), with proposal decisions made since the ledger last ran.
 * `?only=flags` is the small version the Health badge polls.
 */
export async function GET(req: Request) {
  if (!ledgerConfig()) return Response.json({ ok: false, error: "Fleet Health is not set up on this install.", setup: true }, { status: 404, headers: { "Cache-Control": "no-store" } });
  const raw = await readReport();
  if (!raw) {
    return Response.json(
      { ok: false, error: "The learning ledger has not written a report yet. It runs every 30 minutes as the chief's cron job." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  const report = withDecisions(raw, await readDecisions());
  const generatedAt = Number(report.generatedAt) || 0;
  const ageSeconds = Math.max(0, Math.round(Date.now() / 1000 - generatedAt));
  const onlyFlags = new URL(req.url).searchParams.get("only") === "flags";
  const body = onlyFlags
    ? { ok: true, generatedAt, ageSeconds, flags: Array.isArray(report.flags) ? report.flags : [] }
    : { ok: true, ...report, ageSeconds };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
