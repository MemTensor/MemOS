import { describe, expect, it } from "vitest";

import { LOG_LEVEL_ORDER, levelGte, parseLevel, resolveLevelForChannel } from "../../../core/logger/levels.js";

describe("logger/levels", () => {
  it("level ordering is monotonic", () => {
    expect(LOG_LEVEL_ORDER.trace).toBeLessThan(LOG_LEVEL_ORDER.debug);
    expect(LOG_LEVEL_ORDER.debug).toBeLessThan(LOG_LEVEL_ORDER.info);
    expect(LOG_LEVEL_ORDER.info).toBeLessThan(LOG_LEVEL_ORDER.warn);
    expect(LOG_LEVEL_ORDER.warn).toBeLessThan(LOG_LEVEL_ORDER.error);
    expect(LOG_LEVEL_ORDER.error).toBeLessThan(LOG_LEVEL_ORDER.fatal);
  });

  it("levelGte respects the ordering", () => {
    expect(levelGte("error", "warn")).toBe(true);
    expect(levelGte("warn", "error")).toBe(false);
    expect(levelGte("info", "info")).toBe(true);
  });

  it("parseLevel falls back when given garbage", () => {
    expect(parseLevel("info")).toBe("info");
    expect(parseLevel("nope")).toBe("info");
    expect(parseLevel("nope", "warn")).toBe("warn");
  });

  it("resolveLevelForChannel applies longest prefix match", () => {
    const overrides = {
      "core.l2": "debug",
      "core.l2.cross-task": "trace",
      "llm.openai": "warn",
    };
    expect(resolveLevelForChannel("core.l2.incremental", "info", overrides)).toBe("debug");
    expect(resolveLevelForChannel("core.l2.cross-task", "info", overrides)).toBe("trace");
    expect(resolveLevelForChannel("core.l3", "info", overrides)).toBe("info");
    expect(resolveLevelForChannel("llm.openai", "info", overrides)).toBe("warn");
  });

  it("resolveLevelForChannel returns global when no overrides match", () => {
    expect(resolveLevelForChannel("core.session", "warn", {})).toBe("warn");
  });
});
