import type { Config } from "tailwindcss";

// Tokens live in app/globals.css (docs/VISUAL-OVERHAUL.md §2). RGB triplets keep opacity modifiers working.
const rgb = (name: string) => `rgb(var(--c-${name}) / <alpha-value>)`;

const config: Config = {
  // Resolved next to this file, not the working directory (a server started from another folder
  // would otherwise compile classes from the wrong tree).
  content: { relative: true, files: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"] },
  theme: {
    extend: {
      colors: {
        canvas: rgb("canvas"),
        pane: rgb("pane"),
        card: rgb("card"),
        raised: rgb("raised"),
        well: rgb("well"),
        fg: { DEFAULT: rgb("fg"), 2: rgb("fg-2"), 3: rgb("fg-3"), 4: rgb("fg-4") },
        line: { DEFAULT: "var(--line-1)", 2: "var(--line-2)", 3: "var(--line-3)" },
        accent: { DEFAULT: rgb("accent"), solid: rgb("accent-solid"), text: rgb("accent-text") },
        data: rgb("data"),
        ok: rgb("ok"),
        warn: rgb("warn"),
        danger: rgb("danger"),
        // Legacy names from the Discord-era palette, mapped onto the new tokens.
        ink: rgb("canvas"),
        chat: rgb("pane"),
        bubble: rgb("card"),
        mine: rgb("well"),
        chief: rgb("accent"),
      },
      fontFamily: {
        sans: [
          "var(--font-sans)",
          "Inter",
          "system-ui",
          "Segoe UI",
          "Roboto",
          "Segoe UI Emoji",
          "Apple Color Emoji",
          "Noto Color Emoji",
          "sans-serif",
        ],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "Roboto Mono", "Menlo", "monospace"],
      },
      fontSize: {
        display: ["1.75rem", { lineHeight: "2rem", letterSpacing: "-0.022em", fontWeight: "600" }],
        title: ["1.25rem", { lineHeight: "1.625rem", letterSpacing: "-0.017em", fontWeight: "600" }],
        headline: ["1rem", { lineHeight: "1.375rem", letterSpacing: "-0.011em", fontWeight: "600" }],
        body: ["0.9375rem", { lineHeight: "1.375rem", letterSpacing: "-0.006em" }],
        callout: ["0.8125rem", { lineHeight: "1.125rem" }],
        caption: ["0.75rem", { lineHeight: "1rem", letterSpacing: "0.01em" }],
        code: ["0.78125rem", { lineHeight: "1.125rem" }],
      },
      borderRadius: {
        chip: "6px",
        ctl: "10px",
        card: "14px",
        sheet: "20px",
        dock: "28px",
      },
      boxShadow: {
        e3: "var(--shadow-e3)",
        e4: "var(--shadow-e4)",
      },
      transitionTimingFunction: {
        enter: "var(--ease-enter)",
        exit: "var(--ease-exit)",
        move: "var(--ease-move)",
        sheet: "var(--ease-sheet)",
      },
      transitionDuration: {
        press: "80ms",
        fast: "140ms",
        base: "220ms",
        medium: "320ms",
        sheet: "480ms",
      },
    },
  },
  plugins: [],
};

export default config;
