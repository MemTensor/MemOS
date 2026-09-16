/**
 * `recompute-gain.ts` — shared evidence selection + gain recomputation.
 *
 * One selection/computation core shared by ordinary L2 (`runL2`), the read-only
 * `policies.gainPreview` RPC and the timer repair engine.
 * The transaction layer owns policy writes, support accounting, queue progress
 * and journal insertion; this module owns none of them.
 *
 * Selection contract:
 *
 *   1. Union persisted with-links (`tracePolicyLinks`), current-run with
 *      evidence (current associations + induction evidence) and current-run
 *      traces.
 *   2. Include directly-linked traces even if older than their episode's
 *      newest 50; include current-run traces and the newest 50 persisted
 *      traces per linked episode — read from `episodes.trace_ids_json` (the
 *      exact reward-pass set), never a scan of all rows sharing `episode_id`.
 *   3. Deduplicate by ID, sort timestamp DESC then ID DESC.
 *   4. Exclude NULL-score traces BEFORE the final 50-with / 50-without limits
 *      and count them as `excluded.unresolved{With,Without}`. Dangling IDs,
 *      invalid scores and out-of-namespace rows are reported separately. The
 *      pool is never refilled by scanning older unrelated traces.
 *   5. Resolved zeros are kept, including without-traces; zero is valid
 *      evidence.
 *   6. Compute whenever ≥ 1 resolved with-trace remains; an empty resolved
 *      without-set uses the existing prior. Skip (preserving previous policy
 *      state) for no resolved with-evidence — exclusion, not skip-of-policy,
 *      is the rule whenever a resolved with-trace remains.
 *
 * v2 certification: `isFirst = support == 0 OR gain_version != 2` → the raw
 * first-v2 gain is used and the EMA is reset. An inference-rule-refresh
 * recompute (`mode === "inference_refresh"` / `resetEma`) also resets the EMA
 * so a superseded inferred score never blends into its replacement. Later
 * ordinary v2 updates keep the EMA (baseline, 5 pseudocounts, softmax-with-set
 * mean for ≥ 3 samples, arithmetic mean otherwise, existing coefficient).
 * Historical repair never increments support nor repeatedly EMAs unchanged
 * evidence — support accounting stays in the transaction layer.
 *
 * Owner isolation: evidence traces are matched against the POLICY's owner
 * fields (falling back to the caller's exact namespace). NULL / `unknown`
 * owner traces are the shared space in this codebase (`visibilityWhere` treats
 * `owner_agent_kind IS NULL` / `'unknown'` as visible to everyone) — matching
 * them is not borrowing another owner's evidence. A trace that carries a REAL
 * owner different from the policy owner is counted as out-of-namespace and
 * excluded. Unknown-owner policies are reported (`unknownOwner`) and excluded
 * from automatic mutation by repair callers.
 *
 * This module performs NO writes: it never deletes links, never changes
 * support, never replaces NULL with zero, and never certifies excluded traces.
 */

import type { makeEpisodesRepo } from "../../storage/repos/episodes.js";
import type { makeGainRepairRepo } from "../../storage/repos/gain-repair.js";
import type { makeKvRepo } from "../../storage/repos/kv.js";
import type { makePoliciesRepo } from "../../storage/repos/policies.js";
import type { makeTracePolicyLinksRepo } from "../../storage/repos/trace-policy-links.js";
import type { makeTracesRepo } from "../../storage/repos/traces.js";
import { isExactOwner } from "../../storage/repos/_helpers.js";
import type { StorageDb } from "../../storage/types.js";
import type {
  EpisodeId,
  EpochMs,
  GainValueSource,
  PolicyId,
  PolicyRow,
  RuntimeNamespace,
  TraceId,
  TraceRow,
} from "../../types.js";
import { GAIN_INFERENCE_VERSION, GAIN_REPAIR_QUEUE_SEED_KEY } from "../../reward/gain-inference.js";
import { rootLogger } from "../../logger/index.js";
import { computeGain, smoothGain } from "./gain.js";
import type { GainResult, L2Config } from "./types.js";

/** Final with/without caps after resolution. */
export const MAX_EVIDENCE = 50;
/** Newest persisted traces per linked episode. */
export const NEWEST_PER_EPISODE = 50;

