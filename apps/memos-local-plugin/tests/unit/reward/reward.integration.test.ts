/**
 * End-to-end Phase 7 test: seeds episodes + traces in a real SQLite DB,
 * runs the reward pipeline, and inspects both trace and episode rows
 * (+ event emissions).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRewardEventBus } from "../../../core/reward/events.js";
import { contributionGainValues } from "../../../core/reward/gain-value.js";
// Force the contribution-gain batch to throw so
// the persist loop's failure path is exercised. Delegates to the real helper
// unless the flag is set, so every other test in this file is unaffected.
const gainFailure = vi.hoisted(() => ({ fail: false }));
vi.mock("../../../core/reward/gain-value.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../core/reward/gain-value.js")>();
  return {
    ...actual,
    contributionGainValues: (values: readonly number[]) => {
      if (gainFailure.fail) throw new RangeError("injected gain batch failure");
      return actual.contributionGainValues(values);
    },
  };
});import { runGainInference } from "../../../core/reward/gain-inference.js";
import { createRewardRunner } from "../../../core/reward/reward.js";
import type {
  RewardConfig,
  RewardEvent,
  UserFeedback,
} from "../../../core/reward/types.js";
import type {
  EpisodeRow,
  EpochMs,
  FeedbackRow,
  TraceRow,
} from "../../../core/types.js";
import type { EpisodeSnapshot } from "../../../core/session/types.js";
import type { SessionRow } from "../../../core/storage/repos/sessions.js";
import { fakeLlm } from "../../helpers/fake-llm.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";

const NOW = 1_700_000_000_000 as EpochMs;

function cfg(): RewardConfig {
  return {
    gamma: 0.9,
    tauSoftmax: 0.5,
    decayHalfLifeDays: 30,
    llmScoring: true,
    implicitThreshold: 0.2,
    feedbackWindowSec: 0,
    summaryMaxChars: 2000,
    llmConcurrency: 1,
    // Tests exercise minimal fake episodes (often one turn) so we
    // disable the triviality gate; real usage defaults to 2.
    minExchangesForCompletion: 0,
    minContentCharsForCompletion: 0,
    toolHeavyRatio: 0.7,
    minAssistantCharsForToolHeavy: 80,
  };
}

function seedSession(handle: TmpDbHandle, sid: string): void {
  const row: SessionRow = {
    id: sid as unknown as SessionRow["id"],
    agent: "openclaw" as unknown as SessionRow["agent"],
    startedAt: NOW,
    lastSeenAt: NOW,
    meta: {},
  };
  handle.repos.sessions.upsert(row);
}

function seedEpisode(
  handle: TmpDbHandle,
  eid: string,
  sid: string,
  traceIds: string[],
): void {
  // Seed the session once per sid: sessions.upsert is INSERT OR REPLACE, and
  // re-upserting would DELETE the session and cascade-delete every episode/
  // trace that references it.
  if (!handle.repos.sessions.getById(sid as unknown as SessionRow["id"])) {
    seedSession(handle, sid);
  }
  const row: EpisodeRow & { meta: Record<string, unknown> } = {
    id: eid as unknown as EpisodeRow["id"],
    sessionId: sid as unknown as EpisodeRow["sessionId"],
    startedAt: NOW as EpochMs,
    endedAt: NOW as EpochMs,
    status: "closed",
    rTask: null,
    traceIds,
    meta: { userQuery: "deploy my docker image", outcome: "pushed to registry" },
  };
  handle.repos.episodes.insert(row as unknown as Parameters<typeof handle.repos.episodes.insert>[0]);
}

function seedTrace(
  handle: TmpDbHandle,
  id: string,
  eid: string,
  sid: string,
  partial: Partial<TraceRow> = {},
): void {
  const row: TraceRow = {
    id: id as unknown as TraceRow["id"],
    episodeId: eid as unknown as TraceRow["episodeId"],
    sessionId: sid as unknown as TraceRow["sessionId"],
    ts: NOW as EpochMs,
    userText:
      partial.userText ??
      `please deploy my docker image to the registry, verify step ${id}, and report the result`,
    agentText:
      partial.agentText ??
      "completed the requested deployment step and verified the resulting service",
    toolCalls: partial.toolCalls ?? [],
    reflection: partial.reflection ?? null,
    value: 0,
    alpha: (partial.alpha ?? 0) as TraceRow["alpha"],
    rHuman: null,
    priority: 0,
    tags: [],
    vecSummary: null,
    vecAction: null,
    turnId: 0 as never,
    schemaVersion: 1,
  };
  handle.repos.traces.insert(row);
}

function rewardSnapshot(eid: string, sid: string, traceIds: string[] = []): EpisodeSnapshot {
  return {
    id: eid as unknown as EpisodeSnapshot["id"],
    sessionId: sid as unknown as EpisodeSnapshot["sessionId"],
    startedAt: NOW,
    endedAt: NOW,
    status: "closed",
    rTask: null,
    traceIds: traceIds as unknown as EpisodeSnapshot["traceIds"],
    turnCount: 2,
    turns: [
      {
        role: "user",
        content:
          "please review the docker deployment result and explain what went wrong",
        ts: NOW,
        meta: {},
      },
      {
        role: "assistant",
        content:
          "I made the wrong deployment choice and need to retry with corrected settings.",
        ts: NOW,
        meta: {},
      },
    ],
    meta: {},
  };
}

function seedFeedback(
  handle: TmpDbHandle,
  id: string,
  eid: string,
  partial: Partial<FeedbackRow> = {},
): FeedbackRow {
  const row: FeedbackRow = {
    id: id as unknown as FeedbackRow["id"],
    ts: NOW as EpochMs,
    episodeId: eid as unknown as FeedbackRow["episodeId"],
    traceId: null,
    channel: partial.channel ?? "explicit",
    polarity: partial.polarity ?? "positive",
    magnitude: partial.magnitude ?? 0.9,
    rationale: partial.rationale ?? "great work",
    raw: partial.raw ?? { text: "great work" },
  };
  handle.repos.feedback.insert(row);
  return row;
}

function toUserFb(row: FeedbackRow, sid: string): UserFeedback {
  return {
    id: row.id,
    episodeId: row.episodeId as unknown as UserFeedback["episodeId"],
    sessionId: sid as unknown as UserFeedback["sessionId"],
    traceId: row.traceId as unknown as UserFeedback["traceId"],
    ts: row.ts,
    channel: row.channel,
    polarity: row.polarity,
    magnitude: row.magnitude,
    text: (row.raw as { text?: string })?.text ?? row.rationale,
    rationale: row.rationale,
  };
}

describe("reward/integration", () => {
  let handle: TmpDbHandle;
  beforeEach(() => {
    handle = makeTmpDb();
  });
  afterEach(() => {
    handle.cleanup();
  });

  it("writes updated V / priority to traces and r_task on the episode", async () => {
    const sid = "s_int_1";
    const eid = "ep_int_1";
    seedEpisode(handle, eid, sid, ["tr_a", "tr_b", "tr_c"]);
    seedTrace(handle, "tr_a", eid, sid, { alpha: 0.5, agentText: "clone repo" });
    seedTrace(handle, "tr_b", eid, sid, { alpha: 0, agentText: "docker build" });
    seedTrace(handle, "tr_c", eid, sid, { alpha: 0, agentText: "docker push" });

    const fb = toUserFb(seedFeedback(handle, "fb_1", eid, { polarity: "positive" }), sid);

    const bus = createRewardEventBus();
    const events: RewardEvent[] = [];
    bus.onAny((e) => events.push(e));

    const llm = fakeLlm({
      completeJson: {
        "reward.reward.r_human.v3": {
          goal_achievement: 0.9,
          process_quality: 0.7,
          user_satisfaction: 0.8,
          label: "success",
          reason: "image built + pushed",
        },
      },
    });

    const runner = createRewardRunner({
      tracesRepo: handle.repos.traces,
      episodesRepo: handle.repos.episodes,
      feedbackRepo: handle.repos.feedback,
      llm,
      bus,
      cfg: cfg(),
      now: () => NOW,
    });

    const result = await runner.run({
      episodeId: eid as unknown as Parameters<typeof runner.run>[0]["episodeId"],
      feedback: [fb],
      trigger: "explicit_feedback",
    });

    expect(result.rHuman).toBeCloseTo(0.9 * 0.45 + 0.7 * 0.3 + 0.8 * 0.25, 5);
    expect(result.humanScore.source).toBe("llm");
    expect(result.traceIds).toHaveLength(3);
    expect(result.warnings).toEqual([]);

    const tA = handle.repos.traces.getById("tr_a" as unknown as TraceRow["id"])!;
    const tB = handle.repos.traces.getById("tr_b" as unknown as TraceRow["id"])!;
    const tC = handle.repos.traces.getById("tr_c" as unknown as TraceRow["id"])!;
    // V_C = R_human, V_B = γ·V_C, V_A = 0.5·R + 0.5·γ·V_B.
    const r = result.rHuman;
    const vC = r;
    const vB = 0.9 * vC;
    const vA = 0.5 * r + 0.5 * 0.9 * vB;
    expect(tC.value).toBeCloseTo(vC, 5);
    expect(tB.value).toBeCloseTo(vB, 5);
    expect(tA.value).toBeCloseTo(vA, 5);
    // Priority for all three should be positive and ≤ V (decay ≤ 1).
    expect(tC.priority).toBeGreaterThan(0);
    expect(tC.priority).toBeLessThanOrEqual(vC + 1e-9);

    const ep = handle.repos.episodes.getById(eid as unknown as EpisodeRow["id"])!;
    expect(ep.rTask).toBeCloseTo(result.rHuman, 5);
    expect((ep as unknown as { meta: Record<string, unknown> }).meta.reward).toBeDefined();

    // events order: scheduled → scored → updated
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(["reward.scheduled", "reward.scored", "reward.updated"]);
  });

  it("empty feedback list uses implicit fallback (heuristic = 0)", async () => {
    const sid = "s_int_2";
    const eid = "ep_int_2";
    seedEpisode(handle, eid, sid, ["tr_x"]);
    seedTrace(handle, "tr_x", eid, sid, { alpha: 0 });

    const runner = createRewardRunner({
      tracesRepo: handle.repos.traces,
      episodesRepo: handle.repos.episodes,
      feedbackRepo: handle.repos.feedback,
      llm: null,
      bus: createRewardEventBus(),
      cfg: cfg(),
      now: () => NOW,
    });

    const res = await runner.run({
      episodeId: eid as unknown as Parameters<typeof runner.run>[0]["episodeId"],
      feedback: [],
      trigger: "implicit_fallback",
    });
    expect(res.rHuman).toBe(0);
    expect(res.humanScore.source).toBe("heuristic");

    const t = handle.repos.traces.getById("tr_x" as unknown as TraceRow["id"])!;
    expect(t.value).toBe(0);
    expect(t.priority).toBe(0);
  });

  it("treats a triviality skip as terminal and clears an inherited dirty marker", async () => {
    const sid = "s_int_skipped";
    const eid = "ep_int_skipped";
    seedEpisode(handle, eid, sid, ["tr_short"]);
    seedTrace(handle, "tr_short", eid, sid, {
      userText: "我喜欢玩的游戏呢",
      agentText: "你喜欢马里奥。",
    });
    handle.repos.episodes.updateMeta(eid as unknown as EpisodeRow["id"], {
      closeReason: "finalized",
      rewardDirty: {
        failedAttempts: 7,
        lastFailureAt: NOW - 1_000,
      },
    });

    const shortSnapshot: EpisodeSnapshot = {
      ...rewardSnapshot(eid, sid, ["tr_short"]),
      turnCount: 1,
      turns: [
        {
          role: "user",
          content: "我喜欢玩的游戏呢",
          ts: NOW,
          meta: {},
        },
        {
          role: "assistant",
          content: "你喜欢马里奥。",
          ts: NOW,
          meta: {},
        },
      ],
    };
    const runner = createRewardRunner({
      tracesRepo: handle.repos.traces,
      episodesRepo: handle.repos.episodes,
      feedbackRepo: handle.repos.feedback,
      getEpisodeSnapshot: () => shortSnapshot,
      llm: null,
      bus: createRewardEventBus(),
      cfg: {
        ...cfg(),
        minExchangesForCompletion: 2,
        minContentCharsForCompletion: 80,
      },
      now: () => NOW,
    });

    const result = await runner.run({
      episodeId: eid as unknown as Parameters<typeof runner.run>[0]["episodeId"],
      feedback: [],
      trigger: "implicit_fallback",
    });

    expect(result.rHuman).toBe(0);
    const episode = handle.repos.episodes.getById(
      eid as unknown as EpisodeRow["id"],
    )!;
    expect(episode.rTask).toBeNull();
    expect(episode.meta?.reward).toMatchObject({ skipped: true });
    expect(episode.meta?.rewardDirty).toBeUndefined();
  });

  it("episodes with no traces still score R_human but skip backprop", async () => {
    const sid = "s_int_3";
    const eid = "ep_int_3";
    seedEpisode(handle, eid, sid, []);
    const fb = toUserFb(
      seedFeedback(handle, "fb_3", eid, {
        polarity: "negative",
        rationale: "wrong, try again",
        raw: { text: "wrong, try again" },
      }),
      sid,
    );

    const runner = createRewardRunner({
      tracesRepo: handle.repos.traces,
      episodesRepo: handle.repos.episodes,
      feedbackRepo: handle.repos.feedback,
      getEpisodeSnapshot: () => rewardSnapshot(eid, sid),
      llm: null,
      bus: createRewardEventBus(),
      cfg: cfg(),
      now: () => NOW,
    });

    const res = await runner.run({
      episodeId: eid as unknown as Parameters<typeof runner.run>[0]["episodeId"],
      feedback: [fb],
      trigger: "explicit_feedback",
    });
    expect(res.rHuman).toBeLessThan(0);
    expect(res.traceIds).toHaveLength(0);
    const ep = handle.repos.episodes.getById(eid as unknown as EpisodeRow["id"])!;
    expect(ep.rTask).toBeLessThan(0);
  });

  it("throws cleanly when episode is missing", async () => {
    const runner = createRewardRunner({
      tracesRepo: handle.repos.traces,
      episodesRepo: handle.repos.episodes,
      feedbackRepo: handle.repos.feedback,
      llm: null,
      bus: createRewardEventBus(),
      cfg: cfg(),
      now: () => NOW,
    });
    await expect(
      runner.run({
        episodeId: "ep_missing" as unknown as Parameters<typeof runner.run>[0]["episodeId"],
        feedback: [],
        trigger: "manual",
      }),
    ).rejects.toThrow(/episode_not_found|episode not found/);
  });

  it("merges feedback fetched from the repo with the caller-provided list", async () => {
    const sid = "s_int_4";
    const eid = "ep_int_4";
    seedEpisode(handle, eid, sid, ["tr_q"]);
    seedTrace(handle, "tr_q", eid, sid, { alpha: 1 });
    // repo has one explicit row already.
    seedFeedback(handle, "fb_repo", eid, { polarity: "positive" });
    // caller adds a second row with a fresh id.
    const callerFb: UserFeedback = {
      id: "fb_caller" as unknown as UserFeedback["id"],
      episodeId: eid as unknown as UserFeedback["episodeId"],
      sessionId: sid as unknown as UserFeedback["sessionId"],
      traceId: null,
      ts: NOW as EpochMs,
      channel: "explicit",
      polarity: "positive",
      magnitude: 0.9,
      text: "great, thanks!",
      rationale: null,
    };

    const runner = createRewardRunner({
      tracesRepo: handle.repos.traces,
      episodesRepo: handle.repos.episodes,
      feedbackRepo: handle.repos.feedback,
      llm: null,
      bus: createRewardEventBus(),
      cfg: cfg(),
      now: () => NOW,
    });
    const res = await runner.run({
      episodeId: eid as unknown as Parameters<typeof runner.run>[0]["episodeId"],
      feedback: [callerFb],
      trigger: "explicit_feedback",
    });
    expect(res.feedbackCount).toBe(2);
    expect(res.rHuman).toBeGreaterThan(0);
  });

  it("persists gainValue with live_normalized provenance atomically alongside V", async () => {
    const sid = "s_int_gain";
    const eid = "ep_int_gain";
    seedEpisode(handle, eid, sid, ["tr_a", "tr_b", "tr_c"]);
    seedTrace(handle, "tr_a", eid, sid, { alpha: 1, agentText: "clone repo" });
    seedTrace(handle, "tr_b", eid, sid, { alpha: 0, agentText: "docker build" });
    seedTrace(handle, "tr_c", eid, sid, { alpha: 0, agentText: "docker push" });
    seedFeedback(handle, "fb_gain", eid, { polarity: "positive" });

    const runner = createRewardRunner({
      tracesRepo: handle.repos.traces,
      episodesRepo: handle.repos.episodes,
      feedbackRepo: handle.repos.feedback,
      llm: fakeLlm({
        completeJson: {
          "reward.reward.r_human.v3": {
            goal_achievement: 0.9,
            process_quality: 0.7,
            user_satisfaction: 0.8,
            label: "success",
            reason: "image built + pushed",
          },
        },
      }),
      bus: createRewardEventBus(),
      cfg: cfg(),
      outcomeThresholds: { successThreshold: 0.5, failureThreshold: -0.15 },
      now: () => NOW,
    });

    const result = await runner.run({
      episodeId: eid as unknown as Parameters<typeof runner.run>[0]["episodeId"],
      feedback: [],
      trigger: "implicit_fallback",
    });

    const expected = contributionGainValues(result.backprop.updates.map((u) => u.value));
    for (let i = 0; i < result.backprop.updates.length; i++) {
      const u = result.backprop.updates[i]!;
      const row = handle.repos.traces.getById(u.traceId)!;
      // V and gainValue persisted together, with explicit live provenance.
      expect(row.value).toBeCloseTo(u.value, 10);
      expect(row.gainValue).toBeCloseTo(expected[i]!, 10);
      expect(row.gainValueSource).toBe("live_normalized");
      // alpha/priority semantics preserved.
      expect(row.alpha).toBeCloseTo(u.alpha, 10);
      expect(row.priority).toBeCloseTo(u.priority, 10);
      // The result also carries the gain so reward.updated subscribers see it.
      expect(u.gainValue).toBeCloseTo(expected[i]!, 10);
      expect(u.gainValueSource).toBe("live_normalized");
    }
  });

  it("repeat scoring refreshes V and gainValue together", async () => {
    const sid = "s_int_rescore";
    const eid = "ep_int_rescore";
    seedEpisode(handle, eid, sid, ["tr_r"]);
    seedTrace(handle, "tr_r", eid, sid, { alpha: 1 });
    seedFeedback(handle, "fb_r1", eid, { polarity: "positive", rationale: "good" });

    // Scripted scorer: first call scores high, second call scores low.
    let scoreCall = 0;
    const llm = fakeLlm({
      completeJson: {
        "reward.reward.r_human.v3": () => {
          scoreCall += 1;
          if (scoreCall === 1) {
            return {
              goal_achievement: 0.9,
              process_quality: 0.7,
              user_satisfaction: 0.8,
              label: "success",
              reason: "ok",
            };
          }
          return {
            goal_achievement: 0.3,
            process_quality: 0.2,
            user_satisfaction: 0.25,
            label: "success",
            reason: "weaker outcome",
          };
        },
      },
    });
    const runner = createRewardRunner({
      tracesRepo: handle.repos.traces,
      episodesRepo: handle.repos.episodes,
      feedbackRepo: handle.repos.feedback,
      llm,
      bus: createRewardEventBus(),
      cfg: cfg(),
      now: () => NOW,
    });

    await runner.run({
      episodeId: eid as unknown as Parameters<typeof runner.run>[0]["episodeId"],
      feedback: [],
      trigger: "implicit_fallback",
    });
    const first = handle.repos.traces.getById("tr_r" as unknown as TraceRow["id"])!;
    expect(first.gainValueSource).toBe("live_normalized");

    // Second pass with a different reward: V and gain both move.
    const secondResult = await runner.run({
      episodeId: eid as unknown as Parameters<typeof runner.run>[0]["episodeId"],
      feedback: [],
      trigger: "implicit_fallback",
    });
    const second = handle.repos.traces.getById("tr_r" as unknown as TraceRow["id"])!;
    expect(secondResult.rHuman).toBeLessThan(first.rHuman!);
    expect(second.value).toBeCloseTo(secondResult.rHuman, 5);
    // gainValue tracks the rescaled V for the same contributor set.
    expect(second.gainValue).toBeCloseTo(secondResult.rHuman, 5);
    expect(second.gainValueSource).toBe("live_normalized");
    expect(second.gainInferenceVersion).toBe(0);
  });

  it("historical inference cannot overwrite fresh live scores", async () => {
    // Episode A: scored live (gain written with live provenance).
    const sid = "s_int_inf";
    const eidLive = "ep_int_inf_live";
    const eidHist = "ep_int_inf_hist";
    seedEpisode(handle, eidLive, sid, ["tr_live"]);
    seedTrace(handle, "tr_live", eidLive, sid, { alpha: 1 });
    seedFeedback(handle, "fb_inf", eidLive, { polarity: "positive" });

    const runner = createRewardRunner({
      tracesRepo: handle.repos.traces,
      episodesRepo: handle.repos.episodes,
      feedbackRepo: handle.repos.feedback,
      llm: fakeLlm({
        completeJson: {
          "reward.reward.r_human.v3": {
            goal_achievement: 0.9,
            process_quality: 0.7,
            user_satisfaction: 0.8,
            label: "success",
            reason: "ok",
          },
        },
      }),
      bus: createRewardEventBus(),
      cfg: cfg(),
      now: () => NOW,
    });
    const liveResult = await runner.run({
      episodeId: eidLive as unknown as Parameters<typeof runner.run>[0]["episodeId"],
      feedback: [],
      trigger: "implicit_fallback",
    });

    // Episode B: historical (pre-gain) group with the same owner.
    // seedTrace ignores value/rHuman — set them explicitly like a past pass.
    seedEpisode(handle, eidHist, sid, ["tr_hist"]);
    seedTrace(handle, "tr_hist", eidHist, sid, { alpha: 1 });
    handle.repos.traces.updateScore("tr_hist" as unknown as TraceRow["id"], {
      value: 0.9,
      alpha: 1,
      rHuman: 0.9,
      priority: 0.2,
    });

    runGainInference({
      db: handle.db,
      kv: handle.repos.kv,
      episodesRepo: handle.repos.episodes,
      tracesRepo: handle.repos.traces,
      owner: { ownerAgentKind: "unknown", ownerProfileId: "default", ownerWorkspaceId: null },
    });

    const live = handle.repos.traces.getById("tr_live" as unknown as TraceRow["id"])!;
    expect(live.gainValueSource).toBe("live_normalized");
    expect(live.gainValue).toBeCloseTo(liveResult.backprop.updates[0]!.gainValue ?? -1, 10);
    expect(live.gainInferenceVersion).toBe(0);

    const hist = handle.repos.traces.getById("tr_hist" as unknown as TraceRow["id"])!;
    expect(hist.gainValueSource).toBe("inferred_normalized");
    expect(hist.gainValue).toBeCloseTo(0.9, 10);
    expect(hist.gainInferenceVersion).toBe(1);
  });

  it("a failed gain batch omits gain keys so pre-existing live provenance survives", async () => {
    const sid = "s_int_gainfail";
    const eid = "ep_int_gainfail";
    seedEpisode(handle, eid, sid, ["tr_p", "tr_q"]);
    seedTrace(handle, "tr_p", eid, sid, { alpha: 1 });
    seedTrace(handle, "tr_q", eid, sid, { alpha: 1 });
    seedFeedback(handle, "fb_gf", eid, { polarity: "positive" });
    // Pre-existing live provenance from an earlier successful pass (values
    // deliberately distinct from anything the new run would compute).
    handle.repos.traces.updateScore("tr_p" as unknown as TraceRow["id"], {
      value: 0.1,
      alpha: 1,
      rHuman: 0.5,
      priority: 0.05,
      gainValue: 0.42,
      gainValueSource: "live_normalized",
    });
    handle.repos.traces.updateScore("tr_q" as unknown as TraceRow["id"], {
      value: 0.1,
      alpha: 1,
      rHuman: 0.5,
      priority: 0.05,
      gainValue: -0.17,
      gainValueSource: "live_normalized",
    });

    const runner = createRewardRunner({
      tracesRepo: handle.repos.traces,
      episodesRepo: handle.repos.episodes,
      feedbackRepo: handle.repos.feedback,
      llm: fakeLlm({
        completeJson: {
          "reward.reward.r_human.v3": {
            goal_achievement: 0.9,
            process_quality: 0.7,
            user_satisfaction: 0.8,
            label: "success",
            reason: "image built + pushed",
          },
        },
      }),
      bus: createRewardEventBus(),
      cfg: cfg(),
      now: () => NOW,
    });

    gainFailure.fail = true;
    let result: Awaited<ReturnType<typeof runner.run>>;
    try {
      result = await runner.run({
        episodeId: eid as unknown as Parameters<typeof runner.run>[0]["episodeId"],
        feedback: [],
        trigger: "implicit_fallback",
      });
    } finally {
      gainFailure.fail = false;
    }

    // The gain stage warned, but V/alpha still persisted normally.
    expect(result.warnings.some((w) => w.stage === "persist.traces.gain")).toBe(true);
    expect(result.backprop.updates).toHaveLength(2);
    for (const u of result.backprop.updates) {
      const row = handle.repos.traces.getById(u.traceId)!;
      expect(row.value).toBeCloseTo(u.value, 10);
      expect(row.alpha).toBeCloseTo(u.alpha, 10);
      // Gain keys were omitted (not explicit NULLs): prior provenance is
      // untouched on every trace in the failed batch.
      expect(row.gainValueSource).toBe("live_normalized");
      expect(row.gainInferenceVersion).toBe(0);
      // No gain attached to the result for reward.updated subscribers either.
      expect(u.gainValue).toBeUndefined();
      expect(u.gainValueSource).toBeUndefined();
    }
    expect(handle.repos.traces.getById("tr_p" as unknown as TraceRow["id"])!.gainValue)
      .toBeCloseTo(0.42, 10);
    expect(handle.repos.traces.getById("tr_q" as unknown as TraceRow["id"])!.gainValue)
      .toBeCloseTo(-0.17, 10);
  });
});
