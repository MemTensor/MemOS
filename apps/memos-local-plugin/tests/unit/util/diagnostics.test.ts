import { describe, expect, it, vi } from "vitest";
import { retrievalFilterTimeoutMs } from "../../../core/util/diagnostics.js";
describe("retrieval filter diagnostic budget", () => {
  it("retains the default cap, accepts an explicit cap and never exceeds the remaining deadline", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      expect(retrievalFilterTimeoutMs(5000)).toBe(2000);
      expect(retrievalFilterTimeoutMs(5000, 2800)).toBe(2800);
      expect(retrievalFilterTimeoutMs(2500, 2800)).toBe(1500);
      expect(retrievalFilterTimeoutMs(undefined, 60000)).toBeUndefined();
    } finally { vi.restoreAllMocks(); }
  });
});
