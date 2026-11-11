// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { modifyRouteRegex } from "next/dist/lib/redirect-status";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import config from "@/next.config";
import { GET as bridgeGet } from "@/app/api/bridge/[...path]/route";
import { GET as vaultGet } from "@/app/api/vault/file/route";
import { deniedFilePath } from "@/lib/proxy-policy";

/* Security review S1 and S2: the file routes' own headers reach the browser, and no file path reaches the network. */

// next/constants loads helpers Vitest's runner can't (an ESM file in a CommonJS package); the config needs only this.
vi.mock("next/constants", () => ({ PHASE_DEVELOPMENT_SERVER: "phase-development-server" }));

/** The config's headers for a path, matched the way Next's server matches its header rules (router-utils/filesystem.js). */
async function configHeaders(pathname: string): Promise<Record<string, string>> {
  const rules = (await config("phase-production-server").headers?.()) ?? [];
  const match = (source: string) => getPathMatch(source, { strict: true, removeUnnamedParams: true, regexModifier: (re) => modifyRouteRegex(re) });
  return Object.fromEntries(rules.filter((rule) => match(rule.source)(pathname)).flatMap((rule) => rule.headers.map((h) => [h.key.toLowerCase(), h.value])));
}

describe("the app-wide headers", () => {
  it("cover every page and route but the file routes, which send their own", async () => {
    for (const page of ["/", "/pair", "/api/bridge/transcript", "/api/bridge/files", "/api/bridge/file/extra", "/api/vault/tree", "/api/vault/files", "/_next/static/chunks/app.js"]) {
      const headers = await configHeaders(page);
      expect(headers["content-security-policy"], page).toContain("frame-ancestors 'none'");
      expect(headers["x-frame-options"], page).toBe("DENY");
    }
    for (const file of ["/api/vault/file", "/api/bridge/file", "/api/bridge/preview", "/api/bridge/thumb"]) {
      expect(await configHeaders(file), file).toEqual({});
    }
  });
});

let vault = "";
beforeAll(() => {
  vault = mkdtempSync(path.join(tmpdir(), "file-headers-"));
  writeFileSync(path.join(vault, "drawing.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  writeFileSync(path.join(vault, "report.pdf"), "%PDF-1.4");
  writeFileSync(path.join(vault, "photo.png"), "png");
  process.env.CHIEF_VAULT_PATH = vault;
});
afterAll(() => {
  delete process.env.CHIEF_VAULT_PATH;
  rmSync(vault, { recursive: true, force: true });
});
afterEach(() => vi.unstubAllGlobals());

const vaultFile = (rel: string, dest = "document") =>
  vaultGet(new NextRequest(`http://127.0.0.1:3000/api/vault/file?path=${encodeURIComponent(rel)}`, { headers: { "sec-fetch-dest": dest } }));

function expectFileSet(res: Response, framing: "none" | "self") {
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(res.headers.get("content-security-policy")).toContain(`frame-ancestors '${framing}'`);
  expect(res.headers.get("x-frame-options")).toBe(framing === "self" ? "SAMEORIGIN" : "DENY");
}

describe("a vault file", () => {
  it("an SVG opened in a tab downloads, sandboxed, and shows in place only as a picture", async () => {
    const opened = await vaultFile("drawing.svg");
    expect(opened.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(opened.headers.get("content-security-policy")).toMatch(/^sandbox;/);
    expectFileSet(opened, "none");
    const pictured = await vaultFile("drawing.svg", "image");
    expect(pictured.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(pictured.headers.get("content-security-policy")).toMatch(/^sandbox;/);
  });

  it("a PDF can be framed by the dashboard itself, for the Vault's preview, and nothing else", async () => {
    const res = await vaultFile("report.pdf", "iframe");
    expect(res.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    expectFileSet(res, "self");
    const image = await vaultFile("photo.png", "image");
    expect(image.headers.get("content-security-policy")).toMatch(/^sandbox;/);
    expectFileSet(image, "none");
  });

  it("a refusal carries the file set too", async () => {
    const res = await vaultFile("missing.png");
    expect(res.status).toBe(404);
    expectFileSet(res, "none");
  });
});

describe("a bridge file", () => {
  const ctx = (route: string) => ({ params: Promise.resolve({ path: [route] }) });
  const get = (route: string, file: string) => bridgeGet(new NextRequest(`http://127.0.0.1:3000/api/bridge/${route}?path=${encodeURIComponent(file)}`), ctx(route));

  it("sends the file set: a sandbox and no framing, or framing by the dashboard for a PDF", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response("x", { headers: { "content-type": String(url).includes(".pdf") ? "application/pdf" : "image/png" } })));
    const pdf = await get("file", "C:\\Users\\me\\report.pdf");
    expect(pdf.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    expectFileSet(pdf, "self");
    for (const route of ["file", "preview", "thumb"]) {
      const res = await get(route, "C:\\Users\\me\\clip.png");
      expect(res.headers.get("content-security-policy"), route).toMatch(/^sandbox;/);
      expectFileSet(res, "none");
    }
  });

  it("a refused path and an unreachable bridge answer with the file set as well", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const denied = await get("file", "\\\\files.example\\share\\x.png");
    expect(denied.status).toBe(404);
    expectFileSet(denied, "none");
    const down = await get("thumb", "C:\\Users\\me\\clip.mp4");
    expect(down.status).toBe(502);
    expectFileSet(down, "none");
  });
});

describe("file paths that reach past this PC", () => {
  it("refuses network shares and NT-namespace paths, in either slash", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    for (const bad of ["\\\\files.example\\share\\x.png", "//files.example/share/x.png", "\\/files.example/share/x.png", "\\\\?\\C:\\Users\\me\\x.png", "\\\\?\\UNC\\files.example\\share\\x.png", "\\\\.\\pipe\\x", "\\??\\UNC\\files.example\\share\\x.png", "//?/C:/x.png"]) {
      expect(deniedFilePath(bad), bad).toBe(true);
      const res = await bridgeGet(new NextRequest(`http://127.0.0.1:3000/api/bridge/file?path=${encodeURIComponent(bad)}`), { params: Promise.resolve({ path: ["file"] }) });
      expect(res.status, bad).toBe(404);
    }
    expect(fetcher).not.toHaveBeenCalled();
    for (const ok of ["C:\\Users\\me\\Pictures\\shot.png", "E:/projects/notes.md", "/tmp/debug.log", "wiki/Concrete Candles.md", "\\Users\\me\\x.png"]) expect(deniedFilePath(ok), ok).toBe(false);
  });
});
