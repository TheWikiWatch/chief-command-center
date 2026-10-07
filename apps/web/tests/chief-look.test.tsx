import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { ChiefLookExport } from "@/components/chief-look";
import type { Person } from "@/lib/types";

const chief = {
  id: "chief",
  name: "Nova",
  title: "Nova - Chief of Staff",
  description: "",
  section: "",
  shape: "hexagon",
  color: "#E5484D",
  imageKind: "shape",
  custom: true,
  model: "",
  provider: "",
  flavor: "",
  isChief: true,
  ring: "idle",
  jobTitle: "",
} as Person;

type LookWindow = { __chiefLook?: () => Promise<{ png: string | null; accent: string; name: string; reducedMotion: boolean }>; chiefDesktop?: unknown };

afterEach(() => {
  cleanup();
  delete (window as unknown as LookWindow).chiefDesktop;
});

it("does nothing outside the desktop app", () => {
  const { container } = render(<ChiefLookExport chief={chief} assistant="Nova" />);
  expect(container.innerHTML).toBe("");
  expect((window as unknown as LookWindow).__chiefLook).toBeUndefined();
});

it("in the desktop app, offers the update window Chief's name and colour, with a still face kept out of sight", async () => {
  (window as unknown as LookWindow).chiefDesktop = {};
  const { container, unmount } = render(<ChiefLookExport chief={chief} assistant="Nova" />);
  await waitFor(() => expect((window as unknown as LookWindow).__chiefLook).toBeTypeOf("function"));
  const box = container.firstElementChild as HTMLElement;
  expect(box.getAttribute("aria-hidden")).toBe("true");
  expect(box.className).toMatch(/-left-\[9999px\]/);
  const look = await (window as unknown as LookWindow).__chiefLook!();
  expect(look.name).toBe("Nova");
  expect(look.reducedMotion).toBe(false);
  // The test DOM has no canvas: the face comes back empty and the window falls back to the app icon.
  expect(look.png === null || look.png.startsWith("data:image/png")).toBe(true);
  unmount();
  expect((window as unknown as LookWindow).__chiefLook).toBeUndefined();
});
