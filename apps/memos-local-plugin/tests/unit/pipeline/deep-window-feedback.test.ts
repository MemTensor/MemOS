import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FeedbackDTO } from "../../../agent-contract/dto.js";
import type { MemoryCore } from "../../../agent-contract/memory-core.js";
import { BATCH_OP_TAG } from "../../../core/capture/batch-scorer.js";
import { DEFAULT_CONFIG } from "../../../core/config/defaults.js";
import { resolveHome } from "../../../core/config/paths.js";
import { L3_ABSTRACTION_PROMPT } from "../../../core/llm/prompts/l3-abstraction.js";
import { REWARD_R_HUMAN_PROMPT } from "../../../core/llm/prompts/reward.js";
import { initTestLogger } from "../../../core/logger/index.js";
import { createMemoryCore, createPipeline, type PipelineHandle } from "../../../core/pipeline/index.js";
import { DEEP_PROCESSING_QUEUE_KEY } from "../../../core/pipeline/deep-window.js";
import { FEEDBACK_EVOLUTION_QUEUE_KEY, type FeedbackEvolutionJob } from "../../../core/pipeline/feedback-evolution.js";
import type { EpisodeId, TraceId } from "../../../core/types.js";
import { fakeEmbedder } from "../../helpers/fake-embedder.js";
import { fakeLlm } from "../../helpers/fake-llm.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";
import { seedPolicy } from "../memory/l3/_helpers.js";
import { makeDraft } from "../skill/_helpers.js";

let db: TmpDbHandle;
let pipeline: PipelineHandle;
let core: MemoryCore;
let now: number;
let timers: Array<{ callback: () => void; delay: number }>;

const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));
const l3Op = `${L3_ABSTRACTION_PROMPT.id}.v${L3_ABSTRACTION_PROMPT.version}`;
const rewardOp = `reward.${REWARD_R_HUMAN_PROMPT.id}.v${REWARD_R_HUMAN_PROMPT.version}`;

beforeEach(() => {
  initTestLogger();
  now = Date.parse("2026-09-05T14:00:00Z");
  vi.spyOn(Date, "now").mockImplementation(() => now);
  timers = [];
  vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, delay: number) => {
    timers.push({ callback, delay });
    return { unref() {} } as ReturnType<typeof setInterval>;
  }) as typeof setInterval);
  db = makeTmpDb();
});

afterEach(async () => {
  vi.useRealTimers();
  await core?.shutdown();
  db.cleanup();
  vi.restoreAllMocks();
});

function build(
  mode: "always" | "window" = "window",
  options: { drainIntervalSec?: number; failedOps?: Set<string> } = {},
): void {
  const config = structuredClone(DEFAULT_CONFIG);
  config.algorithm.lightweightMemory.enabled = false;
  config.algorithm.deepProcessing = {
    mode, window: "02:00-06:00", timezone: "UTC",
    drainIntervalSec: options.drainIntervalSec ?? 3600, maxBatchPerCycle: 1,
  };
  pipeline = createPipeline({
    agent: "openclaw", home: resolveHome("openclaw", db.dir), config,
    db: db.db, repos: db.repos,
    llm: fakeLlm({
      completeJson: {
        [rewardOp]: { goal_achievement: 1, process_quality: 1, user_satisfaction: 1, reason: "Accepted solution." },
        [BATCH_OP_TAG]: { scores: [{ idx: 0, reflection_text: "Install system libraries before pip.", alpha: 0.8, usable: true, reason: "Reusable dependency recovery." }] },
        [l3Op]: () => {
          if (options.failedOps?.has(l3Op)) throw new Error("temporary provider failure");
          return {
            title: "Alpine dependency recovery",
            domain_tags: ["alpine", "pip"],
            environment: [{ label: "Alpine", description: "Compiled wheels require system libraries." }],
            inference: [], constraints: [], body: "Install system libraries before retrying pip.",
            confidence: 0.8, supersedes_world_ids: [],
          };
        },
        "skill.crystallize": () => {
          if (options.failedOps?.has("skill.crystallize")) throw new Error("temporary provider failure");
          return makeDraft();
        },
      },
    }),
    reflectLlm: null, embedder: fakeEmbedder({ dimensions: 384 }), now: () => now,
    namespace: { agentKind: "openclaw", profileId: "main" },
  });
  core = createMemoryCore(pipeline, resolveHome("openclaw", db.dir), "test");
}

