import { afterEach, describe, expect, it, vi } from "vitest";
import { poll } from "@/lib/poll";
import { requestJson } from "@/lib/request";

afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
describe("bounded polling",()=>{
  it("does not overlap slow requests and refreshes once after foregrounding", async()=>{
    vi.useFakeTimers(); let finish!:()=>void;
    const run=vi.fn((_signal: AbortSignal)=>new Promise<void>(r=>{finish=r;}));
    const stop=poll(run,800);
    await vi.advanceTimersByTimeAsync(5000); expect(run).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("online"));
    expect(run).toHaveBeenCalledTimes(1);
    finish(); await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(2);
    const signal=run.mock.calls[1][0]; stop(); expect(signal.aborted).toBe(true);
    finish(); await vi.advanceTimersByTimeAsync(5000); expect(run).toHaveBeenCalledTimes(2);
  });
  it("slows to 5s while hidden and catches up at once on return",async()=>{
    vi.useFakeTimers();
    let visibility:DocumentVisibilityState="hidden";
    Object.defineProperty(document,"visibilityState",{configurable:true,get:()=>visibility});
    const run=vi.fn(async(_signal:AbortSignal)=>undefined);
    const stop=poll(run,800);
    await vi.advanceTimersByTimeAsync(4000); expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1001); expect(run).toHaveBeenCalledTimes(2);
    visibility="visible"; document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(800); expect(run).toHaveBeenCalledTimes(4);
    stop();
    delete (document as unknown as Record<string, unknown>).visibilityState;
  });
  it("aborts a stalled body read, not just the fetch header phase",async()=>{
    vi.useFakeTimers();
    vi.stubGlobal("fetch",vi.fn((_url,init)=>Promise.resolve({ok:true,status:200,json:()=>new Promise((_r,reject)=>init.signal.addEventListener("abort",()=>reject(new Error("aborted"))))})));
    const pending=requestJson("/test",{},100);
    const check=expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(101); await check;
  });
  it("rejects invalid JSON and preserves HTTP auth status",async()=>{
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response("html",{status:502})));
    await expect(requestJson("/test")).rejects.toThrow("Invalid response");
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json({error:"unauthorized"},{status:401})));
    await expect(requestJson("/test")).rejects.toMatchObject({status:401});
  });
});
