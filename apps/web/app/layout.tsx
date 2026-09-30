import type { Metadata, Viewport } from "next";
import "./globals.css";

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
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="h-full overflow-hidden bg-canvas font-sans text-fg antialiased">{children}</body>
    </html>
  );
}
