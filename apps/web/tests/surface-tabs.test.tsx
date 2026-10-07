import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { SurfaceTabs, surfacePanelId, type Surface } from "@/components/surface-tabs";

afterEach(cleanup);

it("is a real tab list: one tab in the Tab order, arrow keys move between them, each names its panel", () => {
  const onChange = vi.fn();
  render(<SurfaceTabs surface="today" onChange={onChange} />);
  const tabs = screen.getAllByRole("tab");
  expect(tabs.map((t) => t.textContent)).toEqual(["Fleet", "Today", "Vault"]);
  expect(tabs.map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
  expect(tabs[1]).toHaveAttribute("aria-selected", "true");
  expect(tabs[1]).toHaveAttribute("aria-controls", surfacePanelId("today"));
  fireEvent.keyDown(tabs[1], { key: "ArrowRight" });
  expect(onChange).toHaveBeenLastCalledWith("vault");
  fireEvent.keyDown(tabs[1], { key: "ArrowLeft" });
  expect(onChange).toHaveBeenLastCalledWith("fleet");
  fireEvent.keyDown(tabs[1], { key: "End" });
  expect(onChange).toHaveBeenLastCalledWith("vault");
  fireEvent.keyDown(tabs[1], { key: "Home" });
  expect(onChange).toHaveBeenLastCalledWith("fleet");
  expect(onChange).toHaveBeenCalledTimes(4);
});

it("wraps around and moves focus to the chosen tab", () => {
  let surface: Surface = "vault";
  const onChange = vi.fn((next: Surface) => (surface = next));
  const view = render(<SurfaceTabs surface={surface} onChange={onChange} />);
  fireEvent.keyDown(screen.getAllByRole("tab")[2], { key: "ArrowRight" });
  expect(onChange).toHaveBeenLastCalledWith("fleet");
  view.rerender(<SurfaceTabs surface={surface} onChange={onChange} />);
  expect(document.activeElement).toBe(screen.getAllByRole("tab")[0]);
});
