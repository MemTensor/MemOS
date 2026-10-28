/** Host-LLM bridge that delegates MemOS calls to DeepSeek Harness routing. */

import {
  BlockAssembler,
  createAssistantMessage,
  createUserMessage,
  isHarnessError,
  ReasoningEffortId,
  type FinishReason,
  type GenerateOptions,
  type LlmCallConfig,
  type LlmFailure,
  type LlmResolvedModelInfo,
  type PreparedLlmCall,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { deadline, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { AsyncLocalStorage } from "node:async_hooks";

import { ERROR_CODES, MemosError } from "../../agent-contract/errors.js";
import type {
  HostLlmBridge,
  HostLlmCompleteInput,
  HostLlmCompletion,
} from "../../core/llm/host-bridge.js";
import type { LlmMessage, LlmUsage } from "../../core/llm/types.js";

const HOST_LLM_BRIDGE_ID = "deepseek-harness.host.v1";
const HOST_LLM_TIMEOUT_CODE = "MEMOS_DSH_HOST_LLM_TIMEOUT";
const HOST_LLM_MESSAGE_SOURCE = "memos-local-memory";
const NO_REASONING_EFFORT = ReasoningEffortId("off");
const UNSUPPORTED_REASONING_EFFORT = "UNSUPPORTED_REASONING_EFFORT";
const MODEL_CAPABILITY_TTL_MS = 10 * 60 * 1_000;

/** Atomic provider/model route captured from the DSH agent that owns a turn. */
export interface DeepSeekHarnessLlmRoute {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly sessionId?: string;
}

/** Public subset of DSH's LLM runtime used by this adapter. */
export interface DeepSeekHarnessLlmLike {
  resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo>;
  prepareCall(
    config: LlmCallConfig,
    signal?: AbortSignal,
  ): Promise<PreparedLlmCall>;
}

export interface DeepSeekHarnessHostLlmBridge extends HostLlmBridge {
  /** Drop exact-route capability snapshots after a DSH adapter topology update. */
  invalidateModelCapabilities(): void;
}

type AuxiliaryReasoningCapability = "off" | "plain";

interface CapabilityCacheEntry {
  readonly expiresAt: number;
  readonly value: Promise<AuxiliaryReasoningCapability>;
}

interface CapabilityCache {
  readonly entries: Map<string, CapabilityCacheEntry>;
  generation: number;
}

/**
 * Async route scope for MemOS work spawned by one DSH session.
 *
 * The route belongs in async-local state instead of a mutable singleton: DSH
 * can capture multiple sessions concurrently, and credentials are resolved by
 * the DSH LLM runtime only after the exact provider/model pair reaches it.
 */
export class DeepSeekHarnessLlmRouteContext {
  private readonly storage = new AsyncLocalStorage<DeepSeekHarnessLlmRoute>();

  run<T>(route: DeepSeekHarnessLlmRoute, callback: () => T): T {
    const provider = route.provider.trim();
    const model = route.model.trim();
    if (!provider || !model) {
      throw new MemosError(
        ERROR_CODES.INVALID_ARGUMENT,
        "DeepSeek Harness LLM route requires non-empty provider and model",
        { dshCode: "INVALID_ROUTE" },
      );
    }
    const snapshot = Object.freeze({
      provider,
      model,
      ...(route.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: route.reasoningEffort }),
      ...(route.sessionId === undefined ? {} : { sessionId: route.sessionId }),
    });
    return this.storage.run(snapshot, callback);
  }

  current(): DeepSeekHarnessLlmRoute | undefined {
    return this.storage.getStore();
  }
}

export interface CreateDeepSeekHarnessHostLlmBridgeOptions {
  readonly llm: DeepSeekHarnessLlmLike;
  readonly routes: DeepSeekHarnessLlmRouteContext;
}

/**
 * Create a MemOS HostLlmBridge backed by DSH's public streaming runtime.
 *
 * No credential is accepted or read here. DSH resolves credentials inside its
 * registered provider adapter, using the same route as the owning agent turn.
 */
export function createDeepSeekHarnessHostLlmBridge(
  options: CreateDeepSeekHarnessHostLlmBridgeOptions,
): DeepSeekHarnessHostLlmBridge {
  const capabilityCache: CapabilityCache = {
    entries: new Map(),
    generation: 0,
  };
  return {
    id: HOST_LLM_BRIDGE_ID,
    invalidateModelCapabilities(): void {
      capabilityCache.generation++;
      capabilityCache.entries.clear();
    },
    async complete(input: HostLlmCompleteInput): Promise<HostLlmCompletion> {
      const route = options.routes.current();
      if (!route) {
        throw new MemosError(
          ERROR_CODES.LLM_UNAVAILABLE,
          "no active DeepSeek Harness LLM route for this MemOS operation",
          { dshCode: "NO_ACTIVE_ROUTE" },
        );
      }

      const startedAt = Date.now();
      const callDeadline = deadline(
        input.signal,
        input.timeoutMs ?? 0,
        HOST_LLM_TIMEOUT_CODE,
      );

      try {
        callDeadline.signal.throwIfAborted();
        const prepared = await prepareAuxiliaryCall(
          options.llm,
          input,
          route,
          callDeadline.signal,
          capabilityCache,
        );
        const request = createGenerateOptions(input, route, prepared.config);
        request.signal = callDeadline.signal;
        const assembler = new BlockAssembler();
        for await (const chunk of prepared.stream(request)) {
          callDeadline.signal.throwIfAborted();
          assembler.push(chunk);
        }
        callDeadline.signal.throwIfAborted();

        assertSuccessfulFinish(assembler.finish);
        const blocks = assembler.blocks();
        if (blocks.some((block) => block.type === "tool-call")) {
          throw outputError(
            "DeepSeek Harness host LLM returned tool calls for a text-only MemOS request",
            "TOOL_CALLS",
          );
        }
        if (blocks.some((block) => block.type !== "text" && block.type !== "reasoning")) {
          throw outputError(
            "DeepSeek Harness host LLM returned unsupported non-text content",
            "UNSUPPORTED_CONTENT",
          );
        }

        const text = blocks
          .filter((block): block is Extract<(typeof blocks)[number], { type: "text" }> => (
            block.type === "text"
          ))
          .map((block) => block.text)
          .join("");
        if (!text.trim()) {
          throw outputError(
            "DeepSeek Harness host LLM produced no text content",
            "EMPTY_TEXT",
          );
        }

        return {
          text,
          model: route.model,
          ...(assembler.usage === undefined ? {} : { usage: mapUsage(assembler.usage) }),
          durationMs: Date.now() - startedAt,
        };
      } catch (error) {
        const timeout = timeoutOf(callDeadline.signal, HOST_LLM_TIMEOUT_CODE);
        if (timeout) {
          throw new MemosError(
            ERROR_CODES.LLM_TIMEOUT,
            timeout.message,
            { dshCode: timeout.code, timeoutMs: timeout.timeoutMs },
          );
        }
        throw error;
      } finally {
        callDeadline[Symbol.dispose]();
      }
    },
  };
}

function createGenerateOptions(
  input: HostLlmCompleteInput,
  route: DeepSeekHarnessLlmRoute,
  config: LlmCallConfig,
): GenerateOptions {
  const system = input.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const messages = input.messages.flatMap((message) => {
    if (message.role === "system") return [];
    return [toDshMessage(message, route)];
  });

  return {
    // The prepared config is registration-bound and may contain adapter-owned
    // defaults. Preserve it byte-for-byte so prepared.stream() can prove that
    // capability validation and dispatch use the same DSH adapter registration.
    ...config,
    messages,
    ...(system ? { system } : {}),
    // Deliberately omit DSH sessionId. These are auxiliary memory-model calls,
    // not conversation turns; binding them to the live session would trigger
    // DSH durability checkpoints and project helper traffic into the owning
    // agent lifecycle. The per-turn route still selects the exact provider and
    // model without coupling the call to session state.
  };
}

/**
 * Prepare a registration-bound bounded MemOS helper call.
 *
 * Retrieval filters and JSON extractors intentionally use small output caps.
 * Reusing a conversation's high reasoning effort can spend that entire cap on
 * reasoning and produce no JSON/text. Resolve exact-model metadata through
 * DSH, then cache whether its adapter advertises the conventional `off` id.
 * prepareCall remains the final registration-bound authority: if HMR changes
 * the route after metadata resolution, an explicit unsupported-effort result
 * refreshes the cache and retries with the adapter/provider default.
 */
async function prepareAuxiliaryCall(
  llm: DeepSeekHarnessLlmLike,
  input: HostLlmCompleteInput,
  route: DeepSeekHarnessLlmRoute,
  signal: AbortSignal,
  capabilityCache: CapabilityCache,
): Promise<PreparedLlmCall> {
  const config = createCallConfig(input, route);
  const capability = await resolveAuxiliaryReasoningCapability(
    llm,
    route,
    signal,
    capabilityCache,
  );
  if (capability === "plain") {
    return llm.prepareCall(config, signal);
  }
  const preparationGeneration = capabilityCache.generation;
  try {
    return await llm.prepareCall(
      { ...config, reasoningEffort: NO_REASONING_EFFORT },
      signal,
    );
  } catch (error) {
    if (
      !isHarnessError(error)
      || error.code !== UNSUPPORTED_REASONING_EFFORT
    ) {
      throw error;
    }
    // The exact adapter may have changed after the metadata lookup. Preserve
    // prepareCall's registration-bound validation as the final authority and
    // remember the corrected capability only if no newer topology update has
    // already invalidated this preparation generation.
    if (capabilityCache.generation === preparationGeneration) {
      rememberAuxiliaryReasoningCapability(route, "plain", capabilityCache);
    }
    return llm.prepareCall(config, signal);
  }
}

function capabilityRouteKey(route: DeepSeekHarnessLlmRoute): string {
  return JSON.stringify([route.provider, route.model]);
}

function rememberAuxiliaryReasoningCapability(
  route: DeepSeekHarnessLlmRoute,
  capability: AuxiliaryReasoningCapability,
  cache: CapabilityCache,
): void {
  cache.entries.set(capabilityRouteKey(route), {
    expiresAt: Date.now() + MODEL_CAPABILITY_TTL_MS,
    value: Promise.resolve(capability),
  });
}

async function resolveAuxiliaryReasoningCapability(
  llm: DeepSeekHarnessLlmLike,
  route: DeepSeekHarnessLlmRoute,
  signal: AbortSignal,
  cache: CapabilityCache,
): Promise<AuxiliaryReasoningCapability> {
  const key = capabilityRouteKey(route);
  const cached = cache.entries.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  if (cached) cache.entries.delete(key);

  let entry: CapabilityCacheEntry;
  const value = llm.resolveModelInfo(route.provider, route.model, signal)
    .then((info): AuxiliaryReasoningCapability => (
      info.reasoning?.efforts.some((effort) => effort.id === NO_REASONING_EFFORT)
        ? "off"
        : "plain"
    ))
    .catch((error: unknown) => {
      if (cache.entries.get(key) === entry) cache.entries.delete(key);
      throw error;
    });
  entry = {
    expiresAt: Date.now() + MODEL_CAPABILITY_TTL_MS,
    value,
  };
  cache.entries.set(key, entry);
  return value;
}

function createCallConfig(
  input: HostLlmCompleteInput,
  route: DeepSeekHarnessLlmRoute,
): LlmCallConfig {
  return {
    provider: route.provider,
    // A DSH route is an atomic pair. HostLlmCompleteInput.model may describe a
    // direct MemOS provider, so applying it without a provider would misroute.
    model: route.model,
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
  };
}

function toDshMessage(
  message: Exclude<LlmMessage, { role: "system" }>,
  route: DeepSeekHarnessLlmRoute,
) {
  const content = [{ type: "text" as const, text: message.content }];
  if (message.role === "user") {
    return createUserMessage({
      content,
      source: { kind: "plugin", plugin: HOST_LLM_MESSAGE_SOURCE },
    });
  }
  return createAssistantMessage({
    content,
    source: { provider: route.provider, model: route.model },
  });
}

function assertSuccessfulFinish(finish: FinishReason): void {
  switch (finish.kind) {
    case "stop":
      return;
    case "error":
    case "aborted":
      throw dshFailureError(finish.failure);
    case "max-tokens":
      throw outputError(
        "DeepSeek Harness host LLM reached the token cap before completing",
        "MAX_TOKENS",
      );
    case "tool-calls":
      throw outputError(
        "DeepSeek Harness host LLM requested tool calls for a text-only MemOS request",
        "TOOL_CALLS",
      );
    default:
      throw outputError(
        "DeepSeek Harness host LLM returned an unsupported finish reason",
        "UNSUPPORTED_FINISH",
      );
  }
}

function mapUsage(usage: NonNullable<BlockAssembler["usage"]>): LlmUsage {
  const promptTokens = usage.inputTokens
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheWriteTokens ?? 0);
  // DSH's outputTokens already includes reasoning output. reasoningTokens is
  // an informational subset, so adding it again would double-count usage.
  const completionTokens = usage.outputTokens;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}

function dshFailureError(failure: LlmFailure): MemosError {
  const code = failure.code === "RATE_LIMIT"
    ? ERROR_CODES.LLM_RATE_LIMITED
    : failure.code === "TIMEOUT"
      ? ERROR_CODES.LLM_TIMEOUT
      : ERROR_CODES.LLM_UNAVAILABLE;
  return new MemosError(code, failure.message, {
    dshCode: failure.code,
    ...(failure.status === undefined ? {} : { status: failure.status }),
    ...(failure.providerRetryAfterMs === undefined
      ? {}
      : { providerRetryAfterMs: failure.providerRetryAfterMs }),
    ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
  });
}

function outputError(message: string, dshCode: string): MemosError {
  return new MemosError(
    ERROR_CODES.LLM_OUTPUT_MALFORMED,
    message,
    { dshCode },
  );
}
