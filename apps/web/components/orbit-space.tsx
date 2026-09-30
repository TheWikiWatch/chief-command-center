"use client";

import { GodRays } from "@paper-design/shaders-react";

/**
 * Desktop orbit backdrop: a single GodRays shader (VISUAL-OVERHAUL §4.4, §7 budget of one WebGL
 * context). The canvas starfield layers on top; reduced motion gets a static starry gradient.
 */
export function OrbitSpace({ reduced }: { reduced: boolean }) {
  const layer = { width: "100%", height: "100%", pointerEvents: "none" } as const;

  if (reduced) {
    return (
      <div className="pointer-events-none absolute inset-0 [&_*]:pointer-events-none" aria-hidden>
        <div className="orbit-stars-static absolute inset-0 opacity-70" />
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute inset-0 [&_*]:pointer-events-none" aria-hidden>
      <div className="absolute inset-0 opacity-90">
        <GodRays
          colorBack="#09090b"
          colorBloom="#3a1018"
          colors={["#8a3030", "#5a2030", "#241018", "#09090b"]}
          speed={0.1}
          intensity={0.38}
          density={0.55}
          spotty={0.32}
          midSize={0.36}
          midIntensity={0.2}
          bloom={0.16}
          style={layer}
        />
      </div>
    </div>
  );
}
