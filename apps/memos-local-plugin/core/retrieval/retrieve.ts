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
import {
  buildQueryWithExtract,
  extractRepairTaskSection,
  isRepositoryRepairPrompt,
  rawQueryText,
  type CompiledQuery,
} from "./query-builder.js";
import { extractRetrievalQueryWithLlm } from "./query-extract.js";
import type { RetrievalEventBus } from "./events.js";
import { dedupeTraceEpisodeByEpisodeId } from "./dedupe-trace-episode.js";
import { toPacket, renderSnippetForDebug } from "./injector.js";
import { llmFilterCandidates } from "./llm-filter.js";
import {
  isStandaloneMathFinalAnswerTask,
  renderMathFinalAnswerProtocol,
  STANDALONE_MATH_FINAL_ANSWER_TASK_KIND,
} from "./math-task.js";
import { rank, type RankedCandidate } from "./ranker.js";
import { runTier1 } from "./tier1-skill.js";
import { runTier2Experience } from "./tier2-experience.js";
import { runTier2 } from "./tier2-trace.js";
import { runTier3 } from "./tier3-world.js";
import type {
  EpisodeCandidate,
  ExperienceCandidate,
  RetrievalCtx,
  RetrievalDeps,
  RetrievalResult,
  RetrievalStats,
  SkillCandidate,
  TraceCandidate,
  WorldModelCandidate,
} from "./types.js";

const log = rootLogger.child({ channel: "core.retrieval" });
const RETRIEVAL_QUERY_EXTRACT_TIMEOUT_MS = 5_000;

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
}

export function taskProtocolOnlyPacket(
  ctx: TurnStartRetrieveCtx,
  now: EpochMs,
): InjectionPacket | null {
  const taskProtocol = renderTaskProtocol(ctx);
  if (!taskProtocol) return null;
  const { packet } = toPacket({
    ranked: [],
    reason: "turn_start",
    tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
    now,
    sessionId: ctx.sessionId,
    episodeId: ctx.episodeId ?? (`adhoc-episode-${ids.span()}` as EpisodeId),
    taskProtocol,
  });
  return packet;
}

export interface RetrievePlanOverride {
  scenarioId?: string;
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

