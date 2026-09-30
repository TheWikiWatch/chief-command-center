/** Detect classic UTF-8-as-Latin1 mojibake markers in source text. */
export function findMojibakeMarkers(text: string): string[] {
  const hits: string[] = [];
  // Build patterns from code points so this file itself stays clean UTF-8.
  const middotPair = new RegExp(String.fromCharCode(0xc2, 0xb7));
  const win1252Utf8 = new RegExp(String.fromCharCode(0xe2, 0x20ac));
  const emojiMojibake = new RegExp(String.fromCharCode(0xf0, 0x178));
  const chevronMojibake = new RegExp(
    String.fromCharCode(0xe2, 0x2013) + "[" + String.fromCharCode(0xbe, 0xb8) + "]",
  );
  if (middotPair.test(text)) hits.push("utf8-middot-pair");
  if (win1252Utf8.test(text)) hits.push("windows-1252-utf8");
  if (emojiMojibake.test(text)) hits.push("emoji-mojibake");
  if (chevronMojibake.test(text)) hits.push("chevron-mojibake");
  return hits;
}

export function assertCleanSource(text: string, label: string): void {
  const hits = findMojibakeMarkers(text);
  if (hits.length) {
    throw new Error(label + " has encoding damage: " + hits.join(", "));
  }
}
