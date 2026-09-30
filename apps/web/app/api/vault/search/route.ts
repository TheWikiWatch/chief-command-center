import { NextRequest } from "next/server";

import { vaultFail } from "@/lib/server/vault-http";
import { searchVault } from "@/lib/server/vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** File-name and full-text search over the vault (read-only). */
export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") || "").slice(0, 120);
  try {
    const hits = q.trim() ? await searchVault(q) : [];
    return Response.json({ ok: true, q, hits }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return vaultFail(error);
  }
}
