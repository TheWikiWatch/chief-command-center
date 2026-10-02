"use client";

import { toggleFullscreen, useFullscreen } from "@/lib/use-fullscreen";
import { showToast } from "@/lib/toast-store";

/**
 * Lucide `maximize` corners. Each corner turned 180° about its own centre is exactly the
 * matching `minimize` corner, so the icon morphs instead of swapping (see .fs-corner in globals.css).
 * [path, outward x, outward y]
 */
const CORNERS: [string, number, number][] = [
  ["M8 3H5a2 2 0 0 0-2 2v3", -1, -1],
  ["M21 8V5a2 2 0 0 0-2-2h-3", 1, -1],
  ["M3 16v3a2 2 0 0 0 2 2h3", -1, 1],
  ["M16 21h3a2 2 0 0 0 2-2v-3", 1, 1],
];

export function FullscreenIcon({ active, size = 19 }: { active: boolean; size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="fs-icon overflow-visible"
      data-active={active ? "" : undefined}
    >
      {CORNERS.map(([d, x, y]) => (
        <path key={d} d={d} className="fs-corner" style={{ "--fx": x, "--fy": y } as React.CSSProperties} />
      ))}
    </svg>
  );
}

/** Header control: enter or leave page full screen. Renders nothing where the browser cannot. */
export function FullscreenButton() {
  const fs = useFullscreen();
  if (!fs.supported) return null;
  const on = fs.active || fs.browser;
  const label = fs.browser ? "Press F11 to exit full screen" : fs.active ? "Exit full screen (Esc)" : "Full screen (F)";
  return (
    <button
      type="button"
      aria-label="Full screen"
      aria-pressed={on}
      title={label}
      className="fs-btn press flex h-11 w-11 items-center justify-center rounded-full text-fg-2 hover:bg-fill-2 hover:text-fg"
      onClick={() => {
        if (fs.browser) {
          showToast({ tone: "neutral", title: "Press F11 to leave full screen" });
          return;
        }
        void toggleFullscreen().then((ok) => {
          if (!ok) showToast({ tone: "warn", title: "Full screen isn’t available here" });
        });
      }}
    >
      <FullscreenIcon active={on} />
    </button>
  );
}
