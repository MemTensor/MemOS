import { describe, expect, it } from "vitest";
import {
  escapeRegExp,
  findMatchingDelimiter,
  parseJsonWithComments,
  patchToolsAllow,
  stripJsonComments,
} from "../src/shared/json5-lite";

describe("parseJsonWithComments", () => {
  it("parses plain JSON unchanged (regression)", () => {
    expect(parseJsonWithComments(`{"a":1,"b":[2,3]}`)).toEqual({ a: 1, b: [2, 3] });
  });

  it("tolerates // line comments", () => {
    const src = `{
      // a leading comment
      "tools": {
        "allow": ["task-cli"] // trailing inline note
      }
    }`;
    expect(parseJsonWithComments(src)).toEqual({ tools: { allow: ["task-cli"] } });
  });

  it("tolerates /* block */ comments", () => {
    const src = `{
      /* multi-line
         block comment */
      "tools": { "allow": ["a"] }
    }`;
    expect(parseJsonWithComments(src)).toEqual({ tools: { allow: ["a"] } });
  });

  it("tolerates trailing commas in arrays and objects", () => {
    const src = `{
      "tools": {
        "allow": [
          "a",
          "b",
        ],
      },
    }`;
    expect(parseJsonWithComments(src)).toEqual({ tools: { allow: ["a", "b"] } });
  });

  it("does not touch comment-like sequences inside string literals", () => {
    const src = `{ "url": "https://example.com/a//b", "note": "/* not a comment */" }`;
    expect(parseJsonWithComments(src)).toEqual({
      url: "https://example.com/a//b",
      note: "/* not a comment */",
    });
  });

  it("respects escaped quotes inside strings", () => {
    const src = `{ "q": "he said \\"hi\\" // not a comment" }`;
    expect(parseJsonWithComments(src)).toEqual({ q: 'he said "hi" // not a comment' });
  });

  it("does not strip ',]' or ',}' that appear inside string values", () => {
    // Trailing-comma stripping must be string-literal aware.
    expect(parseJsonWithComments(`{"a": ",]"}`)).toEqual({ a: ",]" });
    expect(parseJsonWithComments(`{"a": ",}"}`)).toEqual({ a: ",}" });
    expect(parseJsonWithComments(`{"a": "literal , ] inside"}`)).toEqual({ a: "literal , ] inside" });
  });

  it("handles the openclaw.json shape from issue #1543", () => {
    // Mirrors the structure in the bug report: comments scattered through a
    // realistic config, including in/around tools.allow.
    const src = `{
      // top-level openclaw config
      "tools": {
        "allow": [
          "task-cli", // first tool
          "memos",
          /* a block-comment listed mid-array */
          "summarizer",
        ],
      },
      "agents": { "defaults": { "model": "primary" } }, // trailing object comma too
    }`;
    const parsed = parseJsonWithComments<{ tools: { allow: string[] } }>(src);
    expect(parsed.tools.allow).toEqual(["task-cli", "memos", "summarizer"]);
  });
});

describe("stripJsonComments", () => {
  it("preserves newlines so line numbers stay aligned in error messages", () => {
    const src = "{\n// foo\n\"a\":1\n}";
    const stripped = stripJsonComments(src);
    // The `// foo` line becomes empty but the newline is retained.
    expect(stripped.split("\n").length).toBe(src.split("\n").length);
  });

  it("preserves newline count when stripping multi-line block comments", () => {
    // A block comment spanning N newlines should leave N newlines behind so
    // JSON.parse error line numbers stay aligned with the original source.
    const src = "{\n/* line1\nline2\nline3 */\n\"a\":1\n}";
    const stripped = stripJsonComments(src);
    expect(stripped.split("\n").length).toBe(src.split("\n").length);
    // And the parse should still succeed.
    expect(JSON.parse(stripped)).toEqual({ a: 1 });
  });
});

