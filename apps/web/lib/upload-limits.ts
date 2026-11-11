/**
 * One place for composer attachment limits. They must stay under every layer below:
 * - Next proxy buffer: next.config.ts `proxyClientMaxBodySize` (110mb)
 * - bridge /send body cap: server.py (80 MB of JSON)
 * - bridge per-file cap: data.py MAX_ATTACHMENTS / MAX_ATTACHMENT_BYTES
 * Base64 inflates files by 4/3, so 55 MB of files is about 73 MB on the wire.
 */
export const MAX_ATTACHMENTS = 8;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 55 * 1024 * 1024;

export type SizedFile = { name: string; size: number };

/** Split incoming files into those that fit and a reason for the first one that does not. */
export function admitFiles<T extends SizedFile>(current: SizedFile[], incoming: T[]): { accepted: T[]; error: string } {
  const accepted: T[] = [];
  let count = current.length;
  let total = current.reduce((sum, file) => sum + file.size, 0);
  let error = "";
  for (const file of incoming) {
    if (count >= MAX_ATTACHMENTS) {
      error = `Attach up to ${MAX_ATTACHMENTS} files at a time.`;
      break;
    }
    if (file.size > MAX_FILE_BYTES) {
      error = `${file.name} is over 25 MB.`;
      continue;
    }
    if (total + file.size > MAX_TOTAL_BYTES) {
      error = `${file.name} would take this message over 55 MB. Send it separately.`;
      continue;
    }
    accepted.push(file);
    count += 1;
    total += file.size;
  }
  return { accepted, error };
}

/** The slowest upload a send with files is given time for: 1 Mbit/s (125 bytes a millisecond), a phone on a weak signal. */
const SLOWEST_UPLOAD_BYTES_PER_MS = 125;

/**
 * How long a send with files may take, from its first byte to the bridge's answer: the two minutes it always had, plus
 * the time its bytes take at the slowest upload above (the largest message, about 73 MB on the wire, gets about
 * twelve minutes). The page waits this long (lib/bridge.ts), the proxy a little longer.
 */
export function uploadTimeoutMs(bytes: number): number {
  return 120_000 + Math.ceil(Math.max(0, bytes) / SLOWEST_UPLOAD_BYTES_PER_MS);
}
