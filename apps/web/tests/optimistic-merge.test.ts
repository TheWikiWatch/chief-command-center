import { expect, it } from "vitest";

import { MAX_KEPT_MESSAGES, mergeMsgs } from "@/components/chief-chat";
import type { ChatMessage } from "@/lib/types";

const local = (id: number, content: string, attachments = 0): ChatMessage => ({
  id: 1e12 + id,
  role: "user",
  content,
  attachments: Array.from({ length: attachments }, (_, i) => ({ path: `blob:x/${i}`, name: `f${i}.png`, kind: "image", mime: "image/png" })),
});
const stored = (id: number, content: string, attachments = 0): ChatMessage => ({
  id,
  role: "user",
  content,
  attachments: Array.from({ length: attachments }, (_, i) => ({ path: `C:\\cache\\up_${i}.png`, name: `f${i}.png`, kind: "image", mime: "image/png" })),
});

it("replaces a sending bubble whose stored text differs only in whitespace", () => {
  const out = mergeMsgs([local(1, "Status?\n\nplease")], [stored(10, "Status? please")]);
  expect(out.map((m) => m.id)).toEqual([10]);
});

it("replaces an attachment-only bubble with the stored row that brought files", () => {
  const out = mergeMsgs([local(1, "", 2)], [stored(10, "", 2)]);
  expect(out.map((m) => m.id)).toEqual([10]);
});

it("replaces a bubble whose caption was stored with extra text around it", () => {
  const out = mergeMsgs([local(1, "summarize this")], [stored(10, "[Content of notes.txt]\n…\n\nsummarize this")]);
  expect(out.map((m) => m.id)).toEqual([10]);
});

it("keeps other bubbles, and one stored row replaces only one bubble", () => {
  const out = mergeMsgs([local(1, "hi"), local(2, "hi")], [stored(10, "hi")]);
  expect(out.map((m) => m.id)).toEqual([10, 1e12 + 2]);
});

it("does not treat rows it already had as new confirmations", () => {
  const prev = [stored(10, "hi"), local(1, "hi")];
  expect(mergeMsgs(prev, [stored(10, "hi")]).map((m) => m.id)).toEqual([10, 1e12 + 1]);
});

it("drops the oldest rows once the chat holds the maximum, never a sending bubble", () => {
  const prev = Array.from({ length: MAX_KEPT_MESSAGES }, (_, i) => stored(i + 1, `m${i + 1}`));
  const out = mergeMsgs([...prev, local(1, "pending")], [stored(MAX_KEPT_MESSAGES + 1, "new")]);
  expect(out).toHaveLength(MAX_KEPT_MESSAGES + 1);
  expect(out[0].id).toBe(2);
  expect(out.at(-1)?.id).toBe(1e12 + 1);
});
