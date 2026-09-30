import { expect, it } from "vitest";

import { groupFleet, pickOrbitSeats, turn, WORKING_GROUP } from "@/lib/orbit-layout";

const bot = (id: string, ring = "idle", section = "") => ({ id, ring, section });
const twelve = Array.from({ length: 12 }, (_, i) => bot(`b${i}`));

it("always seats working bots, even at the end of the roster", () => {
  const people = twelve.map((p, i) => (i === 0 || i === 11 ? { ...p, ring: "working" } : p));
  const seats = pickOrbitSeats(people, 10);
  expect(seats).toHaveLength(10);
  expect(seats.map((p) => p.id)).toContain("b11");
  expect(seats.map((p) => p.id)).toContain("b0");
  // Roster order is kept, so seats don't reshuffle.
  expect(seats.map((p) => p.id)).toEqual(["b0", "b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "b11"]);
});

it("shows everyone when they fit, and caps a crowd of workers at the hard maximum", () => {
  expect(pickOrbitSeats(twelve.slice(0, 7), 10)).toHaveLength(7);
  const busy = Array.from({ length: 15 }, (_, i) => bot(`w${i}`, "working"));
  expect(pickOrbitSeats(busy, 10, 12)).toHaveLength(12);
});

it("puts working bots in a group at the top of the list", () => {
  const groups = groupFleet([bot("a", "idle", "Research"), bot("b", "working", "Research"), bot("c"), bot("d", "working")]);
  expect(groups.map(([name, list]) => [name, list.map((p) => p.id)])).toEqual([
    [WORKING_GROUP, ["b", "d"]],
    ["Research", ["a"]],
    ["Specialists", ["c"]],
  ]);
  expect(groupFleet([bot("a")])[0][0]).toBe("Specialists");
});

it("turns the short way round", () => {
  expect(turn(0.1, 6.2)).toBeCloseTo(6.2 - 0.1 - Math.PI * 2);
  expect(turn(1, 2)).toBeCloseTo(1);
});
