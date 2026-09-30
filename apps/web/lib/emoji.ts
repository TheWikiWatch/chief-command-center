const DISCORD_EMOJI = /<(a?):([A-Za-z0-9_]{1,32}):(\d{5,22})>/g;

export const PICKER_EMOJI = [
  "😀", "😃", "😄", "😁", "😅", "😂", "🤣", "😊", "😇", "🙂",
  "😉", "😍", "🥰", "😘", "😋", "😜", "🤪", "🤗", "🤔", "😐",
  "🙄", "😏", "😮", "😪", "😴", "😷", "🤒", "🤯", "🤠", "🥳",
  "😎", "🤓", "😕", "🙁", "😲", "😳", "🥺", "😢", "😭", "😤",
  "😡", "🤬", "💀", "👻", "🤖", "👍", "👎", "👋", "🙌", "👏",
  "🙏", "💪", "🔥", "✨", "⭐", "💯", "❤️", "🧡", "💛", "💚",
  "💙", "💜", "💔", "✅", "❌", "⚠️", "🎉", "👀", "💬", "📌",
];

export function discordEmojiUrl(animated: boolean, id: string) {
  if (!/^\d{5,22}$/.test(id)) return null;
  return `https://cdn.discordapp.com/emojis/${id}.${animated ? "gif" : "png"}?size=48`;
}

export function withDiscordEmojiMarkdown(text: string) {
  return text.replace(DISCORD_EMOJI, (_m, a, name, id) => {
    const src = discordEmojiUrl(a === "a", id);
    if (!src) return _m;
    return `![${name}](${src})`;
  });
}

export type EmojiPiece = { type: "text"; value: string } | { type: "emoji"; name: string; src: string };

export function splitDiscordEmoji(text: string): EmojiPiece[] {
  const out: EmojiPiece[] = [];
  let last = 0;
  const re = new RegExp(DISCORD_EMOJI.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ type: "text", value: text.slice(last, m.index) });
    const src = discordEmojiUrl(m[1] === "a", m[3]);
    if (src) out.push({ type: "emoji", name: m[2], src });
    else out.push({ type: "text", value: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  return out.length ? out : [{ type: "text", value: text }];
}
