// Read-only UI capture via headless Edge + CDP. No dependencies (Node 22 WebSocket).
// Every write endpoint is blocked inside the browser, so nothing reaches Nova or the vault.
// Usage: node docs/visual-overhaul/capture-ui.mjs <outDir> [scenarioRegex]
// Needs the dashboard running on 127.0.0.1:3000. Output contains real chat content: keep it untracked.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const OUT = process.argv[2];
const FILTER = process.argv[3] || "";
const ORIGIN = process.env.CAPTURE_ORIGIN || "http://127.0.0.1:3000";
const PORT = 9337;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = path.join(tmpdir(), "chief-capture-profile");
mkdirSync(OUT, { recursive: true });

const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };
const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };

const WRITES = /\/api\/(bridge\/(send|approve|transcribe|speak|settings|push\/subscribe)|ops\/(launch|settings))/;
const json = (o) => ({ status: 200, body: JSON.stringify(o) });
const MOCK_APPROVAL = { ok: true, approval: { requestId: "capture-1", command: "git push --force origin main", reason: "Dangerous command: force push rewrites remote history", patternKey: "git-force", allowSession: true, allowPermanent: true }, approvals: [] };
const EMPTY_TRANSCRIPT = { ok: true, sessionKey: "agent:main:command_center:dm:owner", lastId: 0, messages: [], generating: false };
const DOWN = "fail";
// Fleet churn fixtures: after the third snapshot a synthetic bot appears (or one disappears). Headless only.
const IVY = { id: "ivy-capture", name: "Ivy - Research Assistant", title: "Ivy", description: "Synthetic bot for the capture gallery", section: "", shape: "", color: "", imageKind: "", custom: false, avatarUrl: null, model: "", provider: "", flavor: "", isChief: false, ring: "working", jobTitle: "Scan the new vendor list" };
const mintAfter = (b, n) => (n >= 3 && Array.isArray(b.roster) ? { ...b, roster: [...b.roster, IVY] } : b);
const retireAfter = (b, n) => (n >= 3 && Array.isArray(b.roster) ? { ...b, roster: b.roster.filter((p, i) => p.isChief || i !== 1) } : b);
// A long synthetic reply from Nova that lands on the Nth transcript poll (scroll-follow checks).
const LONG_REPLY = Array.from({ length: 14 }, (_, i) => `Line ${i + 1} of a long synthetic reply, written so it is taller than the phone screen.`).join("\n\n");
const replyAt = (at) => (b, n) => {
  if (n < at || !b || !Array.isArray(b.messages)) return b;
  const id = (b.lastId || 0) + 100000;
  return { ...b, lastId: id, generating: false, messages: [...b.messages, { id, role: "assistant", content: LONG_REPLY, timestamp: new Date().toISOString() }] };
};
const vaultRow = (name) => `[...document.querySelectorAll('button')].find(b => b.querySelector('span span')?.textContent === ${JSON.stringify(name)})`;
const replyWith = (at, text) => (b, n) => {
  if (n < at || !b || !Array.isArray(b.messages)) return b;
  const id = (b.lastId || 0) + 100000;
  return { ...b, lastId: id, generating: false, messages: [...b.messages, { id, role: "assistant", content: text, timestamp: new Date().toISOString() }] };
};
// The last specialist in the roster (and the first) is working: the phone orbit must still seat both.
const lastWorking = (b) => {
  if (!b || !Array.isArray(b.roster)) return b;
  const bots = b.roster.filter((p) => !p.isChief);
  const pick = new Set([bots[0]?.id, bots[bots.length - 1]?.id]);
  return { ...b, roster: b.roster.map((p) => (pick.has(p.id) ? { ...p, ring: "working", jobTitle: p.id === bots[0]?.id ? "ShortsStudio: cut list" : "Draft the expo tallies" } : p)) };
};
const SEAT_POS = `[...document.querySelectorAll('[data-orbit-seat] button')].slice(0, 4).map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y)]; })`;
const SCROLLER = `document.querySelector('.chief-chat .overflow-y-auto')`;
const FROM_BOTTOM = `(() => { const el = ${SCROLLER}; return { fromBottom: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight), pill: !!document.querySelector('.chief-chat button.glass') }; })()`;
const LAST_CHIEF = JSON.stringify({ id: "chief", name: "Nova - Chief of Staff", shape: "blobatar::hexagon", color: "hsl(0 68% 58%)", isChief: true, custom: true, imageKind: "shape", avatarUrl: null, ring: "idle" });

