/**
 * Regression test for issue #2362 —
 * `attachSkillSubscriber` must receive the dedicated `bgReflectLlm`
 * (built from the `skillEvolver.*` config block), NOT the main `bgLlm`.
 *
 * Background: operators can configure a distinct `skillEvolver.*` model to
 * isolate skill-evolution cost/quality from the main model. In `deps.ts`
 * the pipeline builds a dedicated `bgReflectLlm` from `deps.reflectLlm`,
 * but historically wired the skill subscriber with `llm: bgLlm` — so the
 * skillEvolver client was never actually invoked, `skillEvolver.lastOkAt`
 * never advanced, and the operator-configured skillEvolver model was
 * silently ignored.
 *
 * Fix: `attachSkillSubscriber({ llm: bgReflectLlm ?? bgLlm, ... })`. The
 * fallback preserves current behavior for installations that don't set a
 * distinct `skillEvolver` config (bootstrap aliases `reflectLlm` to null
 * in that case).
 *
 * This test locks the wiring at the pipeline layer: no matter what the
 * caller sets on `deps.llm` vs `deps.reflectLlm`, `buildPipelineSubscribers`
 * must pass the rate-limited `reflectLlm` client (identified by model name)
 * to the skill subscriber when one is provided.
 *
 * This is the mirror of issue #2148 (captureRunner mis-wiring) — same class
 * of bug, opposite direction. See `capture-reflect-llm-wiring.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  LlmCallOptions,
  LlmClient,
  LlmClientStats,
  LlmMessage,
  LlmProviderName,
} from "../../../core/llm/types.js";

const skillSubscriberCalls: Array<{
  llm: LlmClient | null;
}> = [];

vi.mock("../../../core/skill/index.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../core/skill/index.js")
  >("../../../core/skill/index.js");
  return {
    ...actual,
    attachSkillSubscriber: (deps: {
      llm: LlmClient | null;
      [k: string]: unknown;
    }) => {
      skillSubscriberCalls.push({ llm: deps.llm });
      return actual.attachSkillSubscriber(
        deps as Parameters<typeof actual.attachSkillSubscriber>[0],
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

function buildDepsWith(
  h: TmpDbHandle,
  opts: { reflectLlm: LlmClient | null },
): PipelineDeps {
  return {
    agent: "openclaw",
    home: resolveHome("openclaw", "/tmp/memos-issue-2362-test"),
    config: {
      ...DEFAULT_CONFIG,
      algorithm: {
        ...DEFAULT_CONFIG.algorithm,
        lightweightMemory: {
          ...DEFAULT_CONFIG.algorithm.lightweightMemory,
          enabled: false,
        },
      },
    },
    db: h.db,
    repos: h.repos,
    llm: fakeLlmClient("main-llm"),
    reflectLlm: opts.reflectLlm,
    l3Llm: fakeLlmClient("l3-llm"),
    embedder: fakeEmbedder({ dimensions: 384 }),
    log: rootLogger.child({ channel: "test.issue-2362" }),
    namespace: { agentKind: "openclaw", profileId: "main" },
    now: () => 1_700_000_000_000,
  };
}

beforeEach(() => {
  dbHandle = makeTmpDb();
  skillSubscriberCalls.length = 0;
});

afterEach(() => {
  dbHandle?.cleanup();
  dbHandle = null;
});

describe("pipeline/deps attachSkillSubscriber wiring (issue #2362)", () => {
  it("passes bgReflectLlm — not bgLlm — as the skill subscriber's llm when reflectLlm is configured", () => {
    const buses = buildPipelineBuses();
    const deps = buildDepsWith(dbHandle!, {
      reflectLlm: fakeLlmClient("skill-evolver-llm"),
    });
    const algorithm = extractAlgorithmConfig(deps);
    const session = buildPipelineSession(deps, buses.session);
    buildPipelineSubscribers(deps, buses, algorithm, session);

    expect(skillSubscriberCalls).toHaveLength(1);
    const call = skillSubscriberCalls[0];

    // The dedicated skillEvolver client must actually reach the skill
    // subscriber; the reflectLlm client's stats are read as
    // `skillEvolver.lastOkAt` in the overview/health endpoint, so it
    // must be the client that runs the work.
    expect(call.llm?.model).toBe("skill-evolver-llm");

    // Regression guard: even though `deps.llm` is a distinct main-model
    // client, the skill pipeline must ignore it and use the dedicated
    // skillEvolver client. See issue #2362.
    expect(call.llm?.model).not.toBe("main-llm");
  });

  it("falls back to bgLlm when reflectLlm is not configured (backwards compatible)", () => {
    // Installations that don't configure a distinct `skillEvolver.*`
    // block leave `deps.reflectLlm` null — the fix must preserve today's
    // behavior for those setups and use the main model instead.
    const buses = buildPipelineBuses();
    const deps = buildDepsWith(dbHandle!, { reflectLlm: null });
    const algorithm = extractAlgorithmConfig(deps);
    const session = buildPipelineSession(deps, buses.session);
    buildPipelineSubscribers(deps, buses, algorithm, session);

    expect(skillSubscriberCalls).toHaveLength(1);
    const call = skillSubscriberCalls[0];
    expect(call.llm?.model).toBe("main-llm");
  });
});
