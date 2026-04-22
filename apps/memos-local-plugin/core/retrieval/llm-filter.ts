/**
 * LLM-based relevance filter — post-processing step after `rank()`.
 *
 * Motivation (ported from legacy `memos-local-openclaw::unifiedLLMFilter`):
 * cosine retrieval is greedy — any Python prompt pulls back every
 * Python-tagged trace even when the sub-problem doesn't match. A small
 * LLM call ("given this query, pick the truly relevant candidates")
 * removes most of the noise with a single round-trip.
 *
 * Design constraints:
 *   - One LLM call per turn, bounded output (just the index list).
 *   - Totally opt-in: if the LLM is null, or the config flag is off,
 *     or the candidate list is small enough, we pass through the
 *     ranked list unchanged.
 *   - On ANY failure (network, schema, timeout) we fall back to the
 *     ranked list. A missing filter must never crash retrieval.
 *   - Returns both kept and dropped candidates so callers can log
 *     exactly what the LLM pruned (feeds the Logs page).
 */

import type { LlmClient } from "../llm/index.js";
import type { Logger } from "../logger/types.js";
import { RETRIEVAL_FILTER_PROMPT } from "../llm/prompts/index.js";
import type { RankedCandidate } from "./ranker.js";
import type { RetrievalConfig } from "./types.js";

const MAX_CANDIDATE_CONTENT_CHARS = 240;

export interface FilterInput {
  query: string;
  ranked: readonly RankedCandidate[];
}

export interface FilterDeps {
  llm: LlmClient | null;
  log: Logger;
  config: Pick<
    RetrievalConfig,
    "llmFilterEnabled" | "llmFilterMaxKeep" | "llmFilterMinCandidates"
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
}

export async function llmFilterCandidates(
  input: FilterInput,
  deps: FilterDeps,
): Promise<FilterResult> {
  const { ranked, query } = input;
  if (!deps.config.llmFilterEnabled) {
    return passthrough(ranked, "disabled");
  }
  // `llmFilterMinCandidates` is "minimum candidates required to RUN the
  // filter". `<` so a packet with exactly the threshold count still gets
  // a precision pass (the most useful case — small but noisy packets).
  if (ranked.length < deps.config.llmFilterMinCandidates) {
    return passthrough(ranked, "below_threshold");
  }
  if (!query || !query.trim()) {
    return passthrough(ranked, "empty_query");
  }
  if (!deps.llm) {
    return passthrough(ranked, "no_llm");
  }

  const items = ranked.map((r, i) => ({
    index: i,
    label: describeCandidate(r),
  }));
  const list = items
    .map((x) => `${x.index + 1}. ${x.label}`)
    .join("\n");

  try {
    const rsp = await deps.llm.completeJson<{ selected?: unknown }>(
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
        temperature: 0,
        // Short output — we only need an array of integers. Keep the
        // token cap tight so a misbehaving model can't blow budgets.
        maxTokens: 120,
        malformedRetries: 1,
      },
    );
    const raw = (rsp.value?.selected ?? []) as unknown;
    if (!Array.isArray(raw)) {
      deps.log.debug("llm_filter.malformed", {
        got: typeof raw,
      });
      // Same fallback policy as throw — we'd rather lean conservative
      // than dump the whole ranked list into the prompt.
      return safeCutoff(ranked, deps);
    }
    // Convert 1-based indices → 0-based, drop duplicates and out-of-range.
    const keepIndices = new Set<number>();
    for (const v of raw) {
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n)) continue;
      const zero = Math.floor(n) - 1;
      if (zero < 0 || zero >= ranked.length) continue;
      keepIndices.add(zero);
      if (keepIndices.size >= deps.config.llmFilterMaxKeep) break;
    }
    if (keepIndices.size === 0) {
      // Model asked us to drop everything — we honour it even when the
      // ranked list was non-empty. Surface this explicitly so the Logs
      // page can show "LLM found nothing relevant" instead of silently
      // injecting a partial packet.
      return {
        kept: [],
        dropped: [...ranked],
        outcome: "llm_filtered",
      };
    }
    const kept: RankedCandidate[] = [];
    const dropped: RankedCandidate[] = [];
    ranked.forEach((r, i) => {
      (keepIndices.has(i) ? kept : dropped).push(r);
    });
    return {
      kept,
      dropped,
      outcome:
        kept.length === ranked.length ? "llm_kept_all" : "llm_filtered",
    };
  } catch (err) {
    deps.log.warn("llm_filter.failed", {
      err: err instanceof Error ? err.message : String(err),
      candidateCount: ranked.length,
    });
    return safeCutoff(ranked, deps);
  }
}

