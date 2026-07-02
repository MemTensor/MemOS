import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

describe("auto-recall max results", () => {
  it("uses recall.maxResultsDefault instead of a hardcoded limit", () => {
    const source = fs.readFileSync(path.join(root, "index.ts"), "utf-8");
    const hookStart = source.indexOf('api.on("before_prompt_build"');
    const phaseStart = source.indexOf("// \u2500\u2500 Phase 1: Local search", hookStart);
    const phaseEnd = source.indexOf("const [result, arHubResult]", phaseStart);

    expect(hookStart).toBeGreaterThanOrEqual(0);
    expect(phaseStart).toBeGreaterThan(hookStart);
    expect(phaseEnd).toBeGreaterThan(phaseStart);

    const phase = source.slice(phaseStart, phaseEnd);
    expect(phase).toContain("ctx.config.recall?.maxResultsDefault");
    expect(phase).toContain("maxResults: autoRecallMaxResults");
    expect(phase).not.toMatch(/maxResults:\s*10\b/);
  });
});
