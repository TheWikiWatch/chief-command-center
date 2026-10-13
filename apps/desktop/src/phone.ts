import { choosePort, disableServe, enableServe, findTailscale, phoneUrl, readState } from "./tailscale";
import { ctx } from "./state";

/* Phone access: Tailscale Serve in front of the dashboard (Settings → Phone). */

const ALLOW_ENV = "CHIEF_DASHBOARD_TAILSCALE_USER";

/** Tailscale's state for Settings → Phone, with the app's own view of it. The login is the owner's own, shown only on this PC. */
export async function phoneState() {
  const ui = ctx.store.value.ports.ui;
  const ts = await readState(ui);
  const ours = ts.serve.find((e) => e.ours);
  const recorded = ctx.store.value.phoneServe;
  // The dashboard moved to another port (3000 was busy at start): Serve still points at the old one.
  const moved = !ours && !!recorded && recorded.uiPort !== ui && ts.serve.some((e) => e.port === recorded.port && e.target.endsWith(`:${recorded.uiPort}`));
  const allow = String(ctx.store.value.webEnv[ALLOW_ENV] || "").trim();
  return {
    ...ts,
    uiPort: ui,
    url: ours ? phoneUrl(ts.dnsName, ours.port) : "",
    port: ours?.port ?? (moved ? recorded!.port : choosePort(ts.serve)),
    moved,
    access: allow ? ("owner" as const) : ("tailnet" as const),
    allowed: allow,
  };
}

/**
 * An older record (before phone requests were pinned to this PC's Tailscale name) learns the name before the
 * dashboard starts, so phones keep working. Best effort: without it, phone requests are refused until Settings →
 * Phone is opened, never let through.
 *
 * A Serve entry for the dashboard made outside the app (by hand, before the app managed phone access) has no record
 * at all: it is adopted here, so the dashboard accepts phones through it instead of refusing them.
 */
export async function ensurePhoneHost() {
  const rec = ctx.store.value.phoneServe;
  if (rec?.host) return;
  try {
    const ui = ctx.store.value.ports.ui;
    const ts = await readState(ui);
    if (!ts.dnsName) return;
    if (rec) ctx.store.save({ phoneServe: { ...rec, host: ts.dnsName.toLowerCase() } });
    else {
      const ours = ts.serve.find((e) => e.ours);
      if (ours) ctx.store.save({ phoneServe: { port: ours.port, uiPort: ui, host: ts.dnsName.toLowerCase() } });
    }
  } catch {
    /* Tailscale not answering: try again at the next start */
  }
}

/** Restart only the dashboard server so it reads a new allow-list (the window keeps its page). */
async function restartWeb() {
  await ctx.web.stop(true).catch(() => undefined);
  await ctx.web.start();
}

export async function setPhoneAccess(mode: "owner" | "tailnet", login?: string) {
  const webEnv = { ...ctx.store.value.webEnv };
  if (mode === "owner") {
    const who = (login || (await readState(ctx.store.value.ports.ui)).login).trim();
    if (!who) return { ok: false, error: "Tailscale didn't say which account owns this PC. Check that it's signed in." };
    webEnv[ALLOW_ENV] = who;
  } else delete webEnv[ALLOW_ENV];
  ctx.store.save({ webEnv });
  await restartWeb();
  return { ok: true };
}

export async function enablePhone(wanted?: number) {
  const exe = findTailscale();
  if (!exe) return { ok: false, error: "Tailscale isn't installed on this PC." };
  const state = await phoneState();
  if (state.backend !== "Running") return { ok: false, error: "Tailscale isn't running and signed in on this PC." };
  // Without the owner's login there is no account to limit phone access to.
  if (!state.login) return { ok: false, error: "Sign in to Tailscale on this PC first (open the Tailscale app, then Log in)." };
  const recorded = ctx.store.value.phoneServe;
  const port = wanted ?? (state.moved && recorded ? recorded.port : choosePort(state.serve));
  if (port === null) return { ok: false, error: "Every port Tailscale Serve can use (443, 8443, 10000) is taken by something else on this PC." };
  const taken = state.serve.find((e) => e.port === port && !e.ours && !(state.moved && recorded?.port === port));
  if (taken) return { ok: false, error: `Port ${port} already serves ${taken.target}. Choose another port.` };
  const result = await enableServe(exe, port, ctx.store.value.ports.ui);
  if (!result.ok) return result;
  ctx.store.save({ phoneServe: { port, uiPort: ctx.store.value.ports.ui, host: state.dnsName.toLowerCase() } });
  // Turning it on for the first time: only the owner's own Tailscale account, unless they widened it before.
  // Either way the dashboard restarts, so it accepts phone requests for this PC's name from now on.
  if (!ctx.store.value.webEnv[ALLOW_ENV] && state.login && !recorded) await setPhoneAccess("owner", state.login);
  else await restartWeb();
  return { ok: true, url: phoneUrl(state.dnsName, port) };
}

export async function disablePhone() {
  const exe = findTailscale();
  const state = await phoneState();
  const ours = state.serve.find((e) => e.ours);
  if (!exe || !ours) {
    ctx.store.save({ phoneServe: null });
    await restartWeb();
    return { ok: true };
  }
  const result = await disableServe(exe, ours.port, ctx.store.value.ports.ui);
  if (result.ok) {
    ctx.store.save({ phoneServe: null });
    // The dashboard stops accepting phone requests at once, not at the next start.
    await restartWeb();
  }
  return result;
}

/**
 * Quitting: the Serve entry goes with the dashboard, so while the app is closed nothing else on this PC can take the
 * dashboard's port and receive what phones send. The setting stays; `resumeServe` puts the entry back at the next start.
 * Best effort, and never more than a few seconds.
 */
export async function pauseServe(): Promise<void> {
  const rec = ctx.store.value.phoneServe;
  const exe = findTailscale();
  if (!rec || !exe) return;
  await Promise.race([disableServe(exe, rec.port, rec.uiPort).catch(() => undefined), new Promise((r) => setTimeout(r, 5000))]);
}

/** Once the dashboard answers: phone access back on, pointing at the port the dashboard has now. */
export async function resumeServe(): Promise<void> {
  const rec = ctx.store.value.phoneServe;
  const exe = findTailscale();
  if (!rec || !exe) return;
  const ui = ctx.store.value.ports.ui;
  try {
    const ts = await readState(ui);
    if (ts.backend !== "Running" || ts.serve.some((e) => e.ours)) return;
    // Another program's entry on that port is left alone (Settings → Phone then offers another port).
    if (ts.serve.some((e) => e.port === rec.port && !e.target.endsWith(`:${rec.uiPort}`))) return;
    const res = await enableServe(exe, rec.port, ui);
    if (res.ok) ctx.store.save({ phoneServe: { ...rec, uiPort: ui } });
  } catch {
    /* Tailscale not answering: Settings → Phone shows it off, and turning it on again works */
  }
}

/** Links the Phone page may open: Tailscale's own pages (downloads, admin, consent) and the phone app stores. */
export const OPENABLE = /^https:\/\/((login\.|www\.)?tailscale\.com|apps\.apple\.com|play\.google\.com)\//;
