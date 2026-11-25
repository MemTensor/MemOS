import { describe, expect, it, vi } from "vitest";
import { runDiagnosticFilter } from "../../../adapters/deepseek-harness/diagnostic-tool.js";
import { DeepSeekHarnessLlmRouteContext } from "../../../adapters/deepseek-harness/host-llm.js";

describe("diagnostic-only synthetic filter probe", () => {
  it("uses the owning agent route and independent timeout without reading memory", async () => {
    const routes = new DeepSeekHarnessLlmRouteContext();
    const onDiagnostic = vi.fn();
    const completeJson = vi.fn(async (_messages, options) => {
      expect(routes.current()).toMatchObject({ provider: "memtensor", model: "test-model" });
      expect(options.timeoutMs).toBeGreaterThan(3000);
      expect(options.malformedRetries).toBe(0);
      return { value: { ranked: [1] } };
    });
    const result = await runDiagnosticFilter({ candidateCount: 5, timeoutMs: 15000 }, {
      llm: { completeJson } as never, routes, onDiagnostic,
    }, {
      agent: { id: "s", session: { id: "s" }, options: { provider: "memtensor", model: "test-model" } },
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ candidateCount: 5, timeoutMs: 15000, outcome: "llm_filtered", kept: 1 });
    expect(completeJson).toHaveBeenCalledOnce();
    expect(onDiagnostic).toHaveBeenCalledWith("filter.result", expect.objectContaining({ probe: true, candidateCount: 5 }));
  });

  it("rejects unsupported sizes, excessive timeouts and missing routes before calling a model", async () => {
    const completeJson = vi.fn();
    const deps = { llm: { completeJson } as never, routes: new DeepSeekHarnessLlmRouteContext() };
    const exec = { agent: undefined, signal: new AbortController().signal };
    await expect(runDiagnosticFilter({ candidateCount: 100, timeoutMs: 15000 }, deps, exec)).rejects.toThrow();
    await expect(runDiagnosticFilter({ candidateCount: 1, timeoutMs: 60001 }, deps, exec)).rejects.toThrow();
    await expect(runDiagnosticFilter({ candidateCount: 1, timeoutMs: 15000 }, deps, exec)).rejects.toThrow(/route/);
    expect(completeJson).not.toHaveBeenCalled();
  });
});
