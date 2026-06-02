import { describe, expect, it } from "vitest";

import {
  formatModelStatusLine,
  modelStatusFromInfo,
} from "../../../viewer/src/views/overview/model-status";

describe("overview model status", () => {
  it("renders a healthy model as Connected, not the status object", () => {
    const status = modelStatusFromInfo({
      available: true,
      provider: "openai_compatible",
      model: "gpt-4o-mini",
      lastOkAt: 1_700_000_000_000,
    });

    expect(status.label).toBe("Connected");
    expect(formatModelStatusLine(status.label)).toBe("Connected");
  });

  it("never falls back to browser object stringification in the status line", () => {
    const status = modelStatusFromInfo({
      available: true,
      provider: { name: "openai_compatible" },
      model: "gpt-4o-mini",
      lastFallbackAt: 1_700_000_000_000,
      lastError: {
        at: 1_700_000_000_000,
        message: { code: "bad_model", reason: "missing" },
      },
    });
    const line = formatModelStatusLine(status.label, { inherited: true }, { name: "x" });

    expect(status.label).not.toContain("[object Object]");
    expect(line).not.toContain("[object Object]");
    expect(line).toContain("bad_model");
  });
});
