import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { enqueueSpeechTask, stopSpeech, pauseSpeech, resumeSpeech } from "@/lib/voice-client";
class AudioMock extends EventTarget {
  static clips:AudioMock[]=[];
  src=""; paused=true;
  constructor(src=""){super();this.src=src;if(!src)AudioMock.clips.push(this);}
  setAttribute(){} removeAttribute(){this.src="";} load(){} pause(){this.paused=true;}
  play(){this.paused=false;return Promise.resolve();}
}
beforeEach(()=>{AudioMock.clips=[];vi.stubGlobal("Audio",AudioMock);});
afterEach(()=>{stopSpeech();vi.unstubAllGlobals();});
async function flush(){for(let i=0;i<20;i++)await Promise.resolve();}
it("synthesizes and plays replies in order, completing only after ended",async()=>{
  let resolveFirst!:(url:string)=>void;
  const first=vi.fn(()=>new Promise<string>(r=>{resolveFirst=r;})), second=vi.fn(async()=>"second");
  const a=enqueueSpeechTask(first), b=enqueueSpeechTask(second);expect(second).not.toHaveBeenCalled();
  resolveFirst("first");await flush();const clip=AudioMock.clips.at(-1)!;expect(clip.src).toBe("first");
  pauseSpeech();expect(clip.paused).toBe(true);await resumeSpeech();expect(clip.src).toBe("first");
  clip.dispatchEvent(new Event("ended"));expect(await a).toEqual({status:"played"});await flush();expect(clip.src).toBe("second");
  clip.dispatchEvent(new Event("ended"));expect(await b).toEqual({status:"played"});
});
it("keeps playing when a reused player aborts the previous clip",async()=>{
  const job=enqueueSpeechTask(async()=>"clip");
  await flush();
  const clip=AudioMock.clips.at(-1)!;
  clip.dispatchEvent(new Event("abort"));
  clip.dispatchEvent(new Event("error"));
  expect(clip.paused).toBe(false);
  clip.dispatchEvent(new Event("ended"));
  expect(await job).toEqual({status:"played"});
});
it("reports synthesis failure and cancels pending jobs on Stop",async()=>{
  expect(await enqueueSpeechTask(async()=>{throw new Error("provider down");})).toEqual({status:"failed",reason:"provider down"});
  const a=enqueueSpeechTask(()=>new Promise(()=>{}));const b=enqueueSpeechTask(async()=>"second");stopSpeech();
  expect(await a).toEqual({status:"cancelled"});expect(await b).toEqual({status:"cancelled"});
});
