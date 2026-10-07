import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ConnectCards, forgetConnectCardServices } from "@/components/chat/connect-card";
import { ConnectionsPage } from "@/components/settings/connections";
import type { ConnectionService, ConnectionsView } from "@/lib/connections";
import { mailAction } from "@/lib/mail-approval";

/* Settings → Connections, the chat's Connect card and the mail approval sheet's reading of the mail guard's reason.
   The bridge is a fake: every call is recorded, and sign-ins finish when the test says so. */

const svc = (id: string, label: string, extra: Partial<ConnectionService> = {}): ConnectionService => ({
  id,
  label,
  group: "mail",
  blurb: `${label} for testing.`,
  state: "not_connected",
  via: null,
  account: null,
  backends: [],
  needsNous: false,
  ...extra,
});

type Call = { method: string; path: string; body?: Record<string, unknown> };
let calls: Call[];
let view: ConnectionsView;
let opStatus: "pending" | "connected" | "failed";
let opened: string[];

beforeEach(() => {
  forgetConnectCardServices();
  localStorage.clear();
  calls = [];
  opened = [];
  opStatus = "pending";
  view = {
    ok: true,
    nous: { signedIn: false, guest: false, account: null, connectors: false },
    local: { available: true, account: null },
    services: [
      svc("gmail", "Gmail", { backends: ["local"] }),
      svc("googlecalendar", "Google Calendar", { backends: ["local"] }),
      svc("outlook", "Outlook", { needsNous: true }),
      svc("notion", "Notion", { group: "work", backends: ["mcp"] }),
      svc("deepwiki", "Deepwiki", { group: "work", backends: ["mcp"] }),
    ],
    featured: ["gmail", "googlecalendar", "outlook", "notion"],
  };
  vi.stubGlobal("open", (url: string) => {
    opened.push(url);
    return {};
  });
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const path = new URL(input, "http://127.0.0.1").pathname.replace("/api/bridge", "");
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    if (path === "/connections") return json(view);
    if (path === "/connections/connect") return json({ ok: true, op: "op1", url: "https://accounts.example.test/signin", backend: body.backend || "local", finishOnPc: true });
    if (path === "/connections/op/op1") {
      if (opStatus === "connected") view = { ...view, services: view.services.map((s) => (s.id === "gmail" ? { ...s, state: "connected", via: "local", account: "me@example.com" } : s)) };
      return json({ ok: true, status: opStatus, service: "gmail" });
    }
    if (path === "/connections/nous/start") return json({ ok: true, session: "s1", code: "ABCD-1234", url: "https://portal.example.test/device", expiresIn: 900 });
    if (path === "/connections/disconnect") return json({ ok: true, also: [] });
    return json({ ok: true });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("lists email first and the featured work tools, with Nous offered for one-click sign-ins", async () => {
  render(<ConnectionsPage />);
  expect(await screen.findByText("Gmail")).toBeTruthy();
  expect(screen.getByText("Needs a free Nous account.")).toBeTruthy();
  expect(screen.getByText("Notion")).toBeTruthy();
  expect(screen.queryByText("Deepwiki")).toBeNull(); // not featured: under "All work tools"
  fireEvent.click(screen.getByRole("button", { name: /All work tools/ }));
  expect(screen.getByText("Deepwiki")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Find a work tool"), { target: { value: "notion" } });
  expect(screen.queryByText("Deepwiki")).toBeNull();
  expect(screen.getByText(/sending, deleting and moving mail asks you first/i)).toBeTruthy();
});

it("connects Gmail on this PC: opens Google's page, waits, then shows it connected", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(<ConnectionsPage />);
  const row = (await screen.findByText("Gmail")).closest("div.px-3\\.5") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "Connect" }));
  await waitFor(() => expect(opened).toEqual(["https://accounts.example.test/signin"]));
  expect(calls.find((c) => c.path === "/connections/connect")?.body).toEqual({ service: "gmail", backend: "local" });
  expect(await within(row).findByText(/Finish signing in to Gmail/)).toBeTruthy();
  expect(within(row).getByRole("link", { name: /Open again/ }).getAttribute("href")).toBe("https://accounts.example.test/signin");
  opStatus = "connected";
  await act(async () => {
    vi.advanceTimersByTime(1600);
  });
  await waitFor(() => expect(screen.getByText("On this PC · me@example.com")).toBeTruthy());
});

