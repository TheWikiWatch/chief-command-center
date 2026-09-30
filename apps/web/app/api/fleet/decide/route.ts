import { NextRequest } from "next/server";

import { validMutationOrigin } from "@/lib/proxy-policy";
import { recordDecision } from "@/lib/server/fleet";

import { ledgerConfig } from "@/lib/server/app-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Approve or dismiss one distill proposal, for every device (decisions.json next to the report). */
export async function POST(req: NextRequest) {
  if (!ledgerConfig()) return Response.json({ ok: false, error: "Fleet Health is not set up on this install.", setup: true }, { status: 404, headers: { "Cache-Control": "no-store" } });
  if (!validMutationOrigin(req.headers, req.url)) return Response.json({ ok: false, error: "Invalid request origin" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { id?: unknown; decision?: unknown };
  const id = typeof body.id === "string" ? body.id : "";
  if (!/^[\w.-]{1,64}$/.test(id)) return Response.json({ ok: false, error: "Which proposal? (id)" }, { status: 400 });
  if (body.decision !== "approve" && body.decision !== "dismiss") return Response.json({ ok: false, error: "decision must be approve or dismiss" }, { status: 400 });
  try {
    await recordDecision(id, body.decision);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "Could not save the decision" }, { status: 500 });
  }
}
