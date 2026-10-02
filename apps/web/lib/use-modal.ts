"use client";

import { useEffect, type KeyboardEvent, type RefObject } from "react";

export const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/**
 * A dialog's focus behaviour, shared by sheets, voice mode, the image viewer and onboarding:
 *
 * - on open, focus goes to the element marked `data-autofocus`, else the dialog itself; on close it returns
 *   to what had it before;
 * - Tab and Shift+Tab cycle inside (`onKeyDown` returned here goes on the dialog element);
 * - with `inert`, everything else on the page is made inert while it is open, so screen readers and virtual
 *   cursors can't wander behind it. Elements marked `data-modal-keep` (the toast region) stay reachable.
 *   Dialogs scoped to one pane leave `inert` off: the other pane stays usable beside them.
 */
export function useModal(ref: RefObject<HTMLElement | null>, opts: { active?: boolean; inert?: boolean } = {}) {
  const active = opts.active ?? true;
  const inert = opts.inert ?? false;

  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const target = el?.querySelector<HTMLElement>("[data-autofocus]") || el;
    target?.focus({ preventScroll: true });
    return () => {
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [active, ref]);

  useEffect(() => {
    if (!active || !inert) return;
    const el = ref.current;
    if (!el) return;
    const changed: HTMLElement[] = [];
    // Every sibling along the path from the dialog up to <body> goes inert (unless it already was).
    for (let node: HTMLElement | null = el; node && node !== document.body; node = node.parentElement) {
      const parent: HTMLElement | null = node.parentElement;
      if (!parent) break;
      for (const sibling of Array.from(parent.children) as HTMLElement[]) {
        if (sibling === node || sibling.inert || sibling.hasAttribute("data-modal-keep") || sibling.tagName === "SCRIPT") continue;
        sibling.inert = true;
        changed.push(sibling);
      }
    }
    return () => {
      for (const item of changed) item.inert = false;
    };
  }, [active, inert, ref]);

  /** Put on the dialog element: keeps Tab inside it. */
  return function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    const el = ref.current;
    if (e.key !== "Tab" || !el) return;
    const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((item) => !item.closest("[inert],[aria-hidden='true']"));
    if (!items.length) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const current = document.activeElement;
    if (e.shiftKey && (current === first || current === el)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && current === last) {
      e.preventDefault();
      first.focus();
    }
  };
}
