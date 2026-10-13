/*
 * A command or call as the approval sheet shows it: nothing the author can hide. Bidirectional overrides and
 * zero-width characters (which can make `rm -rf` read as something else, or hide text) are shown as visible markers,
 * and runs of blank lines or spaces (which can push the dangerous part out of view) are collapsed with a count.
 */

// Bidi embeddings/overrides/isolates, zero-width and invisible format characters, the BOM.
const HIDDEN = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g;

const hex = (ch: string) => ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");

export type Revealed = { text: string; hidden: number; collapsed: boolean };

export function revealCommand(raw: string): Revealed {
  let hidden = 0;
  let collapsed = false;
  let text = raw.replace(HIDDEN, (ch) => {
    hidden += 1;
    return `⟨U+${hex(ch)}⟩`;
  });
  text = text.replace(/\n(?:[ \t]*\n){3,}/g, (run) => {
    collapsed = true;
    return `\n⟨${run.split("\n").length - 1} blank lines⟩\n`;
  });
  text = text.replace(/[ \t]{12,}/g, (run) => {
    collapsed = true;
    return ` ⟨${run.length} spaces⟩ `;
  });
  return { text, hidden, collapsed };
}
