import { afterEach, expect, it, vi } from "vitest";
import { enableWebPush } from "@/lib/web-push";
afterEach(()=>vi.unstubAllGlobals());
it("does not ask for permission when the bridge has no push backend",async()=>{
  const permission=vi.fn();
  vi.stubGlobal("Notification",{requestPermission:permission});
  vi.stubGlobal("PushManager",class {});
  Object.defineProperty(navigator,"serviceWorker",{configurable:true,value:{register:vi.fn()}});
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json({error:"not found"},{status:404})));
  expect((await enableWebPush()).ok).toBe(false);
  expect(permission).not.toHaveBeenCalled();
});
