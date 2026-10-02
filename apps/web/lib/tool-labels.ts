/**
 * Tool steps in plain words for the chat's timeline: "terminal" reads "Ran a command". Unknown tools (plugins,
 * MCP servers) keep their own name, made readable.
 */
const LABELS: [RegExp, string][] = [
  [/^(terminal|shell|bash|execute_code|run_command)$/, "Ran a command"],
  [/^(read_file|view_file|file_read)$/, "Read a file"],
  [/^(write_file|patch|edit_file|file_write|apply_patch)$/, "Edited a file"],
  [/^(search_files|grep|find_files|list_dir|ls)$/, "Looked through files"],
  [/^(web_search|search_web|websearch)$/, "Searched the web"],
  [/^(web_extract|fetch_url|web_fetch|crawl)/, "Read a web page"],
  [/^browser/, "Used the browser"],
  [/^(vision|vision_analyze|image_analyze)/, "Looked at an image"],
  [/^(image_generate|generate_image)/, "Made an image"],
  [/^(text_to_speech|tts)/, "Made audio"],
  [/^(memory|user_memory)/, "Updated memory"],
  [/^skill/, "Used a skill"],
  [/^(delegate_task|delegate|spawn_agent)/, "Handed work to a specialist"],
  [/^(send_message|message)$/, "Sent a message"],
  [/^(cronjob|schedule|cron)/, "Set up a routine"],
  [/^(kanban|todo|board)/, "Updated the board"],
  [/^session_search/, "Searched past chats"],
  [/^clarify$/, "Asked you a question"],
];

export function toolLabel(name: string): string {
  const key = name.trim().toLowerCase();
  for (const [re, label] of LABELS) if (re.test(key)) return label;
  // mcp__server__do_thing → "Do thing"
  const bare = key.split("__").pop() || key;
  const words = bare.replace(/[_-]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Used a tool";
}

/** A tool's output that reports a failure (a JSON error, a non-zero exit, a traceback). */
export function looksFailed(output: string): boolean {
  const head = output.slice(0, 600);
  return (
    /"success"\s*:\s*false/i.test(head) ||
    /"error"\s*:\s*"[^"]/i.test(head) ||
    /"exit_code"\s*:\s*[1-9]/i.test(head) ||
    /^\s*(error|failed)\b/i.test(head) ||
    /\btraceback \(most recent call last\)/i.test(head)
  );
}

/** "4s", "1m 05s"; empty under a second (not worth showing). */
export function stepDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return "";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
