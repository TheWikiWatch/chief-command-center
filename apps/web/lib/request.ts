export class RequestError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

/** Bound the browser leg as well as the upstream proxy, including body reads. */
export async function requestJson<T>(url: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  init.signal?.addEventListener("abort", abort, { once: true });
  if (init.signal?.aborted) controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    let data: T & { error?: string; detail?: string };
    try {
      data = await response.json();
    } catch {
      throw new Error(`Invalid response (${response.status}). Check the connection before retrying.`);
    }
    if (!response.ok) throw new RequestError(data?.error || data?.detail || `Request failed (${response.status})`, response.status);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid server response");
    return data;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Request timed out or was cancelled. Check whether it completed before retrying.");
    throw error;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
  }
}
