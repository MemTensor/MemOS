/**
 * LLM-based relevance filter — post-processing step after `rank()`.
 *
 * Motivation (ported from legacy `memos-local-openclaw::unifiedLLMFilter`):
 * mechanical retrieval is greedy — any Python prompt pulls back every
 * Python-tagged trace even when the sub-problem doesn't match. A small
 * LLM call ("given this query, pick the truly relevant candidates")
 * removes most of the noise with a single round-trip.
 *
 * Design constraints:
 *   - One LLM call per turn, bounded output (index list + `sufficient`).
 *   - Totally opt-in: if the LLM is null, or the config flag is off,
 *     or the candidate list is empty, we pass through unchanged.
 *   - On ANY failure (network, schema, timeout) we fall back to a
 *     mechanical cutoff. A broken filter must never crash retrieval.
 *   - Returns both kept and dropped candidates so callers can log
 *     exactly what the LLM pruned (feeds the Logs page).
 *   - Rich candidate labels — we include role/time/tags/channels/score
 *     because openclaw's filter runs on those fields and loses precision
 *     without them.
 */

import type { LlmClient } from "../llm/index.js";
import type { Logger } from "../logger/types.js";
import { RETRIEVAL_FILTER_PROMPT } from "../llm/prompts/index.js";
import type { RankedCandidate } from "./ranker.js";
import type { RetrievalConfig, TraceCandidate } from "./types.js";

const DEFAULT_CANDIDATE_BODY_CHARS = 500;
const MIN_FILTER_OUTPUT_TOKENS = 160;
const MAX_FILTER_OUTPUT_TOKENS = 2048;

/**
 * A trace whose `agentText` falls under this length, with no LLM summary
 * or reflection to back it up, is treated as a near-duplicate question
 * trace (issue #1913). The rescue path keeps these *behind* informative
 * candidates so the answer-bearing trace surfaces first.
 */
const INFORMATIVE_AGENT_TEXT_MIN_CHARS = 20;

/**
 * Short acknowledgement / scaffold replies that the filter prompt
 * rightly classes as "scaffolding chatter". When the LLM filter empties
 * the kept set we still need to make a rescue call — these strings let
 * us prefer informative replies over plain acks. Bounded list, exact
 * matches only after trimming surrounding punctuation / whitespace.
 */
const SHORT_ACK_PATTERNS: readonly RegExp[] = [
  /^(ok|okay|sure|got it|noted|understood|alright|will do|copy|copy that|thanks|thank you|✓|✅|👍)[\s.!]*$/i,
  /^(记住了|已记住|已经记住|好的|明白|收到|了解|谢谢)[\s。!]*$/,
];

export interface FilterInput {
  query: string;
  ranked: readonly RankedCandidate[];
  /**
   * Episode this retrieval is happening for (typically the active or
   * just-opening episode). Forwarded to the LLM call so the resulting
   * `system_model_status` audit row can be grouped with the rest of
   * that episode's pipeline activity in the Logs viewer.
   */
  episodeId?: string;
}

export interface FilterDeps {
  llm: LlmClient | null;
  log: Logger;
  timeoutMs?: number;
  config: Pick<
    RetrievalConfig,
    | "llmFilterEnabled"
    | "llmFilterMaxKeep"
    | "llmFilterMinCandidates"
    | "llmFilterCandidateBodyChars"
  >;
}

export interface FilterResult {
  kept: RankedCandidate[];
  dropped: RankedCandidate[];
  /**
   * Why the filter took this shape — surfaced so logs can show
   * "skipped: below threshold" vs "llm returned no selections".
   */
  outcome:
    | "disabled"
    | "no_llm"
    | "below_threshold"
    | "empty_query"
    | "deferred_to_final"
    | "llm_kept_all"
    | "llm_filtered"
    // The LLM returned an empty selection over a non-empty ranked list
    // (issue #1913 — repeated question traces crowding the hit set).
    // We rescued the top-K best-scoring candidates so the agent always
    // sees a packet when retrieval succeeded; `sufficient` is forced
    // to `false` so downstream callers know the injection is weak.
    | "llm_filtered_refilled"
    // The LLM was supposed to run but the call failed / parsed badly.
    // We applied a mechanical relevance cutoff (top-K above
    // `relativeThresholdFloor · topRelevance`) instead of dumping the
    // entire ranked list into the prompt.
    | "llm_failed_safe_cutoff";
  /**
   * The LLM's self-report on whether the *kept* candidates are enough
   * to answer `query`, or whether the caller should widen recall /
   * run a follow-up `memos_search`. `null` when the filter didn't
   * run (disabled / passthrough / failure paths).
   */
  sufficient: boolean | null;
}

