/**
 * Gathers supporting L1 traces for a crystallization candidate.
 *
 * Strategy (V7 §2.3 / §2.5.1):
 *   1. Take the policy's `sourceEpisodeIds` as the canonical evidence cone.
 *   2. For each episode, pull its traces and score them by `value` (V).
 *   3. Apply a blended cosine score against the policy vector — high-V
 *      traces that are also semantically aligned with the policy are the
 *      strongest evidence.
 *   4. Return the top `evidenceLimit` traces, char-capped, sorted by score.
 *
 * This module does **not** call the LLM. It's a pure read-side helper over
 * the storage repos, so it's cheap to run on every reward tick.
 */

import type { EpisodeId, PolicyRow, TraceRow } from "../types.js";
import type { Repos } from "../storage/repos/index.js";
import type { SkillConfig } from "./types.js";

export interface EvidenceResult {
  traces: TraceRow[];
  episodeIds: EpisodeId[];
  /** Median V across the kept traces — used for logging only. */
  medianValue: number;
}

export interface EvidenceDeps {
  repos: Pick<Repos, "traces">;
  config: Pick<SkillConfig, "evidenceLimit" | "traceCharCap">;
}

export function gatherEvidence(
  policy: PolicyRow,
  deps: EvidenceDeps,
): EvidenceResult {
  const episodeIds = policy.sourceEpisodeIds.slice();
  if (episodeIds.length === 0) {
    return { traces: [], episodeIds, medianValue: 0 };
  }

  const pool: TraceRow[] = [];
  for (const episodeId of episodeIds) {
    const traces = deps.repos.traces.list({ episodeId, limit: 20 });
    for (const t of traces) pool.push(t);
  }

  pool.sort((a, b) => {
    const av = scoreTrace(a, policy);
    const bv = scoreTrace(b, policy);
    if (bv !== av) return bv - av;
    return b.ts - a.ts;
  });

  const kept = pool
    .filter((t) => !isRedacted(t))
    .slice(0, Math.max(1, deps.config.evidenceLimit))
    .map((t) => capTrace(t, deps.config.traceCharCap));

  const median = medianValueOf(kept);

  const keptEpisodeIds: EpisodeId[] = [];
  const seen = new Set<string>();
  for (const t of kept) {
    if (!seen.has(t.episodeId)) {
      seen.add(t.episodeId);
      keptEpisodeIds.push(t.episodeId);
    }
  }

  return { traces: kept, episodeIds: keptEpisodeIds, medianValue: median };
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
