"use client";

import { AnimatePresence, motion, useDragControls } from "motion/react";
import { useEffect, useId, useRef, type ReactNode } from "react";

import { XIcon } from "@/components/icons";
import { DUR, EASE } from "@/lib/motion";
import { useLayer } from "@/lib/overlay-stack";

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

type SheetProps = {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Phone: bottom sheet. Desktop: right-hand panel, or a centred window (Settings). */
  side?: "bottom" | "right" | "center";
  /** Bottom sheets: fill most of the screen instead of hugging content. */
  tall?: boolean;
  /** Desktop right-hand panel: wider (Team & Routines' editor). */
  wide?: boolean;
  /** Rendered in the header, before the close button. */
  actions?: ReactNode;
  /** Hide the built-in header (the body provides its own). */
  bare?: boolean;
  closeLabel?: string;
  closeDisabled?: boolean;
  /** Where the panel is positioned: whole viewport, or the nearest positioned ancestor. */
  scope?: "viewport" | "container";
  labelledBy?: string;
  children: ReactNode;
  className?: string;
  zIndex?: number;
};

/**
 * Sheet primitive (VISUAL-OVERHAUL §3.2): scrim fades, panel travels on the iOS/Vaul sheet curve,
 * drag the handle down to dismiss (velocity-aware), Escape closes, focus returns on close.
 */
export function Sheet(props: SheetProps) {
  return <AnimatePresence>{props.open ? <SheetBody key="sheet" {...props} /> : null}</AnimatePresence>;
}

function SheetBody({
  onClose,
  title,
  subtitle,
  side = "bottom",
  tall = false,
  wide = false,
  actions,
  bare = false,
  closeLabel = "Close",
  closeDisabled = false,
  scope = "viewport",
  labelledBy,
  children,
  className = "",
  zIndex = 60,
}: SheetProps) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const drag = useDragControls();
  const bottom = side === "bottom";
  const center = side === "center";
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closeDisabledRef = useRef(closeDisabled);
  closeDisabledRef.current = closeDisabled;

  // Escape and Back close only the top-most sheet (lib/overlay-stack.ts).
  useLayer(true, () => {
    if (closeDisabledRef.current) return false;
    onCloseRef.current();
  });

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = panel.current;
    const target = el?.querySelector<HTMLElement>("[data-autofocus]") || el;
    target?.focus({ preventScroll: true });
    return () => {
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, []);

  // aria-modal: Tab and Shift+Tab stay inside the sheet instead of wandering into the page behind.
  const trapTab = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const el = panel.current;
    if (e.key !== "Tab" || !el) return;
    const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((item) => !item.closest("[inert],[aria-hidden='true']"));
    if (!items.length) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === el)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const position = scope === "viewport" ? "fixed" : "absolute";

  return (
    <div className={`${position} inset-0`} style={{ zIndex }}>
      <motion.div
        className="absolute inset-0 bg-[var(--scrim)]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, transition: { duration: DUR.base, ease: EASE.enter } }}
        exit={{ opacity: 0, transition: { duration: DUR.fast, ease: EASE.exit } }}
        onClick={() => {
          if (!closeDisabled) onClose();
        }}
        aria-hidden="true"
      />
      <motion.div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy || (title ? titleId : undefined)}
        tabIndex={-1}
        onKeyDown={trapTab}
        className={
          bottom
            ? `absolute inset-x-0 bottom-0 flex flex-col rounded-t-sheet border-t border-line-2 bg-raised pb-[env(safe-area-inset-bottom)] shadow-e4 outline-none ${tall ? "h-[92%]" : "max-h-[92%]"} ${className}`
            : center
              ? `absolute inset-0 m-auto flex h-[min(88vh,860px)] w-[min(1000px,calc(100%-48px))] flex-col overflow-hidden rounded-[22px] border border-line-2 bg-raised shadow-e4 outline-none ${className}`
              : `absolute inset-y-0 right-0 flex ${wide ? "w-[min(540px,100%)]" : "w-[min(440px,100%)]"} flex-col border-l border-line-2 bg-raised shadow-e4 outline-none ${className}`
        }
        initial={bottom ? { y: "100%" } : center ? { opacity: 0, scale: 0.97, y: 8 } : { x: 32, opacity: 0 }}
        animate={
          bottom
            ? { y: 0, transition: { duration: DUR.sheet, ease: EASE.sheet } }
            : center
              ? { opacity: 1, scale: 1, y: 0, transition: { duration: DUR.medium, ease: EASE.enter } }
              : { x: 0, opacity: 1, transition: { duration: DUR.medium, ease: EASE.enter } }
        }
        exit={
          bottom
            ? { y: "100%", transition: { duration: 0.3, ease: EASE.exit } }
            : center
              ? { opacity: 0, scale: 0.98, transition: { duration: 0.16, ease: EASE.exit } }
              : { x: 24, opacity: 0, transition: { duration: 0.2, ease: EASE.exit } }
        }
        drag={bottom && !closeDisabled ? "y" : false}
        dragListener={false}
        dragControls={drag}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0, bottom: 0.7 }}
        onDragEnd={(_, info) => {
          if (info.offset.y > 110 || info.velocity.y > 650) onClose();
        }}
      >
        {bottom ? (
          <div
            className="flex h-6 shrink-0 cursor-grab touch-none items-center justify-center active:cursor-grabbing"
            onPointerDown={(e) => {
              if (!closeDisabled) drag.start(e);
            }}
            aria-hidden="true"
          >
            <span className="h-1 w-10 rounded-full bg-white/20" />
          </div>
        ) : null}
        {bare ? null : (
          <header
            className={`flex shrink-0 items-center gap-3 px-4 ${bottom ? "pb-3" : "border-b border-line py-3"}`}
            onPointerDown={(e) => {
              if (bottom && !closeDisabled && !(e.target as HTMLElement).closest("button,a,input,select,textarea")) drag.start(e);
            }}
          >
            <div className="min-w-0 flex-1">
              {title ? (
                <h2 id={titleId} className="truncate text-title text-fg">
                  {title}
                </h2>
              ) : null}
              {subtitle ? <p className="truncate text-callout text-fg-3">{subtitle}</p> : null}
            </div>
            {actions}
            <button
              type="button"
              onClick={onClose}
              disabled={closeDisabled}
              aria-label={closeLabel}
              className="press -mr-1 flex h-11 w-11 items-center justify-center rounded-full text-fg-2 hover:bg-white/[0.06] hover:text-fg disabled:opacity-40"
            >
              <XIcon size={20} />
            </button>
          </header>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
      </motion.div>
    </div>
  );
}
