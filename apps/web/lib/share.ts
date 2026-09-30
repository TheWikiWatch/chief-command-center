/**
 * Structural sharing for polled JSON: returns `prev` (or its unchanged parts) wherever `next` is
 * deep-equal, so a poll that brings nothing new keeps every reference and memoized UI skips work.
 * Arrays of objects with an `id` are matched by id, so a minted or retired bot leaves the rest shared.
 */
export function share<T>(prev: T, next: T): T {
  if (Object.is(prev, next)) return prev;
  if (!prev || !next || typeof prev !== "object" || typeof next !== "object") return next;
  if (Array.isArray(prev) !== Array.isArray(next)) return next;

  if (Array.isArray(next)) {
    const before = prev as unknown[];
    const byId = new Map<unknown, unknown>();
    for (const item of before) {
      const id = item && typeof item === "object" ? (item as { id?: unknown }).id : undefined;
      if (id !== undefined) byId.set(id, item);
    }
    let same = before.length === next.length;
    const out = next.map((item, i) => {
      const id = item && typeof item === "object" ? (item as { id?: unknown }).id : undefined;
      const match = id !== undefined && byId.has(id) ? byId.get(id) : before[i];
      const kept = share(match, item);
      if (kept !== before[i]) same = false;
      return kept;
    });
    return (same ? prev : out) as T;
  }

  const a = prev as Record<string, unknown>;
  const b = next as Record<string, unknown>;
  const keys = Object.keys(b);
  let same = keys.length === Object.keys(a).length;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const kept = share(a[key], b[key]);
    if (kept !== a[key] || !(key in a)) same = false;
    out[key] = kept;
  }
  return (same ? prev : out) as T;
}
