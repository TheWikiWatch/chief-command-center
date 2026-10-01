/**
 * What the desktop app's preload exposes to the page (Phase 7). In a plain browser none of it exists, and
 * every caller has a browser fallback.
 */
export type Release = {
  version: string;
  published: string;
  notes: string;
  package: { file: string; bytes: number; sha256: string };
  hermes: { base_version: string; commit: string };
};

export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "up-to-date"; checkedAt: number }
  | { status: "available"; checkedAt: number; release: Release }
  | { status: "downloading"; release: Release; done: number; total: number }
  | { status: "ready"; release: Release; file: string }
  | { status: "busy"; release: Release; file: string; reasons: string[] }
  | { status: "installing"; release: Release; step: string }
  | { status: "error"; error: string; release?: Release };

export type DesktopUpdates = {
  state: () => Promise<UpdateState>;
  check: () => Promise<UpdateState>;
  download: () => Promise<UpdateState>;
  /** `force`: install although Chief is busy (the owner chose "Install now"). */
  install: (force?: boolean) => Promise<UpdateState>;
  skip: (version: string) => Promise<UpdateState>;
  feed: () => Promise<string>;
  setFeed: (folder: string) => Promise<UpdateState>;
  /** A private GitHub release repository's read-only key (sealed by the shell); older shells lack these. */
  hasKey?: () => Promise<boolean>;
  setKey?: (key: string) => Promise<UpdateState>;
  /** Fetch and verify releases not kept yet for the update history; older shells lack it. */
  history?: () => Promise<{ ok: boolean; added?: number; error?: string }>;
  onState: (fn: (state: UpdateState) => void) => () => void;
};

export type ServeEntry = { port: number; target: string; ours: boolean };

/** Settings → Phone: Tailscale on this PC, and the Serve entry the app manages (apps/desktop/src/tailscale.ts). */
export type PhoneState = {
  installed: boolean;
  /** Running, NeedsLogin, Stopped… ("" when unknown). */
  backend: string;
  dnsName: string;
  login: string;
  https: boolean;
  serve: ServeEntry[];
  error: string;
  uiPort: number;
  /** The phone's address when the dashboard is served ("" when it isn't). */
  url: string;
  /** The Serve port in use, or the one Turn on would use (null when all are taken). */
  port: number | null;
  /** Serve still points at the dashboard's previous port. */
  moved: boolean;
  /** owner: only the allow-listed login(s); tailnet: anyone on the tailnet. */
  access: "owner" | "tailnet";
  allowed: string;
};

export type PhoneResult = { ok: boolean; error?: string; consentUrl?: string; url?: string };

export type DesktopPhone = {
  state: () => Promise<PhoneState>;
  enable: (port?: number) => Promise<PhoneResult>;
  disable: () => Promise<PhoneResult>;
  setAccess: (mode: "owner" | "tailnet") => Promise<PhoneResult>;
  /** Opens Tailscale's pages and the phone app stores in the default browser (nothing else). */
  open: (url: string) => Promise<boolean>;
};

export type ChiefDesktop = {
  updates?: DesktopUpdates;
  /** Older shells lack it. */
  phone?: DesktopPhone;
  /** A native folder picker; resolves to the chosen folder, or null when cancelled. */
  pickFolder?: (options?: { title?: string; defaultPath?: string }) => Promise<string | null>;
  /** A native file picker for opening a file; resolves to its path, or null when cancelled. */
  pickFile?: (options?: { title?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>;
  /**
   * Apply the staged restore: stop Chief (asking about work in progress first), swap in the restored data,
   * start Chief and check its health, then finish or roll back. Only the desktop app can stop Chief.
   */
  applyRestore?: () => Promise<{ ok: boolean; error?: string; report?: { remapped: string[]; review: { file: string; line: number; text: string }[]; missing_secrets: string[] } }>;
};

export function desktop(): ChiefDesktop | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { chiefDesktop?: ChiefDesktop }).chiefDesktop ?? null;
}
