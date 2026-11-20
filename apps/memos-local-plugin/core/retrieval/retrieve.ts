/**
 * Five retrieval entry points corresponding to the V7 injection triggers
 * (ARCHITECTURE.md §4.3). Each picks the right mix of tiers + knob values:
 *
 *  ┌─────────────────┬──────────────────────────────────────────────────┐
 *  │ Trigger         │ Tiers       │ Size               │ Notes         │
 *  ├─────────────────┼─────────────┼────────────────────┼───────────────┤
 *  │ turn_start      │ 1 + 2 + 3   │ full               │ "before user" │
 *  │ tool_driven     │ 2 (+ 3)     │ shrunk             │ on memory_* call
 *  │ skill_invoke    │ 1 primary   │ shrunk             │ just-in-time  │
 *  │ sub_agent       │ 2 + 3       │ shrunk, no tier1   │ sub-agent ctx │
 *  │ decision_repair │ 1 + 2       │ includeLowValue=ON │ unblock loops │
 *  └─────────────────┴─────────────┴────────────────────┴───────────────┘
 *
 * Each entry is a pure async function: it does storage reads, zero writes.
 * Events (`retrieval.started/.done/.failed`) are emitted via the provided
 * bus so callers can stream packets to the viewer or persist audit trails.
 */

import type {
  InjectionPacket,
  EpochMs,
  AgentKind,
  SessionId,
  EpisodeId,
  RetrievalReason,
} from "../../agent-contract/dto.js";
import { ERROR_CODES } from "../../agent-contract/errors.js";
import { ids } from "../id.js";
import { rootLogger } from "../logger/index.js";
import { collectDecisionGuidance } from "./decision-guidance.js";
import { buildQuery, type CompiledQuery } from "./query-builder.js";
import type { RetrievalEventBus } from "./events.js";
import { dedupeTraceEpisodeByEpisodeId } from "./dedupe-trace-episode.js";
import { toPacket, renderSnippetForDebug } from "./injector.js";
import { llmFilterCandidates } from "./llm-filter.js";
import { rank } from "./ranker.js";
import { runTier1 } from "./tier1-skill.js";
import { runTier2Experience } from "./tier2-experience.js";
import { runTier2, type Tier2Input } from "./tier2-trace.js";
import { runTier3 } from "./tier3-world.js";
import type {
  EpisodeCandidate,
  ExperienceCandidate,
  RetrievalCtx,
  RetrievalDeps,
  RetrievalResult,
  RetrievalProfile,
  RetrievalStats,
  SkillCandidate,
  TraceCandidate,
  WorldModelCandidate,
} from "./types.js";

const log = rootLogger.child({ channel: "core.retrieval" });

// ─── Extra context shapes (narrowed aliases for strongly-typed entries) ─────

export type TurnStartRetrieveCtx = Extract<RetrievalCtx, { reason: "turn_start" }>;
export type ToolDrivenRetrieveCtx = Extract<RetrievalCtx, { reason: "tool_driven" }>;
export type SkillInvokeRetrieveCtx = Extract<RetrievalCtx, { reason: "skill_invoke" }>;
export type SubAgentRetrieveCtx = Extract<RetrievalCtx, { reason: "sub_agent" }>;
export type RepairRetrieveCtx = Extract<RetrievalCtx, { reason: "decision_repair" }>;

export interface RetrieveOptions {
  /** Event bus for `retrieval.*` events (optional — tests pass none). */
  events?: RetrievalEventBus;
  /** Override `limit` default (tier totals honored when unspecified). */
  limit?: number;
  /** Turn-start scheduler override. V1 uses this for intent tier gating. */
  plan?: RetrievePlanOverride;
  /**
   * Return mechanically ranked candidates without the local LLM pass.
   * Used when the caller will merge another retrieval route, then run
   * one unified final LLM filter across all routes.
   */
  skipLlmFilter?: boolean;
  /** Shared foreground cancellation signal. */
  signal?: AbortSignal;
  /** Absolute request deadline used to cap optional LLM filtering. */
  deadlineAt?: number;
  /** Per-request malformed-JSON retry policy for the LLM relevance filter. */
  llmFilterMalformedRetries?: number;
}

