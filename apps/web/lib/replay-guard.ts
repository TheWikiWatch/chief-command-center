import type { ChatMessage } from "@/lib/types";

/**
 * Context compaction (Hermes `archive_and_compact`) re-inserts the kept tail of the conversation as
 * NEW rows after a `[CONTEXT COMPACTION` marker. The bridge flags those copies `replay: true`; these
 * rules keep them out of the thread and out of speech, with backstops for rows it could not flag.
 */
const MARKER = /^\s*\[CONTEXT COMPACTION/i;

export const isCompactionMarker = (m: Pick<ChatMessage, "content">) => MARKER.test(m.content || "");

export const sameText = (text: string) => text.replace(/\s+/g, " ").trim();

const keyOf = (m: ChatMessage) => `${m.role}\u0000${sameText(m.content || "")}`;

/**
 * New rows from a transcript page, without compaction copies. A flagged row is always dropped; when a
 * page carries a compaction marker, an unflagged row that repeats a message already on screen is too.
 */
export function dropReplays(prev: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const compacted = incoming.some(isCompactionMarker);
  const known = compacted
    ? new Set(prev.filter((m) => m.id < 1e12 && sameText(m.content || "")).map(keyOf))
    : null;
  return incoming.filter((m) => !m.replay && !(known && !isCompactionMarker(m) && known.has(keyOf(m))));
}

/** Only replies at least this long count as "the same reply" when de-duplicating speech ("Done." may repeat). */
const SAME_REPLY_MIN = 24;
/** More than this many replies waiting at once: read the newest, offer the rest. */
export const SPEAK_BACKLOG = 3;

export type SpeechCandidate = { message: ChatMessage; script: string };

/**
 * Which replies to read aloud now. Drops a reply whose text was already spoken this session or matches
 * an earlier message in the thread (a compaction copy the bridge missed). When too many are waiting,
 * only the newest is read and the rest come back as `held` (offered with a Play button).
 */
export function planSpeech(
  candidates: SpeechCandidate[],
  thread: ChatMessage[],
  spokenTexts: Set<string>,
): { speak: SpeechCandidate[]; held: SpeechCandidate[]; repeats: SpeechCandidate[] } {
  const firstSeen = new Map<string, number>();
  for (const m of thread) {
    if (m.role !== "assistant" || m.id >= 1e12) continue;
    const text = sameText(m.content || "");
    if (text.length < SAME_REPLY_MIN) continue;
    if (!firstSeen.has(text) || m.id < (firstSeen.get(text) as number)) firstSeen.set(text, m.id);
  }
  const fresh: SpeechCandidate[] = [];
  const repeats: SpeechCandidate[] = [];
  for (const c of candidates) {
    const text = sameText(c.message.content || "");
    const earlier = firstSeen.get(text);
    const repeated = text.length >= SAME_REPLY_MIN && (spokenTexts.has(text) || (earlier !== undefined && earlier < c.message.id));
    (repeated || c.message.replay ? repeats : fresh).push(c);
  }
  if (fresh.length <= SPEAK_BACKLOG) return { speak: fresh, held: [], repeats };
  return { speak: fresh.slice(-1), held: fresh.slice(0, -1), repeats };
}
