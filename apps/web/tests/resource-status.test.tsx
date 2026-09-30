import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ResourceStatus } from "@/components/resource-status";
afterEach(()=>{cleanup();vi.useRealTimers();});
it("shows a resource going stale even when its next request never resolves",async()=>{
  vi.useFakeTimers();vi.setSystemTime(10_000);
  const view=render(<ResourceStatus label="Chat" health={{updatedAt:10_000,error:null}} staleAfter={5000}/>);
  expect(screen.getByText(/Chat: updated/)).toBeVisible();
  await act(async()=>vi.advanceTimersByTimeAsync(5000));expect(screen.getByText(/Chat: stale/)).toBeVisible();
  view.rerender(<ResourceStatus label="Chat" health={{updatedAt:15_000,error:null}} staleAfter={5000}/>);
  expect(screen.getByText(/Chat: updated 0s/)).toBeVisible();
});
