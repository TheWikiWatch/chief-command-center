import { publicAppConfig } from "@/lib/server/app-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Names and which optional features this install has. No paths, URLs or credentials. */
export async function GET() {
  return Response.json({ ok: true, ...publicAppConfig() }, { headers: { "Cache-Control": "no-store" } });
}