const log = rootLogger.child({ channel: "core.memory.l2.gain" });

export type RecomputeGainMode = "ordinary" | "inference_refresh" | "preview" | "repair";

export type RecomputeGainSkipReason =
  | null
  | "no_resolved_with"
  | /** Policy owner is `unknown` — auto-mutation must not touch it. */
  "unknown_owner";

/**
 * Narrow evidence view the selection math operates on. Matches the narrow
 * `TraceGainRow` projection from `traces.ts` (no text / vector payloads).
 */
export interface GainEvidenceTrace {
  id: TraceId;
  episodeId: EpisodeId;
  ts: EpochMs;
  value: number;
  gainValue: number | null;
  gainValueSource: GainValueSource | null;
  ownerAgentKind?: string;
  ownerProfileId?: string;
  ownerWorkspaceId?: string | null;
}

export interface RecomputeGainResult {
  /** `null` = computation ran; otherwise why auto-mutation must skip. */
  skipReason: RecomputeGainSkipReason;
  /** 2 = shared gainValue calculation certified; 1 = legacy/uncertified. */
  gainVersion: 1 | 2;
  /** First v2 calculation (support 0 / uncertified / inference refresh). */
  isFirst: boolean;
  /** RAW (un-smoothed) `computeGain` result — preview cannot rebuild it from a scalar. */
  raw: GainResult;
  /** EMA-smoothed gain to persist (equals `raw.gain` when `isFirst`). */
  persistedGain: number;
  /** Resolved with-traces selected after the final 50 cap. */
  selectedWithIds: string[];
  /** Resolved without-traces selected after the final 50 cap. */
  selectedWithoutIds: string[];
  /** Every with-evidence ID in the union (links + caller with-evidence). */
  withIds: string[];
  /** Every pool ID considered (with + current-run + per-episode newest 50). */
  poolIds: string[];
  /** Provenance of the selected with-traces (v2 mode; zeros in legacy mode). */
  provenance: { liveNormalized: number; inferredNormalized: number; legacyUnscaled: number };
  /** Excluded evidence. */
  excluded: {
    /** with-traces whose score is NULL/unresolved (v2 mode). */
    unresolvedWith: number;
    /** without-traces whose score is NULL/unresolved (v2 mode). */
    unresolvedWithout: number;
    /** resolved with-traces cut by the final 50 cap. */
    withBeyondLimit: number;
    /** resolved without-traces cut by the final 50 cap. */
    withoutBeyondLimit: number;
  };
  /** Rows reported separately. */
  reported: { danglingIds: number; invalidScores: number; outOfNamespace: number };
  /** Policy owner is `unknown` — repair callers must not auto-mutate it. */
  unknownOwner: boolean;
}

export interface RecomputeGainRepos {
  episodes: Pick<ReturnType<typeof makeEpisodesRepo>, "getById">;
  traces: Pick<ReturnType<typeof makeTracesRepo>, "getGainRowsByIds" | "count">;
  tracePolicyLinks: Pick<
    ReturnType<typeof makeTracePolicyLinksRepo>,
    "getWithTraceIds" | "getLinkedEpisodeIds"
  >;
}

export interface RecomputeGainInput {
  policy: PolicyRow;
  /** Exact namespace of the caller (falls back to the policy owner fields). */
  namespace: RuntimeNamespace;
  /** Live L2 config slice (extractAlgorithmConfig output). */
  config: L2Config;
  /**
   * Caller context. `"ordinary"` = runL2; `"inference_refresh"` resets the
   * EMA; `"preview"` forces v2 scoring regardless of the enable flag (the
   * preview is a sanity check, not a frozen approval artifact); `"repair"`
   * = timer repair, follows the live flag.
   */
  mode?: RecomputeGainMode;
  /** Current-run traces (the episode's exact scored set). */
  currentTraces?: readonly TraceRow[];
  /** Current-run with-evidence: associations + induction evidence IDs. */
  withTraceIds?: readonly TraceId[];
  /** Explicit EMA reset (inference-rule/input changes must not blend). */
  resetEma?: boolean;
}

// ─── Admission floor (shared with association/induction) ─────────────────────

