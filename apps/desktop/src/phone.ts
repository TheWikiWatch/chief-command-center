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
  const recorded = ctx.store.value.phoneServe;
  const port = wanted ?? (state.moved && recorded ? recorded.port : choosePort(state.serve));
  if (port === null) return { ok: false, error: "Every port Tailscale Serve can use (443, 8443, 10000) is taken by something else on this PC." };
  const taken = state.serve.find((e) => e.port === port && !e.ours && !(state.moved && recorded?.port === port));
  if (taken) return { ok: false, error: `Port ${port} already serves ${taken.target}. Choose another port.` };
  const result = await enableServe(exe, port, ctx.store.value.ports.ui);
  if (!result.ok) return result;
  ctx.store.save({ phoneServe: { port, uiPort: ctx.store.value.ports.ui } });
  // Turning it on for the first time: only the owner's own Tailscale account, unless they widened it before.
  if (!ctx.store.value.webEnv[ALLOW_ENV] && state.login && !recorded) await setPhoneAccess("owner", state.login);
  return { ok: true, url: phoneUrl(state.dnsName, port) };
}

export async function disablePhone() {
  const exe = findTailscale();
  const state = await phoneState();
  const ours = state.serve.find((e) => e.ours);
  if (!exe || !ours) {
    ctx.store.save({ phoneServe: null });
    return { ok: true };
  }
  const result = await disableServe(exe, ours.port, ctx.store.value.ports.ui);
  if (result.ok) ctx.store.save({ phoneServe: null });
  return result;
}

/** Links the Phone page may open: Tailscale's own pages (downloads, admin, consent) and the phone app stores. */
export const OPENABLE = /^https:\/\/((login\.|www\.)?tailscale\.com|apps\.apple\.com|play\.google\.com)\//;
