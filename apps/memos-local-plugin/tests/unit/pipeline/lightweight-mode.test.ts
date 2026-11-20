/**
 * Regression tests for issue #2063 — `algorithm.lightweightMemory.enabled:
 * true` must actually skip the evolution pipeline (reward / L2 / L3 /
 * skill / feedback), not just short-circuit inside `flush()`. The bug was
 * that `buildPipelineSubscribers` unconditionally attached every runner
 * to the buses, so every `capture.done` / `reward.updated` / ... event
 * still cascaded through the LLM-heavy evolution chain even with the
 * flag on.
 *
 * These tests lock in the schema-comment contract:
 * > When enabled, the runtime skips task/reward/L2/L3/skill evolution
 * > and keeps only summarize + embedding + retrieval filter.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildPipelineBuses,
  buildPipelineSession,
  buildPipelineSubscribers,
  createPipeline,
  extractAlgorithmConfig,
  type PipelineDeps,
  type PipelineHandle,
} from "../../../core/pipeline/index.js";
import { DEFAULT_CONFIG } from "../../../core/config/defaults.js";
import { resolveHome } from "../../../core/config/paths.js";
import { rootLogger } from "../../../core/logger/index.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";
import { fakeEmbedder } from "../../helpers/fake-embedder.js";
import type { EpisodeSnapshot } from "../../../core/session/index.js";

let dbHandle: TmpDbHandle | null = null;
let pipeline: PipelineHandle | null = null;

function configWithLightweightMemory(enabled: boolean): typeof DEFAULT_CONFIG {
  return {
    ...DEFAULT_CONFIG,
    algorithm: {
      ...DEFAULT_CONFIG.algorithm,
      lightweightMemory: {
        ...DEFAULT_CONFIG.algorithm.lightweightMemory,
        enabled,
      },
    },
  };
}

function buildDeps(
  h: TmpDbHandle,
  lightweight: boolean,
): PipelineDeps {
  return {
    agent: "openclaw",
    home: resolveHome("openclaw", "/tmp/memos-lightweight-test"),
    config: configWithLightweightMemory(lightweight),
    db: h.db,
    repos: h.repos,
    llm: null,
    reflectLlm: null,
    embedder: fakeEmbedder({ dimensions: 384 }),
    log: rootLogger.child({ channel: "test.lightweight" }),
    namespace: { agentKind: "openclaw", profileId: "main" },
    now: () => 1_700_000_000_000,
  };
}

beforeEach(() => {
  dbHandle = makeTmpDb();
  pipeline = null;
});

afterEach(async () => {
  if (pipeline) {
    try {
      await pipeline.shutdown("test.cleanup");
    } catch {
      /* ignore */
    }
    pipeline = null;
  }
  dbHandle?.cleanup();
  dbHandle = null;
});

describe("pipeline/lightweight-mode wiring (issue #2063)", () => {
  it("normal mode attaches reward/L2/L3/skill subscribers to their upstream buses", () => {
    const buses = buildPipelineBuses();
    const deps = buildDeps(dbHandle!, false);
    const algorithm = extractAlgorithmConfig(deps);
    const session = buildPipelineSession(deps, buses.session);
    buildPipelineSubscribers(deps, buses, algorithm, session);

    // rewardSub listens on captureBus for `capture.done`.
    expect(buses.capture.listenerCount("capture.done")).toBeGreaterThan(0);
    // L2Sub + SkillSub listen on rewardBus.
    expect(buses.reward.listenerCount()).toBeGreaterThan(0);
    // L3Sub + SkillSub listen on l2Bus.
    expect(buses.l2.listenerCount()).toBeGreaterThan(0);
  });

  it("lightweight mode does NOT attach reward/L2/L3/skill subscribers", () => {
    const buses = buildPipelineBuses();
    const deps = buildDeps(dbHandle!, true);
    const algorithm = extractAlgorithmConfig(deps);
    const session = buildPipelineSession(deps, buses.session);
    buildPipelineSubscribers(deps, buses, algorithm, session);

    // The evolution pipeline must be completely off — no listeners on
    // the upstream buses that would drive reward / L2 / L3 / skill
    // runners.
    expect(buses.capture.listenerCount("capture.done")).toBe(0);
    expect(buses.reward.listenerCount()).toBe(0);
    expect(buses.l2.listenerCount()).toBe(0);
  });

  it("lightweight pipeline exposes no evolution listeners even on session bus recovery", async () => {
    // Simulate the bug from the issue: bridge starts up in lightweight
    // mode, `recoverOpenEpisodesAsSessionEnd` re-emits
    // `episode.finalized` for a legacy episode that was closed before
    // lightweight mode was turned on (so `meta.lightweightMemory` is
    // missing). No LLM-heavy runners must fire.
    pipeline = createPipeline(buildDeps(dbHandle!, true));

    let rewardScheduled = 0;
    let l2Started = 0;
    let l3Started = 0;
    let skillStarted = 0;
    pipeline.buses.reward.onAny(() => {
      rewardScheduled++;
    });
    pipeline.buses.l2.onAny(() => {
      l2Started++;
    });
    pipeline.buses.l3.onAny(() => {
      l3Started++;
    });
    pipeline.buses.skill.onAny(() => {
      skillStarted++;
    });

    // Fabricate a plain (non-lightweight) episode snapshot and emit a
    // recovery-style finalization exactly as `memory-core.ts` does at
    // startup.
    const legacyEpisode: EpisodeSnapshot = {
      id: "ep_legacy" as never,
      sessionId: "se_legacy" as never,
      status: "closed",
      startedAt: 1_699_000_000_000 as never,
      endedAt: 1_699_000_005_000 as never,
      rTask: null,
      traceIds: [],
      meta: {},
      turns: [],
      turnCount: 0,
      intent: {
        kind: "task",
        confidence: 0.5,
        reason: "test-fixture",
        retrieval: { tier1: true, tier2: true, tier3: true },
        signals: [],
      },
    };
    pipeline.buses.session.emit({
      kind: "episode.finalized",
      episode: legacyEpisode,
      closedBy: "finalized",
    });

    await pipeline.flush();

    // In lightweight mode, no reward / L2 / L3 / skill events must
    // fire from a session-bus finalization. This is the exact regression
    // called out in issue #2063.
    expect(rewardScheduled).toBe(0);
    expect(l2Started).toBe(0);
    expect(l3Started).toBe(0);
    expect(skillStarted).toBe(0);
  });
});