/**
 * L2 admission floor. Enabled mode requires a RESOLVED gainValue at/above
 * `minGainValue`; disabled (legacy) mode keeps the `minTraceValue` semantics on
 * V. Both modes require an embedding (cosine association cannot run without
 * one). Old candidate-pool entries are revalidated through this same check at
 * induction time — no historical bulk replay.
 */
export function isInductionEligible(
  trace: Pick<TraceRow, "value" | "gainValue" | "vecSummary" | "vecAction">,
  config: Pick<L2Config, "gainV2Enabled" | "minGainValue" | "minTraceValue">,
): boolean {
  if (!(trace.vecSummary ?? trace.vecAction)) return false;
  if (config.gainV2Enabled) {
    // Admission requires the SHARED resolved-value predicate FIRST: only a
    // finite, in-[-1,1] gainValue can ever be evidence, so an out-of-range
    // score can neither associate nor enter induction evidence / support.
    // minGainValue is then applied to the resolved score.
    return isResolvedGainValue(trace.gainValue) && trace.gainValue! >= config.minGainValue;
  }
  return trace.value >= config.minTraceValue;
}

// ─── Pure selection + computation ────────────────────────────────────────────

interface SelectedTrace {
  id: string;
  row: GainEvidenceTrace;
  score: number;
  source: GainValueSource | null;
}

/** Normalized owner triple (NULL → `unknown`/`default` fallbacks applied). */
export interface NormalizedOwner {
  kind: string;
  profile: string;
  workspace: string | null;
}

/** Normalize an owner-shaped row (missing fields → `unknown`/`default`). */
export function normalizeOwner(
  o: {
    ownerAgentKind?: string | null;
    ownerProfileId?: string | null;
    ownerWorkspaceId?: string | null;
  },
): NormalizedOwner {
  return {
    kind: o.ownerAgentKind ?? "unknown",
    profile: o.ownerProfileId ?? "default",
    workspace: o.ownerWorkspaceId ?? null,
  };
}

export interface SelectAndComputeInput {
  policy: Pick<
    PolicyRow,
    | "id"
    | "support"
    | "gain"
    | "gainVersion"
    | "ownerAgentKind"
    | "ownerProfileId"
    | "ownerWorkspaceId"
  >;
  withIds: readonly string[];
  poolIds: readonly string[];
  tracesById: ReadonlyMap<string, GainEvidenceTrace>;
  scoreMode: "gain" | "value";
  config: Pick<L2Config, "gainEmaAlpha" | "tauSoftmax">;
  resetEma?: boolean;
  /**
   * When true, an unknown-owner policy is rejected from AUTO-MUTATION with the
   * distinct `"unknown_owner"` skip reason (ordinary/repair/inference-refresh
   * callers). Preview stays read-only and reportable and passes false.
   */
  rejectUnknownOwner?: boolean;
}

/**
 * Pure selection + gain computation. No I/O, no writes. Callers own support
 * accounting, persistence and queue/journal writes.
 */
