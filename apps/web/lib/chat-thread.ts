/**
 * The conversation the chat panel shows (threads: separate conversations with the chief). Only one chat is
 * mounted at a time, so the chat's bridge requests carry this thread; "main" is the chief's main chat.
 */
let chatThread = "main";

export function setChatThread(id: string) {
  chatThread = id || "main";
}

export function currentChatThread() {
  return chatThread;
}
