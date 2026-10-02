import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { IntentSheet } from "@/components/today/intent-sheet";
const launch=vi.hoisted(()=>vi.fn());
vi.mock("@/lib/ops",()=>({ops:{launch}}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
it("keeps the sheet on rejection, reuses the prepared kickoff, and awaits acceptance",async()=>{
  launch.mockResolvedValue({kickoff:"prepared task"});
  let accept!:()=>void;
  const send=vi.fn().mockRejectedValueOnce(new Error("Chat busy")).mockImplementation(()=>new Promise<void>(r=>{accept=r;}));
  render(<IntentSheet target={{kind:"focus",board_name:"test",ui_label:"test",color:"red",title:"Test task",kicker:"test"}} onClose={vi.fn()} onSent={send}/>);
  fireEvent.click(screen.getByText("Send to Nova"));await screen.findByText("Chat busy");expect(screen.getByText("Test task")).toBeVisible();
  fireEvent.click(screen.getByText("Send to Nova"));await screen.findByText("Sending…");expect(screen.getByText("Close")).toBeDisabled();
  await act(async()=>accept());expect(screen.getByText("Send to Nova")).toBeEnabled();expect(launch).toHaveBeenCalledTimes(1);expect(send).toHaveBeenCalledTimes(2);
});
