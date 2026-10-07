"use client";

import { motion } from "motion/react";

import { BookOpenIcon, ListChecksIcon, MessageCircleIcon, OrbitIcon, type IconProps } from "@/components/icons";
import { SPRING } from "@/lib/motion";

export type PhoneTab = "chat" | "today" | "fleet" | "vault";

export const PHONE_TABS: { id: PhoneTab; label: string; Icon: (p: IconProps) => React.ReactElement }[] = [
  { id: "chat", label: "Chat", Icon: MessageCircleIcon },
  { id: "today", label: "Today", Icon: ListChecksIcon },
  { id: "fleet", label: "Fleet", Icon: OrbitIcon },
  { id: "vault", label: "Vault", Icon: BookOpenIcon },
];

/**
 * Floating glass tab bar (VISUAL-OVERHAUL §5 #1). The pill slides between tabs; Chat carries the approval
 * badge, Fleet a quiet dot for fleet flags not yet looked at.
 */
export function PhoneNav({
  tab,
  approvalPending = false,
  fleetFlags = 0,
  onChange,
}: {
  tab: PhoneTab;
  approvalPending?: boolean;
  fleetFlags?: number;
  onChange: (next: PhoneTab) => void;
}) {
  return (
    <div className="shrink-0 px-3 pb-[calc(env(safe-area-inset-bottom)+8px)] pt-1.5">
      <nav className="glass flex h-16 items-stretch rounded-dock p-1.5" aria-label="Command surfaces">
        {PHONE_TABS.map(({ id, label, Icon }) => {
          const on = tab === id;
          const badge = id === "chat" && approvalPending;
          const flagDot = id === "fleet" && fleetFlags > 0;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onChange(id)}
              aria-current={on ? "page" : undefined}
              className={`relative flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-pane text-caption font-medium transition-colors duration-fast ${
                on ? "text-fg" : "text-fg-3"
              }`}
            >
              {on ? (
                <motion.span
                  layoutId="phone-tab-pill"
                  className="absolute inset-0 rounded-pane bg-fill-3 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]"
                  transition={SPRING.snappy}
                />
              ) : null}
              <motion.span
                className="relative"
                animate={on ? { scale: [1, 1.14, 1], y: [0, -1, 0] } : { scale: 1, y: 0 }}
                transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
              >
                <Icon size={22} strokeWidth={on ? 2 : 1.75} />
                {badge ? (
                  <span className="absolute -right-1.5 -top-1 flex h-3 w-3">
                    <span className="absolute inset-0 animate-ping rounded-full bg-warn opacity-70" />
                    <span className="relative h-3 w-3 rounded-full border-2 border-canvas bg-warn" />
                  </span>
                ) : null}
                {flagDot ? <span className="absolute -right-1 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-canvas bg-warn" aria-hidden="true" /> : null}
              </motion.span>
              <span className="relative">{label}</span>
              {badge ? <span className="sr-only">Approval pending</span> : null}
              {flagDot ? <span className="sr-only">{fleetFlags} fleet {fleetFlags === 1 ? "flag" : "flags"} to look at</span> : null}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
