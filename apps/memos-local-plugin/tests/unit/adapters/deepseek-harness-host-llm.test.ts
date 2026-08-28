import { Context } from "@deepseek-ai/cordis";
import LlmRuntime, {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  resolveRetryPolicy,
  type GenerateOptions,
  type LlmCallConfig,
  type LlmResolvedModelInfo,
  type PreparedLlmCall,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { describe, expect, it, vi } from "vitest";

import {
  createDeepSeekHarnessHostLlmBridge,
  DeepSeekHarnessLlmRouteContext,
  type DeepSeekHarnessLlmLike,
  type DeepSeekHarnessLlmRoute,
} from "../../../adapters/deepseek-harness/host-llm.js";

const ROUTE: DeepSeekHarnessLlmRoute = {
  provider: "deepseek",
  model: "deepseek-chat",
  reasoningEffort: "high",
  sessionId: "session-a",
};

function streamFrom(
  chunks: readonly StreamChunk[],
  observe?: (options: GenerateOptions) => void,
  reasoningEfforts: readonly string[] = ["off", "high"],
  observePreparation?: (
    config: LlmCallConfig,
    signal?: AbortSignal,
  ) => void,
  observeResolution?: (provider: string, model: string) => void,
): DeepSeekHarnessLlmLike {
  return {
    async resolveModelInfo(provider, model) {
      observeResolution?.(provider, model);
      return {
        provider,
        id: model,
        name: model,
        ...(reasoningEfforts.length === 0
          ? {}
          : {
              reasoning: {
                efforts: reasoningEfforts.map((effort) => ({
                  id: ReasoningEffortId(effort),
                  name: effort,
                })),
              },
            }),
      };
    },
    async prepareCall(config, signal) {
      observePreparation?.(config, signal);
      if (
        config.reasoningEffort !== undefined
        && !reasoningEfforts.includes(config.reasoningEffort)
      ) {
        throw new LlmError(
          `unsupported reasoning effort ${config.reasoningEffort}`,
          "UNSUPPORTED_REASONING_EFFORT",
        );
      }
      return preparedCall(config, (options) => {
        observe?.(options);
        return (async function* (): AsyncGenerator<StreamChunk> {
          for (const chunk of chunks) yield chunk;
        })();
      });
    },
  };
}

function preparedCall(
  config: LlmCallConfig,
  stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>,
): PreparedLlmCall {
  return {
    config: Object.freeze({ ...config }),
    retryPolicy: resolveRetryPolicy(undefined, "test retry policy"),
    adapterDefaults: Object.freeze({}),
    stream,
  };
}

function completionChunks(text = "remembered answer"): StreamChunk[] {
  return [
    { type: "block-start", index: 0, blockType: "reasoning" },
    { type: "reasoning-delta", index: 0, text: "private chain of thought" },
    { type: "block-end", index: 0, block: { type: "reasoning", text: "private chain of thought" } },
    { type: "block-start", index: 1, blockType: "text" },
    { type: "text-delta", index: 1, text },
    { type: "block-end", index: 1, block: { type: "text", text } },
    {
      type: "usage",
      usage: {
        inputTokens: 10,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        outputTokens: 5,
        reasoningTokens: 7,
      },
    },
    { type: "finish", reason: { kind: "stop" } },
  ];
}

class RegistrationRecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];

  constructor(private readonly text: string) {
    super();
  }

  override resolveModel(
    provider: string,
    model: string,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [{ id: ReasoningEffortId("off"), name: "Off" }],
      },
    });
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    yield { type: "text-delta", index: 0, text: this.text };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

