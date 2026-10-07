import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ fetchSettings: vi.fn(), patchSettings: vi.fn() }));
vi.mock("@/lib/bridge", () => ({ fetchSettings: api.fetchSettings, patchSettings: api.patchSettings }));

import { RepliesGroup } from "@/components/settings/general";

afterEach(cleanup);

it("the replies-as-written switch reads and writes Hermes's streaming setting, and says when it takes effect", async () => {
  api.fetchSettings.mockResolvedValue({ ok: true, streaming: true });
  api.patchSettings.mockResolvedValue({ ok: true, streaming: false });
  render(<RepliesGroup />);
  const toggle = await screen.findByRole("switch", { name: "Show replies as they're written" });
  await waitFor(() => expect(toggle).toBeChecked());
  fireEvent.click(toggle);
  await waitFor(() => expect(api.patchSettings).toHaveBeenCalledWith({ streaming: false }));
  expect(toggle).not.toBeChecked();
  expect(await screen.findByText(/takes effect the next time Nova starts/i)).toBeInTheDocument();
});

it("a failed save puts the switch back and says why", async () => {
  api.fetchSettings.mockResolvedValue({ ok: true, streaming: false });
  api.patchSettings.mockRejectedValue(new Error("Could not write Hermes config"));
  render(<RepliesGroup />);
  const toggle = await screen.findByRole("switch", { name: "Show replies as they're written" });
  fireEvent.click(toggle);
  await screen.findByText("Could not write Hermes config");
  expect(toggle).not.toBeChecked();
});
