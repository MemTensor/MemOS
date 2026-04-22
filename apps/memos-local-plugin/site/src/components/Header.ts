export function renderHeader(): string {
  return `
    <header class="site-header">
      <div class="site-header__inner">
        <a class="site-brand" href="#">
          <span class="site-brand__dot" aria-hidden="true"></span>
          MemOS Local
        </a>
        <nav class="site-nav" aria-label="Primary">
          <a href="#features">Features</a>
          <a href="#architecture">Architecture</a>
          <a href="#releases">Releases</a>
          <a href="/ui/" target="_self">Open viewer</a>
        </nav>
        <button class="theme-toggle" type="button" aria-label="Cycle theme">
          Theme: Auto
        </button>
      </div>
    </header>
  `;
}
