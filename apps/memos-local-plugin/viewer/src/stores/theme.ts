/**
 * Theme controller — `light` | `dark` | `auto`.
 *
 * - `light` / `dark` force the palette.
 * - `auto` defers to `prefers-color-scheme` via CSS.
 *
 * The chosen mode persists in localStorage and is mirrored to
 * `<html data-theme>` so CSS selectors pick it up without any
 * component subscriptions.
 */
import { signal } from "@preact/signals";

export type Theme = "light" | "dark" | "auto";

const KEY = "memos.theme";

function initial(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "auto") return v;
  } catch {
    // ignore
  }
  return "auto";
}

export const theme = signal<Theme>(initial());

export function setTheme(next: Theme): void {
  theme.value = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // ignore
  }
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = next;
  }
}

/**
 * Set the theme explicitly.
 *
 * We historically exposed a `cycleTheme()` that rotated through the
 * three modes, but the sidebar segmented control now lets the user
 * pick directly — so this is just a named alias to keep callers tidy.
 */
export function cycleTheme(next: Theme): void {
  setTheme(next);
}

// Initialise on import so the first paint already has the right
// data-theme attribute.
setTheme(theme.value);