  const rawQuery = rawQueryText(ctx);
  const llmExtract = await extractRetrievalQueryWithLlm(rawQuery, {
    llm: deps.llm ?? null,
    log,
    episodeId,
    timeoutMs: RETRIEVAL_QUERY_EXTRACT_TIMEOUT_MS,
  });
  const compiled = buildQueryWithExtract(ctx, llmExtract);
  const taskProtocol = renderTaskProtocol(ctx);
  const standaloneMathFinalAnswer = isStandaloneMathFinalAnswerContext(ctx);
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
    const wantTier1 = plan.wantTier1 && deps.config.tier1TopK > 0;
    const wantTier2 = plan.wantTier2 && deps.config.tier2TopK > 0;
    const wantTier3 = plan.wantTier3 && deps.config.tier3TopK > 0;
    const traceOnly = plan.traceOnly === true || deps.config.lightweightMemory === true;

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
            },
          )
        : Promise.resolve([]);

    const tier2Start = Date.now();
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
              includeLowValue: plan.includeLowValue,
              excludeSessionId:
                sessionId && !deps.config.lightweightMemory
                  ? sessionId
                  : undefined,
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
    const tier2LatencyMs = wantTier2 ? Date.now() - tier2Start : 0;
    const tier3LatencyMs = wantTier3 ? Date.now() - tier3Start : 0;

    const fuseStart = Date.now();
    const rawCandidateCount =
      tier1.length +
      tier2.traces.length +
      tier2.episodes.length +
      tier2Experiences.length +
      tier3.length;
    const ranked = rank({
      tier1,
      tier2Traces: tier2.traces,
      tier2Episodes: traceOnly ? [] : tier2.episodes,
      tier2Experiences,
      tier3,
      limit: plan.limit,
      config: deps.config,
      now: deps.now(),
    });
    const mechanicalRanked = ctx.reason !== "decision_repair" &&
      requiresKeywordConfirmation(compiled.text)
      ? ranked.ranked.filter((candidate) =>
          bypassesKeywordConfirmation(candidate) || hasKeywordChannel(candidate)
        )
      : ranked.ranked;
    const fuseLatencyMs = Date.now() - fuseStart;

    // ─── LLM relevance filter ──────────────────────────────────────────
    // Mechanical retrieval produces high-recall but low-precision
    // candidates. A small LLM round-trip (see `llm-filter.ts`) prunes
    // items that share surface keywords with the query but aren't
    // actually relevant. If the LLM is unavailable, the filter helper
    // keeps the mechanical ranking so local lightweight memories remain
    // searchable in offline/default installs.
    const queryText = compiled.text || ((ctx as { userText?: string }).userText ?? "");
    const filterResult = opts.skipLlmFilter
      ? {
          kept: mechanicalRanked,
          dropped: [],
          outcome: "deferred_to_final" as const,
          sufficient: null,
        }
      : await llmFilterCandidates(
          { query: queryText, ranked: mechanicalRanked, episodeId },
          {
            llm: deps.llm ?? null,
            log,
            config: deps.config,
          },
        );
    const filtered = filterResult;
    log.debug("llm_filter.done", {
      outcome: filtered.outcome,
      enforced: false,
      sufficient: filtered.sufficient,
      raw: rawCandidateCount,
      afterThreshold: mechanicalRanked.length,
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
      standaloneMathFinalAnswer,
      taskProtocol,
      currentTaskText: queryText,
    });
    // Surface the dropped-by-LLM candidates so the Logs page can show
    // "initial N → kept M" without the viewer having to re-run the
    // mechanical pipeline.
    packet.droppedByLlm = filtered.dropped
      .map((r) => renderSnippetForDebug(r.candidate))
      .filter((s): s is NonNullable<typeof s> => s !== null);

    const stats: RetrievalStats = {
      reason: ctx.reason,
      scenarioId: plan.scenarioId,
      agent,
      sessionId,
      episodeId,
      plannedTiers: {
        tier1: plan.wantTier1,
        tier2: plan.wantTier2,
        tier3: plan.wantTier3,
      },
      tier1Count: tier1.length,
      tier2Count: tier2.traces.length + (traceOnly ? 0 : tier2.episodes.length) + tier2Experiences.length,
      tier3Count: tier3.length,
      tier1LatencyMs,
      tier2LatencyMs,
      tier3LatencyMs,
      fuseLatencyMs,
      totalLatencyMs: Date.now() - ts,
      queryTokens: approxTokens(compiled.text),
      queryTags: compiled.tags,
      emptyPacket: packet.rendered.trim().length === 0,
      embedding: embeddingStats,
      rawCandidateCount,
      droppedByThresholdCount: ranked.droppedByThreshold,
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
      tier2: tier2.traces.length,
      tier2Ep: traceOnly ? 0 : tier2.episodes.length,
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

function isStandaloneMathFinalAnswerContext(ctx: RetrievalCtx): boolean {
  if (ctx.reason !== "turn_start") return false;
  const hints = (ctx as { contextHints?: Record<string, unknown> }).contextHints;
  return hints?.taskKind === STANDALONE_MATH_FINAL_ANSWER_TASK_KIND;
}

function renderTaskProtocol(ctx: RetrievalCtx): string | null {
  if (ctx.reason !== "turn_start") return null;
  const userText = (ctx as { userText?: string }).userText;
  if (isStandaloneMathFinalAnswerTask(userText)) {
    return renderMathFinalAnswerProtocol(userText);
  }
  if (!isRepositoryRepairPrompt(userText)) return null;
  const runtime = inferRepairRuntime(userText);
  const shellPrefix = renderRunCommand(runtime, "...");
  const writePrefix = renderWriteCommand(runtime, "path/to/file", "EOF");
  const editScriptPrefix = renderWriteCommand(runtime, runtime.editScriptPath, "PY");
  const patchReadinessGate = renderPatchReadinessGate(runtime);
  const visibleIssueContext = renderVisibleRepairContext(userText, runtime);
  const genericDefectContext = renderGenericDefectContext(userText);
  const hintDigest = renderRepairHintContext(userText, runtime);
  const protocol = [
    "## Repository repair task protocol",
    "",
    "This is a repository repair task. Recalled memories are advisory; the current repository state and current prompt win.",
    "",
    "### Runtime conventions",
    `- Command wrapper: \`${runtime.wrapperRef}\` (${runtime.wrapperSource}).`,
    `- Run command form: \`${renderRunCommand(runtime, "command", "10")}\`.`,
    `- Write command form: \`${writePrefix}\`.`,
    runtime.repoRoot
      ? `- Repository root from the current prompt: \`${runtime.repoRoot}\`; include \`cd ${runtime.repoRoot} &&\` in non-poll run commands.`
      : "- Repository root was not explicitly named in the current prompt. Use the wrapper's default working directory; do not invent `/repo`, `/workspace`, or another root.",
    runtime.interruptCommand
      ? `- Interrupt form: \`${renderControlCommand(runtime, runtime.interruptCommand, "3")}\`.`
      : "- Interrupt form: use the current prompt's interrupt convention if the shell enters a continuation prompt.",
    runtime.completionToken
      ? `- Completion token from the current prompt: \`${runtime.completionToken}\`.`
      : "- Completion token: use the exact completion phrase requested by the current prompt.",
  ];
  if (patchReadinessGate) {
    protocol.push("", patchReadinessGate);
  }
  if (visibleIssueContext) {
    protocol.push("", "## Visible issue context", "", visibleIssueContext);
  }
  if (genericDefectContext) {
    protocol.push("", "## Generic repair heuristics", "", genericDefectContext);
  }
  if (hintDigest) {
    protocol.push("", "## Repair hint context", "", hintDigest);
  }
  protocol.push(
    "",
    "### Patch-first completion contract",
    "1. The goal is a small non-empty behavior-changing source `git diff`, not an explanation, comment-only change, test-only change, or proof that the bug already appears fixed.",
    "2. Use read-only commands to locate the target, but do not exceed eight inspect/search commands before the first source edit. If evidence points to one function/class, write the minimal tentative patch with the exact-replacement script, then test and inspect `git diff`.",
    "3. If visible bug or hint context appears above, treat it as the current task action queue: grep one exact issue identifier, inspect the containing source once or twice, then edit the candidate source behavior before searching tests broadly.",
    "4. Edit-readiness rule: after you have inspected the candidate function/class named by the current prompt, the next tool call should create an outer-write `/tmp/memmy_edit.py` exact-replacement script for the smallest source patch. Do not inspect tests first.",
    "5. When the next action would be another broad grep, another nearby `sed`, or a test search, prefer writing `/tmp/memmy_edit.py` for the smallest source behavior change already supported by the prompt and current source.",
    "6. If `git diff` is empty, the task is not complete.",
    "7. If a just-run targeted test, reproduction, or assertion fails after your patch, do not declare completion; inspect the failing expected/actual output and revise the patch until the targeted check passes or the failure is clearly unrelated.",
    "",
    "### Hard gates",
    "1. Stay in the repository selected by the current task wrapper. Never switch to another repository directory unless the current prompt explicitly says so.",
    `2. Use the exact current wrapper reference \`${runtime.wrapperRef}\` from the task prompt. Do not reuse a hard-coded path from memory; retries can change it.`,
    `3. Use copy-paste-safe wrapper calls matching the task prompt: double quotes around the \`${runtime.runVerb}\` command, then single quotes inside that command when a search pattern needs quoting.`,
    `   - Inspect: \`${shellPrefix}\``,
    `   - Good identifier grep: \`${renderRunCommand(runtime, "grep -n target_symbol path/to/file.py")}\`. Search one bare identifier, not a phrase with spaces.`,
    `   - Good literal grep: \`${renderRunCommand(runtime, "grep -n 'literal_pattern_without_spaces' path/to/file.py")}\``,
    `   - Good sed: \`${renderRunCommand(runtime, "sed -n '120,180p' path/to/file.py")}\``,
    `   - Good poll: \`${renderRunCommand(runtime, "", "10")}\` only after a previous command reported still running.`,
    `   - Good script/status/diff: \`${renderRunCommand(runtime, `python ${runtime.editScriptPath}`)}\`, \`${renderRunCommand(runtime, "git diff")}\`, \`${renderRunCommand(runtime, "git status --porcelain")}\`.`,
    `4. Never put raw inner double quotes inside the \`${runtime.runVerb} "..."\` command. Bad: \`grep -n "pattern" file\`; good: \`grep -n 'pattern' file\`.`,
    runtime.repoRoot
      ? `5. Every non-poll \`${runtime.runVerb}\` command should start with \`cd ${runtime.repoRoot} &&\`. Never run \`python ${runtime.editScriptPath}\`, \`git diff\`, \`git status\`, or check scripts without that prefix.`
      : `5. Do not invent a repository root. If the wrapper starts in the repository, run commands directly; if you later confirm a root with \`pwd\`, use \`cd <that-root> &&\` consistently for \`${runtime.runVerb}\` commands.`,
    `6. Do not use complex shell forms inside \`${runtime.runVerb}\`: no inline \`python - <<\`, no heredoc, no \`cat >\`, no \`tee\`, no \`sed -i\`, no \`perl -pi\`, no \`apply_patch\`, no \`patch\`, no \`git apply\`, no \`sh -lc\`, no \`bash -lc\`, no shell pipes (\`|\`), no nested \`${runtime.runVerb}\`, and no empty \`${runtime.runVerb}\` except polling a still-running command.`,
    `7. Never grep for a phrase containing whitespace inside \`${runtime.runVerb}\` such as \`grep -n "def target_symbol"\`, \`grep -n '^    def target_symbol'\`, or \`rg -n "def target_symbol"\`; those can split wrapper arguments or leave stale running commands. Grep the bare identifier (\`target_symbol\`) or inspect a line range with \`nl\`/\`sed\`.`,
    `8. Use outer \`write\` for target files or temporary scripts, e.g. \`${writePrefix}\`. The wrapper is host-side, so do not inspect it from the repository or call it inside \`${runtime.runVerb}\`.`,
    `9. A \`${runtime.wrapperRef} write\` heredoc is literal. Do not put shell substitutions like \`$(sed ...)\`, command output placeholders, line numbers, or diff markers (\`+\`/\`-\` prefixes) into the file content.`,
    `10. If any \`${runtime.runVerb}\` result starts with a bare \`>\` prompt or only echoes lines like \`> command\`, the shell is stuck in quote/heredoc continuation. Stop normal commands, interrupt first${runtime.interruptCommand ? ` with \`${renderControlCommand(runtime, runtime.interruptCommand, "3")}\`` : ""}, then confirm a normal prompt before running scripts or \`git diff\`.`,
    "11. Do not finish by saying the issue is already fixed. For repository repair tasks, a valid completion needs a non-empty source `git diff`; if `git diff` is empty, continue source investigation.",
    "",
    "### Safe edit loop",
    `1. For any multi-line source edit, first create \`${editScriptPrefix}\` with the outer wrapper.`,
    `2. The edit script should use \`Path('${renderTargetPath(runtime, "path/to/file")}')\`, exact \`old\`/\`new\` replacement strings copied from inspected source, \`assert old in text\`, and \`text.replace(old, new, 1)\`.`,
    `3. Run the script with \`${renderRunCommand(runtime, `python ${runtime.editScriptPath}`)}\`.`,
    "4. If `OLD block not found`, inspect the actual block with simple `nl`/`sed`/single-pattern `grep`, then rewrite the temporary edit script with outer `write`. Do not fall back to inline heredoc, `sed -i`, or broad rewrites.",
    "5. If a command syntax error mentions an unclosed quote/heredoc/bracket, stop using that command shape immediately and switch to the outer-write temporary script pattern.",
    `6. If a poll or script run repeats stale source text from an earlier command instead of showing the new command output, stop polling. Run one fresh \`${renderRepoCommand(runtime, "git diff -- <target-file>")}\` or \`${renderRepoCommand(runtime, "git status --porcelain")}\`; if that also repeats stale text, rewrite the edit/check script and execute it with the same repository command prefix.`,
    "",
    "### Search and test discipline",
    "1. Prefer POSIX tools (`grep`, `find`, `nl`, `sed`) because `rg` may be unavailable. Use simple single-token searches; avoid shell pipelines (`|`), phrase searches with spaces, and alternation (`\\|`) in wrapper command strings because host command parsers and allowlists are often conservative.",
    "2. If a Repair hint context or Visible issue context is present, inspect the target source file at most twice, then apply the minimal source edit before searching for regression-test locations.",
    "3. If repair hints contain a candidate source diff or visible issue clues contain a current -> expected expression, apply the minimal source fix before running full tests or searching broadly. Existing tests come after the source edit.",
    "4. Source behavior determines task success. Do not create or keep searching for new regression tests after existing targeted tests pass; run `git diff` and finish.",
    "5. When a candidate diff is present, do not generalize the same idea to other similar call sites, files, tests, docs, or helper functions unless the candidate diff explicitly touches them. Extra edits outside the candidate hunks can break existing behavior checks.",
    "6. Verify with the project's native targeted tests. Only use a generic test runner after confirming the project already uses it; do not install a new test runner just for one repair.",
    `7. Before declaring completion${runtime.completionToken ? ` with \`${runtime.completionToken}\`` : ""}, run \`git diff\`, confirm the patch is non-empty, and check it does not delete unrelated files or tests.`,
    "8. If the latest targeted test/reproduction output contains `FAIL`, `AssertionError`, an expected-vs-actual mismatch, or the same original output after your edit, treat that output as the next edit target; a non-empty patch alone is not enough to finish.",
    "9. If `git diff` is empty, tests or reproduction output are not enough to finish. Keep narrowing the source behavior and make the smallest source edit.",
    "10. If the Repair hint context contains a required `+` checklist or expected added-line count, it is a completion gate: compare `git diff` against it and continue editing until every listed source line/effect is present. Targeted or broad tests passing is not sufficient when the checklist is incomplete.",
    "11. Convergence budget: after locating the visible target class/function and one neighboring same-family implementation, either write the minimal source patch or run one narrow reproduction. Do not keep doing broad grep/test searches without producing a patch.",
    "12. If generic repair heuristics are present, use them as a short source-inspection checklist only; patch the current repository behavior, not the heuristic text.",
    "13. If a Visible issue context names identifiers, do not run `ls` or `pwd` first; the first command should grep one exact issue identifier.",
  );
  return protocol.join("\n");
}

