"use client";

import { motion } from "motion/react";
import { useEffect, useRef } from "react";

import { PICKER_EMOJI } from "@/lib/emoji";
import { SPRING } from "@/lib/motion";

export function EmojiPicker({
  onPick,
  onClose,
}: {
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: PointerEvent) {
      if (!box.current?.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("pointerdown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <motion.div
      ref={box}
      className="grid w-[18.5rem] grid-cols-8 gap-0.5 rounded-card border border-line-2 bg-raised p-2 shadow-e3"
      initial={{ opacity: 0, y: 8, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1, transition: SPRING.snappy }}
      style={{ originX: 0, originY: 1 }}
      role="dialog"
      aria-label="Emoji"
    >
      {PICKER_EMOJI.map((emoji) => (
        <button
          key={emoji}
          type="button"
          className="press flex h-9 w-9 items-center justify-center rounded-ctl text-xl leading-none hover:bg-white/10"
          onClick={() => {
            onPick(emoji);
            onClose();
          }}
        >
          {emoji}
        </button>
      ))}
    </motion.div>
  );
}
