# `site/` — MemOS Local product site

A local-first "marketing / docs / release notes" page for MemOS Local.
Intentionally **not** deployed anywhere: it's built to `site/dist/`
and served by the plugin's HTTP server under `/site/` so users have
a first-class introduction without ever touching the network.

## Why a local site?

The plugin is highly technical, and operators need something more
approachable than the viewer to orient:

- What is Reflect2Evolve, in 3 bullets?
- What runs on my machine vs. in the cloud? (Nothing in the cloud.)
- What version am I on, what did it change, what's next?
- Where is the viewer? Where are the configs?

A static, handcrafted site is the right shape for that — no
framework, no build-step surprises, ~14 kB of JS + 8 kB of CSS.

## Layout

```
site/
├── index.html                    # Vite entry, single-page shell
├── vite.config.ts                # `root: "."`, outputs `dist/`
├── public/
│   └── logo.svg                  # Brand mark
├── src/
│   ├── main.ts                   # Bootstrap → renderApp()
│   ├── app.ts                    # Top-level renderer + interaction wiring
│   ├── theme.ts                  # auto / light / dark cycling
│   ├── styles/
│   │   ├── base.css              # Reset + typography
│   │   ├── theme.css             # Tokens (light/dark/auto)
│   │   ├── layout.css            # Header, sections, grids
│   │   └── components.css        # Buttons, cards, badges
│   └── components/
│       ├── Header.ts             # Sticky nav + theme toggle
│       ├── Hero.ts               # Landing block with CTA → /ui/
│       ├── Features.ts           # Six-card capability grid
│       ├── Architecture.ts       # Three-column adapter / core / runtime
│       ├── Releases.ts           # Markdown-lite feed of `content/releases/*.md`
│       └── Footer.ts             # License/links/year stub
├── content/
│   ├── index.json                # Pre-computed release index (hand-edited)
│   ├── docs/                     # Reserved for future doc content
│   └── releases/
│       ├── template.md           # Frontmatter template for new releases
│       └── *.md                  # One file per release
└── scripts/                      # Reserved for release-index automation
```

## Philosophy

- **Vanilla TS only.** No framework. Each "component" is a function
  returning an HTML string; the root is injected once via
  `innerHTML`. Interactivity is added by `querySelector`/
  `addEventListener` in `app.ts`.
- **Markdown-lite.** `Releases.ts` implements just enough Markdown
  (headings, lists, paragraphs, fenced code) to render the release
  notes without dragging in a full parser. Frontmatter is parsed
  line-by-line — `name: value` only, no YAML escape hatches.
- **Theme coherence.** Same `data-theme` mechanism as the viewer,
  separate storage key (`memos.site.theme`) so theme choices don't
  bleed between apps.

## Writing a release

1. Copy `content/releases/template.md` to `content/releases/<version>.md`.
2. Fill frontmatter (version / date / title / highlight / kind).
3. Write bullets under the standard headings (`## Summary`, `## New`,
   `## Changed`, `## Fixed`, `## Breaking`, `## Internals`,
   `## Thanks`, `## Commits`). The site only renders the first few
   headings — `Commits` etc. are kept for the raw file and tooling.

The site compiles the frontmatter + body into a card at build time;
no server-side rendering is needed.

## Build

```bash
# From apps/memos-local-plugin
npm run build:site      # → site/dist/
```

The build is self-contained: it produces `dist/index.html`, a single
JS chunk, a single CSS chunk, and copies `public/` assets. Bundle
weight:

| Asset       | Size         |
| ----------- | ------------ |
| HTML        | ~0.7 KB      |
| CSS         | ~8 KB        |
| JS          | ~12 KB       |
| **Total**   | **~21 KB**   |

(gzipped: ~8 KB total)

## Running in dev

```bash
npm run site:dev        # Vite dev server on :5174
```

Useful when editing styles live. The dev server does not proxy the
plugin's HTTP API, since the site is purely static.

## Serving from the plugin

The plugin's HTTP server (see `../server/README.md`) serves the
built bundle at `/site/` via the static middleware — with directory-
traversal guards and no cache headers in dev.
