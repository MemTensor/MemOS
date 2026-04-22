/**
 * check-changelog — CI guard.
 *
 * Asserts that `site/content/releases/<package.json version>.md` exists
 * and has valid frontmatter. Runs in CI before `npm publish`. Exits 0
 * on success, 1 on failure.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

function main(): void {
  const root = process.cwd();
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
    version: string;
  };
  const notePath = path.join(root, "site", "content", "releases", `${pkg.version}.md`);
  if (!existsSync(notePath)) {
    console.error(`[release-check] missing release note for ${pkg.version}: ${notePath}`);
    process.exit(1);
  }
  const raw = readFileSync(notePath, "utf8");
  const m = raw.match(/^---\s*\n([\s\S]+?)\n---/);
  if (!m) {
    console.error(`[release-check] no frontmatter in ${notePath}`);
    process.exit(1);
  }
  const fm = m[1];
  for (const key of ["version", "date", "title", "highlight"]) {
    if (!new RegExp(`^${key}:`, "m").test(fm)) {
      console.error(`[release-check] missing frontmatter key '${key}' in ${notePath}`);
      process.exit(1);
    }
  }
  console.log(`[release-check] ok: ${notePath}`);
}

main();
