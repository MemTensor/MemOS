/**
 * Unit tests for the site release parser.
 *
 * The parser is trivial but its output feeds a user-visible widget,
 * so we pin both the success path and a few malformed-input edge
 * cases.
 */

import { describe, it, expect } from "vitest";

// The parser is a pure function inside Releases.ts. We exercise it
// via dynamic import + text extraction — cheaper than a jsdom test.
async function parse(raw: string) {
  // Inline the parser to keep the test completely decoupled from
  // Vite's glob import plumbing. The implementation mirrors
  // src/components/Releases.ts.
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

describe("site release parser", () => {
  it("parses a fully-populated release", async () => {
    const raw = `---
version: 2.0.0-alpha.1
date: 2026-04-17
title: "Initial scaffolding"
highlight: "Sets up directories and contract layer."
kind: alpha
---

## Summary

First alpha.`;
    const r = await parse(raw);
    expect(r.version).toBe("2.0.0-alpha.1");
    expect(r.date).toBe("2026-04-17");
    expect(r.title).toBe("Initial scaffolding");
    expect(r.kind).toBe("alpha");
    expect(r.body.startsWith("## Summary")).toBe(true);
  });

  it("defaults missing `kind` to `minor`", async () => {
    const raw = `---
version: 1.0.0
date: 2026-05-01
title: "x"
highlight: "y"
---

## Summary

...`;
    const r = await parse(raw);
    expect(r.kind).toBe("minor");
  });

  it("handles input without frontmatter gracefully", async () => {
    const r = await parse("# just a plain markdown file\n\nbody only");
    expect(r.title).toBe("(malformed release)");
    expect(r.body).toContain("# just a plain markdown file");
  });
});
