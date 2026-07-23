/**
 * Regression test for issue #2148 —
 * `captureRunner` must receive the main `llm` for its batch-reflection
 * pass, NOT `reflectLlm` (skill-evolver).
 *
 * Background: batch reflection is a JSON-output task. When the operator
 * configures a stronger, thinking-enabled model under `skillEvolver.*`
 * and leaves `llm.enableThinking=false`, wiring `reflectLlm` (skill-
 * evolver) into the capture pipeline makes reflection produce
 * `<think>...</think>` blocks that break JSON parsing. The skill-evolver
 * model is intended for skill crystallization, not capture reflection.
 *
 * This test locks the wiring at the pipeline layer: no matter what the
 * caller sets on `deps.reflectLlm`, `buildPipelineSubscribers` must pass
 * `deps.llm` to `createCaptureRunner`'s `reflectLlm` slot.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  LlmCallOptions,
  LlmClient,
  LlmClientStats,
  LlmMessage,
  LlmProviderName,
} from "../../../core/llm/types.js";

const captureRunnerCalls: Array<{
  llm: LlmClient | null;
  reflectLlm: LlmClient | null;
}> = [];

vi.mock("../../../core/capture/index.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../core/capture/index.js")
  >("../../../core/capture/index.js");
  return {
    ...actual,
    createCaptureRunner: (deps: {
      llm: LlmClient | null;
      reflectLlm: LlmClient | null;
      [k: string]: unknown;
    }) => {
      captureRunnerCalls.push({ llm: deps.llm, reflectLlm: deps.reflectLlm });
      return actual.createCaptureRunner(
        deps as Parameters<typeof actual.createCaptureRunner>[0],
      );
    },
  };
});

import {
  buildPipelineBuses,
  buildPipelineSession,
  buildPipelineSubscribers,
  extractAlgorithmConfig,
  type PipelineDeps,
} from "../../../core/pipeline/index.js";
import { DEFAULT_CONFIG } from "../../../core/config/defaults.js";
import { resolveHome } from "../../../core/config/paths.js";
import { rootLogger } from "../../../core/logger/index.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";
import { fakeEmbedder } from "../../helpers/fake-embedder.js";

function fakeLlmClient(name: string): LlmClient {
  return {
    provider: "local_only" as LlmProviderName,
    model: name,
    canStream: false,
    async complete(_messages: LlmMessage[] | string, _opts?: LlmCallOptions) {
      return {
        text: "{}",
        provider: "local_only" as LlmProviderName,
        model: name,
        servedBy: "local_only" as LlmProviderName,
        durationMs: 0,
      };
    },
    async completeJson<T>() {
      return {
        value: {} as T,
        raw: "{}",
        provider: "local_only" as LlmProviderName,
        model: name,
        servedBy: "local_only" as LlmProviderName,
        durationMs: 0,
      };
    },
    async *stream() {
      yield { delta: "", done: true };
    },
    stats(): LlmClientStats {
      return {
        requests: 0,
        hostFallbacks: 0,
        failures: 0,
        retries: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        lastOkAt: null,
        lastError: null,
        lastStatus: null,
      };
    },
    resetStats() {},
    async close() {},
  };
}

let dbHandle: TmpDbHandle | null = null;

function buildDepsWithDistinctLlms(
  h: TmpDbHandle,
  lightweight: boolean,
): PipelineDeps {
  return {
    agent: "openclaw",
    home: resolveHome("openclaw", "/tmp/memos-issue-2148-test"),
    config: {
      ...DEFAULT_CONFIG,
      algorithm: {
        ...DEFAULT_CONFIG.algorithm,
        lightweightMemory: {
          ...DEFAULT_CONFIG.algorithm.lightweightMemory,
          enabled: lightweight,
        },
      },
    },
    db: h.db,
    repos: h.repos,
    llm: fakeLlmClient("main-llm"),
    reflectLlm: fakeLlmClient("skill-evolver-llm"),
    l3Llm: fakeLlmClient("l3-llm"),
    embedder: fakeEmbedder({ dimensions: 384 }),
    log: rootLogger.child({ channel: "test.issue-2148" }),
    namespace: { agentKind: "openclaw", profileId: "main" },
    now: () => 1_700_000_000_000,
  };
}

beforeEach(() => {
  dbHandle = makeTmpDb();
  captureRunnerCalls.length = 0;
});

afterEach(() => {
  dbHandle?.cleanup();
  dbHandle = null;
});

describe("pipeline/deps captureRunner wiring (issue #2148)", () => {
  it("passes the main llm — not reflectLlm — as the capture runner's reflectLlm slot (normal mode)", () => {
    const buses = buildPipelineBuses();
    const deps = buildDepsWithDistinctLlms(dbHandle!, false);
    const algorithm = extractAlgorithmConfig(deps);
    const session = buildPipelineSession(deps, buses.session);
    buildPipelineSubscribers(deps, buses, algorithm, session);

    expect(captureRunnerCalls).toHaveLength(1);
    const call = captureRunnerCalls[0];

    // The main `llm` slot is unchanged: still the main model.
    expect(call.llm?.model).toBe("main-llm");

    // Regression guard: even though `deps.reflectLlm` is a distinct
    // skill-evolver model (with e.g. enableThinking=true in real use),
    // the capture pipeline must ignore it and use the main llm — batch
    // reflection is a JSON-output task and cannot tolerate thinking
    // tags. See issue #2148.
    expect(call.reflectLlm?.model).toBe("main-llm");
    expect(call.reflectLlm?.model).not.toBe("skill-evolver-llm");
  });

  it("passes the main llm as reflectLlm even in lightweight mode", () => {
    // Lightweight mode still constructs the capture runner (it's what
    // handles the lite/lightweight capture paths); the reflect pass is
    // gated separately. The wiring guard must hold either way so a
    // future flip of the flag can't reintroduce the bug.
    const buses = buildPipelineBuses();
    const deps = buildDepsWithDistinctLlms(dbHandle!, true);
    const algorithm = extractAlgorithmConfig(deps);
    const session = buildPipelineSession(deps, buses.session);
    buildPipelineSubscribers(deps, buses, algorithm, session);

    expect(captureRunnerCalls).toHaveLength(1);
    const call = captureRunnerCalls[0];
    expect(call.llm?.model).toBe("main-llm");
    expect(call.reflectLlm?.model).toBe("main-llm");
  });
});
