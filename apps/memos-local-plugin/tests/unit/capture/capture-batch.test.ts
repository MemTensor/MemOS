/**
 * Capture pipeline — windowed binary reflection/alpha path.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createCaptureRunner, type CaptureRunner } from "../../../core/capture/capture.js";
import { createCaptureEventBus } from "../../../core/capture/events.js";
import { BATCH_REFLECTION_PROMPT } from "../../../core/llm/prompts/reflection.js";
import type {
  CaptureConfig,
  CaptureEvent,
  CaptureEventBus,
} from "../../../core/capture/types.js";
import { initTestLogger } from "../../../core/logger/index.js";
import {
  adaptEpisodesRepo,
  type EpisodesRepo,
} from "../../../core/session/persistence.js";
import type { EpisodeSnapshot, EpisodeTurn } from "../../../core/session/types.js";
import { retrievalFor } from "../../../core/session/heuristics.js";
import type { EpochMs, EpisodeId, SessionId } from "../../../core/types.js";
import { fakeEmbedder } from "../../helpers/fake-embedder.js";
import { fakeLlm } from "../../helpers/fake-llm.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";

const batchOp = `capture.${BATCH_REFLECTION_PROMPT.id}.v${BATCH_REFLECTION_PROMPT.version}`;

/**
 * Drives both phases of the new capture lifecycle (lite write → reflect
 * patch) so existing tests can keep asserting on the merged result.
 * Mirrors the orchestrator's per-turn → topic-end behaviour.
 */
async function runCapture(
  runner: CaptureRunner,
  ep: EpisodeSnapshot,
  closedBy: "finalized" | "abandoned" = "finalized",
) {
  const lite = await runner.runLite({ episode: ep });
  const reflect = await runner.runReflect({ episode: ep, closedBy });
  return {
    ...reflect,
    traceIds: reflect.traceIds.length > 0 ? reflect.traceIds : lite.traceIds,
    warnings: [...lite.warnings, ...reflect.warnings],
    llmCalls: {
      reflectionSynth:
        (lite.llmCalls.reflectionSynth ?? 0) +
        (reflect.llmCalls.reflectionSynth ?? 0),
      alphaScoring:
        (lite.llmCalls.alphaScoring ?? 0) +
        (reflect.llmCalls.alphaScoring ?? 0),
      batchedReflection:
        (lite.llmCalls.batchedReflection ?? 0) +
        (reflect.llmCalls.batchedReflection ?? 0),
      summarize:
        (lite.llmCalls.summarize ?? 0) + (reflect.llmCalls.summarize ?? 0),
    },
  };
}

function baseConfig(overrides: Partial<CaptureConfig> = {}): CaptureConfig {
  return {
    maxTextChars: 4_000,
    maxToolOutputChars: 2_000,
    embedTraces: false, // off for speed; embeddings tested elsewhere.
    alphaScoring: true,
    synthReflections: true,
    llmConcurrency: 2,
    batchMode: "windowed",
    batchThreshold: 12,
    reflectionContextMode: "none",
    longEpisodeReflectMode: "per_step_parallel",
    downstreamStepCount: 3,
    taskContextMaxChars: 800,
    downstreamContextMaxChars: 1_200,
    downstreamPerStepMaxChars: 400,
    synthOutcomeMaxChars: 600,
    ...overrides,
  };
}

function turn(
  role: EpisodeTurn["role"],
  content: string,
  ts: number,
  meta: Record<string, unknown> = {},
): EpisodeTurn {
  return { id: `t_${ts}`, role, content, ts, meta };
}

