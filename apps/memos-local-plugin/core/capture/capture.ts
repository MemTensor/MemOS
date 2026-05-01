/**
 * `capture.ts` — the Phase 6 pipeline entry point.
 *
 * Orchestrates:
 *     extract → normalize → reflect(+synth?) → alpha-score → embed → persist
 *
 * Called by `subscriber.ts` whenever `episode.finalized` fires, or
 * directly by integration tests to run capture synchronously.
 *
 * Return contract: a fully populated `CaptureResult`. Failures inside
 * one stage are captured as `warnings` and we still try to persist the
 * partial rows — V7 treats missing α as α=0, which is already the SQL
 * default, so a non-fatal capture run still yields reward-propagatable
 * traces.
 */

import { ERROR_CODES, MemosError } from "../../agent-contract/errors.js";
import type { Embedder } from "../embedding/index.js";
import type { LlmClient } from "../llm/index.js";
import { rootLogger } from "../logger/index.js";
import { ids } from "../id.js";
import type { EpisodeRow, TraceRow, TraceId } from "../types.js";
import type { makeEmbeddingRetryQueueRepo } from "../storage/repos/embedding_retry_queue.js";
import type { makeTracesRepo } from "../storage/repos/traces.js";
import type { EpisodesRepo } from "../session/persistence.js";
import { disabledScore, scoreReflection } from "./alpha-scorer.js";
import { batchScoreReflections, type BatchScoreInput } from "./batch-scorer.js";
import { embedSteps, type VecPair } from "./embedder.js";
import { normalizeSteps } from "./normalizer.js";
import { extractReflection } from "./reflection-extractor.js";
import { synthesizeReflection } from "./reflection-synth.js";
import { extractSteps } from "./step-extractor.js";
import { createSummarizer, type Summarizer } from "./summarizer.js";
import { tagsForStep } from "./tagger.js";
import { extractErrorSignatures } from "./error-signature.js";
import type {
  CaptureConfig,
  CaptureEvent,
  CaptureEventBus,
  CaptureInput,
  CaptureResult,
  NormalizedStep,
  ReflectionScore,
  ScoredStep,
  StepCandidate,
  TraceCandidate,
} from "./types.js";

type TracesRepo = ReturnType<typeof makeTracesRepo>;
type EmbeddingRetryQueueRepo = ReturnType<typeof makeEmbeddingRetryQueueRepo>;

export interface CaptureDeps {
  tracesRepo: TracesRepo;
  embeddingRetryQueue?: EmbeddingRetryQueueRepo;
  episodesRepo: EpisodesRepo;
  embedder: Embedder | null;
  /** Main LLM — used for per-turn lite capture (summarisation). */
  llm: LlmClient | null;
  /**
   * Dedicated LLM for the topic-end reflection + α scoring pass.
   * When the user configures a stronger model under `skillEvolver.*`,
   * this points to that model; otherwise it falls back to `llm`.
   */
  reflectLlm: LlmClient | null;
  bus: CaptureEventBus;
  cfg: CaptureConfig;
  now?: () => number;
}

export interface CaptureRunner {
  /**
   * Per-turn "lite" capture. Writes the trace row for any newly added
   * step in the episode with `reflection=null` + `alpha=0`. No LLM
   * reflection / α scoring here — the user can already see the memory
   * in the viewer immediately, but no "反思" pill is shown until the
   * topic-level reflect pass fires.
   *
   * Idempotent: existing traces (matched by `step.ts`) are skipped.
   * Safe to call after every `addTurn` cycle.
   */
  runLite(input: CaptureInput): Promise<CaptureResult>;
  /**
   * Topic-end "reflect" capture. Runs the batch reflection scorer over
   * EVERY step of the (now-finalized) episode in one LLM call so the
   * model sees the full causal chain, then writes
   * `reflection + alpha` back onto each existing trace via
   * `tracesRepo.updateReflection`. Emits `capture.done` so the reward
   * subscriber can run `R_human` + V backprop afterwards.
   *
   * Falls back to per-step scoring when the episode exceeds
   * `cfg.batchThreshold` so the prompt can't overflow the model's
   * context window.
   */
  runReflect(input: CaptureInput): Promise<CaptureResult>;
}

