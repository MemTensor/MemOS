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
import type { Logger } from "../logger/types.js";
import { ids } from "../id.js";
import type { EpisodeRow, TraceRow, TraceId, EpochMs } from "../types.js";
import { sanitizeDerivedText } from "../safety/content.js";
import type { makeEmbeddingRetryQueueRepo } from "../storage/repos/embedding_retry_queue.js";
import type { makeTracesRepo } from "../storage/repos/traces.js";
import type { EpisodesRepo } from "../session/persistence.js";
import { batchScoreReflections, type BatchScoreInput } from "./batch-scorer.js";
import { buildActionText, buildStateText, embedSteps, type VecPair } from "./embedder.js";
import {
  CAPTURE_LITE_TURN_CURSOR_META,
  pickTurnId,
  resolveAnchorTurnId,
  stepIdentitySignature,
  stripRepeatedEpisodeUserText,
} from "../episode/turn-anchor.js";
import { traceIdentitySignature } from "../trace/trace-identity.js";
import { normalizeSteps } from "./normalizer.js";
import { extractIncrementalSteps, extractSteps } from "./step-extractor.js";
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
  /**
   * Called after the lite cursor is advanced so the session layer can
   * propagate the new value into its in-memory episode snapshot. Without
   * this hook, getEpisode() returns cursor=0 on every subsequent turn and
   * runLite falls back to full extractSteps instead of the incremental path.
   */
  onLiteCursorAdvanced?: (episodeId: string, turnCount: number) => void;
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
   * Lightweight memory capture. Writes one trace per user/assistant turn
   * instead of per tool/action step, and never emits `capture.done`.
   */
  runLightweight(input: CaptureInput): Promise<CaptureResult>;
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

  function emit(evt: CaptureEvent): void {
    deps.bus.emit(evt);
  }

  // Per-episode serialization. Without this, two near-simultaneous
  // callers (e.g. lite at turn.end + reflect at episode close, or two
  // gateway workers racing on the same episode) each read the existing
  // traces list BEFORE the other inserts — both compute the same "novel"
  // step set and both insert, producing duplicate rows. Signature dedup
  // closes most of this gap, but the mutex turns "mostly safe" into
  // "actually safe" without paying for a DB unique index.
  const episodeLocks = new Map<string, Promise<unknown>>();
  function withEpisodeLock<T>(
    episodeId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = episodeLocks.get(episodeId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    episodeLocks.set(
      episodeId,
      next.finally(() => {
        if (episodeLocks.get(episodeId) === next) episodeLocks.delete(episodeId);
      }),
    );
    return next;
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
    //
    // Dedup MUST read the full episode (listAllForEpisode, no pagination)
    // and key on signature — not on `ts` alone. The previous (ts, list-50)
    // combo silently re-inserted everything past the 50-row cap and any
    // multi-step turn that collided on the same ms, producing triplet rows
    // in the traces table (one per re-entry from lite / reflect / recovery).
    //
    // IMPORTANT: normalizeSteps runs BEFORE the signature comparison so that
    // both sides use the same truncated text. Raw steps carry the full
    // episode-turn text while DB rows store normalizeSteps-truncated text;
    // comparing across that boundary causes false negatives (step appears
    // novel, passes dedup, and a duplicate trace row is inserted).
    const anchorTurnId = resolveAnchorTurnId(input.episode);
    const extractStart = now();
    const rawAll = extractIncrementalSteps(input.episode);
    const existingTraces = deps.tracesRepo.listAllForEpisode(input.episode.id);
    const seenSignatures = new Set<string>(
      existingTraces.map((row) => traceIdentitySignature(row, anchorTurnId)),
    );
    const extractMs = now() - extractStart;
    const normStart = now();
    const normalizedAll = normalizeSteps(rawAll, deps.cfg);
    const normalized = normalizedAll.filter(
      (s) => !seenSignatures.has(stepIdentitySignature(s, anchorTurnId)),
    );
    const normalizeMs = now() - normStart;
    log.debug("stage.extract.done", {
      phase: "lite",
      episodeId: input.episode.id,
      steps: normalized.length,
      novel: normalized.length,
      skipped: normalizedAll.length - normalized.length,
      durationMs: extractMs,
    });

    if (normalized.length === 0) {
      advanceLiteCaptureCursor(input);
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

    // Summarise locally — needed for the viewer card line.
    const summarizeStart = now();
    const summaries = buildDisplaySummaries(scored);
    const summarizeMs = now() - summarizeStart;

    // Embed.
    const { vecs, embedMs } = await runEmbed(scored, warnings);

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
    advanceLiteCaptureCursor(input);
    return result;
  }

  async function runLightweight(input: CaptureInput): Promise<CaptureResult> {
    const startedAt = now();
    const warnings: CaptureResult["warnings"] = [];
    const llmCalls = newLlmCounters();

    emit({
      kind: "capture.started",
      episodeId: input.episode.id,
      sessionId: input.episode.sessionId,
    });

    const anchorTurnId = resolveAnchorTurnId(input.episode);
    const extractStart = now();
    const rawAll = extractIncrementalSteps(input.episode);
    const existingTraces = deps.tracesRepo.listAllForEpisode(input.episode.id);
    const seenTurnIds = new Set(
      existingTraces
        .map((t) => t.turnId)
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v)),
    );
    const rawByTurn = new Map<number, StepCandidate[]>();
    for (const step of rawAll) {
      const turnId = pickTurnId(step.meta, step.ts);
      if (seenTurnIds.has(turnId)) continue;
      const bucket = rawByTurn.get(turnId) ?? [];
      bucket.push(step);
      rawByTurn.set(turnId, bucket);
    }
    const raw = Array.from(rawByTurn.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([turnId, steps]) => mergeTurnSteps(input.episode.id, turnId, steps));
    const extractMs = now() - extractStart;

    const normStart = now();
    const normalized = normalizeSteps(raw, deps.cfg);
    const normalizeMs = now() - normStart;

    if (normalized.length === 0) {
      return emptyResult(input, startedAt, {
        extract: extractMs,
        normalize: normalizeMs,
      }, llmCalls, warnings);
    }

    const scored: ScoredStep[] = normalized.map((s) => ({
      ...s,
      reflection: { text: null, alpha: 0, usable: false, source: "none" },
    }));

    const summarizeStart = now();
    const summaries = buildDisplaySummaries(scored);
    const summarizeMs = now() - summarizeStart;

    const { vecs: summaryOnlyVecs, embedMs } = await runEmbed(
      scored,
      warnings,
      { summaryOnly: true },
    );

    const persistStart = now();
    const rows = buildRows(scored, summaries, summaryOnlyVecs, input.episode, {
      lightweightMemory: true,
    });
    const persisted = await persistRows(rows, input, warnings, {
      skipActionVectorRetry: true,
    });
    if (!persisted) {
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
    log.info("capture.lightweight.done", {
      episodeId: input.episode.id,
      sessionId: input.episode.sessionId,
      traces: result.traceIds.length,
      llmCalls,
      totalMs: result.completedAt - startedAt,
      warnings: warnings.length,
    });
    emit({ kind: "capture.lite.done", result });
    advanceLiteCaptureCursor(input);
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
    const anchorTurnId = resolveAnchorTurnId(input.episode);
    const extractStart = now();
    const rawAll = extractSteps(input.episode);
    const extractMs = now() - extractStart;

    const normStart = now();
    const normalized = normalizeSteps(rawAll, deps.cfg);
    const normalizeMs = now() - normStart;

    // Pair each normalized step with its already-persisted trace row,
    // matched by signature (NOT by ts — two trace rows can share a ts in
    // multi-tool turns). If runLite was skipped for any step, fall back
    // to a fresh insert path so we don't lose data. Full list (no pagination)
    // is required: a 50-row cap caused the recovery path to mis-flag
    // every step past row 50 as "orphan" and re-insert it.
    const existing = deps.tracesRepo.listAllForEpisode(input.episode.id);
    const traceBySignature = new Map<string, (typeof existing)[number]>();
    for (const tr of existing) {
      traceBySignature.set(traceIdentitySignature(tr, anchorTurnId), tr);
    }
    const orphan = normalized.filter(
      (s) => !traceBySignature.has(stepIdentitySignature(s, anchorTurnId)),
    );
    if (orphan.length > 0) {
      log.warn("reflect.orphan_steps", {
        episodeId: input.episode.id,
        count: orphan.length,
        action: "fallback_insert",
      });
      // These steps never went through runLite (likely a test path or a
      // dropped event). Insert them now with reflection=null so the
      // batch pass below can patch them like the rest.
      const orphanScored: ScoredStep[] = orphan.map((s) => ({
        ...s,
        reflection: { text: null, alpha: 0, usable: false, source: "none" },
      }));
      const summaries = buildDisplaySummaries(orphanScored);
      const { vecs } = await runEmbed(orphanScored, warnings);
      let orphanRows = buildRows(orphanScored, summaries, vecs, input.episode);
      orphanRows = stripRepeatedEpisodeUserText(orphanRows, existing, anchorTurnId);
      await persistRows(orphanRows, input, warnings);
      for (const r of orphanRows) {
        traceBySignature.set(traceIdentitySignature(r, anchorTurnId), r);
      }
    }

    if (normalized.length === 0) {
      const result = emptyResult(input, startedAt, {
        extract: extractMs,
        normalize: normalizeMs,
      }, llmCalls, warnings);
      emit({ kind: "capture.done", result });
      return result;
    }

    // Episode-level binary reflection/alpha scoring with fixed windows.
    // Per-step scoring is removed; all failures degrade through the
    // window retry ladder and finally default to RELATED_DEFAULT.
    const reflectStart = now();
    const rLlm = deps.reflectLlm ?? deps.llm;
    const taskSummary = buildTaskReflectionSummary(input.episode, normalized, deps.cfg.taskContextMaxChars);
    log.info("capture.reflect.scoring.start", {
      episodeId: input.episode.id,
      sessionId: input.episode.sessionId,
      steps: normalized.length,
      mode: "batch_windowed_binary",
      provider: rLlm?.provider ?? "none",
      model: rLlm?.model ?? "none",
      taskSummary: taskSummary ? taskSummary.slice(0, 240) : null,
    });
    const scored = await runEpisodeBatchScoring(
      normalized,
      rLlm,
      warnings,
      llmCalls,
      input.episode.id,
      taskSummary,
      log,
    );
    const reflectMs = now() - reflectStart;

    // Patch each existing trace with the freshly-computed reflection +
    // α. Steps that lack a matching trace (shouldn't happen after the
    // orphan-fallback above) are skipped with a warning.
    const persistStart = now();
    const patchedTraceIds: string[] = [];
    for (const s of scored) {
      const row = traceBySignature.get(stepIdentitySignature(s, anchorTurnId));
      if (!row) {
        warnings.push({
          stage: "persist",
          message: "reflect: no trace row for step signature; skipping",
          detail: { ts: s.ts, key: s.key },
        });
        continue;
      }
      try {
        log.info("capture.reflect.trace.scored", {
          episodeId: input.episode.id,
          sessionId: input.episode.sessionId,
          traceId: row.id,
          stepKey: s.key,
          ts: s.ts,
          turnId: pickTurnId(s.meta, s.ts),
          alpha: s.reflection.alpha ?? 0,
          usable: s.reflection.usable,
          reason: s.reflection.reason ?? null,
          source: s.reflection.source,
          model: s.reflection.model ?? null,
          reflection: s.reflection.text,
        });
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
      const row = traceBySignature.get(stepIdentitySignature(s, anchorTurnId));
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

  async function runEmbed(
    scored: ScoredStep[],
    warnings: CaptureResult["warnings"],
    opts: { summaryOnly?: boolean } = {},
  ): Promise<{ vecs: VecPair[]; embedMs: number }> {
    const start = now();
    if (!deps.cfg.embedTraces || !deps.embedder) {
      return { vecs: scored.map(() => ({ summary: null, action: null })), embedMs: now() - start };
    }
    try {
      const vecs = await embedSteps(deps.embedder, scored, {
        stateTexts: scored.map(buildStateText),
        actionTexts: scored.map(buildActionText),
        summaryOnly: opts.summaryOnly,
      });
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

  function advanceLiteCaptureCursor(input: CaptureInput): void {
    const turnCount = input.episode.turns.length;
    try {
      deps.episodesRepo.updateMeta(input.episode.id, {
        [CAPTURE_LITE_TURN_CURSOR_META]: turnCount,
      });
      input.episode.meta = {
        ...input.episode.meta,
        [CAPTURE_LITE_TURN_CURSOR_META]: turnCount,
      };
      // Propagate into the episode manager's authoritative in-memory snapshot
      // so the next getEpisode() call returns the correct cursor and runLite
      // uses the incremental path instead of full extractSteps.
      deps.onLiteCursorAdvanced?.(input.episode.id, turnCount);
    } catch (err) {
      rootLogger.child({ channel: "core.capture" }).warn("capture.cursor_update_failed", {
        episodeId: input.episode.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function buildRows(
    scored: ScoredStep[],
    summaries: string[],
    vecs: VecPair[],
    episode: CaptureInput["episode"],
    opts: { lightweightMemory?: boolean } = {},
  ): TraceRow[] {
    const owner = ownerFromEpisode(episode);
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
      ...owner,
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
      tags: opts.lightweightMemory ? mergeTags(t.tags, ["lightweight_memory"]) : t.tags,
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
      turnId: pickTurnId(t.meta, t.ts) as EpochMs,
      schemaVersion: 1,
    }));
  }

  function buildDisplaySummaries(scored: readonly ScoredStep[]): string[] {
    return scored.map((step) => {
      const source = step.userText.trim() || step.agentText.trim();
      const singleLine = source.replace(/\s+/g, " ").trim();
      return sanitizeDerivedText(singleLine.slice(0, 140)) || "[empty step]";
    });
  }

  function ownerFromEpisode(episode: CaptureInput["episode"]) {
    const meta = episode.meta ?? {};
    const contextHints =
      meta.contextHints && typeof meta.contextHints === "object"
        ? (meta.contextHints as Record<string, unknown>)
        : {};
    return {
      ownerAgentKind: stringMeta(meta, "ownerAgentKind") ?? stringMeta(contextHints, "ownerAgentKind") ?? "unknown",
      ownerProfileId: stringMeta(meta, "ownerProfileId") ?? stringMeta(contextHints, "ownerProfileId") ?? "default",
      ownerWorkspaceId: stringMeta(meta, "ownerWorkspaceId") ?? stringMeta(contextHints, "ownerWorkspaceId") ?? null,
    };
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
    opts: { skipActionVectorRetry?: boolean } = {},
  ): Promise<boolean> {
    const anchorTurnId = resolveAnchorTurnId(input.episode);
    const existingBeforeInsert = deps.tracesRepo.listAllForEpisode(input.episode.id);
    let rowsToInsert = stripRepeatedEpisodeUserText(
      rows,
      existingBeforeInsert,
      anchorTurnId,
    );
    const seenSignatures = new Set(
      existingBeforeInsert.map((row) => traceIdentitySignature(row, anchorTurnId)),
    );
    const uniqueRows = rowsToInsert.filter((row) => {
      const signature = traceIdentitySignature(row, anchorTurnId);
      if (seenSignatures.has(signature)) return false;
      seenSignatures.add(signature);
      return true;
    });
    if (uniqueRows.length !== rowsToInsert.length) {
      warnings.push({
        stage: "persist",
        message: "skipped duplicate trace rows during capture persist",
        detail: {
          skipped: rowsToInsert.length - uniqueRows.length,
          episodeId: input.episode.id,
        },
      });
    }
    rowsToInsert = uniqueRows;

    try {
      for (const row of rowsToInsert) deps.tracesRepo.insert(row);
      rows.splice(0, rows.length, ...rowsToInsert);
      enqueueMissingTraceVectors(rows, warnings, opts);
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
    let canonicalIds: TraceId[] | null = null;
    try {
      const current = deps.episodesRepo.getById(input.episode.id) as EpisodeRow | null;
      const currentTraceIds = current?.traceIds ?? input.episode.traceIds;
      canonicalIds = reconcileTraceIds(
        [...currentTraceIds, ...rows.map((r) => r.id)],
        input.episode,
      );
      deps.episodesRepo.updateTraceIds(input.episode.id, canonicalIds);
    } catch (err) {
      warnings.push({
        stage: "persist",
        message: "failed to update episode trace_ids_json",
        detail: errDetail(err),
      });
    }
    if (canonicalIds) {
      try {
        deleteOrphanTraces(input.episode.id, canonicalIds, warnings, anchorTurnId);
      } catch (err) {
        warnings.push({
          stage: "persist",
          message: "orphan-trace cleanup failed",
          detail: errDetail(err),
        });
      }
    }
    // Manual-replay (gateway) opens the episode with a wall-clock
    // `started_at` but writes trace rows whose `ts` is the historical
    // tool-call time. Without this, the viewer shows "episode started 13:30"
    // with traces stamped 13:17, which looks like the timeline is broken.
    // Pull `started_at` back to the earliest persisted trace ts. Plain repo
    // method `setStartedAt` only moves backwards, so live episodes keep
    // their original opening time.
    try {
      const earliestTs = rows.reduce<number | null>(
        (min, r) => (min == null || r.ts < min ? r.ts : min),
        null,
      );
      if (earliestTs != null) {
        deps.episodesRepo.setStartedAt(input.episode.id, earliestTs);
      }
    } catch (err) {
      warnings.push({
        stage: "persist",
        message: "failed to backfill episode.started_at to earliest trace ts",
        detail: errDetail(err),
      });
    }
    return true;
  }

  /**
   * Remove trace rows belonging to `episodeId` that are NOT in the canonical
   * `trace_ids_json` list. Such orphans arise from earlier capture-side bugs
   * where dedup paginated to 50 rows and re-inserted everything past the cap.
   * `reconcileTraceIds` already collapses them in the in-memory id list, but
   * the underlying rows stay on disk and pollute viewer / retrieval. Logs
   * every deletion so post-incident audits can quantify the cleanup.
   */
  function deleteOrphanTraces(
    episodeId: CaptureInput["episode"]["id"],
    canonicalIds: TraceId[],
    warnings: CaptureResult["warnings"],
    anchorTurnId: number,
  ): void {
    const allRows = deps.tracesRepo.listAllForEpisode(episodeId);

    // Guard 1 — empty canonical + non-empty DB. Most likely a transient
    // `getManyByIds` failure inside `reconcileTraceIds`. Refuse to delete
    // everything; the next capture pass will reconcile correctly.
    if (canonicalIds.length === 0 && allRows.length > 0) {
      log.warn("capture.orphan_traces.skipped_empty_canonical", {
        episodeId,
        existingRowCount: allRows.length,
        reason: "canonical list empty but DB has traces — refusing to delete all",
      });
      warnings.push({
        stage: "persist",
        message: "skipped orphan cleanup: canonical list empty, DB non-empty",
        detail: { episodeId, existingRowCount: allRows.length },
      });
      return;
    }

    const canonical = new Set<string>(canonicalIds);
    const nonCanonical = allRows.filter((row) => !canonical.has(row.id));
    if (nonCanonical.length === 0) return;

    // Guard 2 — signature gate. Only delete a non-canonical row when its
    // signature is ALREADY represented by some canonical row. That row is
    // then provably a duplicate produced by the legacy pagination bug
    // (lite/reflect re-inserted past row 50). Non-canonical rows with a
    // unique signature might be legitimate steps that an earlier reconcile
    // failed to register — preserve those and log so an operator can
    // investigate / manually re-attach.
    const canonicalSignatures = new Set<string>(
      allRows
        .filter((row) => canonical.has(row.id))
        .map((row) => traceIdentitySignature(row, anchorTurnId)),
    );
    const orphans: typeof nonCanonical = [];
    const preserved: typeof nonCanonical = [];
    for (const row of nonCanonical) {
      const sig = traceIdentitySignature(row, anchorTurnId);
      if (canonicalSignatures.has(sig)) orphans.push(row);
      else preserved.push(row);
    }

    if (preserved.length > 0) {
      log.warn("capture.orphan_traces.preserved_unique", {
        episodeId,
        preservedCount: preserved.length,
        canonicalCount: canonicalIds.length,
        preservedIds: preserved.slice(0, 20).map((r) => r.id),
        truncated: preserved.length > 20,
        hint: "non-canonical rows with unique signatures kept; consider re-attaching",
      });
      warnings.push({
        stage: "persist",
        message: "preserved non-canonical traces with unique signatures",
        detail: { episodeId, preserved: preserved.length },
      });
    }

    if (orphans.length === 0) return;

    // Guard 3 — mass-delete circuit breaker. If a future bug makes most
    // rows look like duplicates, refuse to delete and force operator
    // attention. Triplet recovery on a typical episode deletes < 60% of
    // the episode (e.g. 85/178 rows = 48%).
    // Anything above 80% is suspicious enough to halt and ask.
    const totalRows = allRows.length;
    const deleteRatio = orphans.length / totalRows;
    const MAX_DELETE_RATIO = 0.8;
    if (deleteRatio > MAX_DELETE_RATIO) {
      log.error("capture.orphan_traces.refused_mass_delete", {
        episodeId,
        wouldDelete: orphans.length,
        totalRows,
        canonicalCount: canonicalIds.length,
        deleteRatio,
        threshold: MAX_DELETE_RATIO,
        sampleOrphanIds: orphans.slice(0, 20).map((r) => r.id),
      });
      warnings.push({
        stage: "persist",
        message: "refused orphan cleanup: delete ratio exceeds safety threshold",
        detail: {
          episodeId,
          wouldDelete: orphans.length,
          totalRows,
          deleteRatio,
          threshold: MAX_DELETE_RATIO,
        },
      });
      return;
    }

    log.warn("capture.orphan_traces.cleanup", {
      episodeId,
      orphanCount: orphans.length,
      canonicalCount: canonicalIds.length,
      totalRows,
      orphanIds: orphans.slice(0, 20).map((r) => r.id),
      truncated: orphans.length > 20,
    });
    let deleted = 0;
    for (const row of orphans) {
      try {
        deps.tracesRepo.deleteById(row.id);
        deleted += 1;
      } catch (err) {
        log.warn("capture.orphan_traces.delete_failed", {
          episodeId,
          traceId: row.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    warnings.push({
      stage: "persist",
      message: "deleted duplicate trace rows not in canonical list",
      detail: { episodeId, deleted, attempted: orphans.length },
    });
  }

  function reconcileTraceIds(traceIds: TraceId[], episode: CaptureInput["episode"]): TraceId[] {
    const uniqueIds = dedupeTraceIds(traceIds);
    const rowById = new Map(deps.tracesRepo.getManyByIds(uniqueIds).map((row) => [row.id, row]));
    const originalIndex = new Map(uniqueIds.map((id, idx) => [id, idx]));
    const anchorTurnId = resolveAnchorTurnId(episode);
    const stepOrder = new Map<string, number>();
    extractSteps(episode).forEach((step, idx) => {
      const signature = stepIdentitySignature(step, anchorTurnId);
      if (!stepOrder.has(signature)) stepOrder.set(signature, idx);
    });
    const seenSignatures = new Set<string>();
    return uniqueIds
      .filter((id) => rowById.has(id))
      .sort((a, b) => {
        const ai = stepOrder.get(traceIdentitySignature(rowById.get(a)!, anchorTurnId));
        const bi = stepOrder.get(traceIdentitySignature(rowById.get(b)!, anchorTurnId));
        if (ai != null && bi != null && ai !== bi) return ai - bi;
        if (ai != null && bi == null) return -1;
        if (ai == null && bi != null) return 1;
        return (originalIndex.get(a) ?? 0) - (originalIndex.get(b) ?? 0);
      })
      .filter((id) => {
        const signature = traceIdentitySignature(rowById.get(id)!, anchorTurnId);
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

  function enqueueMissingTraceVectors(
    rows: TraceRow[],
    warnings: CaptureResult["warnings"],
    opts: { skipActionVectorRetry?: boolean } = {},
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
      if (!opts.skipActionVectorRetry && !row.vecAction) {
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

  function mergeTags(existing: readonly string[], extra: readonly string[]): string[] {
    return Array.from(new Set([...existing, ...extra])).sort();
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

  return {
    runLite: (input) => withEpisodeLock(input.episode.id, () => runLite(input)),
    runLightweight: (input) => withEpisodeLock(input.episode.id, () => runLightweight(input)),
    runReflect: (input) => withEpisodeLock(input.episode.id, () => runReflect(input)),
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

async function runEpisodeBatchScoring(
  normalized: NormalizedStep[],
  llm: LlmClient | null,
  warnings: CaptureResult["warnings"],
  llmCalls: { batchedReflection: number },
  episodeId: string,
  taskSummary: string | null,
  log: Logger,
): Promise<ScoredStep[]> {
  const fallbackRelatedDefault = (): ScoredStep[] =>
    normalized.map((step) => ({
      ...step,
      reflection: {
        text: "RELATED_DEFAULT",
        alpha: 0.5,
        usable: true,
        source: "none",
        reason: "FALLBACK_RELATED_DEFAULT",
      },
    }));

  if (!llm) {
    warnings.push({
      stage: "batch",
      message: "no reflect llm; using episode-wide RELATED_DEFAULT fallback",
    });
    log.warn("reflection_fallback_related_default", {
      degraded: true,
      episodeId,
      stepsCount: normalized.length,
      failedWindows: normalized.length > 0 ? 1 : 0,
      reason: "no_llm",
    });
    return fallbackRelatedDefault();
  }

  const primary = await runWindowPass({
    normalized,
    llm,
    episodeId,
    taskSummary,
    windowSize: 20,
    overlap: 3,
    maxRetries: 1,
    warnings,
    llmCalls,
  });
  if (primary.success) return mergeWindowScores(normalized, primary.results);

  warnings.push({
    stage: "batch",
    message: "primary window pass failed; degrading to smaller windows",
    detail: { windowSize: 9, overlap: 3 },
  });

  const degraded = await runWindowPass({
    normalized,
    llm,
    episodeId,
    taskSummary,
    windowSize: 9,
    overlap: 3,
    maxRetries: 2,
    warnings,
    llmCalls,
  });
  if (degraded.success) return mergeWindowScores(normalized, degraded.results);

  log.error("reflection_fallback_related_default", {
    degraded: true,
    episodeId,
    stepsCount: normalized.length,
    failedWindows: degraded.failedWindows,
  });
  warnings.push({
    stage: "batch",
    message: "all window retries exhausted; force RELATED_DEFAULT for episode",
    detail: { failedWindows: degraded.failedWindows },
  });
  return fallbackRelatedDefault();
}

async function runWindowPass(args: {
  normalized: NormalizedStep[];
  llm: LlmClient;
  episodeId: string;
  taskSummary: string | null;
  windowSize: number;
  overlap: number;
  maxRetries: number;
  warnings: CaptureResult["warnings"];
  llmCalls: { batchedReflection: number };
}): Promise<{ success: boolean; results: Map<number, ReflectionScore[]>; failedWindows: number }> {
  const windows = buildWindows(args.normalized.length, args.windowSize, args.overlap);
  const results = new Map<number, ReflectionScore[]>();
  let failedWindows = 0;
  for (const win of windows) {
    let ok = false;
    for (let attempt = 0; attempt <= args.maxRetries; attempt++) {
      try {
        const inputs: BatchScoreInput[] = args.normalized
          .slice(win.start, win.end)
          .map((step) => ({ step }));
        const out = await batchScoreReflections(args.llm, inputs, {
          episodeId: args.episodeId,
          phase: "reflect",
          taskSummary: args.taskSummary,
        });
        args.llmCalls.batchedReflection += 1;
        results.set(win.start, out.scores);
        ok = true;
        break;
      } catch (err) {
        if (attempt === args.maxRetries) {
          args.warnings.push({
            stage: "batch",
            message: "window batch scoring failed",
            detail: { ...errDetail(err), windowStart: win.start, windowEnd: win.end, attempts: attempt + 1 },
          });
        }
      }
    }
    if (!ok) failedWindows += 1;
  }
  return { success: failedWindows === 0, results, failedWindows };
}

function mergeWindowScores(
  normalized: NormalizedStep[],
  windowScores: Map<number, ReflectionScore[]>,
): ScoredStep[] {
  const merged = new Map<number, ReflectionScore>();
  const starts = [...windowScores.keys()].sort((a, b) => a - b);
  for (const start of starts) {
    const scores = windowScores.get(start) ?? [];
    for (let i = 0; i < scores.length; i++) {
      const idx = start + i;
      const next = scores[i];
      if (!next) continue;
      const prev = merged.get(idx);
      if (!prev) {
        merged.set(idx, next);
        continue;
      }
      if (reflectionRank(next) > reflectionRank(prev)) merged.set(idx, next);
    }
  }
  return normalized.map((step, idx) => {
    const score = merged.get(idx);
    if (score) return { ...step, reflection: score };
    return {
      ...step,
      reflection: {
        text: "RELATED_DEFAULT",
        alpha: 0.5,
        usable: true,
        source: "none",
        reason: "MISSING_WINDOW_DEFAULT",
      },
    };
  });
}

function reflectionRank(score: ReflectionScore): number {
  const label = (score.text ?? "").trim();
  if (label === "PIVOTAL") return 2;
  if (label === "RELATED" || label === "RELATED_DEFAULT") return 1;
  return 0;
}

function buildWindows(length: number, windowSize: number, overlap: number): Array<{ start: number; end: number }> {
  if (length <= 0) return [];
  const out: Array<{ start: number; end: number }> = [];
  const stride = Math.max(1, windowSize - overlap);
  let start = 0;
  while (start < length) {
    const end = Math.min(length, start + windowSize);
    out.push({ start, end });
    if (end >= length) break;
    start += stride;
  }
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

function buildTaskReflectionSummary(
  episode: CaptureInput["episode"],
  steps: readonly NormalizedStep[],
  maxChars = 1_200,
): string | null {
  const firstUser = episode.turns.find((t) => t.role === "user" && t.content.trim());
  const finalAssistant = [...episode.turns]
    .reverse()
    .find((t) => t.role === "assistant" && t.content.trim());
  const toolNames = Array.from(
    new Set(steps.flatMap((s) => s.toolCalls.map((t) => t.name).filter(Boolean))),
  ).slice(0, 12);

  const parts = [
    firstUser ? `Task: ${clipForPrompt(firstUser.content, Math.min(500, maxChars))}` : "",
    `Intent: ${episode.intent.kind} (${episode.intent.reason})`,
    finalAssistant ? `Final assistant response: ${clipForPrompt(finalAssistant.content, Math.min(500, maxChars))}` : "",
    toolNames.length > 0 ? `Tools used: ${toolNames.join(", ")}` : "",
  ].filter(Boolean);

  const summary = parts.length > 0 ? parts.join("\n") : null;
  return summary ? clipForPrompt(summary, maxChars) : null;
}

function stringMeta(meta: Record<string, unknown>, key: string): string | undefined {
  const value = meta[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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

function clipForPrompt(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

function mergeTurnSteps(
  episodeId: string,
  turnId: number,
  steps: readonly StepCandidate[],
): StepCandidate {
  const ordered = [...steps].sort((a, b) => a.ts - b.ts);
  const first = ordered[0]!;
  const userText = firstNonEmpty(ordered.map((s) => s.userText));
  const agentText = ordered
    .map((s) => s.agentText.trim())
    .filter(Boolean)
    .join("\n\n");
  const agentThinking = ordered
    .map((s) => s.agentThinking?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n") || null;
  const rawReflection = firstNonEmpty(ordered.map((s) => s.rawReflection ?? ""));
  const toolCalls = ordered.flatMap((s) => s.toolCalls);
  const lastTs = ordered.reduce((m, s) => Math.max(m, s.ts), first.ts);

  return {
    key: `${episodeId}:${turnId}:lightweight`,
    ts: lastTs as EpochMs,
    userText,
    agentText,
    agentThinking,
    toolCalls,
    rawReflection: rawReflection || null,
    depth: Math.min(...ordered.map((s) => s.depth)),
    isSubagent: ordered.some((s) => s.isSubagent),
    meta: {
      ...ordered.reduce<Record<string, unknown>>(
        (acc, s) => ({ ...acc, ...s.meta }),
        {},
      ),
      turnId,
      lightweightMemory: true,
    },
  };
}

function firstNonEmpty(values: readonly string[]): string {
  return values.map((v) => v.trim()).find(Boolean) ?? "";
}
