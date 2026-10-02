import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { isFullscreenKey, toggleFullscreen, useFullscreenShortcut } from "@/lib/use-fullscreen";
import { openLayer, resetLayers } from "@/lib/overlay-stack";

let element: Element | null = null;
const request = vi.fn(async () => {
  element = document.documentElement;
  document.dispatchEvent(new Event("fullscreenchange"));
});
const exit = vi.fn(async () => {
  element = null;
  document.dispatchEvent(new Event("fullscreenchange"));
});

function support(enabled: boolean) {
  Object.defineProperty(document, "fullscreenEnabled", { configurable: true, get: () => enabled });
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => element });
  Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exit });
  Object.defineProperty(document.documentElement, "requestFullscreen", { configurable: true, value: request });
}

beforeEach(() => {
  element = null;
  request.mockClear();
  exit.mockClear();
  support(true);
});
afterEach(() => {
  cleanup();
  resetLayers();
});

it("toggleFullscreen exits when already full screen and reports refusal", async () => {
  element = document.documentElement;
  await expect(toggleFullscreen()).resolves.toBe(true);
  expect(exit).toHaveBeenCalled();
  request.mockRejectedValueOnce(new Error("no gesture"));
  await expect(toggleFullscreen()).resolves.toBe(false);
});

it("F toggles only when not typing, with no modifiers and no sheet open", () => {
  const key = (init: KeyboardEventInit, target: EventTarget = document.body) => {
    const e = new KeyboardEvent("keydown", init);
    Object.defineProperty(e, "target", { value: target });
    return isFullscreenKey(e);
  };
  expect(key({ key: "f" })).toBe(true);
  expect(key({ key: "F" })).toBe(true);
  expect(key({ key: "f", ctrlKey: true })).toBe(false);
  expect(key({ key: "g" })).toBe(false);
  const textarea = document.createElement("textarea");
  document.body.append(textarea);
  expect(key({ key: "f" }, textarea)).toBe(false);
  textarea.remove();
  const close = openLayer(() => undefined);
  expect(key({ key: "f" })).toBe(false);
  close();
});

it("the desktop shortcut calls the Fullscreen API", async () => {
  function Harness() {
    useFullscreenShortcut(true);
    return null;
  }
  render(<Harness />);
  await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "f" })));
  expect(request).toHaveBeenCalledTimes(1);
});

it("the header has no full-screen button (F11, Settings and the command palette have it)", async () => {
  const { HeaderStatus } = await import("@/components/connection-status");
  render(<HeaderStatus connected onOpenSettings={() => {}} />);
  expect(screen.queryByRole("button", { name: "Full screen" })).toBeNull();
});
