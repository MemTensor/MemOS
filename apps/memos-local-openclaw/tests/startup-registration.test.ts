import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("startup registration", () => {
  it("does not run npm rebuild during plugin registration", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../index.ts"), "utf-8");
    const registrationPrelude = source.slice(0, source.indexOf("const ctx = buildContext"));

    expect(registrationPrelude).not.toContain("spawnSync");
    expect(registrationPrelude).not.toContain("npm rebuild better-sqlite3");
    expect(registrationPrelude).not.toContain("rebuild\", \"better-sqlite3");
  });
});