describe("DeepSeek Harness host LLM bridge", () => {
  it("maps MemOS messages and uses a declared no-reasoning effort", async () => {
    let request: GenerateOptions | undefined;
    let prepared: { config: LlmCallConfig; signal?: AbortSignal } | undefined;
    const llm = streamFrom(completionChunks(), (options) => {
      request = options;
    }, ["off", "high"], (config, signal) => {
      prepared = { config, signal };
    });
    const routes = new DeepSeekHarnessLlmRouteContext();
    const bridge = createDeepSeekHarnessHostLlmBridge({ llm, routes });

    const result = await routes.run(ROUTE, () => bridge.complete({
      messages: [
        { role: "system", content: "System rule one." },
        { role: "user", content: "Question" },
        { role: "assistant", content: "Earlier answer" },
        { role: "system", content: "System rule two." },
      ],
      // The route is an atomic provider/model pair; a MemOS-side model hint
      // must not detach the model from the active DSH provider.
      model: "ignored-memos-model",
      temperature: 0.25,
      maxTokens: 321,
      timeoutMs: 2_000,
    }));

    expect(request).toMatchObject({
      provider: "deepseek",
      model: "deepseek-chat",
      reasoningEffort: "off",
      system: "System rule one.\n\nSystem rule two.",
      temperature: 0.25,
      maxTokens: 321,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Question" }],
          source: { kind: "plugin", plugin: "memos-local-memory" },
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Earlier answer" }],
          source: { kind: "model", provider: "deepseek", model: "deepseek-chat" },
        },
      ],
    });
    expect(request).not.toHaveProperty("sessionId");
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(prepared?.config).toEqual({
      provider: "deepseek",
      model: "deepseek-chat",
      reasoningEffort: ReasoningEffortId("off"),
      temperature: 0.25,
      maxTokens: 321,
    });
    expect(prepared?.signal).toBe(request?.signal);
    expect(result).toEqual({
      text: "remembered answer",
      model: "deepseek-chat",
      usage: {
        promptTokens: 15,
        completionTokens: 5,
        totalTokens: 20,
      },
      durationMs: expect.any(Number),
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("does not invent an off effort when the exact model does not advertise it", async () => {
    let request: GenerateOptions | undefined;
    const preparations: LlmCallConfig[] = [];
    let resolutions = 0;
    const routes = new DeepSeekHarnessLlmRouteContext();
    const bridge = createDeepSeekHarnessHostLlmBridge({
      llm: streamFrom([
        { type: "text-delta", index: 0, text: "ok" },
        { type: "finish", reason: { kind: "stop" } },
      ], (options) => {
        request = options;
      }, [], (config) => {
        preparations.push(config);
      }, () => {
        resolutions++;
      }),
      routes,
    });

    const complete = () => routes.run(
      { provider: "openai", model: "gpt-test", reasoningEffort: "high" },
      () => bridge.complete({ messages: [{ role: "user", content: "hello" }] }),
    );
    const result = await complete();
    await complete();

    expect(request).not.toHaveProperty("system");
    expect(request).not.toHaveProperty("reasoningEffort");
    expect(request).not.toHaveProperty("sessionId");
    expect(request).not.toHaveProperty("temperature");
    expect(request).not.toHaveProperty("maxTokens");
    expect(preparations).toEqual([
      { provider: "openai", model: "gpt-test" },
      { provider: "openai", model: "gpt-test" },
    ]);
    expect(resolutions).toBe(1);
    expect(result).not.toHaveProperty("usage");
    expect(result.text).toBe("ok");
  });

  it("invalidates resolved effort capabilities when the DSH adapter changes", async () => {
    let supportsOff = false;
    let resolutions = 0;
    const preparations: string[] = [];
    const routes = new DeepSeekHarnessLlmRouteContext();
    const bridge = createDeepSeekHarnessHostLlmBridge({
      llm: {
        async resolveModelInfo(provider, model) {
          resolutions++;
          return {
            provider,
            id: model,
            name: model,
            ...(supportsOff
              ? {
                  reasoning: {
                    efforts: [{ id: ReasoningEffortId("off"), name: "Off" }],
                  },
                }
              : {}),
          };
        },
        async prepareCall(config) {
          preparations.push(config.reasoningEffort ?? "plain");
          if (config.reasoningEffort !== undefined && !supportsOff) {
            throw new LlmError("unsupported", "UNSUPPORTED_REASONING_EFFORT");
          }
          return preparedCall(config, () => (async function* () {
            yield { type: "text-delta", index: 0, text: "ok" } as StreamChunk;
            yield { type: "finish", reason: { kind: "stop" } } as StreamChunk;
          })());
        },
      },
      routes,
    });
    const complete = () => routes.run(
      { provider: "openai", model: "gpt-test" },
      () => bridge.complete({ messages: [{ role: "user", content: "hello" }] }),
    );

    await complete();
    supportsOff = true;
    await complete();
    bridge.invalidateModelCapabilities();
    await complete();

    expect(preparations).toEqual(["plain", "plain", "off"]);
    expect(resolutions).toBe(2);
  });

  it("coalesces concurrent capability lookups for one route", async () => {
    let resolutions = 0;
    const routes = new DeepSeekHarnessLlmRouteContext();
    const llm = streamFrom([
      { type: "text-delta", index: 0, text: "ok" },
      { type: "finish", reason: { kind: "stop" } },
    ], undefined, [], undefined, () => {
      resolutions++;
    });
    const bridge = createDeepSeekHarnessHostLlmBridge({ llm, routes });
    const complete = () => routes.run(
      { provider: "openai", model: "gpt-test" },
      () => bridge.complete({ messages: [{ role: "user", content: "hello" }] }),
    );

    await Promise.all([complete(), complete()]);

    expect(resolutions).toBe(1);
  });

  it("expires cached capabilities so silent model updates are eventually observed", async () => {
    let now = 1_000;
    let supportsOff = false;
    let resolutions = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const routes = new DeepSeekHarnessLlmRouteContext();
    const preparations: string[] = [];
    const bridge = createDeepSeekHarnessHostLlmBridge({
      llm: {
        async resolveModelInfo(provider, model) {
          resolutions++;
          return {
            provider,
            id: model,
            name: model,
            ...(supportsOff
              ? {
                  reasoning: {
                    efforts: [{ id: ReasoningEffortId("off"), name: "Off" }],
                  },
                }
              : {}),
          };
        },
        async prepareCall(config) {
          preparations.push(config.reasoningEffort ?? "plain");
          return preparedCall(config, () => (async function* () {
            yield { type: "text-delta", index: 0, text: "ok" } as StreamChunk;
            yield { type: "finish", reason: { kind: "stop" } } as StreamChunk;
          })());
        },
      },
      routes,
    });
    const complete = () => routes.run(
      { provider: "openai", model: "gpt-test" },
      () => bridge.complete({ messages: [{ role: "user", content: "hello" }] }),
    );

    try {
      await complete();
      supportsOff = true;
      now += 10 * 60 * 1_000 + 1;
      await complete();
    } finally {
      nowSpy.mockRestore();
    }

    expect(preparations).toEqual(["plain", "off"]);
    expect(resolutions).toBe(2);
  });

  it("falls back safely when HMR changes capabilities between lookup and preparation", async () => {
    const preparations: string[] = [];
    let firstOff = true;
    let resolutions = 0;
    const routes = new DeepSeekHarnessLlmRouteContext();
    const bridge = createDeepSeekHarnessHostLlmBridge({
      llm: {
        resolveModelInfo(provider, model) {
          resolutions++;
          return Promise.resolve({
            provider,
            id: model,
            name: model,
            reasoning: {
              efforts: [{ id: ReasoningEffortId("off"), name: "Off" }],
            },
          });
        },
        async prepareCall(config) {
          preparations.push(config.reasoningEffort ?? "plain");
          if (config.reasoningEffort !== undefined && firstOff) {
            firstOff = false;
            throw new LlmError("adapter changed", "UNSUPPORTED_REASONING_EFFORT");
          }
          return preparedCall(config, () => (async function* () {
            yield { type: "text-delta", index: 0, text: "ok" } as StreamChunk;
            yield { type: "finish", reason: { kind: "stop" } } as StreamChunk;
          })());
        },
      },
      routes,
    });
    const complete = () => routes.run(
      { provider: "openai", model: "gpt-test" },
      () => bridge.complete({ messages: [{ role: "user", content: "hello" }] }),
    );

    await complete();
    await complete();

    expect(preparations).toEqual(["off", "plain", "plain"]);
    expect(resolutions).toBe(1);
  });

  it("does not fall back for errors other than unsupported reasoning effort", async () => {
    const failure = new LlmError("invalid model metadata", "INVALID_MODEL_REASONING");
    const prepareCall = vi.fn<DeepSeekHarnessLlmLike["prepareCall"]>();
    prepareCall.mockRejectedValue(failure);
    const routes = new DeepSeekHarnessLlmRouteContext();
    const bridge = createDeepSeekHarnessHostLlmBridge({
      llm: {
        resolveModelInfo: (provider, model) => Promise.resolve({
          provider,
          id: model,
          name: model,
          reasoning: {
            efforts: [{ id: ReasoningEffortId("off"), name: "Off" }],
          },
        }),
        prepareCall,
      },
      routes,
    });

    await expect(routes.run(ROUTE, () => bridge.complete({
      messages: [{ role: "user", content: "hello" }],
    }))).rejects.toBe(failure);
    expect(prepareCall).toHaveBeenCalledTimes(1);
  });

  it("dispatches through the registration that validated the route across HMR", async () => {
    const ctx = new Context();
    await ctx.plugin(LlmRuntime);
    const oldAdapter = new RegistrationRecordingAdapter("old registration");
    const newAdapter = new RegistrationRecordingAdapter("new registration");
    const disposeOld = ctx.llm.registerAdapter(["deepseek"], oldAdapter);
    let disposeNew: (() => void) | undefined;
    const routes = new DeepSeekHarnessLlmRouteContext();
    const bridge = createDeepSeekHarnessHostLlmBridge({
      llm: {
        resolveModelInfo: (provider, model, signal) => (
          ctx.llm.resolveModelInfo(provider, model, signal)
        ),
        async prepareCall(config, signal) {
          const prepared = await ctx.llm.prepareCall(config, signal);
          // Simulate a provider plugin HMR swap in the exact TOCTOU window
          // between model-capability validation and auxiliary dispatch.
          disposeOld();
          disposeNew = ctx.llm.registerAdapter(["deepseek"], newAdapter);
          return prepared;
        },
      },
      routes,
    });

    try {
      await expect(routes.run(ROUTE, () => bridge.complete({
        messages: [{ role: "user", content: "hello" }],
        timeoutMs: 2_000,
      }))).resolves.toMatchObject({
        text: "old registration",
        model: "deepseek-chat",
      });
      expect(oldAdapter.requests).toHaveLength(1);
      expect(oldAdapter.requests[0]).toMatchObject({
        provider: "deepseek",
        model: "deepseek-chat",
        reasoningEffort: ReasoningEffortId("off"),
      });
      expect(oldAdapter.requests[0]).not.toHaveProperty("sessionId");
      expect(newAdapter.requests).toHaveLength(0);
    } finally {
      disposeNew?.();
    }
  });

  it("keeps concurrent async route scopes isolated", async () => {
    const routes = new DeepSeekHarnessLlmRouteContext();
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    const first = routes.run(
      { provider: "provider-a", model: "model-a", sessionId: "a" },
      async () => {
        expect(routes.current()).toMatchObject({ sessionId: "a" });
        await firstGate;
        return routes.current();
      },
    );
    const second = routes.run(
      { provider: "provider-b", model: "model-b", sessionId: "b" },
      async () => {
        expect(routes.current()).toMatchObject({ sessionId: "b" });
        await secondGate;
        return routes.current();
      },
    );

    releaseSecond();
    releaseFirst();

    await expect(first).resolves.toMatchObject({
      provider: "provider-a",
      model: "model-a",
      sessionId: "a",
    });
    await expect(second).resolves.toMatchObject({
      provider: "provider-b",
      model: "model-b",
      sessionId: "b",
    });
    expect(routes.current()).toBeUndefined();
  });

  it("fails when complete is called outside an active DSH route", async () => {
    const bridge = createDeepSeekHarnessHostLlmBridge({
      llm: streamFrom(completionChunks()),
      routes: new DeepSeekHarnessLlmRouteContext(),
    });

    await expect(bridge.complete({
      messages: [{ role: "user", content: "hello" }],
    })).rejects.toThrow("no active DeepSeek Harness LLM route");
  });

  it.each([
    {
      name: "provider rate limit",
      finish: { kind: "error", failure: { message: "too many requests", code: "RATE_LIMIT" } },
      message: "too many requests",
      code: "llm_rate_limited",
      dshCode: "RATE_LIMIT",
    },
    {
      name: "provider timeout",
      finish: { kind: "error", failure: { message: "provider timed out", code: "TIMEOUT" } },
      message: "provider timed out",
      code: "llm_timeout",
      dshCode: "TIMEOUT",
    },
    {
      name: "other provider error",
      finish: { kind: "error", failure: { message: "provider unavailable", code: "UNAVAILABLE" } },
      message: "provider unavailable",
      code: "llm_unavailable",
      dshCode: "UNAVAILABLE",
    },
    {
      name: "provider abort",
      finish: { kind: "aborted", failure: { message: "request cancelled", code: "ABORTED" } },
      message: "request cancelled",
      code: "llm_unavailable",
      dshCode: "ABORTED",
    },
    {
      name: "max-token truncation",
      finish: { kind: "max-tokens" },
      message: "token cap",
      code: "llm_output_malformed",
      dshCode: "MAX_TOKENS",
    },
    {
      name: "tool request",
      finish: { kind: "tool-calls" },
      message: "tool calls",
      code: "llm_output_malformed",
      dshCode: "TOOL_CALLS",
    },
  ] as const)("rejects $name", async ({ finish, message, code, dshCode }) => {
    const routes = new DeepSeekHarnessLlmRouteContext();
    const bridge = createDeepSeekHarnessHostLlmBridge({
      llm: streamFrom([{ type: "finish", reason: finish } as StreamChunk]),
      routes,
    });

    const rejection = routes.run(ROUTE, () => bridge.complete({
      messages: [{ role: "user", content: "hello" }],
    }));

    await expect(rejection).rejects.toMatchObject({
      message: expect.stringContaining(message),
      code,
      details: { dshCode },
    });
  });

  it("rejects tool-call blocks even when the finish reason is stop", async () => {
    const routes = new DeepSeekHarnessLlmRouteContext();
    const bridge = createDeepSeekHarnessHostLlmBridge({
      llm: streamFrom([
        {
          type: "tool-call-delta",
          index: 0,
          id: "call-1" as never,
          name: "lookup",
          argumentsDelta: "{}",
        },
        { type: "finish", reason: { kind: "stop" } },
      ]),
      routes,
    });

    await expect(routes.run(ROUTE, () => bridge.complete({
      messages: [{ role: "user", content: "hello" }],
    }))).rejects.toMatchObject({
      code: "llm_output_malformed",
      details: { dshCode: "TOOL_CALLS" },
    });
  });

  it.each([
    { body: [] },
    { body: [{ type: "reasoning-delta", index: 0, text: "reasoning only" }] },
    { body: [{ type: "text-delta", index: 0, text: "   \n" }] },
  ] as const)("rejects an empty text completion %#", async ({ body }) => {
    const routes = new DeepSeekHarnessLlmRouteContext();
    const bridge = createDeepSeekHarnessHostLlmBridge({
      llm: streamFrom([
        ...(body as readonly StreamChunk[]),
        { type: "finish", reason: { kind: "stop" } },
      ]),
      routes,
    });

    await expect(routes.run(ROUTE, () => bridge.complete({
      messages: [{ role: "user", content: "hello" }],
    }))).rejects.toMatchObject({
      code: "llm_output_malformed",
      details: { dshCode: "EMPTY_TEXT" },
    });
  });

  it("combines the caller abort signal with the DSH request signal", async () => {
    const prepareCall = vi.fn<DeepSeekHarnessLlmLike["prepareCall"]>();
    const routes = new DeepSeekHarnessLlmRouteContext();
    const bridge = createDeepSeekHarnessHostLlmBridge({
      llm: {
        resolveModelInfo: (provider, model) => Promise.resolve({
          provider,
          id: model,
          name: model,
        }),
        prepareCall,
      },
      routes,
    });
    const controller = new AbortController();
    controller.abort(new Error("caller cancelled"));

    await expect(routes.run(ROUTE, () => bridge.complete({
      messages: [{ role: "user", content: "hello" }],
      signal: controller.signal,
      timeoutMs: 1_000,
    }))).rejects.toThrow("caller cancelled");
    expect(prepareCall).not.toHaveBeenCalled();
  });

  it("enforces the MemOS timeout through the fused DSH request signal", async () => {
    let observedSignal: AbortSignal | undefined;
    const llm: DeepSeekHarnessLlmLike = {
      resolveModelInfo(provider, model) {
        return Promise.resolve({ provider, id: model, name: model });
      },
      prepareCall(config, signal) {
        observedSignal = signal;
        return Promise.resolve(preparedCall(config, (options) => {
          observedSignal = options.signal;
          return (async function* (): AsyncGenerator<StreamChunk> {
            await new Promise<void>((resolve) => {
              options.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
          })();
        }));
      },
    };
    const routes = new DeepSeekHarnessLlmRouteContext();
    const bridge = createDeepSeekHarnessHostLlmBridge({ llm, routes });

    await expect(routes.run(ROUTE, () => bridge.complete({
      messages: [{ role: "user", content: "hello" }],
      timeoutMs: 5,
    }))).rejects.toMatchObject({
      code: "llm_timeout",
      details: { dshCode: "MEMOS_DSH_HOST_LLM_TIMEOUT", timeoutMs: 5 },
    });
    expect(observedSignal?.aborted).toBe(true);
  });
});
