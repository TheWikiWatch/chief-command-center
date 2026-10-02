"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CircleAlertIcon, ClockIcon, SparklesIcon } from "@/components/icons";
import { fetchFleetHealth, markFlagsSeen, refreshFleetHealth, type FleetHealth as Health } from "@/lib/fleet-health";
import { splitTitle } from "@/lib/names";
import { poll } from "@/lib/poll";
import { share } from "@/lib/share";
import { showToast } from "@/lib/toast-store";
import type { Person } from "@/lib/types";
import { useAssistantName } from "@/lib/identity";
import { DeskRow } from "@/components/fleet-health/desks";
import { FlagRow } from "@/components/fleet-health/flags";
import { EmptyCard, RefreshButton, RuntimeCard, Section, Tile } from "@/components/fleet-health/parts";
import { Proposals } from "@/components/fleet-health/proposals";
import { ChangeRow, Skills } from "@/components/fleet-health/skills";

/** Dismissals from before decisions were shared (2026-09-29); sent to the server once, then cleared. */
export const LEGACY_DISMISSED_KEY = "chief-fleet-dismissed";
export const SKILLS_FOLDED = 8;

function ago(seconds: number) {
  if (seconds < 90) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400 * 2) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}
export const agoAt = (epochSeconds: number | null | undefined) => (epochSeconds ? ago(Date.now() / 1000 - epochSeconds) : "never");
export const agoIso = (iso: string | null | undefined) => (iso ? agoAt(Date.parse(iso) / 1000) : "never");
export const day = (epochSeconds: number) => new Date(epochSeconds * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/**
 * Fleet Health (an optional connector): what needs the owner's eyes (flags), desk
 * scorecards, the skills the fleet rewrote grouped with before/after verdicts per episode, runtime
 * health, and the weekly distill's proposals. Reads the learning ledger's report; Revert and Refresh
 * run the ledger; Approve sends the proposal to the chief and records the decision for every device.
 */
export function FleetHealth({
  people,
  phone = false,
  onSendToChief,
}: {
  people: Person[];
  phone?: boolean;
  onSendToChief?: (text: string) => Promise<void>;
}) {
  const assistant = useAssistantName();
  const [data, setData] = useState<Health | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [openSkill, setOpenSkill] = useState<string | null>(null);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(
    () =>
      poll(async (signal) => {
        try {
          const next = await fetchFleetHealth(signal);
          if (signal.aborted) return;
          setData((prev) => share(prev, next));
          setError("");
        } catch (e) {
          if (!signal.aborted) setError(e instanceof Error ? e.message : "Fleet health is unavailable");
        }
      }, 60_000),
    [tick],
  );

  // Looking at Health clears the badge for the flags on screen.
  const flagIds = (data?.flags || []).map((f) => f.id).join("|");
  useEffect(() => {
    if (flagIds) markFlagsSeen(flagIds.split("|"));
  }, [flagIds]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await refreshFleetHealth();
      if (!res.ok) throw new Error(res.error || "Refresh failed");
      setTick((n) => n + 1);
    } catch (e) {
      showToast({ title: "Couldn't refresh", body: e instanceof Error ? e.message : "The ledger failed", tone: "warn", icon: "alert" });
    } finally {
      setRefreshing(false);
    }
  }, []);

  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);

  if (!data) {
    return (
      <div className="px-4 py-6">
        {error ? (
          <EmptyCard icon={<CircleAlertIcon size={22} />} title="Fleet health isn't available" body={error} action={<RefreshButton busy={refreshing} onClick={refresh} label="Run the ledger now" />} />
        ) : (
          <div className="space-y-3" role="status" aria-label="Loading fleet health">
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-[74px] rounded-card bg-fill-1" />
              ))}
            </div>
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="h-14 rounded-card bg-fill-1" style={{ opacity: 1 - i * 0.15 }} />
            ))}
          </div>
        )}
      </div>
    );
  }

  const active = data.desks.filter((d) => d.cards30 > 0 || d.last7.done + d.last7.crashed + d.last7.gaveUp > 0 || d.blocked > 0);
  const idle = data.desks.filter((d) => !active.includes(d));
  const done7 = data.desks.reduce((n, d) => n + d.last7.done, 0);
  const flags = data.flags || [];
  const skills = data.skills;

  function showSkill(key: string) {
    setOpenSkill(key);
    window.requestAnimationFrame(() => document.getElementById(skillAnchor(key))?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  return (
    <div className={`mx-auto max-w-3xl px-4 pb-10 ${phone ? "pt-3" : "pt-2"}`}>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Tile label="Cards done · 7d" value={done7} />
        <Tile label="Crashes · 24h" value={data.runtime.crashes24h} tone={data.runtime.crashes24h ? "danger" : undefined} note={`${data.runtime.crashes7d} in 7 days`} />
        <Tile label="Compactions today" value={data.runtime.compactionsToday} note={`${assistant}'s context`} />
        <Tile label="Skill changes · 7d" value={data.changes7d} note="made by the fleet" />
      </div>

      <div className="mt-3 flex items-center gap-2 text-caption text-fg-3">
        <ClockIcon size={13} />
        <span className={data.ageSeconds > 3 * 3600 ? "text-warn" : undefined}>Updated {ago(data.ageSeconds)}</span>
        <span className="ml-auto">
          <RefreshButton busy={refreshing} onClick={refresh} label="Refresh" small />
        </span>
      </div>

      {flags.length ? (
        <Section title="Needs a look" count={flags.length} hint="Nothing changes until you act">
          <ul className="space-y-2">
            {flags.map((f) => (
              <FlagRow key={f.id} flag={f} onShowSkill={showSkill} onSendToChief={onSendToChief} />
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Desks" count={active.length} hint="Last 7 days · cards done per week">
        <ul className="overflow-hidden rounded-card border border-line bg-card">
          {active.map((d) => (
            <DeskRow key={d.desk} card={d} person={byId.get(d.desk)} />
          ))}
        </ul>
        {idle.length ? (
          <p className="mt-2 px-1 text-caption text-fg-3">
            No work in 30 days: {idle.map((d) => displayDesk(d.desk, byId.get(d.desk))).join(", ")}
          </p>
        ) : null}
      </Section>

      {skills ? (
        <Skills skills={skills} open={openSkill} onOpen={setOpenSkill} onReverted={reload} />
      ) : (
        <Section title="Learning" count={data.changes.length} hint="Skills the fleet changed">
          {data.changes.length ? (
            <ul className="space-y-2">
              {data.changes.map((c) => (
                <ChangeRow key={c.id} change={c} title={c.skill?.split("/").pop() || c.file} onReverted={reload} />
              ))}
            </ul>
          ) : (
            <EmptyCard icon={<SparklesIcon size={20} />} title="No skill changes recorded yet" body={`Changes appear here as background review and ${assistant} edit skills.`} />
          )}
        </Section>
      )}

      <Section title="Runtime" hint="Crashes of Hermes and the app, from the Windows event log">
        <RuntimeCard health={data} />
      </Section>

      <Section title="Proposals" count={data.proposals.filter((p) => !p.status || p.status === "open").length} hint="From the weekly distill · Sundays 5pm">
        <Proposals items={data.proposals} onSendToChief={onSendToChief} onDecided={reload} />
      </Section>
    </div>
  );
}

export function displayDesk(desk: string, person?: Person) {
  return person ? splitTitle(person.name).name || person.name : desk;
}

export const skillAnchor = (key: string) => `skill-${key.replace(/[^\w-]/g, "-")}`;

export const SEVERITY: Record<string, string> = {
  danger: "border-danger/40 bg-danger/6",
  warn: "border-warn/30 bg-warn/5",
  info: "border-line bg-card",
};
export const SEVERITY_DOT: Record<string, string> = { danger: "bg-danger", warn: "bg-warn", info: "bg-fg-3" };

export const VERDICT: Record<string, string> = {
  helped: "bg-ok/15 text-ok",
  worse: "bg-danger/15 text-danger",
  "no clear change": "bg-fill-2 text-fg-2",
  confounded: "bg-warn/15 text-warn",
};

export const STATUS: Record<string, { label: string; tone: string }> = {
  applied: { label: "Applied", tone: "bg-ok/15 text-ok" },
  // Keys are the ledger's status strings; {name} is the chief's display name.
  "waiting on the chief": { label: "Waiting on {name}", tone: "bg-warn/15 text-warn" },
  "sent to the chief": { label: "Sent to {name}", tone: "bg-fill-2 text-fg-2" },
  dismissed: { label: "Dismissed", tone: "border border-line-2 text-fg-3" },
};
