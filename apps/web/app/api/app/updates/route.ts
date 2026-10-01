import { readUpdateHistory } from "@/lib/server/update-history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The app's update history: published releases with their notes, and when each version first ran here. */
export async function GET() {
  return Response.json({ ok: true, ...(await readUpdateHistory()) }, { headers: { "Cache-Control": "no-store" } });
}
