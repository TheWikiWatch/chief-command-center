import { plainCustomEmoji } from "@/lib/emoji";

export function EmojiText({ text }: { text: string }) {
  return <span className="whitespace-pre-wrap">{plainCustomEmoji(text)}</span>;
}
