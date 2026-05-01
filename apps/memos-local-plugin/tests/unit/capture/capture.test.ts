/**
 * End-to-end capture pipeline tests.
 *
 * Uses a real SQLite via `makeTmpDb`, a fake embedder, and a fake LLM.
 * Exercises the full extract → normalize → reflect → α → embed → insert
 * path and asserts on what we actually persist.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createCaptureEventBus } from "../../../core/capture/events.js";
import { createCaptureRunner, type CaptureRunner } from "../../../core/capture/capture.js";
import type { Embedder } from "../../../core/embedding/types.js";
import { REFLECTION_SCORE_PROMPT } from "../../../core/llm/prompts/reflection.js";
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
import type {
  EpisodeSnapshot,
  EpisodeTurn,
} from "../../../core/session/types.js";
import { retrievalFor } from "../../../core/session/heuristics.js";
import type { EpochMs, EpisodeId, SessionId, TraceId, TraceRow } from "../../../core/types.js";
import { fakeEmbedder } from "../../helpers/fake-embedder.js";
import { fakeLlm } from "../../helpers/fake-llm.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";

const alphaOp = `capture.alpha.${REFLECTION_SCORE_PROMPT.id}.v${REFLECTION_SCORE_PROMPT.version}`;

/**
 * End-to-end test helper: runs the lite-phase capture (which writes
 * the bare trace rows) and then the reflect-phase capture (which patches
 * reflection + α). Mirrors the orchestrator's per-turn → topic-end
 * lifecycle so existing assertions on result.traceIds / persisted rows
 * continue to make sense.
 *
 * Returns the reflect-phase result because that's the one carrying the
 * post-scoring metadata downstream consumers (reward, L2) actually
 * trigger off of.
 */
