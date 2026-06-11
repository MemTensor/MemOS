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
 *   - When the LLM returns an empty selection, we inject nothing — no
 *     mechanical top-1 / safe-cutoff fallback.
 *   - When filter is disabled or no LLM client is configured, a small
 *     mechanical cap still applies so offline installs stay usable.
 *   - Returns both kept and dropped candidates so callers can log
 *     exactly what the LLM pruned (feeds the Logs page).
 */

import type { LlmClient } from "../llm/index.js";
import type { Logger } from "../logger/types.js";
import { RETRIEVAL_FILTER_PROMPT } from "../llm/prompts/index.js";
import { reflectionAsText } from "../capture/types.js";
import type { RankedCandidate } from "./ranker.js";
import type { RetrievalConfig } from "./types.js";

const DEFAULT_CANDIDATE_BODY_CHARS = 500;
const MIN_FILTER_OUTPUT_TOKENS = 160;
const MAX_FILTER_OUTPUT_TOKENS = 2048;

export interface FilterInput {
  query: string;
  ranked: readonly RankedCandidate[];
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
    | "llmFilterFallbackMaxKeep"
    | "llmFilterMinCandidates"
    | "llmFilterCandidateBodyChars"
  >;
}

export interface FilterResult {
  kept: RankedCandidate[];
  dropped: RankedCandidate[];
  outcome:
    | "disabled"
    | "no_llm"
    | "below_threshold"
    | "empty_query"
    | "deferred_to_final"
    | "llm_kept_all"
    | "llm_filtered"
    | "llm_rejected_all"
    | "llm_filter_error";
  sufficient: boolean | null;
}

export async function llmFilterCandidates(
  input: FilterInput,
  deps: FilterDeps,
): Promise<FilterResult> {
  const { ranked, query } = input;
  if (!deps.config.llmFilterEnabled) {
    return fallbackCap(ranked, deps, "disabled");
  }
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
    return fallbackCap(ranked, deps, "no_llm");
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
        maxTokens: filterOutputTokenBudget(ranked.length),
        malformedRetries: 1,
      },
    );
    const raw = (rsp.value?.ranked ?? rsp.value?.selected ?? []) as unknown;
    const sufficient = coerceBool(rsp.value?.sufficient);
    if (!Array.isArray(raw)) {
      deps.log.debug("llm_filter.malformed", { got: typeof raw });
      return rejectAll(ranked, "llm_filter_error", null);
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
      deps.log.warn("llm_filter.empty_selection", {
        candidateCount: ranked.length,
        sufficient: sufficient ?? null,
      });
      return rejectAll(ranked, "llm_rejected_all", sufficient);
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
    return rejectAll(ranked, "llm_filter_error", null);
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

function rejectAll(
  ranked: readonly RankedCandidate[],
  outcome: Extract<FilterResult["outcome"], "llm_rejected_all" | "llm_filter_error">,
  sufficient: boolean | null,
): FilterResult {
  return {
    kept: [],
    dropped: [...ranked],
    outcome,
    sufficient,
  };
}

function fallbackCap(
  ranked: readonly RankedCandidate[],
  deps: FilterDeps,
  outcome: Extract<FilterResult["outcome"], "disabled" | "no_llm">,
): FilterResult {
  const keepCap = fallbackMaxKeep(deps);
  if (keepCap === 0) {
    return {
      kept: [],
      dropped: [...ranked],
      outcome,
      sufficient: null,
    };
  }
  return {
    kept: ranked.slice(0, keepCap),
    dropped: ranked.slice(keepCap),
    outcome,
    sufficient: null,
  };
}

function fallbackMaxKeep(deps: FilterDeps): number {
  return Math.max(
    0,
    deps.config.llmFilterFallbackMaxKeep ?? Math.min(deps.config.llmFilterMaxKeep, 4),
  );
}

function coerceBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "yes" || v === 1) return true;
  if (v === "false" || v === "no" || v === 0) return false;
  return null;
}

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
        {
          const refl = reflectionAsText(tr.reflection)?.trim();
          if (refl) parts.push(`[note] ${refl}`);
        }
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
        return describeExperience(ex, bodyChars);
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

function describeExperience(
  ex: {
    title?: string;
    trigger?: string;
    procedure?: string;
    verification?: string;
    experienceType?: string;
    evidencePolarity?: string;
  },
  bodyChars: number,
): string {
  const headParts = [
    squashBody(ex.title ?? "(experience)", 80),
    ex.experienceType || ex.evidencePolarity
      ? `(${[ex.experienceType, ex.evidencePolarity].filter(Boolean).join(", ")})`
      : null,
  ].filter(Boolean);
  const lines = [`[EXPERIENCE] ${headParts.join(" ")}`];
  const remaining = Math.max(0, bodyChars - lines[0]!.length);
  const triggerBudget = Math.min(160, Math.floor(remaining * 0.38));
  const procedureBudget = Math.min(180, Math.floor(remaining * 0.42));
  const verificationBudget = Math.min(80, Math.floor(remaining * 0.2));
  if (ex.trigger?.trim() && triggerBudget > 0) {
    lines.push(`  Trigger: ${squashBody(ex.trigger, triggerBudget)}`);
  }
  if (ex.procedure?.trim() && procedureBudget > 0) {
    lines.push(`  Do: ${squashBody(ex.procedure, procedureBudget)}`);
  }
  if (ex.verification?.trim() && verificationBudget > 0) {
    lines.push(`  Check: ${squashBody(ex.verification, verificationBudget)}`);
  }
  return lines.join("\n");
}

function squashBody(s: string, max: number): string {
  const cleaned = s.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, Math.max(0, max - 1)) + "…";
}
