import { NextRequest } from "next/server";
import { deniedFilePath, permittedOperation, protectFileHeaders, validMutationOrigin } from "@/lib/proxy-policy";
import { bridgeUrl } from "@/lib/server/app-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function bridgeBase() {
  return bridgeUrl();
}

function token() {
  return process.env.CHIEF_DASHBOARD_TOKEN || "";
}

async function proxy(req: NextRequest, path: string[]) {
  if (!permittedOperation("bridge", req.method, path)) return Response.json({ ok: false, error: "Unsupported operation" }, { status: 404 });
  if (req.method !== "GET" && !validMutationOrigin(req.headers, req.url)) return Response.json({ ok: false, error: "Invalid request origin" }, { status: 403 });
  const url = new URL(req.url);
  if (path[0] === "file" || path[0] === "preview" || path[0] === "thumb") {
    const file = url.searchParams.get("path") || "";
    if (deniedFilePath(file)) return Response.json({ ok: false, error: "not found" }, { status: 404 });
  }
  // Plugin SSE is not proxied: it holds App Router requests open and 502-floods a down gateway.
  if (path[0] === "events") {
    return new Response(null, { status: 204 });
  }
  const rel = path.join("/");
  const target = `${bridgeBase()}/${rel}${url.search}`;
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${token()}`);
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("Content-Type", contentType);
  const range = req.headers.get("range");
  if (range) headers.set("Range", range);

  let body: ArrayBuffer | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await req.arrayBuffer();
  }

  // A long-poll (/transcript?wait=N) is held by the bridge for up to N seconds (at most 25).
  const wait = path[0] === "transcript" ? Math.min(25, Math.max(0, Number(url.searchParams.get("wait")) || 0)) : 0;
  // Provider setup can fetch catalogs and run one test completion: allow a minute.
  const timeoutMs = wait
    ? (wait + 10) * 1000
    : path[0] === "setup"
      ? 60000
    : path[0] === "file" || path[0] === "preview" || path[0] === "thumb" || path[0] === "transcribe" || path[0] === "speak"
      ? 180000
      : path[0] === "snapshot"
          ? 15000
          : path[0] === "health"
            ? 2000
            : path[0] === "settings"
              ? 15000
        : path[0] === "send"
          ? 120000
                : 8000;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      cache: "no-store",
      // A long-poll the browser gave up on (tab closed, app backgrounded) is not waited out here.
      signal: wait ? AbortSignal.any([AbortSignal.timeout(timeoutMs), req.signal]) : AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return Response.json({ ok: false, error: "bridge unreachable" }, { status: 502 });
  }

  const out = new Headers();
  const pass = [
    "content-type",
    "cache-control",
    "content-length",
    "accept-ranges",
    "content-range",
    "content-disposition",
  ];
  for (const key of pass) {
    const v = upstream.headers.get(key);
    if (v) out.set(key, v);
  }
  if (path[0] === "file" || path[0] === "preview" || path[0] === "thumb") protectFileHeaders(out, upstream.ok ? path[0] : "file");
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { path } = await ctx.params;
  return proxy(req, path);
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { path } = await ctx.params;
  return proxy(req, path);
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { path } = await ctx.params;
  return proxy(req, path);
}
