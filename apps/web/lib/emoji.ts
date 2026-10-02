const CUSTOM_EMOJI = /<(a?):([A-Za-z0-9_]{1,32}):(\d{5,22})>/g;

export const PICKER_EMOJI = [
  "😀", "😃", "😄", "😁", "😅", "😂", "🤣", "😊", "😇", "🙂",
  "😉", "😍", "🥰", "😘", "😋", "😜", "🤪", "🤗", "🤔", "😐",
  "🙄", "😏", "😮", "😪", "😴", "😷", "🤒", "🤯", "🤠", "🥳",
  "😎", "🤓", "😕", "🙁", "😲", "😳", "🥺", "😢", "😭", "😤",
  "😡", "🤬", "💀", "👻", "🤖", "👍", "👎", "👋", "🙌", "👏",
  "🙏", "💪", "🔥", "✨", "⭐", "💯", "❤️", "🧡", "💛", "💚",
  "💙", "💜", "💔", "✅", "❌", "⚠️", "🎉", "👀", "💬", "📌",
];

/**
 * Custom emoji written as `<:name:id>` (or `<a:name:id>`, animated) by older chat platforms show as `:name:`.
 * Their images live on a third-party CDN, and this app makes no outside requests to show a message.
 */
export function plainCustomEmoji(text: string) {
  return text.replace(CUSTOM_EMOJI, (_m, _a, name) => `:${name}:`);
}
