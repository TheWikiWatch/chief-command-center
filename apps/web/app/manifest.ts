import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Chief Command Center",
    short_name: "Chief",
    description: "Your chief of staff and your team of agents",
    start_url: "/",
    display: "standalone",
    // One colour each: a web app manifest has no light/dark variants. Dark is the app's default look, and the
    // installed app's splash shows only until the page paints in the owner's own look.
    background_color: "#09090B",
    theme_color: "#09090B",
    // PNGs for Android's installed-app icon and splash (it does not use SVG there); the maskable one
    // fills the launcher's shape, and the monochrome one is Android's themed icon (tinted to the wallpaper).
    // All drawn by scripts/gen-pwa-icons.mjs.
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icons/monochrome-512.png", sizes: "512x512", type: "image/png", purpose: "monochrome" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  };
}
