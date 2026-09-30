import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MicButton } from "@/components/mic-button";
import { stopSpeech } from "@/lib/voice-client";
const mocks=vi.hoisted(()=>({transcribe:vi.fn(),permission:vi.fn(),stop:vi.fn()}));
vi.mock("@/lib/bridge",()=>({transcribeAudio:mocks.transcribe}));
vi.mock("@/lib/voice-client",()=>({blobToDataUrl:async()=>"data:audio/webm;base64,AAA=",holdWakeLock:vi.fn(),releaseWakeLock:vi.fn(),pickRecorderMime:()=>"audio/webm",stopSpeech:vi.fn(),unlockAudio:async()=>{}}));
class Recorder {
  state="inactive"; mimeType="audio/webm";
  onstop:(()=>void)|null=null; ondataavailable:((e:{data:Blob})=>void)|null=null;
  start(){this.state="recording";}
  stop(){this.state="inactive";this.ondataavailable?.({data:new Blob(["x".repeat(1024)])});this.onstop?.();}
}
beforeEach(()=>{
  vi.clearAllMocks(); vi.stubGlobal("MediaRecorder",Recorder);
  Object.defineProperty(navigator,"mediaDevices",{configurable:true,value:{getUserMedia:mocks.permission}});
  HTMLElement.prototype.setPointerCapture=vi.fn();
  mocks.permission.mockResolvedValue({getTracks:()=>[{stop:mocks.stop}]});
  mocks.transcribe.mockResolvedValue({ok:true,transcript:"hello"});
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});
async function recording(){fireEvent.pointerDown(screen.getByRole("button"));await screen.findByRole("button",{name:"Release to send"});}
it("discards pointer cancellation without transcribing",async()=>{
  const send=vi.fn();render(<MicButton onTranscript={send} onError={vi.fn()}/>);await recording();
  fireEvent.pointerCancel(screen.getByRole("button"));
  expect(mocks.transcribe).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();expect(mocks.stop).toHaveBeenCalled();
});
it("discards on unmount and releases a late permission grant",async()=>{
  let grant!:(stream:unknown)=>void;mocks.permission.mockImplementation(()=>new Promise(r=>{grant=r;}));
  const view=render(<MicButton onTranscript={vi.fn()} onError={vi.fn()}/>);
  fireEvent.pointerDown(screen.getByRole("button"));await waitFor(()=>expect(mocks.permission).toHaveBeenCalled());view.unmount();
  await act(async()=>grant({getTracks:()=>[{stop:mocks.stop}]}));
  expect(mocks.stop).toHaveBeenCalled();expect(mocks.transcribe).not.toHaveBeenCalled();
});
it("sends a deliberate release and returns to idle",async()=>{
  let now=1000;vi.spyOn(Date,"now").mockImplementation(()=>now);
  const send=vi.fn();render(<MicButton onTranscript={send} onError={vi.fn()}/>);await recording();now+=800;
  fireEvent.pointerUp(screen.getByRole("button"));await waitFor(()=>expect(send).toHaveBeenCalledWith("hello"));
  expect(screen.getByRole("button",{name:"Hold to talk"})).toBeEnabled();
});
it("does not stop speech when the page hides", () => {
  render(<MicButton onTranscript={vi.fn()} onError={vi.fn()} />);
  const previous = Object.getOwnPropertyDescriptor(document, "visibilityState");
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  document.dispatchEvent(new Event("visibilitychange"));
  expect(stopSpeech).not.toHaveBeenCalled();
  if (previous) Object.defineProperty(document, "visibilityState", previous);
  else Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
it("records while Space is held on the focused button and sends on release", async () => {
  let now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const send = vi.fn();
  render(<MicButton onTranscript={send} onError={vi.fn()} />);
  const button = screen.getByRole("button");
  fireEvent.keyDown(button, { key: " " });
  fireEvent.keyDown(button, { key: " ", repeat: true });
  await screen.findByRole("button", { name: "Release to send" });
  now += 800;
  fireEvent.keyUp(button, { key: " " });
  await waitFor(() => expect(send).toHaveBeenCalledWith("hello"));
  expect(mocks.permission).toHaveBeenCalledTimes(1);
});
