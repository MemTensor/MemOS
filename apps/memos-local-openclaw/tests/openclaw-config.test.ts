import { describe, expect, it } from "vitest";
import { ensureToolsAllowEntry } from "../src/openclaw-config";

describe("ensureToolsAllowEntry", () => {
  it("adds the entry to tools.allow when missing", () => {
    const raw = JSON.stringify(
      {
        tools: {
          allow: ["file_search", "shell"],
        },
      },
      null,
      2,
    );

    const patched = ensureToolsAllowEntry(raw, "group:plugins");
    expect(patched).not.toBe(raw);

    const parsed = JSON.parse(patched);
    expect(parsed.tools.allow).toEqual(["file_search", "shell", "group:plugins"]);
  });

  it("does NOT modify any other array that happens to contain the same string as the last tools.allow entry", () => {
    // Regression: issue #1377. The previous implementation used `raw.replace(new RegExp(`(${lastEntry})(\\s*\\])`))`
    // which is non-global and matches the FIRST occurrence in the file. When models.providers.*.models[*].input
    // appeared BEFORE tools.allow and ended with the same JSON value as the last tools.allow entry, it patched the
    // wrong array, corrupting openclaw.json:
    //   "input": ["text", "image"]      → "input": ["text", "image", "group:plugins"]   ← BUG
    //   "allow": ["file_search", "image"] (was meant to be patched here)
    const raw = JSON.stringify(
      {
        models: {
          providers: {
            qwen: {
              models: [
                {
                  id: "qwen3.5-plus-search",
                  name: "qwen3.5-plus-search",
                  input: ["text", "image"],
                },
              ],
            },
          },
        },
        tools: {
          allow: ["file_search", "image"],
        },
      },
      null,
      2,
    );

    const patched = ensureToolsAllowEntry(raw, "group:plugins");
    const parsed = JSON.parse(patched);

    expect(parsed.models.providers.qwen.models[0].input).toEqual(["text", "image"]);
    expect(parsed.tools.allow).toEqual(["file_search", "image", "group:plugins"]);
  });

  it("is a no-op when the entry is already present", () => {
    const raw = JSON.stringify(
      {
        tools: { allow: ["file_search", "group:plugins"] },
      },
      null,
      2,
    );
    expect(ensureToolsAllowEntry(raw, "group:plugins")).toBe(raw);
  });

  it("is a no-op when tools.allow contains a wildcard", () => {
    const raw = JSON.stringify({ tools: { allow: ["*"] } }, null, 2);
    expect(ensureToolsAllowEntry(raw, "group:plugins")).toBe(raw);
  });

  it("is a no-op when tools.allow is missing or empty", () => {
    expect(ensureToolsAllowEntry(JSON.stringify({}), "group:plugins")).toBe(JSON.stringify({}));
    const emptyAllow = JSON.stringify({ tools: { allow: [] } }, null, 2);
    expect(ensureToolsAllowEntry(emptyAllow, "group:plugins")).toBe(emptyAllow);
  });

  it("preserves indentation style when rewriting", () => {
    const raw =
      "{\n" +
      "  \"tools\": {\n" +
      "    \"allow\": [\n" +
      "      \"file_search\",\n" +
      "      \"shell\"\n" +
      "    ]\n" +
      "  },\n" +
      "  \"models\": { \"providers\": {} }\n" +
      "}\n";

    const patched = ensureToolsAllowEntry(raw, "group:plugins");
    const parsed = JSON.parse(patched);
    expect(parsed.tools.allow).toEqual(["file_search", "shell", "group:plugins"]);
    // Detected 2-space indent should be preserved
    expect(patched.split("\n").some((line) => line.startsWith("    \"allow\""))).toBe(true);
    // Original trailing newline is kept
    expect(patched.endsWith("\n")).toBe(true);
  });

  it("handles regex-special characters in the last tools.allow entry", () => {
    // Previous regex approach used JSON.stringify(value) inline and did not escape regex metacharacters.
    const raw = JSON.stringify({ tools: { allow: ["a", "weird.name+x"] } }, null, 2);
    const patched = ensureToolsAllowEntry(raw, "group:plugins");
    const parsed = JSON.parse(patched);
    expect(parsed.tools.allow).toEqual(["a", "weird.name+x", "group:plugins"]);
  });

  it("returns the input unchanged when JSON cannot be parsed", () => {
    const raw = "not really json";
    expect(ensureToolsAllowEntry(raw, "group:plugins")).toBe(raw);
  });
});
