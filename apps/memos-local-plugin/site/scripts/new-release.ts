/**
 * new-release — scaffold a new release-note markdown from template.md.
 *
 * Usage:
 *   tsx site/scripts/new-release.ts 2.0.0-rc.1
 *
 * Creates `site/content/releases/<version>.md`, prefilled with the
 * version + today's date + the template body. It does NOT touch
 * `package.json` or run `release:index` — those are explicit steps so
 * the author can hand-edit the note first.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

function main(): void {
  const version = process.argv[2];
  if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
    console.error("usage: tsx site/scripts/new-release.ts <version>");
    process.exit(1);
  }

  const root = process.cwd();
  const dir = path.join(root, "site", "content", "releases");
  const target = path.join(dir, `${version}.md`);
  if (existsSync(target)) {
    console.error(`release note already exists: ${target}`);
    process.exit(1);
  }

  const template = readFileSync(path.join(dir, "template.md"), "utf8");
  const today = new Date().toISOString().slice(0, 10);
  const filled = template
    .replace(/^version:\s*.*$/m, `version: ${version}`)
    .replace(/^date:\s*.*$/m, `date: ${today}`);
  writeFileSync(target, filled);
  console.log(`[release-new] wrote ${target}`);
  console.log(`[release-new] next:\n  $EDITOR ${target}\n  npm run release:index`);
}

main();
