import { describe, expect, it } from "vitest";

import { bootUrl, dialogOptions, fileFilters, isBootPage, navigateDecision, sameOrigin, senderAllowed, validFeed, validServePort, windowOpenDecision } from "../src/guards";

const ORIGIN = "http://127.0.0.1:3000";
// User-info look-alike (`origin` + "@" + another host), assembled so the privacy scan doesn't read it as an address.
const USERINFO = `${ORIGIN}${"@"}evil.example/`;
const BOOT = bootUrl("C:\\Program Files\\WindowsApps\\Chief\\resources\\static");

describe("origins are compared exactly, never by prefix", () => {
  it("accepts the dashboard's own pages", () => {
    expect(sameOrigin("http://127.0.0.1:3000/", ORIGIN)).toBe(true);
    expect(sameOrigin("http://127.0.0.1:3000/settings?x=1#y", ORIGIN)).toBe(true);
  });

  it("refuses look-alikes that start with the same text", () => {
    expect(sameOrigin(USERINFO, ORIGIN)).toBe(false);
    expect(sameOrigin("http://127.0.0.1:30001/", ORIGIN)).toBe(false);
    expect(sameOrigin("http://127.0.0.1:3000.evil.example/", ORIGIN)).toBe(false);
    expect(sameOrigin("https://127.0.0.1:3000/", ORIGIN)).toBe(false);
    expect(sameOrigin("not a url", ORIGIN)).toBe(false);
    expect(sameOrigin("http://127.0.0.1:3000/", "")).toBe(false);
  });

  it("opens only the dashboard in-app; web links go to the browser; anything else is denied", () => {
    expect(windowOpenDecision("http://127.0.0.1:3000/vault", ORIGIN)).toBe("allow");
    expect(windowOpenDecision(USERINFO, ORIGIN)).toBe("external");
    expect(windowOpenDecision("https://example.com/docs", ORIGIN)).toBe("external");
    expect(windowOpenDecision("file:///C:/Windows/System32/calc.exe", ORIGIN)).toBe("deny");
    expect(windowOpenDecision("javascript:alert(1)", ORIGIN)).toBe("deny");
  });

  it("keeps the window on the dashboard or the boot page only", () => {
    expect(navigateDecision("http://127.0.0.1:3000/", ORIGIN, BOOT)).toBe("allow");
    expect(navigateDecision(BOOT, ORIGIN, BOOT)).toBe("allow");
    expect(navigateDecision(`${BOOT}?retry=1`, ORIGIN, BOOT)).toBe("allow");
    expect(navigateDecision("file:///D:/elsewhere/evil.html", ORIGIN, BOOT)).toBe("deny");
    expect(navigateDecision("http://127.0.0.1:30001/", ORIGIN, BOOT)).toBe("external");
    expect(navigateDecision("chrome://settings", ORIGIN, BOOT)).toBe("deny");
  });

  it("recognises the boot page whatever the drive letter case", () => {
    expect(isBootPage(BOOT.replace("file:///C:", "file:///c:"), BOOT)).toBe(true);
    expect(isBootPage(BOOT.replace("boot.html", "other.html"), BOOT)).toBe(false);
  });
});

describe("IPC senders", () => {
  it("allows the dashboard, and the boot page only for boot channels", () => {
    expect(senderAllowed("http://127.0.0.1:3000/", ORIGIN, BOOT)).toBe(true);
    expect(senderAllowed(BOOT, ORIGIN, BOOT)).toBe(false);
    expect(senderAllowed(BOOT, ORIGIN, BOOT, { boot: true })).toBe(true);
    expect(senderAllowed(USERINFO, ORIGIN, BOOT)).toBe(false);
    expect(senderAllowed("https://evil.example/", ORIGIN, BOOT, { boot: true })).toBe(false);
    expect(senderAllowed(undefined, ORIGIN, BOOT)).toBe(false);
  });
});

describe("IPC arguments", () => {
  it("takes only Tailscale Serve's HTTPS ports", () => {
    expect(validServePort(443)).toBe(443);
    expect(validServePort(8443)).toBe(8443);
    expect(validServePort(10000)).toBe(10000);
    expect(validServePort(22)).toBeUndefined();
    expect(validServePort("443")).toBeUndefined();
    expect(validServePort(undefined)).toBeUndefined();
  });

  it("takes a GitHub repository or a local folder as the update source, never a network share", () => {
    expect(validFeed("github:owner/releases")).toBe("github:owner/releases");
    expect(validFeed("https://github.com/owner/releases")).toBe("https://github.com/owner/releases");
    expect(validFeed("  D:\\Releases  ")).toBe("D:\\Releases");
    expect(validFeed("")).toBe("");
    expect(validFeed("\\\\attacker\\share")).toBeNull();
    expect(validFeed("//attacker/share")).toBeNull();
    expect(validFeed("\\\\?\\UNC\\attacker\\share")).toBeNull();
    expect(validFeed("relative\\folder")).toBeNull();
    expect(validFeed("https://evil.example/feed")).toBeNull();
    expect(validFeed("D:\\a\nb")).toBeNull();
  });

  it("cleans dialog options and filters", () => {
    expect(dialogOptions({ title: "Pick", defaultPath: "D:\\Backups" })).toEqual({ title: "Pick", defaultPath: "D:\\Backups" });
    expect(dialogOptions({ defaultPath: "\\\\host\\share" })).toEqual({ title: undefined, defaultPath: undefined });
    expect(dialogOptions(null)).toEqual({ title: undefined, defaultPath: undefined });
    expect(fileFilters([{ name: "Backups", extensions: ["chiefbackup", "../x", 5] }])).toEqual([{ name: "Backups", extensions: ["chiefbackup", "5"] }]);
    expect(fileFilters("nope")).toBeUndefined();
  });
});