export function createCaptureRunner(deps: CaptureDeps): CaptureRunner {
  const log = rootLogger.child({ channel: "core.capture" });
  const now = deps.now ?? Date.now;
  const summarizer: Summarizer = createSummarizer({
    llm: deps.llm ?? null,
    log: log.child({ channel: "core.capture.summarizer" }),
  });

  function emit(evt: CaptureEvent): void {
    deps.bus.emit(evt);
  }

  /**
   * Per-turn lite capture — see `CaptureRunner.runLite` for contract.
   * Extracts new steps from the episode, summarises + embeds them,
   * and inserts trace rows with `reflection=null` + `alpha=0`. The
   * topic-end `runReflect` pass fills those in later.
   */
  async function runLite(input: CaptureInput): Promise<CaptureResult> {
    const startedAt = now();
    const warnings: CaptureResult["warnings"] = [];
    const llmCalls = newLlmCounters();

    emit({
      kind: "capture.started",
      episodeId: input.episode.id,
      sessionId: input.episode.sessionId,
    });

    // ─── Extract + dedup (skip steps we've already written this episode) ──
    const extractStart = now();
    const rawAll = extractSteps(input.episode);
    const existingTraces = deps.tracesRepo.list({ episodeId: input.episode.id });
    const seenTs = new Set<number>(existingTraces.map((t) => t.ts));
    const raw = rawAll.filter((s) => !seenTs.has(s.ts));
    const extractMs = now() - extractStart;
    log.debug("stage.extract.done", {
      phase: "lite",
      episodeId: input.episode.id,
      steps: raw.length,
      novel: raw.length,
      skipped: rawAll.length - raw.length,
      durationMs: extractMs,
    });

    const normStart = now();
    const normalized = normalizeSteps(raw, deps.cfg);
    const normalizeMs = now() - normStart;

    if (normalized.length === 0) {
      const result = emptyResult(input, startedAt, {
        extract: extractMs,
        normalize: normalizeMs,
      }, llmCalls, warnings);
      // No `capture.done` here — lite never triggers reward.
      return result;
    }

    // Skip stage 3 entirely. Wrap each NormalizedStep into a
    // ScoredStep with a placeholder reflection so the rest of the
    // pipeline keeps the same shape.
    const scored: ScoredStep[] = normalized.map((s) => ({
      ...s,
      reflection: { text: null, alpha: 0, usable: false, source: "none" },
    }));

    // Summarise — needed for the viewer card line + retrieval embedding.
    const summarizeStart = now();
    const { summaries, summarizeMs } = await runSummarize(
      scored,
      summarizeStart,
      llmCalls,
      warnings,
    );

    // Embed.
    const { vecs, embedMs } = await runEmbed(scored, summaries, warnings);

    // Persist as new rows. Reflection / α deliberately empty.
    const persistStart = now();
    const rows = buildRows(scored, summaries, vecs, input.episode);
    const persisted = await persistRows(rows, input, warnings);
    if (!persisted) {
      // emit capture.failed handled inside persistRows on hard fail.
      return finalResult(
        input,
        startedAt,
        [],
        scored.map(toCandidate(rows)),
        {
          extract: extractMs,
          normalize: normalizeMs,
          reflect: 0,
          alpha: 0,
          summarize: summarizeMs,
          embed: embedMs,
          persist: now() - persistStart,
        },
        llmCalls,
        warnings,
      );
    }
    const persistMs = now() - persistStart;

    const result = finalResult(
      input,
      startedAt,
      rows.map((r) => r.id),
      buildTraceCandidates(scored, rows),
      {
        extract: extractMs,
        normalize: normalizeMs,
        reflect: 0,
        alpha: 0,
        summarize: summarizeMs,
        embed: embedMs,
        persist: persistMs,
      },
      llmCalls,
      warnings,
    );
    log.info("capture.lite.done", {
      episodeId: input.episode.id,
      sessionId: input.episode.sessionId,
      traces: result.traceIds.length,
      llmCalls,
      totalMs: result.completedAt - startedAt,
      warnings: warnings.length,
    });
    // Emit `capture.lite.done` so the api_logs table gets a per-turn
    // `memory_add` row. This is distinct from `capture.done` which
    // triggers the reward / L2 / L3 chain and only fires at topic end.
    emit({ kind: "capture.lite.done", result });
    return result;
  }

  /**
   * Topic-end reflect pass — see `CaptureRunner.runReflect` for contract.
   * Reads every trace already written for this episode, batch-scores
   * reflection + α across the full causal chain, and patches each
   * trace row with the result. Then fires `capture.done` so the
   * reward subscriber computes R_human + back-propagates V.
   */
  async function runReflect(input: CaptureInput): Promise<CaptureResult> {
    const startedAt = now();
    const warnings: CaptureResult["warnings"] = [];
    const llmCalls = newLlmCounters();

    emit({
      kind: "capture.started",
      episodeId: input.episode.id,
      sessionId: input.episode.sessionId,
    });

    // Re-derive normalized steps from the (now closed) episode so the
    // batch scorer sees state/action/outcome in the exact same shape
    // it would have seen during a per-step pass.
    const extractStart = now();
    const rawAll = extractSteps(input.episode);
    const extractMs = now() - extractStart;

    const normStart = now();
    const normalized = normalizeSteps(rawAll, deps.cfg);
    const normalizeMs = now() - normStart;

    // Pair each normalized step with its already-persisted trace row
    // (matched by ts). If runLite was skipped for any step, fall back
    // to a fresh insert path so we don't lose data.
    const existing = deps.tracesRepo.list({ episodeId: input.episode.id });
    const traceByTs = new Map<number, (typeof existing)[number]>();
    for (const tr of existing) traceByTs.set(tr.ts, tr);
    const orphan = normalized.filter((s) => !traceByTs.has(s.ts));
    if (orphan.length > 0) {
      log.warn("reflect.orphan_steps", {
        episodeId: input.episode.id,
        count: orphan.length,
        action: "fallback_insert",
      });
      // These steps never went through runLite (likely a test path or a
      // dropped event). Insert them now with reflection=null so the
      // batch pass below can patch them like the rest.
      const summStart = now();
      const { summaries } = await runSummarize(
        orphan.map((s) => ({
          ...s,
          reflection: { text: null, alpha: 0, usable: false, source: "none" },
        })),
        summStart,
        llmCalls,
        warnings,
      );
      const orphanScored: ScoredStep[] = orphan.map((s) => ({
        ...s,
        reflection: { text: null, alpha: 0, usable: false, source: "none" },
      }));
      const { vecs } = await runEmbed(orphanScored, summaries, warnings);
      const orphanRows = buildRows(orphanScored, summaries, vecs, input.episode);
      await persistRows(orphanRows, input, warnings);
      for (const r of orphanRows) traceByTs.set(r.ts, r);
    }

    if (normalized.length === 0) {
      const result = emptyResult(input, startedAt, {
        extract: extractMs,
        normalize: normalizeMs,
      }, llmCalls, warnings);
      emit({ kind: "capture.done", result });
      return result;
    }

    // Batch reflection + α across every step of the now-closed
    // episode. Falls back to per-step scoring when over the threshold
    // or when batching fails / no LLM is wired. The reflect pass uses
    // `reflectLlm` (skill-evolver model when configured) for higher
    // quality reflections; per-turn lite capture still uses `llm`.
    const reflectStart = now();
    const rLlm = deps.reflectLlm ?? deps.llm;
    const useBatch = shouldBatch(deps.cfg, normalized.length, rLlm !== null);
    let scored: ScoredStep[] = [];
    if (useBatch) {
      scored = await runBatchScoring(normalized, rLlm!, deps, warnings, llmCalls);
    }
    if (!useBatch || scored.length === 0) {
      scored = await runPerStepScoring(normalized, rLlm, deps, warnings, llmCalls);
    }
    const reflectMs = now() - reflectStart;

    // Patch each existing trace with the freshly-computed reflection +
    // α. Steps that lack a matching trace (shouldn't happen after the
    // orphan-fallback above) are skipped with a warning.
    const persistStart = now();
    const patchedTraceIds: string[] = [];
    for (const s of scored) {
      const row = traceByTs.get(s.ts);
      if (!row) {
        warnings.push({
          stage: "persist",
          message: "reflect: no trace row for step ts; skipping",
          detail: { ts: s.ts, key: s.key },
        });
        continue;
      }
      try {
        deps.tracesRepo.updateReflection(row.id, {
          reflection: s.reflection.text,
          alpha: s.reflection.alpha ?? 0,
        });
        patchedTraceIds.push(row.id);
      } catch (err) {
        warnings.push({
          stage: "persist",
          message: "reflect: updateReflection failed",
          detail: errDetail(err),
        });
      }
    }
    const persistMs = now() - persistStart;

    // Build traces[] mirroring the schema downstream subscribers
    // expect (reward / L2 induction reads `traces` to seed credit
    // assignment). For reflect-phase rows we re-emit ScoredStep-shaped
    // candidates carrying the freshly computed reflection + α; the
    // already-existing trace ids come from the matched DB rows.
    const traces: TraceCandidate[] = scored.map((s) => {
      const row = traceByTs.get(s.ts);
      return {
        ...s,
        traceId: (row?.id ?? "") as TraceId,
        tags: row?.tags ?? tagsForStep(s),
        vecSummary: row?.vecSummary ?? null,
        vecAction: row?.vecAction ?? null,
      };
    });

    const result: CaptureResult = {
      episodeId: input.episode.id,
      sessionId: input.episode.sessionId,
      traceIds: patchedTraceIds,
      traces,
      startedAt,
      completedAt: now(),
      stageTimings: {
        extract: extractMs,
        normalize: normalizeMs,
        reflect: reflectMs,
        alpha: 0,
        summarize: 0,
        embed: 0,
        persist: persistMs,
      },
      llmCalls,
      warnings,
    };

    log.info("capture.reflect.done", {
      episodeId: input.episode.id,
      sessionId: input.episode.sessionId,
      traces: patchedTraceIds.length,
      llmCalls,
      totalMs: result.completedAt - startedAt,
      warnings: warnings.length,
    });
    // ONLY here (topic end) do we fire `capture.done`. That kicks off
    // the reward subscriber → R_human + V backprop, then L2 / L3 /
    // skill induction. By gating it on the reflect phase we make sure
    // those expensive downstream stages run once per topic, not once
    // per turn.
    emit({ kind: "capture.done", result });
    return result;
  }

  // ─── Internal helpers shared by runLite + runReflect ────────────────────

  function newLlmCounters() {
    return {
      reflectionSynth: 0,
      alphaScoring: 0,
      batchedReflection: 0,
      summarize: 0,
    };
  }

  function emptyResult(
    input: CaptureInput,
    startedAt: number,
    timings: { extract: number; normalize: number },
    llmCalls: ReturnType<typeof newLlmCounters>,
    warnings: CaptureResult["warnings"],
  ): CaptureResult {
    return {
      episodeId: input.episode.id,
      sessionId: input.episode.sessionId,
      traceIds: [],
      traces: [],
      startedAt,
      completedAt: now(),
      stageTimings: {
        extract: timings.extract,
        normalize: timings.normalize,
        reflect: 0,
        alpha: 0,
        summarize: 0,
        embed: 0,
        persist: 0,
      },
      llmCalls,
      warnings: [
        ...warnings,
        { stage: "extract", message: "no usable steps in episode" },
      ],
    };
  }

  async function runSummarize(
    scored: ScoredStep[],
    summarizeStart: number,
    llmCalls: ReturnType<typeof newLlmCounters>,
    warnings: CaptureResult["warnings"],
  ): Promise<{ summaries: string[]; summarizeMs: number }> {
    const concurrency = Math.max(1, deps.cfg.llmConcurrency);
    const summaries = await runConcurrently(
      scored,
      concurrency,
      async (step) => {
        try {
          const s = await summarizer.summarize(step);
          llmCalls.summarize += 1;
          return s;
        } catch (err) {
          warnings.push({
            stage: "summarize",
            message: "summarizer threw; falling back to userText",
            detail: errDetail(err),
          });
          return (step.userText ?? step.agentText ?? "").slice(0, 140);
        }
      },
    );
    return { summaries, summarizeMs: now() - summarizeStart };
  }

  async function runEmbed(
    scored: ScoredStep[],
    summaries: string[],
    warnings: CaptureResult["warnings"],
  ): Promise<{ vecs: VecPair[]; embedMs: number }> {
    const start = now();
    if (!deps.cfg.embedTraces || !deps.embedder) {
      return { vecs: scored.map(() => ({ summary: null, action: null })), embedMs: now() - start };
    }
    try {
      const vecs = await embedSteps(deps.embedder, scored, summaries);
      return { vecs, embedMs: now() - start };
    } catch (err) {
      warnings.push({
        stage: "embed",
        message: "embedder threw; inserting null vectors",
        detail: errDetail(err),
      });
      return { vecs: scored.map(() => ({ summary: null, action: null })), embedMs: now() - start };
    }
  }

  function buildRows(
    scored: ScoredStep[],
    summaries: string[],
    vecs: VecPair[],
    episode: CaptureInput["episode"],
  ): TraceRow[] {
    const traces: TraceCandidate[] = scored.map((s, i) => ({
      ...s,
      traceId: ids.trace() as TraceId,
      tags: tagsForStep(s),
      vecSummary: vecs[i]?.summary ?? null,
      vecAction: vecs[i]?.action ?? null,
    }));
    return traces.map((t, i) => ({
      id: t.traceId,
      episodeId: episode.id,
      sessionId: episode.sessionId,
      ts: t.ts,
      userText: t.userText,
      agentText: t.agentText,
      summary: summaries[i] ?? null,
      toolCalls: t.toolCalls,
      // Reflection + α deliberately empty in lite-phase rows; the
      // topic-end reflect pass fills them via `updateReflection`.
      reflection: t.reflection.text,
      agentThinking: t.agentThinking ?? null,
      value: 0,
      alpha: t.reflection.alpha ?? 0,
      rHuman: null,
      // V7 §0.6: priority(f1) ∝ max(V,0) · decay(Δt). Seeded at 0.5
      // so retrieval can find the row immediately; reward backprop
      // overwrites it once the topic is reflected on.
      priority: 0.5,
      tags: t.tags,
      errorSignatures: extractErrorSignatures({
        toolCalls: t.toolCalls,
        agentText: t.agentText,
        reflection: t.reflection.text ?? undefined,
      }),
      vecSummary: t.vecSummary,
      vecAction: t.vecAction,
      // step-extractor stamps every sub-step that came from the same
      // user message with a stable `turnId` (= the user turn's ts).
      // The viewer collapses rows with identical (episodeId, turnId)
      // into a single "one round = one memory" card; algorithm-side
      // machinery ignores the field.
      turnId: pickTurnId(t.meta, t.ts),
      schemaVersion: 1,
    }));
  }

  function buildTraceCandidates(
    scored: ScoredStep[],
    rows: TraceRow[],
  ): TraceCandidate[] {
    const used = new Set<number>();
    return rows.map((row) => {
      const idx = scored.findIndex((s, i) => !used.has(i) && rowMatchesStep(row, s));
      const s = scored[idx >= 0 ? idx : 0]!;
      if (idx >= 0) used.add(idx);
      return {
        ...s,
        traceId: row.id as TraceId,
        tags: row.tags,
        vecSummary: row.vecSummary,
        vecAction: row.vecAction,
      };
    });
  }

  function rowMatchesStep(row: TraceRow, step: ScoredStep): boolean {
    if (row.ts !== step.ts) return false;
    const rowTool = row.toolCalls[0];
    const stepTool = step.toolCalls[0];
    if (rowTool || stepTool) return rowTool?.name === stepTool?.name;
    return row.userText === step.userText && row.agentText === step.agentText;
  }

  async function persistRows(
    rows: TraceRow[],
    input: CaptureInput,
    warnings: CaptureResult["warnings"],
  ): Promise<boolean> {
    const existingBeforeInsert = deps.tracesRepo.list({ episodeId: input.episode.id });
    const seenSignatures = new Set(existingBeforeInsert.map(traceIdentitySignature));
    const uniqueRows = rows.filter((row) => {
      const signature = traceIdentitySignature(row);
      if (seenSignatures.has(signature)) return false;
      seenSignatures.add(signature);
      return true;
    });
    if (uniqueRows.length !== rows.length) {
      warnings.push({
        stage: "persist",
        message: "skipped duplicate trace rows during capture persist",
        detail: {
          skipped: rows.length - uniqueRows.length,
          episodeId: input.episode.id,
        },
      });
      rows.splice(0, rows.length, ...uniqueRows);
    }

    try {
      for (const row of rows) deps.tracesRepo.insert(row);
      enqueueMissingTraceVectors(rows, warnings);
    } catch (err) {
      const failure = errDetail(err);
      log.error("persist.failed", {
        episodeId: input.episode.id,
        err: failure,
      });
      emit({
        kind: "capture.failed",
        episodeId: input.episode.id,
        sessionId: input.episode.sessionId,
        stage: "persist",
        error: {
          code: (failure.code as string | undefined) ?? ERROR_CODES.INTERNAL,
          message: (failure.message as string | undefined) ?? String(err),
        },
      });
      throw err instanceof Error
        ? err
        : new MemosError(ERROR_CODES.INTERNAL, "capture.persist failed", failure);
    }
    try {
      const current = deps.episodesRepo.getById(input.episode.id) as EpisodeRow | null;
      const currentTraceIds = current?.traceIds ?? input.episode.traceIds;
      deps.episodesRepo.updateTraceIds(
        input.episode.id,
        reconcileTraceIds([...currentTraceIds, ...rows.map((r) => r.id)], input.episode),
      );
    } catch (err) {
      warnings.push({
        stage: "persist",
        message: "failed to update episode trace_ids_json",
        detail: errDetail(err),
      });
    }
    return true;
  }

  function reconcileTraceIds(traceIds: TraceId[], episode: CaptureInput["episode"]): TraceId[] {
    const uniqueIds = dedupeTraceIds(traceIds);
    const rowById = new Map(deps.tracesRepo.getManyByIds(uniqueIds).map((row) => [row.id, row]));
    const originalIndex = new Map(uniqueIds.map((id, idx) => [id, idx]));
    const stepOrder = new Map<string, number>();
    extractSteps(episode).forEach((step, idx) => {
      const signature = stepIdentitySignature(step);
      if (!stepOrder.has(signature)) stepOrder.set(signature, idx);
    });
    const seenSignatures = new Set<string>();
    return uniqueIds
      .filter((id) => rowById.has(id))
      .sort((a, b) => {
        const ai = stepOrder.get(traceIdentitySignature(rowById.get(a)!));
        const bi = stepOrder.get(traceIdentitySignature(rowById.get(b)!));
        if (ai != null && bi != null && ai !== bi) return ai - bi;
        if (ai != null && bi == null) return -1;
        if (ai == null && bi != null) return 1;
        return (originalIndex.get(a) ?? 0) - (originalIndex.get(b) ?? 0);
      })
      .filter((id) => {
        const signature = traceIdentitySignature(rowById.get(id)!);
        if (seenSignatures.has(signature)) return false;
        seenSignatures.add(signature);
        return true;
      });
  }

  function dedupeTraceIds(traceIds: TraceId[]): TraceId[] {
    const seen = new Set<TraceId>();
    const out: TraceId[] = [];
    for (const id of traceIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  function stepIdentitySignature(step: StepCandidate): string {
    const tool = step.toolCalls[0];
    const turnId = pickTurnId(step.meta, step.ts);
    if (tool) {
      const hasRealTiming =
        typeof tool.startedAt === "number" || typeof tool.endedAt === "number";
      return [
        "tool",
        turnId,
        tool.name,
        hasRealTiming ? tool.startedAt ?? "" : step.ts,
        hasRealTiming ? tool.endedAt ?? "" : "",
        stableJson(tool.input),
        stableJson(tool.output),
        tool.errorCode ?? "",
      ].join("\x1f");
    }
    if (step.agentText.trim()) {
      return ["assistant", turnId, step.ts, step.agentText.trim()].join("\x1f");
    }
    return ["user", turnId, step.ts, step.userText.trim()].join("\x1f");
  }

  function traceIdentitySignature(row: TraceRow): string {
    const tool = row.toolCalls[0];
    if (tool) {
      const hasRealTiming =
        typeof tool.startedAt === "number" || typeof tool.endedAt === "number";
      return [
        "tool",
        row.turnId,
        tool.name,
        hasRealTiming ? tool.startedAt ?? "" : row.ts,
        hasRealTiming ? tool.endedAt ?? "" : "",
        stableJson(tool.input),
        stableJson(tool.output),
        tool.errorCode ?? "",
      ].join("\x1f");
    }
    if (row.agentText.trim()) {
      return ["assistant", row.turnId, row.ts, row.agentText.trim()].join("\x1f");
    }
    return ["user", row.turnId, row.ts, row.userText.trim()].join("\x1f");
  }

  function stableJson(value: unknown): string {
    if (value === undefined) return "";
    return JSON.stringify(sortJson(value));
  }

  function sortJson(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortJson);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, val]) => [key, sortJson(val)]),
    );
  }

  function enqueueMissingTraceVectors(
    rows: TraceRow[],
    warnings: CaptureResult["warnings"],
  ): void {
    if (!deps.cfg.embedTraces || !deps.embeddingRetryQueue || !deps.embedder) return;
    const queuedAt = now();
    let queued = 0;
    for (const row of rows) {
      if (!row.vecSummary) {
        deps.embeddingRetryQueue.enqueue({
          id: `er_${ids.span()}`,
          targetKind: "trace",
          targetId: row.id,
          vectorField: "vec_summary",
          sourceText: row.summary?.trim() || row.userText.trim() || "(empty)",
          now: queuedAt,
        });
        queued++;
      }
      if (!row.vecAction) {
        deps.embeddingRetryQueue.enqueue({
          id: `er_${ids.span()}`,
          targetKind: "trace",
          targetId: row.id,
          vectorField: "vec_action",
          sourceText: traceActionText(row),
          now: queuedAt,
        });
        queued++;
      }
    }
    if (queued > 0) {
      warnings.push({
        stage: "embed",
        message: "embedding retry queued for missing trace vectors",
        detail: { queued },
      });
    }
  }

  function finalResult(
    input: CaptureInput,
    startedAt: number,
    traceIds: string[],
    traces: TraceCandidate[],
    timings: CaptureResult["stageTimings"],
    llmCalls: ReturnType<typeof newLlmCounters>,
    warnings: CaptureResult["warnings"],
  ): CaptureResult {
    return {
      episodeId: input.episode.id,
      sessionId: input.episode.sessionId,
      traceIds,
      traces,
      startedAt,
      completedAt: now(),
      stageTimings: timings,
      llmCalls,
      warnings,
    };
  }

  /**
   * Used by `runLite`'s short-circuit error branch — captures the
   * partially-computed scored steps as TraceCandidates so the result
   * still carries debug info even when persistence failed.
   */
  function toCandidate(
    rows: TraceRow[],
  ): (s: ScoredStep, i: number) => TraceCandidate {
    return (s, i) => ({
      ...s,
      traceId: (rows[i]?.id ?? "") as TraceId,
      tags: rows[i]?.tags ?? tagsForStep(s),
      vecSummary: rows[i]?.vecSummary ?? null,
      vecAction: rows[i]?.vecAction ?? null,
    });
  }

  return { runLite, runReflect };
}

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Decide whether to use the batched reflection+α path.
 *
 * `per_step`     → never (legacy path).
 * `per_episode`  → always, when an LLM is available.
 * `auto`         → batch when step count fits inside `batchThreshold`.
 */
