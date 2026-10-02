import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { Tip } from "@/components/ui/popovers";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("labels a button on hover after a pause, with its shortcut, and never on a touch-only screen", () => {
  vi.useFakeTimers();
  const onClick = vi.fn();
  render(
    <Tip label="Settings" shortcut="Ctrl+,">
      <button type="button" aria-label="Settings" onClick={onClick} />
    </Tip>,
  );
  const button = screen.getByRole("button", { name: "Settings" });
  const media = vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
  fireEvent.mouseEnter(button);
  act(() => void vi.advanceTimersByTime(1000));
  expect(screen.queryByRole("tooltip")).toBeNull();
  media.mockReturnValue({ matches: false } as MediaQueryList);

  fireEvent.mouseEnter(button);
  expect(screen.queryByRole("tooltip")).toBeNull();
  act(() => void vi.advanceTimersByTime(500));
  expect(screen.getByRole("tooltip")).toHaveTextContent("SettingsCtrl+,");
  expect(button).toHaveAttribute("aria-describedby", screen.getByRole("tooltip").id);

  fireEvent.click(button);
  expect(onClick).toHaveBeenCalled();
  fireEvent.mouseLeave(button);
  expect(screen.queryByRole("tooltip")).toBeNull();
});