export function selectAndComputeGain(input: SelectAndComputeInput): RecomputeGainResult {
  const { policy } = input;
  const policyOwner = normalizeOwner(policy);
  const unknownOwner = policyOwner.kind === "unknown";
  const withIdSet = new Set(input.withIds);
  const allIds = Array.from(new Set(input.poolIds));

  const withBuckets: SelectedTrace[] = [];
  const withoutBuckets: SelectedTrace[] = [];
  let danglingIds = 0;
  let invalidScores = 0;
  let outOfNamespace = 0;
  let unresolvedWith = 0;
  let unresolvedWithout = 0;

  for (const id of allIds) {
    const row = input.tracesById.get(id);
    if (!row) {
      danglingIds++;
      continue;
    }
    if (isBorrowedEvidence(policyOwner, row)) {
      outOfNamespace++;
      continue;
    }
    const isWith = withIdSet.has(id);
    const resolved = resolveScore(row, input.scoreMode);
    if (resolved.kind === "unresolved") {
      if (isWith) unresolvedWith++;
      else unresolvedWithout++;
      continue;
    }
    if (resolved.kind === "invalid") {
      invalidScores++;
      continue;
    }
    (isWith ? withBuckets : withoutBuckets).push({
      id,
      row,
      score: resolved.score,
      source: resolved.source,
    });
  }

  withBuckets.sort(byTsDescThenIdDesc);
  withoutBuckets.sort(byTsDescThenIdDesc);
  const selectedWith = withBuckets.slice(0, MAX_EVIDENCE);
  const selectedWithout = withoutBuckets.slice(0, MAX_EVIDENCE);
  const withBeyondLimit = withBuckets.length - selectedWith.length;
  const withoutBeyondLimit = withoutBuckets.length - selectedWithout.length;

  const provenance = { liveNormalized: 0, inferredNormalized: 0, legacyUnscaled: 0 };
  for (const s of selectedWith) {
    if (s.source === "live_normalized") provenance.liveNormalized++;
    else if (s.source === "inferred_normalized") provenance.inferredNormalized++;
    else if (s.source === "legacy_unscaled") provenance.legacyUnscaled++;
  }

  const base = {
    selectedWithIds: selectedWith.map((s) => s.id),
    selectedWithoutIds: selectedWithout.map((s) => s.id),
    withIds: Array.from(withIdSet),
    poolIds: allIds,
    provenance,
    excluded: { unresolvedWith, unresolvedWithout, withBeyondLimit, withoutBeyondLimit },
    reported: { danglingIds, invalidScores, outOfNamespace },
    unknownOwner,
  };

  const skipVersion: 1 | 2 = input.scoreMode === "gain" ? 2 : 1;
  const skipResult = (skipReason: "no_resolved_with" | "unknown_owner") => ({
    skipReason,
    gainVersion: skipVersion,
    isFirst: false,
    raw: emptyGain(policy.id),
    persistedGain: policy.gain,
    ...base,
  });

  // Unknown-owner policies are excluded from automatic mutation:
  // the caller still receives the full selection report (preview relies on it)
  // but auto-mutation paths must not write gain/support/status for them.
  if (unknownOwner && input.rejectUnknownOwner === true) {
    return skipResult("unknown_owner");
  }

  if (selectedWith.length === 0) {
    return skipResult("no_resolved_with");
  }

  const raw = computeGain(
    {
      policyId: policy.id,
      withTraces: toTraceViews(selectedWith),
      withoutTraces: toTraceViews(selectedWithout),
    },
    { tauSoftmax: input.config.tauSoftmax },
  );
  const isV2 = input.scoreMode === "gain";
  const gainVersion: 1 | 2 = isV2 ? 2 : 1;
  const isFirst = isV2
    ? policy.support === 0 || (policy.gainVersion ?? 1) !== 2 || input.resetEma === true
    : policy.support === 0;
  const persistedGain = smoothGain({
    newGain: raw.gain,
    currentGain: policy.gain,
    alpha: input.config.gainEmaAlpha,
    isFirst,
  });
  return {
    skipReason: null,
    gainVersion,
    isFirst,
    raw,
    persistedGain,
    ...base,
  };
}

// ─── I/O wrapper ─────────────────────────────────────────────────────────────

/**
 * Gather persisted evidence (with-links ∪ `policy.sourceTraceIds` induction
 * evidence + per-episode newest 50 from `episodes.trace_ids_json`), merge
 * current-run traces, then delegate to the pure core. Read-only.
 */