function passthrough(
  ranked: readonly RankedCandidate[],
  outcome: FilterResult["outcome"],
): FilterResult {
  return { kept: [...ranked], dropped: [], outcome };
}

/**
 * Mechanical fail-closed: when the LLM is unavailable / errored,
 * apply a relative-relevance cutoff so we don't dump the entire ranked
 * list into the prompt. Keeps:
 *   1. items whose score ≥ `topScore · relativeThresholdFloor`
 *   2. capped at `llmFilterMaxKeep` so the prompt stays small.
 *
 * The ranker already applied an initial cutoff with the same floor,
 * but the LLM is expected to prune further (because cosine + RRF still
 * over-includes); this fallback uses a slightly tighter ratio so the
 * "fail" path doesn't ship as much noise as the success path.
 */
function safeCutoff(
  ranked: readonly RankedCandidate[],
  deps: FilterDeps,
): FilterResult {
  if (ranked.length === 0) {
    return { kept: [], dropped: [], outcome: "llm_failed_safe_cutoff" };
  }
  // Tighter than the ranker's relativeThresholdFloor — when LLM has
  // failed, lean conservative.
  const ratio = 0.7;
  const topScore = ranked.reduce((m, c) => Math.max(m, c.score ?? c.relevance), 0);
  const cutoff = topScore > 0 ? topScore * ratio : 0;
  const keepCap = Math.max(1, deps.config.llmFilterMaxKeep);
  const kept: RankedCandidate[] = [];
  const dropped: RankedCandidate[] = [];
  for (const c of ranked) {
    const s = c.score ?? c.relevance;
    if (s >= cutoff && kept.length < keepCap) kept.push(c);
    else dropped.push(c);
  }
  // If the cutoff would have dropped everything, keep the single best
  // candidate so the agent at least sees one option. Better than 0.
  if (kept.length === 0 && ranked.length > 0) {
    kept.push(ranked[0]!);
    dropped.shift();
  }
  return { kept, dropped, outcome: "llm_failed_safe_cutoff" };
}

function describeCandidate(r: RankedCandidate): string {
  const c = r.candidate;
  switch (c.tier) {
    case "tier1": {
      const skill = c as {
        skillName?: string;
        invocationGuide?: string;
        eta?: number;
      };
      const name = skill.skillName ?? "(skill)";
      const hint = (skill.invocationGuide ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_CANDIDATE_CONTENT_CHARS);
      return `[SKILL] ${name} — ${hint}`;
    }
    case "tier2": {
      if (c.refKind === "trace") {
        const tr = c as {
          summary?: string;
          userText?: string;
          agentText?: string;
          reflection?: string | null;
        };
        const body = (tr.summary || tr.userText || tr.agentText || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, MAX_CANDIDATE_CONTENT_CHARS);
        return `[TRACE] ${body}`;
      }
      const ep = c as { summary?: string };
      const body = (ep.summary ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_CANDIDATE_CONTENT_CHARS);
      return `[EPISODE] ${body}`;
    }
    case "tier3": {
      const wm = c as { title?: string; body?: string };
      const head = wm.title ?? "(world-model)";
      const hint = (wm.body ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_CANDIDATE_CONTENT_CHARS);
      return `[WORLD-MODEL] ${head} — ${hint}`;
    }
    default:
      return "[UNKNOWN]";
  }
}