function shouldBatch(cfg: CaptureConfig, stepCount: number, hasLlm: boolean): boolean {
  if (!hasLlm) return false;
  if (stepCount === 0) return false;
  if (cfg.batchMode === "per_step") return false;
  if (cfg.batchMode === "per_episode") return true;
  // "auto"
  return stepCount <= cfg.batchThreshold;
}

async function runBatchScoring(
  normalized: NormalizedStep[],
  llm: LlmClient,
  deps: CaptureDeps,
  warnings: CaptureResult["warnings"],
  llmCalls: { reflectionSynth: number; alphaScoring: number; batchedReflection: number },
): Promise<ScoredStep[]> {
  const inputs: BatchScoreInput[] = normalized.map((step) => ({
    step,
    existingReflection: extractReflection(step),
  }));

  try {
    const out = await batchScoreReflections(llm, inputs, {
      synthReflections: deps.cfg.synthReflections,
    });
    llmCalls.batchedReflection += 1;
    return normalized.map((step, i) => ({
      ...step,
      reflection: out.scores[i] ?? disabledScore(null, "none"),
    }));
  } catch (err) {
    // Single failure mode: the batched call (or its validator) threw.
    // Fall back to per-step in the caller. We surface a warning so the
    // viewer can show "batch path degraded" without crashing capture.
    warnings.push({
      stage: "batch",
      message: "batched reflection scoring failed; falling back to per-step",
      detail: errDetail(err),
    });
    return [];
  }
}

