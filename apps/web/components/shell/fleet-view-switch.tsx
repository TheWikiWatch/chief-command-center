"use client";

import { ViewSwitch } from "@/components/ui/controls";
import { FleetView } from "@/components/shell/persisted";

/* Fleet's Crew / Health switch. */

/** Fleet surface: the crew (orbit / list) or its health (scorecards, learning, runtime, proposals). */
export function FleetViewSwitch({ view, onChange, flags = 0 }: { view: FleetView; onChange: (next: FleetView) => void; flags?: number }) {
  const health = (
    <>
      Health
      {flags ? (
        <span className="ml-1.5 inline-grid min-w-[18px] place-items-center rounded-full bg-warn/20 px-1 font-mono text-micro leading-[18px] text-warn tabular" aria-label={`${flags} new ${flags === 1 ? "flag" : "flags"}`}>
          {flags}
        </span>
      ) : null}
    </>
  );
  return <ViewSwitch label="Fleet view" value={view} onChange={onChange} glass options={[["crew", "Crew"], ["health", health]]} />;
}