const click = (expr) => `(() => { const el = ${expr}; if (el) { el.click(); return true } return false })()`;
const byText = (t) => `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(t)})`;
const byLabel = (t) => `document.querySelector('[aria-label=${JSON.stringify(t)}]')`;
const railRow = (i) => `document.querySelectorAll('ul li > button')[${i}]`;
const orbitSeat = (i) => `[...document.querySelectorAll('button')].filter(b => b.querySelector('.orbit-bot-name'))[${i}]`;
const firstTask = `document.querySelector('ol button')`;
const firstArea = `document.querySelector('[data-area]')`;

const scenarios = [
  // Phone
  { name: "phone-chat", vp: PHONE, ls: { "chief-phone-tab": "chat" } },
  { name: "phone-chat-top", vp: PHONE, ls: { "chief-phone-tab": "chat" }, js: [`(() => { const s=[...document.querySelectorAll('.overflow-auto')].find(e=>e.closest('.chief-chat')); if (s) s.scrollTop = 0; })()`] },
  { name: "phone-chat-compact", vp: PHONE, ls: { "chief-phone-tab": "chat", "chief-chat-compact": "1" } },
  { name: "phone-chat-empty", vp: PHONE, ls: { "chief-phone-tab": "chat" }, mock: { "/api/bridge/transcript": json(EMPTY_TRANSCRIPT) } },
  { name: "phone-chat-thinking", vp: PHONE, ls: { "chief-phone-tab": "chat" }, patch: { "/api/bridge/transcript": (b) => ({ ...b, generating: true }) } },
  { name: "phone-chat-approval", vp: PHONE, ls: { "chief-phone-tab": "chat" }, mock: { "/api/bridge/approvals": json(MOCK_APPROVAL) } },
  { name: "phone-chat-approval-armed", vp: PHONE, ls: { "chief-phone-tab": "chat" }, mock: { "/api/bridge/approvals": json(MOCK_APPROVAL) }, js: [click(byText("Always allow"))], settle: 600 },
  { name: "phone-today-with-approval-banner", vp: PHONE, ls: { "chief-phone-tab": "today" }, mock: { "/api/bridge/approvals": json(MOCK_APPROVAL) } },
  { name: "phone-chat-emoji", vp: PHONE, ls: { "chief-phone-tab": "chat" }, js: [click(byLabel("Add attachment or emoji")), click(byLabel("Insert emoji"))], settle: 600 },
  { name: "phone-chat-plus-menu", vp: PHONE, ls: { "chief-phone-tab": "chat" }, js: [click(byLabel("Add attachment or emoji"))], settle: 600 },
  { name: "phone-chat-recording", vp: PHONE, ls: { "chief-phone-tab": "chat" }, hold: '[aria-label="Hold to talk"]', settle: 1800 },
  { name: "phone-chat-gateway-down", vp: PHONE, ls: { "chief-phone-tab": "chat", "chief-last-known": LAST_CHIEF }, mock: { "/api/bridge/": DOWN }, wait: 16000 },
  { name: "phone-today", vp: PHONE, ls: { "chief-phone-tab": "today" } },
  { name: "phone-today-intent", vp: PHONE, ls: { "chief-phone-tab": "today" }, js: [click(firstTask)], settle: 800 },
  { name: "phone-today-area", vp: PHONE, ls: { "chief-phone-tab": "today" }, js: [click(firstArea)], settle: 800 },
  { name: "phone-today-ops-down", vp: PHONE, ls: { "chief-phone-tab": "today" }, mock: { "/api/ops/": DOWN }, wait: 9000 },
  { name: "phone-fleet", vp: PHONE, ls: { "chief-phone-tab": "fleet" } },
  { name: "phone-fleet-mint", vp: PHONE, ls: { "chief-phone-tab": "fleet" }, patch: { "/api/bridge/snapshot": mintAfter }, wait: 9200 },
  { name: "phone-fleet-look", vp: PHONE, ls: { "chief-phone-tab": "fleet" }, js: [click(railRow(0))], settle: 1500 },
  { name: "phone-settings", vp: PHONE, ls: { "chief-phone-tab": "chat" }, js: [click(`document.querySelector('[aria-label="Settings"]')`)], settle: 2500 },
  { name: "phone-settings-sound", vp: PHONE, ls: { "chief-phone-tab": "chat" }, js: [click(`document.querySelector('[aria-label="Settings"]')`), `setTimeout(() => [...document.querySelectorAll('h3')].find(h => h.textContent === "Sound")?.scrollIntoView({ block: "start" }), 900)`], settle: 2500 },
  { name: "phone-voice", vp: PHONE, ls: { "chief-phone-tab": "chat" }, js: [click(byLabel("Voice mode"))], settle: 1500 },
  { name: "phone-voice-thinking", vp: PHONE, ls: { "chief-phone-tab": "chat" }, patch: { "/api/bridge/transcript": (b) => ({ ...b, generating: true }) }, js: [click(byLabel("Voice mode"))], settle: 1500 },
  { name: "phone-voice-recording", vp: PHONE, ls: { "chief-phone-tab": "chat" }, js: [click(byLabel("Voice mode"))], hold: '[role=dialog] [aria-label="Hold to talk"]', settle: 1800 },
  { name: "phone-status-voicelog", vp: PHONE, ls: { "chief-phone-tab": "chat", "chief-speech-log": "[{\"at\": 1790172479623, \"preview\": \"Third step done \\u2014 and this one makes the tool honest about printing.\", \"parts\": 4, \"firstSoundMs\": 1900, \"outcome\": \"played\", \"hidden\": false, \"metered\": true}, {\"at\": 1790171939623, \"preview\": \"Crash notice \\u2014 triaged and contained.\", \"parts\": 3, \"outcome\": \"missed\", \"reason\": \"Missed while away\", \"hidden\": true, \"metered\": false}, {\"at\": 1790171639623, \"preview\": \"Second build step done.\", \"parts\": 5, \"firstSoundMs\": 21000, \"outcome\": \"stalled\", \"reason\": \"Playback stalled\", \"hidden\": false, \"metered\": true}]" }, js: [`document.querySelector('[aria-label^="Connection"]').click(); true`, `document.querySelector('[role=dialog] h3')?.closest(".overflow-y-auto, [class*=overflow]")?.scrollBy(0, 400); true`], settle: 1200 },
  { name: "phone-chat-followups", vp: PHONE, ls: { "chief-phone-tab": "chat", "chief-followups": "[{\"id\": \"finished:ada:x\", \"kind\": \"finished\", \"who\": \"Ada\", \"whoId\": \"ada\", \"title\": \"Print studio: validate extensions + PrintProfile warnings\", \"createdAt\": 1790172718664, \"dueAt\": 1790172898664, \"afterId\": 99999999999, \"shown\": true}, {\"id\": \"promise:1\", \"kind\": \"promise\", \"title\": \"I'll check back once Iris lands the postcard proof.\", \"createdAt\": 1790171638664, \"dueAt\": 1790172838664, \"afterId\": 99999999999, \"shown\": true}]" } },
  { name: "phone-vault", vp: PHONE, ls: { "chief-phone-tab": "vault" } },
  { name: "phone-vault-note", vp: PHONE, ls: { "chief-phone-tab": "vault" }, js: [click(vaultRow("index"))], settle: 1800 },
  { name: "phone-vault-search", vp: PHONE, ls: { "chief-phone-tab": "vault" }, js: [`(() => { const i = document.querySelector('input[aria-label="Search the vault"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(i, "launch plan"); i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`], settle: 1500 },
  { name: "phone-chat-vaultlink", vp: PHONE, ls: { "chief-phone-tab": "chat" }, patch: { "/api/bridge/transcript": replyWith(4, "Saved the review to `E:/Second Brain/index.md` and linked [[Concrete Candles]] for context.") }, wait: 12000 },
  { name: "phone-chat-vaultlink-open", vp: PHONE, ls: { "chief-phone-tab": "chat" }, patch: { "/api/bridge/transcript": replyWith(4, "Saved the review to `E:/Second Brain/index.md` and linked [[Concrete Candles]] for context.") }, wait: 12000, js: [click(`[...document.querySelectorAll('.chief-chat a[href^="#vault="]')].pop()`)], settle: 2000 },
  { name: "desktop-vault", vp: DESKTOP, ls: { "chief-surface": "vault", "chief-split": "60" } },
  { name: "desktop-vault-note", vp: DESKTOP, ls: { "chief-surface": "vault", "chief-split": "60" }, js: [click(vaultRow("index"))], settle: 1800 },
  { name: "phone-status", vp: PHONE, ls: { "chief-phone-tab": "chat" }, js: [click(`document.querySelector('[aria-label^="Connection"]')`)], settle: 1200 },
  // Desktop
  { name: "desktop-today-chat", vp: DESKTOP, ls: { "chief-surface": "today", "chief-split": "60" } },
  { name: "desktop-fleet-orbit", vp: DESKTOP, ls: { "chief-surface": "fleet", "chief-split": "60" }, wait: 9000 },
  { name: "desktop-fleet-mint", vp: DESKTOP, ls: { "chief-surface": "fleet", "chief-split": "60" }, patch: { "/api/bridge/snapshot": mintAfter }, wait: 8600 },
  { name: "desktop-fleet-retire", vp: DESKTOP, ls: { "chief-surface": "fleet", "chief-split": "60" }, patch: { "/api/bridge/snapshot": retireAfter }, wait: 8300 },
  { name: "desktop-fleet-rail", vp: DESKTOP, ls: { "chief-surface": "fleet", "chief-split": "40" } },
  { name: "desktop-fleet-look", vp: DESKTOP, ls: { "chief-surface": "fleet", "chief-split": "60" }, js: [click(orbitSeat(1))], settle: 1500, wait: 8000 },
  { name: "desktop-thinking-orbit", vp: DESKTOP, ls: { "chief-surface": "fleet", "chief-split": "60" }, patch: { "/api/bridge/transcript": (b) => ({ ...b, generating: true }) }, wait: 9000 },
  { name: "desktop-approval", vp: DESKTOP, ls: { "chief-surface": "today", "chief-split": "60" }, mock: { "/api/bridge/approvals": json(MOCK_APPROVAL) } },
  { name: "desktop-today-intent", vp: DESKTOP, ls: { "chief-surface": "today", "chief-split": "60" }, js: [click(firstTask)], settle: 800 },
  { name: "desktop-today-area", vp: DESKTOP, ls: { "chief-surface": "today", "chief-split": "60" }, js: [click(firstArea)], settle: 800 },
  { name: "desktop-settings", vp: DESKTOP, ls: { "chief-surface": "today", "chief-split": "60" }, js: [click(`document.querySelector('.chief-chat [aria-label="Settings"]')`)], settle: 2500 },
  { name: "desktop-gateway-down", vp: DESKTOP, ls: { "chief-surface": "fleet", "chief-split": "60", "chief-last-known": LAST_CHIEF }, mock: { "/api/bridge/": DOWN, "/api/ops/": DOWN }, wait: 16000 },
  // Scroll-follow checks (PLAN-2026-09-23 §3): print how far from the bottom the thread ends up.
  { name: "chk-follow-bottom", vp: PHONE, ls: { "chief-phone-tab": "chat" }, patch: { "/api/bridge/transcript": replyAt(5) }, js: [`true`], settle: 12000, check: FROM_BOTTOM },
  { name: "chk-follow-reading", vp: PHONE, ls: { "chief-phone-tab": "chat" }, patch: { "/api/bridge/transcript": replyAt(5) }, js: [`(() => { const el = ${SCROLLER}; let n = 0; const t = setInterval(() => { el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -250 })); el.scrollTop -= 250; if (++n > 14) clearInterval(t); }, 1500); return true; })()`], settle: 12000, check: FROM_BOTTOM },
  { name: "chk-follow-idle", vp: PHONE, ls: { "chief-phone-tab": "chat" }, patch: { "/api/bridge/transcript": replyAt(9) }, js: [`(() => { const el = ${SCROLLER}; el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -900 })); el.scrollTop -= 900; return true; })()`], settle: 18000, check: FROM_BOTTOM },
  { name: "phone-fleet-working-last", vp: PHONE, ls: { "chief-phone-tab": "fleet" }, patch: { "/api/bridge/snapshot": lastWorking }, wait: 9000 },
  { name: "phone-fleet-working-list", vp: PHONE, ls: { "chief-phone-tab": "fleet" }, patch: { "/api/bridge/snapshot": lastWorking }, wait: 9000, js: [`document.getElementById("fleet-list")?.scrollIntoView(); true`], settle: 1200 },
  { name: "desktop-fleet-working", vp: DESKTOP, ls: { "chief-surface": "fleet", "chief-split": "60" }, patch: { "/api/bridge/snapshot": lastWorking }, wait: 9000 },
  { name: "chk-desktop-orbit-moves", vp: DESKTOP, ls: { "chief-surface": "fleet", "chief-split": "60" }, wait: 9000, check: `new Promise((done) => { const a = ${SEAT_POS}; setTimeout(() => done({ before: a, after: ${SEAT_POS} }), 3000); })` },
  { name: "chk-desktop-orbit-hover", vp: DESKTOP, ls: { "chief-surface": "fleet", "chief-split": "60" }, wait: 9000, js: [`(() => { const b = document.querySelector('[data-orbit-seat] button'); b.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })); return true; })()`], settle: 2500, check: `new Promise((done) => { const a = ${SEAT_POS}; setTimeout(() => done({ before: a, after: ${SEAT_POS} }), 3000); })` },
  // Perf probes (§7): 4x CPU throttle approximates a mid-range Android; prints fps, p95 frame and long tasks.
  { name: "perf-phone-chat", vp: PHONE, ls: { "chief-phone-tab": "chat" }, cpu: 4, probe: true },
  { name: "perf-phone-chat-thinking", vp: PHONE, ls: { "chief-phone-tab": "chat" }, cpu: 4, probe: true, patch: { "/api/bridge/transcript": (b) => ({ ...b, generating: true }) } },
  { name: "perf-phone-fleet", vp: PHONE, ls: { "chief-phone-tab": "fleet" }, cpu: 4, probe: true },
  { name: "perf-phone-today", vp: PHONE, ls: { "chief-phone-tab": "today" }, cpu: 4, probe: true },
  { name: "perf-desktop-fleet", vp: DESKTOP, ls: { "chief-surface": "fleet", "chief-split": "60" }, probe: true, wait: 9000 },
].filter((s) => new RegExp(FILTER).test(s.name));

