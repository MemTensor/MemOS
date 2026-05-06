#!/usr/bin/env node
"use strict";

/**
 * Post-build: append `.js` (or `/index.js`) to every relative ESM import in dist/.
 *
 * Why: tsconfig uses `moduleResolution: "bundler"` so source files don't need
 * `.js` suffixes — but Node's native ESM loader requires explicit suffixes.
 * OpenClaw's plugin loader runs the emitted JS through the standard loader,
 * so we rewrite the imports here instead of polluting source with `.js`.
 */

const fs = require("fs");
const path = require("path");

const DIST = path.resolve(__dirname, "..", "dist");

// Matches:  import ... from "X"  |  export ... from "X"  |  import("X")
const IMPORT_RE = /(\bfrom\s*['"]|\bimport\s*\(\s*['"])(\.[^'"]+)(['"])/g;

function rewriteSpec(spec, fileDir) {
  if (/\.(m?js|cjs|json)$/.test(spec)) return spec;
  const abs = path.resolve(fileDir, spec);
  if (fs.existsSync(abs + ".js")) return spec + ".js";
  if (fs.existsSync(path.join(abs, "index.js"))) return spec.replace(/\/?$/, "/index.js");
  return spec;
}

let touched = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!entry.name.endsWith(".js")) continue;
    const src = fs.readFileSync(full, "utf8");
    let changed = false;
    const out = src.replace(IMPORT_RE, (m, head, spec, tail) => {
      const next = rewriteSpec(spec, path.dirname(full));
      if (next !== spec) { changed = true; return head + next + tail; }
      return m;
    });
    if (changed) { fs.writeFileSync(full, out); touched++; }
  }
}

if (!fs.existsSync(DIST)) {
  console.error("[fix-esm-imports] dist/ not found — run tsc first");
  process.exit(1);
}
walk(DIST);
console.log(`[fix-esm-imports] rewrote imports in ${touched} file(s)`);
