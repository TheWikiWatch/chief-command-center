"use client";

import { useState } from "react";

import { MessageSquareWarningIcon } from "@/components/icons";
import { Group } from "@/components/ui/settings-group";
import { btn } from "@/components/ui/button";
import { field } from "@/components/ui/field";
import { desktop } from "@/lib/desktop";

/* Settings → About: a tester tells the developer about a problem, by e-mail (private; no accounts). */

const LIMIT = 1500; // an e-mail link longer than ~2000 characters is cut short by some mail apps

/** The e-mail a report opens: the tester's words, the versions, and the diagnostics file to attach (if made). */
export function reportMail(opts: {
  to: string;
  what: string;
  expected?: string;
  versions: { app: string; hermes: string };
  device: string;
  diagnostics?: string;
  when?: Date;
}): string {
  const clip = (text: string) => (text.length > LIMIT ? `${text.slice(0, LIMIT)}… (cut short)` : text);
  const what = opts.what.trim();
  const first = what.split(/\r?\n/)[0].slice(0, 60);
  const body = [
    "What happened:",
    clip(what),
    ...(opts.expected?.trim() ? ["", "What I expected:", clip(opts.expected.trim())] : []),
    "",
    "----",
    `App ${opts.versions.app || "unknown"} · Hermes ${opts.versions.hermes || "unknown"}`,
    `${opts.device} · ${(opts.when ?? new Date()).toISOString().slice(0, 16).replace("T", " ")} UTC`,
    opts.diagnostics ? `Diagnostics: ${opts.diagnostics} (in the Downloads folder; attach it to this e-mail)` : "Diagnostics: not attached",
  ].join("\n");
  const q = (s: string) => encodeURIComponent(s);
  return `mailto:${opts.to}?subject=${q(`Chief Command Center problem: ${first}${what.length > first.length ? "…" : ""}`)}&body=${q(body)}`;
}

function deviceLine(): string {
  const phone = typeof window !== "undefined" && window.matchMedia?.("(max-width: 767px)").matches;
  const where = desktop() ? "Desktop app" : phone ? "Phone" : "Browser";
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const os = /Windows NT 10/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : "";
  return os ? `${where} on ${os}` : where;
}

export function ReportProblemGroup({ email, versions }: { email: string; versions: { app: string; hermes: string } }) {
  const [what, setWhat] = useState("");
  const [expected, setExpected] = useState("");
  const api = desktop();
  const [withDiagnostics, setWithDiagnostics] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  if (!email) return null;

  async function send() {
    if (!what.trim()) return;
    setBusy(true);
    setNote(null);
    let file = "";
    try {
      if (api?.reportDiagnostics && withDiagnostics) {
        const made = await api.reportDiagnostics();
        if (made.ok) file = made.name || "";
        else setNote({ tone: "error", text: `The diagnostics file couldn't be made (${made.error || "unknown"}); the e-mail opens without it.` });
      }
      window.location.href = reportMail({ to: email, what, expected, versions, device: deviceLine(), diagnostics: file });
      setNote({
        tone: "ok",
        text: file
          ? `Your e-mail app is opening with the report. Attach ${file} (the folder holding it just opened), then send.`
          : "Your e-mail app is opening with the report. Check it, then send.",
      });
      setWhat("");
      setExpected("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Group
      icon={<MessageSquareWarningIcon className="size-4" />}
      title="Report a problem"
      hint="Tell the developer what went wrong. It goes by e-mail from your own e-mail app, so you see everything before it's sent."
    >
      <div className="space-y-3 p-3">
        <label className="block">
          <span className="mb-1.5 block px-1 text-caption font-medium text-fg-3">What happened?</span>
          <textarea
            value={what}
            onChange={(e) => setWhat(e.target.value)}
            rows={4}
            placeholder="What you did, what went wrong, and any error you saw."
            className={field({ extra: "w-full resize-y py-2" })}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block px-1 text-caption font-medium text-fg-3">What did you expect instead? (optional)</span>
          <textarea value={expected} onChange={(e) => setExpected(e.target.value)} rows={2} className={field({ extra: "w-full resize-y py-2" })} />
        </label>
        {api?.reportDiagnostics ? (
          <label className="flex items-start gap-2.5 px-1 text-callout text-fg-2">
            <input type="checkbox" checked={withDiagnostics} onChange={(e) => setWithDiagnostics(e.target.checked)} className="mt-1 size-4 accent-current" />
            <span>
              Include a diagnostics file <span className="text-fg-3">(recommended)</span>
              <span className="mt-0.5 block text-caption text-fg-3">
                Logs, crash reports and versions in a zip, with keys and passwords blanked out. It's saved to your Downloads folder for you to attach.
              </span>
            </span>
          </label>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={btn("primary", "md")} disabled={busy || !what.trim()} onClick={() => void send()}>
            {busy ? "Preparing…" : "Write the e-mail"}
          </button>
          <span className="text-caption text-fg-3">To {email}</span>
        </div>
        {note ? (
          <p role={note.tone === "error" ? "alert" : "status"} className={`text-callout ${note.tone === "error" ? "text-danger" : "text-fg-2"}`}>
            {note.text}
          </p>
        ) : null}
      </div>
    </Group>
  );
}