interface RepairRuntimeConvention {
  wrapperRef: string;
  wrapperSource: string;
  runVerb: string;
  repoRoot: string | null;
  editScriptPath: string;
  completionToken: string | null;
  interruptCommand: string | null;
}

function inferRepairRuntime(text: string | undefined): RepairRuntimeConvention {
  const raw = String(text ?? "");
  const wrapperMatch =
    raw.match(/^\s*([A-Z][A-Z0-9_]*(?:_PATH|_WRAPPER|_HANDLE)?)\s*[:=]\s*(\/\S+|\S+)/im) ??
    raw.match(/\b([A-Z][A-Z0-9_]*(?:_PATH|_WRAPPER|_HANDLE)?)\s*=\s*(\/\S+)/i);
  const wrapperRef = wrapperMatch?.[1]?.trim() || "COMMAND_WRAPPER";
  const wrapperSource = wrapperMatch
    ? `declared in current prompt as ${wrapperRef}`
    : "generic wrapper placeholder; replace with the current prompt's wrapper";
  const runVerb = /\btmux-run\b/i.test(raw) ? "tmux-run" : "run";
  const repoRoot = extractPromptRepoRoot(raw);
  const completionToken = raw.match(/\bReply\s+([A-Z][A-Z0-9_]{2,})\s+when done\b/i)?.[1] ?? null;
  const interruptCommand = /\bctrl-c\b/i.test(raw) ? "ctrl-c" : null;
  return {
    wrapperRef,
    wrapperSource,
    runVerb,
    repoRoot,
    editScriptPath: "/tmp/memmy_edit.py",
    completionToken,
    interruptCommand,
  };
}

function extractPromptRepoRoot(text: string): string | null {
  const cdRoot = text.match(/\bcd\s+(\/[A-Za-z0-9_./-]+)\s*&&/)?.[1];
  if (cdRoot) return cdRoot;
  const labeledRoot = text.match(/\b(?:repo(?:sitory)?\s*(?:root|dir(?:ectory)?)|working\s+directory)\s*[:=]\s*(\/[A-Za-z0-9_./-]+)/i)?.[1];
  return labeledRoot ?? null;
}

function renderRepoCommand(runtime: RepairRuntimeConvention, command: string): string {
  if (!command) return "";
  return runtime.repoRoot ? `cd ${runtime.repoRoot} && ${command}` : command;
}

function renderRunCommand(
  runtime: RepairRuntimeConvention,
  command: string,
  waitSeconds = "10",
): string {
  return `${runtime.wrapperRef} ${runtime.runVerb} "${renderRepoCommand(runtime, command)}" ${waitSeconds}`;
}

