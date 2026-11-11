import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { CommandShell } from "@/components/command-shell";
import { currentChatThread, setChatThread } from "@/lib/chat-thread";

/* Review A2: the shell starts on what this device remembers, with no first frame of the defaults. */

const shell = vi.hoisted(() => ({ phone: false, chats: [] as string[] }));
vi.mock("@/lib/use-phone-shell", () => ({ usePhoneShell: () => shell.phone }));
// Vitest resolves the package's server build (its edge-light export), where panels never lay out; the app runs this one.
vi.mock("react-resizable-panels", () =>
  vi.importActual<typeof import("react-resizable-panels")>("../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.js"),
);
vi.mock("@/components/chief-chat", () => ({
  // Records the thread each chat mounted with, as the real one reads it (once, as it first renders).
  ChiefChat: () => {
    const [thread] = useState(() => {
      shell.chats.push(currentChatThread());
      return currentChatThread();
    });
    return <div>Chat in {thread}</div>;
  },
}));
vi.mock("@/components/today-pane", () => ({ TodayPane: () => <div>Today contents</div> }));
vi.mock("@/components/workforce-pane", () => ({ WorkforcePane: () => <div>Fleet contents</div> }));
vi.mock("@/components/vault-pane", () => ({ VaultPane: () => <div>Vault contents</div> }));
vi.mock("@/components/look-drawer", () => ({ LookDrawer: () => null }));
vi.mock("@/components/settings-panel", () => ({ SettingsPanel: () => null }));
vi.mock("@/lib/bridge", () => ({
  subscribeBridge: () => () => {},
  fetchHealth: async () => ({ ok: true }),
  fetchSnapshot: async () => ({ ok: true, roster: [] }),
  fetchApprovals: async () => ({ ok: true, approval: null }),
}));

beforeEach(() => {
  localStorage.clear();
  shell.chats = [];
  setChatThread("main");
});
afterEach(cleanup);

it("the chat mounts once, on the saved thread, and the phone opens on the saved tab", async () => {
  shell.phone = true;
  localStorage.setItem("chief-chat-thread", "t-1234abcd");
  localStorage.setItem("chief-phone-tab", "today");
  render(<CommandShell />);
  // The first render already shows the saved tab: no frame of Chat first (a tab that isn't shown is `hidden`).
  expect(screen.getByText("Today contents").closest(".hidden")).toBeNull();
  expect(screen.getByText("Chat in t-1234abcd").closest(".hidden")).not.toBeNull();
  await new Promise((r) => setTimeout(r, 50));
  expect(shell.chats).toEqual(["t-1234abcd"]);
  fireEvent.click(screen.getByRole("button", { name: "Chat" }));
  expect(screen.getByText("Chat in t-1234abcd").closest(".hidden")).toBeNull();
});

it("the desktop opens on the saved surface, with the split the panel group saved", async () => {
  shell.phone = false;
  localStorage.setItem("chief-surface", "vault");
  // The group's own record (autoSaveId), under the panels' names.
  localStorage.setItem("react-resizable-panels:chief-shell-split", JSON.stringify({ "shell-chat,shell-surfaces": { expandToSizes: {}, layout: [40, 60] } }));
  render(<CommandShell />);
  expect(await screen.findByText("Vault contents")).toBeInTheDocument();
  expect(screen.queryByText("Today contents")).toBeNull();
  // 40 % on the left is the chat-wide rail.
  expect(screen.getByRole("button", { name: "Switch to orbit" })).toBeInTheDocument();
  expect(shell.chats).toEqual(["main"]);
});

it("a device that saved its split the old way starts with it", async () => {
  shell.phone = false;
  localStorage.setItem("chief-split", "40");
  render(<CommandShell />);
  expect(await screen.findByRole("button", { name: "Switch to orbit" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Switch to orbit" }));
  // The group saves the new split itself.
  await waitFor(() => expect(JSON.parse(localStorage.getItem("react-resizable-panels:chief-shell-split") || "{}")["shell-chat,shell-surfaces"]?.layout).toEqual([60, 40]));
});
