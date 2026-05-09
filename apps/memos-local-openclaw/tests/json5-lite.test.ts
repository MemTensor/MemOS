import { describe, expect, it } from "vitest";
import { parseJsonWithComments, stripJsonComments } from "../src/shared/json5-lite";

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
});
