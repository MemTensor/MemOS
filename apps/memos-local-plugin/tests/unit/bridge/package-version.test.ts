import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("bridge package version loading", () => {
  it("does not require package.json after dynamic ESM imports", () => {
    const source = readFileSync(resolve("bridge.cts"), "utf8");

    expect(source).not.toMatch(/require\([^)]*package\.json[^)]*\)/);
    expect(source).toMatch(/readFileSync\([^)]*package\.json[^)]*\)/);
  });
});
