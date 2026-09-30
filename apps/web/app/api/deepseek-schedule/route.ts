import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SOURCE = "https://api-docs.deepseek.com/quick_start/pricing";
const DAY_MS = 24 * 60 * 60 * 1000;
/** After a failed check, keep the last answer and try again in an hour (not on every request). */
const RETRY_MS = 60 * 60 * 1000;

type ScheduleStatus = "match" | "changed" | "unverified";
type Cache = { checkedAt: number; status: ScheduleStatus; detail: string };

let cache: Cache | null = null;
let nextCheck = 0;
let checking: Promise<void> | null = null;

function json(body: Cache) {
  return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
}

async function check() {
  try {
    const res = await fetch(SOURCE, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    const html = await res.text();
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    if (!res.ok) throw new Error(`pricing page ${res.status}`);
    const windows = /01:00\s*[-–—]\s*04:00/.test(text) && /06:00\s*[-–—]\s*10:00/.test(text);
    const weekdays = /monday through friday/i.test(text);
    const holidays = /holiday/i.test(text);
    if (windows && weekdays && holidays) {
      cache = { checkedAt: Date.now(), status: "match", detail: "Official peak windows still match." };
    } else if (!windows) {
      cache = {
        checkedAt: Date.now(),
        status: "changed",
        detail: "DeepSeek's pricing page no longer lists 01:00–04:00 and 06:00–10:00 UTC.",
      };
    } else {
      cache = { checkedAt: Date.now(), status: "unverified", detail: "Could not confirm the full schedule wording." };
    }
    nextCheck = Date.now() + DAY_MS;
  } catch {
    if (!cache) {
      cache = { checkedAt: Date.now(), status: "unverified", detail: "Could not reach DeepSeek's pricing page." };
    }
    nextCheck = Date.now() + RETRY_MS;
  }
}

/** Compare the published peak windows to the rule baked into the dashboard. */
export async function GET() {
  if (!cache || Date.now() >= nextCheck) {
    // Concurrent requests share one fetch.
    checking ??= check().finally(() => {
      checking = null;
    });
    await checking;
  }
  return json(cache as Cache);
}
