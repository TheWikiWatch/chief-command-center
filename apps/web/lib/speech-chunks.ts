/**
 * Split a reply into speech chunks (PLAN-2026-09-23 §1): a short first chunk so sound starts in about
 * a second or two, then larger chunks prepared while the previous one plays. Short replies stay whole.
 */
const FIRST_MIN = 60;
const FIRST_MAX = 240;
const REST_MAX = 650;
const WHOLE_MAX = 300;

function sentences(text: string): string[] {
  const out = text.match(/[^.!?…]+(?:[.!?…]+["')\]]*|$)\s*/g) || [text];
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Break one over-long sentence at commas or spaces so no chunk exceeds `max`. */
function hardWrap(sentence: string, max: number): string[] {
  if (sentence.length <= max) return [sentence];
  const out: string[] = [];
  let rest = sentence;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(" "));
    const at = cut > max * 0.4 ? cut + 1 : max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export function splitSpeech(script: string): string[] {
  const text = script.replace(/\s+/g, " ").trim();
  if (!text) return [];
  if (text.length <= WHOLE_MAX) return [text];
  const parts = sentences(text).flatMap((s) => hardWrap(s, REST_MAX));

  const chunks: string[] = [];
  let first = "";
  let i = 0;
  while (i < parts.length) {
    const next = first ? `${first} ${parts[i]}` : parts[i];
    if (first && (first.length >= FIRST_MIN || next.length > FIRST_MAX)) break;
    if (!first && parts[i].length > FIRST_MAX) {
      const [head, ...tail] = hardWrap(parts[i], FIRST_MAX);
      first = head;
      parts.splice(i, 1, ...tail);
      break;
    }
    first = next;
    i += 1;
  }
  chunks.push(first);

  let current = "";
  for (; i < parts.length; i += 1) {
    const next = current ? `${current} ${parts[i]}` : parts[i];
    if (current && next.length > REST_MAX) {
      chunks.push(current);
      current = parts[i];
    } else current = next;
  }
  if (current) chunks.push(current);
  return chunks.filter(Boolean);
}
