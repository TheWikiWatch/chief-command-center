/*
 * A command or call as the approval sheet shows it: nothing the author can hide. Bidirectional overrides and
 * zero-width characters (which can make `rm -rf` read as something else, or hide text) are shown as visible markers,
 * and runs of blank lines or spaces (which can push the dangerous part out of view) are collapsed with a count.
 */

// Bidi embeddings/overrides/isolates, zero-width and invisible format characters, the BOM.
const HIDDEN = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g;

const hex = (ch: string) => ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");

/*
 * Hermes 0.23 marks an approval's hidden characters itself (agent/redact.py): each as Python spells it escaped
 * (\u200b, \U000e0100, \xad), a run of four or more once with its count (⟨\u200b ×5⟩), and long padding collapsed
 * (⟨+N blank lines⟩, ⟨+N whitespace chars⟩). What arrives marked that way counts the same as the raw characters.
 */
const ESCAPE = String.raw`\\(?:x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8})`;
const ESCAPED = new RegExp(`⟨(${ESCAPE}) ×(\\d+)⟩|(${ESCAPE})`, "g");
const COLLAPSED = /⟨\+\d+ (?:blank lines|whitespace chars)⟩/;
// Hermes's rule for what it escapes: control, format and unassigned code points, line and paragraph separators, and
// characters that draw as blank. An escape of anything else (a command's own `\u00e9`) is ordinary text.
const BLANK = /[\u{34f}\u{115f}\u{1160}\u{17b4}\u{17b5}\u{180b}-\u{180d}\u{180f}\u{2800}\u{3164}\u{ffa0}\u{fe00}-\u{fe0f}\u{e0100}-\u{e01ef}]/u;

function escapesHidden(escape: string): boolean {
  const code = parseInt(escape.slice(2), 16);
  if (!(code <= 0x10ffff)) return false;
  const ch = String.fromCodePoint(code);
  return /[\p{C}\p{Zl}\p{Zp}]/u.test(ch) || BLANK.test(ch);
}

export type Revealed = { text: string; hidden: number; collapsed: boolean };

export function revealCommand(raw: string): Revealed {
  let hidden = 0;
  let collapsed = COLLAPSED.test(raw);
  for (const [, run, count, one] of raw.matchAll(ESCAPED)) if (escapesHidden(run || one)) hidden += run ? Number(count) : 1;
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
