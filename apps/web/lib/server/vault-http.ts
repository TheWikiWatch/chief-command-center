import { VaultPathError } from "@/lib/server/vault";

/** Vault errors never reveal paths: bad or outside paths look the same as missing ones. */
export function vaultFail(error: unknown) {
  if (error instanceof VaultPathError) {
    if (error.message === "not configured") {
      return Response.json({ ok: false, error: "No Second Brain folder is set up yet", setup: true }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    const status = error.message === "not found" || error.message === "hidden" || error.message === "outside the vault" ? 404 : 400;
    return Response.json({ ok: false, error: status === 404 ? "Not found in the vault" : "Bad path" }, { status, headers: { "Cache-Control": "no-store" } });
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") {
    return Response.json({ ok: false, error: "Not found in the vault" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  return Response.json({ ok: false, error: "The vault could not be read" }, { status: 500, headers: { "Cache-Control": "no-store" } });
}
