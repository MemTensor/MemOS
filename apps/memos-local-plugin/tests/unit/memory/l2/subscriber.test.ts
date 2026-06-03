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
  FeedbackRow,
  PolicyRow,
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
    gainEmaAlpha: 0.4,
  };
}

function vec(values: readonly number[]): EmbeddingVector {
  return new Float32Array(values) as unknown as EmbeddingVector;
}

function seedTrace(
  handle: TmpDbHandle,
  id: string,
  ep: string,
  toolOutput = "Error: MODULE_NOT_FOUND",
): TraceRow {
  ensureEpisode(handle, ep, "s_sub");
  const row: TraceRow = {
    id: id as TraceRow["id"],
    episodeId: ep as TraceRow["episodeId"],
    sessionId: "s_sub" as TraceRow["sessionId"],
    ts: NOW as TraceRow["ts"],
    userText: "",
    agentText: "",
    toolCalls: [
      { name: "pip.install", input: {}, output: toolOutput, startedAt: NOW, endedAt: NOW },
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
      echoParams: { gamma: 0.9, lambda: 0.5, delta: 0.1, decayHalfLifeDays: 30, now: NOW },
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

  it("gates infra-heavy failure episodes with verdict E", async () => {
    seedTrace(handle, "tr_e", "ep_e", "socket failed: ETIMEDOUT");
    handle.repos.episodes.setOutcome("ep_e" as TraceRow["episodeId"], "failure");

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
      result: fakeRewardResult("ep_e", ["tr_e"]),
    } as RewardEvent);
    await sub.drain();

    const ep = handle.repos.episodes.getById("ep_e" as TraceRow["episodeId"]);
    expect(ep?.meta?.gateVerdict).toBe("E");
    expect(events.some((e) => e.kind === "l2.candidate.added")).toBe(false);
    sub.detach();
  });

  it("gates questionable failure episodes with verdict Q", async () => {
    seedTrace(handle, "tr_q", "ep_q");
    handle.repos.episodes.setOutcome("ep_q" as TraceRow["episodeId"], "failure");
    handle.repos.episodes.setVerifierPassed("ep_q" as TraceRow["episodeId"], null);

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
      result: fakeRewardResult("ep_q", ["tr_q"]),
    } as RewardEvent);
    await sub.drain();

    const ep = handle.repos.episodes.getById("ep_q" as TraceRow["episodeId"]);
    expect(ep?.meta?.gateVerdict).toBe("Q");
    expect(events.some((e) => e.kind === "l2.candidate.added")).toBe(false);
    sub.detach();
  });

  it("routes learnable failure with feedback away from runL2", async () => {
    seedTrace(handle, "tr_f", "ep_f");
    handle.repos.episodes.setOutcome("ep_f" as TraceRow["episodeId"], "failure");
    handle.repos.episodes.setVerifierPassed("ep_f" as TraceRow["episodeId"], false);
    const feedback: FeedbackRow = {
      id: "fb_ep_f" as FeedbackRow["id"],
      ownerAgentKind: "openclaw",
      ownerProfileId: "default",
      ownerWorkspaceId: null,
      ts: NOW as FeedbackRow["ts"],
      episodeId: "ep_f" as FeedbackRow["episodeId"],
      traceId: "tr_f" as FeedbackRow["traceId"],
      channel: "explicit",
      polarity: "negative",
      magnitude: 1,
      rationale: "需要修正",
      raw: { text: "请修复这个失败路径" },
    };
    handle.repos.feedback.insert(feedback);

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
      result: fakeRewardResult("ep_f", ["tr_f"]),
    } as RewardEvent);
    await sub.drain();

    const ep = handle.repos.episodes.getById("ep_f" as TraceRow["episodeId"]);
    expect(ep?.meta?.gateVerdict).toBe("L");
    expect(events.some((e) => e.kind === "l2.candidate.added")).toBe(false);
    sub.detach();
  });

  it("routes learnable failure without feedback to failure sink", async () => {
    seedTrace(handle, "tr_sink", "ep_sink", "app error: bad config");
    handle.repos.episodes.setOutcome("ep_sink" as TraceRow["episodeId"], "failure");
    handle.repos.episodes.setVerifierPassed("ep_sink" as TraceRow["episodeId"], false);

    const rewardBus = createRewardEventBus();
    const l2Bus = createL2EventBus();
    const sub = attachL2Subscriber({
      db: handle.db,
      repos: handle.repos,
      rewardBus,
      l2Bus,
      llm: fakeLlm({
        completeJson: {
          "l2.failure.experience.sink.v2": {
            title: "修复配置失败",
            trigger: "配置校验失败并报错",
            procedure: "先检查配置项，再重试任务",
            verification: "重试后无同类错误",
            boundary: "仅适用于配置缺失类失败",
            experience_type: "repair_instruction",
            decision_guidance: { prefer: ["先校验输入"], avoid: ["直接盲重试"] },
            support_trace_ids: ["tr_sink"],
          },
        },
      }),
      log: rootLogger,
      config: cfg(),
      thresholds: { minSupport: 3, minGain: 0.15, archiveGain: -0.05 },
    });

    rewardBus.emit({
      kind: "reward.updated",
      result: fakeRewardResult("ep_sink", ["tr_sink"]),
    } as RewardEvent);
    await sub.drain();

    const rows = handle.repos.policies.list({ limit: 20 });
    const sinkRow = rows.find((p) => p.sourceEpisodeIds.includes("ep_sink" as TraceRow["episodeId"]));
    expect(sinkRow).toBeTruthy();
    expect(sinkRow?.gain).toBeCloseTo(0.02, 5);
    expect(sinkRow?.sourceFeedbackIds).toContain("f:sink:ep_sink");
    expect(sinkRow?.inducedBy).toContain("failure.experience.sink");
    sub.detach();
  });

  it("skips failure sink write when decision guidance is empty", async () => {
    seedTrace(handle, "tr_sink_empty", "ep_sink_empty", "app error: bad config");
    handle.repos.episodes.setOutcome("ep_sink_empty" as TraceRow["episodeId"], "failure");
    handle.repos.episodes.setVerifierPassed("ep_sink_empty" as TraceRow["episodeId"], false);

    const rewardBus = createRewardEventBus();
    const l2Bus = createL2EventBus();
    const sub = attachL2Subscriber({
      db: handle.db,
      repos: handle.repos,
      rewardBus,
      l2Bus,
      llm: fakeLlm({
        completeJson: {
          "l2.failure.experience.sink.v2": {
            title: "空指导",
            trigger: "触发",
            procedure: "步骤",
            verification: "验证",
            boundary: "",
            experience_type: "repair_instruction",
            decision_guidance: { prefer: [], avoid: [] },
            support_trace_ids: ["tr_sink_empty"],
          },
        },
      }),
      log: rootLogger,
      config: cfg(),
      thresholds: { minSupport: 3, minGain: 0.15, archiveGain: -0.05 },
    });

    rewardBus.emit({
      kind: "reward.updated",
      result: fakeRewardResult("ep_sink_empty", ["tr_sink_empty"]),
    } as RewardEvent);
    await sub.drain();

    const rows = handle.repos.policies.list({ limit: 50 });
    const sinkRow = rows.find((p) => p.sourceEpisodeIds.includes("ep_sink_empty" as TraceRow["episodeId"]));
    expect(sinkRow).toBeFalsy();
    sub.detach();
  });

  it("treats empty feedback rows as non-corrective and still runs failure sink", async () => {
    seedTrace(handle, "tr_f_empty", "ep_f_empty");
    handle.repos.episodes.setOutcome("ep_f_empty" as TraceRow["episodeId"], "failure");
    handle.repos.episodes.setVerifierPassed("ep_f_empty" as TraceRow["episodeId"], false);
    const feedback: FeedbackRow = {
      id: "fb_ep_f_empty" as FeedbackRow["id"],
      ownerAgentKind: "openclaw",
      ownerProfileId: "default",
      ownerWorkspaceId: null,
      ts: NOW as FeedbackRow["ts"],
      episodeId: "ep_f_empty" as FeedbackRow["episodeId"],
      traceId: "tr_f_empty" as FeedbackRow["traceId"],
      channel: "explicit",
      polarity: "negative",
      magnitude: 1,
      rationale: null,
      raw: {},
    };
    handle.repos.feedback.insert(feedback);

    const rewardBus = createRewardEventBus();
    const l2Bus = createL2EventBus();
    const sub = attachL2Subscriber({
      db: handle.db,
      repos: handle.repos,
      rewardBus,
      l2Bus,
      llm: fakeLlm({
        completeJson: {
          "l2.failure.experience.sink.v2": {
            title: "修复空反馈失败",
            trigger: "失败触发",
            procedure: "先检查输入",
            verification: "复测",
            boundary: "",
            experience_type: "repair_instruction",
            decision_guidance: { prefer: ["检查输入"], avoid: ["盲重试"] },
            support_trace_ids: ["tr_f_empty"],
          },
        },
      }),
      log: rootLogger,
      config: cfg(),
      thresholds: { minSupport: 3, minGain: 0.15, archiveGain: -0.05 },
    });

    rewardBus.emit({
      kind: "reward.updated",
      result: fakeRewardResult("ep_f_empty", ["tr_f_empty"]),
    } as RewardEvent);
    await sub.drain();

    const rows = handle.repos.policies.list({ limit: 50 });
    const sinkRow = rows.find((p) => p.sourceEpisodeIds.includes("ep_f_empty" as TraceRow["episodeId"]));
    expect(sinkRow).toBeTruthy();
    sub.detach();
  });

  it("promotes injected viewed candidate on success", async () => {
    ensureEpisode(handle, "ep_settle", "s_sub");
    handle.repos.episodes.setOutcome("ep_settle" as TraceRow["episodeId"], "success");
    const policy: PolicyRow = {
      id: "po_injected" as PolicyRow["id"],
      ownerAgentKind: "openclaw",
      ownerProfileId: "default",
      ownerWorkspaceId: null,
      title: "t",
      trigger: "trigger",
      procedure: "proc",
      verification: "verify",
      boundary: "",
      support: 1,
      gain: 0,
      status: "candidate",
      sourceEpisodeIds: [],
      inducedBy: "feedback.experience.v1",
      decisionGuidance: { preference: [], antiPattern: [] },
      createdAt: NOW,
      updatedAt: NOW,
      vec: null,
    };
    handle.repos.policies.insert(policy);
    handle.repos.episodePolicyInjections.inject({
      episodeId: "ep_settle" as TraceRow["episodeId"],
      policyId: "po_injected" as PolicyRow["id"],
      now: NOW,
    });
    const trace: TraceRow = {
      ...seedTrace(handle, "tr_settle", "ep_settle"),
      toolCalls: [
        {
          name: "memos_get",
          input: { kind: "policy", id: "po_injected" },
          output: "{}",
          startedAt: NOW,
          endedAt: NOW,
        },
      ],
    };
    handle.repos.traces.upsert(trace);

    const rewardBus = createRewardEventBus();
    const l2Bus = createL2EventBus();
    const sub = attachL2Subscriber({
      db: handle.db,
      repos: handle.repos,
      rewardBus,
      l2Bus,
      llm: null,
      log: rootLogger,
      config: cfg(),
      thresholds: { minSupport: 3, minGain: 0.15, archiveGain: -0.05 },
    });
    rewardBus.emit({
      kind: "reward.updated",
      result: fakeRewardResult("ep_settle", ["tr_settle"]),
    } as RewardEvent);
    await sub.drain();

    const updated = handle.repos.policies.getById("po_injected" as PolicyRow["id"]);
    expect(updated?.status).toBe("active");
    sub.detach();
  });

  it("degrades viewed active policy on repeated failure", async () => {
    ensureEpisode(handle, "ep_degrade", "s_sub");
    handle.repos.episodes.setOutcome("ep_degrade" as TraceRow["episodeId"], "failure");
    handle.repos.policies.insert({
      id: "po_degrade" as PolicyRow["id"],
      ownerAgentKind: "openclaw",
      ownerProfileId: "default",
      ownerWorkspaceId: null,
      title: "d",
      trigger: "trigger",
      procedure: "proc",
      verification: "verify",
      boundary: "",
      support: 3,
      gain: 0.3,
      status: "active",
      sourceEpisodeIds: [],
      inducedBy: "feedback.experience.v1",
      decisionGuidance: { preference: [], antiPattern: ["不要重试"] },
      verifierMeta: { degradeFailStreak: 1 },
      createdAt: NOW,
      updatedAt: NOW,
      vec: null,
    });
    handle.repos.episodePolicyInjections.inject({
      episodeId: "ep_degrade" as TraceRow["episodeId"],
      policyId: "po_degrade" as PolicyRow["id"],
      now: NOW,
    });
    const trace = seedTrace(handle, "tr_degrade", "ep_degrade");
    trace.toolCalls = [{
      name: "memos_get",
      input: { kind: "policy", id: "po_degrade" },
      output: "{}",
      startedAt: NOW,
      endedAt: NOW,
    }];
    handle.repos.traces.upsert(trace);

    const rewardBus = createRewardEventBus();
    const l2Bus = createL2EventBus();
    const sub = attachL2Subscriber({
      db: handle.db,
      repos: handle.repos,
      rewardBus,
      l2Bus,
      llm: null,
      log: rootLogger,
      config: cfg(),
      thresholds: { minSupport: 3, minGain: 0.15, archiveGain: -0.05 },
    });
    rewardBus.emit({
      kind: "reward.updated",
      result: fakeRewardResult("ep_degrade", ["tr_degrade"]),
    } as RewardEvent);
    await sub.drain();

    const updated = handle.repos.policies.getById("po_degrade" as PolicyRow["id"]);
    expect(updated?.status).toBe("candidate");
    expect((updated?.verifierMeta as { degradeFailStreak?: number } | null)?.degradeFailStreak).toBe(2);
    sub.detach();
  });

  it("refreshes candidate gain with K=50 truncation on success", async () => {
    ensureEpisode(handle, "ep_gain", "s_sub");
    handle.repos.episodes.setOutcome("ep_gain" as TraceRow["episodeId"], "success");
    handle.repos.policies.insert({
      id: "po_anchor" as PolicyRow["id"],
      ownerAgentKind: "openclaw",
      ownerProfileId: "default",
      ownerWorkspaceId: null,
      title: "anchor",
      trigger: "t",
      procedure: "p",
      verification: "v",
      boundary: "",
      support: 30,
      gain: 0.1,
      status: "active",
      mergeFamily: "failure_corrective",
      sourceEpisodeIds: [],
      inducedBy: "feedback.experience.v1",
      decisionGuidance: { preference: [], antiPattern: [] },
      createdAt: NOW,
      updatedAt: NOW,
      vec: null,
    });
    handle.repos.episodePolicyInjections.inject({
      episodeId: "ep_gain" as TraceRow["episodeId"],
      policyId: "po_anchor" as PolicyRow["id"],
      now: NOW,
    });
    handle.repos.policies.insert({
      id: "po_target" as PolicyRow["id"],
      ownerAgentKind: "openclaw",
      ownerProfileId: "default",
      ownerWorkspaceId: null,
      title: "target",
      trigger: "t",
      procedure: "p",
      verification: "v",
      boundary: "",
      support: 25,
      gain: 0.2,
      status: "candidate",
      mergeFamily: "failure_corrective",
      evidencePolarity: "negative",
      sourceEpisodeIds: [],
      inducedBy: "feedback.experience.v1",
      decisionGuidance: { preference: [], antiPattern: ["x"] },
      createdAt: NOW,
      updatedAt: NOW,
      vec: null,
    });
    const trace = seedTrace(handle, "tr_gain", "ep_gain");
    trace.toolCalls = [{
      name: "memos_get",
      input: { kind: "policy", id: "po_anchor" },
      output: "{}",
      startedAt: NOW,
      endedAt: NOW,
    }];
    handle.repos.traces.upsert(trace);

    const rewardBus = createRewardEventBus();
    const l2Bus = createL2EventBus();
    const sub = attachL2Subscriber({
      db: handle.db,
      repos: handle.repos,
      rewardBus,
      l2Bus,
      llm: null,
      log: rootLogger,
      config: cfg(),
      thresholds: { minSupport: 3, minGain: 0.15, archiveGain: -0.05 },
    });

    rewardBus.emit({
      kind: "reward.updated",
      result: fakeRewardResult("ep_gain", ["tr_gain"]),
    } as RewardEvent);
    await sub.drain();
    const first = handle.repos.policies.getById("po_target" as PolicyRow["id"]);
    expect(first?.gain).toBeCloseTo(0.22, 5);

    rewardBus.emit({
      kind: "reward.updated",
      result: fakeRewardResult("ep_gain", ["tr_gain"]),
    } as RewardEvent);
    await sub.drain();
    const second = handle.repos.policies.getById("po_target" as PolicyRow["id"]);
    expect(second?.gain).toBeCloseTo(0.22, 5);
    sub.detach();
  });

  it("runOnce respects failure routing and writes sink policy", async () => {
    seedTrace(handle, "tr_once_failure", "ep_once_failure", "bad config");
    handle.repos.episodes.setOutcome("ep_once_failure" as TraceRow["episodeId"], "failure");
    handle.repos.episodes.setVerifierPassed("ep_once_failure" as TraceRow["episodeId"], false);

    const rewardBus = createRewardEventBus();
    const l2Bus = createL2EventBus();
    const sub = attachL2Subscriber({
      db: handle.db,
      repos: handle.repos,
      rewardBus,
      l2Bus,
      llm: fakeLlm({
        completeJson: {
          "l2.failure.experience.sink.v2": {
            title: "runOnce sink",
            trigger: "失败触发",
            procedure: "检查配置",
            verification: "重试成功",
            boundary: "",
            experience_type: "repair_instruction",
            decision_guidance: { prefer: ["检查配置"], avoid: ["直接重试"] },
            support_trace_ids: ["tr_once_failure"],
          },
        },
      }),
      log: rootLogger,
      config: cfg(),
      thresholds: { minSupport: 3, minGain: 0.15, archiveGain: -0.05 },
    });

    await sub.runOnce("ep_once_failure" as TraceRow["episodeId"]);
    const rows = handle.repos.policies.list({ limit: 50 });
    const sinkRow = rows.find((p) => p.sourceEpisodeIds.includes("ep_once_failure" as TraceRow["episodeId"]));
    expect(sinkRow).toBeTruthy();
    sub.detach();
  });
});
