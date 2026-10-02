import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FleetInvite, FleetSide, SPECIALIST_IDEAS } from "@/components/fleet/fleet-side";
import { recordRosterEvent, resetFleetActivity } from "@/lib/fleet-activity";
import type { Person } from "@/lib/types";

afterEach(() => {
  cleanup();
  resetFleetActivity();
});

const bot = (id: string, name: string, extra: Partial<Person> = {}): Person => ({
  id, name, title: name, description: "", section: "", shape: "circle", color: "", imageKind: "", custom: false,
  model: "", provider: "", flavor: "", isChief: false, ring: "idle", jobTitle: "", ...extra,
});

describe("the Fleet beside the orbit", () => {
  it("invites the owner to bring on a specialist, filling the message box", () => {
    const onAsk = vi.fn();
    render(<FleetInvite onAsk={onAsk} />);
    fireEvent.click(screen.getByRole("button", { name: SPECIALIST_IDEAS[1].label }));
    expect(onAsk).toHaveBeenCalledWith(SPECIALIST_IDEAS[1].ask);
  });

  it("lists the crew, working first, and this session's activity newest first", () => {
    const ada = bot("ada", "Ada - Researcher");
    const ben = bot("ben", "Ben - Writer", { ring: "working", jobTitle: "Draft the newsletter" });
    const onOpen = vi.fn();
    render(<FleetSide chief={undefined} specialists={[ada, ben]} onOpen={onOpen} />);
    expect(screen.getByText(/Nothing yet this session/)).toBeInTheDocument();
    const crew = [...screen.getByRole("list", { name: "Crew" }).querySelectorAll("li")].map((li) => li.textContent);
    expect(crew[0]).toContain("Draft the newsletter");
    expect(crew[1]).toContain("Researcher");

    act(() => {
      recordRosterEvent({ kind: "minted", person: ada }, 1000);
      recordRosterEvent({ kind: "dispatched", person: ben }, 2000);
    });
    const activity = screen.getByRole("list", { name: "Activity" }).querySelectorAll("li");
    expect(activity[0].textContent).toContain("Ben picked up work");
    expect(activity[0].textContent).toContain("Draft the newsletter");
    expect(activity[1].textContent).toContain("Ada joined");
    fireEvent.click(screen.getAllByRole("button", { name: "Ben" })[0]);
    expect(onOpen).toHaveBeenCalledWith(ben);
  });
});
