"use client";

import { AnimatePresence, motion } from "motion/react";

import { BellIcon, CheckIcon, SparklesIcon, TriangleAlertIcon, UserMinusIcon, UserPlusIcon, WifiIcon, WifiOffIcon, WrenchIcon, type IconProps } from "@/components/icons";
import { SPRING } from "@/lib/motion";
import { dismissToast, useToasts, type Toast, type ToastIcon, type ToastTone } from "@/lib/toast-store";

const ICONS: Record<ToastIcon, (p: IconProps) => React.ReactElement> = {
  sparkles: SparklesIcon,
  wrench: WrenchIcon,
  wifi: WifiIcon,
  "wifi-off": WifiOffIcon,
  check: CheckIcon,
  alert: TriangleAlertIcon,
  "user-plus": UserPlusIcon,
  "user-minus": UserMinusIcon,
  bell: BellIcon,
};

const TONE: Record<ToastTone, string> = {
  neutral: "text-fg-2",
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  accent: "text-accent-text",
};

/** Top-center stack (VISUAL-OVERHAUL §5 #18). Swipe up to dismiss. */
export function ToastViewport() {
  const toasts = useToasts();
  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-70 flex flex-col items-center gap-2 px-3 pt-[calc(env(safe-area-inset-top)+10px)]"
      aria-live="polite"
      aria-atomic="false"
    >
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <ToastCard key={toast.id} toast={toast} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function ToastCard({ toast }: { toast: Toast }) {
  const Icon = toast.icon ? ICONS[toast.icon] : null;
  return (
    <motion.div
      layout
      role="status"
      className="pointer-events-auto flex w-full max-w-sm touch-pan-x items-center gap-3 rounded-card border border-line-2 bg-raised px-3.5 py-2.5 shadow-e3"
      initial={{ opacity: 0, y: -18, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1, transition: SPRING.snappy }}
      exit={{ opacity: 0, y: -14, scale: 0.97, transition: { duration: 0.18, ease: [0.3, 0, 0.8, 0.15] } }}
      drag="y"
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={{ top: 0.6, bottom: 0.05 }}
      onDragEnd={(_, info) => {
        if (info.offset.y < -24 || info.velocity.y < -400) dismissToast(toast.id);
      }}
      onClick={() => dismissToast(toast.id)}
    >
      {Icon ? (
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/6 ${TONE[toast.tone || "neutral"]}`}>
          <Icon size={17} />
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-callout font-medium text-fg">{toast.title}</span>
        {toast.body ? <span className="block truncate text-caption text-fg-3">{toast.body}</span> : null}
      </span>
    </motion.div>
  );
}