async function runPerStepScoring(
  normalized: NormalizedStep[],
  llm: LlmClient | null,
  deps: CaptureDeps,
  warnings: CaptureResult["warnings"],
  llmCalls: { reflectionSynth: number; alphaScoring: number },
): Promise<ScoredStep[]> {
  const concurrency = Math.max(1, deps.cfg.llmConcurrency);
  return runConcurrently(normalized, concurrency, async (step): Promise<ScoredStep> => {
    const { score, synthCount } = await resolveReflection(step, llm, deps, warnings);
    llmCalls.reflectionSynth += synthCount;
    const finalScore = await resolveAlpha(step, score, llm, deps, warnings);
    if (finalScore !== score) llmCalls.alphaScoring += 1;
    return { ...step, reflection: finalScore };
  });
}

async function resolveReflection(
  step: NormalizedStep,
  llm: LlmClient | null,
  deps: CaptureDeps,
  warnings: CaptureResult["warnings"],
): Promise<{ score: ReflectionScore; synthCount: number }> {
  const adapterProvided = step.rawReflection !== null && step.rawReflection.trim().length > 0;
  const extracted = extractReflection(step);
  if (extracted) {
    return {
      score: disabledScore(extracted, adapterProvided ? "adapter" : "extracted"),
      synthCount: 0,
    };
  }
  if (!deps.cfg.synthReflections || !llm) {
    return { score: disabledScore(null, "none"), synthCount: 0 };
  }
  try {
    const synth = await synthesizeReflection(llm, step);
    if (synth.text) {
      return {
        score: { text: synth.text, alpha: null, usable: true, source: "synth", model: synth.model },
        synthCount: 1,
      };
    }
    return { score: disabledScore(null, "none"), synthCount: 1 };
  } catch (err) {
    warnings.push({
      stage: "reflection.synth",
      message: "synth failed",
      detail: errDetail(err),
    });
    return { score: disabledScore(null, "none"), synthCount: 0 };
  }
}

