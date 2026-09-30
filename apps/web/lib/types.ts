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
   * waiting in the outbox for Chief to be reachable ("queued", lib/outbox.ts). */
  delivery?: "sent" | "queued";
  /** Client-only: the outbox id of a queued bubble. */
  queueId?: string;
  /** Client-only: why a queued bubble hasn't gone yet (the last network error). */
  queueNote?: string;
  /** Client-only: files in a queued bubble that have no preview to show. */
  queueFiles?: string[];
};

export type Transcript = {
  sessionKey: string;
  messages: ChatMessage[];
  lastId: number;
  bind?: Bind;
  generating?: boolean;
  /** The pending approval, when the bridge sends it with the transcript (phase 4 bridges). */
  approval?: ExecApproval | null;
  /** The bridge can hold `?wait=` requests until something changes. */
  longpoll?: boolean;
  /** Load earlier (`?before=`): older rows are left, and the next `before` to ask for. */
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