export interface RetrievePlanOverride {
  scenarioId?: string;
  profile?: RetrievalProfile;
  wantTier1?: boolean;
  wantTier2?: boolean;
  wantTier3?: boolean;
  limit?: number;
}

// ─── Entry point: turn_start ────────────────────────────────────────────────

export async function turnStartRetrieve(
  deps: RetrievalDeps,
  ctx: TurnStartRetrieveCtx,
  opts: RetrieveOptions = {},
): Promise<RetrievalResult> {
  if (deps.config.lightweightMemory) {
    return runAll(deps, ctx, opts, applyPlanOverride({
      wantTier1: false,
      wantTier2: true,
      wantTier3: false,
      includeLowValue: false,
      limit: opts.limit ?? Math.max(1, deps.config.tier2TopK),
      traceOnly: true,
    }, opts.plan));
  }
  return runAll(deps, ctx, opts, applyPlanOverride({
    wantTier1: true,
    wantTier2: true,
    wantTier3: true,
    includeLowValue: deps.config.includeLowValue,
    limit:
      opts.limit ??
      deps.config.tier1TopK + deps.config.tier2TopK + deps.config.tier3TopK,
  }, opts.plan));
}

// ─── Entry point: tool_driven ───────────────────────────────────────────────

export async function toolDrivenRetrieve(
  deps: RetrievalDeps,
  ctx: ToolDrivenRetrieveCtx,
  opts: RetrieveOptions = {},
): Promise<RetrievalResult> {
  // Tool-driven retrievals are smaller — we've already spent a turn budget;
  // we only mine Tier 2 (+ optional Tier 3 if vec available). Tier-1 is
  // skipped to avoid re-injecting skills the agent already saw at turn_start.
  return runAll(deps, ctx, opts, {
    wantTier1: false,
    wantTier2: true,
    wantTier3: deps.config.lightweightMemory ? false : true,
    includeLowValue: deps.config.includeLowValue,
    limit: opts.limit ?? Math.max(1, deps.config.tier2TopK),
    traceOnly: deps.config.lightweightMemory,
  });
}

// ─── Entry point: skill_invoke ──────────────────────────────────────────────

export async function skillInvokeRetrieve(
  deps: RetrievalDeps,
  ctx: SkillInvokeRetrieveCtx,
  opts: RetrieveOptions = {},
): Promise<RetrievalResult> {
  if (deps.config.lightweightMemory) {
    return runAll(deps, ctx, opts, {
      wantTier1: false,
      wantTier2: true,
      wantTier3: false,
      includeLowValue: false,
      limit: opts.limit ?? Math.max(1, deps.config.tier2TopK),
      traceOnly: true,
    });
  }
  // Just-in-time: the agent is about to execute a named Skill. We want
  // (a) the actual Skill's invocation guide if still fresh, and (b) a
  // handful of trace hits to double-check it's the right call.
  return runAll(deps, ctx, opts, {
    wantTier1: true,
    wantTier2: true,
    wantTier3: false,
    includeLowValue: false,
    limit: opts.limit ?? Math.max(1, deps.config.tier1TopK + 2),
  });
}

// ─── Entry point: sub_agent ─────────────────────────────────────────────────

export async function subAgentRetrieve(
  deps: RetrievalDeps,
  ctx: SubAgentRetrieveCtx,
  opts: RetrieveOptions = {},
): Promise<RetrievalResult> {
  return runAll(deps, ctx, opts, {
    wantTier1: false,
    wantTier2: true,
    wantTier3: deps.config.lightweightMemory ? false : true,
    includeLowValue: false,
    limit: opts.limit ?? deps.config.tier2TopK + deps.config.tier3TopK,
    traceOnly: deps.config.lightweightMemory,
  });
}

// ─── Entry point: decision_repair ───────────────────────────────────────────

export async function repairRetrieve(
  deps: RetrievalDeps,
  ctx: RepairRetrieveCtx,
  opts: RetrieveOptions = {},
): Promise<RetrievalResult | null> {
  // Only kicks in after we've hit `failureCount ≥ threshold`. The packet
  // may be `null` when we have no relevant history — callers should treat
  // that as "don't inject anything".
  if (deps.config.lightweightMemory) return null;
  if (ctx.failureCount <= 0) return null;
  const result = await runAll(deps, ctx, opts, {
    wantTier1: true,
    wantTier2: true,
    wantTier3: false,
    includeLowValue: true, // anti-patterns live at priority=0
    limit: opts.limit ?? deps.config.tier1TopK + deps.config.tier2TopK,
  });
  if (result.stats.emptyPacket) return null;
  return result;
}

