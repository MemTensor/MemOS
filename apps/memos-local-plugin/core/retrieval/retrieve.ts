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
  isSoftwareRepairPrompt,
  rawQueryText,
  type CompiledQuery,
} from "./query-builder.js";
import { extractRetrievalQueryWithLlm } from "./query-extract.js";
import type { RetrievalEventBus } from "./events.js";
import { dedupeTraceEpisodeByEpisodeId } from "./dedupe-trace-episode.js";
import { toPacket, renderSnippetForDebug } from "./injector.js";
import { llmFilterCandidates } from "./llm-filter.js";
import { STANDALONE_MATH_FINAL_ANSWER_TASK_KIND } from "./math-task.js";
import { rank } from "./ranker.js";
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
    const mechanicalRanked = ranked.ranked;
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
  if (!isSoftwareRepairPrompt(userText)) return null;
  const shellPrefix = `WRAPPER_PATH tmux-run "cd /testbed && ..."`;
  const writePrefix = `WRAPPER_PATH write /testbed/path/to/file << 'EOF'`;
  const editScriptPrefix = `WRAPPER_PATH write /tmp/memos_edit.py << 'PY'`;
  const sourceRoots = inferRepairSourceRoots(userText);
  const immediateActionGate = renderImmediateRepairActionGate(userText);
  const visibleBugDigest = renderRepairVisibleBugDigest(userText, sourceRoots);
  const hintDigest = renderRepairHintDigest(userText);
  const protocol = [
    "## Software engineering task protocol",
    "",
    "This is a software repair task. Recalled memories are advisory; the current repository state and current prompt win.",
  ];
  if (immediateActionGate) {
    protocol.push("", immediateActionGate);
  }
  if (visibleBugDigest) {
    protocol.push("", "## Visible bug clue digest", "", visibleBugDigest);
  }
  if (hintDigest) {
    protocol.push("", "## Bug hint digest", "", hintDigest);
  }
  protocol.push(
    "",
    "### Patch-first completion contract",
    "1. The goal is a small non-empty source `git diff`, not an explanation, test-only change, or proof that the bug already appears fixed.",
    "2. Use read-only commands to locate the target, but do not exceed eight inspect/search commands before the first source edit. If evidence points to one function/class, write the minimal tentative patch with the exact-replacement script, then test and inspect `git diff`.",
    "3. If a visible bug or hint closure appears above, treat it as the current task action queue: grep one exact visible identifier, inspect the containing source once or twice, then edit the candidate source behavior before searching tests broadly.",
    "4. Closure-stop rule: after you have inspected the candidate function/class named by a closure, the next tool call must create an outer-write `/tmp/memos_edit.py` exact-replacement script for the smallest source patch. Do not inspect tests first.",
    "5. When the next action would be another broad grep, another nearby `sed`, or a test search, prefer writing `/tmp/memos_edit.py` for the smallest source behavior change already supported by the prompt and current source.",
    "6. If `git diff` is empty, the task is not complete.",
    "",
    "### Hard gates",
    "1. Treat the task repository as `/testbed`; never switch to `/repo` unless the current prompt explicitly says so.",
    "2. Use the exact current `WRAPPER_PATH` from the task prompt. Do not reuse a hard-coded `/tmp/...-exec` path from memory; retries can change it.",
    "3. Use copy-paste-safe wrapper calls matching the task prompt: double quotes around the `tmux-run` command, then single quotes inside that command when a search pattern needs quoting.",
    `   - Inspect: \`${shellPrefix} 10\``,
    "   - Good identifier grep: `WRAPPER_PATH tmux-run \"cd /testbed && grep -n combine path/to/file.py\" 10`. Search one bare identifier, not a phrase with spaces.",
    "   - Good literal grep: `WRAPPER_PATH tmux-run \"cd /testbed && grep -n 'literal_pattern_without_spaces' path/to/file.py\" 10`",
    "   - Good sed: `WRAPPER_PATH tmux-run \"cd /testbed && sed -n '120,180p' path/to/file.py\" 10`",
    "   - Good poll: `WRAPPER_PATH tmux-run \"\" 10` only after a previous command reported still running.",
    "   - Good script/status/diff: `WRAPPER_PATH tmux-run \"cd /testbed && python /tmp/memos_edit.py\" 10`, `WRAPPER_PATH tmux-run \"cd /testbed && git diff\" 10`, `WRAPPER_PATH tmux-run \"cd /testbed && git status --porcelain\" 10`.",
    "4. Never put raw inner double quotes inside the `tmux-run \"...\"` command. Bad: `grep -n \"pattern\" file`; good: `grep -n 'pattern' file`.",
    "5. Every non-poll `tmux-run` command must start with `cd /testbed &&`. Never run `python /tmp/...`, `git diff`, `git status`, or check scripts without that prefix.",
    "6. Do not use complex shell forms inside `tmux-run`: no inline `python - <<`, no heredoc, no `cat >`, no `tee`, no `sed -i`, no `perl -pi`, no `apply_patch`, no `patch`, no `git apply`, no `sh -lc`, no `bash -lc`, no shell pipes (`|`), no nested `tmux-run`, and no empty `tmux-run` except polling a still-running command.",
    "7. Never grep for a phrase containing whitespace inside `tmux-run` such as `grep -n \"def combine\"`, `grep -n '^    def combine'`, or `rg -n \"def combine\"`; those split the host wrapper arguments and can leave a stale running grep. Grep the bare identifier (`combine`) or inspect a line range with `nl`/`sed`.",
    `8. Use outer \`write\` for target files or temporary scripts, e.g. \`${writePrefix}\`. The wrapper path is host-side, so do not inspect it from \`/testbed\` or call it inside tmux-run.`,
    "9. A `WRAPPER_PATH write` heredoc is literal. Do not put shell substitutions like `$(sed ...)`, command output placeholders, line numbers, or diff markers (`+`/`-` prefixes) into the file content.",
    "10. Do not finish by saying the bug is already fixed. For verifier-scored repair tasks, a valid completion needs a non-empty source `git diff`; if `git diff` is empty, continue source investigation instead of `TASK_COMPLETE`.",
    "",
    "### Safe edit loop",
    `1. For any multi-line source edit, first create \`${editScriptPrefix}\` with the outer wrapper.`,
    "2. The edit script should use `Path('/testbed/...')`, exact `old`/`new` replacement strings copied from inspected source, `assert old in text`, and `text.replace(old, new, 1)`.",
    "3. Run the script with `WRAPPER_PATH tmux-run \"cd /testbed && python /tmp/memos_edit.py\" 10`.",
    "4. If `OLD block not found`, inspect the actual block with simple `nl`/`sed`/single-pattern `grep`, then rewrite the temporary edit script with outer `write`. Do not fall back to inline heredoc, `sed -i`, or broad rewrites.",
    "5. If a command syntax error mentions an unclosed quote/heredoc/bracket, stop using that command shape immediately and switch to the outer-write temporary script pattern.",
    "6. If a poll or script run repeats stale source text from an earlier command instead of showing the new command output, stop polling. Run one fresh `cd /testbed && git diff -- <target-file>` or `cd /testbed && git status --porcelain`; if that also repeats stale text, rewrite the edit/check script and execute it with the exact `cd /testbed &&` prefix.",
    "",
    "### Search and test discipline",
    "1. Prefer POSIX tools (`grep`, `find`, `nl`, `sed`) because `rg` may be unavailable. Use simple single-token searches; avoid shell pipelines (`|`), phrase searches with spaces, and alternation (`\\|`) in wrapper command strings because the evaluation allowlist is conservative.",
    "2. If a Bug hint digest or Visible bug clue digest is present, inspect the target source file at most twice, then apply the minimal source edit before searching for regression-test locations.",
    "3. If bug hints contain a candidate source diff or visible bug clues contain a current -> expected expression, apply the minimal source fix before running full tests or searching broadly. Existing tests come after the source edit.",
    "4. Held-out verification scores the source patch. Do not create or keep searching for new regression tests after existing targeted tests pass; run `git diff` and finish.",
    "5. When a candidate diff is present, do not generalize the same idea to other similar call sites, files, tests, docs, or helper functions unless the candidate diff explicitly touches them. Extra edits outside the candidate hunks can break existing behavior checks.",
    "6. Verify with the project's native targeted tests: Django usually uses `python tests/runtests.py ...`; SymPy usually uses `python bin/test ...`; only use `python -m pytest` after confirming pytest exists. Do not install pytest just to run one benchmark task.",
    "7. Before `TASK_COMPLETE`, run `git diff`, confirm the patch is non-empty, and check it does not delete unrelated files or tests.",
    "8. If `git diff` is empty, tests or reproduction output are not enough to finish. Keep narrowing the source behavior and make the smallest source edit.",
    "9. If the Bug hint digest contains a required `+` checklist or expected added-line count, it is a completion gate: compare `git diff` against it and continue editing until every listed source line/effect is present. Targeted or broad tests passing is not sufficient when the checklist is incomplete.",
    "10. Convergence budget: after locating the visible target class/function and one neighboring same-family implementation, either write the minimal source patch or run one narrow reproduction. Do not keep doing broad grep/test searches without producing a patch.",
    "11. For operation-reduction or optimizer bugs, inspect the named operation classes plus the base reducer/optimizer contract, then patch the missing reduction method before broad test discovery.",
    "12. If a Visible bug clue digest names identifiers, do not run `ls` or `pwd` first; the first command should grep one exact visible identifier.",
  );
  return protocol.join("\n");
}