export async function llmFilterCandidates(
  input: FilterInput,
  deps: FilterDeps,
): Promise<FilterResult> {
  const { ranked, query } = input;
  if (!deps.config.llmFilterEnabled) {
    return passthrough(ranked, "disabled");
  }
  // `llmFilterMinCandidates` is the *minimum* list length required to
  // RUN the filter. Default is 1, meaning even a single candidate gets
  // a precision pass — openclaw behaviour, and matches the user
  // reports that "a single off-topic memory sneaks through when the
  // filter skips the check".
  if (ranked.length < deps.config.llmFilterMinCandidates) {
    return passthrough(ranked, "below_threshold");
  }
  if (ranked.length === 0) {
    return passthrough(ranked, "below_threshold");
  }
  if (!query || !query.trim()) {
    return passthrough(ranked, "empty_query");
  }
  if (!deps.llm) {
    return passthrough(ranked, "no_llm");
  }

  const bodyChars =
    deps.config.llmFilterCandidateBodyChars ?? DEFAULT_CANDIDATE_BODY_CHARS;
  const items = ranked.map((r, i) => ({
    index: i,
    label: describeCandidate(r, bodyChars),
  }));
  const list = items.map((x) => `${x.index + 1}. ${x.label}`).join("\n");

  try {
    const rsp = await deps.llm.completeJson<{
      ranked?: unknown;
      selected?: unknown;
      sufficient?: unknown;
    }>(
      [
        { role: "system", content: RETRIEVAL_FILTER_PROMPT.system },
        {
          role: "user",
          content: `QUERY: ${query.slice(0, 500)}

CANDIDATES:
${list}`,
        },
      ],
      {
        op: `retrieval.${RETRIEVAL_FILTER_PROMPT.id}.v${RETRIEVAL_FILTER_PROMPT.version}`,
        phase: "retrieve",
        episodeId: input.episodeId,
        temperature: 0,
        timeoutMs: deps.timeoutMs,
        // Output is only ordered indices + one bool, but the list can
        // legitimately be as long as the ranked candidates.
        maxTokens: filterOutputTokenBudget(ranked.length),
        malformedRetries: 1,
      },
    );
    const raw = (rsp.value?.ranked ?? rsp.value?.selected ?? []) as unknown;
    const sufficient = coerceBool(rsp.value?.sufficient);
    if (!Array.isArray(raw)) {
      deps.log.debug("llm_filter.malformed", { got: typeof raw });
      return safeCutoff(ranked, deps);
    }
    const orderedIndices: number[] = [];
    const seenIndices = new Set<number>();
    for (const v of raw) {
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n)) continue;
      const zero = Math.floor(n) - 1;
      if (zero < 0 || zero >= ranked.length) continue;
      if (seenIndices.has(zero)) continue;
      seenIndices.add(zero);
      orderedIndices.push(zero);
    }
    const cappedIndices = orderedIndices.slice(
      0,
      Math.max(0, deps.config.llmFilterMaxKeep),
    );
    const keepIndices = new Set(cappedIndices);
    if (keepIndices.size === 0) {
      // Issue #1913: the model asked us to drop everything. Honouring
      // that verbatim used to collapse `turn.start` injection to "" even
      // when retrieval was healthy — the failure mode is a hit set
      // dominated by near-duplicate question traces from prior
      // sessions, where each candidate individually looks like
      // "surface-similar wrong sub-problem" to the filter prompt.
      // Instead, rescue the top-K best-scoring candidates (preferring
      // informative traces over pure-question / ack-only chatter) so
      // the agent always sees a packet when retrieval succeeded.
      // `safeCutoff`'s sibling escape hatch (`llmFilterMaxKeep === 0`)
      // is honoured so operators can still ask for hard drop.
      return rescueFromEmptySelection(ranked, deps, sufficient);
    }
    const kept = cappedIndices.map((i) => ranked[i]!);
    const dropped: RankedCandidate[] = [];
    ranked.forEach((r, i) => {
      if (!keepIndices.has(i)) dropped.push(r);
    });
    return {
      kept,
      dropped,
      outcome:
        kept.length === ranked.length ? "llm_kept_all" : "llm_filtered",
      sufficient,
    };
  } catch (err) {
    deps.log.warn("llm_filter.failed", {
      err: err instanceof Error ? err.message : String(err),
      candidateCount: ranked.length,
    });
    return safeCutoff(ranked, deps);
  }
}

