import { expect, it } from "vitest";

import { share } from "@/lib/share";

it("keeps every reference when a poll brings nothing new", () => {
  const prev = { roster: [{ id: "a", ring: "idle" }, { id: "b", ring: "working" }], meta: { n: 1 } };
  const next = JSON.parse(JSON.stringify(prev));
  expect(share(prev, next)).toBe(prev);
});

it("shares unchanged bots by id when one is minted, retired or changes", () => {
  const a = { id: "a", ring: "idle" };
  const b = { id: "b", ring: "working" };
  const prev = { roster: [a, b] };
  const minted = share(prev, { roster: [{ id: "c", ring: "idle" }, { id: "a", ring: "idle" }, { id: "b", ring: "working" }] });
  expect(minted).not.toBe(prev);
  expect(minted.roster[1]).toBe(a);
  expect(minted.roster[2]).toBe(b);

  const retired = share(prev, { roster: [{ id: "b", ring: "working" }] });
  expect(retired.roster).toEqual([b]);
  expect(retired.roster[0]).toBe(b);

  const changed = share(prev, { roster: [{ id: "a", ring: "idle" }, { id: "b", ring: "idle" }] });
  expect(changed.roster[0]).toBe(a);
  expect(changed.roster[1]).not.toBe(b);
  expect(changed.roster[1].ring).toBe("idle");
});

it("handles nulls, primitives and added or removed keys", () => {
  expect(share(null, { x: 1 })).toEqual({ x: 1 });
  expect(share({ x: 1 } as object | null, null)).toBeNull();
  const prev = { x: 1, y: 2 } as Record<string, number>;
  expect(share(prev, { x: 1 })).toEqual({ x: 1 });
  expect(share(prev, { x: 1, y: 2, z: 3 })).toEqual({ x: 1, y: 2, z: 3 });
  expect(share([1, 2], [1, 2])).toEqual([1, 2]);
});