function renderControlCommand(
  runtime: RepairRuntimeConvention,
  command: string,
  waitSeconds = "3",
): string {
  return `${runtime.wrapperRef} ${runtime.runVerb} "${command}" ${waitSeconds}`;
}

function renderTargetPath(runtime: RepairRuntimeConvention, target: string): string {
  if (target.startsWith("/")) return target;
  const cleanTarget = target.replace(/^\/+/, "");
  return runtime.repoRoot ? `${runtime.repoRoot}/${cleanTarget}` : cleanTarget;
}

function renderWriteCommand(
  runtime: RepairRuntimeConvention,
  target: string,
  marker: string,
): string {
  return `${runtime.wrapperRef} write ${renderTargetPath(runtime, target)} << '${marker}'`;
}

function renderPatchReadinessGate(runtime: RepairRuntimeConvention): string {
  return [
    "### Patch-readiness gate",
    "- First objective: produce a small non-empty source `git diff`. Do not run or search tests before the first source edit once the target function/class is found from current prompt evidence.",
    `- After you inspect the target function/class, the next tool call should create \`${renderWriteCommand(runtime, runtime.editScriptPath, "PY")}\` with an exact old/new replacement.`,
    `- Never send multi-line Python, patch text, heredocs, or \`apply_patch\` through \`${runtime.runVerb}\`; only the outer \`write\` wrapper may carry multi-line content.`,
    "- If the source edit fails, inspect only the exact old block, rewrite the edit script, and try again; do not switch to broad test search.",
  ].join("\n");
}

function extractRepairDescription(text: string): string {
  return (
    extractRepairTaskSection(text, "Issue Description") ||
    extractRepairTaskSection(text, "Bug Description")
  );
}

function renderVisibleRepairContext(
  text: string | undefined,
  runtime: RepairRuntimeConvention,
): string | null {
  const issue = extractRepairDescription(String(text ?? ""));
  if (!issue) return null;

  const cleaned = issue
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const identifiers = extractRepairIdentifiers(cleaned).slice(0, 8);
  const replacements = extractInsteadOfPairs(cleaned).slice(0, 2);
  const hasInsteadOfReplacement = /\binstead of\b/i.test(cleaned);
  const orderedCallAnchors = extractOrderedCallAnchors(cleaned).slice(0, 6);
  const orderedExampleGuidance = renderOrderedExampleGuidance(orderedCallAnchors);
  if (identifiers.length === 0 && replacements.length === 0) return null;

  const firstSearch = orderedCallAnchors.find((token) => !token.includes("'")) ??
    identifiers.find((token) => !token.includes("'"));
  const replacementGuidance = replacements.length
    ? [
        "Visible replacement guidance:",
        "- After the guard, create an outer-write `/tmp/memmy_edit.py` exact-replacement script; do not list the same block again just for line numbers.",
        "- Use the smallest exact line/block or return/call expression, change only the externally wrong output, run the script, then `git diff`.",
      ].join("\n")
    : "";
  const outputDataFlowGuard = replacements.length && hasInsteadOfReplacement
    ? [
        "Output data-flow guard:",
        "- For returns/redirects/renders `current` instead of `expected`, `expected` is the externally observed output, not a blanket replacement for every internal use.",
        "- If `current` is assigned to a variable used for lookup/validation/parsing before output, preserve that internal value and change only the return/redirect/render call or split the variable.",
        "- Generic pattern: `value = current; check(value); return Redirect(value)` should become `value = current; check(value); return Redirect(expected)`, not `value = expected`.",
      ].join("\n")
    : "";
  return truncateHintDigest(
    [
      "These clues come only from the current task description. Use them to reduce no-op exploration; verify against current source before editing.",
      identifiers.length
        ? `Search these exact issue identifiers/strings first: ${identifiers.map((id) => `\`${id}\``).join(", ")}.`
        : "",
      replacements.length
        ? [
            "Prompt wording suggests possible current -> expected expression pairs:",
            ...replacements.map((pair) => `- \`${pair.current}\` -> \`${pair.expected}\``),
          ].join("\n")
        : "",
      outputDataFlowGuard,
      replacementGuidance,
      orderedExampleGuidance,
      "If issue identifiers are present, do not start with `ls`/`pwd`; first grep the most specific identifier in source and tests, inspect the containing function, then apply the minimal source edit.",
      firstSearch
        ? `Example first search: \`${renderRunCommand(runtime, `grep -R -n '${firstSearch}' .`)}\``
        : "",
    ].filter(Boolean).join("\n"),
    2_000,
  );
}

interface GenericDefectHeuristic {
  label: string;
  re: RegExp;
  guidance: string[];
}

