/**
 * End-to-end Phase 7 test: seeds episodes + traces in a real SQLite DB,
 * runs the reward pipeline, and inspects both trace and episode rows
 * (+ event emissions).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRewardEventBus } from "../../../core/reward/events.js";
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
  seedSession(handle, sid);
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
    userText: "",
    agentText: partial.agentText ?? "",
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
});
