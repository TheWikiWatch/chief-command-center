export class RequestError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

/*
 * Every request's failure is a sentence the owner can read: the bridge's own messages already are, but the browser,
 * the proxy and the network speak in codes ("Failed to fetch", "bridge unreachable", "Request failed (502)"), and
 * every screen shows `error.message`. The status stays on the error (0 for no answer at all), so the outbox can still
 * tell a retryable failure from a refusal.
 */
export const PLAIN = {
  offline: "Can't reach Chief right now. Check the connection; it reconnects on its own.",
  down: "Chief isn't answering right now. It may be restarting; try again in a moment.",
  timeout: "That took too long. Check whether it finished before trying again.",
  garbled: "Chief's answer didn't come through properly. Try again.",
  signedOut: "This window isn't connected to Chief anymore. Reload the app.",
  missing: "That isn't available in this version of Chief.",
  tooBig: "That's too big to send. Try fewer or smaller files.",
  busy: "Chief is busy. Try again in a moment.",
} as const;

/** A message meant for people: starts with a capital and has words (the proxy's and the network's codes don't). */
/** Text a person wrote (a sentence), not a code, a status line or a stack trace. */
export function sentence(text: unknown): text is string {
  return typeof text === "string" && /^[A-Z0-9"“'‘(]/.test(text.trim()) && /\s/.test(text.trim()) && !/Traceback|^\w+Error\b/.test(text);
}

/** The plain sentence for a failed answer: the server's own when it wrote one, else one for its status. */
export function plainFailure(status: number, text?: unknown): string {
  if (sentence(text) && !/^Request failed \(\d+\)$/.test(String(text))) return String(text).trim();
  if (status === 401 || status === 403) return PLAIN.signedOut;
  if (status === 404 || status === 405 || status === 501) return PLAIN.missing;
  if (status === 408 || status === 504) return PLAIN.timeout;
  if (status === 413) return PLAIN.tooBig;
  if (status === 429) return PLAIN.busy;
  if (status === 0) return PLAIN.offline;
  return status >= 500 ? PLAIN.down : `That didn't work (error ${status}). Try again.`;
}

/** What to show for any caught error: its message when it's a sentence (requestJson's always are), else `fallback`. */
export function friendlyError(error: unknown, fallback: string): string {
  if (error instanceof RequestError) return error.message;
  if (error instanceof TypeError && /fetch|network|load failed/i.test(error.message)) return PLAIN.offline;
  if (error instanceof Error && sentence(error.message)) return error.message;
  return fallback;
}

/** Bound the browser leg as well as the upstream proxy, including body reads. */
export async function requestJson<T>(url: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  init.signal?.addEventListener("abort", abort, { once: true });
  if (init.signal?.aborted) controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw error;
      // No answer at all: the network, Tailscale, or the app's server is down.
      throw new RequestError(PLAIN.offline, 0);
    }
    let data: T & { error?: string; detail?: string };
    try {
      data = await response.json();
    } catch {
      if (controller.signal.aborted) throw new Error("aborted");
      throw new RequestError(response.ok ? PLAIN.garbled : plainFailure(response.status), response.status);
    }
    if (!response.ok) throw new RequestError(plainFailure(response.status, data?.error || data?.detail), response.status);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new RequestError(PLAIN.garbled, response.status);
    return data;
  } catch (error) {
    if (controller.signal.aborted) throw new RequestError(PLAIN.timeout, 0);
    throw error;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
  }
}
