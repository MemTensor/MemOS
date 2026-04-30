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
import { toPacket, renderSnippetForDebug } from "./injector.js";
import { llmFilterCandidates } from "./llm-filter.js";
import { rank } from "./ranker.js";
import { runTier1 } from "./tier1-skill.js";
import { runTier2 } from "./tier2-trace.js";
import { runTier3 } from "./tier3-world.js";
import type {
  EpisodeCandidate,
  RetrievalCtx,
  RetrievalDeps,
  RetrievalResult,
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
}

// ─── Entry point: turn_start ────────────────────────────────────────────────

export async function turnStartRetrieve(
  deps: RetrievalDeps,
  ctx: TurnStartRetrieveCtx,
  opts: RetrieveOptions = {},
): Promise<RetrievalResult> {
  return runAll(deps, ctx, opts, {
    wantTier1: true,
    wantTier2: true,
    wantTier3: true,
    includeLowValue: false,
    limit:
      opts.limit ??
      deps.config.tier1TopK + deps.config.tier2TopK + deps.config.tier3TopK,
  });
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
    wantTier3: true,
    includeLowValue: false,
    limit: opts.limit ?? Math.max(1, deps.config.tier2TopK),
  });
}

// ─── Entry point: skill_invoke ──────────────────────────────────────────────

export async function skillInvokeRetrieve(
  deps: RetrievalDeps,
  ctx: SkillInvokeRetrieveCtx,
  opts: RetrieveOptions = {},
): Promise<RetrievalResult> {
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
    wantTier3: true,
    includeLowValue: false,
    limit: opts.limit ?? deps.config.tier2TopK + deps.config.tier3TopK,
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
  wantTier1: boolean;
  wantTier2: boolean;
  wantTier3: boolean;
  includeLowValue: boolean;
  limit: number;
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

  const compiled = buildQuery(ctx);
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
      ? await deps.embedder.embed(compiled.text, "query").then((vec) => {
          embeddingStats.ok = true;
          return vec;
        }).catch((err) => {
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
      !!compiled.ftsMatch || (compiled.patternTerms?.length ?? 0) > 0;
    const noUsableChannel = !queryVec && !haveKeywordChannel;

    // Kick off the tiers in parallel — each resolves to its own list.
    const tier1Start = Date.now();
    const tier1Promise: Promise<SkillCandidate[]> =
      plan.wantTier1 && !noUsableChannel
        ? runTier1(
            { repos: deps.repos, config: deps.config },
            {
              kind: "embedded",
              queryVec: queryVec ?? null,
              rawText: compiled.text,
              ftsMatch: compiled.ftsMatch,
              patternTerms: compiled.patternTerms,
            },
          )
        : Promise.resolve([]);

    const tier2Start = Date.now();
    const tier2Promise: Promise<{ traces: TraceCandidate[]; episodes: EpisodeCandidate[] }> =
      plan.wantTier2 && !noUsableChannel
        ? runTier2(
            { repos: deps.repos, config: deps.config, now: deps.now },
            {
              queryVec: queryVec ?? null,
              tags: compiled.tags,
              structuralFragments: compiled.structuralFragments,
              ftsMatch: compiled.ftsMatch,
              patternTerms: compiled.patternTerms,
              includeLowValue: plan.includeLowValue,
            },
          )
        : Promise.resolve({ traces: [], episodes: [] });

    const tier3Start = Date.now();
    const tier3Promise: Promise<WorldModelCandidate[]> =
      plan.wantTier3 && !noUsableChannel
        ? runTier3(
            { repos: deps.repos, config: deps.config },
            {
              queryVec: queryVec ?? null,
              ftsMatch: compiled.ftsMatch,
              patternTerms: compiled.patternTerms,
            },
          )
        : Promise.resolve([]);

    const [tier1, tier2, tier3] = await Promise.all([
      tier1Promise,
      tier2Promise,
      tier3Promise,
    ]);

    const tier1LatencyMs = plan.wantTier1 ? Date.now() - tier1Start : 0;
    const tier2LatencyMs = plan.wantTier2 ? Date.now() - tier2Start : 0;
    const tier3LatencyMs = plan.wantTier3 ? Date.now() - tier3Start : 0;

    const fuseStart = Date.now();
    const rawCandidateCount =
      tier1.length + tier2.traces.length + tier2.episodes.length + tier3.length;
    const ranked = rank({
      tier1,
      tier2Traces: tier2.traces,
      tier2Episodes: tier2.episodes,
      tier3,
      limit: plan.limit,
      config: deps.config,
      now: deps.now(),
    });
    const fuseLatencyMs = Date.now() - fuseStart;

    // ─── LLM relevance filter ──────────────────────────────────────────
    // Mechanical retrieval produces high-recall but low-precision
    // candidates. A small LLM round-trip (see `llm-filter.ts`) prunes
    // items that share surface keywords with the query but aren't
    // actually relevant. Fails open — on any error we keep the
    // mechanical ranking.
    const queryText =
      (ctx as { userText?: string }).userText ?? compiled.text ?? "";
    const filtered = await llmFilterCandidates(
      { query: queryText, ranked: ranked.ranked },
      {
        llm: deps.llm ?? null,
        log,
        config: deps.config,
      },
    );
    log.debug("llm_filter.done", {
      outcome: filtered.outcome,
      sufficient: filtered.sufficient,
      raw: rawCandidateCount,
      afterThreshold: ranked.ranked.length,
      droppedByThreshold: ranked.droppedByThreshold,
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
    const decisionGuidance = collectDecisionGuidance({
      ranked: filtered.kept,
      repos: deps.repos,
    });
    if (
      decisionGuidance.preference.length > 0 ||
      decisionGuidance.antiPattern.length > 0
    ) {
      log.debug("decision_guidance.collected", {
        preference: decisionGuidance.preference.length,
        antiPattern: decisionGuidance.antiPattern.length,
        policyIdsTouched: decisionGuidance.policyIdsTouched.length,
      });
    }

    const { packet } = toPacket({
      ranked: filtered.kept,
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
      // descriptors + a `skill_get(...)` invocation hint instead of
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
      .map((r) => renderSnippetForDebug(r.candidate))
      .filter((s): s is NonNullable<typeof s> => s !== null);

    const stats: RetrievalStats = {
      reason: ctx.reason,
      agent,
      sessionId,
      episodeId,
      tier1Count: tier1.length,
      tier2Count: tier2.traces.length + tier2.episodes.length,
      tier3Count: tier3.length,
      tier1LatencyMs,
      tier2LatencyMs,
      tier3LatencyMs,
      fuseLatencyMs,
      totalLatencyMs: Date.now() - ts,
      queryTokens: approxTokens(compiled.text),
      queryTags: compiled.tags,
      emptyPacket: packet.snippets.length === 0,
      embedding: embeddingStats,
      rawCandidateCount,
      droppedByThresholdCount: ranked.droppedByThreshold,
      thresholdFloor: ranked.thresholdFloor,
      topRelevance: ranked.topRelevance,
      rankedCount: ranked.ranked.length,
      llmFilterOutcome: filtered.outcome,
      llmFilterSufficient: filtered.sufficient ?? undefined,
      llmFilterKept: filtered.kept.length,
      llmFilterDropped: filtered.dropped.length,
      channelHits: ranked.channelHits,
    };

    log.info("done", {
      reason: ctx.reason,
      sessionId,
      tier1: tier1.length,
      tier2: tier2.traces.length,
      tier2Ep: tier2.episodes.length,
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
