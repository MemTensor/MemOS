/**
 * build-index — rebuild CHANGELOG.md + site/content/releases/index.json
 * from the per-version markdown files under site/content/releases/.
 *
 * Runs in two steps:
 *   1. Scan `site/content/releases/*.md`, parse frontmatter.
 *   2. Emit:
 *      - `site/content/releases/index.json` — sorted list consumed by the
 *        site's Releases widget (title/date/highlight/kind).
 *      - `CHANGELOG.md` at the plugin root — human-readable index with a
 *        link + highlight per release.
 *
 * Releases without valid frontmatter are skipped with a warning so a
 * half-written draft never poisons the index.
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";

interface ReleaseMeta {
  version: string;
  date: string;
  title: string;
  highlight: string;
  kind: string;
  filename: string;
}

function parseFrontmatter(raw: string, filename: string): ReleaseMeta | null {
  const m = raw.match(/^---\s*\n([\s\S]+?)\n---\s*\n?/);
  if (!m) {
    console.warn(`[release-index] skipping ${filename}: no frontmatter block`);
    return null;
  }
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-zA-Z][\w-]*):\s*"?([^"]*)"?\s*$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  if (!meta.version || !meta.date || !meta.title) {
    console.warn(`[release-index] skipping ${filename}: missing required fields`);
    return null;
  }
  return {
    version: meta.version,
    date: meta.date,
    title: meta.title,
    highlight: meta.highlight ?? "",
    kind: meta.kind || "minor",
    filename,
  };
}

function compareVersion(a: ReleaseMeta, b: ReleaseMeta): number {
  // Newest first.
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  return a.version < b.version ? 1 : -1;
}

function main(): void {
  // `__dirname` in ESM is not available; resolve relative to CWD which is the plugin root.
  const root = process.cwd();
  const dir = path.join(root, "site", "content", "releases");
  const files = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "template.md");

  const releases: ReleaseMeta[] = [];
  for (const f of files) {
    const raw = readFileSync(path.join(dir, f), "utf8");
    const meta = parseFrontmatter(raw, f);
    if (meta) releases.push(meta);
  }
  releases.sort(compareVersion);

  writeFileSync(
    path.join(dir, "index.json"),
    JSON.stringify(releases, null, 2) + "\n",
  );

  const lines = [
    "# Changelog",
    "",
    "All notable changes to `@memtensor/memos-local-plugin` are documented per",
    "release in [`site/content/releases/`](./site/content/releases/). This file is",
    "regenerated from those release notes by `npm run release:index`.",
    "",
    "> Do **not** edit this file by hand. Edit the per-version markdown in",
    "> `site/content/releases/<version>.md` instead.",
    "",
    "## Index",
    "",
  ];
  for (const r of releases) {
    lines.push(`- [\`${r.version}\`](./site/content/releases/${r.filename}) — ${r.highlight || r.title}`);
  }
  writeFileSync(path.join(root, "CHANGELOG.md"), lines.join("\n") + "\n");

  console.log(`[release-index] wrote ${releases.length} entries to CHANGELOG.md + index.json`);
}

main();