async function runCapture(
  runner: CaptureRunner,
  ep: EpisodeSnapshot,
  closedBy: "finalized" | "abandoned" = "finalized",
) {
  const lite = await runner.runLite({ episode: ep });
  const reflect = await runner.runReflect({ episode: ep, closedBy });
  // Surface the union so callers can introspect either phase. We mirror
  // legacy `run()` shape by returning reflect (it's the one with the
  // final reflection / α data + emits capture.done).
  return {
    ...reflect,
    // Lite-phase wrote the row ids; reflect-phase patches existing ones
    // and reports them in `traceIds` too. Combine for callers asserting
    // on count.
    traceIds:
      reflect.traceIds.length > 0 ? reflect.traceIds : lite.traceIds,
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
    embedTraces: true,
    alphaScoring: true,
    synthReflections: false,
    llmConcurrency: 2,
    // Default to per-step here so the existing assertions on
    // `llmCalls.alphaScoring`/`reflectionSynth` continue to hold. The
    // batched path has its own dedicated test file.
    batchMode: "per_step",
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

function traceRow(opts: {
  id: string;
  ts: number;
  userText?: string;
  agentText?: string;
  toolCalls?: TraceRow["toolCalls"];
}): TraceRow {
  return {
    id: opts.id as TraceId,
    episodeId: "ep_1" as EpisodeId,
    sessionId: "se_1" as SessionId,
    ts: opts.ts as EpochMs,
    userText: opts.userText ?? "",
    agentText: opts.agentText ?? "",
    summary: null,
    toolCalls: opts.toolCalls ?? [],
    reflection: null,
    agentThinking: null,
    value: 0,
    alpha: 0,
    rHuman: null,
    priority: 0.5,
    tags: [],
    errorSignatures: [],
    vecSummary: null,
    vecAction: null,
    turnId: 1_000 as EpochMs,
    schemaVersion: 1,
  };
}

describe("capture/pipeline (end-to-end)", () => {
  beforeAll(() => initTestLogger());

  let tmp: TmpDbHandle;
  let episodesRepo: EpisodesRepo;
  let bus: CaptureEventBus;
  let seen: CaptureEvent[];

  beforeEach(() => {
    tmp = makeTmpDb();
    episodesRepo = adaptEpisodesRepo(tmp.repos.episodes);
    // Seed a session + episode so traces FK checks pass.
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
    embedder: Embedder | null = fakeEmbedder({ dimensions: 8 }),
  ): CaptureRunner {
    return createCaptureRunner({
      tracesRepo: tmp.repos.traces,
      embeddingRetryQueue: tmp.repos.embeddingRetryQueue,
      episodesRepo,
      embedder,
      llm,
      reflectLlm: llm,
      bus,
      cfg: baseConfig(overrides),
    });
  }

  it("writes one trace per step with α=0 when alpha disabled and no reflection present", async () => {
    const runner = buildRunner({ alphaScoring: false });
    const ep = episodeSnapshot({
      id: "ep_1",
      sessionId: "se_1",
      turns: [turn("user", "say hi", 1_000), turn("assistant", "hi", 1_100)],
    });
    const result = await runCapture(runner, ep);

    expect(result.traceIds).toHaveLength(1);
    const persisted = tmp.repos.traces.getById(result.traceIds[0]!);
    expect(persisted).not.toBeNull();
    expect(persisted!.userText).toBe("say hi");
    expect(persisted!.agentText).toBe("hi");
    expect(persisted!.reflection).toBeNull();
    expect(persisted!.alpha).toBe(0);
    expect(persisted!.value).toBe(0);
    // Newly-captured rows seed `priority` at 0.5 so they're visible to
    // Tier-2 retrieval even before reward backprop runs (V7 §0.6 will
    // overwrite this once R_human lands).
    expect(persisted!.priority).toBe(0.5);
    expect(persisted!.vecSummary).toBeInstanceOf(Float32Array);
    expect(persisted!.vecAction).toBeInstanceOf(Float32Array);
  });

  it("preserves existing episode trace order when tools have no reliable startedAt", async () => {
    const runner = buildRunner({ alphaScoring: false });
    const rows: TraceRow[] = [
      traceRow({
        id: "tr_web",
        ts: 3_000,
        userText: "look up current sales",
        toolCalls: [{ name: "web_search", input: undefined, output: "[web_search]" }],
      }),
      traceRow({
        id: "tr_terminal",
        ts: 1_100,
        toolCalls: [{
          name: "terminal",
          input: undefined,
          output: JSON.stringify({ output: "ok" }),
          startedAt: 1_050,
          endedAt: 1_100,
        }],
      }),
      traceRow({ id: "tr_final", ts: 4_000, agentText: "final answer" }),
    ];
    for (const row of rows) tmp.repos.traces.insert(row);
    episodesRepo.updateTraceIds("ep_1" as EpisodeId, rows.map((row) => row.id));

    const ep = episodeSnapshot({
      id: "ep_1",
      sessionId: "se_1",
      turns: [
        turn("user", "look up current sales", 1_000),
        turn("tool", "[web_search]", 3_000, { tool: "web_search" }),
        turn("tool", JSON.stringify({ output: "ok" }), 1_100, {
          tool: "terminal",
          startedAt: 1_050,
          endedAt: 1_100,
        }),
        turn("assistant", "final answer", 4_000),
        turn("user", "thanks", 5_000),
        turn("assistant", "you are welcome", 5_100),
      ],
    });
    ep.traceIds = rows.map((row) => row.id);

    const lite = await runner.runLite({ episode: ep });

    expect(lite.traceIds).toHaveLength(1);
    const episode = tmp.repos.episodes.getById("ep_1" as EpisodeId)!;
    expect(episode.traceIds).toEqual([...rows.map((row) => row.id), lite.traceIds[0]]);
  });

  it("places newly inserted older conversation steps before the final assistant trace", async () => {
    const runner = buildRunner({ alphaScoring: false });
    const finalTrace = traceRow({ id: "tr_final", ts: 2_000, agentText: "final answer" });
    tmp.repos.traces.insert(finalTrace);
    episodesRepo.updateTraceIds("ep_1" as EpisodeId, [finalTrace.id]);

    const ep = episodeSnapshot({
      id: "ep_1",
      sessionId: "se_1",
      turns: [
        turn("user", "look up current sales", 1_000),
        turn("tool", JSON.stringify({ success: true }), 1_100, {
          tool: "browser_navigate",
          input: { url: "https://example.com" },
          output: { success: true },
          startedAt: 1_050,
          endedAt: 1_100,
        }),
        turn("assistant", "final answer", 2_000),
      ],
    });
    ep.traceIds = [finalTrace.id];

    const lite = await runner.runLite({ episode: ep });

    expect(lite.traceIds).toHaveLength(1);
    expect(tmp.repos.episodes.getById("ep_1" as EpisodeId)!.traceIds).toEqual([
      lite.traceIds[0],
      finalTrace.id,
    ]);
  });

  it("skips duplicate tool rows with the same action signature during capture persist", async () => {
    const runner = buildRunner({ alphaScoring: false });
    const toolMeta = {
      tool: "browser_navigate",
      input: { url: "https://example.com" },
      output: { success: true },
      startedAt: 1_050,
      endedAt: 1_100,
    };
    const ep = episodeSnapshot({
      id: "ep_1",
      sessionId: "se_1",
      turns: [
        turn("user", "look up current sales", 1_000),
        turn("tool", JSON.stringify({ success: true }), 1_100, toolMeta),
        turn("tool", JSON.stringify({ success: true }), 1_200, toolMeta),
        turn("assistant", "final answer", 2_000),
      ],
    });

    const lite = await runner.runLite({ episode: ep });
    const rows = tmp.repos.traces.list({ episodeId: "ep_1" as EpisodeId });

    expect(lite.traceIds).toHaveLength(2);
    expect(rows.filter((row) => row.toolCalls[0]?.name === "browser_navigate")).toHaveLength(1);
    expect(rows.filter((row) => row.agentText === "final answer")).toHaveLength(1);
    expect(tmp.repos.episodes.getById("ep_1" as EpisodeId)!.traceIds).toEqual(lite.traceIds);
  });

  it("passes through adapter-provided reflection and stores α from LLM", async () => {
    const llm = fakeLlm({
      completeJson: {
        [alphaOp]: { alpha: 0.8, usable: true, reason: "concrete" },
      },
    });
    const runner = buildRunner({}, llm);
    const ep = episodeSnapshot({
      id: "ep_1",
      sessionId: "se_1",
      turns: [
        turn("user", "do x", 1_000),
        turn("assistant", "done", 1_100, {
          reflection: "I chose the shell tool because it's the cheapest.",
        }),
      ],
    });
    const result = await runCapture(runner, ep);

    expect(result.traceIds).toHaveLength(1);
    expect(result.llmCalls.alphaScoring).toBe(1);
    expect(result.llmCalls.reflectionSynth).toBe(0);

    const t = tmp.repos.traces.getById(result.traceIds[0]!)!;
    expect(t.reflection).toContain("shell tool");
    expect(t.alpha).toBeCloseTo(0.8, 5);
  });

  it("clamps α to 0 when LLM marks reflection unusable", async () => {
    const llm = fakeLlm({
      completeJson: {
        [alphaOp]: { alpha: 0.9, usable: false, reason: "tautology" },
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
          "### Reasoning:\nI did this because I needed to do this more than a dozen tokens.",
          1_100,
        ),
      ],
    });
    const result = await runCapture(runner, ep);
    const t = tmp.repos.traces.getById(result.traceIds[0]!)!;
    expect(t.reflection).toBeTruthy();
    expect(t.alpha).toBe(0);
  });

  it("alpha LLM failure is non-fatal — trace still persists with neutral α", async () => {
    const llm = fakeLlm({ completeJson: {} }); // no mocks → throws
    const runner = buildRunner({}, llm);
    const ep = episodeSnapshot({
      id: "ep_1",
      sessionId: "se_1",
      turns: [
        turn("user", "q", 1_000),
        turn("assistant", "### Reasoning:\nI picked X because of Y and Z.", 1_100),
      ],
    });
    const result = await runCapture(runner, ep);

    expect(result.traceIds).toHaveLength(1);
    expect(result.warnings.some((w) => w.stage === "alpha")).toBe(true);
    const t = tmp.repos.traces.getById(result.traceIds[0]!)!;
    expect(t.reflection).toBeTruthy();
    expect(t.alpha).toBeCloseTo(0.5, 5); // neutral fallback from disabledScore
  });

  it("synthesizes reflection when configured and extraction found nothing", async () => {
    const llm = fakeLlm({
      complete: {
        "capture.reflection.synth":
          "I decided to run ls because the user requested a directory listing.",
      },
      completeJson: {
        [alphaOp]: { alpha: 0.6, usable: true, reason: "ok" },
      },
    });
    const runner = buildRunner({ synthReflections: true }, llm);
    const ep = episodeSnapshot({
      id: "ep_1",
      sessionId: "se_1",
      turns: [
        turn("user", "list files", 1_000),
        turn("assistant", "ok", 1_100), // no reflection pattern in text
      ],
    });
    const result = await runCapture(runner, ep);
    expect(result.llmCalls.reflectionSynth).toBe(1);
    const t = tmp.repos.traces.getById(result.traceIds[0]!)!;
    expect(t.reflection).toContain("directory listing");
    expect(t.alpha).toBeCloseTo(0.6, 5);
  });

  it("updates episode.trace_ids_json with new ids", async () => {
    const runner = buildRunner({ alphaScoring: false });
    const ep = episodeSnapshot({
      id: "ep_1",
      sessionId: "se_1",
      turns: [turn("user", "a", 1_000), turn("assistant", "b", 1_100)],
    });
    const result = await runCapture(runner, ep);
    const row = tmp.repos.episodes.getById("ep_1" as EpisodeId)!;
    expect(row.traceIds).toEqual(result.traceIds);
  });

  it("multi-step episode produces one trace per step with correct ts order", async () => {
    const runner = buildRunner({ alphaScoring: false });
    const ep = episodeSnapshot({
      id: "ep_1",
      sessionId: "se_1",
      turns: [
        turn("user", "first", 1_000),
        turn("assistant", "reply1", 1_050),
        turn("user", "second", 1_100),
        turn("assistant", "reply2", 1_150),
      ],
    });
    const result = await runCapture(runner, ep);
    expect(result.traceIds).toHaveLength(2);
    const rows = result.traceIds.map((id) => tmp.repos.traces.getById(id)!);
    expect(rows[0]!.ts).toBeLessThan(rows[1]!.ts);
    expect(rows[0]!.userText).toBe("first");
    expect(rows[1]!.userText).toBe("second");
  });

  it("emits capture.started for both phases and capture.done at topic end", async () => {
    const runner = buildRunner({ alphaScoring: false });
    const ep = episodeSnapshot({
      id: "ep_1",
      sessionId: "se_1",
      turns: [turn("user", "q", 1_000), turn("assistant", "a", 1_100)],
    });
    await runCapture(runner, ep);
    // V7 §0.1 lifecycle: lite emits `capture.started` (and stays
    // silent on done — reward must NOT fire mid-topic). Reflect emits
    // `capture.started` again, then `capture.done` to gate the reward
    // chain. Two starts + one done is the correct topology.
    expect(seen.map((e) => e.kind)).toEqual([
      "capture.started",
      "capture.lite.done",
      "capture.started",
      "capture.done",
    ]);
  });

  it("zero usable steps → empty capture, warning issued, still emits capture.done", async () => {
    const runner = buildRunner({ alphaScoring: false });
    const ep = episodeSnapshot({
      id: "ep_1",
      sessionId: "se_1",
      turns: [], // totally empty episode
    });
    const result = await runCapture(runner, ep);
    expect(result.traceIds).toEqual([]);
    expect(result.warnings.some((w) => w.stage === "extract")).toBe(true);
    expect(seen.map((e) => e.kind)).toContain("capture.done");
  });

  it("embed disabled → null vectors on row", async () => {
    const runner = buildRunner({ embedTraces: false, alphaScoring: false });
    const ep = episodeSnapshot({
      id: "ep_1",
      sessionId: "se_1",
      turns: [turn("user", "q", 1_000), turn("assistant", "a", 1_100)],
    });
    const result = await runCapture(runner, ep);
    const t = tmp.repos.traces.getById(result.traceIds[0]!)!;
    expect(t.vecSummary).toBeNull();
    expect(t.vecAction).toBeNull();
    expect(tmp.repos.embeddingRetryQueue.countByStatus("pending")).toBe(0);
  });

  it("embedder failure queues missing trace vectors for retry", async () => {
    const runner = buildRunner(
      { embedTraces: true, alphaScoring: false },
      null,
      fakeEmbedder({ dimensions: 8, throwWith: new Error("embedder offline") }),
    );
    const ep = episodeSnapshot({
      id: "ep_1",
      sessionId: "se_1",
      turns: [turn("user", "q", 1_000), turn("assistant", "a", 1_100)],
    });

    const result = await runCapture(runner, ep);
    const t = tmp.repos.traces.getById(result.traceIds[0]!)!;

    expect(t.vecSummary).toBeNull();
    expect(t.vecAction).toBeNull();
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "embed",
          message: "embedding retry queued for missing trace vectors",
          detail: { queued: 2 },
        }),
      ]),
    );
    expect(tmp.repos.embeddingRetryQueue.countByStatus("pending")).toBe(2);
  });
});
