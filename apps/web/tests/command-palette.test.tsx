import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandPalette, matches, withRecent, type PaletteCommand } from "@/components/command-palette";
import { matchShortcut } from "@/lib/shortcuts";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

describe("the keyboard map", () => {
  it("knows the shortcuts, and leaves single keys alone while typing", () => {
    expect(matchShortcut(key({ key: "k", ctrlKey: true }), true)).toBe("palette");
    expect(matchShortcut(key({ key: ",", ctrlKey: true }), false)).toBe("settings");
    expect(matchShortcut(key({ key: "2", ctrlKey: true }), false)).toBe("surface2");
    expect(matchShortcut(key({ key: "n", code: "KeyN", ctrlKey: true, altKey: true }), false)).toBe("newThread");
    expect(matchShortcut(key({ key: "/" }), false)).toBe("composer");
    expect(matchShortcut(key({ key: "?" , shiftKey: true }), false)).toBe("help");
    expect(matchShortcut(key({ key: "/" }), true)).toBeNull();
    expect(matchShortcut(key({ key: "a" }), false)).toBeNull();
  });
});

describe("the command palette", () => {
  const run = { today: vi.fn(), settings: vi.fn() };
  const commands: PaletteCommand[] = [
    { id: "today", label: "Today", group: "Go to", keywords: "tasks", run: run.today },
    { id: "settings-voice", label: "Settings: Voice", group: "Settings", keywords: "speech microphone", run: run.settings },
  ];

  it("finds commands by every word of the query, keywords included", () => {
    expect(matches(commands[1], "voice")).toBe(true);
    expect(matches(commands[1], "settings microphone")).toBe(true);
    expect(matches(commands[0], "tasks")).toBe(true);
    expect(matches(commands[0], "voice")).toBe(false);
  });

  it("runs the highlighted command with Enter, and offers to ask the chief anything else", async () => {
    const onAsk = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} commands={commands} assistant="Nova" onAsk={onAsk} />);
    const box = screen.getByRole("combobox");
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: "microphone" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Settings: Voice", "Ask Nova: “microphone”"]);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onClose).toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 5));
    expect(run.settings).toHaveBeenCalled();
    fireEvent.change(box, { target: { value: "what is on my plate" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await new Promise((r) => setTimeout(r, 5));
    expect(onAsk).toHaveBeenCalledWith("what is on my plate");
  });
});

describe("the palette's memory and search", () => {
  const go = (id: string, label: string): PaletteCommand => ({ id, label, group: "Go to", run: vi.fn() });

  it("puts recently run commands first, once", () => {
    const list = withRecent([go("a", "Alpha"), go("b", "Beta"), go("c", "Gamma")], ["c", "gone"]);
    expect(list.map((c) => `${c.group}:${c.id}`)).toEqual(["Recent:c", "Go to:a", "Go to:b"]);
  });

  it("remembers what ran, and shows search results for the current query only", async () => {
    const search = vi.fn(async (q: string) => [{ id: `vault:${q}.md`, label: `${q} note`, group: "Vault" as const, run: vi.fn() }]);
    const commands = [go("today", "Today"), go("fleet", "Fleet")];
    const view = render(<CommandPalette open onClose={() => {}} commands={commands} assistant="Nova" onAsk={() => {}} search={search} />);
    const box = screen.getByRole("combobox");
    fireEvent.change(box, { target: { value: "fleet" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByRole("option", { name: "fleet note" })).toBeInTheDocument();
    expect(search).toHaveBeenLastCalledWith("fleet", expect.any(AbortSignal));
    view.unmount();
    render(<CommandPalette open onClose={() => {}} commands={commands} assistant="Nova" onAsk={() => {}} />);
    expect(screen.getAllByRole("option")[0]).toHaveTextContent("Fleet");
  });
});
