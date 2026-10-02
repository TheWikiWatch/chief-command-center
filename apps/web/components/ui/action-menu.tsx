"use client";

import { Menu } from "@base-ui/react/menu";
import type { ReactElement, ReactNode } from "react";

import { LAYER } from "@/lib/layers";

/* Menus on Base UI (focus, arrow keys, Escape, outside clicks, screen-reader roles). Kept out of popovers.tsx so
   the first load doesn't carry it: the phone header loads it when it renders. */

export type MenuEntry = { id: string; label: string; icon?: ReactNode; shortcut?: string; danger?: boolean; disabled?: boolean; onSelect: () => void } | "separator";

/** A dropdown of actions from a trigger (the header's overflow, a row's more-actions). */
export function ActionMenu({ trigger, items, align = "end" }: { trigger: ReactElement; items: MenuEntry[]; align?: "start" | "center" | "end" }) {
  return (
    <Menu.Root>
      <Menu.Trigger render={trigger} />
      <Menu.Portal>
        <Menu.Positioner align={align} sideOffset={6} style={{ zIndex: LAYER.hoverCard }}>
          <Menu.Popup className="min-w-52 rounded-card border border-line-2 bg-raised p-1 shadow-e3 outline-hidden transition-[opacity,transform] duration-fast data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
            {items.map((item, i) =>
              item === "separator" ? (
                <Menu.Separator key={`sep-${i}`} className="my-1 h-px bg-line" />
              ) : (
                <Menu.Item
                  key={item.id}
                  disabled={item.disabled}
                  onClick={item.onSelect}
                  className={`flex min-h-10 cursor-default items-center gap-2.5 rounded-ctl px-2.5 text-body outline-hidden data-disabled:opacity-50 data-highlighted:bg-fill-2 ${item.danger ? "text-danger" : "text-fg"}`}
                >
                  {item.icon ? <span className="text-fg-3">{item.icon}</span> : null}
                  <span className="min-w-0 flex-1">{item.label}</span>
                  {item.shortcut ? <kbd className="font-mono text-micro text-fg-3">{item.shortcut}</kbd> : null}
                </Menu.Item>
              ),
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
