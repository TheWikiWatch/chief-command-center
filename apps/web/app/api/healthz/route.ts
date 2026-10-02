// The desktop app's readiness probe: answers as soon as the server runs, without calling the gateway (a hung
// gateway must not make the dashboard look down) and without the session cookie (lib/loopback-session.ts).
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