const GENERIC_DEFECT_HEURISTICS: readonly GenericDefectHeuristic[] = [
  {
    label: "omitted-input default guard",
    re: /\b(?:omit(?:ted|s|ting)?|missing|not provided|absent|blank|empty)\b[\s\S]{0,240}\b(?:default|fallback|normalized|validated|parsed|derived|non-empty|value)\b|\b(?:default|fallback|normalized|validated|parsed|derived|non-empty|value)\b[\s\S]{0,240}\b(?:omit(?:ted|s|ting)?|missing|not provided|absent|blank|empty)\b/i,
    guidance: [
      "Inspect the guard that skips assignment when raw input omits a field or key; if a later normalized value is present, the default-preserving branch should not block that assignment.",
      "Before adding a new guard condition, compare it with earlier `continue`/`return` guards in the same block; do not add a condition that an earlier guard already made impossible.",
      "If the same mapping is available through a local alias and an object property, treat key-presence guards on either name as equivalent when checking whether a new guard is redundant.",
      "Preserve default behavior for empty normalized values by using the repository's empty/sentinel helper; the skip guard should usually run only when the normalized value is empty.",
      "Patch the construct/assignment path where raw presence and normalized presence meet, not every caller that happens to supply a default.",
    ],
  },
  {
    label: "public representation boundary",
    re: /\b(?:enum|choice|member|symbolic|literal|primitive|representation|public value|serialized)\b[\s\S]{0,240}\b(?:string|integer|number|value|cast|convert|created|retrieved|returned)\b|\b(?:created|retrieved|returned|serialized)\b[\s\S]{0,240}\b(?:enum|choice|member|symbolic|literal|primitive|representation)\b/i,
    guidance: [
      "Find the shared boundary where an internal wrapper/member becomes the caller-visible primitive value; patch that conversion instead of adding per-field accessors.",
      "Keep validation strict internally, but make created, fetched, and serialized values expose the same public shape.",
    ],
  },
  {
    label: "closed-form expression exactness",
    re: /\b(?:precompute|closed[- ]form|formula|symbolic|expression|integral|integration|differentiat(?:e|ion)|density|cdf|pdf|piecewise|branch)\b/i,
    guidance: [
      "When adding a formula or symbolic expression, inspect neighboring implementations and assertions for the exact public expression shape, branch order, and comparison convention; mathematically equivalent output can still fail structural checks.",
      "After an expected-vs-actual assertion failure, adjust the returned expression to the repository's canonical form instead of stopping at numeric or algebraic equivalence.",
    ],
  },
  {
    label: "stateful seed reuse across repeated work",
    re: /\b(?:seed|random|shuffle|deterministic|reproducible)\b[\s\S]{0,240}\b(?:repeat(?:ed)?|group|subgroup|partition|class|bucket|child|split|loop)\b|\b(?:repeat(?:ed)?|group|subgroup|partition|class|bucket|child|split|loop)\b[\s\S]{0,240}\b(?:seed|random|shuffle|deterministic|reproducible)\b/i,
    guidance: [
      "Normalize the public seed once to a stateful generator/state object, then pass that object through repeated child operations so each child consumes the evolving state.",
      "Do not pass the same raw seed into every grouped operation; preserve the existing behavior when shuffling/randomization is disabled.",
    ],
  },
  {
    label: "paired inverse-operation reduction",
    re: /\b(?:reduce|reduction|optimi[sz]e|coalesce|cancel|squash)\b[\s\S]{0,240}\b(?:add|create|insert|set|remove|delete|drop|unset|inverse|op(?:eration)?s?)\b|\b(?:add|create|insert|set)\w*\b[\s\S]{0,160}\b(?:remove|delete|drop|unset)\w*\b/i,
    guidance: [
      "Inspect the paired operation classes and the common reducer/optimizer contract; inverse operations on the same object/key usually need an explicit no-op rule.",
      "Patch the reducer contract for the matching pair, and delegate nonmatching pairs to the existing fallback path.",
    ],
  },
  {
    label: "scoped lookup-context propagation",
    re: /\b(?:lookup|resolve|foreign|related|reference|key)\b[\s\S]{0,240}\b(?:database|datastore|store|backend|context|scope|target|non-default)\b|\b(?:database|datastore|store|backend|context|scope|target|non-default)\b[\s\S]{0,240}\b(?:lookup|resolve|foreign|related|reference|key)\b/i,
    guidance: [
      "If a temporary object or reference is created only to compute a lookup key, make sure it carries the target datastore/context before computing that key.",
      "Patch transient context propagation in the load/resolve path; avoid changing user-defined key functions or global routing behavior.",
    ],
  },
  {
    label: "same-metadata aggregation",
    re: /\b(?:same|identical|duplicate|repeated|multiple)\b[\s\S]{0,240}\b(?:metadata|classification|coefficient|factor|term|group|bucket|item)\b|\b(?:aggregate|combine|merge|collect|group)\b[\s\S]{0,240}\b(?:same|identical|duplicate|repeated|multiple|metadata|classification)\b/i,
    guidance: [
      "Group returned items by their semantic metadata first, then combine items in the same group while preserving coefficient/container/return-shape rules.",
      "Verify both the repeated-item case and the single-item case so the common representation stays stable.",
    ],
  },
  {
    label: "owned-object identity and ordering",
    re: /\b(?:abstract|base|template|prototype|cop(?:y|ied)|clone|derived|inherited|owner|owned|attached)\b[\s\S]{0,240}\b(?:equal|equality|compare|comparison|hash|ordering|sort|deduplicate|collision|counter|tie)\b|\b(?:equal|equality|compare|comparison|hash|ordering|sort|deduplicate|collision|counter|tie)\b[\s\S]{0,240}\b(?:abstract|base|template|prototype|cop(?:y|ied)|clone|derived|inherited|owner|owned|attached)\b/i,
    guidance: [
      "If objects copied from a shared template collide because identity/order uses only a local counter or name, include a stable primitive owner or namespace key in equality, hashing, and tie-breaking.",
      "Use existing string/id/tuple metadata for that owner key; avoid comparing owner objects directly, and preserve the repository's convention for unattached objects.",
    ],
  },
  {
    label: "secondary namespace relabel before merge",
    re: /\b(?:merge|combine|join|union|compose|attach)\b[\s\S]{0,240}\b(?:right[- ]hand|secondary|other side|prefix|namespace|temporary name|generated name|identifier|collision|mapping|reference)\b|\b(?:right[- ]hand|secondary|other side|prefix|namespace|temporary name|generated name|identifier|collision|mapping|reference)\b[\s\S]{0,240}\b(?:merge|combine|join|union|compose|attach)\b/i,
    guidance: [
      "When merging two structures that both contain generated names or references, deterministically relabel the secondary side before building the combined mapping.",
      "Patch the merge path and its reference map updates, not the global name allocator; preserve explicit names and delegate non-conflicting cases to existing behavior.",
    ],
  },
  {
    label: "fast-path precondition initialization",
    re: /\b(?:fast[- ]path|shortcut|optimized path|single[- ]source|single[- ]table|same source|same table|avoid subquery|subquery|performance regression)\b[\s\S]{0,240}\b(?:initialize|initialise|register|base|source|handle|alias|count|before|decision|branch)\b|\b(?:initialize|initialise|register|base|source|handle|alias|count|before|decision|branch)\b[\s\S]{0,240}\b(?:fast[- ]path|shortcut|optimized path|single[- ]source|single[- ]table|same source|same table|avoid subquery|subquery|performance regression)\b/i,
    guidance: [
      "Before a single-source or optimized-path branch counts handles/references, ensure the base source has been registered through the repository's existing initializer.",
      "Do not make the fast path stricter with an extra filter/query/no-condition guard when the issue says a simple all-item operation should take that fast path; initialize the state that the existing fast-path decision already expects.",
      "If verification still shows the same slow path or subquery, your patch did not reach the branch precondition; revise the setup that feeds the count/decision rather than adding comments or restating the existing condition.",
      "Patch the precondition setup for the branch decision instead of rewriting the compiler/planner/executor behavior around it.",
    ],
  },
  {
    label: "single-column subquery projection",
    re: /\b(?:subquery|sub-select|nested query|in lookup|membership lookup|related lookup|relationship lookup|filter)\b[\s\S]{0,240}\b(?:column|columns|select list|projection|annotation|extra select|expected one|too many)\b|\b(?:column|columns|select list|projection|annotation|extra select|expected one|too many)\b[\s\S]{0,240}\b(?:subquery|sub-select|nested query|in lookup|membership lookup|related lookup|relationship lookup|filter)\b/i,
    guidance: [
      "For lookup/filter subqueries, inspect where the projection is set; the final nested query should select only the target column(s) required by the lookup.",
      "Patch the projection-setting path so annotations, extra selected columns, ordering-only expressions, or previously selected fields cannot leak into a single-column membership subquery.",
      "Verify by compiling or running the narrow failing lookup; errors like 'subquery returns N columns' mean the patch must replace or clear the select list, not only rename the target field.",
    ],
  },
  {
    label: "backend identifier quoting boundary",
    re: /\b(?:sql|database|backend|introspection|constraint|metadata|pragma|schema|table|column|index)\b[\s\S]{0,240}\b(?:quote|quoted|identifier|reserved word|keyword|escaping|raw name)\b|\b(?:reserved word|keyword|identifier|raw name|quote|quoted|escaping)\b[\s\S]{0,240}\b(?:sql|database|backend|introspection|constraint|metadata|pragma|schema|table|column|index)\b/i,
    guidance: [
      "When table, column, index, or constraint names are interpolated into backend metadata/introspection statements, route every identifier through the repository's existing quote/escape helper.",
      "Patch the backend/introspection boundary where raw identifiers enter the statement; avoid changing unrelated query compilation or user model behavior.",
      "If a metadata command still errors after quoting, inspect that command's accepted identifier syntax and adjust the quoting boundary instead of adding a broad exception handler.",
    ],
  },
  {
    label: "public facade assembly consistency",
    re: /\b(?:public|wrapper|facade|top[- ]level|method form|function form|adapter|assembly|list assembly|return shape|output shape)\b[\s\S]{0,240}\b(?:lower[- ]level|internal|core|helper|already works|differs|inconsistent|inconsistant|wrong output|expected output)\b|\b(?:lower[- ]level|internal|core|helper|already works|differs|inconsistent|inconsistant|wrong output|expected output)\b[\s\S]{0,240}\b(?:public|wrapper|facade|top[- ]level|method form|function form|adapter|assembly|list assembly|return shape|output shape)\b/i,
    guidance: [
      "If an internal method produces the right semantic result but the public wrapper returns a different shape, patch the wrapper/assembly boundary first.",
      "Preserve the lower-level algorithm and public return contract; verify both the direct internal path and the public facade path after editing.",
    ],
  },
  {
    label: "configuration/default propagation",
    re: /\b(?:default|fallback|option|setting|parameter|argument|config(?:uration)?|preserve|respect|support|ignored|missing|route|path|redirect|script name)\b/i,
    guidance: [
      "Trace where the option is read, normalized, stored, and emitted; patch the first broken handoff rather than adding a special case at the output.",
      "When a value is used for validation and display/output, keep those roles separate if the expected external value differs from the internal lookup value.",
    ],
  },
  {
    label: "boundary conversion and value normalization",
    re: /\b(?:type|cast|convert|conversion|parse|serialize|deserialize|string|number|integer|boolean|enum|choice|value|literal)\b/i,
    guidance: [
      "Check the boundary where external input becomes an internal value and where it is converted back; avoid double-converting or comparing pre-normalized values with normalized values.",
      "Preserve the public value shape expected by callers while keeping internal validation strict.",
    ],
  },
  {
    label: "copy/mutation isolation",
    re: /\b(?:copy|clone|mutat(?:e|ion)|shared|independent|same object|in-place|side effect|leak|reuse)\b/i,
    guidance: [
      "Look for shallow copies of containers, cached objects, descriptors, or option maps; patch the ownership boundary so later mutation cannot affect the original object.",
      "Prefer copying at construction/assignment boundaries over patching every later mutation site.",
    ],
  },
  {
    label: "identifier/key collision handling",
    re: /\b(?:identifier|name|key|prefix|suffix|mapping|map|dict(?:ionary)?|lookup|collision|conflict|duplicate name|name clash)\b/i,
    guidance: [
      "Trace key construction and lookup together; ensure generated identifiers or keys cannot collide with explicit names and that fallback lookups use the same normalized key shape.",
      "Patch the central key-generation or lookup helper when one exists.",
    ],
  },
  {
    label: "pairing and scope alignment",
    re: /\b(?:pair|pairs|combination|cartesian|for each|each\s+\w+\s+with|per[- ]\w+|scope|scoped|shard|owner|owned)\b/i,
    guidance: [
      "Check nested loops and cross-product construction: each scoped object should be paired only with objects owned by the same scope unless the prompt explicitly asks for all combinations.",
      "Patch the iterator/filter that builds candidate pairs before changing downstream validation code.",
    ],
  },
  {
    label: "state and reproducibility propagation",
    re: /\b(?:state|seed|random|deterministic|context|session|scope|propagat(?:e|ion)|inherit|carry over)\b/i,
    guidance: [
      "Find the factory/wrapper that creates child operations and confirm state/configuration is passed through every branch, including clones and default constructors.",
      "Patch the shared creation path before editing individual call sites.",
    ],
  },
  {
    label: "aggregation/reduction completeness",
    re: /\b(?:aggregate|aggregation|reduce|reduction|combine|merge|sum|count|multiple|repeated|duplicate|factor|group)\b/i,
    guidance: [
      "Inspect both the specialized operation and the common reducer/combiner contract; missing methods often look correct for one item and fail for repeated or grouped items.",
      "Patch the operation contract where the repeated case is represented, then verify a single-item case still behaves the same.",
    ],
  },
  {
    label: "parser/grouping precedence",
    re: /\b(?:parser?|parse|syntax|precedence|associativity|parenthes(?:es|is)|grouping|token|lexer|fraction|operator)\b/i,
    guidance: [
      "Check token grouping before semantic conversion; most parser fixes belong at the smallest grammar or normalization boundary that preserves existing valid inputs.",
      "Add or run a narrow parse/reparse check for the ambiguous expression before broad tests.",
    ],
  },
  {
    label: "validation/error metadata preservation",
    re: /\b(?:validat(?:e|ion)|error code|error message|exception|metadata|detail|reason|diagnostic)\b/i,
    guidance: [
      "Preserve structured error metadata when wrapping or re-raising errors; callers may assert on code/detail fields, not just message text.",
      "Patch the wrapper or adapter that drops metadata instead of changing unrelated validation rules.",
    ],
  },
  {
    label: "layout or derived-option propagation",
    re: /\b(?:layout|spacing|padding|margin|size|width|height|align|derived|computed|inherit)\b/i,
    guidance: [
      "For derived visual or structural options, inspect the parent-to-child propagation path and the final render/build step; patch the missing handoff rather than hard-coding one output.",
      "Verify that explicitly supplied child options still override inherited defaults.",
    ],
  },
];

