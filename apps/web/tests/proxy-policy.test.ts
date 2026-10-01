// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/bridge/[...path]/route";
import { PUT as opsPut } from "@/app/api/ops/[...path]/route";
import { deniedFilePath, permittedOperation, protectFileHeaders, validMutationOrigin } from "@/lib/proxy-policy";

afterEach(() => vi.unstubAllGlobals());
describe("proxy trust boundary", () => {
  it("accepts exact local and Serve origins, rejecting foreign, missing and null origins", () => {
    for (const host of ["127.0.0.1:3000", "localhost:3000", "chief.example.ts.net"]) {
      const origin = `${host.includes("ts.net") ? "https" : "http"}://${host}`;
      expect(validMutationOrigin(new Headers({ host, origin }), origin)).toBe(true);
      for (const bad of ["https://evil.example", "null", origin + "/path"]) expect(validMutationOrigin(new Headers({host, origin: bad}), origin)).toBe(false);
      expect(validMutationOrigin(new Headers({host}), origin)).toBe(false);
    }
  });
  it("permits only explicit routes and rejects encoded traversal and extra segments", () => {
    expect(permittedOperation("bridge", "GET", ["profile", "dave-dev"])).toBe(true);
    for (const p of [["profile", ".."], ["file", "extra"], ["profile", "%2f"], ["outbox"], ["settings", "delete"]]) expect(permittedOperation("bridge", "GET", p)).toBe(false);
    // Provider setup: reads by GET, changes by POST only; nothing else under setup/.
    for (const p of [["setup", "status"], ["setup", "providers"], ["setup", "models"]]) expect(permittedOperation("bridge", "GET", p)).toBe(true);
    for (const p of [["setup", "key"], ["setup", "model"], ["setup", "endpoint", "check"], ["setup", "endpoint", "save"], ["setup", "test"]]) expect(permittedOperation("bridge", "POST", p)).toBe(true);
    expect(permittedOperation("bridge", "GET", ["setup", "key"])).toBe(false);
    expect(permittedOperation("bridge", "POST", ["setup", "status"])).toBe(false);
    expect(permittedOperation("bridge", "POST", ["setup", "secrets"])).toBe(false);
    expect(permittedOperation("ops", "PUT", ["settings"])).toBe(true);
    expect(permittedOperation("ops", "PUT", ["boards"])).toBe(false);
    // Settings → Phone: the alert device count by GET; a test alert and stopping alerts by POST.
    expect(permittedOperation("bridge", "GET", ["push", "subscriptions"])).toBe(true);
    for (const p of [["push", "test"], ["push", "unsubscribe"]]) expect(permittedOperation("bridge", "POST", p)).toBe(true);
    expect(permittedOperation("bridge", "GET", ["push", "test"])).toBe(false);
  });
  it("blocks writes before forwarding and permits same-origin JSON mutations", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ok:true})); vi.stubGlobal("fetch", fetcher);
    const url = "http://127.0.0.1:3000/api/bridge/send";
    const context = {params:Promise.resolve({path:["send"]})};
    expect((await POST(new NextRequest(url,{method:"POST",body:"{}"}), context)).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await POST(new NextRequest(url,{method:"POST",headers:{host:"127.0.0.1:3000",origin:"http://127.0.0.1:3000","content-type":"application/json"},body:"{}"}),context)).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await opsPut(new NextRequest("http://127.0.0.1:3000/api/ops/boards",{method:"PUT"}),{params:Promise.resolve({path:["boards"]})})).status).toBe(404);
  });
  it("denies token filenames even before an older installed bridge sees them", async () => {
    const fetcher=vi.fn(); vi.stubGlobal("fetch",fetcher);
    const req=new NextRequest("http://127.0.0.1:3000/api/bridge/file?path="+encodeURIComponent("C:\\fixture\\.token"));
    expect((await GET(req,{params:Promise.resolve({path:["file"]})})).status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("refuses Hermes databases and NTFS stream paths before the bridge sees them", async () => {
    const fetcher=vi.fn().mockResolvedValue(new Response("x",{headers:{"content-type":"image/png"}})); vi.stubGlobal("fetch",fetcher);
    for (const bad of ["C:\\h\\profiles\\chief\\state.db-wal","C:\\h\\kanban.db","C:\\h\\x.sqlite3","C:\\h\\auth.json::$DATA","C:\\h\\a.png:hidden"]) {
      expect(deniedFilePath(bad)).toBe(true);
      const req=new NextRequest("http://127.0.0.1:3000/api/bridge/file?path="+encodeURIComponent(bad));
      expect((await GET(req,{params:Promise.resolve({path:["file"]})})).status).toBe(404);
    }
    expect(fetcher).not.toHaveBeenCalled();
    for (const ok of ["C:\\Users\\me\\Pictures\\shot.png","E:\\projects\\notes.md","/tmp/debug.log"]) expect(deniedFilePath(ok)).toBe(false);
  });
  it("lets thumbnails cache but never originals or failed thumbnails", async () => {
    const context=(p:string)=>({params:Promise.resolve({path:[p]})});
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response("jpg",{headers:{"content-type":"image/jpeg"}})));
    expect((await GET(new NextRequest("http://127.0.0.1:3000/api/bridge/thumb?path=v.mp4"),context("thumb"))).headers.get("cache-control")).toBe("private, max-age=3600");
    expect((await GET(new NextRequest("http://127.0.0.1:3000/api/bridge/file?path=v.png"),context("file"))).headers.get("cache-control")).toBe("private, no-store");
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json({ok:false},{status:404})));
    expect((await GET(new NextRequest("http://127.0.0.1:3000/api/bridge/thumb?path=v.mp4"),context("thumb"))).headers.get("cache-control")).toBe("private, no-store");
  });
  it("says Today needs a Second Brain when neither Ops nor a Second Brain folder is configured", async () => {
    // The only call is to the chief's bridge, asking which Second Brain folder it was set up with.
    const fetcher=vi.fn().mockResolvedValue(Response.json({ok:true,configured:false,path:""})); vi.stubGlobal("fetch",fetcher);
    const res=await opsPut(new NextRequest("http://127.0.0.1:3000/api/ops/settings",{method:"PUT",headers:{host:"127.0.0.1:3000",origin:"http://127.0.0.1:3000","content-type":"application/json"},body:JSON.stringify({vault_path:"x"})}),{params:Promise.resolve({path:["settings"]})});
    expect(res.status).toBe(404);
    expect((await res.json()).setup).toBe(true);
    expect(fetcher.mock.calls.map((c)=>String(c[0]))).toEqual(["http://127.0.0.1:7790/setup/second-brain"]);
  });
  it("forwards only vault_path to Ops settings", async () => {
    process.env.CHIEF_OPS_URL="http://127.0.0.1:8790";
    const fetcher=vi.fn().mockResolvedValue(Response.json({ok:true})); vi.stubGlobal("fetch",fetcher);
    const put=(body:unknown)=>opsPut(new NextRequest("http://127.0.0.1:3000/api/ops/settings",{method:"PUT",headers:{host:"127.0.0.1:3000",origin:"http://127.0.0.1:3000","content-type":"application/json"},body:JSON.stringify(body)}),{params:Promise.resolve({path:["settings"]})});
    expect((await put({vault_path:" E:\\Second Brain ",hermes_cmd:"calc.exe",poll_seconds:1})).status).toBe(200);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({vault_path:"E:\\Second Brain"});
    expect((await put({hermes_cmd:"calc.exe"})).status).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(1);
    delete process.env.CHIEF_OPS_URL;
  });
  it("sandboxes active documents while preserving passive media and ranges", async () => {
    const fetcher=vi.fn().mockResolvedValue(new Response("<svg/>",{headers:{"content-type":"image/svg+xml","content-disposition":"inline; filename=demo.svg"}})); vi.stubGlobal("fetch",fetcher);
    const result=await GET(new NextRequest("http://127.0.0.1:3000/api/bridge/file?path=demo.svg"),{params:Promise.resolve({path:["file"]})});
    expect(result.headers.get("content-security-policy")).toContain("sandbox;");
    expect(result.headers.get("content-disposition")).toContain("attachment");
    for(const type of ["image/png","audio/mpeg","video/mp4","application/pdf"]){
      const headers=new Headers({"content-type":type,"content-disposition":"inline","content-range":"bytes 0-9/20"}); protectFileHeaders(headers);
      expect(headers.get("content-disposition")).toBe("inline"); expect(headers.get("content-range")).toBe("bytes 0-9/20");
    }
  });
});
