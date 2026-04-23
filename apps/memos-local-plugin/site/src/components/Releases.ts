/**
 * Release feed component.
 *
 * Uses Vite's `import.meta.glob(..., { as: 'raw', eager: true })` to
 * compile the `content/releases/*.md` files into the bundle as raw
 * strings. We parse the YAML frontmatter ourselves — the site doesn't
 * need a Markdown runtime.
 */

const rawReleases = import.meta.glob<string>(
  "../../content/releases/*.md",
  { query: "?raw", import: "default", eager: true },
);

interface ReleaseMeta {
  version: string;
  date: string;
  title: string;
  highlight: string;
  kind: string;
  body: string;
}

function parseFrontmatter(raw: string): ReleaseMeta {
  const match = raw.match(/^---\s*\n([\s\S]+?)\n---\s*\n?([\s\S]*)$/);
  if (!match) {
    return {
      version: "",
      date: "",
      title: "(malformed release)",
      highlight: "",
      kind: "",
      body: raw,
    };
  }
  const [, fm, body] = match;
  const meta: Record<string, string> = {};
  for (const line of fm.split("\n")) {
    const kv = line.match(/^([a-zA-Z][\w-]*):\s*"?([^"]*)"?\s*$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return {
    version: meta.version ?? "",
    date: meta.date ?? "",
    title: meta.title ?? "",
    highlight: meta.highlight ?? "",
    kind: meta.kind ?? "minor",
    body: body.trim(),
  };
}

function releases(): ReleaseMeta[] {
  return Object.entries(rawReleases)
    .filter(([path]) => !/template\.md$/.test(path))
    .map(([, raw]) => parseFrontmatter(raw))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

function escape(s: string): string {
  return s.replace(/[&<>"]/g, (c) => {
    if (c === "&") return "&amp;";
    if (c === "<") return "&lt;";
    if (c === ">") return "&gt;";
    return "&quot;";
  });
}

function renderMarkdownLite(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inList = false;
  let inCode = false;
  let codeBuf: string[] = [];

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith("```")) {
      if (inCode) {
        out.push(`<pre><code>${escape(codeBuf.join("\n"))}</code></pre>`);
        codeBuf = [];
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    if (/^##\s+/.test(line)) {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push(`<h4>${escape(line.replace(/^##\s+/, ""))}</h4>`);
    } else if (/^-\s+/.test(line)) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${escape(line.replace(/^-\s+/, ""))}</li>`);
    } else if (line === "") {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push("");
    } else if (line.startsWith("<!--")) {
      continue;
    } else {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push(`<p>${escape(line)}</p>`);
    }
  }
  if (inList) out.push("</ul>");
  return out.join("\n");
}

function renderItem(r: ReleaseMeta): string {
  return `
    <li class="release-item">
      <header>
        <h3>v${escape(r.version)} — ${escape(r.title)}</h3>
        <span class="release-item__meta">
          <span class="badge badge--${escape(r.kind)}">${escape(r.kind)}</span>
          · ${escape(r.date)}
        </span>
      </header>
      <p class="release-item__highlight">${escape(r.highlight)}</p>
      <div class="release-item__body">${renderMarkdownLite(r.body)}</div>
    </li>
  `;
}

export function renderReleases(): string {
  const list = releases();
  const empty = list.length === 0;
  return `
    <section id="releases" class="site-section">
      <div class="site-section__inner">
        <h2>Release notes</h2>
        <p style="color: var(--site-mute); max-width: 60ch; margin-bottom: 32px;">
          ${
            empty
              ? "No releases published yet."
              : `Most recent first, compiled from <code>content/releases/</code>.`
          }
        </p>
        ${
          empty
            ? ""
            : `<ol class="release-list">${list.map(renderItem).join("")}</ol>`
        }
      </div>
    </section>
  `;
}
