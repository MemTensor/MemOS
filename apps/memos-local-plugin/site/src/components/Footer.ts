export function renderFooter(): string {
  const year = new Date().getFullYear();
  return `
    <footer class="site-footer">
      <div class="site-footer__inner">
        <div>
          MemOS Local · ${year} · runs on your laptop, never phones home
        </div>
        <div>
          <a href="https://github.com/">Repo</a> ·
          <a href="/ui/">Viewer</a> ·
          <a href="#architecture">Architecture</a>
        </div>
      </div>
    </footer>
  `;
}