export function recomputePolicyGain(
  input: RecomputeGainInput,
  deps: RecomputeGainRepos,
): RecomputeGainResult {
  const { policy } = input;
  // Persisted with-evidence = direct trace-policy links ∪ the policy's stored
  // induction evidence (`sourceTraceIds`). Imported / feedback-derived policies
  // frequently carry sourceTraceIds WITHOUT any trace-policy links; ordinary
  // L2, preview and repair must all see the same evidence union.
  const sourceTraceIds = (policy.sourceTraceIds ?? []).map(String);
  const linkedWith = dedup([
    ...deps.tracePolicyLinks.getWithTraceIds(policy.id).map(String),
    ...sourceTraceIds,
  ]);
  const extraWith = (input.withTraceIds ?? []).map(String);
  const withIds = dedup([...linkedWith, ...extraWith]);

  const currentIds: string[] = [];
  const tracesById = new Map<string, GainEvidenceTrace>();
  for (const t of input.currentTraces ?? []) {
    const key = String(t.id);
    currentIds.push(key);
    tracesById.set(key, toEvidenceFromTraceRow(t));
  }

  // Linked episodes come from BOTH direct links and the source traces (their
  // episodes may have no direct link row at all).
  const linkedEpisodeIds = new Set<string>(
    deps.tracePolicyLinks.getLinkedEpisodeIds(policy.id).map(String),
  );
  if (sourceTraceIds.length > 0) {
    for (const r of deps.traces.getGainRowsByIds(sourceTraceIds)) {
      linkedEpisodeIds.add(String(r.episodeId));
    }
  }

  const perEpisodeIds: string[] = [];
  for (const epId of linkedEpisodeIds) {
    const ep = deps.episodes.getById(epId as EpisodeId);
    if (!ep) continue;
    const ids = (ep.traceIds ?? []).map(String);
    if (ids.length === 0) continue;
    const rows = deps.traces.getGainRowsByIds(ids);
    // Orphan diagnosability (the pass leaves traces-table rows never folded
    // into trace_ids_json unresolved for inference; the L2 pool likewise
    // draws only from S): one indexed COUNT per linked episode vs the S
    // members actually present, debug-logged when nonzero so baseline
    // shifts are diagnosable. No behavior/score change — the pool below is
    // built from S exactly as before.
    try {
      const total = deps.traces.count({ episodeId: epId as EpisodeId });
      const orphansExcluded = Math.max(0, total - rows.length);
      if (orphansExcluded > 0) {
        log.debug("recompute_gain.orphans_excluded", {
          policyId: String(policy.id),
          episodeId: epId,
          orphansExcluded,
          poolMembers: rows.length,
        });
      }
    } catch {
      // Diagnosability must never break selection — skip the signal.
    }
    // Contract: timestamp DESC then ID DESC (matches the final selection sort).
    rows.sort((a, b) => b.ts - a.ts || String(b.id).localeCompare(String(a.id)));
    for (const r of rows.slice(0, NEWEST_PER_EPISODE)) perEpisodeIds.push(String(r.id));
  }

  const poolIds = dedup([...withIds, ...currentIds, ...perEpisodeIds]);

  const missing = poolIds.filter((id) => !tracesById.has(id));
  for (const r of deps.traces.getGainRowsByIds(missing)) {
    const key = String(r.id);
    if (!tracesById.has(key)) tracesById.set(key, toEvidenceFromGainRow(r));
  }

  const scoreMode: "gain" | "value" =
    input.mode === "preview" || input.config.gainV2Enabled ? "gain" : "value";

  return selectAndComputeGain({
    policy,
    withIds,
    poolIds,
    tracesById,
    scoreMode,
    config: { gainEmaAlpha: input.config.gainEmaAlpha, tauSoftmax: input.config.tauSoftmax },
    resetEma: input.resetEma === true || input.mode === "inference_refresh",
    // Unknown-owner policies are excluded from automatic mutation in EVERY
    // mode (v2 or legacy): only a successful owner-validated calculation may
    // write gain/support/status. Preview is read-only and reportable so it
    // always computes.
    rejectUnknownOwner: input.mode !== "preview",
  });
}

// ─── Queue reconciliation from the evidence union (startup) ─────────────────

export interface GainRepairUnionReconcileDeps extends RecomputeGainRepos {
  db: StorageDb;
  kv: ReturnType<typeof makeKvRepo>;
  gainRepair: ReturnType<typeof makeGainRepairRepo>;
  policies: Pick<ReturnType<typeof makePoliciesRepo>, "list">;
  owner: { ownerAgentKind: string; ownerProfileId: string; ownerWorkspaceId?: string | null };
  inferenceVersion?: number;
  now?: () => number;
}

export interface GainRepairUnionReconcileResult {
  /** Policies upserted as pending (≥ 1 resolved with-link survives). */
  seeded: number;
  /** Policies seeded directly as blocked (zero resolved with-links). */
  blocked: number;
  /** Archived / missing queue rows reconciled away. */
  reconciled: number;
}

