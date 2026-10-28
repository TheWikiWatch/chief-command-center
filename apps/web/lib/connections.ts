"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { requestJson, friendlyError } from "@/lib/request";

/*
 * Connections (bridge contract `chief.connections.v1`, connections.py): email, calendars, documents and work tools
 * the bots can use. Settings → Connections and the chat's Connect card share this client and its sign-in flow.
 *
 * Backends: `quick` (Nous Connectors: one Nous sign-in, then the service's own page; works from any device),
 * `local` (Google on this PC: the sign-in finishes in a browser on the PC) and `mcp` (Hermes's catalog: the service's
 * own sign-in, also finished on the PC).
 */

export type Backend = "quick" | "local" | "mcp";
export type ServiceState = "connected" | "not_connected" | "reconnect";

/** One quick account of a service: `name` is what bots pick it by (unnamed until renamed); `default` is the one used without a name. */
export type ServiceAccount = { id: string; name: string | null; label: string; status: string; default: boolean };

export type ConnectionService = {
  id: string;
  label: string;
  group: "mail" | "work";
  blurb: string;
  state: ServiceState;
  via: Backend | null;
  account: string | null;
  accounts: ServiceAccount[];
  backends: Backend[];
  needsNous: boolean;
  category?: string;
};

export type ConnectionsView = {
  ok: boolean;
  error?: string;
  warning?: string;
  nous: { signedIn: boolean; guest: boolean; account: string | null; connectors: boolean };
  local: { available: boolean; account: string | null };
  services: ConnectionService[];
  featured: string[];
};

export type KeyNeed = { name: string; prompt: string; secret: boolean };
type ConnectStart = { ok: boolean; error?: string; op?: string; url?: string; backend?: Backend; finishOnPc?: boolean; needs?: KeyNeed[]; state?: "connected" };
type OpStatus = { ok: boolean; error?: string; status: "pending" | "connected" | "failed"; service: string };
export type NousStart = { ok: boolean; error?: string; session: string; code: string; url: string; expiresIn: number };
/** A finished sign-in (Hermes 0.22.5) also says who signed in, what moved over from the free guest (Hermes's own
 * lines: apps moved, apps to connect again), and the chief's new model when Hermes moved it off the free one. */
export type NousResult = { account?: string | null; handoff?: string[]; model?: string };
type NousPoll = { ok: boolean; error?: string; status: "pending" | "approved" | "denied" | "expired" | "error" | "cancelled" } & NousResult;

