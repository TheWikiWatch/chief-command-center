// @vitest-environment-options { "url": "https://desk.example-tailnet.ts.net/" }
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/web-push", () => ({
  pushCapability: vi.fn(async () => ({ available: true })),
  pushStatus: vi.fn(async () => "off"),
  enableWebPush: vi.fn(async () => ({ ok: true })),
  disableWebPush: vi.fn(async () => ({ ok: true })),
  pushDeviceCount: vi.fn(async () => 1),
  sendTestPush: vi.fn(async () => ({ ok: true, sent: 1 })),
}));

import { PhoneSettings } from "@/components/phone/phone-settings";
import { enableWebPush, pushStatus } from "@/lib/web-push";

const setUA = (ua: string) => Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Settings → Phone, opened on the phone", () => {
  it("Android: home-screen steps, then alerts on and a test", async () => {
    setUA("Mozilla/5.0 (Linux; Android 16; Pixel 10) Chrome/140");
    render(<PhoneSettings />);
    expect(await screen.findByText(/Add .* to your home screen/)).toBeInTheDocument();
    expect(screen.getByText(/In Chrome, tap ⋮, then Install app/)).toBeInTheDocument();
    vi.mocked(pushStatus).mockResolvedValueOnce("on");
    fireEvent.click(await screen.findByRole("button", { name: "Turn on alerts" }));
    await waitFor(() => expect(enableWebPush).toHaveBeenCalled());
    expect(await screen.findByText(/Alerts are on/)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Stop alerts here" })).toBeInTheDocument();
  });

  it("iPhone in Safari: alerts wait until it's opened from the home screen", async () => {
    setUA("Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) Safari/604.1");
    render(<PhoneSettings />);
    expect(await screen.findByText(/tap Share, then Add to Home Screen/)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Turn on alerts" })).toBeDisabled();
    expect(screen.getByText(/Add it to the home screen first/)).toBeInTheDocument();
  });
});
