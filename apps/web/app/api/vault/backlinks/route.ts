import { NextRequest } from "next/server";

import { vaultFail } from "@/lib/server/vault-http";
import { backlinks } from "@/lib/server/vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Notes that link to this one (read-only). */
export async function GET(req: NextRequest) {
  const rel = req.nextUrl.searchParams.get("path") || "";
  try {
    const links = rel ? await backlinks(rel) : [];
    return Response.json({ ok: true, path: rel, links }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return vaultFail(error);
  }
}
