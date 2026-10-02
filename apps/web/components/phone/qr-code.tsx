"use client";

import { useMemo } from "react";
import { encode } from "uqr";

/**
 * A QR code as crisp SVG. Always dark modules on white, whatever the theme: phone cameras read that best.
 * Each row's dark runs become one rectangle, so the path stays small.
 */
export function QrCode({ value, size = 168, label }: { value: string; size?: number; label: string }) {
  const { path, n } = useMemo(() => {
    const qr = encode(value, { ecc: "M", border: 2 });
    let d = "";
    qr.data.forEach((row, y) => {
      let x = 0;
      while (x < row.length) {
        if (!row[x]) {
          x++;
          continue;
        }
        const start = x;
        while (x < row.length && row[x]) x++;
        d += `M${start} ${y}h${x - start}v1h-${x - start}z`;
      }
    });
    return { path: d, n: qr.size };
  }, [value]);
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${n} ${n}`} width={size} height={size} shapeRendering="crispEdges" className="block rounded-ctl bg-white">
      <path d={path} fill="#09090b" />
    </svg>
  );
}
