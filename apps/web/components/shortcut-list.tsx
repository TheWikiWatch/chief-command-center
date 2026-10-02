"use client";

import { keyLabel, SHORTCUTS } from "@/lib/shortcuts";

/** The "?" sheet: every keyboard shortcut. */
export function ShortcutList({ phone }: { phone: boolean }) {
  return (
    <ul className="divide-y divide-(--line-1)">
      {SHORTCUTS.filter((s) => !(phone && s.desktopOnly)).map((s) => (
        <li key={s.id} className="flex items-center justify-between gap-4 px-1 py-2.5 text-body">
          <span className="text-fg-2">{s.label}</span>
          <span className="flex gap-1">
            {s.keys.map((k) => (
              <kbd key={k} className="min-w-7 rounded-chip border border-line-2 bg-fill-1 px-1.5 py-0.5 text-center font-mono text-caption text-fg">
                {keyLabel(k)}
              </kbd>
            ))}
          </span>
        </li>
      ))}
    </ul>
  );
}
