import { NextResponse, type NextRequest } from "next/server";

import { validMutationOrigin } from "@/lib/proxy-policy";
import { DEVICE_COOKIE, redeemPairingCode } from "@/lib/server/phone-devices";

/*
 * Pairing a phone (lib/server/phone-devices.ts). The only page an unpaired phone can open: it trades the one-time
 * code the PC shows (Settings → Phone → Pair a phone) for this phone's device cookie. The code can come in the QR
 * link (`/pair?code=`) or be typed, which also works inside an iPhone home-screen app (its own cookie jar).
 */
export const dynamic = "force-dynamic";

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(code: string, error = "") {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pair this phone · Chief</title><meta name="color-scheme" content="dark">
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#09090b;color:#ededef;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:20px;box-sizing:border-box}
main{width:100%;max-width:360px;background:#151518;border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:28px 24px}
h1{font-size:20px;font-weight:600;margin:0 0 6px}p{margin:0 0 18px;color:#a1a1aa;font-size:14px}
label{display:block;font-size:13px;color:#a1a1aa;margin-bottom:6px}
input{width:100%;box-sizing:border-box;font:600 22px/1 ui-monospace,"Cascadia Mono",monospace;letter-spacing:.18em;text-align:center;padding:14px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:#09090b;color:#ededef}
button{margin-top:14px;width:100%;min-height:46px;border:0;border-radius:999px;background:#ededef;color:#09090b;font:600 15px system-ui,sans-serif}
.err{color:#ff6369;font-size:14px;margin:12px 0 0}
</style></head><body><main>
<h1>Pair this phone</h1>
<p>On your PC, open Chief, then Settings, Phone, and choose Pair a phone. Enter the code it shows.</p>
<form method="post" action="/pair">
<label for="code">Code from the PC</label>
<input id="code" name="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="12" placeholder="ABCD-EFGH" value="${escape(code)}" required>
<button type="submit">Pair</button>
${error ? `<p class="err" role="alert">${escape(error)}</p>` : ""}
</form></main></body></html>`;
  return new NextResponse(body, { status: error ? 400 : 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export function GET(req: NextRequest) {
  return page((req.nextUrl.searchParams.get("code") || "").slice(0, 12));
}

export async function POST(req: NextRequest) {
  if (!validMutationOrigin(req.headers, req.url)) return page("", "That didn't come from this page. Open it again and try once more.");
  const form = await req.formData().catch(() => null);
  const code = String(form?.get("code") || "").slice(0, 32);
  const result = redeemPairingCode(code, req.headers.get("user-agent") || "");
  if (!result.ok) return page(code, result.error);
  const res = NextResponse.redirect(new URL("/", `https://${req.headers.get("host")}`), 303);
  res.cookies.set(DEVICE_COOKIE, result.cookie, { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 400 * 24 * 3600 });
  return res;
}
