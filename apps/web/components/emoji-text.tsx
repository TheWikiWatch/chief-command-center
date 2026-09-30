import { splitDiscordEmoji } from "@/lib/emoji";

export function EmojiText({ text }: { text: string }) {
  return (
    <span className="whitespace-pre-wrap">
      {splitDiscordEmoji(text).map((part, i) =>
        part.type === "emoji" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={`${part.src}-${i}`} alt={part.name} src={part.src} className="chat-emoji" />
        ) : (
          <span key={i}>{part.value}</span>
        ),
      )}
    </span>
  );
}
