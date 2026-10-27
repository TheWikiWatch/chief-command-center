import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { LocalModelsGroup } from "@/components/settings/local-models";
import type { LocalModel, LocalStatus } from "@/lib/local-models";
import { jobFailure, progressLine } from "@/lib/local-models";
import { permittedOperation } from "@/lib/proxy-policy";

/* Settings → Models on this PC (local_ai.py): the folder comes first, then one click sets up the recommended
   model; each model says whether it fits; a running download shows its progress and pauses. */

let status: LocalStatus;
let catalog: LocalModel[];
let posts: { path: string; body: Record<string, unknown> }[];

beforeEach(() => {
  posts = [];
  status = {
    ok: true,
    enabled: false,
    engine: { installed: false, backend: null, version: null, updateAvailable: false },
    server: { running: false },
    active: null,
    loaded: {},
    models: [],
    machine: { gpu: "Example GPU", vram: "12 GB", vramBytes: 12 * 1024 ** 3, ramBytes: 32 * 1024 ** 3, sharedMemory: false },
    folder: { path: "C:\\hermes\\models", chosen: false, supported: true, suggested: "E:\\Chief models", freeBytes: 120 * 1024 ** 3, models: 0 },
    jobs: [],
  };
  catalog = [
    { id: "qwen-x", display_name: "Qwen X", recommended: true, fits: true, size_label: "16.5 GB", fit_summary: "runs at its full 256K context", vision: true },
    { id: "huge", display_name: "Huge", fits: false, size_label: "155 GB", fit_detail: "exceeds GPU + system memory" },
  ];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const path = new URL(input, "http://127.0.0.1").pathname.replace("/api/bridge/", "");
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posts.push({ path, body });
      if (path === "local-models/folder") status = { ...status, folder: { ...status.folder, chosen: true, path: String(body.path) } };
      return Response.json({ ok: true, job_id: "qs1" });
    }
    if (path === "local-models/catalog") return Response.json({ ok: true, models: catalog });
    return Response.json(status);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("asks for a folder first (the roomiest other drive suggested), then sets up the recommended model in one click", async () => {
  render(<LocalModelsGroup />);
  expect(await screen.findByText(/Example GPU · 12 GB/)).toBeTruthy();
  const setUp = await screen.findByRole("button", { name: "Set it up" });
  expect(setUp).toBeDisabled();
  expect((screen.getByLabelText("Folder for models") as HTMLInputElement).value).toBe("E:\\Chief models");
  fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));
  await waitFor(() => expect(posts[0]).toEqual({ path: "local-models/folder", body: { path: "E:\\Chief models" } }));
  expect(await screen.findByText(/Models go in E:\\Chief models/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Set it up" }));
  await waitFor(() => expect(posts[1]).toEqual({ path: "local-models/quickstart", body: { model: "" } }));
  expect(screen.getByText("Too big for this PC")).toBeTruthy();
});

it("a running download shows its progress and pauses; a downloaded model is used or removed", async () => {
  status = {
    ...status,
    folder: { ...status.folder, chosen: true },
    engine: { installed: true, backend: "cuda", version: "b9000", updateAvailable: false },
    jobs: [{ job_id: "dl1", kind: "model-download", target: "Qwen X", status: "running", phase: "downloading", detail: "Downloading Qwen X", total_bytes: 16 * 1024 ** 3, done_bytes: 4 * 1024 ** 3, percent: 25, bytes_per_sec: 40 * 1024 ** 2, eta_seconds: 300, can_pause: true }],
  };
  catalog = [{ ...catalog[0], downloaded: true, downloaded_model_id: "qwen-x-Q4" }];
  render(<LocalModelsGroup />);
  expect(await screen.findByText("4.0 GB of 16.0 GB · 40 MB/s · about 5 min left")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Pause" }));
  await waitFor(() => expect(posts.find((p) => p.path === "local-models/pause")?.body).toEqual({ job: "dl1" }));
});

it("uses a downloaded model for the chief and asks before removing it", async () => {
  status = { ...status, folder: { ...status.folder, chosen: true }, models: [{ id: "qwen-x-Q4", size_bytes: 1, size_label: "16.5 GB" }] };
  catalog = [{ ...catalog[0], downloaded: true, downloaded_model_id: "qwen-x-Q4" }];
  render(<LocalModelsGroup />);
  const row = (await screen.findByText("Qwen X")).closest("[data-model]") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: /^Use for / }));
  await waitFor(() => expect(posts[0]).toEqual({ path: "local-models/activate", body: { model: "qwen-x-Q4" } }));
  fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
  fireEvent.click(within(row).getAllByRole("button", { name: "Remove" }).at(-1)!);
  await waitFor(() => expect(posts.at(-1)).toEqual({ path: "local-models/remove", body: { model: "qwen-x-Q4" } }));
});

