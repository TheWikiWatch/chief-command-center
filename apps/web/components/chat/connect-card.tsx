"use client";

import { useEffect, useState } from "react";

import { CheckIcon, LockIcon, ShieldCheckIcon } from "@/components/icons";
import { FlowNote, ServiceTile } from "@/components/settings/connections";
import { Button } from "@/components/ui/button";
import { BACKEND_LABEL, fetchConnections, useConnectFlow, type Backend, type ConnectionService } from "@/lib/connections";
import { useAssistantName } from "@/lib/identity";
import { openSettings } from "@/lib/settings-nav";
import type { ConnectRequest } from "@/lib/types";

/*
 * A bot asking for a connection: "Connect Gmail" with a button, in the thread (bridge: connections.py
 * `connect_from_tool_row`, from the bot's `connections` request or Hermes's own connector links). One click opens the
 * sign-in; the card turns to "connected" and Continue tells the bot to go ahead. It reads the live state, so an old
 * card for something already connected just says so.
 */

const MAIL = new Set(["gmail", "outlook"]);
const DISMISSED = "chief:connect-dismissed";
let shared: { at: number; rows: Promise<ConnectionService[]> } | null = null;

/** The services, read once for every card on screen (and again after 15 s or a connection). */
function services(fresh = false): Promise<ConnectionService[]> {
  if (!fresh && shared && Date.now() - shared.at < 15_000) return shared.rows;
  const rows = fetchConnections(fresh).then((v) => v.services);
  shared = { at: Date.now(), rows };
  rows.catch(() => {
    shared = null;
  });
  return rows;
}

/** Forget the shared read (tests, and after the owner changes a connection elsewhere). */
export function forgetConnectCardServices() {
  shared = null;
}

function dismissed(key: string): boolean {
  try {
    return (JSON.parse(localStorage.getItem(DISMISSED) || "[]") as string[]).includes(key);
  } catch {
    return false;
  }
}

function dismiss(key: string) {
  try {
    const list = (JSON.parse(localStorage.getItem(DISMISSED) || "[]") as string[]).filter((k) => k !== key);
    localStorage.setItem(DISMISSED, JSON.stringify([...list, key].slice(-100)));
  } catch {
    // Remembered for this view only.
  }
}

export function ConnectCards({ items, messageId, onQuickReply }: { items: ConnectRequest[]; messageId: number; onQuickReply?: (text: string) => Promise<void> }) {
  const seen = new Set<string>();
  return (
    <div className="space-y-2">
      {items
        .filter((i) => !seen.has(i.service) && seen.add(i.service))
        .map((item) => (
          <ConnectCard key={item.service} item={item} cardKey={`${messageId}:${item.service}`} onQuickReply={onQuickReply} />
        ))}
    </div>
  );
}

const ALT: Record<Backend, string> = { local: "Keep it on this PC", quick: "Use Quick instead", mcp: "Connect directly" };

function ConnectCard({ item, cardKey, onQuickReply }: { item: ConnectRequest; cardKey: string; onQuickReply?: (text: string) => Promise<void> }) {
  const [row, setRow] = useState<ConnectionService | null | undefined>(undefined);
  const [hidden, setHidden] = useState(() => dismissed(cardKey));
  const [continued, setContinued] = useState(false);
  const { flow, start, cancel } = useConnectFlow(item.service, () => {
    void services(true).then((rows) => setRow(rows.find((r) => r.id === item.service) || null));
  });

  useEffect(() => {
    let live = true;
    services()
      .then((rows) => live && setRow(rows.find((r) => r.id === item.service) || null))
      .catch(() => live && setRow(null));
    return () => {
      live = false;
    };
  }, [item.service]);

  const chief = useAssistantName();
  const label = row?.label || item.label || item.service;
  const say = (text: string) => onQuickReply?.(text).catch(() => undefined);

  if (hidden) {
    return <p className="text-caption text-fg-3">Not connecting {label} for now. You can connect it any time in Settings → Connections.</p>;
  }

  const connected = row?.state === "connected" || flow.step === "done";
  if (connected) {
    const justNow = flow.step === "done";
    return (
      <div className="flex max-w-md items-center gap-3 rounded-card border border-line bg-card px-3.5 py-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-ok/15 text-ok">
          <CheckIcon className="size-4" strokeWidth={2.5} />
        </span>
        <p className="min-w-0 flex-1 text-callout text-fg">
          {label} connected{row?.via ? <span className="text-fg-3"> · {BACKEND_LABEL[row.via]}</span> : null}
        </p>
        {justNow && !continued && onQuickReply ? (
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setContinued(true);
              void say(`${label} is connected. Go ahead.`);
            }}
          >
            Continue
          </Button>
        ) : null}
      </div>
    );
  }

  const backends = row?.backends || [];
  const needsNous = !!row?.needsNous || (row !== undefined && row !== null && !backends.length);
  const busy = flow.step === "starting" || flow.step === "waiting";
  return (
    <div className="max-w-md rounded-card border border-line bg-card p-3.5">
      <div className="flex items-start gap-3">
        <ServiceTile service={{ id: item.service, label }} />
        <div className="min-w-0 flex-1">
          <p className="text-body font-medium text-fg">Connect {label}</p>
          <p className="mt-0.5 text-caption text-fg-3">{item.why ? reason(chief, item.why) : row?.blurb || "A bot needs this to carry on."}</p>
          {MAIL.has(item.service) ? (
            <p className="mt-1 flex items-center gap-1 text-caption text-fg-3">
              <ShieldCheckIcon className="size-3.5 text-ok" /> Sending always asks you first.
            </p>
          ) : null}
        </div>
      </div>
      {row === undefined ? (
        <div className="mt-3 h-9 rounded-full bg-fill-1" aria-hidden />
      ) : row === null ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => openSettings("connections")}>
            Open Connections
          </Button>
        </div>
      ) : busy || flow.step === "pc-only" || flow.step === "keys" ? null : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {needsNous ? (
            <Button variant="primary" size="sm" onClick={() => openSettings("connections")}>
              Set up in Settings
            </Button>
          ) : (
            <>
              <Button variant="primary" size="sm" onClick={() => void start(backends[0])}>
                {backends[0] === "local" ? <LockIcon className="size-3.5" /> : null}
                Connect
              </Button>
              {backends.slice(1, 2).map((b) => (
                <Button key={b} variant="secondary" size="sm" onClick={() => void start(b)}>
                  {ALT[b]}
                </Button>
              ))}
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              dismiss(cardKey);
              setHidden(true);
              void say(`Not now: skip ${label} for this.`);
            }}
          >
            Not now
          </Button>
        </div>
      )}
      <FlowNote flow={flow} label={label} onCancel={cancel} onRetry={() => void start(backends[0])} onKeys={(env, b) => void start(b, env)} />
    </div>
  );
}

/** The bot's reason as a sentence: "to sort your inbox" reads "Chief wants it to sort your inbox." */
function reason(chief: string, why: string): string {
  const t = why.trim().replace(/[.!?]+$/, "");
  return /^(to|for|so)\s/i.test(t) ? `${chief} wants it ${t.charAt(0).toLowerCase()}${t.slice(1)}.` : `${t.charAt(0).toUpperCase()}${t.slice(1)}.`;
}
