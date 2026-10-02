"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

/**
 * Buttons, one definition for the whole app. `btn()` gives the class string (for places that must stay a plain
 * element), `Button` and `IconButton` the elements.
 *
 *   primary    the one main action of a view: light pill on the dark canvas
 *   accent     a send or confirm that belongs to the chief (crimson)
 *   secondary  a second choice beside primary: outlined
 *   ghost      quiet actions in toolbars and rows
 *   danger     destructive: deny, delete, retire
 *
 * Sizes: `md` is 44 px (touch), `sm` 36 px (dense desktop rows). Every variant has a pressed state (`press`),
 * a visible focus ring (globals.css) and a disabled look.
 */
export type ButtonVariant = "primary" | "accent" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-fg text-canvas font-semibold hover:bg-fg/90 disabled:bg-fill-3 disabled:text-fg-4",
  accent: "bg-accent-solid text-white font-semibold hover:bg-accent-solid/90 disabled:bg-fill-3 disabled:text-fg-4",
  secondary: "border border-line-2 text-fg hover:bg-fill-1 hover:border-line-3 disabled:text-fg-4",
  ghost: "text-fg-2 hover:bg-fill-2 hover:text-fg disabled:text-fg-4",
  danger: "border border-danger/40 text-danger hover:bg-danger/10 disabled:opacity-50",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "min-h-9 px-3 text-callout",
  md: "min-h-11 px-5 text-callout",
};

export function btn(variant: ButtonVariant = "primary", size: ButtonSize = "md", extra = ""): string {
  return `press inline-flex items-center justify-center gap-2 rounded-full transition-colors duration-fast disabled:cursor-not-allowed ${SIZE[size]} ${VARIANT[variant]} ${extra}`.trim();
}

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize; icon?: ReactNode };

export const Button = forwardRef<HTMLButtonElement, Props>(function Button({ variant = "primary", size = "md", icon, className = "", type = "button", children, ...rest }, ref) {
  return (
    <button ref={ref} type={type} className={btn(variant, size, className)} {...rest}>
      {icon}
      {children}
    </button>
  );
});

/** A round icon-only button. `label` is required: it is the button's accessible name and its hover title. */
export const IconButton = forwardRef<HTMLButtonElement, Omit<Props, "children" | "icon"> & { label: string; children: ReactNode }>(function IconButton(
  { label, size = "md", variant = "ghost", className = "", type = "button", children, ...rest },
  ref,
) {
  const box = size === "md" ? "size-11" : "size-9";
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={`press inline-grid ${box} shrink-0 place-items-center rounded-full transition-colors duration-fast ${VARIANT[variant]} ${className}`.trim()}
      {...rest}
    >
      {children}
    </button>
  );
});
