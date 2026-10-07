export type Ring = "idle" | "working" | "failed";

export type Person = {
  id: string;
  name: string;
  title: string;
  description: string;
  section: string;
  shape: string;
  color: string;
  imageKind: string;
  custom: boolean;
  pet?: unknown;
  avatarUrl?: string | null;
  model: string;
  provider: string;
  flavor: string;
  isChief: boolean;
  ring: Ring;
  jobTitle: string;
  startedAt?: string | number;
};

export type Bind = {
  sessionKey: string;
  kind: string;
  bound: boolean;
  userId?: string;
};

export type ApprovalChoice = "once" | "session" | "always" | "deny";

export type ExecApproval = {
  requestId: string;
  command: string;
  reason: string;
  patternKey?: string;
  allowPermanent: boolean;
  allowSession: boolean;
};

export type Snapshot = {
  ok: boolean;
  gateway: boolean;
  bind: Bind;
  roster: Person[];
  sections: string[];
  workers: unknown[];
  approval?: ExecApproval | null;
  generating?: boolean;
};

export type ChatAttachment = {
  path: string;
  name: string;
  kind: "image" | "video" | "audio" | "file" | string;
  mime: string;
};

export type ChatMessage = {
  id: number;
  role: string;
  content: string;
  timestamp?: string;
  tools?: string[];
  attachments?: ChatAttachment[];
  /** Bridge: a copy Hermes re-inserted at a context compaction (history, never a new reply). */
  replay?: boolean;
  /** Client-only: a local bubble the bridge accepted ("sent", waiting for its stored copy), or one
   * waiting in the outbox for the chief to be reachable ("queued", lib/outbox.ts). */
  delivery?: "sent" | "queued";
  /** Client-only: the outbox id of a queued bubble. */
  queueId?: string;
  /** Client-only: why a queued bubble hasn't gone yet (the last network error). */
  queueNote?: string;
  /** Client-only: files in a queued bubble that have no preview to show. */
  queueFiles?: string[];
  /** Client-only: sent while the chief was working, so it was added to that work (steer), not a new turn. */
  steered?: boolean;
  /** Bridge: questions the chief asked with Hermes's `clarify` tool, and the owner's answers. */
  asked?: AskedQuestion[];
  /** Client-only: a gateway notice or scheduled-job message shown in the thread (not a transcript row). */
  notice?: ChatNotice;
};

export type AskedQuestion = { question: string; choices: string[]; answer: string | string[]; unanswered?: boolean };

/** The chief's open question: the turn waits until the owner answers (a choice, several, or their own words). */
export type PendingQuestion = { id: string; question: string; choices: string[]; multi: boolean };

/** A message the gateway sent that isn't a reply: a scheduled job's result or a notice. */
export type ChatNotice = {
  id: string;
  at: number;
  text: string;
  source: "scheduled" | "notice";
  /** A scheduled job's answer, unwrapped by the bridge: which routine it came from (and whose it is). */
  routine?: { name: string; jobId: string; profile?: string };
  /** A scheduled job that failed, in the app's words: the error, how many runs in a row, and Hermes's full text. */
  failure?: { error: string; streak: number; detail: string };
  /** Files it carried (an image a routine made, or one handed over after a reply's text). */
  attachments?: ChatAttachment[];
  /** Client-only: the same notice repeated this many times in a row (restarts), and when the last one came. */
  repeat?: number;
  until?: number;
};

/** What the running turn is doing: since when (epoch seconds), how many steps, and the current one. */
export type TurnActivity = { since: number; steps: number; label: string };

/** The chief's reply so far, while the turn runs: Hermes's draft id, the text, and when the frame came (epoch seconds). */
export type ReplyDraft = { id: number; text: string; at: number };

/** Work the chief handed to helpers that is still running after its turn ended (Hermes's background delegations). */
export type BackgroundTask = { goal: string; step: string };
export type BackgroundUnit = { id: string; status: "running" | "stalling" | "finalizing" | string; since: number; tasks: BackgroundTask[] };

/** A thread's earlier conversation (before a fresh start). Times are epoch seconds. */
export type PreviousConversation = { id: string; title: string; started: number; ended: number; messages: number };

export type Transcript = {
  sessionKey: string;
  messages: ChatMessage[];
  lastId: number;
  bind?: Bind;
  generating?: boolean;
  /** The pending approval, when the bridge sends it with the transcript (phase 4 bridges). */
  approval?: ExecApproval | null;
  /** The chief's open question, its current step, and notices since `nsince` (newer bridges). */
  clarify?: PendingQuestion | null;
  activity?: TurnActivity | null;
  /** The reply as it's being written (Hermes's draft frames), and its signature for the long-poll (newer bridges). */
  draft?: ReplyDraft | null;
  draftSig?: string;
  /** Background tasks still running for this conversation, and their signature for the long-poll (newer bridges). */
  background?: BackgroundUnit[];
  backgroundSig?: string;
  notices?: ChatNotice[];
  noticeHead?: string;
  /** The thread's earlier conversations (first load only). */
  previous?: PreviousConversation[];
  thread?: string;
  /** The bridge can hold `?wait=` requests until something changes. */
  longpoll?: boolean;
  /** Load earlier (`?before=`, and the first load): older rows are left. `cursor`: the next `before` to ask for. */
  more?: boolean;
  cursor?: number;
};

export type Peek = {
  ok: boolean;
  id?: string;
  soul?: string;
  memory?: string;
  userMemory?: string;
  toolsets?: string[];
  skills?: string[];
  model?: { default?: string; provider?: string };
  description?: string;
  job?: { title?: string; status?: string; kanbanStatus?: string };
  flavor?: { flavor?: string; pin?: string; status_note?: string };
};