function seed(suffix = "1", status: "open" | "closed" = "closed"): { episodeId: EpisodeId; traceId: TraceId } {
  const owner = { ownerAgentKind: "openclaw" as const, ownerProfileId: "main", ownerWorkspaceId: null };
  const episodeId = `ep_feedback_window_${suffix}` as EpisodeId;
  const sessionId = `se_feedback_window_${suffix}`;
  const traceId = `tr_feedback_window_${suffix}` as TraceId;
  db.repos.sessions.upsert({ id: sessionId, agent: "openclaw", ...owner, startedAt: now - 2000, lastSeenAt: now, meta: {} });
  db.repos.episodes.insert({
    id: episodeId, sessionId, ...owner, startedAt: now - 2000, endedAt: status === "closed" ? now : null,
    traceIds: [traceId], rTask: null, status, meta: { closeReason: "finalized" },
  });
  db.repos.traces.insert({
    id: traceId, episodeId, sessionId, ...owner, ts: now - 1000, turnId: now - 2000,
    userText: "How do I fix pip install cryptography failing on an Alpine Linux container?",
    agentText: "Install openssl-dev and libffi-dev with apk, then retry pip install cryptography.",
    toolCalls: [], reflection: "Install system libraries before pip.", alpha: 0.8, value: 0.8, rHuman: null,
    priority: 0, tags: ["alpine", "pip"], vecSummary: null, vecAction: null, schemaVersion: 1,
  });
  seedPolicy(db, { sourceEpisodeIds: [episodeId] });
  return { episodeId, traceId };
}

function submit(target: ReturnType<typeof seed>): Promise<FeedbackDTO> {
  return core.submitFeedback({ ...target, channel: "explicit", polarity: "positive", magnitude: 1 });
}

async function settle(): Promise<void> {
  await nextTick();
  await pipeline.flush();
  await nextTick();
}

function fire(source: "queue" | "scan" = "queue"): void {
  timers.findLast((timer) => timer.delay === (source === "queue" ? 60_000 : 600_000))!.callback();
}

function pendingFeedback(): FeedbackEvolutionJob[] {
  return db.repos.kv.get(FEEDBACK_EVOLUTION_QUEUE_KEY, []);
}

