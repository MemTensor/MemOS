import { describe, it, expect, vi } from "vitest";
import memosLocalPlugin from "../index";

/**
 * Regression test for GitHub issue #1559.
 *
 * OpenClaw 2026.3.31 removed `api.registerMemoryCapability` and replaced it
 * with three focused methods. The plugin must:
 *   1. Prefer `api.registerMemoryPromptSection(builder)` when the host
 *      exposes it (new SDK).
 *   2. Fall back to `api.registerMemoryCapability({ promptBuilder })` when
 *      only the legacy method exists (older SDK).
 *   3. Fail loudly when neither method is exposed.
 */

function makeBaseApi(extra: Record<string, any>) {
  return {
    pluginConfig: {},
    config: {},
    resolvePath: (input: string) =>
      input === "~/.openclaw" ? "/tmp/memos-local-openclaw-1559" : input,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    registerTool: () => {},
    registerService: () => {},
    on: () => {},
    ...extra,
  } as any;
}

describe("OpenClaw 2026.3.31 memory-API migration (issue #1559)", () => {
  it("calls registerMemoryPromptSection when the new host SDK exposes it", () => {
    const registerMemoryPromptSection = vi.fn();
    const registerMemoryCapability = vi.fn();
    const api = makeBaseApi({
      registerMemoryPromptSection,
      registerMemoryCapability, // both present: new API must win
    });

    expect(() => memosLocalPlugin.register(api)).not.toThrow();

    expect(registerMemoryPromptSection).toHaveBeenCalledTimes(1);
    const builderArg = registerMemoryPromptSection.mock.calls[0][0];
    expect(typeof builderArg).toBe("function");
    // Builder must return a string[] (prompt section lines)
    const out = builderArg({
      availableTools: new Set(["memory_search", "memory_get"]),
    });
    expect(Array.isArray(out)).toBe(true);
    expect(out.some((line: string) => /memory/i.test(line))).toBe(true);

    // When the new API is wired, the legacy capability call MUST NOT also be
    // invoked — otherwise the host would receive a duplicate registration.
    expect(registerMemoryCapability).not.toHaveBeenCalled();
  });

  it("falls back to registerMemoryCapability on hosts without the new API", () => {
    const registerMemoryCapability = vi.fn();
    const api = makeBaseApi({
      registerMemoryCapability, // legacy-only host (pre-2026.3.31)
    });

    expect(() => memosLocalPlugin.register(api)).not.toThrow();

    expect(registerMemoryCapability).toHaveBeenCalledTimes(1);
    const capabilityArg = registerMemoryCapability.mock.calls[0][0];
    expect(capabilityArg).toBeDefined();
    expect(typeof capabilityArg.promptBuilder).toBe("function");
  });

  it("throws when neither memory-registration API is present", () => {
    const error = vi.fn();
    const warn = vi.fn();
    const api = makeBaseApi({
      logger: {
        debug: () => {},
        info: () => {},
        warn,
        error,
      },
    });

    expect(() => memosLocalPlugin.register(api)).toThrow(
      /registerMemoryPromptSection|registerMemoryCapability/,
    );
    expect(error).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