const PREFIX = "/api/bridge/connections";
const get = <T,>(path: string, timeout = 30_000) => requestJson<T>(`${PREFIX}${path}`, { cache: "no-store" }, timeout);
const post = <T,>(path: string, body: unknown, timeout = 30_000) =>
  requestJson<T>(`${PREFIX}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, timeout);

function must<T extends { ok: boolean; error?: string }>(data: T, fallback: string): T {
  if (!data.ok) throw new Error(data.error || fallback);
  return data;
}

export const fetchConnections = async (refresh = false) => must(await get<ConnectionsView>(refresh ? "?refresh=1" : ""), "Couldn't read your connections");
/** Quick only: `name` connects another account under that name; `account` signs that account in again. */
export type AccountChoice = { name?: string; account?: string };
export const startConnect = async (service: string, backend?: Backend, env?: Record<string, string>, choice?: AccountChoice) =>
  must(
    await post<ConnectStart>("/connect", { service, backend: backend || "", ...(env ? { env } : {}), ...(choice?.name ? { name: choice.name } : {}), ...(choice?.account ? { account: choice.account } : {}) }, 80_000),
    "Couldn't start that connection",
  );
export const connectStatus = async (op: string) => must(await get<OpStatus>(`/op/${encodeURIComponent(op)}`), "Couldn't check the sign-in");
export const cancelConnect = (op: string) => post<{ ok: boolean }>("/cancel", { op }).catch(() => undefined);
export const disconnectService = async (service: string) => must(await post<{ ok: boolean; error?: string; also?: string[] }>("/disconnect", { service }), "Couldn't disconnect");
export const renameAccount = async (service: string, account: string, name: string) =>
  must(await post<{ ok: boolean; error?: string; name?: string }>("/account/rename", { service, account, name }), "Couldn't rename that account");
export const removeAccount = async (service: string, account: string) =>
  must(await post<{ ok: boolean; error?: string }>("/account/remove", { service, account }), "Couldn't disconnect that account");
/** What an account is called on the page: its name, else the sign-in's own label (usually the address). */
export const accountTitle = (a: ServiceAccount) => a.name || a.label || "Account";
/** The form Nous takes for an account name (1-32 lowercase letters, digits or dashes), or "" when it can't be one. */
export function accountName(text: string): string {
  const name = text.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(name) ? name : "";
}
export const startNousSignIn = async () => must(await post<NousStart>("/nous/start", {}, 45_000), "Couldn't start the Nous sign-in");
export const pollNousSignIn = async (session: string) => must(await get<NousPoll>(`/nous/${encodeURIComponent(session)}`), "Couldn't check the Nous sign-in");
export const cancelNousSignIn = (session: string) => post<{ ok: boolean }>("/nous/cancel", { session }).catch(() => undefined);
export const signOutNous = async () => must(await post<{ ok: boolean; error?: string }>("/nous/signout", {}), "Couldn't sign out");

/** This browser runs on the PC (the desktop app, or a browser on it): a loopback sign-in can finish here. */
export const onThisPc = () => typeof window !== "undefined" && /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(window.location.hostname);

export const BACKEND_LABEL: Record<Backend, string> = { quick: "Quick", local: "On this PC", mcp: "Direct" };

/** Open a sign-in page. The desktop app sends it to the system browser; a blocked popup leaves the card's link. */
/**
 * A sign-in address the bridge handed back, if it's one to open: https only, with no user name or password in it.
 * Anything else (a `javascript:` or `file:` link, a plain-http page) is never opened or linked.
 */
export function signInUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && !u.password ? u.href : "";
  } catch {
    return "";
  }
}

export function openSignIn(url: string): boolean {
  const safe = signInUrl(url);
  if (!safe) return false;
  try {
    return !!window.open(safe, "_blank", "noopener,noreferrer");
  } catch {
    return false;
  }
}

export type FlowState =
  | { step: "idle" }
  | { step: "starting"; backend?: Backend }
  | { step: "keys"; backend: Backend; needs: KeyNeed[] }
  | { step: "waiting"; op: string; url: string; backend: Backend; finishOnPc: boolean }
  | { step: "pc-only"; backend: Backend }
  | { step: "done" }
  | { step: "failed"; error: string };

const POLL_MS = 1500;

/**
 * One service's connect flow: start (open the sign-in page), wait while the person signs in, then done. Polls the
 * bridge's operation; cancelling or unmounting stops the poll (and cancels a sign-in nobody finished).
 */
export function useConnectFlow(service: string, onDone?: () => void) {
  const [flow, setFlow] = useState<FlowState>({ step: "idle" });
  const opRef = useRef("");
  const doneRef = useRef(onDone);
  useEffect(() => {
    doneRef.current = onDone;
  });

  useEffect(() => {
    if (flow.step !== "waiting") return;
    let live = true;
    const timer = window.setInterval(() => {
      connectStatus(flow.op)
        .then((s) => {
          if (!live) return;
          if (s.status === "connected") {
            opRef.current = "";
            setFlow({ step: "done" });
            doneRef.current?.();
          } else if (s.status === "failed") {
            opRef.current = "";
            setFlow({ step: "failed", error: s.error || "The sign-in didn't finish." });
          }
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [flow]);

  // A sign-in left open when the card or row goes away is cancelled (its loopback receiver stops waiting).
  useEffect(
    () => () => {
      if (opRef.current) void cancelConnect(opRef.current);
    },
    [],
  );

  const start = useCallback(
    async (backend?: Backend, env?: Record<string, string>, choice?: AccountChoice) => {
      if ((backend === "local" || backend === "mcp") && !onThisPc()) {
        setFlow({ step: "pc-only", backend });
        return;
      }
      setFlow({ step: "starting", backend });
      try {
        const res = await startConnect(service, backend, env, choice);
        if (res.needs?.length) return setFlow({ step: "keys", backend: backend || "mcp", needs: res.needs });
        if (res.state === "connected" || !res.op || !res.url) {
          setFlow({ step: "done" });
          doneRef.current?.();
          return;
        }
        opRef.current = res.op;
        const used = res.backend || backend || "quick";
        if (res.finishOnPc && !onThisPc()) {
          void cancelConnect(res.op);
          opRef.current = "";
          return setFlow({ step: "pc-only", backend: used });
        }
        openSignIn(res.url);
        setFlow({ step: "waiting", op: res.op, url: res.url, backend: used, finishOnPc: !!res.finishOnPc });
      } catch (err) {
        setFlow({ step: "failed", error: friendlyError(err, "Couldn't start that connection") });
      }
    },
    [service],
  );

  const cancel = useCallback(() => {
    if (opRef.current) void cancelConnect(opRef.current);
    opRef.current = "";
    setFlow({ step: "idle" });
  }, []);

  return { flow, start, cancel, reset: () => setFlow({ step: "idle" }) };
}