function filterOutputTokenBudget(candidateCount: number): number {
  return Math.min(
    MAX_FILTER_OUTPUT_TOKENS,
    Math.max(MIN_FILTER_OUTPUT_TOKENS, candidateCount * 8 + 80),
  );
}

function passthrough(
  ranked: readonly RankedCandidate[],
  outcome: FilterResult["outcome"],
): FilterResult {
  return { kept: [...ranked], dropped: [], outcome, sufficient: null };
}

/**
 * Issue #1913 rescue path. Invoked when the LLM relevance filter
 * returned `selected: []` for a *non-empty* ranked candidate list — the
 * most common cause is a hit set dominated by near-duplicate question
 * traces from previous sessions, where the filter prompt's "drop
 * scaffolding chatter" / "drop surface-similar wrong sub-problem"
 * rubric is applied to every candidate.
 *
 * Strategy: keep the top-K best-scoring candidates, preferring
 * informative traces (skill / episode / experience / world-model, or a
 * trace whose `agentText`/`summary`/`reflection` carries real content)
 * over pure-question chatter. We do NOT re-query the LLM — the rescue
 * is a single O(n) partition + slice. Outcome label is
 * `"llm_filtered_refilled"` so the Logs viewer can show "LLM collapsed,
 * safety net fired" distinct from a normal `"llm_filtered"`.
 *
 * Escape hatch: `llmFilterMaxKeep === 0` skips the rescue entirely and
 * honours the "drop everything" request (matches existing `safeCutoff`
 * semantics for the same config value).
 */
function rescueFromEmptySelection(
  ranked: readonly RankedCandidate[],
  deps: FilterDeps,
  sufficient: boolean | null,
): FilterResult {
  const keepCap = Math.max(0, deps.config.llmFilterMaxKeep);
  if (keepCap === 0 || ranked.length === 0) {
    return {
      kept: [],
      dropped: [...ranked],
      outcome: "llm_filtered",
      sufficient: sufficient ?? false,
    };
  }
  const informative: RankedCandidate[] = [];
  const chatter: RankedCandidate[] = [];
  for (const r of ranked) {
    if (isInformativeCandidate(r)) informative.push(r);
    else chatter.push(r);
  }
  // Preserve ranker order within each bucket; informative first so the
  // answer-bearing trace surfaces even when the ranker placed it below
  // surface-similar question traces.
  const ordered = [...informative, ...chatter];
  const kept = ordered.slice(0, Math.min(keepCap, ordered.length));
  const keptSet = new Set(kept);
  const dropped = ranked.filter((r) => !keptSet.has(r));
  deps.log.debug("llm_filter.collapsed_refill", {
    ranked: ranked.length,
    rescued: kept.length,
    informative: informative.length,
    chatter: chatter.length,
    filteredAll: true,
  });
  return {
    kept,
    dropped,
    outcome: "llm_filtered_refilled",
    sufficient: sufficient ?? false,
  };
}

/**
 * Returns true when a ranked candidate carries content the agent can
 * actually use. Skills, episodes, experiences, and world-models always
 * count. Traces count when their `summary` or `reflection` is non-empty
 * or their `agentText` is longer than a short acknowledgement.
 *
 * Used by the rescue path (and intentionally only there) to bias the
 * rescued set toward traces with informative assistant text. False
 * negatives (an informative trace mistakenly labelled chatter) still
 * get rescued because they sit in the second half of the ordered list.
 */
function isInformativeCandidate(r: RankedCandidate): boolean {
  const c = r.candidate;
  if (c.refKind !== "trace") return true;
  const t = c as TraceCandidate;
  if ((t.summary?.trim().length ?? 0) > 0) return true;
  if ((t.reflection?.trim().length ?? 0) > 0) return true;
  const agent = t.agentText?.trim() ?? "";
  if (agent.length === 0) return false;
  if (isShortAck(agent)) return false;
  return agent.length >= INFORMATIVE_AGENT_TEXT_MIN_CHARS;
}

function isShortAck(text: string): boolean {
  return SHORT_ACK_PATTERNS.some((re) => re.test(text));
}

