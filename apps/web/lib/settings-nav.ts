/** Settings categories, and a way for any part of the app to open Settings at one (the usage strip opens Usage). */
export type SettingsCategory = "general" | "models" | "tools" | "voice" | "second-brain" | "notifications" | "phone" | "usage" | "backup" | "about";

export const OPEN_SETTINGS_EVENT = "chief:open-settings";

export function openSettings(category?: SettingsCategory) {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { category } }));
}

/** Team & Routines, opened at a tab (Settings → Second Brain links to the routines). */
export type TeamTab = "team" | "routines";
export const OPEN_TEAM_EVENT = "chief:open-team";

export function openTeam(tab: TeamTab = "team") {
  window.dispatchEvent(new CustomEvent(OPEN_TEAM_EVENT, { detail: { tab } }));
}