describe("escapeRegExp", () => {
  it("escapes regex metacharacters", () => {
    const s = "a.b+c?d(e)f[g]h{i}j|k^l$m*n\\o";
    const re = new RegExp(`^${escapeRegExp(s)}$`);
    expect(re.test(s)).toBe(true);
    // And it shouldn't match a different string of the same length.
    expect(re.test("aXbYcZdWeVfUgThSiRjQkPlOmNnM\\o")).toBe(false);
  });
});

describe("findMatchingDelimiter", () => {
  it("matches a simple object", () => {
    const s = "x{a:1}y";
    expect(findMatchingDelimiter(s, 1, "{", "}")).toBe(5);
  });

  it("ignores delimiters inside string literals", () => {
    const s = `{"v": "}"}`;
    expect(findMatchingDelimiter(s, 0, "{", "}")).toBe(s.length - 1);
  });

  it("ignores delimiters inside line and block comments", () => {
    const s = "{ // }\n /* } */ \"k\":1 }";
    expect(findMatchingDelimiter(s, 0, "{", "}")).toBe(s.length - 1);
  });

  it("matches nested arrays", () => {
    const s = "[[1, [2, 3]], 4]";
    expect(findMatchingDelimiter(s, 0, "[", "]")).toBe(s.length - 1);
  });
});

describe("patchToolsAllow", () => {
  it("appends a new entry after the last one", () => {
    const raw = `{
  "tools": {
    "allow": [
      "task-cli",
      "memos"
    ]
  }
}`;
    const out = patchToolsAllow(raw, "memos", "group:plugins");
    const parsed = parseJsonWithComments<{ tools: { allow: string[] } }>(out);
    expect(parsed.tools.allow).toEqual(["task-cli", "memos", "group:plugins"]);
  });

  it("preserves comments and trailing commas in the surrounding file", () => {
    const raw = `{
  // top of file
  "tools": {
    "allow": [
      "task-cli", // first
      "memos",
    ],
  },
}`;
    const out = patchToolsAllow(raw, "memos", "group:plugins");
    expect(out).toContain("// top of file");
    expect(out).toContain("// first");
    const parsed = parseJsonWithComments<{ tools: { allow: string[] } }>(out);
    expect(parsed.tools.allow).toEqual(["task-cli", "memos", "group:plugins"]);
  });

  it("regression #1377: does not corrupt other arrays whose last element matches", () => {
    // An earlier array (`other.list`) ends with the same string ("memos") as
    // `tools.allow`. The previous global `raw.replace(...)` would rewrite the
    // FIRST match it found, corrupting `other.list` instead of `tools.allow`.
    const raw = `{
  "other": {
    "list": [
      "alpha",
      "memos"
    ]
  },
  "tools": {
    "allow": [
      "task-cli",
      "memos"
    ]
  }
}`;
    const out = patchToolsAllow(raw, "memos", "group:plugins");
    const parsed = parseJsonWithComments<{
      other: { list: string[] };
      tools: { allow: string[] };
    }>(out);
    // `other.list` must be untouched.
    expect(parsed.other.list).toEqual(["alpha", "memos"]);
    // And `tools.allow` got the new entry.
    expect(parsed.tools.allow).toEqual(["task-cli", "memos", "group:plugins"]);
  });

  it("escapes regex metacharacters in the last entry (e.g. tool names with dots/parens)", () => {
    const raw = `{
  "tools": {
    "allow": [
      "first.tool",
      "weird(name).tool+v2"
    ]
  }
}`;
    const out = patchToolsAllow(raw, "weird(name).tool+v2", "group:plugins");
    const parsed = parseJsonWithComments<{ tools: { allow: string[] } }>(out);
    expect(parsed.tools.allow).toEqual([
      "first.tool",
      "weird(name).tool+v2",
      "group:plugins",
    ]);
  });

  it("returns the input unchanged when tools.allow can't be located", () => {
    const raw = `{ "agents": { "defaults": {} } }`;
    expect(patchToolsAllow(raw, "anything", "group:plugins")).toBe(raw);
  });
});