describe("feedback with a deep-processing window", () => {
  it.each(["always", "window"] as const)("returns explicit feedback during the day (%s)", async (mode) => {
    build(mode);
    await core.init();
    const target = seed();
    const call = vi.spyOn(pipeline.llm!, "completeJson");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let returned = false;
    const feedback = submit(target).then((value) => { returned = true; return value; });
    await nextTick();
    await nextTick();
    const returnedDuringDaytime = returned;
    const daytimeOps = call.mock.calls.map(([, opts]) => opts?.op);
    // Release the old implementation's overnight waits before asserting.
    now = Date.parse("2026-09-06T03:00:00Z");
    await vi.advanceTimersByTimeAsync(60_000);
    const saved = await feedback;
    expect(returnedDuringDaytime).toBe(true);
    expect(db.repos.feedback.getById(saved.id)).not.toBeNull();
    expect(db.repos.episodes.getById(target.episodeId)?.rTask).toBe(1);
    expect(db.repos.traces.getById(target.traceId)?.rHuman).toBe(1);
    if (mode === "window") expect(daytimeOps).toEqual([rewardOp]);
    else expect(db.repos.worldModel.list()).toHaveLength(1);
  });

  it.each(["window", "always"] as const)("recovers scored feedback after restarting in %s mode", async (mode) => {
    build();
    await core.init();
    const target = seed();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let returned = false;
    const feedback = submit(target).then(() => { returned = true; });
    await nextTick();
    await nextTick();
    const returnedDuringDaytime = returned;
    if (!returned) {
      now = Date.parse("2026-09-06T03:00:00Z");
      await vi.advanceTimersByTimeAsync(60_000);
    }
    await feedback;
    expect(returnedDuringDaytime).toBe(true);
    expect(db.repos.worldModel.list()).toHaveLength(0);
    await core.shutdown();
    // The feedback obligation must survive independently of the capture queue
    // and of reward coverage, which was already complete before shutdown.
    db.repos.kv.set(DEEP_PROCESSING_QUEUE_KEY, []);
    build(mode);
    now = Date.parse("2026-09-06T03:00:00Z");
    await core.init();
    await core.waitForStartupRecovery?.();
    await settle();
    expect(db.repos.worldModel.list()).toHaveLength(1);
    expect(db.repos.skills.list()).toHaveLength(1);
    const calls = pipeline.llm!.stats().requests;
    now += 600_000;
    fire("scan");
    await settle();
    expect(pipeline.llm!.stats().requests).toBe(calls);
  });

  it("does not await another episode's L2 drain while accepting feedback", async () => {
    build();
    await core.init();
    const target = seed();
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    const drain = vi.spyOn(pipeline.l2, "drain").mockReturnValue(blocked);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let returned = false;
    const feedback = submit(target).then(() => { returned = true; });
    await nextTick();
    await nextTick();
    const returnedDuringDaytime = returned;
    try {
      finish();
      now = Date.parse("2026-09-06T03:00:00Z");
      await vi.advanceTimersByTimeAsync(60_000);
      await feedback;
      expect(returnedDuringDaytime).toBe(true);
    } finally {
      finish();
      drain.mockRestore();
    }
  });

  it("returns when the window closes during immediate feedback scoring", async () => {
    build();
    await core.init();
    const target = seed();
    now = Date.parse("2026-09-06T05:59:59Z");
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    const run = pipeline.rewardRunner.run;
    vi.spyOn(pipeline.rewardRunner, "run").mockImplementation(async (input) => {
      await blocked;
      return run(input);
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let returned = false;
    const feedback = submit(target).then(() => { returned = true; });
    now += 2000;
    finish();
    await nextTick();
    await nextTick();
    const returnedAfterClosing = returned;
    now = Date.parse("2026-09-07T03:00:00Z");
    await vi.advanceTimersByTimeAsync(60_000);
    await feedback;
    expect(returnedAfterClosing).toBe(true);
    expect(db.repos.episodes.getById(target.episodeId)?.rTask).toBe(1);
  });

  it("finishes feedback evolution in the next window while the episode is still open", async () => {
    build();
    await core.init();
    const target = seed("open", "open");
    await submit(target);
    expect(pendingFeedback()).toHaveLength(1);
    expect(db.repos.worldModel.list()).toHaveLength(0);
    now = Date.parse("2026-09-06T03:00:00Z");
    fire();
    await vi.waitFor(() => expect(pendingFeedback()).toHaveLength(0));
    expect(db.repos.worldModel.list()).toHaveLength(1);
    expect(db.repos.skills.list()).toHaveLength(1);
    expect(db.repos.episodes.getById(target.episodeId)?.status).toBe("open");
  });

  it("shares the batch budget with capture work and preserves unreflected obligations", async () => {
    build();
    await core.init();
    const feedbackTarget = seed("feedback");
    const captureTarget = seed("capture");
    db.repos.episodes.updateMeta(captureTarget.episodeId, { deepProcessingPending: true });
    pipeline.deepWindow.enqueue(captureTarget.episodeId, "finalized");
    await submit(feedbackTarget);
    const reflect = vi.spyOn(pipeline.captureRunner, "runReflect");
    now = Date.parse("2026-09-06T03:00:00Z");
    fire();
    await vi.waitFor(() => expect(pendingFeedback()).toHaveLength(0));
    expect(reflect).not.toHaveBeenCalled();
    expect(db.repos.episodes.getById(captureTarget.episodeId)?.meta?.deepProcessingPending).toBe(true);
    now += 600_000;
    fire("scan");
    await settle();
    expect(reflect).not.toHaveBeenCalled();
    now += 3_000_000;
    fire("scan");
    await settle();
    expect(reflect).toHaveBeenCalledTimes(1);
    expect(await reflect.mock.results[0]!.value).toMatchObject({ warnings: [] });
    await vi.waitFor(() => {
      expect(db.repos.episodes.getById(captureTarget.episodeId)?.meta?.deepProcessingPending).not.toBe(true);
    });
  });

  it("serializes newer feedback for an episode and does not acknowledge it with an older job", async () => {
    build();
    await core.init();
    const target = seed();
    const first = await submit(target);
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    const run = pipeline.l3.runOnce;
    const l3 = vi.spyOn(pipeline.l3, "runOnce").mockImplementation(async (input) => {
      await blocked;
      return run(input);
    });
    now = Date.parse("2026-09-06T03:00:00Z");
    fire();
    try {
      await vi.waitFor(() => expect(l3).toHaveBeenCalledTimes(1));
      const second = await submit(target);
      expect(pendingFeedback().map((job) => job.feedbackId)).toEqual([first.id, second.id]);
      now += 3_600_000;
      fire();
      fire("scan");
      await settle();
      expect(l3).toHaveBeenCalledTimes(1);
      finish();
      await vi.waitFor(() => expect(pendingFeedback().map((job) => job.feedbackId)).toEqual([second.id]));
      now += 3_600_000;
      fire();
      await vi.waitFor(() => expect(pendingFeedback()).toHaveLength(0));
      expect(l3).toHaveBeenCalledTimes(2);
    } finally {
      finish();
      await settle();
      l3.mockRestore();
    }
  });

  it("retains an interrupted feedback job and does not touch SQLite after shutdown", async () => {
    build();
    await core.init();
    await submit(seed());
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    const run = pipeline.l3.runOnce;
    const l3 = vi.spyOn(pipeline.l3, "runOnce").mockImplementation(async (input) => {
      const result = await run(input);
      await blocked;
      return result;
    });
    now = Date.parse("2026-09-06T03:00:00Z");
    fire();
    try {
      await vi.waitFor(() => expect(l3).toHaveBeenCalledTimes(1));
      await core.shutdown();
      expect(pendingFeedback()).toHaveLength(1);
      const read = vi.spyOn(db.repos.kv, "get");
      const write = vi.spyOn(db.repos.kv, "set");
      db.db.close();
      finish();
      await nextTick();
      await nextTick();
      expect(read).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    } finally {
      finish();
      await nextTick();
      l3.mockRestore();
    }
  });

  it("records the feedback and its evolution obligation atomically", async () => {
    build();
    await core.init();
    const target = seed();
    const set = db.repos.kv.set;
    const write = vi.spyOn(db.repos.kv, "set").mockImplementation((key, value) => {
      if (key === FEEDBACK_EVOLUTION_QUEUE_KEY) throw new Error("database is locked");
      set(key, value);
    });
    try {
      await expect(submit(target)).rejects.toThrow("database is locked");
      expect(db.repos.feedback.getForEpisode(target.episodeId)).toHaveLength(0);
      expect(db.repos.traces.getById(target.traceId)?.rHuman).toBeNull();
    } finally {
      write.mockRestore();
    }
  });

  it.each([l3Op, "skill.crystallize"])("retries %s failures with backoff instead of acknowledging lost work", async (op) => {
    const failedOps = new Set([op]);
    build("window", { drainIntervalSec: 60, failedOps });
    await core.init();
    await submit(seed());
    now = Date.parse("2026-09-06T03:00:00Z");
    for (let attempts = 1; attempts <= 3; attempts++) {
      fire();
      await vi.waitFor(() => expect(pendingFeedback()[0]?.failedAttempts).toBe(attempts));
      if (attempts < 3) now += 60_000;
    }
    failedOps.clear();
    const requests = pipeline.llm!.stats().requests;
    now += 600_000;
    fire();
    fire("scan");
    await settle();
    expect(pipeline.llm!.stats().requests).toBe(requests);
    now += 3_000_000;
    fire();
    await vi.waitFor(() => expect(pendingFeedback()).toHaveLength(0));
    expect(db.repos.worldModel.list()).toHaveLength(1);
    expect(db.repos.skills.list()).toHaveLength(1);
  });

  it("resumes a feedback job interrupted before foreground preparation finishes", async () => {
    build();
    await core.init();
    const target = seed();
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    const run = pipeline.rewardRunner.run;
    const score = vi.spyOn(pipeline.rewardRunner, "run").mockImplementation(async (input) => {
      const result = await run(input);
      await blocked;
      return result;
    });
    const feedback = submit(target);
    try {
      await nextTick();
      await core.shutdown();
      expect(pendingFeedback()).toEqual([expect.objectContaining({ prepared: false })]);
    } finally {
      finish();
      await feedback;
      score.mockRestore();
    }
    build();
    now = Date.parse("2026-09-06T03:00:00Z");
    await core.init();
    await core.waitForStartupRecovery?.();
    expect(pendingFeedback()).toHaveLength(0);
    expect(db.repos.worldModel.list()).toHaveLength(1);
    expect(db.repos.skills.list()).toHaveLength(1);
  });
});
