"use client";

import { useEffect, useState } from "react";
import { BookOpenIcon, InfoIcon } from "@/components/icons";
import { UpdateHistoryButton } from "@/components/updates/update-history";
import { Group, Row } from "@/components/ui/settings-group";
import { fetchAbout, type AboutInfo } from "@/lib/about-client";

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
        <Row label="Version" hint={about?.app || "…"} />
        <Row label="Hermes Agent" hint={about ? `${about.hermes || "version unknown"}, by Nous Research (MIT)` : "…"} />
        <Row
          label="Hermes updates"
          hint="Hermes is built into the app and never updates itself. A newer Hermes reaches you as an app update, once it passes the app's compatibility checks; the app backs up your data before Hermes first starts on it."
        />
        <Row label="Licence" hint="MIT. Your data stays on this computer unless you send it somewhere." />
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

/* ------------------------------------------------------------------ Connection (the chief's model) */
