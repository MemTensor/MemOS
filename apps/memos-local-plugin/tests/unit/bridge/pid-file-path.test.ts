import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("bridge PID file path", () => {
  for (const entry of ["bridge.cts", "bridge.mts"]) {
    it(`${entry} preserves configured homes and falls back to the OS home`, () => {
      const source = readFileSync(resolve(entry), "utf8");
      const start = source.indexOf("function pidFilePath");
      const end = source.indexOf("function readPidFile", start);

      expect(start, `${entry}: pidFilePath() not found`).toBeGreaterThanOrEqual(0);
      expect(end, `${entry}: readPidFile() not found`).toBeGreaterThan(start);

      const pidFilePathSource = source.slice(start, end);
      const configuredHomeGuard = pidFilePathSource.indexOf("if (configuredHome)");
      const osHomeFallback = pidFilePathSource.indexOf("homedir()");

      expect(configuredHomeGuard, `${entry}: configured home guard missing`).toBeGreaterThanOrEqual(
        0,
      );
      expect(osHomeFallback, `${entry}: OS home fallback missing`).toBeGreaterThan(
        configuredHomeGuard,
      );
      expect(pidFilePathSource).not.toMatch(/process\.env\.HOME|["']\/tmp["']/);
    });
  }
});