// ─── Shared pipeline ────────────────────────────────────────────────────────

interface RunPlan {
  scenarioId?: string;
  profile?: RetrievalProfile;
  wantTier1: boolean;
  wantTier2: boolean;
  wantTier3: boolean;
  includeLowValue: boolean;
  limit: number;
  traceOnly?: boolean;
}

function applyPlanOverride(plan: RunPlan, override?: RetrievePlanOverride): RunPlan {
  if (!override) return plan;
  return {
    ...plan,
    scenarioId: override.scenarioId ?? plan.scenarioId,
    profile: override.profile ?? plan.profile,
    wantTier1: override.wantTier1 ?? plan.wantTier1,
    wantTier2: override.wantTier2 ?? plan.wantTier2,
    wantTier3: override.wantTier3 ?? plan.wantTier3,
    limit: override.limit ?? plan.limit,
  };
}

async function runAll(
  deps: RetrievalDeps,
  ctx: RetrievalCtx,
  opts: RetrieveOptions,
  plan: RunPlan,
): Promise<RetrievalResult> {
  const agent = (ctx as { agent?: AgentKind }).agent ?? "openclaw";
  const sessionId = (ctx as { sessionId: SessionId }).sessionId;
  const episodeId = (ctx as { episodeId?: EpisodeId }).episodeId;
  const ts = deps.now();

  const compiled = buildQuery(ctx, { ftsTokenizer: deps.config.ftsTokenizer });
  opts.events?.emit({
    kind: "retrieval.started",
    reason: ctx.reason,
    agent,
    sessionId,
    episodeId,
    queryTags: compiled.tags,
    ts,
  });

  try {
    const embeddingStats: RetrievalStats["embedding"] = {
      attempted: compiled.text.length > 0,
      ok: false,
      degraded: false,
    };
    const queryVec = compiled.text
      ? await deps.embedder
          .embed(compiled.text, "query", {
            signal: opts.signal,
            deadlineAt: opts.deadlineAt,
          })
          .then((vec) => {
            embeddingStats.ok = true;
            return vec;
          })
          .catch((err) => {
            const code = (err as { code?: string })?.code;
            const message = err instanceof Error ? err.message : String(err);
            embeddingStats.degraded = true;
            embeddingStats.errorCode = code;
            embeddingStats.errorMessage = message;
            log.warn("embed_failed", {
              reason: ctx.reason,
              code,
              err: message,
            });
            return null;
          })
      : null;

    // The keyword channels (FTS + pattern) work even without an embedder,
    // so we no longer short-circuit on `emptyVec`. We only require *some*
    // channel to be armed.
    const haveKeywordChannel =
      !!compiled.ftsMatch ||
      compiled.patternTerms.length > 0 ||
      compiled.exactIdentifiers.length > 0;
    const noUsableChannel = !queryVec && !haveKeywordChannel;

    // Kick off the tiers in parallel — each resolves to its own list.
    const wantTier1 = plan.wantTier1 && deps.config.tier1TopK > 0;
    const wantTier2 = plan.wantTier2 && deps.config.tier2TopK > 0;
    const wantTier3 = plan.wantTier3 && deps.config.tier3TopK > 0;
    const profile = plan.profile ?? "default";
    const traceOnly =
      plan.traceOnly === true ||
      deps.config.lightweightMemory === true ||
      profile === "personal_fact";

    const tier1Start = Date.now();
    const tier1Promise: Promise<SkillCandidate[]> =
      wantTier1 && !noUsableChannel
        ? runTier1(
            { repos: deps.repos, config: deps.config },
            {
              kind: "embedded",
              queryVec: queryVec ?? null,
              rawText: compiled.text,
              ftsMatch: compiled.ftsMatch,
              patternTerms: compiled.patternTerms,
              exactIdentifiers: compiled.exactIdentifiers,
            },
          )
        : Promise.resolve([]);

    const tier2Start = Date.now();
    const currentVisibleContext = resolveVisibleContext(ctx, sessionId, deps.config);
    const tier2Promise: Promise<{ traces: TraceCandidate[]; episodes: EpisodeCandidate[] }> =
      wantTier2 && !noUsableChannel
        ? runTier2(
            { repos: deps.repos, config: deps.config, now: deps.now },
            {
              queryVec: queryVec ?? null,
              tags: compiled.tags,
              structuralFragments: compiled.structuralFragments,
              ftsMatch: compiled.ftsMatch,
              patternTerms: compiled.patternTerms,
              exactIdentifiers: compiled.exactIdentifiers,
              profile,
              includeLowValue: plan.includeLowValue,
              ...currentVisibleContext,
            },
          )
        : Promise.resolve({ traces: [], episodes: [] });

    const tier2ExperiencePromise: Promise<ExperienceCandidate[]> =
      wantTier2 && !traceOnly && !noUsableChannel
        ? runTier2Experience(
            { repos: deps.repos, config: deps.config },
            {
              queryVec,
              ftsMatch: compiled.ftsMatch,
              patternTerms: compiled.patternTerms,
              exactIdentifiers: compiled.exactIdentifiers,
            },
          )
        : Promise.resolve([]);

    const tier3Start = Date.now();
    const tier3Promise: Promise<WorldModelCandidate[]> =
      wantTier3 && !noUsableChannel
        ? runTier3(
            { repos: deps.repos, config: deps.config },
            {
              queryVec: queryVec ?? null,
              ftsMatch: compiled.ftsMatch,
              patternTerms: compiled.patternTerms,
              exactIdentifiers: compiled.exactIdentifiers,
            },
          )
        : Promise.resolve([]);

    const [tier1, tier2, tier2Experiences, tier3] = await Promise.all([
      tier1Promise,
      tier2Promise,
      tier2ExperiencePromise,
      tier3Promise,
    ]);

    const tier1LatencyMs = wantTier1 ? Date.now() - tier1Start : 0;
    let tier2LatencyMs = wantTier2 ? Date.now() - tier2Start : 0;
    const tier3LatencyMs = wantTier3 ? Date.now() - tier3Start : 0;

    const fuseStart = Date.now();
    let activeTier2 = tier2;
    let rawCandidateCount =
      tier1.length +
      activeTier2.traces.length +
      activeTier2.episodes.length +
      tier2Experiences.length +
      tier3.length;
    const exactIdentifiers =
      ctx.reason === "decision_repair" ? [] : compiled.exactIdentifiers;
    let ranked = rank({
      tier1,
      tier2Traces: activeTier2.traces,
      tier2Episodes: traceOnly ? [] : activeTier2.episodes,
      tier2Experiences,
      tier3,
      limit: plan.limit,
      config: deps.config,
      now: deps.now(),
      profile,
      exactIdentifiers,
    });
    let mechanicalRanked = ranked.ranked;
    let fuseLatencyMs = Date.now() - fuseStart;

    // ─── LLM relevance filter ──────────────────────────────────────────
    // Mechanical retrieval produces high-recall but low-precision
    // candidates. A small LLM round-trip (see `llm-filter.ts`) prunes
    // items that share surface keywords with the query but aren't
    // actually relevant. If the LLM is unavailable, the filter helper
    // keeps the mechanical ranking so local lightweight memories remain
    // searchable in offline/default installs.
    const queryText = (ctx as { userText?: string }).userText ?? compiled.text ?? "";
    let filterResult = opts.skipLlmFilter
      ? {
          kept: mechanicalRanked,
          dropped: [],
          outcome: "deferred_to_final" as const,
          sufficient: null,
        }
      : await llmFilterCandidates(
          { query: queryText, ranked: mechanicalRanked, episodeId, profile },
          {
            llm: deps.llm ?? null,
            log,
            config: deps.config,
            signal: opts.signal,
            deadlineAt: opts.deadlineAt,
            timeoutMs: filterTimeoutMs(opts.deadlineAt),
            malformedRetries: opts.llmFilterMalformedRetries,
          },
        );

    let retrievalPasses = 1;
    if (
      profile === "personal_fact" &&
      filterResult.kept.length === 0 &&
      (filterResult.outcome === "llm_filtered_empty" ||
        mechanicalRanked.length === 0) &&
      wantTier2 &&
      queryVec &&
      !opts.skipLlmFilter
    ) {
      const wideningStartedAt = Date.now();
      const widenedTier2 = await runTier2(
        { repos: deps.repos, config: deps.config, now: deps.now },
        {
          queryVec,
          tags: compiled.tags,
          structuralFragments: compiled.structuralFragments,
          ftsMatch: compiled.ftsMatch,
          patternTerms: compiled.patternTerms,
          exactIdentifiers: compiled.exactIdentifiers,
          profile,
          includeActionVector: true,
          includeLowValue: plan.includeLowValue,
          ...currentVisibleContext,
        },
      );
      tier2LatencyMs += Date.now() - wideningStartedAt;

      const wideningFuseStartedAt = Date.now();
      const widenedRanked = rank({
        tier1: [],
        tier2Traces: widenedTier2.traces,
        tier2Episodes: [],
        tier2Experiences: [],
        tier3: [],
        limit: plan.limit,
        config: deps.config,
        now: deps.now(),
        profile,
        exactIdentifiers,
      });
      const widenedMechanical = widenedRanked.ranked;
      fuseLatencyMs += Date.now() - wideningFuseStartedAt;
      const widenedFilter = await llmFilterCandidates(
        {
          query: queryText,
          ranked: widenedMechanical,
          episodeId,
          profile,
        },
        {
          llm: deps.llm ?? null,
          log,
          config: deps.config,
          signal: opts.signal,
          deadlineAt: opts.deadlineAt,
          timeoutMs: filterTimeoutMs(opts.deadlineAt),
          malformedRetries: opts.llmFilterMalformedRetries,
        },
      );

      activeTier2 = widenedTier2;
      ranked = widenedRanked;
      mechanicalRanked = widenedMechanical;
      filterResult = widenedFilter;
      rawCandidateCount = widenedTier2.traces.length;
      retrievalPasses = 2;
      log.debug("retrieval.widened", {
        profile,
        pass: retrievalPasses,
        actionChannel: true,
        candidates: rawCandidateCount,
        outcome: widenedFilter.outcome,
      });
    }
    const filtered = filterResult;
    for (const candidate of mechanicalRanked) {
      log.debug("rank.candidate", {
        refKind: candidate.candidate.refKind,
        refId: candidate.candidate.refId,
        ...candidate.scoreDetails,
      });
    }
    log.debug("llm_filter.done", {
      outcome: filtered.outcome,
      enforced: false,
      sufficient: filtered.sufficient,
      raw: rawCandidateCount,
      afterThreshold: mechanicalRanked.length,
      droppedByThreshold: ranked.droppedByThreshold,
      dedupedBeforeMmr: ranked.dedupedBeforeMmr,
      dedupedAfterThreshold: ranked.dedupedAfterThreshold,
      droppedByKeywordConfirmation: ranked.droppedByKeywordConfirmation,
      thresholdFloor: round(ranked.thresholdFloor, 3),
      topRelevance: round(ranked.topRelevance, 3),
      kept: filtered.kept.length,
      dropped: filtered.dropped.length,
      channels: ranked.channelHits,
    });

    // V7 §2.4.6 — gather preference / anti-pattern from policies that
    // share evidence with what we just retrieved. Cheap (one bounded
    // scan of active policies) and produces nothing when there's
    // nothing to say, so it's safe to call unconditionally here.
    const { ranked: dedupedKept, dedupedByEpisodeCount } =
      dedupeTraceEpisodeByEpisodeId(filtered.kept);

    const decisionGuidance = traceOnly
      ? undefined
      : collectDecisionGuidance({
          ranked: dedupedKept,
          repos: deps.repos,
        });
    if (
      decisionGuidance &&
      (decisionGuidance.preference.length > 0 ||
        decisionGuidance.antiPattern.length > 0)
    ) {
      log.debug("decision_guidance.collected", {
        preference: decisionGuidance.preference.length,
        antiPattern: decisionGuidance.antiPattern.length,
        policyIdsTouched: decisionGuidance.policyIdsTouched.length,
      });
    }

    const { packet } = toPacket({
      ranked: dedupedKept,
      reason: ctx.reason,
      tierLatencyMs: {
        tier1: tier1LatencyMs,
        tier2: tier2LatencyMs,
        tier3: tier3LatencyMs,
      },
      now: deps.now(),
      // Fall back to synthetic ids when a retrieval entry point was
      // invoked outside a live turn (CLI preview, tests). The runtime
      // orchestrator overwrites these via `stamped` before the packet
      // reaches the adapter.
      sessionId: sessionId ?? (`adhoc-session-${ids.span()}` as SessionId),
      episodeId: episodeId ?? (`adhoc-episode-${ids.span()}` as EpisodeId),
      // V7 §2.6 — Tier-1 default = "summary" so we surface skill
      // descriptors + a `memos_skill_get(...)` invocation hint instead of
      // inlining every full guide. Hosts without tool support can flip
      // this to "full" via `algorithm.retrieval.skillInjectionMode`.
      skillInjectionMode: deps.config.skillInjectionMode,
      skillSummaryChars: deps.config.skillSummaryChars,
      decisionGuidance,
    });
    // Surface the dropped-by-LLM candidates so the Logs page can show
    // "initial N → kept M" without the viewer having to re-run the
    // mechanical pipeline.
    packet.droppedByLlm = filtered.dropped
      .map((r) => {
        const snippet = renderSnippetForDebug(r.candidate);
        if (snippet) {
          snippet.score = round(r.score, 4);
          snippet.scoreDetails = r.scoreDetails;
        }
        return snippet;
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);

    const stats: RetrievalStats = {
      reason: ctx.reason,
      scenarioId: plan.scenarioId,
      profile,
      retrievalPasses,
      agent,
      sessionId,
      episodeId,
      plannedTiers: {
        tier1: plan.wantTier1,
        tier2: plan.wantTier2,
        tier3: plan.wantTier3,
      },
      tier1Count: tier1.length,
      tier2Count:
        activeTier2.traces.length +
        (traceOnly ? 0 : activeTier2.episodes.length) +
        tier2Experiences.length,
      tier3Count: tier3.length,
      tier1LatencyMs,
      tier2LatencyMs,
      tier3LatencyMs,
      fuseLatencyMs,
      totalLatencyMs: Date.now() - ts,
      queryTokens: approxTokens(compiled.text),
      queryTags: compiled.tags,
      exactIdentifierCount: compiled.exactIdentifiers.length,
      emptyPacket: packet.snippets.length === 0,
      embedding: embeddingStats,
      rawCandidateCount,
      droppedByThresholdCount: ranked.droppedByThreshold,
      dedupedBeforeMmrCount: ranked.dedupedBeforeMmr,
      dedupedAfterThresholdCount: ranked.dedupedAfterThreshold,
      droppedByKeywordConfirmationCount:
        ranked.droppedByKeywordConfirmation,
      thresholdFloor: ranked.thresholdFloor,
      topRelevance: ranked.topRelevance,
      rankedCount: mechanicalRanked.length,
      llmFilterOutcome: filtered.outcome,
      llmFilterSufficient: filtered.sufficient ?? undefined,
      llmFilterKept: filtered.kept.length,
      llmFilterDropped: filtered.dropped.length,
      dedupedByEpisodeCount:
        dedupedByEpisodeCount > 0 ? dedupedByEpisodeCount : undefined,
      channelHits: ranked.channelHits,
    };

    log.info("done", {
      reason: ctx.reason,
      sessionId,
      tier1: tier1.length,
      tier2: activeTier2.traces.length,
      tier2Ep: traceOnly ? 0 : activeTier2.episodes.length,
      tier2Experience: tier2Experiences.length,
      tier3: tier3.length,
      kept: packet.snippets.length,
      totalMs: stats.totalLatencyMs,
    });

    opts.events?.emit({
      kind: "retrieval.done",
      reason: ctx.reason,
      agent,
      sessionId,
      episodeId,
      packet,
      stats,
      ts: deps.now(),
    });

    return { packet, stats };
  } catch (err) {
    const code = (err as { code?: string })?.code ?? ERROR_CODES.INTERNAL;
    const message = err instanceof Error ? err.message : String(err);
    log.error("failed", {
      reason: ctx.reason,
      sessionId,
      err: { code, message },
    });
    opts.events?.emit({
      kind: "retrieval.failed",
      reason: ctx.reason,
      agent,
      sessionId,
      episodeId,
      error: { code, message },
      ts: deps.now(),
    });
    return emptyResult(ctx.reason, agent, sessionId, episodeId, ts, deps.now());
  }
}

function filterTimeoutMs(deadlineAt?: number): number | undefined {
  if (deadlineAt === undefined) return undefined;
  return Math.max(1, Math.min(2_000, deadlineAt - Date.now()));
}

function emptyResult(
  reason: RetrievalReason,
  agent: AgentKind,
  sessionId: SessionId,
  episodeId: EpisodeId | undefined,
  startedAt: EpochMs,
  finishedAt: EpochMs,
): RetrievalResult {
  return {
    packet: {
      reason,
      snippets: [],
      rendered: "",
      tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
      packetId: `empty-${startedAt}`,
      ts: finishedAt,
      sessionId,
      episodeId: episodeId ?? (`adhoc-episode-${ids.span()}` as EpisodeId),
    },
    stats: {
      reason,
      agent,
      sessionId,
      episodeId,
      tier1Count: 0,
      tier2Count: 0,
      tier3Count: 0,
      tier1LatencyMs: 0,
      tier2LatencyMs: 0,
      tier3LatencyMs: 0,
      fuseLatencyMs: 0,
      totalLatencyMs: finishedAt - startedAt,
      queryTokens: 0,
      queryTags: [],
      emptyPacket: true,
      embedding: { attempted: false, ok: false, degraded: false },
    },
  };
}

function approxTokens(s: string): number {
  if (!s) return 0;
  return Math.ceil(s.length / 4);
}

function resolveVisibleContext(
  ctx: RetrievalCtx,
  sessionId: SessionId | undefined,
  config: RetrievalDeps["config"],
): Pick<Tier2Input, "visibleContext" | "excludeSessionId"> {
  if (
    ctx.reason !== "turn_start" ||
    !sessionId ||
    config.lightweightMemory
  ) {
    return {};
  }

  const hints = ctx.contextHints;
  if (hints?.visibleContextKnown !== true) {
    // Backward compatibility for adapters that cannot yet report the
    // model-visible window. This preserves the old no-repeat behaviour
    // instead of guessing that the session has been compacted.
    return { excludeSessionId: sessionId };
  }

  const rawStartTs = hints.visibleContextStartTs;
  const startTs =
    typeof rawStartTs === "number" && Number.isFinite(rawStartTs)
      ? rawStartTs
      : undefined;
  const userTexts = Array.isArray(hints.visibleContextUserTexts)
    ? hints.visibleContextUserTexts
        .filter((text): text is string => typeof text === "string")
        .map((text) => text.trim())
        .filter(Boolean)
        .slice(-128)
    : [];

  return {
    visibleContext: {
      sessionId,
      ...(startTs !== undefined ? { startTs } : {}),
      ...(userTexts.length > 0 ? { userTexts } : {}),
    },
  };
}

function round(n: number, d: number): number {
  if (!Number.isFinite(n)) return n;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/** Thin façade so pipelines can `new Retriever(deps)` if they prefer OO. */
export class Retriever {
  constructor(private readonly deps: RetrievalDeps) {}

  turnStart(ctx: TurnStartRetrieveCtx, opts?: RetrieveOptions) {
    return turnStartRetrieve(this.deps, ctx, opts);
  }
  toolDriven(ctx: ToolDrivenRetrieveCtx, opts?: RetrieveOptions) {
    return toolDrivenRetrieve(this.deps, ctx, opts);
  }
  skillInvoke(ctx: SkillInvokeRetrieveCtx, opts?: RetrieveOptions) {
    return skillInvokeRetrieve(this.deps, ctx, opts);
  }
  subAgent(ctx: SubAgentRetrieveCtx, opts?: RetrieveOptions) {
    return subAgentRetrieve(this.deps, ctx, opts);
  }
  repair(ctx: RepairRetrieveCtx, opts?: RetrieveOptions) {
    return repairRetrieve(this.deps, ctx, opts);
  }
}
