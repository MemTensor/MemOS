import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../../..");

describe("production dependency staging", () => {
  it("ignores development-only peer conflicts in the Unix installer", () => {
    const source = readFileSync(path.join(repoRoot, "install.sh"), "utf8");
    const installCommand = source
      .split("\n")
      .find((line) => line.includes("npm install --omit=dev"));

    expect(installCommand).toBeDefined();
    expect(installCommand).toContain("--legacy-peer-deps");
  });

  it("ignores development-only peer conflicts in the Windows installer", () => {
    const source = readFileSync(path.join(repoRoot, "install.ps1"), "utf8");
    const installArguments = source
      .split("\n")
      .find((line) => line.includes('"install", "--omit=dev"'));

    expect(installArguments).toBeDefined();
    expect(installArguments).toContain('"--legacy-peer-deps"');
  });
});
