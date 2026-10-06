import { NextRequest } from "next/server";

import { validMutationOrigin } from "@/lib/proxy-policy";
import { recordFlagAck } from "@/lib/server/fleet";

import { ledgerConfig } from "@/lib/server/app-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUBJECT = /^[\w./:@-]{1,200}$/;

/**
 * What the owner did about a Fleet Health flag, for every device: "fine" (looks fine), "asked" (sent to the chief;
 * the chief's tidy-up isn't counted as rework) or "clear" (show it again). Stored in flag-acks.json next to the report.
 */
export async function POST(req: NextRequest) {
  if (!ledgerConfig()) return Response.json({ ok: false, error: "Fleet Health is not set up on this install.", setup: true }, { status: 404, headers: { "Cache-Control": "no-store" } });
  if (!validMutationOrigin(req.headers, req.url)) return Response.json({ ok: false, error: "Invalid request origin" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { subject?: unknown; action?: unknown; skill?: unknown };
  const subject = typeof body.subject === "string" ? body.subject : "";
  if (!SUBJECT.test(subject)) return Response.json({ ok: false, error: "Which flag? (subject)" }, { status: 400 });
  if (body.action !== "fine" && body.action !== "asked" && body.action !== "clear") {
    return Response.json({ ok: false, error: "action must be fine, asked or clear" }, { status: 400 });
  }
  const skill = typeof body.skill === "string" && SUBJECT.test(body.skill) ? body.skill : undefined;
  try {
    await recordFlagAck(subject, body.action === "clear" ? null : body.action, skill);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "Could not save that" }, { status: 500 });
  }
}
