"use client";


/* Small formatters for the Vault. */

export function ago(ms: number) {
  if (!ms) return "";
  const d = (Date.now() - ms) / 86_400_000;
  if (d < 1 / 24) return "just now";
  if (d < 1) return `${Math.round(d * 24)}h ago`;
  if (d < 30) return `${Math.round(d)}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: d > 300 ? "numeric" : undefined });
}

export function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