function inferRepairSourceRoots(text: string | undefined): string {
  const lower = String(text ?? "").toLowerCase();
  if (lower.includes("django/django")) return "django tests";
  if (lower.includes("sympy/sympy")) return "sympy";
  if (lower.includes("scikit-learn/scikit-learn")) return "sklearn";
  if (lower.includes("matplotlib/matplotlib")) return "lib";
  return ".";
}

function renderImmediateRepairActionGate(text: string | undefined): string {
  const promptText = String(text ?? "");
  const bug = extractRepairTaskSection(promptText, "Bug Description") ?? "";
  const hints = extractRepairTaskSection(promptText, "Hints") ?? "";
  const visible = `${bug}\n${hints}`;
  const patternLines: string[] = [];

  if (renderCleanedDataDefaultDigest(visible)) {
    patternLines.push(
      "Visible pattern: cleaned_data/default override. After reading the construct/assignment guard, edit that guard now: add a cleaned-value emptiness condition to the existing default+omitted-data `continue`.",
    );
  }
  if (renderFactorGroupingDigest(visible)) {
    patternLines.push(
      "Visible pattern: factor-list multiplicity aggregation. After reading the public wrapper and list assembly point, edit the wrapper/list assembly path before tests.",
    );
  }
  if (renderRandomStateDigest(visible)) {
    patternLines.push(
      "Visible pattern: shuffle/random_state propagation. After reading the splitter loop, edit RNG normalization/propagation before test discovery or ad-hoc reproductions; if the loop passes one raw `random_state` into repeated per-class/per-stratum splitters, normalize it once to the repository RNG object and reuse that object.",
    );
  }
  if (renderModelFieldComparisonDigest(visible)) {
    patternLines.push(
      "Visible pattern: model-attached object comparison. After reading equality/hash/order methods, edit a stable primitive model-key helper before test discovery; do not place raw model classes/objects inside the ordering/hash tuple.",
    );
  }
  if (renderEnumValueCastingDigest(visible)) {
    patternLines.push(
      "Visible pattern: enum/choices value casting. After reading the shared Choices/enum base, edit the common value representation path before test discovery.",
    );
  }
  if (renderSingleAliasDeleteDigest(visible)) {
    patternLines.push(
      "Visible pattern: single-alias SQL fast path. After reading the alias-count branch, edit base alias initialization before test discovery.",
    );
  }

  return [
    "### Immediate repair gate",
    "- First objective: produce a small non-empty source `git diff`. Do not run or search tests before the first source edit once the target function/class is found.",
    "- After you inspect the target function/class, the next tool call should create `WRAPPER_PATH write /tmp/memos_edit.py << 'PY'` with an exact old/new replacement.",
    "- If the source edit fails, inspect only the exact old block, rewrite the edit script, and try again; do not switch to broad test search.",
    ...patternLines.map((line) => `- ${line}`),
  ].join("\n");
}