async function resolveAlpha(
  step: NormalizedStep,
  current: ReflectionScore,
  llm: LlmClient | null,
  deps: CaptureDeps,
  warnings: CaptureResult["warnings"],
): Promise<ReflectionScore> {
  if (!current.text) return current; // nothing to grade
  if (!deps.cfg.alphaScoring || !llm) return current;

  try {
    const scored = await scoreReflection(llm, {
      step,
      reflectionText: current.text,
    });
    return {
      ...current,
      alpha: scored.alpha,
      usable: scored.usable,
      model: scored.model,
    };
  } catch (err) {
    warnings.push({
      stage: "alpha",
      message: "alpha scoring failed; keeping neutral α",
      detail: errDetail(err),
    });
    return current;
  }
}

async function runConcurrently<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  for (let w = 0; w < Math.min(concurrency, items.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return out;
}

function errDetail(err: unknown): Record<string, unknown> {
  if (err instanceof MemosError) return { code: err.code, message: err.message, ...(err.details ?? {}) };
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { value: String(err) };
}

function traceActionText(row: Pick<TraceRow, "agentText" | "toolCalls">): string {
  const toolSig = row.toolCalls
    .map((t) => `${t.name}(${safeStringify(t.input).slice(0, 300)})`)
    .join("; ");
  return [row.agentText.trim(), toolSig].filter((s) => s.length > 0).join("\n---\n") || "(empty)";
}

function safeStringify(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Pull the `turnId` stamped by `step-extractor` out of the
 * `StepCandidate.meta` blob. Falls back to the trace's own `ts` so
 * old fixtures that pre-date the field still group as a singleton
 * (one row → one card). Always returns a finite number.
 */
function pickTurnId(meta: Record<string, unknown> | undefined, fallbackTs: number): number {
  const raw = (meta as Record<string, unknown> | undefined)?.turnId;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : fallbackTs;
}