function renderGenericDefectContext(text: string | undefined): string | null {
  const source = [
    extractRepairDescription(String(text ?? "")),
    extractRepairTaskSection(String(text ?? ""), "Hints"),
  ].filter(Boolean).join("\n");
  if (!source.trim()) return null;

  const matched = GENERIC_DEFECT_HEURISTICS
    .filter((heuristic) => heuristic.re.test(source))
    .slice(0, 6);
  if (matched.length === 0) return null;

  return truncateHintDigest(
    [
      "The following generic defect categories are triggered only by words in the current issue/hints. Use them to choose the first source path to inspect; do not treat them as a fixed patch.",
      "If one of these categories clearly matches after inspecting the named function/class and one neighboring same-family implementation, prefer a minimal source patch before broad test search.",
      ...matched.flatMap((heuristic) => [
        `- ${heuristic.label}:`,
        ...heuristic.guidance.map((line) => `  - ${line}`),
      ]),
    ].join("\n"),
    3_600,
  );
}

const OPERATION_PREFIXES = [
  "Add",
  "Alter",
  "Create",
  "Delete",
  "Drop",
  "Insert",
  "Remove",
  "Rename",
  "Set",
  "Unset",
  "Update",
] as const;

function extractRepairIdentifiers(text: string): string[] {
  const buckets = [
    /\b([A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+)\b/g,
    /\b([A-Za-z_][A-Za-z0-9_]*)\(\)/g,
    /\b([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+)\b/g,
    /\b([A-Z][A-Z0-9_]{2,})\b/g,
    /\b([A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+)\b/g,
    /['"]([^'"\n]{2,120})['"]/g,
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  const addToken = (raw: string, source: "generic" | "call" = "generic") => {
    const token = normalizeRepairIdentifier(raw);
    if (!token || seen.has(token)) return;
    if (
      source === "call"
        ? !isUsefulRepairCallIdentifier(token)
        : !isUsefulRepairIdentifier(token)
    ) return;
    seen.add(token);
    out.push(token);
  };

  // Expand compact operation pairs such as "Add/RemoveIndex" into both
  // concrete identifiers. This is derived solely from visible prompt text.
  for (const match of text.matchAll(/\b([A-Z][A-Za-z0-9]*)\/([A-Z][A-Za-z0-9]+)\b/g)) {
    const left = match[1] ?? "";
    const right = match[2] ?? "";
    addToken(right);
    const rightParts = splitOperationToken(right);
    if (rightParts && OPERATION_PREFIXES.includes(left as typeof OPERATION_PREFIXES[number])) {
      addToken(`${left}${rightParts.suffix}`);
    } else {
      addToken(left);
    }
  }

  for (const re of buckets) {
    for (const match of text.matchAll(re)) {
      addToken(match[1] ?? "");
    }
  }
  for (const match of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    addToken(match[1] ?? "", "call");
  }
  return out;
}

function normalizeRepairIdentifier(token: string): string {
  return token
    .replace(/[.,;:)\]]+$/g, "")
    .replace(/^[([{\s]+/g, "")
    .trim();
}

function isUsefulRepairIdentifier(token: string): boolean {
  if (token.length < 3 || token.length > 120) return false;
  if (/^https?:/i.test(token)) return false;
  if (/^(?:Bug|Issue|Description|Patch|Reply|Done)$/i.test(token)) return false;
  if (/\s/.test(token)) return false;
  if (/^[a-z]\.[a-z]$/i.test(token)) return false;
  if (/["'`$]/.test(token)) return false;
  const fileOrPath = /^[A-Za-z0-9_./-]+\.(?:py|js|ts|tsx|java|rs|go|rb|php|c|cc|cpp|h|txt|md|rst)$/i.test(token);
  const attrChain = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(token);
  const constantName = /^[A-Z][A-Z0-9_]{2,}$/.test(token);
  const camelName = /[A-Z][a-z0-9]+[A-Z]/.test(token);
  const snakeName = /^[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+$/.test(token);
  return (
    fileOrPath ||
    attrChain ||
    constantName ||
    camelName ||
    snakeName
  );
}

function isUsefulRepairCallIdentifier(token: string): boolean {
  if (token.length < 3 || token.length > 80) return false;
  if (/^(?:if|for|while|switch|return|assert|print|lambda|with|class|def|function)$/i.test(token)) {
    return false;
  }
  if (/^[A-Z][A-Za-z0-9_]+$/.test(token)) return true;
  return /^[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+$/.test(token);
}

function renderOrderedExampleGuidance(callAnchors: readonly string[]): string {
  if (callAnchors.length < 2) return "";
  return [
    `Ordered concrete examples detected: ${callAnchors.map((anchor) => `\`${anchor}\``).join(", ")}.`,
    "When the issue lists multiple failing examples, complete the earliest visible concrete example before moving to later easier examples unless inspected source or tests clearly name a different target.",
  ].join("\n");
}

function extractOrderedCallAnchors(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    const token = normalizeRepairIdentifier(match[1] ?? "");
    if (!isUsefulRepairCallIdentifier(token)) continue;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(token);
  }
  return out;
}

function splitOperationToken(token: string): { prefix: typeof OPERATION_PREFIXES[number]; suffix: string } | null {
  for (const prefix of OPERATION_PREFIXES) {
    if (
      token.startsWith(prefix) &&
      token.length > prefix.length &&
      /[A-Z]/.test(token[prefix.length] ?? "")
    ) {
      return { prefix, suffix: token.slice(prefix.length) };
    }
  }
  return null;
}

function extractInsteadOfPairs(text: string): Array<{ current: string; expected: string }> {
  const pairs: Array<{ current: string; expected: string }> = [];
  for (const match of text.matchAll(/\binstead of\s+([^\n]+)/gi)) {
    const expected = cleanPromptExpression(match[1] ?? "");
    const before = text
      .slice(Math.max(0, (match.index ?? 0) - 180), match.index)
      .replace(/\([^)]*\)/g, " ");
    const currentMatches = [...before.matchAll(/\b(?:to|with|using|uses?|returns?|returning)\s+([^\n]{2,160})/gi)];
    const current = cleanPromptExpression(currentMatches.at(-1)?.[1] ?? "");
    if (!current || !expected) continue;
    if (current === expected) continue;
    pairs.push({ current, expected });
  }
  for (const match of text.matchAll(/\bshould have\s+([\s\S]{2,220}?)\s+and not\s+([\s\S]{2,220}?)(?=(?:\.|\n|$))/gi)) {
    const expected = cleanPromptExpression(match[1] ?? "");
    const current = cleanPromptExpression(match[2] ?? "");
    if (!current || !expected) continue;
    if (current === expected) continue;
    pairs.push({ current, expected });
  }
  return pairs;
}

function cleanPromptExpression(value: string): string {
  const trimmed = value.trim();
  const withoutParenthetical = trimmed.startsWith("(")
    ? trimmed
    : trimmed.replace(/\([^)]*\)/g, "");
  return withoutParenthetical
    .replace(/\s+/g, " ")
    .replace(/^[\s:,-]+|[\s:,-]+$/g, "")
    .trim();
}

function renderRepairHintContext(
  text: string | undefined,
  runtime: RepairRuntimeConvention,
): string | null {
  const hints = extractRepairTaskSection(String(text ?? ""), "Hints");
  if (!hints) return null;

  const cleaned = hints
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const anchors = extractImplementationAnchors(cleaned).slice(0, 10);
  const anchorGuidance = renderAnchorGuidance(anchors, runtime);

  const diffIndex = cleaned.search(/\bdiff --git\b/i);
  if (diffIndex >= 0) {
    const diffText = cleaned.slice(diffIndex);
    const formattedDiff = formatUnifiedDiffForHint(diffText);
    const firstTarget = extractFirstDiffTarget(diffText);
    const requiredWrite = renderWriteCommand(runtime, runtime.editScriptPath, "PY");
    return truncateHintDigest(
      [
        "The task hints include a candidate source diff. Use it as the first patch attempt before any full test run or broad test search.",
        "Immediate order: inspect the diff target once, create a temporary exact-replacement edit script with the outer `write` wrapper, run it, run narrow existing tests, then `git diff` and finish.",
        firstTarget ? `Primary edit target: ${renderTargetPath(runtime, firstTarget)}` : "",
        anchorGuidance,
        requiredWrite ? `Required edit command starts with: \`${requiredWrite}\`.` : "",
        firstTarget ? renderExactReplacementScriptPattern(firstTarget, runtime) : "",
        "Do not paste compact diff hunks directly into the source file. Remove `+`/`-` diff prefixes, do not use `$(...)` inside `write`, and preserve indentation from the inspected source.",
        "Candidate diff hunks:",
        formattedDiff,
      ].filter(Boolean).join("\n"),
      3_600,
    );
  }

  if (/\b(?:patch|exact fix|tentative patch|def\s+\w+|class\s+\w+)\b/i.test(cleaned)) {
    const directHint = [
      "The task hints include a concrete implementation clue. Try the minimal source fix first:",
      anchorGuidance,
      cleaned,
    ].filter(Boolean).join("\n");
    return truncateHintDigest(directHint, 7_500);
  }
  return truncateHintDigest(
    [
      "Task-provided hints. Use these as visible task context, but keep the current source and tests as the authority:",
      anchorGuidance,
      cleaned,
    ].filter(Boolean).join("\n"),
    1_600,
  );
}

function renderAnchorGuidance(
  anchors: readonly string[],
  runtime: RepairRuntimeConvention,
): string {
  if (anchors.length === 0) return "";
  const firstSearch = anchors.find((anchor) => !anchor.includes("'")) ?? anchors[0];
  const searchCommand = firstSearch
    ? renderRunCommand(runtime, renderAnchorSearchCommand(firstSearch))
    : "";
  return [
    `Implementation anchors extracted from current hints: ${anchors.map((anchor) => `\`${anchor}\``).join(", ")}.`,
    searchCommand
      ? `Prefer the first hint-guided search before traceback nouns: \`${searchCommand}\`.`
      : "",
    anchors.some((anchor) => /(?:_compatible|supports?_|can_|has_|is_)/i.test(anchor))
      ? "If a hint anchor is a compatibility/capability flag, prefer a direct semantic guard or no-op at that boundary over parsing generated output strings."
      : "",
    "After inspecting the named class/function and one neighboring same-family implementation, patch the smallest source boundary that explains the current issue.",
  ].filter(Boolean).join("\n");
}

function renderAnchorSearchCommand(anchor: string): string {
  if (/\.(?:py|js|ts|tsx|java|rs|go|rb|php|c|cc|cpp|h)$/i.test(anchor)) {
    const name = anchor.split("/").filter(Boolean).at(-1) ?? anchor;
    return `find . -name '${name}'`;
  }
  return `grep -R -n '${anchor}' .`;
}

function extractImplementationAnchors(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string | undefined) => {
    const token = normalizeRepairIdentifier(String(raw ?? ""));
    if (!isUsefulImplementationAnchor(token)) return;
    const key = token.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(token);
  };

  for (const match of text.matchAll(/\b(?:class|def|function|method)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    add(match[1]);
  }
  for (const match of text.matchAll(/\b([A-Za-z0-9_./-]+\.(?:py|js|ts|tsx|java|rs|go|rb|php|c|cc|cpp|h))(?::L?\d+)?\b/g)) {
    add(stripDiffPathPrefix(match[1]));
  }
  for (const match of text.matchAll(/\b([A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+)\b/g)) {
    add(match[1]);
  }
  for (const match of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\b/g)) {
    add(match[1]);
  }
  for (const match of text.matchAll(/\b([a-z][a-z0-9]+_[A-Za-z0-9_]+)\b/g)) {
    add(match[1]);
  }
  return out.slice(0, 16);
}

function isUsefulImplementationAnchor(token: string): boolean {
  if (token.length < 3 || token.length > 120) return false;
  if (/^https?:/i.test(token)) return false;
  if (/\s/.test(token)) return false;
  if (/^(?:Thanks|Likely|Description|Reproduced|Alternative|Inspect|Patch|Reply|Error|Traceback)$/i.test(token)) {
    return false;
  }
  if (/^(?:OperationalError|IntegrityError|DataError|ValueError|TypeError|AttributeError|Exception)$/i.test(token)) {
    return false;
  }
  return (
    /\.[A-Za-z0-9]+$/.test(token) ||
    /[A-Z][a-z0-9]+[A-Z]/.test(token) ||
    /^[a-z][a-z0-9]+_[A-Za-z0-9_]+$/.test(token)
  );
}

function stripDiffPathPrefix(token: string | undefined): string {
  return String(token ?? "").replace(/^(?:a|b)\//, "");
}

function renderExactReplacementScriptPattern(
  target: string,
  runtime: RepairRuntimeConvention,
): string {
  return [
    "Safe large-file edit pattern:",
    "```python",
    "from pathlib import Path",
    `p = Path("${renderTargetPath(runtime, target)}")`,
    "text = p.read_text()",
    "old = \"\"\"copy the exact old block from the inspected source, without line numbers\"\"\"",
    "new = \"\"\"replacement block, without diff +/- markers\"\"\"",
    "assert old in text",
    "p.write_text(text.replace(old, new, 1))",
    "```",
  ].join("\n");
}

function extractFirstDiffTarget(diffText: string): string | null {
  const match = diffText.match(/\+\+\+\s+b\/([^\s]+)/);
  return match?.[1]?.trim() || null;
}

function truncateHintDigest(text: string, maxChars = 1_600): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 3).trimEnd()}...`;
}

function formatUnifiedDiffForHint(diffText: string): string {
  const normalized = diffText
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
  const formatted = normalized
    .replace(/\s+(diff --git\s+a\/)/g, "\n$1")
    .replace(/\s+(index\s+[0-9a-f]+\.\.[0-9a-f]+(?:\s+\d+)?)\s+/gi, "\n$1\n")
    .replace(/\s+(---\s+a\/[^\s]+)\s+/g, "\n$1\n")
    .replace(/\s+(\+\+\+\s+b\/[^\s]+)\s+/g, "\n$1\n")
    .replace(/\s+(@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@)/g, "\n$1 ")
    .replace(/\s-\s+/g, "\n- ")
    .replace(/\s\+\s+/g, "\n+ ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const lines = formatted.split("\n");
  const kept: string[] = [];
  let hunkCount = 0;
  for (const line of lines) {
    if (line.startsWith("@@")) hunkCount++;
    if (hunkCount > 4) break;
    if (
      /^diff --git\b/.test(line) ||
      /^---\s/.test(line) ||
      /^\+\+\+\s/.test(line) ||
      /^@@\s/.test(line) ||
      /^[-+] /.test(line) ||
      (hunkCount > 0 && kept.length < 8)
    ) {
      kept.push(line);
    }
    if (kept.join("\n").length > 3_200) break;
  }
  return kept.join("\n").trim() || normalized.slice(0, 3_200).trim();
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

function requiresKeywordConfirmation(text: string): boolean {
  const tokens = text.match(/[A-Za-z0-9_:-]{12,}/g) ?? [];
  return tokens.some((token) => {
    const hasIdentifierShape = /[_:-]/.test(token) || /\d/.test(token);
    const hasEnoughEntropy = /[A-Za-z]/.test(token) && token.length >= 16;
    return hasIdentifierShape && hasEnoughEntropy;
  });
}

function hasKeywordChannel(candidate: RankedCandidate): boolean {
  return (candidate.candidate.channels ?? []).some((channel) =>
    channel.channel === "fts" ||
    channel.channel === "pattern" ||
    channel.channel === "structural"
  );
}

function bypassesKeywordConfirmation(candidate: RankedCandidate): boolean {
  const refKind = candidate.candidate.refKind;
  return refKind === "skill" || refKind === "world-model";
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
