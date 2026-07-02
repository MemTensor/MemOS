/**
 * Tier 2 — trace + episode retrieval (V7 §2.6 §0.6).
 *
 * Two flavours of candidates come out of this tier:
 *
 *   1. *Trace-level* hits — single `traces` rows. Used when the agent
 *      needs a concrete "last time I did this, step-by-step" reminder.
 *   2. *Episode-level* roll-ups — best traces per `episode_id` collapse
 *      into one `EpisodeCandidate` per episode summarising the whole
 *      sub-task ("episode replay" in V7 prose).
 *
 * Channels (all run in parallel, fused via RRF in the ranker):
 *
 *   - vec_summary   — cosine over `traces.vec_summary` (state)
 *   - vec_action    — cosine over `traces.vec_action`  (action)
 *   - fts           — FTS5 trigram MATCH over user/agent/summary/reflection/tags
 *   - pattern       — LIKE %term% for queries below the trigram window
 *                     (e.g. 2-char Chinese names)
 *   - structural    — verbatim error-signature substring match
 *
 * Each channel contributes a `ChannelRank` to the candidate; the ranker
 * sums `1 / (k + rank)` across channels (RRF). Candidates that surface
 * in multiple channels get a strong lift — this is what plugs the
 * "single-channel false positive" hole that pure-cosine retrieval has.
 */

import { rootLogger } from "../logger/index.js";
import { priorityFor } from "../reward/backprop.js";
import type { EmbeddingVector, EpisodeId, SessionId, TraceId } from "../types.js";
import type {
  ChannelRank,
  EpisodeCandidate,
  RetrievalChannel,
  RetrievalConfig,
  RetrievalEmbedder,
  RetrievalRepos,
  TraceCandidate,
  TraceVecKind,
} from "./types.js";

const log = rootLogger.child({ channel: "core.retrieval.tier2" });

const MAX_EPISODE_SUMMARY_CHARS = 800;
const DEFAULT_KEYWORD_TOPK = 20;

export interface Tier2Deps {
  repos: Pick<RetrievalRepos, "traces">;
  embedder?: RetrievalEmbedder;
  config: RetrievalConfig;
  now: () => number;
}

export interface Tier2Input {
  queryVec: EmbeddingVector | null;
  /** Optional tag hints — from `buildQuery`. Empty = no tag filtering. */
  tags: readonly string[];
  /**
   * V7 §2.6 structural-match fragments (verbatim error snippets). When
   * non-empty, we issue a dedicated `searchByErrorSignature` query and
   * blend the hits with the semantic candidates before ranking.
   */
  structuralFragments?: readonly string[];
  /** FTS5 MATCH expression (trigram channel). */
  ftsMatch?: string | null;
  /** Pattern terms (2-char ASCII / CJK bigrams). */
  patternTerms?: readonly string[];
  /** Whether `decision_repair` forced `includeLowValue`. */
  includeLowValue?: boolean;
  /**
   * When set, trace search excludes rows from this session (cross-session
   * turn-start retrieval should not repeat the current chat window).
   */
  excludeSessionId?: SessionId;
}

export interface Tier2Result {
  traces: TraceCandidate[];
  episodes: EpisodeCandidate[];
}

