import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("bridge PID file path", () => {
  for (const entry of ["bridge.cts", "bridge.mts"]) {
    it(`${entry} resolves the PID directory from the OS home`, () => {
      const source = readFileSync(resolve(entry), "utf8");
      const start = source.indexOf("function pidFilePath");
      const end = source.indexOf("function readPidFile", start);

      expect(start, `${entry}: pidFilePath() not found`).toBeGreaterThanOrEqual(0);
      expect(end, `${entry}: readPidFile() not found`).toBeGreaterThan(start);

      const pidFilePathSource = source.slice(start, end);
      expect(pidFilePathSource).toMatch(/\bhomedir\(\)/);
      expect(pidFilePathSource).not.toMatch(/process\.env\.HOME|["']\/tmp["']/);
    });
  }
});
