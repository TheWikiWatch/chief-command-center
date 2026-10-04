"use client";

import { useEffect, useState } from "react";

import { deviceLine, reportMail } from "@/components/settings/report-problem";
import { btn } from "@/components/ui/button";
import { field } from "@/components/ui/field";
import { Sheet } from "@/components/ui/sheet";
import { draftReport, type ReportDraft } from "@/lib/bridge";
import { desktop } from "@/lib/desktop";
import { useAssistantName } from "@/lib/identity";

/**
 * The flag under a reply: tell the developer this went wrong, in two taps. The chief writes a short summary from
 * the reply, the message before it and the recent errors in its logs; the tester sees all of it, adds a note if
 * they like, and their own e-mail app opens with the report (nothing is sent by the app).
 */
export function ReportReplySheet({
  open,
  reply,
  previous,
  email,
  versions,
  onClose,
}: {
  open: boolean;
  reply: string;
  previous: string;
  email: string;
  versions: { app: string; hermes: string };
  onClose: () => void;
}) {
  const assistant = useAssistantName();
  const api = desktop();
  const [draft, setDraft] = useState<ReportDraft | null>(null);
  const [note, setNote] = useState("");
  const [withDiagnostics, setWithDiagnostics] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  // Mounted afresh for each report (the chat keys it), so its state starts clean.
  useEffect(() => {
    if (!open) return;
    let live = true;
    draftReport({ message: reply, previous })
      .then((d) => live && setDraft(d))
      .catch(() => live && setDraft({ ok: true, summary: "", summaryError: `${assistant} couldn't be reached for a summary.`, errors: [] }));
    return () => {
      live = false;
    };
  }, [open, reply, previous, assistant]);

  async function write() {
    setBusy(true);
    let file = "";
    try {
      if (api?.reportDiagnostics && withDiagnostics) {
        const made = await api.reportDiagnostics();
        if (made.ok) file = made.name || "";
      }
      window.location.href = reportMail({
        to: email,
        what: note,
        versions,
        device: deviceLine(),
        diagnostics: file,
        summary: draft?.summary,
        summaryBy: assistant,
        reply,
        errors: draft?.errors,
      });
      setDone({
        tone: "ok",
        text: file ? `Your e-mail app is opening with the report. Attach ${file} (its folder just opened), then send.` : "Your e-mail app is opening with the report. Check it, then send.",
      });
    } catch {
      setDone({ tone: "error", text: "The e-mail couldn't be opened." });
    } finally {
      setBusy(false);
    }
  }

  const writing = draft === null;
  const errors = draft?.errors?.length ?? 0;
  return (
    <Sheet open={open} onClose={onClose} title="Report a problem" subtitle="With this reply, to the developer by e-mail">
      <div className="space-y-4 p-4">
        <section>
          <h3 className="mb-1.5 px-1 text-caption font-medium text-fg-3">{assistant}&apos;s summary</h3>
          <div className="rounded-card border border-line bg-card px-3 py-2.5 text-callout text-fg-2" aria-live="polite">
            {writing ? (
              <span className="animate-pulse text-fg-3">{assistant} is writing a short summary…</span>
            ) : draft?.summary ? (
              <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{draft.summary}</span>
            ) : (
              <span className="text-fg-3">{draft?.summaryError || "No summary this time."} The report goes with the facts below.</span>
            )}
          </div>
        </section>
        <section>
          <h3 className="mb-1.5 px-1 text-caption font-medium text-fg-3">Included</h3>
          <ul className="space-y-1 px-1 text-callout text-fg-2">
            <li className="line-clamp-2 [overflow-wrap:anywhere]">The reply: “{reply.slice(0, 160)}{reply.length > 160 ? "…" : ""}”</li>
            <li>{writing ? "Recent errors from the app's logs…" : errors ? `${errors} recent error${errors === 1 ? "" : "s"} from the app's logs (keys and passwords blanked out)` : "No recent errors in the app's logs"}</li>
            <li>The app and Hermes versions, and this device</li>
          </ul>
        </section>
        <label className="block">
          <span className="mb-1.5 block px-1 text-caption font-medium text-fg-3">Anything to add? (optional)</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="What you expected, or what you were trying to do." className={field({ extra: "w-full resize-y py-2" })} />
        </label>
        {api?.reportDiagnostics ? (
          <label className="flex items-start gap-2.5 px-1 text-callout text-fg-2">
            <input type="checkbox" checked={withDiagnostics} onChange={(e) => setWithDiagnostics(e.target.checked)} className="mt-1 size-4 accent-current" />
            <span>
              Include a diagnostics file <span className="text-fg-3">(recommended)</span>
              <span className="mt-0.5 block text-caption text-fg-3">Saved to your Downloads folder for you to attach.</span>
            </span>
          </label>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={btn("primary", "md")} disabled={busy || writing} onClick={() => void write()}>
            {busy ? "Preparing…" : writing ? "Writing the summary…" : "Write the e-mail"}
          </button>
          <span className="text-caption text-fg-3">To {email}</span>
        </div>
        {done ? (
          <p role={done.tone === "error" ? "alert" : "status"} className={`text-callout ${done.tone === "error" ? "text-danger" : "text-fg-2"}`}>
            {done.text}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
