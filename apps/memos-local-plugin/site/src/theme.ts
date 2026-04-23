/**
 * Tiny theme controller for the site.
 *
 * Cycles `auto` → `light` → `dark` and persists to localStorage under
 * the site-local key. No frameworks involved.
 */

const KEY = "memos.site.theme";
type Mode = "auto" | "light" | "dark";
const ORDER: Mode[] = ["auto", "light", "dark"];

function read(): Mode {
  const v = localStorage.getItem(KEY);
  if (v === "light" || v === "dark" || v === "auto") return v;
  return "auto";
}

function apply(mode: Mode) {
  document.documentElement.dataset.theme = mode;
  const toggle = document.querySelector<HTMLButtonElement>(".theme-toggle");
  if (toggle) toggle.textContent = toggleLabel(mode);
}

function toggleLabel(mode: Mode): string {
  return `Theme: ${mode[0].toUpperCase()}${mode.slice(1)}`;
}

export function applyStoredTheme(): void {
  apply(read());
}

export function cycleTheme(): void {
  const cur = read();
  const nxt = ORDER[(ORDER.indexOf(cur) + 1) % ORDER.length];
  localStorage.setItem(KEY, nxt);
  apply(nxt);
}
