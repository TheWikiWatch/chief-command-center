import { NextRequest } from "next/server";
import { deniedFilePath, permittedOperation, protectFileHeaders, validMutationOrigin } from "@/lib/proxy-policy";
import { bridgeUrl } from "@/lib/server/app-config";
import { invalidateSecondBrain } from "@/lib/server/second-brain";

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
  const rel = path.join("/");
  // The live channel (lib/live.ts): streamed through, closed when the page goes away. A gateway that is down
  // answers at once (502), and the page backs off before trying again, so nothing floods.
  if (path[0] === "events") {
    try {
      const upstream = await fetch(`${bridgeBase()}/events`, {
        headers: { Authorization: `Bearer ${token()}` },
        cache: "no-store",
        signal: AbortSignal.any([AbortSignal.timeout(3000 + 6 * 3600 * 1000), req.signal]),
      });
      if (!upstream.ok || !upstream.body) return new Response(null, { status: 502 });
      return new Response(upstream.body, {
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" },
      });
    } catch {
      return new Response(null, { status: 502 });
    }
  }
  const target = `${bridgeBase()}/${rel}${url.search}`;
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${token()}`);
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("Content-Type", contentType);
  const range = req.headers.get("range");
  if (range) headers.set("Range", range);

  // Bodies stream through (an 80 MB send isn't held in this process a second time).
  const body = req.method !== "GET" && req.method !== "HEAD" ? req.body : null;
  const length = req.headers.get("content-length");
  if (length) headers.set("Content-Length", length);

  // A long-poll (/transcript?wait=N) is held by the bridge for up to N seconds (at most 25).
  const wait = path[0] === "transcript" ? Math.min(25, Math.max(0, Number(url.searchParams.get("wait")) || 0)) : 0;
  // Provider setup can fetch catalogs and run one test completion: allow a minute.
  // A generated portrait waits on the image service (the bridge allows it 150 s); installing a pet downloads its
  // sprite sheet; the pet gallery's first read fetches its whole manifest.
  const look = path[0] === "look" ? path[2] || "" : "";
  const timeoutMs = wait
    ? (wait + 10) * 1000
    : look === "portrait"
      ? 170000
    : look === "pet" || look === "avatar"
      ? 70000
    : rel === "pets/catalog" || path[0] === "pets" || path[0] === "pet"
      ? 30000
    : path[0] === "setup"
      ? 60000
    : rel === "tools/test"
      ? 180000
    : rel === "report/draft"
      ? 60000
    : path[0] === "tools"
      ? 30000
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

  // The time limit is for the bridge to start answering. Once it has, the answer streams to the browser for as long
  // as that takes: a limit over the whole body cut big answers off half-way to a phone ("failed to pipe response"),
  // and the page then asked again from the start. A body that stalls is still ended, after BODY_GRACE_MS.
  const controller = new AbortController();
  const stop = (reason: unknown) => controller.abort(reason);
  let timer = setTimeout(() => stop(new DOMException("The bridge didn't answer in time", "TimeoutError")), timeoutMs);
  // A long-poll the browser gave up on (tab closed, app backgrounded) is not waited out here.
  const onGone = () => stop(req.signal.reason);
  if (wait) req.signal.addEventListener("abort", onGone, { once: true });
  const finish = () => {
    clearTimeout(timer);
    req.signal.removeEventListener("abort", onGone);
  };
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      // Required by Node's fetch for a streamed request body.
      ...(body ? { duplex: "half" as const } : {}),
      cache: "no-store",
      signal: controller.signal,
    });
  } catch {
    finish();
    return Response.json({ ok: false, error: "bridge unreachable" }, { status: 502 });
  }
  clearTimeout(timer);
  timer = setTimeout(() => stop(new DOMException("The answer stalled", "TimeoutError")), Math.max(timeoutMs, BODY_GRACE_MS));
  // A new Second Brain folder takes effect in Today and Vault on the next request.
  if (req.method === "POST" && rel === "setup/second-brain") invalidateSecondBrain();

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
  return new Response(upstream.body ? passThrough(upstream.body, rel, finish) : null, { status: upstream.status, headers: out });
}

/** How long an answer that has started may take to finish streaming. */
const BODY_GRACE_MS = 5 * 60_000;

/** The bridge's answer streamed on, with its timers cleared when it ends, and a cut-off logged with its route. */
function passThrough(body: ReadableStream<Uint8Array>, route: string, done: () => void): ReadableStream<Uint8Array> {
  // Taken on the first read, not now: the body stays unlocked until the answer is actually sent.
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      reader ??= body.getReader();
      try {
        const { value, done: end } = await reader.read();
        if (end) {
          done();
          ctrl.close();
        } else ctrl.enqueue(value);
      } catch (error) {
        done();
        console.warn(`bridge proxy: the answer to ${route} was cut off (${(error as Error)?.name || "error"})`);
        ctrl.error(error);
      }
    },
    cancel(reason) {
      done();
      void (reader ?? body).cancel(reason).catch(() => undefined);
    },
  });
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

/** A bot's photo (`look/<id>/avatar`): the image itself is the body. */
export async function PUT(req: NextRequest, ctx: Ctx) {
  const { path } = await ctx.params;
  return proxy(req, path);
}