/**
 * Rebuild the repair queue from the COMPLETE evidence union (with-links ∪
 * `source_trace_ids_json` induction evidence). The repair queue is never
 * treated as authoritative: every candidate/active policy of the owner is
 * re-derived, archived/missing entries are reconciled away, and policies with
 * zero resolved with-links are seeded as `blocked` directly — no attempt, no
 * budget spent.
 *
 * Pure queue/state writes: never touches policy fields, support or status.
 */
export function reconcileGainRepairQueueFromEvidenceUnion(
  deps: GainRepairUnionReconcileDeps,
): GainRepairUnionReconcileResult {
  const version = deps.inferenceVersion ?? GAIN_INFERENCE_VERSION;
  const now = deps.now ?? Date.now;
  const owner = deps.owner;

  return deps.db.tx(() => {
    const reconciled = deps.gainRepair.reconcileArchivedOrMissing(owner);
    // Explicit large cap: `policies.list` defaults to 500 rows and the
    // reconcile must rebuild the queue from the COMPLETE evidence union. The
    // owner triple is pushed into SQL (kind/profile `=`, workspace NULL-
    // exact `IS` — Gate 2) so other owners' rows never leave the database;
    // the shared `isExactOwner` predicate stays as the exact in-JS gate
    // (policies columns are NOT NULL DEFAULT 'unknown'/'default', so the
    // SQL pre-filter cannot narrow beyond what the predicate accepts —
    // no semantics change, just fewer rows hydrated).
    const ownerFilter = {
      ownerAgentKind: owner.ownerAgentKind,
      ownerProfileId: owner.ownerProfileId,
      ownerWorkspaceId: owner.ownerWorkspaceId ?? null,
    };
    const targets = [
      ...deps.policies.list({ status: "candidate", limit: 100_000, ...ownerFilter }),
      ...deps.policies.list({ status: "active", limit: 100_000, ...ownerFilter }),
    ].filter((p) => isExactOwner(p, owner));

    let seeded = 0;
    let blocked = 0;
    for (const policy of targets) {
      const withIds = dedup([
        ...deps.tracePolicyLinks.getWithTraceIds(policy.id).map(String),
        ...(policy.sourceTraceIds ?? []).map(String),
      ]);
      let resolved = 0;
      if (withIds.length > 0) {
        const policyOwner = normalizeOwner(policy);
        for (const r of deps.traces.getGainRowsByIds(withIds)) {
          // Same validity predicate as the selector: NULL is unresolved and
          // non-finite/out-of-range scores are NOT resolved evidence.
          if (!isResolvedGainValue(r.gainValue)) continue;
          if (isBorrowedEvidence(policyOwner, r)) continue;
          resolved++;
        }
      }
      // Preserve explicit inference invalidation: an existing
      // `inference_refresh` entry must NOT be downgraded to
      // `inferred_evidence_updated` by the rebuild — it survives until a
      // successful refreshed calculation resolves it (the timer removes the
      // queue entry on completion, so any surviving entry is unresolved).
      const existing = deps.gainRepair.getByPolicy(policy.id);
      const reason =
        existing?.reason === "inference_refresh"
          ? "inference_refresh"
          : "inferred_evidence_updated";
      const common = {
        policyId: policy.id,
        ownerAgentKind: owner.ownerAgentKind,
        ownerProfileId: owner.ownerProfileId,
        ownerWorkspaceId: owner.ownerWorkspaceId ?? null,
        inferenceVersion: version,
        now: now(),
      };
      if (resolved > 0) {
        deps.gainRepair.upsertPending({ ...common, reason });
        seeded++;
      } else {
        deps.gainRepair.upsertBlocked({
          ...common,
          reason,
          blockedReason: "no_resolved_with",
        });
        blocked++;
      }
    }

    // Keep the durable seed watermark coherent (the union rebuild above
    // is authoritative regardless; the marker only prevents older seed paths
    // from double-running after a crash).
    deps.kv.set(GAIN_REPAIR_QUEUE_SEED_KEY, {
      version,
      ownerAgentKind: owner.ownerAgentKind,
      ownerProfileId: owner.ownerProfileId,
      seededAt: now(),
    });
    return { seeded, blocked, reconciled };
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

type ResolvedScore =
  | { kind: "resolved"; score: number; source: GainValueSource | null }
  | { kind: "unresolved" }
  | { kind: "invalid" };

/**
 * Shared resolved-gainValue validity predicate: NULL is unresolved and
 * non-finite / out-of-[-1,1] values are NOT resolved evidence. Used by both
 * the selector (`resolveScore`) and the queue rebuild so a policy can never
 * be seeded `pending` on an invalid score.
 */
export function isResolvedGainValue(gainValue: number | null | undefined): boolean {
  return gainValue != null && Number.isFinite(gainValue) && Math.abs(gainValue) <= 1;
}

function resolveScore(row: GainEvidenceTrace, mode: "gain" | "value"): ResolvedScore {
  if (mode === "gain") {
    if (row.gainValue == null) return { kind: "unresolved" };
    if (!isResolvedGainValue(row.gainValue)) return { kind: "invalid" };
    return { kind: "resolved", score: row.gainValue, source: row.gainValueSource ?? null };
  }
  if (!Number.isFinite(row.value)) return { kind: "invalid" };
  return { kind: "resolved", score: row.value, source: null };
}

/**
 * A trace is borrowed evidence only when it carries a REAL owner that differs
 * from the policy owner. NULL / `unknown`-owner traces are the shared space
 * (see file header) — matching them is not borrowing another owner's evidence.
 * Exported for the re-screen requeue, which must apply the SAME
 * resolved-evidence predicate as this module's union reconcile.
 */
export function isBorrowedEvidence(
  policyOwner: NormalizedOwner,
  trace: Pick<GainEvidenceTrace, "ownerAgentKind" | "ownerProfileId" | "ownerWorkspaceId">,
): boolean {
  const t = normalizeOwner(trace);
  if (t.kind === "unknown") return false;
  return !(t.kind === policyOwner.kind && t.profile === policyOwner.profile && t.workspace === policyOwner.workspace);
}

function toTraceViews(entries: readonly SelectedTrace[]): TraceRow[] {
  const out: TraceRow[] = [];
  for (const e of entries) {
    out.push({
      id: e.row.id,
      episodeId: e.row.episodeId,
      sessionId: "",
      ts: e.row.ts,
      userText: "",
      agentText: "",
      toolCalls: [],
      reflection: null,
      value: e.score,
      alpha: 0,
      rHuman: null,
      priority: 0,
      tags: [],
      vecSummary: null,
      vecAction: null,
      turnId: 0,
      schemaVersion: 0,
    });
  }
  return out;
}

function emptyGain(policyId: PolicyId): GainResult {
  return {
    policyId,
    gain: 0,
    withMean: 0,
    withoutMean: 0,
    withCount: 0,
    withoutCount: 0,
    weightedWith: 0,
    poolMean: 0,
    baseline: 0,
  };
}

function byTsDescThenIdDesc(a: SelectedTrace, b: SelectedTrace): number {
  return b.row.ts - a.row.ts || b.id.localeCompare(a.id);
}

function toEvidenceFromTraceRow(t: TraceRow): GainEvidenceTrace {
  return {
    id: t.id,
    episodeId: t.episodeId,
    ts: t.ts,
    value: t.value,
    gainValue: t.gainValue ?? null,
    gainValueSource: t.gainValueSource ?? null,
    ownerAgentKind: t.ownerAgentKind,
    ownerProfileId: t.ownerProfileId,
    ownerWorkspaceId: t.ownerWorkspaceId,
  };
}

function toEvidenceFromGainRow(r: ReturnType<ReturnType<typeof makeTracesRepo>["getGainRowsByIds"]>[number]): GainEvidenceTrace {
  return {
    id: r.id as TraceId,
    episodeId: r.episodeId as EpisodeId,
    ts: r.ts,
    value: r.value,
    gainValue: r.gainValue,
    gainValueSource: r.gainValueSource,
    ownerAgentKind: r.ownerAgentKind,
    ownerProfileId: r.ownerProfileId,
    ownerWorkspaceId: r.ownerWorkspaceId,
  };
}

function dedup(ids: readonly string[]): string[] {
  return Array.from(new Set(ids));
}