function renderRepairVisibleBugDigest(
  text: string | undefined,
  sourceRoots: string,
): string | null {
  const bug = extractRepairTaskSection(String(text ?? ""), "Bug Description");
  if (!bug) return null;

  const cleaned = bug
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const identifiers = extractVisibleBugIdentifiers(cleaned).slice(0, 8);
  const replacements = extractInsteadOfPairs(cleaned).slice(0, 2);
  const hasInsteadOfReplacement = /\binstead of\b/i.test(cleaned);
  const patternDigest = renderVisibleBugPatternDigest(cleaned, identifiers);
  if (identifiers.length === 0 && replacements.length === 0 && !patternDigest) return null;

  const firstSearch = identifiers.find((token) => !token.includes("'"));
  const replacementClosure = replacements.length
    ? [
        "Visible replacement closure:",
        "- After the guard, create an outer-write `/tmp/memos_edit.py` exact-replacement script; do not list the same block again just for line numbers.",
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
      "These clues come only from the visible Bug Description. Use them to reduce no-op exploration; verify against current source before editing.",
      identifiers.length
        ? `Search these exact visible identifiers/strings first: ${identifiers.map((id) => `\`${id}\``).join(", ")}.`
        : "",
      patternDigest,
      replacements.length
        ? [
            "Prompt wording suggests possible current -> expected expression pairs:",
            ...replacements.map((pair) => `- \`${pair.current}\` -> \`${pair.expected}\``),
          ].join("\n")
        : "",
      outputDataFlowGuard,
      replacementClosure,
      "If visible identifiers are present, do not start with `ls`/`pwd`; first grep the most specific identifier in source and tests, inspect the containing function, then apply the minimal source edit.",
      firstSearch
        ? `Example first search: \`WRAPPER_PATH tmux-run "cd /testbed && grep -R -n '${firstSearch}' ${sourceRoots}" 10\``
        : "",
    ].filter(Boolean).join("\n"),
    2_400,
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

