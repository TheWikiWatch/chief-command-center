import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-23T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const PAGE = "<p>Peak: 01:00 – 04:00 and 06:00 – 10:00 UTC, Monday through Friday, except public holidays.</p>";

it("checks once a day, and after a failure waits an hour instead of refetching on every request", async () => {
  const fetchMock = vi.fn(async () => new Response(PAGE, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const { GET } = await import("@/app/api/deepseek-schedule/route");

  expect((await (await GET()).json()).status).toBe("match");
  await GET();
  expect(fetchMock).toHaveBeenCalledTimes(1);

  // A day later the page is down: keep the last answer.
  vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000 + 1);
  fetchMock.mockRejectedValue(new Error("offline"));
  expect((await (await GET()).json()).status).toBe("match");
  await GET();
  await GET();
  expect(fetchMock).toHaveBeenCalledTimes(2);

  // An hour later it tries again.
  vi.setSystemTime(Date.now() + 60 * 60 * 1000 + 1);
  await GET();
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("shares one fetch between requests that arrive together", async () => {
  let release!: (r: Response) => void;
  const fetchMock = vi.fn(() => new Promise<Response>((r) => (release = r)));
  vi.stubGlobal("fetch", fetchMock);
  const { GET } = await import("@/app/api/deepseek-schedule/route");
  const a = GET();
  const b = GET();
  release(new Response(PAGE));
  await Promise.all([a, b]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
