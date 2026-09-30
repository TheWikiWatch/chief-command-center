import { NextRequest } from "next/server";
import { permittedOperation, validMutationOrigin } from "@/lib/proxy-policy";
import { opsUrl } from "@/lib/server/app-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function opsBase() {
  return opsUrl();
}

async function proxy(req: NextRequest, path: string[]) {
  if (!opsBase()) return Response.json({ ok: false, error: "Today is not connected to a task service on this install.", setup: true }, { status: 404 });
  if (!permittedOperation("ops", req.method, path)) return Response.json({ ok: false, error: "Unsupported operation" }, { status: 404 });
  if (req.method !== "GET" && !validMutationOrigin(req.headers, req.url)) return Response.json({ ok: false, error: "Invalid request origin" }, { status: 403 });
  const rel = path.join("/");
  const url = new URL(req.url);
  const target =
    path[0] === "health" ? `${opsBase()}/health${url.search}` : `${opsBase()}/api/${rel}${url.search}`;
  const headers = new Headers();
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("Content-Type", contentType);

  let body: ArrayBuffer | string | undefined;
  if (req.method === "PUT" && path[0] === "settings") {
    // The dashboard only edits the vault folder. Never relay other Ops settings such as hermes_cmd.
    const vaultPath = await req.json().then((b: unknown) => (b as { vault_path?: unknown })?.vault_path, () => undefined);
    if (typeof vaultPath !== "string" || !vaultPath.trim()) {
      return Response.json({ ok: false, error: "Only vault_path can be changed here." }, { status: 400 });
    }
    body = JSON.stringify({ vault_path: vaultPath.trim() });
    headers.set("Content-Type", "application/json");
  } else if (req.method !== "GET" && req.method !== "HEAD") {
    body = await req.arrayBuffer();
  }

  const timeoutMs = path[0] === "health" ? 2000 : path[0] === "launch" ? 15000 : 8000;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return Response.json({ ok: false, error: "ops unreachable" }, { status: 502 });
  }

  const out = new Headers();
  const type = upstream.headers.get("content-type");
  if (type) out.set("content-type", type);
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

export async function PUT(req: NextRequest, ctx: Ctx) {
  const { path } = await ctx.params;
  return proxy(req, path);
}
