import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CommandShell } from "@/components/command-shell";
vi.mock("@/lib/use-phone-shell",()=>({usePhoneShell:()=>true}));
vi.mock("@/components/chief-chat",()=>({ChiefChat:()=> <div>Chat contents</div>}));
vi.mock("@/components/today-pane",()=>({TodayPane:()=> <div>Today contents</div>}));
vi.mock("@/components/workforce-pane",()=>({WorkforcePane:()=> <div>Fleet contents</div>}));
vi.mock("@/components/look-drawer",()=>({LookDrawer:()=>null}));
vi.mock("@/components/settings-panel",()=>({SettingsPanel:()=>null}));
vi.mock("@/lib/bridge",()=>({
  subscribeBridge:(fn:(signal:AbortSignal)=>Promise<void>)=>{const ac=new AbortController();void fn(ac.signal);return()=>ac.abort();},
  fetchHealth:async()=>({ok:true}),fetchSnapshot:async()=>({ok:true,roster:[]}),
  fetchApprovals:async()=>({ok:true,approval:{requestId:"test",command:"fixture",reason:"test"}}),
}));
afterEach(()=>{cleanup();localStorage.clear();});
const pill=()=>screen.findByRole("button",{name:"Nova needs your approval — open Chat"});
it("badges Chat, floats an approval pill on Today and Fleet, and the pill opens Chat",async()=>{
  render(<CommandShell/>);
  expect(await screen.findByText("Approval pending")).toBeInTheDocument();
  for(const tab of ["Today","Fleet"]){
    fireEvent.click(screen.getByRole("button",{name:tab}));
    const notice=await pill();
    await waitFor(()=>expect(notice).toBeVisible());
  }
  fireEvent.click(await pill());
  expect(screen.getByText("Chat contents")).toBeVisible();
  await waitFor(()=>expect(screen.queryByRole("button",{name:"Nova needs your approval — open Chat"})).toBeNull());
});