it("with no recommendation for this card, offers the smallest model that runs, and says it's slower", async () => {
  status = { ...status, folder: { ...status.folder, chosen: true } };
  catalog = [
    { id: "big", display_name: "Big", fits: true, size_bytes: 22e9, size_label: "21.9 GB", spilled: true },
    { id: "small", display_name: "Small", fits: true, size_bytes: 16e9, size_label: "16.2 GB", spilled: true },
  ];
  render(<LocalModelsGroup />);
  expect(await screen.findByText(/Set up Small \(16.2 GB\).*answers slower than a cloud model/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Set it up" }));
  await waitFor(() => expect(posts[0]).toEqual({ path: "local-models/quickstart", body: { model: "small" } }));
});

it("follows a running job by its own route, and says a failed one in a sentence", async () => {
  status = {
    ...status,
    folder: { ...status.folder, chosen: true },
    jobs: [{ job_id: "dl1", kind: "model-download", target: "Qwen X", status: "running", phase: "downloading", detail: "Downloading Qwen X", percent: 10 }],
  };
  const seen: string[] = [];
  const inner = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const path = new URL(input, "http://127.0.0.1").pathname.replace("/api/bridge/", "");
    seen.push(path);
    if (path === "local-models/job/dl1") return Response.json({ ok: true, job: { ...status.jobs[0], percent: 60 } });
    return inner(input, init);
  });
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    render(<LocalModelsGroup />);
    expect(await screen.findByRole("progressbar")).toHaveAttribute("aria-valuenow", "10");
    await vi.advanceTimersByTimeAsync(2100);
    await waitFor(() => expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "60"));
    expect(seen.filter((p) => p === "local-models").length).toBe(1);
  } finally {
    vi.useRealTimers();
  }
  expect(jobFailure({ job_id: "j", kind: "model-download", target: "Qwen X", status: "error", phase: "", detail: "", error: "Not enough free space on E:" })).toBe(
    "Couldn't download Qwen X. Not enough free space on E:.",
  );
  expect(jobFailure({ job_id: "j", kind: "quickstart", target: "Qwen X", status: "error", phase: "", detail: "", error: "HTTPError: 503" })).toBe(
    "Couldn't set up Qwen X. Check the free space and the internet connection, then try again.",
  );
});

it("says progress plainly and the proxy forwards the routes", () => {
  expect(progressLine({ job_id: "j", kind: "x", target: "t", status: "running", phase: "p", detail: "", total_bytes: 2 * 1024 ** 3, done_bytes: 1024 ** 3, eta_seconds: 4000 })).toBe(
    "1.0 GB of 2.0 GB · about 1 h 7 min left",
  );
  expect(permittedOperation("bridge", "GET", ["local-models"])).toBe(true);
  expect(permittedOperation("bridge", "GET", ["local-models", "job", "abc123"])).toBe(true);
  expect(permittedOperation("bridge", "POST", ["local-models", "quickstart"])).toBe(true);
  expect(permittedOperation("bridge", "POST", ["local-models", "sideload"])).toBe(false);
});
