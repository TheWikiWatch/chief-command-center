import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkforcePane } from "@/components/workforce-pane";
import { orbitLayout } from "@/lib/orbit-layout";
import { diffRoster, useFleetMoments } from "@/lib/roster-moments";
import type { Person } from "@/lib/types";

vi.mock("@paper-design/shaders-react", () => ({ GodRays: () => null }));
vi.mock("@blobatar/react/gaze", () => ({ useGaze: () => ({ ref: () => undefined, lookAt: () => undefined }) }));
const toast = vi.hoisted(() => vi.fn());
vi.mock("@/lib/toast-store", () => ({ showToast: toast }));

function bot(id: string, extra: Partial<Person> = {}): Person {
  return {
    id,
    name: `${id} - Specialist`,
    title: id,
    description: "",
    section: "",
    shape: "",
    color: "",
    imageKind: "",
    custom: false,
    avatarUrl: null,
    model: "",
    provider: "",
    flavor: "",
    isChief: false,
    ring: "idle",
    jobTitle: "",
    ...extra,
  };
}

const chief = bot("chief", { name: "Chief - Chief of Staff", isChief: true, shape: "blobatar::hexagon" });
const weird = [
  bot("fresh-mint"),
  bot("broken-shape", { shape: "definitely-not-a-shape", color: "not-a-color" }),
  bot("emoji", { name: "🚀🚀 Extremely long named specialist with emoji and more words than fit 🚀" }),
  bot("no-dash", { name: "Just One Name" }),
  bot("photo", { imageKind: "photo", avatarUrl: "/api/bridge/avatar/photo" }),
];
const base = [chief, bot("ada"), bot("cody"), bot("herb")];
const many = [chief, ...Array.from({ length: 14 }, (_, i) => bot(`s${i}`, { section: i % 3 ? "Research" : "" }))];

beforeEach(() => {
  toast.mockClear();
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("roster churn", () => {
  it("renders every layout through 3 → 6 → 2 → 14 bots, including odd new ones", () => {
    const rosters = [base, [chief, bot("ada"), ...weird], [chief, bot("ada"), bot("herb")].slice(0, 3), many];
    for (const mode of ["orbit", "rail"] as const) {
      for (const phone of [false, true]) {
        if (mode === "orbit" && phone) continue;
        const view = render(<WorkforcePane people={rosters[0]} mode={mode} phone={phone} onOpen={() => undefined} onLookTarget={() => undefined} />);
        for (const people of rosters.slice(1)) {
          view.rerender(<WorkforcePane people={people} mode={mode} phone={phone} onOpen={() => undefined} onLookTarget={() => undefined} />);
        }
        const buttons = screen.getAllByRole("button").length;
        expect(buttons).toBeGreaterThanOrEqual(phone ? 10 : 14);
        view.unmount();
      }
    }
  });

  it("diffs minted, retired, dispatched and finished", () => {
    const prev = new Map(base.map((p) => [p.id, p]));
    const next = [chief, bot("ada", { ring: "working", jobTitle: "Ship it" }), bot("cody"), bot("ivy", { ring: "working" })];
    const events = diffRoster(prev, next).map((e) => `${e.kind}:${e.person.id}`);
    expect(events).toEqual(expect.arrayContaining(["dispatched:ada", "minted:ivy", "dispatched:ivy", "retired:herb"]));
    const done = diffRoster(new Map(next.map((p) => [p.id, p])), [chief, bot("ada"), bot("cody"), bot("ivy", { ring: "working" })]);
    expect(done.map((e) => `${e.kind}:${e.person.id}`)).toEqual(["finished:ada"]);
  });

  it("never announces on the first roster or right after a reconnect, then announces once per change", () => {
    const { rerender } = renderHook(({ people, connected }) => useFleetMoments(people, connected), {
      initialProps: { people: base, connected: true },
    });
    expect(toast).not.toHaveBeenCalled();
    rerender({ people: [...base, bot("ivy")], connected: true });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0].title).toBe("Chief added ivy");
    rerender({ people: [...base, bot("ivy")], connected: false });
    rerender({ people: [chief, bot("zed")], connected: true });
    expect(toast).toHaveBeenCalledTimes(1);
    rerender({ people: [chief], connected: true });
    expect(toast).toHaveBeenCalledTimes(2);
    expect(toast.mock.calls[1][0].title).toBe("Chief retired zed");
  });

  it("still announces a mint after a quiet reconnect when polls share an unchanged roster", () => {
    const roster = [...base];
    const { result, rerender } = renderHook(({ people, connected }) => useFleetMoments(people, connected), {
      initialProps: { people: roster, connected: true },
    });
    rerender({ people: roster, connected: false });
    // Reconnect: the shared roster keeps its identity, so only the arriving snapshot sets the baseline.
    rerender({ people: roster, connected: true });
    act(() => result.current.markFresh(roster));
    rerender({ people: [...roster, bot("ivy")], connected: true });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0].title).toBe("Chief added ivy");
  });

  it("treats changes made while away as the baseline once a fresh snapshot arrives", () => {
    const { result, rerender } = renderHook(({ people, connected }) => useFleetMoments(people, connected), {
      initialProps: { people: base, connected: true },
    });
    rerender({ people: base, connected: false });
    rerender({ people: base, connected: true });
    const fresh = [...base, bot("zed")];
    act(() => result.current.markFresh(fresh));
    rerender({ people: fresh, connected: true });
    expect(toast).not.toHaveBeenCalled();
  });

  it("marks minted bots for their entrance, then clears", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ people }) => useFleetMoments(people, true), { initialProps: { people: base } });
    rerender({ people: [...base, bot("ivy")] });
    expect(result.current.minted.has("ivy")).toBe(true);
    act(() => vi.advanceTimersByTime(3000));
    expect(result.current.minted.has("ivy")).toBe(false);
    vi.useRealTimers();
  });

  it("lays out one ring up to 12 and two rings beyond, all seats inside the pane", () => {
    expect(new Set(orbitLayout(12).map((s) => s.ring))).toEqual(new Set([0]));
    const thirty = orbitLayout(30);
    expect(thirty).toHaveLength(30);
    expect(new Set(thirty.map((s) => s.ring))).toEqual(new Set([0, 1]));
    for (const s of thirty) {
      expect(s.x).toBeGreaterThan(5);
      expect(s.x).toBeLessThan(95);
      expect(s.y).toBeGreaterThan(5);
      expect(s.y).toBeLessThan(95);
    }
  });
});
