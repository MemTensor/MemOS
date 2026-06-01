/**
 * Gathers supporting L1 traces for a crystallization candidate.
 *
 * Reads episode **canonical** `traceIds` when present, otherwise a high
 * `limit` list, then dedupes by `traceIdentitySignature` before scoring.
 */

import type { EpisodeId, PolicyRow, SkillRow, TraceId, TraceRow } from "../types.js";
import type { Repos } from "../storage/repos/index.js";
import { traceIdentitySignature } from "../trace/trace-identity.js";
import type { SkillConfig } from "./types.js";

/** Match `traces.list` cap — long episodes must not truncate to the default 50. */
export const EPISODE_TRACE_POOL_LIMIT = 500;

export interface EvidenceResult {
  traces: TraceRow[];
  episodeIds: EpisodeId[];
  medianValue: number;
  /** Traces considered before top-N slice (after signature dedupe). */
  poolAfterDedupe: number;
}

export interface EvidenceDeps {
  repos: Pick<Repos, "traces" | "episodes">;
  config: Pick<SkillConfig, "evidenceLimit" | "traceCharCap">;
}

export function gatherEvidence(policy: PolicyRow, deps: EvidenceDeps): EvidenceResult {
  const episodeIds = policy.sourceEpisodeIds.slice();
  if (episodeIds.length === 0) {
    return { traces: [], episodeIds, medianValue: 0, poolAfterDedupe: 0 };
  }

  const pool: TraceRow[] = [];
  for (const episodeId of episodeIds) {
    pool.push(...loadEpisodeTraces(episodeId, deps.repos));
  }

  const deduped = dedupeTracesBySignature(pool, (t, p) => scoreTrace(t, policy) - scoreTrace(p, policy));
  const sorted = deduped
    .filter((t) => !isRedacted(t))
    .sort((a, b) => {
      const av = scoreTrace(a, policy);
      const bv = scoreTrace(b, policy);
      if (bv !== av) return bv - av;
      return b.ts - a.ts;
    });

  const kept = sorted
    .slice(0, Math.max(1, deps.config.evidenceLimit))
    .map((t) => capTrace(t, deps.config.traceCharCap));

  const keptEpisodeIds: EpisodeId[] = [];
  const seen = new Set<string>();
  for (const t of kept) {
    if (!seen.has(t.episodeId)) {
      seen.add(t.episodeId);
      keptEpisodeIds.push(t.episodeId);
    }
  }

  return {
    traces: kept,
    episodeIds: keptEpisodeIds,
    medianValue: medianValueOf(kept),
    poolAfterDedupe: deduped.length,
  };
}

export interface IncrementalEvidenceResult {
  traces: TraceRow[];
  poolAfterDedupe: number;
}

/**
 * Canonical traces whose ids are not yet in `skill.evidenceAnchors`, after
 * signature dedupe (ignores orphan duplicate rows).
 */
export function gatherIncrementalEvidence(
  policy: PolicyRow,
  existingSkill: SkillRow,
  deps: EvidenceDeps,
): IncrementalEvidenceResult {
  const anchors = new Set<string>((existingSkill.evidenceAnchors ?? []) as string[]);
  const pool: TraceRow[] = [];

  for (const episodeId of policy.sourceEpisodeIds) {
    for (const t of loadEpisodeTraces(episodeId, deps.repos)) {
      if (!anchors.has(t.id)) pool.push(t);
    }
  }

  const deduped = dedupeTracesBySignature(pool, (a, b) => b.value - a.value);
  const sorted = deduped
    .filter((t) => !isRedacted(t))
    .sort((a, b) => {
      if (b.value !== a.value) return b.value - a.value;
      return b.ts - a.ts;
    });

  return {
    traces: sorted.slice(0, Math.max(1, deps.config.evidenceLimit)),
    poolAfterDedupe: deduped.length,
  };
}

export function gatherCounterExamples(
  policy: PolicyRow,
  deps: EvidenceDeps,
): TraceRow[] {
  if (policy.sourceEpisodeIds.length === 0) return [];
  const pool: TraceRow[] = [];
  for (const episodeId of policy.sourceEpisodeIds) {
    for (const t of loadEpisodeTraces(episodeId, deps.repos)) {
      if (Number.isFinite(t.value) && t.value < 0) pool.push(t);
    }
  }
  const deduped = dedupeTracesBySignature(pool, (a, b) => a.value - b.value);
  deduped.sort((a, b) => a.value - b.value);
  return deduped.slice(0, 5).map((t) => capTrace(t, deps.config.traceCharCap));
}

function loadEpisodeTraces(
  episodeId: EpisodeId,
  repos: Pick<Repos, "traces" | "episodes">,
): TraceRow[] {
  const episode = repos.episodes.getById(episodeId);
  const canonicalIds = episode?.traceIds ?? [];
  if (canonicalIds.length > 0) {
    const rows: TraceRow[] = [];
    for (const id of canonicalIds) {
      const row = repos.traces.getById(id as TraceId);
      if (row) rows.push(row);
    }
    if (rows.length > 0) return rows;
  }
  return repos.traces.list({ episodeId, limit: EPISODE_TRACE_POOL_LIMIT });
}

function dedupeTracesBySignature(
  traces: TraceRow[],
  prefer: (a: TraceRow, b: TraceRow) => number,
): TraceRow[] {
  const best = new Map<string, TraceRow>();
  for (const t of traces) {
    const sig = traceIdentitySignature(t);
    const prev = best.get(sig);
    if (!prev || prefer(t, prev) < 0) best.set(sig, t);
  }
  return Array.from(best.values());
}

function scoreTrace(trace: TraceRow, policy: PolicyRow): number {
  const v = Number.isFinite(trace.value) ? trace.value : 0;
  const cosBonus = cosineOrZero(trace.vecSummary, policy.vec) * 0.2;
  return v + cosBonus;
}

function cosineOrZero(
  a: Float32Array | null | undefined,
  b: Float32Array | null | undefined,
): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let la = 0;
  let lb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    la += ai * ai;
    lb += bi * bi;
  }
  if (la === 0 || lb === 0) return 0;
  return dot / (Math.sqrt(la) * Math.sqrt(lb));
}

function capTrace(trace: TraceRow, cap: number): TraceRow {
  const userText = capString(trace.userText, cap);
  const agentText = capString(trace.agentText, cap);
  if (userText === trace.userText && agentText === trace.agentText) return trace;
  return { ...trace, userText, agentText };
}

function capString(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return s.slice(0, cap) + "…";
}

function isRedacted(t: TraceRow): boolean {
  return t.userText === "[REDACTED]" || t.agentText === "[REDACTED]";
}

function medianValueOf(rows: TraceRow[]): number {
  if (rows.length === 0) return 0;
  const sorted = rows.map((r) => r.value).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}
