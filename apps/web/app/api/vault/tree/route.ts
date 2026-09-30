import { NextRequest } from "next/server";

import { vaultFail } from "@/lib/server/vault-http";
import { listDir, vaultRoot, warmVaultIndex } from "@/lib/server/vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One folder of the vault (read-only). */
export async function GET(req: NextRequest) {
  const dir = req.nextUrl.searchParams.get("dir") || "";
  // Someone is browsing the vault: have the search index ready before they search.
  warmVaultIndex();
  try {
    const [entries, root] = await Promise.all([listDir(dir), vaultRoot()]);
    return Response.json({ ok: true, dir, root: root.split(/[\\/]/).pop(), rootPath: root, entries }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return vaultFail(error);
  }
}
