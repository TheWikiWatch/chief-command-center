import { afterEach, expect, it } from "vitest";

import { assistantName, DEFAULT_ASSISTANT_NAME, ownerName, resetIdentity, setAssistantTitle, setOwnerName } from "@/lib/identity";

afterEach(() => localStorage.clear());

it("a fresh install calls the assistant Chief and addresses nobody by name", () => {
  resetIdentity();
  expect(assistantName()).toBe(DEFAULT_ASSISTANT_NAME);
  expect(DEFAULT_ASSISTANT_NAME).toBe("Chief");
  expect(ownerName()).toBe("");
});

it("takes the chief's name from its profile title and remembers it", () => {
  resetIdentity();
  setAssistantTitle("Ada - Chief of Staff");
  expect(assistantName()).toBe("Ada");
  expect(localStorage.getItem("chief-assistant-name")).toBe("Ada");
  setAssistantTitle("");
  expect(assistantName()).toBe("Ada");
});

it("uses the owner's configured name", () => {
  setOwnerName("  Sam ");
  expect(ownerName()).toBe("Sam");
});
