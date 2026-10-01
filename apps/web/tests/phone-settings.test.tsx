import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/web-push", () => ({
  pushCapability: vi.fn(async () => ({ available: true })),
  pushStatus: vi.fn(async () => "off"),
  enableWebPush: vi.fn(async () => ({ ok: true })),
  disableWebPush: vi.fn(async () => ({ ok: true })),
  pushDeviceCount: vi.fn(async () => 2),
  sendTestPush: vi.fn(async () => ({ ok: true, sent: 2 })),
}));

import { PhoneSettings } from "@/components/phone/phone-settings";
import type { PhoneState } from "@/lib/desktop";
import { phonePlatform } from "@/lib/install-prompt";
import { sendTestPush } from "@/lib/web-push";

const base: PhoneState = {
  installed: true,
  backend: "Running",
  dnsName: "desk.example-tailnet.ts.net",
  login: "owner@example.com",
  https: true,
  serve: [],
  error: "",
  uiPort: 3000,
  url: "",
  port: 443,
  moved: false,
  access: "tailnet",
  allowed: "",
};

function stubPhone(state: Partial<PhoneState>, overrides: Record<string, unknown> = {}) {
  const api = {
    state: vi.fn(async () => ({ ...base, ...state })),
    enable: vi.fn(async () => ({ ok: true, url: "https://desk.example-tailnet.ts.net" })),
    disable: vi.fn(async () => ({ ok: true })),
    setAccess: vi.fn(async () => ({ ok: true })),
    open: vi.fn(async () => true),
    ...overrides,
  };
  (window as unknown as { chiefDesktop?: unknown }).chiefDesktop = { phone: api };
  return api;
}

beforeEach(() => vi.useRealTimers());
afterEach(() => {
  cleanup();
  delete (window as unknown as { chiefDesktop?: unknown }).chiefDesktop;
  vi.clearAllMocks();
});

describe("Settings → Phone on the PC", () => {
  it("starts at getting Tailscale, with later steps waiting", async () => {
    const api = stubPhone({ installed: false, backend: "" });
    render(<PhoneSettings />);
    fireEvent.click(await screen.findByRole("button", { name: /Get Tailscale/ }));
    expect(api.open).toHaveBeenCalledWith("https://tailscale.com/download/windows");
    expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull();
  });

  it("sends the owner to Tailscale's DNS page when HTTPS certificates are off", async () => {
    const api = stubPhone({ https: false });
    render(<PhoneSettings />);
    expect(await screen.findByText(/Signed in as owner@example.com/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Open DNS settings/ }));
    expect(api.open).toHaveBeenCalledWith("https://login.tailscale.com/admin/dns");
  });

  it("turns phone access on, and offers Tailscale's consent link when it asks first", async () => {
    const api = stubPhone({}, { enable: vi.fn(async () => ({ ok: false, error: "Tailscale needs your permission first.", consentUrl: "https://login.tailscale.com/f/serve?node=n1" })) });
    render(<PhoneSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Turn on" }));
    expect(api.enable).toHaveBeenCalledWith(443);
    expect(await screen.findByRole("alert")).toHaveTextContent("Tailscale needs your permission first.");
    fireEvent.click(screen.getByRole("button", { name: /Allow it in Tailscale/ }));
    expect(api.open).toHaveBeenCalledWith("https://login.tailscale.com/f/serve?node=n1");
  });

  it("when on: the address, its QR code, the phone steps, who can open it, and a test alert", async () => {
    const api = stubPhone({ url: "https://desk.example-tailnet.ts.net", serve: [{ port: 443, target: "http://127.0.0.1:3000", ours: true }] });
    render(<PhoneSettings />);
    expect(await screen.findByRole("img", { name: "QR code for https://desk.example-tailnet.ts.net" })).toBeInTheDocument();
    expect(screen.getAllByText("https://desk.example-tailnet.ts.net").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /Google Play/ }));
    expect(api.open).toHaveBeenCalledWith(expect.stringContaining("play.google.com"));
    fireEvent.click(screen.getByRole("radio", { name: /Only you/ }));
    await waitFor(() => expect(api.setAccess).toHaveBeenCalledWith("owner"));
    expect(await screen.findByText("Alerts go to 2 devices")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send a test alert" }));
    expect(await screen.findByText(/Sent to 2 devices/)).toBeInTheDocument();
    expect(sendTestPush).toHaveBeenCalled();
    // Changing who can open it restarts the dashboard; the other buttons wait for that.
    await waitFor(() => expect(screen.getByRole("button", { name: "Turn off" })).toBeEnabled(), { timeout: 4000 });
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(api.disable).toHaveBeenCalled());
  });

  it("offers to fix the address when the dashboard moved ports", async () => {
    const api = stubPhone({ moved: true, uiPort: 3001, port: 443 });
    render(<PhoneSettings />);
    expect(await screen.findByText(/moved to port 3001/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fix it" }));
    await waitFor(() => expect(api.enable).toHaveBeenCalledWith(443));
  });
});

describe("which phone", () => {
  it("tells iPhone from Android", () => {
    expect(phonePlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)")).toBe("ios");
    expect(phonePlatform("Mozilla/5.0 (Linux; Android 16; Pixel 10)")).toBe("android");
    expect(phonePlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("other");
  });
});
