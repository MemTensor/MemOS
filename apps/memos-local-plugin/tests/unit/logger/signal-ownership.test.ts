import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("process signal ownership", () => {
  it("keeps SIGINT/SIGTERM out of the shared logger", () => {
    const source = readFileSync(resolve("core/logger/index.ts"), "utf8");

    expect(source).not.toMatch(/process\.once\("SIG(?:INT|TERM)"/);
    expect(source).not.toMatch(/process\.exit\(13[0-9]\)|process\.exit\(14[0-9]\)/);
    expect(source).toMatch(/process\.once\("beforeExit"/);
  });

  it("leaves graceful signal handling with both executable bridge entries", () => {
    for (const entry of ["bridge.cts", "bridge.mts"]) {
      const source = readFileSync(resolve(entry), "utf8");
      expect(source).toMatch(/process\.on\("SIGINT"/);
      expect(source).toMatch(/process\.on\("SIGTERM"/);
      expect(source).toContain("const SHUTDOWN_TIMEOUT_MS = 20_000");
      expect(source).toContain("function withShutdownTimeout(p: Promise<void>): Promise<void>");
      expect(source).not.toMatch(/(?<!withShutdownTimeout\()await core\.shutdown\(\)/);
      expect(source).not.toMatch(/(?<!withShutdownTimeout\()void core\.shutdown\(\)/);
    }
  });
});
