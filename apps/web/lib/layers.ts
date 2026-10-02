/**
 * The stacking order, lowest first. Class-based layers (`z-10` … `z-50`) are for things inside a pane; these are
 * the floating layers above it. A sheet opened from another sheet takes the next layer up.
 *
 *   10–30  inside a pane: raised rows, headers, the composer and tab bar
 *   40     a pane's own sheets (approval, a task, the vault folder)
 *   45     voice mode's backdrop; 50 the phone shell's floating controls
 *   60     sheets over the whole app (settings, status)
 *   70     a sheet opened from one of those (update history)
 *   75     voice mode; 80 the image viewer and hover cards
 *   90     the look drawer, which opens from anywhere, sheets included
 */
export const LAYER = {
  paneSheet: 40,
  sheet: 60,
  sheetOverSheet: 70,
  hoverCard: 80,
  drawer: 90,
} as const;
