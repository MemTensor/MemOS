import { describe, it, expect } from "vitest";
import {
  ensureGroupPluginsAllowed,
} from "../src/shared/openclaw-config";

/**
 * Regression coverage for issue #1543:
 *
 *   memos-local: could not patch tools.allow:
 *   SyntaxError: Expected double-quoted property name in JSON at position 2222 (line 90 column 7)
 *
 * The user's openclaw.json has `// ...` line comments, and the previous
 * implementation called strict JSON.parse on it.
 */
describe("ensureGroupPluginsAllowed (issue #1543)", () => {
  it("patches tools.allow even when openclaw.json contains // comments", () => {
    const raw = `{
      // top of file
      "tools": {
        // these tools are allowed
        "allow": [
          "Bash",
          "Read",
          "Write"
        ]
      }
    }`;
    const r = ensureGroupPluginsAllowed(raw);
    expect(r.changed).toBe(true);
    expect(r.patched).toContain(`"group:plugins"`);
    // Existing comments must survive.
    expect(r.patched).toContain("// top of file");
    expect(r.patched).toContain("// these tools are allowed");
  });

  it("patches tools.allow when openclaw.json uses single-quoted strings", () => {
    const raw = `{
      "tools": {
        "allow": ['Bash', 'Read', 'Write']
      }
    }`;
    const r = ensureGroupPluginsAllowed(raw);
    expect(r.changed).toBe(true);
    expect(r.patched).toContain("'group:plugins'");
  });

  it("patches tools.allow when openclaw.json has trailing commas", () => {
    const raw = `{
      "tools": {
        "allow": ["Bash", "Read", "Write",],
      },
    }`;
    const r = ensureGroupPluginsAllowed(raw);
    expect(r.changed).toBe(true);
    expect(r.patched).toContain(`"group:plugins"`);
  });

  it("does nothing when tools.allow already contains group:plugins", () => {
    const raw = `{
      "tools": { "allow": ["Bash", "group:plugins"] }
    }`;
    const r = ensureGroupPluginsAllowed(raw);
    expect(r.changed).toBe(false);
  });

  it("does nothing when tools.allow contains the wildcard '*'", () => {
    const raw = `{
      "tools": { "allow": ["*"] }
    }`;
    const r = ensureGroupPluginsAllowed(raw);
    expect(r.changed).toBe(false);
  });

  it("does nothing when tools.allow is missing or empty", () => {
    expect(ensureGroupPluginsAllowed(`{}`).changed).toBe(false);
    expect(ensureGroupPluginsAllowed(`{ "tools": {} }`).changed).toBe(false);
    expect(
      ensureGroupPluginsAllowed(`{ "tools": { "allow": [] } }`).changed,
    ).toBe(false);
  });

  it("returns changed=false (no throw) when the file is truly malformed", () => {
    const r = ensureGroupPluginsAllowed("{ not_json: , bad: }");
    expect(r.changed).toBe(false);
    expect(r.reason).toMatch(/parse failed/);
  });
});
