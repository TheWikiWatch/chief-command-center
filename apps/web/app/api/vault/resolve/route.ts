import { NextRequest } from "next/server";

import { vaultFail } from "@/lib/server/vault-http";
import { kindOf, relFromAbsolute, resolveInVault, resolveLink } from "@/lib/server/vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Turn whatever Chief or a note wrote into a vault path: an absolute path (E:\Second Brain\...),
 * a vault-relative path, or an Obsidian link target ([[Note]], [[folder/Note#Heading]]).
 */
export async function GET(req: NextRequest) {
  const ref = (req.nextUrl.searchParams.get("ref") || "").trim().replace(/^`|`$/g, "");
  const from = req.nextUrl.searchParams.get("from") || undefined;
  try {
    let rel: string | null = null;
    if (/^[A-Za-z]:[\\/]/.test(ref)) rel = await relFromAbsolute(ref);
    else {
      // A plain relative path first, then an Obsidian-style name.
      const direct = await resolveInVault(ref).then((r) => r.rel).catch(() => null);
      rel = direct ?? (await resolveLink(ref, from));
    }
    if (rel === null) return Response.json({ ok: false, error: "Not found in the vault" }, { status: 404 });
    const { rel: clean } = await resolveInVault(rel);
    const heading = ref.includes("#") ? ref.split("#").slice(1).join("#").split("|")[0].trim() : "";
    return Response.json({ ok: true, path: clean, kind: kindOf(clean), heading }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return vaultFail(error);
  }
}
