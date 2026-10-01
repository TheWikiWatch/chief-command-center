"use client";

import { useState } from "react";

import { Thread } from "@/components/chat/thread";
import { ChevronRightIcon, ClockIcon } from "@/components/icons";
import { Sheet } from "@/components/ui/sheet";
import { fetchPreviousConversation } from "@/lib/bridge";
import type { ChatMessage, Person, PreviousConversation } from "@/lib/types";

function when(epoch: number) {
  return epoch
    ? new Date(epoch * 1000).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "";
}

/**
 * A thread's earlier conversations (each fresh start keeps the one before as history): listed at the top of
 * the thread, and opened read-only in a sheet.
 */
export function PreviousConversations({ items, chief, phone }: { items: PreviousConversation[]; chief: Person | undefined; phone: boolean }) {
  const [open, setOpen] = useState<PreviousConversation | null>(null);
  const [rows, setRows] = useState<ChatMessage[] | null>(null);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  if (!items.length) return null;
  const shown = expanded ? items : items.slice(0, 2);

  const show = (item: PreviousConversation) => {
    setOpen(item);
    setRows(null);
    setError("");
    fetchPreviousConversation(item.id)
      .then((t) => setRows(t.messages))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "That conversation couldn't be read."));
  };

  return (
    <div className="mb-4 rounded-card border border-line bg-card/60 px-3 py-2">
      <p className="flex items-center gap-1.5 px-1 pb-1 text-caption font-medium text-fg-3">
        <ClockIcon size={13} />
        Earlier in this thread
      </p>
      <ul>
        {shown.map((item) => (
          <li key={item.id}>
            <button type="button" onClick={() => show(item)} className="press flex min-h-10 w-full items-center gap-2 rounded-[10px] px-1.5 text-left hover:bg-white/[0.04]">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-callout text-fg-2">{item.title || "Previous conversation"}</span>
                <span className="block text-caption text-fg-3">
                  {when(item.ended || item.started)} · {item.messages} {item.messages === 1 ? "message" : "messages"}
                </span>
              </span>
              <ChevronRightIcon size={15} className="shrink-0 text-fg-3" />
            </button>
          </li>
        ))}
      </ul>
      {items.length > 2 ? (
        <button type="button" onClick={() => setExpanded((v) => !v)} className="press min-h-8 px-1.5 text-caption text-fg-3 hover:text-fg-2">
          {expanded ? "Show fewer" : `Show all ${items.length}`}
        </button>
      ) : null}
      <Sheet open={!!open} onClose={() => setOpen(null)} title={open?.title || "Previous conversation"} subtitle={open ? `${when(open.started)} · read only` : undefined} side={phone ? "bottom" : "right"} tall>
        <div className="flex min-h-0 flex-1 flex-col">
          {error ? <p className="px-4 py-3 text-callout text-danger">{error}</p> : null}
          {!rows && !error ? <p className="px-4 py-3 text-callout text-fg-3">Reading…</p> : null}
          {rows ? <Thread messages={rows} chief={chief} awaiting={false} waitingApproval={false} connected onSuggestion={() => {}} /> : null}
        </div>
      </Sheet>
    </div>
  );
}
