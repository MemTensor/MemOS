import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../../..");

describe("OpenClaw native dependency install", () => {
  it("installs production dependencies and explicitly rebuilds better-sqlite3", () => {
    const source = readFileSync(
      path.join(repoRoot, "adapters/openclaw/install.openclaw.sh"),
      "utf8",
    );

    expect(source).toContain("npm install --omit=dev");
    expect(source).toContain("npm rebuild better-sqlite3");
  });
});