/**
 * Mechanical fail-closed: when the LLM is unavailable / errored,
 * apply a relative-relevance cutoff so we don't dump the entire ranked
 * list into the prompt. Keeps:
 *   1. items whose score ≥ `topScore · 0.7`
 *   2. capped at `llmFilterMaxKeep` so the prompt stays small.
 *
 * The ranker already applied an initial cutoff with the same family of
 * floors, but the LLM is expected to prune further (because the
 * ranker is tuned for recall). This fallback uses a slightly tighter
 * ratio so the "fail" path doesn't ship as much noise as the success
 * path.
 */
function safeCutoff(
  ranked: readonly RankedCandidate[],
  deps: FilterDeps,
): FilterResult {
  if (ranked.length === 0) {
    return {
      kept: [],
      dropped: [],
      outcome: "llm_failed_safe_cutoff",
      sufficient: null,
    };
  }
  const ratio = 0.7;
  const topScore = ranked.reduce(
    (m, c) => Math.max(m, c.score ?? c.relevance),
    0,
  );
  const cutoff = topScore > 0 ? topScore * ratio : 0;
  const keepCap = Math.max(0, deps.config.llmFilterMaxKeep);
  if (keepCap === 0) {
    return {
      kept: [],
      dropped: [...ranked],
      outcome: "llm_failed_safe_cutoff",
      sufficient: null,
    };
  }
  const kept: RankedCandidate[] = [];
  const dropped: RankedCandidate[] = [];
  for (const c of ranked) {
    const s = c.score ?? c.relevance;
    if (s >= cutoff && kept.length < keepCap) kept.push(c);
    else dropped.push(c);
  }
  // If the cutoff would have dropped everything, keep the single best
  // candidate so the agent at least sees one option.
  if (kept.length === 0 && ranked.length > 0) {
    kept.push(ranked[0]!);
    dropped.shift();
  }
  return {
    kept,
    dropped,
    outcome: "llm_failed_safe_cutoff",
    sufficient: null,
  };
}

function coerceBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "yes" || v === 1) return true;
  if (v === "false" || v === "no" || v === 0) return false;
  return null;
}

/**
 * Render a ranked candidate into a single labelled string for the LLM.
 * Keep this intentionally content-focused: the filter should judge the
 * candidate's semantic usefulness, not anchor on retrieval internals like
 * timestamps, channels, tags, or ranker scores.
 */
function describeCandidate(r: RankedCandidate, bodyChars: number): string {
  const c = r.candidate;
  switch (c.tier) {
    case "tier1": {
      const skill = c as {
        skillName?: string;
        invocationGuide?: string;
      };
      const head = skill.skillName ?? "(skill)";
      const hint = squashBody(skill.invocationGuide ?? "", bodyChars);
      return `[SKILL] ${head}${hint ? `\n   ${hint}` : ""}`;
    }
    case "tier2": {
      if (c.refKind === "trace") {
        const tr = c as {
          summary?: string;
          userText?: string;
          agentText?: string;
          reflection?: string | null;
        };
        const parts: string[] = [];
        if (tr.summary?.trim()) parts.push(tr.summary.trim());
        if (tr.userText?.trim()) parts.push(`[user] ${tr.userText.trim()}`);
        if (tr.agentText?.trim())
          parts.push(`[assistant] ${tr.agentText.trim()}`);
        if (tr.reflection?.trim())
          parts.push(`[note] ${tr.reflection.trim()}`);
        const body = squashBody(parts.join(" "), bodyChars);
        return `[TRACE] ${body}`;
      }
      if (c.refKind === "experience") {
        const ex = c as {
          title?: string;
          trigger?: string;
          procedure?: string;
          verification?: string;
          experienceType?: string;
          evidencePolarity?: string;
        };
        const parts = [
          ex.title,
          ex.experienceType ? `type=${ex.experienceType}` : null,
          ex.evidencePolarity ? `evidence=${ex.evidencePolarity}` : null,
          ex.trigger,
          ex.procedure,
          ex.verification,
        ].filter(Boolean).join(" ");
        const body = squashBody(parts, bodyChars);
        return `[EXPERIENCE] ${body}`;
      }
      const ep = c as { summary?: string };
      const body = squashBody(ep.summary ?? "", bodyChars);
      return `[EPISODE] ${body}`;
    }
    case "tier3": {
      const wm = c as { title?: string; body?: string };
      const head = wm.title ?? "(world-model)";
      const body = squashBody(wm.body ?? "", bodyChars);
      return `[WORLD-MODEL] ${head}${body ? `\n   ${body}` : ""}`;
    }
    default:
      return "[UNKNOWN]";
  }
}

function squashBody(s: string, max: number): string {
  const cleaned = s.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, Math.max(0, max - 1)) + "…";
}
