/**
 * Capture pipeline — batched reflection+α path (V7 §3.2 batched variant).
 *
 * These tests exercise `algorithm.capture.batchMode = "auto" | "per_episode"`
 * and prove that:
 *   1. one LLM call covers all step's ρ + α (no per-step calls);
 *   2. existing reflections are preserved verbatim;
 *   3. synth-disabled steps stay at α=0 even when the LLM tries to write
 *      one for them;
 *   4. `auto` mode falls back to per-step when stepCount > batchThreshold;
 *   5. a malformed batched response degrades into the per-step path
 *      instead of crashing capture.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createCaptureRunner, type CaptureRunner } from "../../../core/capture/capture.js";
import { createCaptureEventBus } from "../../../core/capture/events.js";
import {
  BATCH_REFLECTION_PROMPT,
  REFLECTION_SCORE_PROMPT,
} from "../../../core/llm/prompts/reflection.js";
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
const alphaOp = `capture.alpha.${REFLECTION_SCORE_PROMPT.id}.v${REFLECTION_SCORE_PROMPT.version}`;

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
    batchMode: "auto",
    batchThreshold: 12,
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

describe("capture/pipeline (batched ρ+α path)", () => {
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

  it("3-step episode → ONE batched LLM call (no per-step alpha/synth)", async () => {
    const llm = fakeLlm({
      completeJson: {
        [batchOp]: {
          scores: [
            {
              idx: 0,
              reflection_text: "I asked for the file list because it was needed.",
              alpha: 0.6,
              usable: true,
              reason: "ok",
            },
            {
              idx: 1,
              reflection_text: "I narrowed the search to the src tree.",
              alpha: 0.7,
              usable: true,
              reason: "good",
            },
            {
              idx: 2,
              reflection_text: "I confirmed the result and stopped.",
              alpha: 0.5,
              usable: true,
              reason: "ok",
            },
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
    expect(rows[0]!.reflection).toContain("file list");
    expect(rows[0]!.alpha).toBeCloseTo(0.6, 5);
    expect(rows[1]!.alpha).toBeCloseTo(0.7, 5);
    expect(rows[2]!.alpha).toBeCloseTo(0.5, 5);
  });

  it("preserves existing adapter-provided reflection verbatim (no rewrite)", async () => {
    const llm = fakeLlm({
      completeJson: {
        // The LLM tries to "improve" the reflection. We must IGNORE that
        // text and copy the adapter-provided one through.
        [batchOp]: {
          scores: [
            {
              idx: 0,
              reflection_text: "LLM-rewritten reflection that should be ignored.",
              alpha: 0.8,
              usable: true,
              reason: "good",
            },
          ],
        },
      },
    });
    const runner = buildRunner({}, llm);

    const ep = episodeSnapshot({
      id: "ep_1",
      sessionId: "se_1",
      turns: [
        turn("user", "do x", 1_000),
        turn("assistant", "done", 1_100, {
          reflection: "I picked the cheapest tool because user said so.",
        }),
      ],
    });

    const result = await runCapture(runner, ep);
    const t = tmp.repos.traces.getById(result.traceIds[0]!)!;
    // Original reflection survives intact.
    expect(t.reflection).toBe("I picked the cheapest tool because user said so.");
    // α is taken from the LLM grading.
    expect(t.alpha).toBeCloseTo(0.8, 5);
    expect(result.llmCalls.batchedReflection).toBe(1);
  });

  it("synthReflections=false discards LLM-written reflections for empty steps", async () => {
    const llm = fakeLlm({
      completeJson: {
        [batchOp]: {
          scores: [
            // LLM tries to invent a reflection; with synth disabled we drop it.
            {
              idx: 0,
              reflection_text: "Fabricated reflection by the LLM.",
              alpha: 0.7,
              usable: true,
              reason: "n/a",
            },
          ],
        },
      },
    });
    const runner = buildRunner({ synthReflections: false }, llm);

    const ep = episodeSnapshot({
      id: "ep_1",
      sessionId: "se_1",
      turns: [
        turn("user", "list files", 1_000),
        turn("assistant", "ok", 1_100), // no reflection pattern
      ],
    });
    const result = await runCapture(runner, ep);
    const t = tmp.repos.traces.getById(result.traceIds[0]!)!;
    expect(t.reflection).toBeNull();
    expect(t.alpha).toBe(0); // V7 disabledScore semantics
  });

  it("auto mode falls back to per-step when stepCount > batchThreshold", async () => {
    const llm = fakeLlm({
      completeJson: {
        // ONLY per-step alpha mock; if batched gets called, the test fails
        // with "no completeJson mock for op=...batch...".
        [alphaOp]: { alpha: 0.5, usable: true, reason: "ok" },
      },
      complete: {
        "capture.reflection.synth": "I made this decision deliberately.",
      },
    });
    const runner = buildRunner({ batchMode: "auto", batchThreshold: 2 }, llm);

    // 3 steps → above threshold → per-step path.
    const ep = episodeSnapshot({
      id: "ep_1",
      sessionId: "se_1",
      turns: [
        turn("user", "a", 1_000),
        turn("assistant", "1", 1_010),
        turn("user", "b", 1_020),
        turn("assistant", "2", 1_030),
        turn("user", "c", 1_040),
        turn("assistant", "3", 1_050),
      ],
    });

    const result = await runCapture(runner, ep);
    expect(result.traceIds).toHaveLength(3);
    expect(result.llmCalls.batchedReflection).toBe(0);
    // 3 synth + 3 alpha calls in per-step mode.
    expect(result.llmCalls.reflectionSynth).toBe(3);
    expect(result.llmCalls.alphaScoring).toBe(3);
  });

  it("per_episode mode batches even when step count is large", async () => {
    const scores = Array.from({ length: 5 }, (_, i) => ({
      idx: i,
      reflection_text: `reflection #${i}`,
      alpha: 0.4,
      usable: true,
      reason: "ok",
    }));
    const llm = fakeLlm({
      completeJson: { [batchOp]: { scores } },
    });
    const runner = buildRunner({ batchMode: "per_episode", batchThreshold: 2 }, llm);

    const turns: EpisodeTurn[] = [];
    for (let i = 0; i < 5; i++) {
      turns.push(turn("user", `q${i}`, 1_000 + i * 100));
      turns.push(turn("assistant", `a${i}`, 1_050 + i * 100));
    }
    const ep = episodeSnapshot({ id: "ep_1", sessionId: "se_1", turns });
    const result = await runCapture(runner, ep);
    expect(result.traceIds).toHaveLength(5);
    expect(result.llmCalls.batchedReflection).toBe(1);
    expect(result.llmCalls.alphaScoring).toBe(0);
  });

  it("malformed batched response → falls back to per-step + emits warning", async () => {
    const llm = fakeLlm({
      completeJson: {
        // Wrong shape: scores has fewer entries than steps. Validator throws,
        // capture catches and falls back to per-step.
        [batchOp]: { scores: [] },
        [alphaOp]: { alpha: 0.5, usable: true, reason: "ok" },
      },
      complete: {
        "capture.reflection.synth": "I responded after thinking it through.",
      },
    });
    const runner = buildRunner({ batchMode: "per_episode" }, llm);

    const ep = episodeSnapshot({
      id: "ep_1",
      sessionId: "se_1",
      turns: [
        turn("user", "do x", 1_000),
        turn("assistant", "done", 1_100),
      ],
    });
    const result = await runCapture(runner, ep);
    expect(result.traceIds).toHaveLength(1);
    expect(result.warnings.some((w) => w.stage === "batch")).toBe(true);
    expect(result.llmCalls.batchedReflection).toBe(0);
    // Per-step fallback ran.
    expect(result.llmCalls.reflectionSynth).toBe(1);
    expect(result.llmCalls.alphaScoring).toBe(1);
  });

  it("usable=false in batched response forces α=0 (V7 eq.5)", async () => {
    const llm = fakeLlm({
      completeJson: {
        [batchOp]: {
          scores: [
            {
              idx: 0,
              reflection_text: "I did things.",
              alpha: 0.9,
              usable: false,
              reason: "tautology",
            },
          ],
        },
      },
    });
    const runner = buildRunner({}, llm);
    const ep = episodeSnapshot({
      id: "ep_1",
      sessionId: "se_1",
      turns: [
        turn("user", "q", 1_000),
        turn(
          "assistant",
          "### Reasoning:\nI executed the obvious action that any agent would, period.",
          1_100,
        ),
      ],
    });
    const result = await runCapture(runner, ep);
    const t = tmp.repos.traces.getById(result.traceIds[0]!)!;
    // Reflection text preserved (came from regex extractor), but α clamped.
    expect(t.reflection).toContain("obvious action");
    expect(t.alpha).toBe(0);
  });

  it("no LLM available → batch dispatch refuses, per-step path runs as today", async () => {
    const runner = buildRunner({ alphaScoring: false }, null);
    const ep = episodeSnapshot({
      id: "ep_1",
      sessionId: "se_1",
      turns: [turn("user", "a", 1_000), turn("assistant", "b", 1_100)],
    });
    const result = await runCapture(runner, ep);
    expect(result.traceIds).toHaveLength(1);
    expect(result.llmCalls.batchedReflection).toBe(0);
    expect(result.llmCalls.reflectionSynth).toBe(0);
    expect(result.llmCalls.alphaScoring).toBe(0);
  });
});