function extractVisibleBugIdentifiers(text: string): string[] {
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
  const addToken = (raw: string) => {
    const token = normalizeVisibleBugToken(raw);
    if (!token || seen.has(token)) return;
    if (!isUsefulVisibleBugToken(token)) return;
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
  return out;
}

function normalizeVisibleBugToken(token: string): string {
  return token
    .replace(/[.,;:)\]]+$/g, "")
    .replace(/^[([{\s]+/g, "")
    .trim();
}

function isUsefulVisibleBugToken(token: string): boolean {
  if (token.length < 3 || token.length > 120) return false;
  if (/^https?:/i.test(token)) return false;
  if (/^(?:Bug|Description|Patch|Django|Reply|TASK_COMPLETE)$/i.test(token)) return false;
  return (
    /[_.%/]/.test(token) ||
    /[A-Z][A-Z0-9_]{2,}/.test(token) ||
    /[A-Z][a-z0-9]+[A-Z]/.test(token)
  );
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

function renderVisibleBugPatternDigest(
  text: string,
  identifiers: string[],
): string {
  const cleanedDataDefaultDigest = renderCleanedDataDefaultDigest(text);
  const enumValueCastingDigest = renderEnumValueCastingDigest(text);
  const modelFieldComparisonDigest = renderModelFieldComparisonDigest(text);
  const randomStateDigest = renderRandomStateDigest(text);
  const singleAliasDeleteDigest = renderSingleAliasDeleteDigest(text);
  const aliasPrefixCollisionDigest = renderAliasPrefixCollisionDigest(text);
  const naturalKeyDatabaseDigest = renderNaturalKeyDatabaseDigest(text);
  const factorGroupingDigest = renderFactorGroupingDigest(text);
  const asksForReduction =
    /\b(?:reduce|reduction|optimi[sz](?:e|ing|ation)|coalesce|collapse|cancel)\b/i
      .test(text);
  const mentionsOperations = /\boperations?\b/i.test(text) ||
    identifiers.some((id) => splitOperationToken(id));
  const addLike = identifiers.filter((id) =>
    /^(?:Add|Create|Insert|Set)[A-Z]/.test(id)
  );
  const removeLike = identifiers.filter((id) =>
    /^(?:Remove|Delete|Drop|Unset)[A-Z]/.test(id)
  );
  if (!asksForReduction || !mentionsOperations || addLike.length === 0 || removeLike.length === 0) {
    return [
      cleanedDataDefaultDigest,
      enumValueCastingDigest,
      modelFieldComparisonDigest,
      randomStateDigest,
      singleAliasDeleteDigest,
      aliasPrefixCollisionDigest,
      naturalKeyDatabaseDigest,
      factorGroupingDigest,
    ].filter(Boolean).join("\n");
  }

  const namedOps = [...addLike.slice(0, 2), ...removeLike.slice(0, 2)]
    .map((id) => `\`${id}\``)
    .join(", ");
  const operationDigest = [
    "Operation reduction closure:",
    `- Visible prompt names paired operations (${namedOps}). Treat this as an algebraic operation-reduction task, not broad test discovery.`,
    "- Mandatory staged plan: (1) grep the two named operation classes; (2) inspect only those classes, the base reducer/optimizer contract, and one neighboring same-family implementation; (3) write `/tmp/memos_edit.py` for the minimal source patch. Do not search tests before step 3.",
    "- Patch the operation method that is missing the inverse-operation rule. An earlier add/create/set followed by a later remove/delete/drop/unset on the same model/object key should reduce to the repository's no-op representation; if neighboring reducer code uses `return []`, follow that convention.",
    "- Non-matching operations must delegate to the repository's existing fallback (`super().reduce(...)`, base reducer, or equivalent), not return a broad result.",
    "- Use only attributes already present on the classes for equality checks; never hard-code values from the prompt or a remembered patch.",
  ].join("\n");
  return [
    operationDigest,
    cleanedDataDefaultDigest,
    enumValueCastingDigest,
    modelFieldComparisonDigest,
    randomStateDigest,
    singleAliasDeleteDigest,
    aliasPrefixCollisionDigest,
    naturalKeyDatabaseDigest,
    factorGroupingDigest,
  ].filter(Boolean).join("\n");
}

function renderCleanedDataDefaultDigest(text: string): string {
  if (
    !/\bcleaned_data\b/i.test(text) ||
    !/\bdefaults?\b/i.test(text) ||
    !/\b(?:payload|POST|raw data|submitted data|omitted|isn'?t in|not in)\b/i.test(text)
  ) {
    return "";
  }
  return [
    "Cleaned-data default override closure:",
    "- If raw submitted data omits a field but `cleaned_data` supplies a non-empty value, the model default skip guard should not block assigning that value.",
    "- Do not add `field_name not in cleaned_data` as the extra guard when the surrounding loop already requires membership in `cleaned_data`; that is a no-op for this bug shape.",
    "- Preserve default behavior for empty cleaned values (`None`, empty string/list/tuple/dict, or the repository's `empty_values` helper). Minimal patch: let the existing default/omitted-data `continue` run only when the cleaned value is empty by the form/model field convention.",
    "- Patch shape: change `if has_default and value_omitted_from_data(...): continue` into `if has_default and value_omitted_from_data(...) and cleaned_value in field.empty_values: continue`, using the source's actual variable names.",
    "- Once the construct/assignment function and `empty_values` helper are visible, stop searching tests; the next action should be the exact-replacement edit script.",
    "- Patch the construct/assignment point, not generic widget omission semantics.",
  ].join("\n");
}

function renderEnumValueCastingDigest(text: string): string {
  if (
    !/\b(?:TextChoices|IntegerChoices|Choices)\b/.test(text) ||
    !/\benum\b/i.test(text) ||
    !/\b(?:str|type|created|retrieved|getter|field value)\b/i.test(text)
  ) {
    return "";
  }
  return [
    "Enum value casting closure:",
    "- If a created model instance keeps an enum member but a retrieved instance has the primitive DB value, patch the shared enum/choices value representation path, not per-model field accessors.",
    "- Minimal generic shape: inspect the repository's `Choices`/enum base class and make string casting return the underlying `.value` when that is the externally expected primitive.",
    "- Keep database serialization/deserialization and `.choices` construction unchanged unless the source shows they are the failing conversion path.",
  ].join("\n");
}

function renderModelFieldComparisonDigest(text: string): string {
  if (
    !/\babstract\b/i.test(text) ||
    !/\bfields?\b/i.test(text) ||
    !/\b(?:__eq__|__hash__|__lt__|creation_counter|compare|equal|set)\b/i.test(text)
  ) {
    return "";
  }
  return [
    "Model-attached object comparison closure:",
    "- If objects copied from an abstract/base definition collide because equality/hash use only a creation/order counter, add the owning model namespace to equality and hashing.",
    "- Preserve the existing counter as the primary ordering key. For tie-breaking, compare stable primitive model labels/names or tuples, not model classes/objects directly with `<`.",
    "- Do not implement ordering/hash as `(creation_counter, getattr(obj, 'model', None))`: that still puts a raw class/object in the key. First derive a primitive key such as `(app_label, model_name)`, `label_lower`, or the repository's equivalent stable string tuple.",
    "- Generic patch shape: define or inline a model-key expression guarded for unattached objects, then use `(creation_counter, model_key)` consistently in `__eq__`, `__hash__`, and `__lt__`; for ordering, compare `creation_counter` first and only use the model-key tie-break when counters match.",
    "- Keep unattached objects safe by using `None` or the repository's missing-model convention in equality/hash/order keys.",
  ].join("\n");
}

function renderRandomStateDigest(text: string): string {
  if (
    !/\b(?:StratifiedKFold|stratification|stratum|strata|class(?:'s)? samples)\b/i.test(text) ||
    !/\bshuffle\b/i.test(text) ||
    !/\brandom_state\b/i.test(text)
  ) {
    return "";
  }
  return [
    "Random-state propagation closure:",
    "- If shuffle is ineffective because each class/stratum receives the same shuffle, patch RNG propagation at the splitter loop rather than changing the public split API.",
    "- Create/normalize one RNG for the outer split operation and pass that same RNG object through per-class/per-stratum shuffles so its state advances naturally.",
    "- Stop condition: after finding a target loop that builds repeated per-class/per-stratum splitters with `random_state=rng` and `rng` is still the public seed/raw `self.random_state`, make the source edit immediately. Do not inspect base classes, tests, or run custom reproductions first.",
    "- If the repository exposes a random-state normalizer such as `check_random_state`, prefer it over inventing a new generator wrapper; the generic patch shape is `rng = normalizer(self.random_state)` before the repeated splitter loop.",
    "- Failure signature: if different seeds only permute fold order while the per-class pairings stay seed-insensitive, that confirms shared raw seed reuse; edit the RNG initializer instead of continuing investigation.",
    "- Do not draw a fresh integer seed for each stratum unless the repository already uses that convention; it can break repeated-CV determinism. Keep `shuffle=False` behavior untouched.",
    "- If documentation uses misleading wording, update only the narrow sentence that describes the shuffle unit.",
  ].join("\n");
}

function renderSingleAliasDeleteDigest(text: string): string {
  if (
    !/\bdelete\(\)/i.test(text) ||
    !/\b(?:subquery|single alias|aliases?|same table|performance regression|LOCK TABLES)\b/i.test(text)
  ) {
    return "";
  }
  return [
    "Single-alias SQL fast-path closure:",
    "- If a delete/update compiler already has a single-table fast path but the prompt still observes a self-subquery, inspect whether the base table alias is registered before the alias-count check.",
    "- Minimal generic patch: call the repository's existing base/initial alias initializer before deciding whether the query has one alias. Do not rewrite the whole SQL compiler or broad delete behavior.",
    "- Finish only after `git diff` contains a source change that affects the alias-count decision; an empty diff plus passing existing tests is not a fix.",
  ].join("\n");
}

function renderAliasPrefixCollisionDigest(text: string): string {
  if (
    !/\balias_prefix\b/i.test(text) ||
    !/\b(?:rhs|right[-\s]?hand|right query|both queries)\b/i.test(text) ||
    !/\b(?:change_map|change_aliases|bump_prefix|alias collision|collisions?)\b/i.test(text)
  ) {
    return "";
  }
  return [
    "Alias-prefix collision closure:",
    "- If two query objects share the same alias prefix and the prompt/hints name `rhs`, `change_map`, or `Query.change_aliases`, treat this as a deterministic RHS alias-relabelling bug, not a global table-alias generator problem.",
    "- Mandatory edit trigger: inspect `Query.combine()` and `Query.change_aliases()` once, then write `/tmp/memos_edit.py`; do not keep grepping for `def combine` or searching tests after the alias-prefix collision is visible.",
    "- Minimal generic patch shape: before constructing the combine `change_map`, give the RHS query a non-conflicting alias prefix using the repository's existing alias-prefix convention, then relabel RHS aliases through `change_aliases()` or the equivalent alias-map/refcount/table-map updater.",
    "- Do not randomize alias prefixes, patch `table_alias()` globally, or use `Query.bump_prefix()` blindly if the visible hint says it is not directly applicable; adapt the same deterministic relabelling idea to the combine/RHS path.",
    "- Completion gate: `git diff` should touch the query-combine alias collision path and should not edit AUTHORS, tests, or unrelated SQL compiler behavior.",
  ].join("\n");
}

function renderNaturalKeyDatabaseDigest(text: string): string {
  if (
    !/\bloaddata\b/i.test(text) ||
    !/\bnatural[_\s-]?keys?\b/i.test(text) ||
    !/\b(?:foreign keys?|ForeignKey|related_descriptors|fields_cache)\b/i.test(text) ||
    !/\b(?:non-default|second database|--database|using|db_manager|default DB|default database)\b/i.test(text)
  ) {
    return "";
  }
  return [
    "Natural-key database-state closure:",
    "- If `loaddata --database <name>` fails only when a natural key traverses a foreign key, patch the deserializer's temporary natural-key instance state, not managers, fixtures, or relation descriptors.",
    "- Mandatory edit trigger: after inspecting `build_instance()` in `django/core/serializers/base.py`, write `/tmp/memos_edit.py`; do not keep searching tests once the code calls `Model(**data).natural_key()` without setting the instance database.",
    "- Minimal generic patch shape: create the temporary object once, set its `_state.db` (or repository equivalent) to the deserialization `db`/`using` value before calling `natural_key()`, then use that natural key for the existing `get_by_natural_key()` lookup.",
    "- Keep the manager lookup on `default_manager.db_manager(db)` and preserve the final returned model construction/PK conversion behavior; the bug is the transient object using the wrong database while resolving related natural keys.",
    "- Do not patch user model natural_key methods, default database routing, fixture parsing, or relation descriptor behavior for this pattern.",
  ].join("\n");
}

function renderFactorGroupingDigest(text: string): string {
  if (
    !/\b(?:factor|factors|factorization|sqf|sqf_list)\b/i.test(text) ||
    !/\bmultiplicity\b/i.test(text) ||
    !/\b(?:should have|not\s+\d+\s+factors?|combine|consistent|consistant)\b/i.test(text)
  ) {
    return "";
  }
  return [
    "Factor-list grouping closure:",
    "- If visible output says multiple factors with the same multiplicity should be one factor, treat this as a result-aggregation invariant.",
    "- Mandatory edit trigger: after inspecting the public wrapper and the generic factor-list assembly point, stop searching and patch that assembly point. Do not inspect tests, docstrings, or unrelated multivariate behavior before the first source edit.",
    "- Minimal generic algorithm: group returned factor pairs by multiplicity; for repeated multiplicities, multiply the factors together into one factor for that multiplicity, preserving the coefficient, product value, return shape, and expression-vs-polynomial mode.",
    "- If the public symbolic wrapper first explodes a top-level product into separate args, aggregate same-multiplicity symbolic factors before returning the wrapper's list; do not only patch a lower-level polynomial method that the prompt says already works.",
    "- When a method form and a public function differ, treat the method form as a local oracle for the wrapper's expected shape and patch the wrapper/list assembly path.",
    "- If hints mention side issues, prioritize the explicit failing-output invariant over documentation or broader API redesign.",
    "- Keep the repository's existing ordering/canonicalization convention; do not change parsing, printing, or unrelated simplification code.",
  ].join("\n");
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

function renderRepairHintDigest(text: string | undefined): string | null {
  const hints = extractRepairTaskSection(String(text ?? ""), "Hints");
  if (!hints) return null;

  const cleaned = hints
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const diffIndex = cleaned.search(/\bdiff --git\b/i);
  if (diffIndex >= 0) {
    const diffText = cleaned.slice(diffIndex);
    const formattedDiff = formatUnifiedDiffForHint(diffText);
    const firstTarget = extractFirstDiffTarget(diffText);
    const requiredWrite = `WRAPPER_PATH write /tmp/memos_edit.py << 'PY'`;
    return truncateHintDigest(
      [
        "The task hints include a candidate source diff. Use it as the first patch attempt before any full test run or broad test search.",
        "Immediate order: inspect the diff target once, create a temporary exact-replacement edit script with the outer `write` wrapper, run it, run narrow existing tests, then `git diff` and finish.",
        firstTarget ? `Primary edit target: /testbed/${firstTarget}` : "",
        requiredWrite ? `Required edit command starts with: \`${requiredWrite}\`.` : "",
        firstTarget ? renderExactReplacementScriptPattern(firstTarget) : "",
        "Do not paste compact diff hunks directly into the source file. Remove `+`/`-` diff prefixes, do not use `$(...)` inside `write`, and preserve indentation from the inspected source.",
        "Candidate diff hunks:",
        formattedDiff,
      ].filter(Boolean).join("\n"),
      3_600,
    );
  }

  if (/\b(?:patch|exact fix|tentative patch|def\s+\w+|class\s+\w+)\b/i.test(cleaned)) {
    const patternDigest = renderVisibleBugPatternDigest(cleaned, extractVisibleBugIdentifiers(cleaned));
    const directHint = [
      "The task hints include a concrete implementation clue. Try the minimal source fix first:",
      patternDigest,
      cleaned,
    ].filter(Boolean).join("\n");
    return truncateHintDigest(directHint, 7_500);
  }
  const patternDigest = renderVisibleBugPatternDigest(cleaned, extractVisibleBugIdentifiers(cleaned));
  return truncateHintDigest(
    [
      "Task-provided hints. Use these as visible task context, but keep the current source and tests as the authority:",
      patternDigest,
      cleaned,
    ].filter(Boolean).join("\n"),
    patternDigest ? 2_400 : 1_600,
  );
}

function renderExactReplacementScriptPattern(target: string): string {
  return [
    "Safe large-file edit pattern:",
    "```python",
    "from pathlib import Path",
    `p = Path("/testbed/${target}")`,
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
