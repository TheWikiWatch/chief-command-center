import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { LayerScope, layerDepth, openLayer, resetLayers, useLayer } from "@/lib/overlay-stack";

const settle = () => act(() => new Promise((r) => setTimeout(r, 30)));

// Let queued history steps land before the next test starts.
afterEach(async () => {
  await settle();
  resetLayers();
});

it("Escape closes only the top-most layer", () => {
  const under = vi.fn();
  const top = vi.fn();
  const closeUnder = openLayer(under);
  const closeTop = openLayer(top);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(top).toHaveBeenCalledTimes(1);
  expect(under).not.toHaveBeenCalled();
  // Both closed in the same tick: both history entries are taken back.
  const before = window.history.length;
  closeTop();
  closeUnder();
  expect(layerDepth()).toBe(0);
  expect(window.history.length).toBe(before);
});

it("Back pops one layer at a time, and a layer closed by its button takes its entry back", async () => {
  const under = vi.fn();
  const top = vi.fn();
  const closeUnder = openLayer(under);
  openLayer(top);
  expect(layerDepth()).toBe(2);
  window.history.back();
  await settle();
  expect(top).toHaveBeenCalledTimes(1);
  expect(under).not.toHaveBeenCalled();
  expect(layerDepth()).toBe(1);
  // Closing the remaining layer with its own button steps history back without dismissing again.
  closeUnder();
  await settle();
  expect(under).not.toHaveBeenCalled();
  expect(layerDepth()).toBe(0);
});

it("a layer that refuses to close keeps its place", async () => {
  const refuse = vi.fn(() => false as const);
  const close = openLayer(refuse);
  window.history.back();
  await settle();
  expect(refuse).toHaveBeenCalledTimes(1);
  expect(layerDepth()).toBe(1);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(layerDepth()).toBe(1);
  close();
  await settle();
});

function Probe({ onDismiss }: { onDismiss: () => void }) {
  useLayer(true, onDismiss);
  return null;
}

it("layers inside a hidden tab wait until it shows", async () => {
  const dismiss = vi.fn();
  const view = render(
    <LayerScope visible={false}>
      <Probe onDismiss={dismiss} />
    </LayerScope>,
  );
  expect(layerDepth()).toBe(0);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(dismiss).not.toHaveBeenCalled();
  view.rerender(
    <LayerScope visible>
      <Probe onDismiss={dismiss} />
    </LayerScope>,
  );
  expect(layerDepth()).toBe(1);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(dismiss).toHaveBeenCalledTimes(1);
  view.unmount();
  await settle();
  expect(layerDepth()).toBe(0);
});

it("closing one layer and opening another in the same tick reuses the history entry", async () => {
  const closeA = openLayer(() => undefined);
  const length = window.history.length;
  closeA();
  const b = vi.fn();
  const closeB = openLayer(b);
  await settle();
  expect(window.history.length).toBe(length);
  expect(layerDepth()).toBe(1);
  window.history.back();
  await settle();
  expect(b).toHaveBeenCalledTimes(1);
  closeB();
});
