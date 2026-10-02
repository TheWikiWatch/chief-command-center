/** Every word of the query appears in the label, the keywords or the group (the palette and Settings search). */
export function matches(command: { label: string; keywords?: string; group: string }, query: string): boolean {
  const hay = `${command.label} ${command.keywords || ""} ${command.group}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}
