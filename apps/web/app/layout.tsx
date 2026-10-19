import type { Metadata, Viewport } from "next";
import "./globals.css";

import { BOOT_SCRIPT } from "@/lib/app-look";
import { mono, sans } from "@/lib/fonts";

export const metadata: Metadata = {
  title: "Chief Command Center",
  description: "Your chief of staff and your team of agents",
  applicationName: "Chief",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Chief",
  },
  icons: {
    icon: "/icon.svg",
    apple: "/icons/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#09090B",
  colorScheme: "dark light",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The canvas colour inline too: a phone reloading the app over a slow link paints before the stylesheet arrives,
    // and without it that first frame is white. The boot script sets it (and the light theme, and the accent) from
    // this device's copy of the last look before anything paints (lib/app-look.ts).
    <html lang="en" className={`${sans.variable} ${mono.variable}`} style={{ backgroundColor: "var(--boot-bg, #09090B)" }} suppressHydrationWarning>
      <head>
        {/* A fixed script from this app (no input in it): the last look, before the first paint. */}
        <script dangerouslySetInnerHTML={{ __html: BOOT_SCRIPT }} />
      </head>
      <body className="h-full overflow-hidden bg-canvas font-sans text-fg antialiased" style={{ backgroundColor: "var(--boot-bg, #09090B)" }}>
        {children}
      </body>
    </html>
  );
}