it("asks which way when a service has more than one, Quick first", async () => {
  view = {
    ...view,
    nous: { signedIn: true, guest: false, account: "me@example.com", connectors: true },
    services: view.services.map((s) => (s.id === "googlecalendar" ? { ...s, backends: ["quick", "local"] } : s)),
  };
  render(<ConnectionsPage />);
  expect(await screen.findByText(/Quick connections are on/)).toBeTruthy();
  const row = screen.getByText("Google Calendar").closest("div.px-3\\.5") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: /Connect/ }));
  const quick = within(row).getByRole("button", { name: /Quick.*recommended/ });
  expect(within(row).getByRole("button", { name: /On this PC/ })).toBeTruthy();
  fireEvent.click(quick);
  await waitFor(() => expect(calls.find((c) => c.path === "/connections/connect")?.body).toEqual({ service: "googlecalendar", backend: "quick" }));
});

it("signs in to Nous with a code and the portal's page", async () => {
  render(<ConnectionsPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
  expect(await screen.findByText("ABCD-1234")).toBeTruthy();
  expect(opened).toEqual(["https://portal.example.test/device"]);
  expect(screen.getByRole("link", { name: /Open Nous/ }).getAttribute("href")).toBe("https://portal.example.test/device");
});

it("confirms before disconnecting, and says what else on this PC goes with it", async () => {
  view = {
    ...view,
    services: view.services.map((s) =>
      s.id === "gmail" || s.id === "googlecalendar" ? { ...s, state: "connected", via: "local", account: "me@example.com" } : s,
    ),
  };
  render(<ConnectionsPage />);
  const row = (await screen.findByText("Gmail")).closest("div.px-3\\.5") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "Disconnect" }));
  expect(within(row).getByText(/Google Calendar on this PC go too/)).toBeTruthy();
  fireEvent.click(within(row).getAllByRole("button", { name: "Disconnect" })[1]);
  await waitFor(() => expect(calls.some((c) => c.path === "/connections/disconnect" && c.body?.service === "gmail")).toBe(true));
});

it("the chat card connects in one click and Continue tells the bot to go ahead", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const said: string[] = [];
  render(<ConnectCards items={[{ service: "gmail", label: "Gmail", why: "to sort your inbox" }]} messageId={7} onQuickReply={async (t) => void said.push(t)} />);
  expect(await screen.findByText("Connect Gmail")).toBeTruthy();
  expect(screen.getByText(/wants it to sort your inbox\./)).toBeTruthy();
  expect(screen.getByText("Sending always asks you first.")).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
  await waitFor(() => expect(opened.length).toBe(1));
  opStatus = "connected";
  await act(async () => {
    vi.advanceTimersByTime(1600);
  });
  fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
  expect(said).toEqual(["Gmail is connected. Go ahead."]);
  expect(screen.queryByRole("button", { name: "Continue" })).toBeNull(); // once
});

it("an old card for something already connected just says so", async () => {
  view = { ...view, services: view.services.map((s) => (s.id === "gmail" ? { ...s, state: "connected", via: "quick" } : s)) };
  render(<ConnectCards items={[{ service: "gmail", label: "Gmail", why: "" }]} messageId={8} onQuickReply={async () => undefined} />);
  expect(await screen.findByText(/Gmail connected/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
});

it("a service that needs Nous sends the owner to Settings, and Not now tells the bot", async () => {
  const said: string[] = [];
  render(<ConnectCards items={[{ service: "outlook", label: "Outlook", why: "" }]} messageId={9} onQuickReply={async (t) => void said.push(t)} />);
  expect(await screen.findByRole("button", { name: "Set up in Settings" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Not now" }));
  expect(said).toEqual(["Not now: skip Outlook for this."]);
  expect(screen.getByText(/Not connecting Outlook for now/)).toBeTruthy();
});

it("a card for a service this account can't reach says so, with nothing to press", async () => {
  view = { ...view, services: view.services.filter((s) => s.id !== "outlook") };
  render(<ConnectCards items={[{ service: "outlook", label: "Outlook", why: "" }]} messageId={10} onQuickReply={async () => undefined} />);
  expect(await screen.findByText("Outlook can’t be connected from this app yet.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
});

it("reads the mail guard's reason back as an email for the approval sheet", () => {
  const mail = mailAction({
    patternKey: "plugin_rule:chief:mail-send",
    reason: "Send an email\nTo: someone@example.com\nSubject: Thursday's plan\n\nHi, here is where we landed.",
  });
  expect(mail).toMatchObject({
    rule: "mail-send",
    title: "Send this email?",
    what: "Send an email",
    fields: [
      { key: "To", value: "someone@example.com" },
      { key: "Subject", value: "Thursday's plan" },
    ],
    body: "Hi, here is where we landed.",
  });
  expect(mailAction({ patternKey: "plugin_rule:chief:mail-move", reason: "Move email out of the inbox" })?.fields).toEqual([]);
  expect(mailAction({ patternKey: "rm_recursive", reason: "x" })).toBeNull();
  expect(mailAction({ patternKey: "plugin_rule:someone-else:send", reason: "x" })).toBeNull();
});