export async function runTier2(deps: Tier2Deps, input: Tier2Input): Promise<Tier2Result> {
  const { repos, config } = deps;
  const startedAt = Date.now();
  try {
    const searchFilters = buildTraceSearchFilters(deps, input);
    const vectorFilters = buildVectorSearchFilters(deps, searchFilters);
    const vecPoolSize = Math.max(
      config.tier2TopK,
      Math.ceil(config.tier2TopK * config.candidatePoolFactor),
    );
    const keywordPoolSize = Math.max(
      config.tier2TopK,
      config.keywordTopK ?? DEFAULT_KEYWORD_TOPK,
    );

    const tagsForStorage = resolveTagFilter(input.tags, config);
    const blended: Map<TraceId, TraceCandidate> = new Map();

    // ─── Vector channels ──────────────────────────────────────────────
    if (input.queryVec && input.queryVec.length > 0) {
      const summaryHits = repos.traces.searchByVector(input.queryVec, vecPoolSize, {
        kind: "summary",
        anyOfTags: tagsForStorage,
        where: vectorFilters.where,
        params: vectorFilters.params,
        hardCap: vecPoolSize * 4,
      });
      mergeChannelHits(blended, summaryHits, "vec_summary", input.queryVec);

      if (!config.lightweightMemory) {
        const actionHits = repos.traces.searchByVector(input.queryVec, vecPoolSize, {
          kind: "action",
          anyOfTags: tagsForStorage,
          where: vectorFilters.where,
          params: vectorFilters.params,
          hardCap: vecPoolSize * 4,
        });
        mergeChannelHits(blended, actionHits, "vec_action", input.queryVec);
      }

      // If both vector channels came back empty AND tag filtering is
      // "auto", retry once without tags so a mis-tagged query never
      // yields a vector-empty packet for a user with otherwise relevant
      // traces.
      if (blended.size === 0 && tagsForStorage && config.tagFilter === "auto") {
        log.debug("tag_filter_relaxed", { tags: tagsForStorage });
        const retry = repos.traces.searchByVector(input.queryVec, vecPoolSize, {
          kind: "summary",
          where: vectorFilters.where,
          params: vectorFilters.params,
          hardCap: vecPoolSize * 4,
        });
        mergeChannelHits(blended, retry, "vec_summary", input.queryVec);
      }
    }

    // ─── FTS keyword channel ──────────────────────────────────────────
    if (input.ftsMatch && repos.traces.searchByText) {
      const ftsHits = repos.traces.searchByText(input.ftsMatch, keywordPoolSize, {
        where: searchFilters.where,
        params: searchFilters.params,
      });
      mergeChannelHits(blended, ftsHits, "fts", input.queryVec ?? null);
    }

    // ─── Pattern (LIKE) channel ───────────────────────────────────────
    if (
      input.patternTerms &&
      input.patternTerms.length > 0 &&
      repos.traces.searchByPattern
    ) {
      const patternHits = repos.traces.searchByPattern(input.patternTerms, keywordPoolSize, {
        where: searchFilters.where,
        params: searchFilters.params,
      });
      mergeChannelHits(blended, patternHits, "pattern", input.queryVec ?? null);
    }

    // ─── Structural error-signature channel ───────────────────────────
    if (input.structuralFragments && input.structuralFragments.length > 0) {
      const structuralRows = repos.traces.searchByErrorSignature(
        input.structuralFragments,
        Math.max(config.tier2TopK, 10),
        { where: searchFilters.where, params: searchFilters.params },
      );
      structuralRows.forEach((row, idx) => {
        const sigs = row.errorSignatures ?? [];
        const existing = blended.get(row.id as TraceId);
        if (existing) {
          (existing.channels ??= []).push({
            channel: "structural",
            rank: idx,
            score: 1 / (idx + 1),
          });
          // Boost cosine slightly so structural-match hits out-rank pure
          // semantic hits at the same text similarity (capped at 1).
          existing.cosine = Math.min(1, existing.cosine + 0.08);
          const prevMatched = Array.isArray(existing.debug?.structuralMatched)
            ? (existing.debug!.structuralMatched as string[])
            : [];
          existing.debug = {
            ...existing.debug,
            structuralMatched: [...prevMatched, ...sigs],
          };
          return;
        }
        blended.set(row.id as TraceId, {
          tier: "tier2",
          refKind: "trace",
          refId: row.id as TraceId,
          // Strong synthetic cosine — structural exact match is very
          // high-signal. Capped at 0.9 so real perfect-cosine hits can
          // still edge it out.
          cosine: 0.9,
          ts: row.ts,
          vec: input.queryVec ?? null,
          value: row.value,
          priority: row.priority,
          episodeId: row.episodeId,
          sessionId: row.sessionId,
          vecKind: "summary",
          userText: row.userText,
          agentText: row.agentText,
          summary: row.summary ?? null,
          reflection: row.reflection,
          tags: row.tags,
          channels: [{ channel: "structural", rank: idx, score: 1 / (idx + 1) }],
          debug: {
            structuralMatched: sigs,
          },
        });
      });
    }

    if (blended.size === 0) {
      log.info("done", {
        traceCount: 0,
        episodeCount: 0,
        keywordPoolSize,
        latencyMs: Date.now() - startedAt,
      });
      return { traces: [], episodes: [] };
    }

    // ─── Hydrate from full rows ───────────────────────────────────────
    const ids = [...blended.keys()];
    const rows = repos.traces.getManyByIds(ids);
    const byId = new Map(rows.map((r) => [r.id, r]));

    const traces: TraceCandidate[] = [];
    for (const cand of blended.values()) {
      const row = byId.get(cand.refId);
      if (!row) continue;
      traces.push({
        ...cand,
        value: row.value,
        priority: row.priority,
        userText: row.userText,
        agentText: row.agentText,
        summary: row.summary ?? null,
        reflection: row.reflection,
        tags: row.tags,
      });
    }

    // Sort by blended score (cosine + priority + multi-channel boost) descending.
    traces.sort((a, b) => blendScore(b, deps) - blendScore(a, deps));
    const topTraces = traces.slice(0, config.tier2TopK);

    // Roll up to episode-level summaries.
    const episodes = config.lightweightMemory
      ? []
      : rollupEpisodes(topTraces, deps).slice(0, config.tier2TopK);

    log.info("done", {
      traceCount: topTraces.length,
      episodeCount: episodes.length,
      keywordPoolSize,
      vecPoolSize,
      latencyMs: Date.now() - startedAt,
    });

    return { traces: topTraces, episodes };
  } catch (err) {
    log.error("failed", {
      err: { message: err instanceof Error ? err.message : String(err) },
      latencyMs: Date.now() - startedAt,
    });
    return { traces: [], episodes: [] };
  }
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function buildTraceSearchFilters(
  deps: Tier2Deps,
  input: Tier2Input,
): { where?: string; params?: Record<string, unknown> } {
  const parts: string[] = [];
  const params: Record<string, unknown> = {};
  const includeLow = input.includeLowValue ?? deps.config.includeLowValue;
  if (!includeLow) parts.push("priority > 0");
  if (input.excludeSessionId) {
    parts.push("session_id != @exclude_session_id");
    params.exclude_session_id = input.excludeSessionId;
  }
  if (parts.length === 0) return {};
  return { where: parts.join(" AND "), params };
}

/**
 * Layered on top of {@link buildTraceSearchFilters}. Adds the
 * `vectorScanMaxAgeMs` time-window bound (issue #1929) so the cosine
 * brute-force scan over `traces.vec_summary` / `vec_action` only
 * touches rows newer than the configured cutoff. The keyword
 * channels (FTS / pattern / structural) keep the unbounded view so
 * ancient traces remain reachable by exact-text recall.
 *
 * Returns the base filters unchanged when `vectorScanMaxAgeMs` is
 * `0`, missing, or any other non-positive value — matching the
 * legacy "scan everything" behaviour.
 */
function buildVectorSearchFilters(
  deps: Tier2Deps,
  base: { where?: string; params?: Record<string, unknown> },
): { where?: string; params?: Record<string, unknown> } {
  const maxAgeMs = deps.config.vectorScanMaxAgeMs;
  if (
    typeof maxAgeMs !== "number" ||
    !Number.isFinite(maxAgeMs) ||
    maxAgeMs <= 0
  ) {
    return base;
  }
  const minTs = deps.now() - maxAgeMs;
  const params: Record<string, unknown> = {
    ...(base.params ?? {}),
    vector_scan_min_ts: minTs,
  };
  const where = base.where
    ? `${base.where} AND ts >= @vector_scan_min_ts`
    : "ts >= @vector_scan_min_ts";
  return { where, params };
}

function resolveTagFilter(
  tags: readonly string[],
  config: RetrievalConfig,
): readonly string[] | undefined {
  if (config.tagFilter === "off") return undefined;
  if (tags.length === 0) return undefined;
  return tags;
}

function mergeChannelHits(
  into: Map<TraceId, TraceCandidate>,
  hits: Array<{
    id: string;
    score: number;
    meta?: {
      ts: number;
      priority: number;
      value: number;
      episode_id: EpisodeId;
      session_id: string;
      tags_json?: string;
    };
  }>,
  channel: RetrievalChannel,
  queryVec: EmbeddingVector | null,
): void {
  hits.forEach((h, idx) => {
    const id = h.id as TraceId;
    const meta = h.meta;
    if (!meta) return;
    const existing = into.get(id);
    if (existing) {
      (existing.channels ??= []).push({ channel, rank: idx, score: h.score });
      // Vector channels also update cosine + vecKind so the ranker uses
      // the strongest cosine for MMR redundancy comparisons.
      if (channel === "vec_summary" || channel === "vec_action") {
        if (h.score > existing.cosine) {
          existing.cosine = h.score;
          existing.vecKind = channel === "vec_action" ? "action" : "summary";
        }
      }
      return;
    }
    const isVec = channel === "vec_summary" || channel === "vec_action";
    const vecKind: TraceVecKind = channel === "vec_action" ? "action" : "summary";
    into.set(id, {
      tier: "tier2",
      refKind: "trace",
      refId: id,
      // Vector hits seed cosine with the score; keyword hits start at 0
      // and depend on RRF for ranking.
      cosine: isVec ? h.score : 0,
      ts: meta.ts,
      vec: queryVec,
      value: meta.value,
      priority: meta.priority,
      episodeId: meta.episode_id,
      sessionId: meta.session_id as TraceCandidate["sessionId"],
      vecKind,
      userText: "",
      agentText: "",
      summary: null,
      reflection: null,
      tags: safeParseTags(meta.tags_json),
      channels: [{ channel, rank: idx, score: h.score }],
    });
  });
}

function blendScore(c: TraceCandidate, deps: Tier2Deps): number {
  // Re-derive priority so we respect any time elapsed between write and
  // retrieval (keeps old high-V traces sinking over the half-life).
  const livePriority = priorityFor(c.value, c.ts, deps.config.decayHalfLifeDays, deps.now());
  const channelCount = c.channels?.length ?? 0;
  const channelLift =
    channelCount > 1
      ? // small additive boost for "matched in N channels" — bounded so
        // a 5-channel match doesn't become 5× anything.
        Math.min(0.15, 0.04 * (channelCount - 1))
      : 0;
  return (
    deps.config.weightCosine * c.cosine +
    deps.config.weightPriority * livePriority +
    channelLift
  );
}

/**
 * Bucket traces by episode and emit one `EpisodeCandidate` per bucket.
 *
 * V7 §2.6 Tier 2b ("sub-task episode replay") — when the current turn's
 * goal resembles a past episode (goal-to-goal cosine ≥
 * `episodeGoalMinSim`), surface the past episode's **ordered action
 * sequence** as a reference solution.
 *
 * Ranking rule:
 *   1. Drop buckets with < 2 traces.
 *   2. Drop buckets whose best trace has cosine below
 *      `episodeGoalMinSim` (goal mismatch).
 *   3. Drop buckets whose best trace has V < 0.
 *   4. Sort by `maxValue` then `cosine`.
 */
function rollupEpisodes(
  traces: readonly TraceCandidate[],
  deps: Tier2Deps,
): EpisodeCandidate[] {
  if (traces.length === 0) return [];
  const goalMinSim = deps.config.episodeGoalMinSim ?? 0;

  const buckets = new Map<EpisodeId, { best: TraceCandidate; all: TraceCandidate[] }>();
  for (const t of traces) {
    const b = buckets.get(t.episodeId);
    if (!b) {
      buckets.set(t.episodeId, { best: t, all: [t] });
    } else {
      b.all.push(t);
      if (t.value > b.best.value || (t.value === b.best.value && t.cosine > b.best.cosine)) {
        b.best = t;
      }
    }
  }

  const out: EpisodeCandidate[] = [];
  for (const { best, all } of buckets.values()) {
    if (all.length < 2) continue;
    if (best.cosine < goalMinSim) continue;
    if (best.value < 0 && goalMinSim > 0) continue;

    const ordered = all.slice().sort((a, b) => a.ts - b.ts);
    const summary = renderEpisodeSummary(best, ordered);
    const meanPriority = all.reduce((s, x) => s + x.priority, 0) / all.length;

    out.push({
      tier: "tier2",
      refKind: "episode",
      refId: best.episodeId,
      cosine: best.cosine,
      ts: best.ts,
      vec: best.vec,
      sessionId: best.sessionId,
      summary,
      maxValue: Math.max(...all.map((t) => t.value)),
      meanPriority,
      // Aggregate channel signal from all member traces so the ranker
      // can still RRF-fuse the rolled-up episode against other tiers.
      channels: dedupChannels(all.flatMap((t) => t.channels ?? [])),
      debug: { memberCount: all.length, goalSim: best.cosine },
    });
  }

  out.sort((a, b) => b.maxValue - a.maxValue || b.cosine - a.cosine);
  return out;
}

function dedupChannels(channels: readonly ChannelRank[]): ChannelRank[] {
  const best = new Map<RetrievalChannel, ChannelRank>();
  for (const c of channels) {
    const prev = best.get(c.channel);
    if (!prev || c.rank < prev.rank) best.set(c.channel, c);
  }
  return Array.from(best.values());
}

function renderEpisodeSummary(_best: TraceCandidate, members: readonly TraceCandidate[]): string {
  const header = "Past similar episode";
  const MAX_STEPS = 6;
  const steps = members.slice(0, MAX_STEPS).map((m, idx) => {
    const parts: string[] = [`step ${idx + 1}`];
    const s = m.summary?.trim().replace(/\s+/g, " ") ?? "";
    if (s) {
      parts.push(`summary: ${s.slice(0, 160)}`);
    } else {
      const u = m.userText?.trim().replace(/\s+/g, " ") ?? "";
      if (u) parts.push(`user: ${u.slice(0, 120)}`);
      const a = m.agentText?.trim().replace(/\s+/g, " ") ?? "";
      if (a) parts.push(`agent: ${a.slice(0, 120)}`);
    }
    const r = m.reflection?.trim() ?? "";
    if (r) parts.push(`reflection: ${r.slice(0, 160)}`);
    return parts.join("\n  ");
  });
  const omitted = members.length > MAX_STEPS ? `…(+${members.length - MAX_STEPS} more steps)` : "";
  const full = [header, ...steps, omitted].filter(Boolean).join("\n");
  return full.length <= MAX_EPISODE_SUMMARY_CHARS
    ? full
    : `${full.slice(0, MAX_EPISODE_SUMMARY_CHARS - 16)}\n...[truncated]`;
}

function safeParseTags(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((t): t is string => typeof t === "string");
    }
  } catch {
    // ignore
  }
  return [];
}
