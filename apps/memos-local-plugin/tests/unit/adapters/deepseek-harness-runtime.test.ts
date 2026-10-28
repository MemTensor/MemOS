import { join } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import { describe, expect, it, vi } from "vitest";

import {
  configureDeepSeekHarnessHostLlm,
  deepSeekHarnessAutoRecoveryEnabled,
  deepSeekHarnessMemoryGuidance,
  defaultDeepSeekHarnessHome,
  inject,
  registerDeepSeekHarnessHostLlmCapabilityInvalidation,
} from "../../../adapters/deepseek-harness/index.js";
import type {
  DeepSeekHarnessHostLlmBridge,
} from "../../../adapters/deepseek-harness/host-llm.js";
import { DEFAULT_CONFIG } from "../../../core/config/index.js";

describe("DeepSeek Harness adapter runtime defaults", () => {
  it("injects the DSH LLM service and uses it for an otherwise unconfigured MemOS LLM", () => {
    expect(inject).toContain("llm");

    const configured = configureDeepSeekHarnessHostLlm(DEFAULT_CONFIG, true);
    expect(configured.llm.provider).toBe("host");
    expect(configured.llm.model).toBe("");
    expect(DEFAULT_CONFIG.llm.provider).toBe("");
  });

  it("preserves an explicitly configured MemOS LLM provider", () => {
    const direct = {
      ...DEFAULT_CONFIG,
      llm: {
        ...DEFAULT_CONFIG.llm,
        provider: "anthropic" as const,
        model: "claude-direct",
      },
    };

    expect(configureDeepSeekHarnessHostLlm(direct, true)).toBe(direct);
    expect(configureDeepSeekHarnessHostLlm(DEFAULT_CONFIG, false)).toBe(DEFAULT_CONFIG);
  });

  it("disables autonomous full-memory recovery when only a turn-scoped host route exists", () => {
    const host = configureDeepSeekHarnessHostLlm(DEFAULT_CONFIG, true);
    expect(deepSeekHarnessAutoRecoveryEnabled(host)).toBe(true);
    expect(deepSeekHarnessAutoRecoveryEnabled({
      ...host,
      algorithm: {
        ...host.algorithm,
        lightweightMemory: {
          ...host.algorithm.lightweightMemory,
          enabled: false,
        },
      },
    })).toBe(false);

    const direct = {
      ...host,
      llm: { ...host.llm, provider: "anthropic" as const },
      algorithm: {
        ...host.algorithm,
        lightweightMemory: {
          ...host.algorithm.lightweightMemory,
          enabled: false,
        },
      },
    };
    expect(deepSeekHarnessAutoRecoveryEnabled(direct)).toBe(true);
  });

  it("places memory under DSH_HOME when the adapter home is not explicit", () => {
    expect(defaultDeepSeekHarnessHome("", {
      DSH_HOME: "/tmp/isolated-dsh",
    }, "/users/example")).toBe(join("/tmp/isolated-dsh", "memos-plugin"));
    expect(defaultDeepSeekHarnessHome(
      "/data/explicit-memos",
      { DSH_HOME: "/tmp/ignored" },
      "/users/example",
    )).toBe("/data/explicit-memos");
  });

  it("does not advertise a disabled tool and marks recalled text as untrusted", () => {
    const withoutTools = deepSeekHarnessMemoryGuidance(false);
    expect(withoutTools).not.toContain("memos_search");
    expect(withoutTools).toContain("untrusted historical data");
    expect(deepSeekHarnessMemoryGuidance(true)).toContain("memos_search");
  });

  it("invalidates host LLM capabilities when DSH adapters are updated", () => {
    let listener: (() => void) | undefined;
    const unregister = vi.fn();
    const ctx = {
      on(event: string, callback: () => void): () => void {
        expect(event).toBe("llm/adapters-updated");
        listener = callback;
        return unregister;
      },
    } as unknown as Context;
    const invalidateModelCapabilities = vi.fn();
    const bridge = {
      invalidateModelCapabilities,
    } as unknown as DeepSeekHarnessHostLlmBridge;

    const registered = registerDeepSeekHarnessHostLlmCapabilityInvalidation(
      ctx,
      bridge,
    );
    listener?.();

    expect(registered).toBe(unregister);
    expect(invalidateModelCapabilities).toHaveBeenCalledOnce();
  });
});
