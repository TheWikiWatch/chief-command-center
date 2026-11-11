import { createReadStream, promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { NextRequest } from "next/server";

import { fileSecurityHeaders } from "@/lib/proxy-policy";
import { vaultFail } from "@/lib/server/vault-http";
import { kindOf, mimeOf, resolveInVault, resolveLink } from "@/lib/server/vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INLINE = new Set(["note", "image", "pdf", "video", "audio", "canvas", "text"]);

/**
 * One vault file, read-only. `path` is vault-relative; `name` resolves an Obsidian embed (![[x.png]])
 * relative to `from`. Supports Range so videos and audio can seek.
 */
export async function GET(req: NextRequest) {
  const res = await read(req);
  // next.config.ts leaves this route out of the app-wide headers: every answer here carries the file set itself.
  fileSecurityHeaders(res.headers);
  return res;
}

async function read(req: NextRequest): Promise<Response> {
  const params = req.nextUrl.searchParams;
  try {
    let rel = params.get("path") || "";
    if (!rel && params.get("name")) rel = (await resolveLink(params.get("name") || "", params.get("from") || undefined)) || "";
    if (!rel) return Response.json({ ok: false, error: "Not found in the vault" }, { status: 404 });
    const { abs, rel: clean } = await resolveInVault(rel);
    const st = await fs.stat(abs);
    if (!st.isFile()) return Response.json({ ok: false, error: "Not a file" }, { status: 400 });

    const kind = kindOf(clean);
    const name = clean.split("/").pop() || "file";
    const headers = new Headers({
      "Content-Type": mimeOf(clean),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=60",
      "Last-Modified": new Date(st.mtimeMs).toUTCString(),
    });
    // An SVG is a document that can carry script: shown in place only as a picture (an <img> asks for an image),
    // downloaded when it is opened in a tab.
    const svgPage = mimeOf(clean) === "image/svg+xml" && req.headers.get("sec-fetch-dest") !== "image";
    const download = params.get("download") === "1" || !INLINE.has(kind) || svgPage;
    headers.set("Content-Disposition", `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`);

    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") || "");
    if (range && st.size > 0) {
      let start = range[1] ? Number(range[1]) : NaN;
      let end = range[2] ? Number(range[2]) : st.size - 1;
      if (Number.isNaN(start)) {
        start = Math.max(0, st.size - end);
        end = st.size - 1;
      }
      end = Math.min(end, st.size - 1);
      if (start > end || start >= st.size) {
        return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${st.size}` } });
      }
      headers.set("Content-Range", `bytes ${start}-${end}/${st.size}`);
      headers.set("Content-Length", String(end - start + 1));
      const body = Readable.toWeb(createReadStream(abs, { start, end })) as ReadableStream;
      return new Response(body, { status: 206, headers });
    }
    headers.set("Content-Length", String(st.size));
    return new Response(Readable.toWeb(createReadStream(abs)) as ReadableStream, { status: 200, headers });
  } catch (error) {
    return vaultFail(error);
  }
}
