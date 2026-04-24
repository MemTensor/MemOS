import { describe, expect, it } from "vitest";

import { MemosError } from "../../../agent-contract/errors.js";
import { buildJsonSystemHint, parseLlmJson } from "../../../core/llm/json-mode.js";

describe("llm/json-mode", () => {
  it("parses plain JSON", () => {
    expect(parseLlmJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseLlmJson("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("strips ```json … ``` fences", () => {
    const raw = ["```json", '{"alpha":0.7,"usable":true}', "```"].join("\n");
    expect(parseLlmJson<{ alpha: number }>(raw).alpha).toBeCloseTo(0.7);
  });

  it("strips plain ``` fences", () => {
    const raw = "```\n[1,2]\n```";
    expect(parseLlmJson(raw)).toEqual([1, 2]);
  });

  it("extracts the first balanced object from surrounding prose", () => {
    const raw = 'Sure! Here you go: {"ok":true, "reason":"fine"}. Thanks!';
    const v = parseLlmJson<{ ok: boolean; reason: string }>(raw);
    expect(v.ok).toBe(true);
    expect(v.reason).toBe("fine");
  });

  it("extracts the first balanced array", () => {
    const raw = "[1, 2, {\"x\": [3, 4]}]";
    expect(parseLlmJson(raw)).toEqual([1, 2, { x: [3, 4] }]);
  });

  it("handles nested braces inside strings", () => {
    const raw = '{"msg":"use {a} like {b}","n":2}';
    expect(parseLlmJson<{ msg: string }>(raw).msg).toBe("use {a} like {b}");
  });

  it("removes trailing commas as last resort", () => {
    const raw = '{"a":1,"b":2,}';
    expect(parseLlmJson(raw)).toEqual({ a: 1, b: 2 });
  });

  it("handles trailing commas inside arrays", () => {
    const raw = '[1, 2, 3, ]';
    expect(parseLlmJson(raw)).toEqual([1, 2, 3]);
  });

  it("throws LLM_OUTPUT_MALFORMED on empty input", () => {
    try {
      parseLlmJson("   ");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MemosError);
      expect((err as MemosError).code).toBe("llm_output_malformed");
    }
  });

  it("throws LLM_OUTPUT_MALFORMED on unrecoverable text", () => {
    try {
      parseLlmJson("no json here, just words");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MemosError);
      expect((err as MemosError).details).toMatchObject({ rawPreview: expect.any(String) });
    }
  });

  it("buildJsonSystemHint(no-schema) includes baseline instruction", () => {
    const h = buildJsonSystemHint();
    expect(h).toMatch(/single valid JSON value/i);
    expect(h).not.toMatch(/Expected shape/);
  });

  it("buildJsonSystemHint(schema) adds shape description", () => {
    const h = buildJsonSystemHint('{"a":number}');
    expect(h).toMatch(/Expected shape/);
    expect(h).toMatch(/"a"/);
  });
});
