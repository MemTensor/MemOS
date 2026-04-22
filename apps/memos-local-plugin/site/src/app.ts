/**
 * Vanilla renderer for the site.
 *
 * The site is three scrollable sections + a release-notes feed. Vite
 * resolves Markdown fixtures via `import.meta.glob` (raw) so we can
 * display them without a markdown runtime.
 */

import { renderHeader } from "./components/Header";
import { renderHero } from "./components/Hero";
import { renderFeatures } from "./components/Features";
import { renderArchitecture } from "./components/Architecture";
import { renderReleases } from "./components/Releases";
import { renderFooter } from "./components/Footer";
import { applyStoredTheme, cycleTheme } from "./theme";

export function renderApp(root: HTMLElement): void {
  applyStoredTheme();
  root.innerHTML = `
    <div class="site-root">
      ${renderHeader()}
      <main class="site-main">
        ${renderHero()}
        ${renderFeatures()}
        ${renderArchitecture()}
        ${renderReleases()}
      </main>
      ${renderFooter()}
    </div>
  `;
  wireInteractions(root);
}

function wireInteractions(root: HTMLElement): void {
  const toggle = root.querySelector<HTMLButtonElement>(".theme-toggle");
  toggle?.addEventListener("click", () => cycleTheme());
}
