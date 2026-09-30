/**
 * Native Windows notifications for the desktop window (PLAN §9.6): Electron has no Web Push, so the main
 * process long-polls the bridge's transcript and, only while the window is hidden or unfocused, shows a
 * notification for a new reply or a new approval request. Clicking it shows the window.
 */
export type NotifierDeps = {
  port: () => number;
  token: string;
  assistant: () => string;
  shouldNotify: () => boolean;
  notify: (title: string, body: string) => void;
  fetchImpl?: typeof fetch;
};

type Message = { id?: number; role?: string; content?: unknown; text?: unknown; replay?: boolean };
type Transcript = { messages?: Message[]; approval?: { requestId?: string; command?: string; description?: string } | null };

export function snippet(value: unknown, max = 140): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export class Notifier {
  private running = false;
  private after = 0;
  private approval = "";

  constructor(private readonly deps: NotifierDeps) {}

  private async get(query: string, timeoutMs: number): Promise<Transcript> {
    const f = this.deps.fetchImpl ?? fetch;
    const res = await f(`http://127.0.0.1:${this.deps.port()}/transcript?${query}`, {
      headers: { Authorization: `Bearer ${this.deps.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`bridge ${res.status}`);
    return (await res.json()) as Transcript;
  }

  /** One round: returns after new rows, an approval change, or the long-poll timeout. */
  async step(wait = 25): Promise<void> {
    const first = this.after === 0;
    const data = await this.get(first ? "after=0" : `after=${this.after}&wait=${wait}&approval=${encodeURIComponent(this.approval)}`, (wait + 10) * 1000);
    const messages = data.messages || [];
    const newest = messages.reduce((n, m) => Math.max(n, Number(m.id || 0)), this.after);
    const approval = data.approval?.requestId || "";
    if (!first && this.deps.shouldNotify()) {
      const replies = messages.filter((m) => m.role === "assistant" && !m.replay && Number(m.id || 0) > this.after);
      const last = replies[replies.length - 1];
      if (last) this.deps.notify(this.deps.assistant(), snippet(last.content ?? last.text) || "New reply");
      if (approval && approval !== this.approval) {
        this.deps.notify(`${this.deps.assistant()} needs your approval`, snippet(data.approval?.description || data.approval?.command) || "Open to review.");
      }
    }
    this.after = Math.max(newest, first ? newest : this.after);
    this.approval = approval;
  }

  start() {
    if (this.running) return;
    this.running = true;
    void (async () => {
      while (this.running) {
        try {
          await this.step();
        } catch {
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    })();
  }

  stop() {
    this.running = false;
  }
}
