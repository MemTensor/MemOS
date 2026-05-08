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
import type { RetrievalConfig } from "./types.js";

const DEFAULT_CANDIDATE_BODY_CHARS = 500;
const MIN_FILTER_OUTPUT_TOKENS = 160;
const MAX_FILTER_OUTPUT_TOKENS = 2048;

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
    | "llm_kept_all"
    | "llm_filtered"
    // The LLM was supposed to run but the call failed / parsed badly.
    // We applied a mechanical relevance cutoff (top-K above
    // `relativeThresholdFloor · topRelevance`) instead of dumping the
    // entire ranked list into the prompt.
    | "llm_failed_safe_cutoff";
  /**
   * The LLM's self-report on whether the *kept* candidates are enough
   * to answer `query`, or whether the caller should widen recall /
   * run a follow-up `memory_search`. `null` when the filter didn't
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
      // Model asked us to drop everything — honoured. Surface this
      // explicitly so the Logs page can show "LLM found nothing
      // relevant" instead of silently injecting a partial packet.
      return {
        kept: [],
        dropped: [...ranked],
        outcome: "llm_filtered",
        sufficient: sufficient ?? false,
      };
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
