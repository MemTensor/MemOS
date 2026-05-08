/**
 * `attachL2Subscriber` binds the reward bus to the L2 orchestrator.
 *
 * We test that a `reward.updated` event actually triggers L2 processing
 * (at least one candidate added), and that detach() stops further work.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRewardEventBus } from "../../../../core/reward/events.js";
import type { RewardEvent, RewardResult } from "../../../../core/reward/types.js";
import {
  attachL2Subscriber,
  createL2EventBus,
  type L2Config,
  type L2Event,
} from "../../../../core/memory/l2/index.js";
import { rootLogger } from "../../../../core/logger/index.js";
import type {
  EmbeddingVector,
  TraceRow,
} from "../../../../core/types.js";
import { fakeLlm } from "../../../helpers/fake-llm.js";
import { makeTmpDb, type TmpDbHandle } from "../../../helpers/tmp-db.js";
import { ensureEpisode } from "./_helpers.js";

const NOW = 1_700_000_000_000;

function cfg(): L2Config {
  return {
    minSimilarity: 0.8,
    candidateTtlDays: 30,
    gamma: 0.9,
    tauSoftmax: 0.4,
    useLlm: true,
    minTraceValue: 0.1,
    minEpisodesForInduction: 5, // keep induction off for this test
    inductionTraceCharCap: 2_000,
  };
}

function vec(values: readonly number[]): EmbeddingVector {
  return new Float32Array(values) as unknown as EmbeddingVector;
}

function seedTrace(handle: TmpDbHandle, id: string, ep: string): TraceRow {
  ensureEpisode(handle, ep, "s_sub");
  const row: TraceRow = {
    id: id as TraceRow["id"],
    episodeId: ep as TraceRow["episodeId"],
    sessionId: "s_sub" as TraceRow["sessionId"],
    ts: NOW as TraceRow["ts"],
    userText: "",
    agentText: "",
    toolCalls: [
      { name: "pip.install", input: {}, output: "Error: MODULE_NOT_FOUND", startedAt: NOW, endedAt: NOW },
    ],
    reflection: null,
    value: 0.8,
    alpha: 0.5 as TraceRow["alpha"],
    rHuman: null,
    priority: 0,
    tags: ["docker", "pip"],
    vecSummary: vec([1, 0, 0]),
    vecAction: null,
    turnId: 0 as never,
    schemaVersion: 1,
  };
  handle.repos.traces.insert(row);
  return row;
}

function fakeRewardResult(episodeId: string, traceIds: string[]): RewardResult {
  return {
    episodeId: episodeId as RewardResult["episodeId"],
    sessionId: "s_sub" as RewardResult["sessionId"],
    rHuman: 0.8,
    humanScore: {
      rHuman: 0.8,
      axes: { goalAchievement: 0.8, processQuality: 0.6, userSatisfaction: 0.8 },
      reason: "ok",
      source: "heuristic",
      model: null,
    },
    feedbackCount: 1,
    backprop: {
      updates: [],
      meanAbsValue: 0.8,
      maxPriority: 0.8,
      echoParams: { gamma: 0.9, decayHalfLifeDays: 30, now: NOW },
    },
    traceIds: traceIds as RewardResult["traceIds"],
    timings: { summary: 0, score: 0, backprop: 0, persist: 0, total: 0 },
    warnings: [],
    startedAt: NOW as RewardResult["startedAt"],
    completedAt: NOW as RewardResult["completedAt"],
  };
}

describe("memory/l2/subscriber", () => {
  let handle: TmpDbHandle;
  beforeEach(() => {
    handle = makeTmpDb();
  });
  afterEach(() => {
    handle.cleanup();
  });

  it("emits l2.candidate.added when reward.updated fires", async () => {
    seedTrace(handle, "tr_a", "ep_1");

    const rewardBus = createRewardEventBus();
    const l2Bus = createL2EventBus();
    const events: L2Event[] = [];
    l2Bus.onAny((e) => events.push(e));

    const sub = attachL2Subscriber({
      db: handle.db,
      repos: handle.repos,
      rewardBus,
      l2Bus,
      llm: fakeLlm(),
      log: rootLogger,
      config: cfg(),
      thresholds: { minSupport: 3, minGain: 0.15, archiveGain: -0.05 },
    });

    rewardBus.emit({
      kind: "reward.updated",
      result: fakeRewardResult("ep_1", ["tr_a"]),
    } as RewardEvent);

    await new Promise((r) => setTimeout(r, 50));

    expect(events.some((e) => e.kind === "l2.candidate.added")).toBe(true);
    sub.detach();
  });

  it("detach stops further processing", async () => {
    seedTrace(handle, "tr_b", "ep_2");

    const rewardBus = createRewardEventBus();
    const l2Bus = createL2EventBus();
    const events: L2Event[] = [];
    l2Bus.onAny((e) => events.push(e));

    const sub = attachL2Subscriber({
      db: handle.db,
      repos: handle.repos,
      rewardBus,
      l2Bus,
      llm: fakeLlm(),
      log: rootLogger,
      config: cfg(),
      thresholds: { minSupport: 3, minGain: 0.15, archiveGain: -0.05 },
    });
    sub.detach();

    rewardBus.emit({
      kind: "reward.updated",
      result: fakeRewardResult("ep_2", ["tr_b"]),
    } as RewardEvent);

    await new Promise((r) => setTimeout(r, 30));
    expect(events).toHaveLength(0);
  });

  it("coalesces dense reward.updated events for the same episode", async () => {
    seedTrace(handle, "tr_dense", "ep_dense");

    const rewardBus = createRewardEventBus();
    const l2Bus = createL2EventBus();
    const events: L2Event[] = [];
    l2Bus.onAny((e) => events.push(e));

    const sub = attachL2Subscriber({
      db: handle.db,
      repos: handle.repos,
      rewardBus,
      l2Bus,
      llm: fakeLlm(),
      log: rootLogger,
      config: cfg(),
      thresholds: { minSupport: 3, minGain: 0.15, archiveGain: -0.05 },
    });

    for (let i = 0; i < 5; i++) {
      rewardBus.emit({
        kind: "reward.updated",
        result: fakeRewardResult("ep_dense", ["tr_dense"]),
      } as RewardEvent);
    }

    await sub.drain();

    expect(events.filter((e) => e.kind === "l2.candidate.added")).toHaveLength(2);
    sub.detach();
  });

  it("runOnce reloads traces from SQLite", async () => {
    seedTrace(handle, "tr_c", "ep_3");

    const rewardBus = createRewardEventBus();
    const l2Bus = createL2EventBus();
    const events: L2Event[] = [];
    l2Bus.onAny((e) => events.push(e));

    const sub = attachL2Subscriber({
      db: handle.db,
      repos: handle.repos,
      rewardBus,
      l2Bus,
      llm: null, // LLM disabled → candidate-only
      log: rootLogger,
      config: cfg(),
      thresholds: { minSupport: 3, minGain: 0.15, archiveGain: -0.05 },
    });

    await sub.runOnce("ep_3" as TraceRow["episodeId"]);
    expect(events.some((e) => e.kind === "l2.candidate.added")).toBe(true);
    sub.detach();
  });
});
