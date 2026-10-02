import localFont from "next/font/local";

/*
 * Fonts are vendored in app/fonts (SIL OFL 1.1, licenses alongside) instead of npm packages:
 * the daily `npm run dev` caches node_modules for its whole life, so a new package would
 * break the live app until a restart. Files inside the repo are always picked up.
 */

/** Inter Variable with optical sizing: large sizes get the Display cut automatically. Latin only (73KB), preloaded. */
export const sans = localFont({
  src: "../app/fonts/InterVariable-latin-opsz.woff2",
  variable: "--font-inter",
  weight: "100 900",
  display: "swap",
  preload: true,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
    },
  ],
});

/** Geist Mono for code, commands and counters. Not preloaded: fetched only when monospace text is on screen. */
export const mono = localFont({
  src: "../app/fonts/GeistMono-Variable.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});
