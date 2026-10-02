"use client";

import { useEffect, useState } from "react";
import { BookOpenIcon, InfoIcon } from "@/components/icons";
import { UpdateHistoryButton } from "@/components/updates/update-history";
import { Group, PillButton, Row } from "@/components/ui/settings-group";
import { desktop } from "@/lib/desktop";
import { fetchAbout, type AboutInfo } from "@/lib/about-client";
import { LoadingLine } from "@/components/ui/surface";

/* Settings → About. */

/** About: what this is built from, and whose work it carries. */
export function AboutGroup() {
  const [about, setAbout] = useState<AboutInfo | null>(null);
  useEffect(() => {
    void fetchAbout()
      .then(setAbout)
      .catch(() => setAbout(null));
  }, []);
  return (
    <>
      <Group icon={<InfoIcon className="size-4" />} title="Chief Command Center" action={<UpdateHistoryButton />}>
        <Row label="Version" hint={about ? about.app || "unknown" : <LoadingLine className="w-16" />} />
        <Row label="Hermes Agent" hint={about ? `${about.hermes || "version unknown"}, by Nous Research (MIT)` : <LoadingLine className="w-40" />} />
        <Row
          label="Hermes updates"
          hint="Hermes is built into the app and never updates itself. A newer Hermes reaches you as an app update, once it passes the app's compatibility checks; the app backs up your data before Hermes first starts on it."
        />
        <Row label="Licence" hint="MIT. Your data stays on this computer unless you send it somewhere." />
        <NoticesRow />
        <DiagnosticsRow />
      </Group>
      <Group icon={<BookOpenIcon className="size-4" />} title="Bundled with credit">
        <Row
          label={about?.toolkit ? `obsidian-second-brain ${about.toolkit.version}` : "obsidian-second-brain"}
          hint={`The Second Brain skills and routines, by Eugeniu Ghelbur (MIT). ${about?.toolkit?.source || "github.com/eugeniughelbur/obsidian-second-brain"}`}
        />
      </Group>
    </>
  );
}

/** Desktop app only: the licences of everything the app bundles (npm and Python packages, ffmpeg, Git…). */
function NoticesRow() {
  const [note, setNote] = useState("");
  const open = desktop()?.openNotices;
  if (!open) return null;
  return (
    <Row label="Third-party licences" hint={note || "The open-source software inside the app, with each licence, and where to get the source of the GPL programs (ffmpeg, Git)."}>
      <div className="mt-2">
        <PillButton onClick={() => void open().then((r) => setNote(r === "missing" ? "This build doesn't include them (a development build)." : ""))}>Open</PillButton>
      </div>
    </Row>
  );
}

/** Desktop app only: a zip of the logs, crash dumps and versions, for the owner to look through and send. */
function DiagnosticsRow() {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const make = desktop()?.diagnostics;
  if (!make) return null;
  return (
    <Row label="Diagnostics" hint={note || "Logs, crash reports and versions in one zip, to send when something goes wrong. Nothing is sent by the app; look through it first."}>
      <div className="mt-2">
        <PillButton
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setNote("");
            void make()
              .then((r) => setNote(r.ok ? "Saved. The folder with the zip is open." : r.error === "cancelled" ? "" : `Couldn't make it: ${r.error}`))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Collecting…" : "Create diagnostics"}
        </PillButton>
      </div>
    </Row>
  );
}

/* ------------------------------------------------------------------ Connection (the chief's model) */
