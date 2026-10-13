import { describe, expect, it } from "vitest";

import { confirmFeed, confirmForcedRestart, confirmInstall, confirmPhoneAccess, confirmRestore, skipAllowed } from "../src/owner-confirm";
import { belowFloor, releaseFloor } from "../src/updater";

/* Security review S10: the shell itself asks before the actions a page could otherwise start alone. */

describe("what the shell asks the owner", () => {
  it("says plainly when a chosen version is older than the running one", () => {
    expect(confirmInstall("0.1.30", "0.1.40")).toMatchObject({ message: "Go back to Chief 0.1.30?", ok: "Go back to 0.1.30" });
    expect(confirmInstall("0.1.41", "0.1.40")).toMatchObject({ message: "Install Chief 0.1.41?", ok: "Install 0.1.41" });
  });

  it("asks before a restart only when it would interrupt work", () => {
    expect(confirmForcedRestart([])).toBeNull();
    expect(confirmForcedRestart(["Chief is answering in chat."])?.detail).toContain("Chief is answering in chat.");
  });

  it("asks before the update source changes, not when it's saved unchanged", () => {
    expect(confirmFeed("github:a/b", "github:a/b")).toBeNull();
    expect(confirmFeed("D:\\updates", "github:a/b")?.detail).toContain("D:\\updates");
  });

  it("asks before opening Chief to the whole tailnet, never before narrowing it", () => {
    expect(confirmPhoneAccess("owner")).toBeNull();
    expect(confirmPhoneAccess("tailnet")?.ok).toBe("Allow the whole tailnet");
  });

  it("always asks before a restore, and names the work it would stop", () => {
    expect(confirmRestore([]).message).toBe("Restore this backup?");
    expect(confirmRestore(["A routine is running."]).detail).toContain("A routine is running.");
  });
});

describe("a page can't pre-skip or downgrade around the owner", () => {
  it("skips only the version on offer", () => {
    expect(skipAllowed("0.1.41", "0.1.41")).toBe(true);
    expect(skipAllowed("0.1.42", "0.1.41")).toBe(false);
    expect(skipAllowed("0.1.41", null)).toBe(false);
    expect(skipAllowed("x", "x")).toBe(false);
  });

  it("the signed floor is the highest any verified release names", () => {
    expect(releaseFloor([])).toBe("");
    expect(releaseFloor([{}, { floor: "0.1.40" }, { floor: "0.1.9" }, { floor: "nonsense" }])).toBe("0.1.40");
    expect(belowFloor("0.1.39", "0.1.40")).toBe(true);
    expect(belowFloor("0.1.40", "0.1.40")).toBe(false);
    expect(belowFloor("0.1.1", "")).toBe(false);
  });
});
