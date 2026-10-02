"use client";

import { CommandShell } from "@/components/command-shell";
import { TipProvider } from "@/components/ui/popovers";

export default function HomePage() {
  return (
    <TipProvider>
      <CommandShell />
    </TipProvider>
  );
}