function episodeSnapshot(opts: {
  id: string;
  sessionId: string;
  turns: EpisodeTurn[];
}): EpisodeSnapshot {
  return {
    id: opts.id as EpisodeId,
    sessionId: opts.sessionId as SessionId,
    startedAt: (opts.turns[0]?.ts ?? 1_000) as EpochMs,
    endedAt: (opts.turns[opts.turns.length - 1]?.ts ?? 1_000) as EpochMs,
    status: "closed",
    rTask: null,
    turnCount: opts.turns.length,
    turns: opts.turns,
    traceIds: [],
    meta: {},
    intent: {
      kind: "task",
      confidence: 1,
      reason: "t",
      retrieval: retrievalFor("task"),
      signals: [],
    },
  };
}

describe("capture/pipeline (windowed binary path)", () => {
  beforeAll(() => initTestLogger());

  let tmp: TmpDbHandle;
  let episodesRepo: EpisodesRepo;
  let bus: CaptureEventBus;
  let seen: CaptureEvent[];

  beforeEach(() => {
    tmp = makeTmpDb();
    episodesRepo = adaptEpisodesRepo(tmp.repos.episodes);
    tmp.repos.sessions.upsert({
      id: "se_1",
      agent: "openclaw",
      startedAt: 1_000 as EpochMs,
      lastSeenAt: 2_000 as EpochMs,
      meta: {},
    });
    tmp.repos.episodes.insert({
      id: "ep_1" as EpisodeId,
      sessionId: "se_1" as SessionId,
      startedAt: 1_000 as EpochMs,
      endedAt: 2_000 as EpochMs,
      traceIds: [],
      rTask: null,
      status: "closed",
      meta: {},
    });
    bus = createCaptureEventBus();
    seen = [];
    bus.onAny((e) => seen.push(e));
  });

  afterEach(() => {
    tmp.cleanup();
  });

  function buildRunner(
    overrides: Partial<CaptureConfig> = {},
    llm: ReturnType<typeof fakeLlm> | null = null,
  ): CaptureRunner {
    return createCaptureRunner({
      tracesRepo: tmp.repos.traces,
      episodesRepo,
      embedder: fakeEmbedder({ dimensions: 8 }),
      llm,
      reflectLlm: llm,
      bus,
      cfg: baseConfig(overrides),
    });
  }

  it("single window writes tri-valued reflections and social fallback", async () => {
    const llm = fakeLlm({
      completeJson: {
        [batchOp]: {
          scores: [
            { idx: 0, relevance: "RELATED", reason: "ON_PATH" },
            { idx: 1, relevance: "IRRELEVANT", reason: "DETOUR" },
            { idx: 2, relevance: "PIVOTAL", reason: "TURNING_POINT" },
          ],
        },
      },
    });
    const runner = buildRunner({}, llm);

    const ep = episodeSnapshot({
      id: "ep_1",
      sessionId: "se_1",
      turns: [
        turn("user", "list files", 1_000),
        turn("assistant", "ok", 1_100),
        turn("user", "narrow it to src", 1_200),
        turn("assistant", "done", 1_300),
        turn("user", "thanks", 1_400),
        turn("assistant", "you're welcome", 1_500),
      ],
    });

    const result = await runCapture(runner, ep);

    expect(result.traceIds).toHaveLength(3);
    expect(result.llmCalls.batchedReflection).toBe(1);
    expect(result.llmCalls.reflectionSynth).toBe(0);
    expect(result.llmCalls.alphaScoring).toBe(0);

    const rows = result.traceIds.map((id) => tmp.repos.traces.getById(id)!);
    expect(rows[0]!.reflection).toBe("RELATED");
    expect(rows[0]!.alpha).toBe(0.5);
    expect(rows[1]!.reflection).toBe("IRRELEVANT");
    expect(rows[1]!.alpha).toBe(0);
    expect(rows[2]!.reflection).toBe("IRRELEVANT");
    expect(rows[2]!.alpha).toBe(0);
  });

  it("window overlap conflict uses alpha=1 override", async () => {
    const llm = fakeLlm({
      completeJson: {
        [batchOp]: (input) => {
          const messages = input as Array<{ role: string; content: string }>;
          const payload = JSON.parse(messages.find((m) => m.role === "user")!.content) as {
            steps: Array<{ idx: number }>;
          };
          if (payload.steps.length === 20) {
            return { scores: payload.steps.map((s) => ({ idx: s.idx, relevance: "IRRELEVANT", reason: "DETOUR" })) };
          }
          return { scores: payload.steps.map((s) => ({ idx: s.idx, relevance: "PIVOTAL", reason: "RECOVERY" })) };
        },
      },
    });
    const runner = buildRunner({}, llm);
    const turns: EpisodeTurn[] = [];
    for (let i = 0; i < 21; i++) {
      turns.push(turn("user", `q${i}`, 1_000 + i * 10));
      turns.push(turn("assistant", `a${i}`, 1_005 + i * 10));
    }
    const result = await runCapture(runner, episodeSnapshot({ id: "ep_1", sessionId: "se_1", turns }));
    expect(result.llmCalls.batchedReflection).toBe(2);
    const rows = result.traceIds.map((id) => tmp.repos.traces.getById(id)!);
    // idx 17..19 are overlap, should be upgraded to PIVOTAL (alpha=1).
    expect(rows[17]!.alpha).toBe(1);
    expect(rows[18]!.alpha).toBe(1);
    expect(rows[19]!.alpha).toBe(1);
  });

  it("all retries failed => episode fallback RELATED_DEFAULT + alpha=0.5", async () => {
    const llm = fakeLlm({
      completeJson: {},
    });
    const runner = buildRunner({}, llm);

    const ep = episodeSnapshot({
      id: "ep_1",
      sessionId: "se_1",
      turns: [turn("user", "do x", 1_000), turn("assistant", "done", 1_100)],
    });

    const result = await runCapture(runner, ep);
    const t = tmp.repos.traces.getById(result.traceIds[0]!)!;
    expect(t.reflection).toBe("RELATED_DEFAULT");
    expect(t.alpha).toBe(0.5);
    expect(result.warnings.some((w) => w.message.includes("force RELATED_DEFAULT"))).toBe(true);
  });

  it("degraded pass uses 9-size windows after primary fail", async () => {
    const llm = fakeLlm({
      completeJson: {
        [batchOp]: (input) => {
          const messages = input as Array<{ role: string; content: string }>;
          const payload = JSON.parse(messages.find((m) => m.role === "user")!.content) as {
            steps: Array<{ idx: number }>;
          };
          if (payload.steps.length === 20) throw new Error("fail primary window");
          return { scores: payload.steps.map((s) => ({ idx: s.idx, relevance: "RELATED", reason: "ON_PATH" })) };
        },
      },
    });
    const runner = buildRunner({}, llm);

    const ep = episodeSnapshot({
      id: "ep_1",
      sessionId: "se_1",
      turns: Array.from({ length: 25 }).flatMap((_, i) => [
        turn("user", `u${i}`, 1_000 + i * 20),
        turn("assistant", `a${i}`, 1_010 + i * 20),
      ]),
    });
    const result = await runCapture(runner, ep);
    expect(result.warnings.some((w) => w.message.includes("degrading to smaller windows"))).toBe(true);
    expect(result.traceIds).toHaveLength(25);
    expect(result.traceIds.every((id) => tmp.repos.traces.getById(id)!.alpha === 0.5)).toBe(true);
  });
  it("no LLM available => directly fallback to RELATED_DEFAULT", async () => {
    const runner = buildRunner({ alphaScoring: false }, null);
    const ep = episodeSnapshot({
      id: "ep_1",
      sessionId: "se_1",
      turns: [turn("user", "a", 1_000), turn("assistant", "b", 1_100)],
    });
    const result = await runCapture(runner, ep);
    expect(result.traceIds).toHaveLength(1);
    const t = tmp.repos.traces.getById(result.traceIds[0]!)!;
    expect(t.reflection).toBe("RELATED_DEFAULT");
    expect(t.alpha).toBe(0.5);
  });
});
