import { beforeEach, expect, it } from "vitest";

import { LAST_CHIEF_KEY, readLastChief } from "@/lib/identity";

beforeEach(() => localStorage.clear());

it("moves the chief record an earlier version saved under its old key, once", () => {
  localStorage.setItem("chief-last-earlier", JSON.stringify({ id: "chief", name: "Nova - Chief of Staff" }));
  expect(readLastChief()).toMatchObject({ id: "chief", name: "Nova - Chief of Staff" });
  expect(localStorage.getItem("chief-last-earlier")).toBeNull();
  expect(JSON.parse(localStorage.getItem(LAST_CHIEF_KEY) || "{}").name).toBe("Nova - Chief of Staff");
  expect(readLastChief()).toMatchObject({ id: "chief" });
});

it("ignores anything that isn't the chief's record", () => {
  localStorage.setItem(LAST_CHIEF_KEY, JSON.stringify({ id: "ada", name: "Ada" }));
  expect(readLastChief()).toBeNull();
  localStorage.setItem(LAST_CHIEF_KEY, "not json");
  expect(readLastChief()).toBeNull();
});