const PROBE = `new Promise((done) => {
  const long = [];
  const po = new PerformanceObserver((l) => l.getEntries().forEach((e) => long.push(Math.round(e.duration))));
  try { po.observe({ type: "longtask" }); } catch {}
  const frames = []; let last = performance.now(); const end = last + 5000;
  const f = (t) => { frames.push(t - last); last = t; if (t < end) requestAnimationFrame(f); else { po.disconnect(); frames.sort((a, b) => a - b);
    done(JSON.stringify({ fps: Math.round(frames.length / 5), p95: Math.round(frames[Math.floor(frames.length * 0.95)]), longTasks: long.length, longest: Math.max(0, ...long), heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null })); } };
  requestAnimationFrame(f);
})`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* stale lock; reuse */ }
  const edge = spawn(EDGE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--headless=new", "--no-first-run", "--disable-extensions", "--mute-audio", "--autoplay-policy=user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "about:blank"], { stdio: "ignore" });
  let target;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(250);
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === "page"); } catch { /* not up yet */ }
  }
  if (!target) throw new Error("Edge did not start");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  await sleep(800); // a fresh headless Edge can reject the first commands while it settles
  let seq = 0;
  const pending = new Map();
  let current = null;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 15000);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.addEventListener("message", async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      return;
    }
    if (msg.method !== "Fetch.requestPaused") return;
    const { requestId, request, responseStatusCode } = msg.params;
    const url = request.url;
    try {
      if (WRITES.test(url) && request.method !== "GET") {
        await send("Fetch.fulfillRequest", { requestId, responseCode: 503, responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from(JSON.stringify({ ok: false, error: "capture mode: writes blocked" })).toString("base64") });
        return;
      }
      const s = current || {};
      const mockKey = Object.keys(s.mock || {}).find((k) => url.includes(k));
      if (mockKey && responseStatusCode === undefined) {
        const m = s.mock[mockKey];
        if (m === DOWN) { await send("Fetch.failRequest", { requestId, errorReason: "ConnectionRefused" }); return; }
        await send("Fetch.fulfillRequest", { requestId, responseCode: m.status, responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from(m.body).toString("base64") });
        return;
      }
      const patchKey = Object.keys(s.patch || {}).find((k) => url.includes(k));
      if (patchKey && responseStatusCode !== undefined) {
        const res = await send("Fetch.getResponseBody", { requestId });
        const text = res.base64Encoded ? Buffer.from(res.body, "base64").toString("utf8") : res.body;
        let out = text;
        s._n = s._n || {};
        s._n[patchKey] = (s._n[patchKey] || 0) + 1;
        try { out = JSON.stringify(s.patch[patchKey](JSON.parse(text), s._n[patchKey])); } catch { /* leave as is */ }
        await send("Fetch.fulfillRequest", { requestId, responseCode: responseStatusCode, responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from(out).toString("base64") });
        return;
      }
      await send("Fetch.continueRequest", { requestId });
    } catch { /* request gone */ }
  });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Fetch.enable", { patterns: [{ urlPattern: "*/api/*", requestStage: "Request" }, { urlPattern: "*/api/bridge/transcript*", requestStage: "Response" }, { urlPattern: "*/api/bridge/snapshot*", requestStage: "Response" }] });

  for (const s of scenarios) {
    try {
    current = s;
    await send("Emulation.setDeviceMetricsOverride", s.vp).catch(async () => { await sleep(1000); return send("Emulation.setDeviceMetricsOverride", s.vp); });
    await send("Emulation.setTouchEmulationEnabled", { enabled: s.vp.mobile, maxTouchPoints: s.vp.mobile ? 5 : 1 });
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
    await send("Emulation.setCPUThrottlingRate", { rate: s.cpu || 1 });
    await send("Page.navigate", { url: `${ORIGIN}/manifest.webmanifest` });
    await sleep(400);
    const ls = { "chief-speak-replies": "0", "chief-chat-compact": "0", ...s.ls };
    await send("Runtime.evaluate", { expression: `localStorage.clear(); ${Object.entries(ls).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)})`).join(";")}` });
    await send("Page.navigate", { url: `${ORIGIN}/` });
    await sleep(s.wait ?? 7000);
    for (const js of s.js || []) {
      const r = await send("Runtime.evaluate", { expression: js, returnByValue: true });
      if (r?.result?.value === false) console.log(`  ! ${s.name}: action target not found`);
      await sleep(s.settle ?? 800);
    }
    let held = null;
    if (s.hold) {
      const r = await send("Runtime.evaluate", { expression: `(() => { const el = document.querySelector(${JSON.stringify(s.hold)}); if (!el) return null; const b = el.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()`, returnByValue: true });
      held = r?.result?.value;
      if (held) {
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: held[0], y: held[1] });
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x: held[0], y: held[1], button: "left", buttons: 1, clickCount: 1 });
        await sleep(s.settle ?? 1500);
      } else console.log(`  ! ${s.name}: hold target not found`);
    }
    if (s.check) {
      const r = await send("Runtime.evaluate", { expression: s.check, returnByValue: true, awaitPromise: true });
      console.log(`check ${s.name} ${JSON.stringify(r?.result?.value)}`);
      continue;
    }
    if (s.probe) {
      const r = await send("Runtime.evaluate", { expression: PROBE, awaitPromise: true, returnByValue: true });
      console.log(`perf ${s.name} ${r?.result?.value}`);
      continue;
    }
    const shot = await send("Page.captureScreenshot", { format: "png" });
    if (held) {
      // Slide far away first so the recording cancels, then release (sends are blocked anyway).
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: held[0] - 200, y: held[1] - 200, buttons: 1 });
      await sleep(200);
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: held[0] - 200, y: held[1] - 200, button: "left", buttons: 0, clickCount: 1 });
    }
    writeFileSync(path.join(OUT, `${s.name}.png`), Buffer.from(shot.data, "base64"));
    console.log(`captured ${s.name}`);
    } catch (e) { console.log(`  x ${s.name}: ${e.message}`); }
  }
  ws.close();
  spawnSync("taskkill", ["/PID", String(edge.pid), "/T", "/F"], { stdio: "ignore" });
  // Edge children detach from the launcher; stop every process using this capture profile only.
  spawnSync("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -match 'chief-capture-profile' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"], { stdio: "ignore" });
}

main().catch((e) => { console.error(e); process.exit(1); });
