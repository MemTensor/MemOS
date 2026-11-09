/**
 * Regression tests for issue #2474.
 *
 * The `pruneUnknown` validator used to key its "known fields" set on
 * `DEFAULT_CONFIG`, so any TypeBox `Type.Optional(...)` field without a
 * default (e.g. `llm.reasoning` → `ReasoningSchema`) was reported as an
 * unknown key on every boot:
 *
 *   config.warning message="unknown config key 'llm.reasoning' (kept as-is …)"
 *   config.warning message="unknown config key 'skillEvolver.reasoning' (…)"
 *   config.warning message="unknown config key 'l3Llm.reasoning' (…)"
 *
 * Fix: derive the known-key set from the TypeBox schema (`ConfigSchema`),
 * not from the defaults tree. This covers every current and future
 * optional field in one place.
 *
 * Precedent: #2248 added `llm.maxTokens` / `llm.headers` to `DEFAULT_CONFIG`
 * to cure the same class of warning. The schema-driven rewrite subsumes
 * that approach.
 */

import { describe, expect, it } from "vitest";

import { resolveConfig } from "../../../core/config/index.js";

const UNKNOWN_WARN_RE = /unknown config key/;

describe("resolveConfig schema-driven unknown-key detection (issue #2474)", () => {
  it("does not warn for llm.reasoning (an optional field declared in the schema)", () => {
    const warnings: string[] = [];
    const cfg = resolveConfig({ llm: { reasoning: { enabled: false } } }, warnings);
    expect(warnings.filter((w) => UNKNOWN_WARN_RE.test(w))).toEqual([]);
    expect(cfg.llm.reasoning).toEqual({ enabled: false });
  });

  it("does not warn for skillEvolver.reasoning", () => {
    const warnings: string[] = [];
    const cfg = resolveConfig(
      { skillEvolver: { reasoning: { effort: "medium" } } },
      warnings,
    );
    expect(warnings.filter((w) => UNKNOWN_WARN_RE.test(w))).toEqual([]);
    expect(cfg.skillEvolver.reasoning).toEqual({ effort: "medium" });
  });

  it("does not warn for l3Llm.reasoning", () => {
    const warnings: string[] = [];
    const cfg = resolveConfig(
      { l3Llm: { reasoning: { maxTokens: 2048 } } },
      warnings,
    );
    expect(warnings.filter((w) => UNKNOWN_WARN_RE.test(w))).toEqual([]);
    expect(cfg.l3Llm.reasoning).toEqual({ maxTokens: 2048 });
  });

  it("still warns on real typos inside a known schema branch", () => {
    const warnings: string[] = [];
    resolveConfig({ llm: { reasonning: {} } }, warnings);
    expect(warnings).toContain(
      "unknown config key 'llm.reasonning' (kept as-is for forward compatibility)",
    );
  });

  it("still warns on top-level unknown branches", () => {
    const warnings: string[] = [];
    resolveConfig({ entityExtractor: { reasoning: { enabled: true } } }, warnings);
    expect(
      warnings.some((w) =>
        /unknown config key 'entityExtractor'/.test(w),
      ),
    ).toBe(true);
  });

  it("keeps nested free-form map child keys without warning (llm.headers via schema Record)", () => {
    const warnings: string[] = [];
    const cfg = resolveConfig(
      { llm: { headers: { "X-A": "1", "X-B": "2" } } },
      warnings,
    );
    expect(warnings.filter((w) => UNKNOWN_WARN_RE.test(w))).toEqual([]);
    expect(cfg.llm.headers).toEqual({ "X-A": "1", "X-B": "2" });
  });

  it("keeps logging.channels user-defined child keys without warning (Record)", () => {
    const warnings: string[] = [];
    const cfg = resolveConfig(
      { logging: { channels: { "core.l2.cross-task": "debug" } } },
      warnings,
    );
    expect(warnings.filter((w) => UNKNOWN_WARN_RE.test(w))).toEqual([]);
    expect(cfg.logging.channels).toEqual({ "core.l2.cross-task": "debug" });
  });

  it("resolved config retains the reasoning block exactly as specified", () => {
    const cfg = resolveConfig({
      llm: {
        reasoning: { enabled: true, effort: "high", maxTokens: 4096 },
      },
      skillEvolver: {
        reasoning: { enabled: false },
      },
      l3Llm: {
        reasoning: { effort: "low" },
      },
    });
    expect(cfg.llm.reasoning).toEqual({ enabled: true, effort: "high", maxTokens: 4096 });
    expect(cfg.skillEvolver.reasoning).toEqual({ enabled: false });
    expect(cfg.l3Llm.reasoning).toEqual({ effort: "low" });
  });

  it("still warns on unknown nested keys inside the reasoning block itself", () => {
    const warnings: string[] = [];
    resolveConfig(
      { llm: { reasoning: { unknownKnob: 1 } } },
      warnings,
    );
    expect(warnings).toContain(
      "unknown config key 'llm.reasoning.unknownKnob' (kept as-is for forward compatibility)",
    );
  });
});
