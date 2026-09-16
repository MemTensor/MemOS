/**
 * `gain-inference.ts` — idempotent historical gain inference.
 *
 * A one-time TypeScript pass that runs after migrations and before consumers
 * / timers. For every episode's reward-pass set S (the distinct IDs in
 * `episodes.trace_ids_json` — NEVER all `episode_id` rows) it:
 *
 *   1. requires finite V ∈ [-1,1] and finite r_human ∈ [-1,1] on every member,
 *      with reward consistency within 1e-9;
 *   2. requires nonzero V to share R's sign (R = 0 ⇒ all V = 0);
 *   3. cross-checks `meta.reward.traceIds` exact-set equality when present;
 *   4. conserving groups → gainValue = clamp(V · nonzeroCount, -1, 1) with
 *      `inferred_normalized` provenance;
 *   5. non-conserving groups that still satisfy integrity → gainValue = V with
 *      `legacy_unscaled` provenance;
 *   6. everything else stays unresolved (NULL gain_value / NULL source).
 *
 * Every screening attempt — including unresolved ones — stamps
 * `gain_inference_version`, so a restart never rescans stamped groups. On an
 * inference-version bump, lower-stamp `inferred_normalized` / `legacy_unscaled`
 * rows are revisited. `live_normalized` rows are never overwritten.
 *
 * Orphan rows sharing `episode_id` but not listed in S are outside the reward
 * pass: they stay unresolved and are reported separately.
 */

import type { EpisodeId, TraceId } from "../types.js";
import { contributionGainValues } from "./gain-value.js";
import { rootLogger } from "../logger/index.js";
import type { StorageDb } from "../storage/types.js";
import type { makeEpisodesRepo } from "../storage/repos/episodes.js";
import type { makeTracesRepo } from "../storage/repos/traces.js";
import type { makeGainRepairRepo } from "../storage/repos/gain-repair.js";
import type { makeKvRepo } from "../storage/repos/kv.js";
import type { GainValueSource } from "../types.js";

export const GAIN_INFERENCE_VERSION = 1;

/**
 * Per-boot bound for the startup inference pass (review): the pass
 * runs synchronously inside bridge init (spec ordering — before repair
 * scheduling, so consumers never observe partially converted groups), and an
 * unbounded run over a large backlog risks the `initWatchdogMs` kill →
 * restart crash-loop (PR #40 precedent). Both bounds are deliberately
 * conservative against the 120s watchdog default; resume is durable with NO
 * new state (every attempt stamps `gain_inference_version`, so unstamped
 * rows are revisited next boot and new stamps already clear the queue-seed
 * watermark in the same transaction).
 */
export const GAIN_INFERENCE_BOOT_MAX_GROUPS = 2000;
/** Wall-clock budget per boot for the startup inference pass. */
export const GAIN_INFERENCE_BOOT_TIME_BUDGET_MS = 30_000;

/** Audit boundary for legacy_unscaled reports — not an eligibility gate. */
export const GAIN_POST_CUTOVER_BOUNDARY_MS = Date.parse("2026-06-22T00:00:00Z");

const REWARD_CONSISTENCY_TOLERANCE = 1e-9;
const CONSERVATION_ABS_TOLERANCE = 0.002;
const CONSERVATION_REL_TOLERANCE = 0.01;

const log = rootLogger.child({ channel: "core.reward.gain_inference" });

// ─── Pure per-group screening ────────────────────────────────────────────────

export interface GainGroupMember {
  id: string;
  episodeId: string;
  value: number;
  rHuman: number | null;
  ts: number;
  ownerAgentKind?: string;
  ownerProfileId?: string;
  ownerWorkspaceId?: string | null;
}

export interface GainGroupInput {
  episodeId: string;
  /** S — distinct trace IDs listed in `episodes.trace_ids_json`. */
  traceIds: readonly string[];
  /** Fetched members; must cover every id in `traceIds`. */
  members: readonly GainGroupMember[];
  /**
   * `episode.meta.reward.traceIds` when present. May be any JSON value — a
   * scalar/object/wrong-shaped value MUST resolve the group unresolved (NULL),
   * never a numeric gain and never a passed cross-check.
   */
  metaRewardTraceIds?: unknown;
  episodeOwnerAgentKind?: string;
  episodeOwnerProfileId?: string;
  /**
   * Episode workspace for the ownership check. NULL-exact like the SQL
   * owner filters (`owner_workspace_id IS @workspace_id`): NULL matches
   * only NULL, never a wildcard. Absent (undefined) skips the workspace
   * comparison for callers that do not carry it.
   */
  episodeOwnerWorkspaceId?: string | null;
}

export type GainGroupStatus = GainValueSource | "unresolved";

export interface GainGroupOutcome {
  status: GainGroupStatus;
  reason: string;
  /** gainValue per member id (only for inferred_normalized / legacy_unscaled). */
  gainByTraceId: ReadonlyMap<string, number>;
  /** Number of nonzero contributions in S. */
  nonzeroCount: number;
  sumV: number;
  reward: number;
}

export function screenGainGroup(input: GainGroupInput): GainGroupOutcome {
  const { episodeId, traceIds } = input;
  const members = input.members;
  const S = Array.from(new Set(traceIds));

  const unresolved = (reason: string): GainGroupOutcome => ({
    status: "unresolved",
    reason,
    gainByTraceId: new Map(),
    nonzeroCount: 0,
    sumV: 0,
    reward: 0,
  });

  // A nonempty, valid list is required.
  if (S.length === 0) return unresolved("empty_set");

  // Every listed member must exist — never derive N from a partial set.
  if (members.length !== S.length) return unresolved("missing_listed_member");
  const memberById = new Map(members.map((m) => [m.id, m]));
  for (const id of S) {
    if (!memberById.has(id)) return unresolved("missing_listed_member");
  }

  // Members must belong to the episode (and, when known, the episode owner).
  // Workspace follows the Gate 2 NULL-exact convention shared with the SQL
  // owner filters (`owner_workspace_id IS @workspace_id` in the repair queue
  // and policies repos): normalize both sides with ?? null so NULL matches
  // only NULL. Skipped groups resolve unresolved and keep the existing
  // unresolved audit counting.
  for (const m of members) {
    if (m.episodeId !== episodeId) return unresolved("member_outside_episode");
  }
  const episodeWorkspace = input.episodeOwnerWorkspaceId ?? null;
  if (
    input.episodeOwnerAgentKind ||
    input.episodeOwnerProfileId ||
    input.episodeOwnerWorkspaceId !== undefined
  ) {
    for (const m of members) {
      const mKind = m.ownerAgentKind ?? "unknown";
      const mProfile = m.ownerProfileId ?? "default";
      const mWorkspace = m.ownerWorkspaceId ?? null;
      if (
        (input.episodeOwnerAgentKind && mKind !== input.episodeOwnerAgentKind) ||
        (input.episodeOwnerProfileId && mProfile !== input.episodeOwnerProfileId) ||
        (input.episodeOwnerWorkspaceId !== undefined && mWorkspace !== episodeWorkspace)
      ) {
        return unresolved("mixed_ownership");
      }
    }
  }

  // 1. Finite V and r_human within [-1, 1], reward consistency within 1e-9.
  for (const m of members) {
    if (!Number.isFinite(m.value) || Math.abs(m.value) > 1) return unresolved("invalid_value");
    if (m.rHuman == null || !Number.isFinite(m.rHuman) || Math.abs(m.rHuman) > 1) {
      return unresolved("invalid_r_human");
    }
  }
  let reward = members[0]!.rHuman as number;
  for (const m of members) {
    if (Math.abs((m.rHuman as number) - reward) > REWARD_CONSISTENCY_TOLERANCE) {
      return unresolved("mixed_reward");
    }
  }

  // 2. Sign check: nonzero V must share R's sign; R = 0 requires all V = 0.
  if (reward === 0) {
    if (members.some((m) => m.value !== 0)) return unresolved("sign_mismatch");
  } else {
    for (const m of members) {
      if (m.value !== 0 && Math.sign(m.value) !== Math.sign(reward)) {
        return unresolved("sign_mismatch");
      }
    }
  }

  // 3. meta.reward.traceIds exact-set cross-check when present. Only a real
  // array of string IDs may take part: a scalar/object/array-of-non-strings
  // means the group stays unresolved — it must never produce a numeric gain
  // and must never pass the exact-set comparison.
  if (input.metaRewardTraceIds != null) {
    if (
      !Array.isArray(input.metaRewardTraceIds) ||
      !(input.metaRewardTraceIds as unknown[]).every((id) => typeof id === "string")
    ) {
      return unresolved("trace_ids_mismatch");
    }
    const metaSet = new Set(input.metaRewardTraceIds as string[]);
    if (metaSet.size !== S.length || !S.every((id) => metaSet.has(id))) {
      return unresolved("trace_ids_mismatch");
    }
  }

  const sumV = members.reduce((acc, m) => acc + m.value, 0);
  const nonzeroCount = members.filter((m) => m.value !== 0).length;

  // 4./5. Conservation decides provenance; otherwise legacy_unscaled.
  const tolerance = Math.max(CONSERVATION_ABS_TOLERANCE, Math.abs(reward) * CONSERVATION_REL_TOLERANCE);
  const conserving = Math.abs(sumV - reward) <= tolerance;

  const gainByTraceId = new Map<string, number>();
  if (conserving) {
    const scaled = contributionGainValues(members.map((m) => m.value));
    members.forEach((m, i) => gainByTraceId.set(m.id, scaled[i]!));
    return {
      status: "inferred_normalized",
      reason: "conserving",
      gainByTraceId,
      nonzeroCount,
      sumV,
      reward,
    };
  }
  for (const m of members) gainByTraceId.set(m.id, m.value);
  return {
    status: "legacy_unscaled",
    reason: "non_conserving_with_integrity",
    gainByTraceId,
    nonzeroCount,
    sumV,
    reward,
  };
}

// ─── Storage pass ────────────────────────────────────────────────────────────

export interface GainInferenceDeps {
  db: StorageDb;
  kv: ReturnType<typeof makeKvRepo>;
  episodesRepo: ReturnType<typeof makeEpisodesRepo>;
  tracesRepo: ReturnType<typeof makeTracesRepo>;
  owner: { ownerAgentKind: string; ownerProfileId: string; ownerWorkspaceId?: string | null };
  inferenceVersion?: number;
  pageSize?: number;
  /**
   * Max episode groups screened per call. Unbounded when omitted; the
   * bootstrap passes `GAIN_INFERENCE_BOOT_MAX_GROUPS`. Partial progress is
   * durable (attempt stamps) so the next boot resumes where this one stopped.
   */
  maxGroups?: number;
  /**
   * Wall-clock budget (ms) per call, measured with `now`. Unbounded when
   * omitted; the bootstrap passes `GAIN_INFERENCE_BOOT_TIME_BUDGET_MS`.
   */
  timeBudgetMs?: number;
  /** Clock for the wall-clock budget (injectable for tests). */
  now?: () => number;
}

export interface GainInferenceCounts {
  groups: number;
  traces: number;
}

export interface GainInferenceReport {
  /** Episodes screened this call (capped by maxGroups/timeBudgetMs when set). */
  candidateGroups: number;
  /**
   * True when the call stopped early on maxGroups/timeBudgetMs with
   * unscreened backlog remaining. The next boot resumes durably via the
   * attempt stamps — no new state needed.
   */
  truncated: boolean;
  /** Trace rows stamped this run (any outcome). */
  stampedTraces: number;
  inferredNormalized: GainInferenceCounts;
  legacyUnscaled: GainInferenceCounts;
  unresolved: GainInferenceCounts;
  /** legacy_unscaled groups whose newest member is on/after the cutover. */
  postCutoverLegacy: GainInferenceCounts;
  /** legacy_unscaled groups with unknown member chronology (ts ≤ 0 / non-finite). */
  unknownChronology: GainInferenceCounts;
  /** Groups inferred without meta.reward.traceIds (audit only). */
  auditMetaAbsent: number;
  /** Traces sharing episode_id but not listed in S, left unresolved. */
  orphansOutsideS: number;
  /** Episodes whose trace_ids_json is invalid JSON (skipped, reported). */
  invalidJsonGroups: number;
  /** All trace ids stamped this run (input to queue seeding). */
  affectedTraceIds: string[];
}

export function runGainInference(deps: GainInferenceDeps): GainInferenceReport {
  const version = deps.inferenceVersion ?? GAIN_INFERENCE_VERSION;
  const pageSize = Math.max(1, Math.min(deps.pageSize ?? 500, 5000));
  const owner = deps.owner;

  const report: GainInferenceReport = {
    candidateGroups: 0,
    truncated: false,
    stampedTraces: 0,
    inferredNormalized: { groups: 0, traces: 0 },
    legacyUnscaled: { groups: 0, traces: 0 },
    unresolved: { groups: 0, traces: 0 },
    postCutoverLegacy: { groups: 0, traces: 0 },
    unknownChronology: { groups: 0, traces: 0 },
    auditMetaAbsent: 0,
    orphansOutsideS: 0,
    invalidJsonGroups: 0,
    affectedTraceIds: [],
  };

  const invalidJson = deps.db
    .prepare<unknown, { n: number }>(
      `SELECT COUNT(*) AS n FROM episodes WHERE json_valid(trace_ids_json) = 0`,
    )
    .get()!;
  report.invalidJsonGroups = invalidJson.n;
  if (invalidJson.n > 0) {
    log.warn("gain_inference.invalid_trace_ids_json", { episodes: invalidJson.n });
  }

  const selectRawTraceIds = deps.db.prepare<{ id: string }, { trace_ids_json: string }>(
    `SELECT trace_ids_json FROM episodes WHERE id=@id`,
  );
  // Guarded orphan count: json_each only ever sees a valid array (CASE), and
  // NOT EXISTS (not NOT IN) so a NULL array element can never mask an orphan.
  // IS_ARRAY(X) explicitly classifies JSON shape via a nested CASE: json_type()
  // is evaluated ONLY inside `CASE WHEN json_valid(X) = 1 THEN ...`, so it can
  // never see malformed input (bare json_type throws on malformed JSON — probed
  // 2026-09-14). This matters because json_array_length() returns 0 — not NULL
  // — for valid non-array JSON, so a length-based classifier would wrongly send
  // object/scalar episodes down the array branch.
  const IS_ARRAY = (x: string) =>
    `CASE WHEN json_valid(${x}) = 1 THEN (CASE WHEN json_type(${x}) = 'array' THEN 1 ELSE 0 END) ELSE 0 END`;
  const countOrphans = deps.db.prepare<{ episode_id: string; raw: string }, { n: number }>(
    `SELECT COUNT(*) AS n
       FROM traces t
      WHERE t.episode_id = @episode_id
        AND ${IS_ARRAY("@raw")} = 1
        AND NOT EXISTS (
          SELECT 1
            FROM json_each(CASE WHEN ${IS_ARRAY("@raw")} = 1 THEN @raw ELSE '[]' END) je
           WHERE je.value = t.id
        )`,
  );
  // Candidate selection is guaranteed throw-safe: json_each and json_type are
  // only ever fed values guarded by the nested CASE idiom, so one malformed
  // row cannot abort the startup pass. Invalid JSON (json_valid = 0) AND every
  // valid non-array JSON (object/scalar — IS_ARRAY = 0) are routed through the
  // episode-member branch regardless of their JSON values, so their member
  // traces are stamped unresolved instead of being silently skipped (no
  // restart re-scan loops).
  const selectCandidates = deps.db.prepare<
    {
      version: number;
      kind: string;
      profile: string;
      workspace_id: string | null;
      after_id: string;
      page_size: number;
    },
    { id: string }
  >(
    `SELECT DISTINCT e.id AS id
       FROM episodes e
      WHERE (e.owner_agent_kind = @kind AND e.owner_profile_id = @profile
             OR e.owner_agent_kind = 'unknown')
        -- Gate 2 workspace-exactness, same convention as the repair queue
        -- and policies owner filters: IS is NULL-safe, so a NULL-workspace
        -- tick matches only NULL-workspace episodes (never a wildcard).
        AND e.owner_workspace_id IS @workspace_id
        AND e.id > @after_id
        AND (
          (${IS_ARRAY("e.trace_ids_json")} = 1
           AND EXISTS (
             SELECT 1
               FROM json_each(CASE WHEN ${IS_ARRAY("e.trace_ids_json")} = 1
                                   THEN e.trace_ids_json ELSE '[]' END) je
               JOIN traces t ON t.id = je.value
              WHERE t.gain_inference_version < @version
                AND (t.gain_value_source IS NULL
                     OR t.gain_value_source IN ('inferred_normalized','legacy_unscaled'))
           ))
          OR
          (${IS_ARRAY("e.trace_ids_json")} = 0
           AND EXISTS (
             SELECT 1 FROM traces t2
              WHERE t2.episode_id = e.id
                AND t2.gain_inference_version < @version
                AND (t2.gain_value_source IS NULL
                     OR t2.gain_value_source IN ('inferred_normalized','legacy_unscaled'))
           ))
        )
      ORDER BY e.id
      LIMIT @page_size`,
  );

  let afterId = "";
  // Per-boot bound (see GAIN_INFERENCE_BOOT_*): stop selecting new groups
  // once the group cap or the wall-clock budget is reached. The pass stays
  // fully synchronous in init order (no deferral — spec requires
  // inference to complete before repair scheduling/consumers run); partial
  // progress is durable via attempt stamps so the next boot resumes.
  // NOT gated behind gainV2Enabled: rollout step 1 requires inference
  // verified while the flag is false, and unresolved rows stay NULL (never
  // zero), so partial progress degrades safe.
  const maxGroups =
    deps.maxGroups === undefined ? Number.POSITIVE_INFINITY : Math.max(1, Math.floor(deps.maxGroups));
  const nowFn = deps.now ?? Date.now;
  const deadline =
    deps.timeBudgetMs === undefined ? undefined : nowFn() + Math.max(0, deps.timeBudgetMs);
  let processedGroups = 0;
  let stoppedEarly = false;
  for (;;) {
    const candidates = selectCandidates.all({
      version,
      kind: owner.ownerAgentKind,
      profile: owner.ownerProfileId,
      workspace_id: owner.ownerWorkspaceId ?? null,
      after_id: afterId,
      page_size: pageSize,
    });
    if (candidates.length === 0) break;

    for (const { id } of candidates) {
      if (processedGroups >= maxGroups || (deadline !== undefined && nowFn() >= deadline)) {
        stoppedEarly = true;
        break;
      }
      processedGroups += 1;
      report.candidateGroups += 1;
      const ep = deps.episodesRepo.getById(id as EpisodeId);
      if (!ep) continue;
      const raw = selectRawTraceIds.get({ id })?.trace_ids_json ?? "[]";

      // S must be an array of string IDs. Any scalar/object/wrong-shaped
      // value (or invalid JSON) has no valid S: the group is unresolved and
      // the existing episode-member traces get an attempt stamp so a restart
      // never re-scans them.
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null; // invalid JSON — no throw, handled as wrong-shaped
      }
      const isStringIdArray =
        Array.isArray(parsed) && (parsed as unknown[]).every((x) => typeof x === "string");
      const idList = isStringIdArray ? (parsed as string[]) : null;

      // A valid but EMPTY array is a real (empty) reward pass: nothing to
      // stamp and nothing to screen.
      if (idList !== null && idList.length === 0) continue;

      if (idList === null) {
        // Wrong-shaped S: stamp existing episode members unresolved in short
        // bounded pages. No gain, no source — attempt version only. Any stamp
        // durably invalidates the queue-seed watermark IN THE SAME transaction
        // so same-version newly stamped work is never skipped by reconcile.
        let stamped = 0;
        let afterMemberId = "";
        for (;;) {
          // One malformed huge episode can page through tens of thousands of
          // members; honor the deadline between pages so a single group cannot
          // overrun the whole boot budget. Partial pages are resumable — the
          // members already stamped carry the attempt version.
          if (deadline !== undefined && nowFn() >= deadline) {
            stoppedEarly = true;
            break;
          }
          const members = deps.tracesRepo.listGainRowsForEpisode(id, {
            limit: 2000,
            afterId: afterMemberId,
          });
          if (members.length === 0) break;
          deps.db.tx(() => {
            let pageStamped = 0;
            for (const tr of members) {
              if (tr.gainValueSource === "live_normalized") continue;
              if (tr.gainInferenceVersion >= version) continue;
              const res = deps.tracesRepo.stampGain(tr.id, {
                gainValue: null,
                source: null,
                inferenceVersion: version,
              });
              if (res.changes > 0) {
                pageStamped += 1;
                report.affectedTraceIds.push(tr.id);
              }
            }
            if (pageStamped > 0) deps.kv.del(GAIN_REPAIR_QUEUE_SEED_KEY);
            stamped += pageStamped;
          });
          afterMemberId = members[members.length - 1]!.id;
        }
        report.unresolved.groups += 1;
        report.unresolved.traces += stamped;
        report.stampedTraces += stamped;
        continue;
      }

      // Valid array S: bounded narrow member read (chunked, no text/vector
      // payloads), then per-group screening.
      const S = Array.from(new Set(idList));
      const fetched = deps.tracesRepo.getGainRowsByIds(S);
      const byId = new Map(fetched.map((t) => [String(t.id), t]));

      let orphans = 0;
      try {
        orphans = countOrphans.get({ episode_id: id, raw })?.n ?? 0;
      } catch {
        orphans = 0; // defensive — the query is guarded; never abort the pass
      }
      report.orphansOutsideS += orphans;

      const meta = (ep as unknown as { meta?: Record<string, unknown> }).meta ?? {};
      const metaReward = meta.reward as { traceIds?: unknown } | undefined;
      const outcome = screenGainGroup({
        episodeId: id,
        traceIds: S,
        members: S.map((tid) => {
          const tr = byId.get(String(tid));
          return {
            id: String(tid),
            episodeId: tr ? String(tr.episodeId) : id,
            value: tr?.value ?? Number.NaN,
            rHuman: tr?.rHuman ?? null,
            ts: tr?.ts ?? 0,
            ownerAgentKind: tr?.ownerAgentKind ?? "unknown",
            ownerProfileId: tr?.ownerProfileId ?? "default",
            ownerWorkspaceId: tr?.ownerWorkspaceId ?? null,
          };
        }),
        metaRewardTraceIds: metaReward && metaReward.traceIds != null ? metaReward.traceIds : null,
        episodeOwnerAgentKind: ep.ownerAgentKind,
        episodeOwnerProfileId: ep.ownerProfileId,
        episodeOwnerWorkspaceId: ep.ownerWorkspaceId,
      });

      // Every group that receives a numeric gain counts toward
      // `auditMetaAbsent` when no reward metadata is available — including
      // legacy groups, which carry no meta by construction. Only genuinely
      // unresolved groups (no gain at all) are exempt.
      if (outcome.status !== "unresolved") {
        if (metaReward == null || metaReward.traceIds == null) report.auditMetaAbsent += 1;
      }

      // Stamp the group in a short transaction. Only members that actually
      // need screening are stamped; live_normalized is never overwritten.
      // Any stamp durably invalidates the queue-seed watermark IN THE SAME
      // transaction, so same-version newly stamped work (e.g. groups added
      // after an earlier seed) is re-derived by the next reconcile even after
      // a stamp-then-crash-before-reconcile.
      let stampedInGroup = 0;
      deps.db.tx(() => {
        for (const tid of S) {
          const tr = byId.get(String(tid));
          if (!tr) continue; // ghost member — nothing to stamp
          if (tr.gainValueSource === "live_normalized") continue;
          if (tr.gainInferenceVersion >= version) continue;
          const gain = outcome.gainByTraceId.get(String(tid));
          const res = deps.tracesRepo.stampGain(String(tid) as TraceId, {
            gainValue: outcome.status === "unresolved" ? null : (gain ?? null),
            source: outcome.status === "unresolved" ? null : outcome.status,
            inferenceVersion: version,
          });
          if (res.changes > 0) {
            stampedInGroup += 1;
            report.affectedTraceIds.push(String(tid));
          }
        }
        if (stampedInGroup > 0) deps.kv.del(GAIN_REPAIR_QUEUE_SEED_KEY);
      });
      report.stampedTraces += stampedInGroup;

      const counts =
        outcome.status === "inferred_normalized"
          ? report.inferredNormalized
          : outcome.status === "legacy_unscaled"
            ? report.legacyUnscaled
            : report.unresolved;
      counts.groups += 1;
      counts.traces += stampedInGroup;

      if (outcome.status === "legacy_unscaled") {
        let newestTs = 0;
        let unknown = false;
        for (const tid of S) {
          const tr = byId.get(String(tid));
          const ts = tr?.ts ?? 0;
          if (!Number.isFinite(ts) || ts <= 0) unknown = true;
          if (ts > newestTs) newestTs = ts;
        }
        if (unknown) {
          report.unknownChronology.groups += 1;
          report.unknownChronology.traces += stampedInGroup;
        } else if (newestTs >= GAIN_POST_CUTOVER_BOUNDARY_MS) {
          report.postCutoverLegacy.groups += 1;
          report.postCutoverLegacy.traces += stampedInGroup;
        }
      }
    }
    if (stoppedEarly) break;
    afterId = candidates[candidates.length - 1]!.id;
  }
  report.truncated = stoppedEarly;

  log.info("gain_inference.done", {
    version,
    ...report,
  });
  return report;
}

// ─── Queue seeding / reconciliation (startup, durable) ───────────────────────

/**
 * kv watermark key recording the inference version for which queue seeding
 * already ran for a given owner. When the watermark is behind the current
 * inference version (or absent — e.g. a crash between trace commits and
 * seeding), reconciliation re-derives the seed set from stored state.
 */
export const GAIN_REPAIR_QUEUE_SEED_KEY = "pipeline.gain_repair_queue_seed.v1";

export interface GainRepairQueueReconcileDeps {
  db: StorageDb;
  kv: ReturnType<typeof makeKvRepo>;
  gainRepair: ReturnType<typeof makeGainRepairRepo>;
  tracesRepo: ReturnType<typeof makeTracesRepo>;
  owner: { ownerAgentKind: string; ownerProfileId: string; ownerWorkspaceId?: string | null };
  reason?: import("../storage/repos/gain-repair.js").GainRepairQueueReason;
  inferenceVersion?: number;
  now?: () => number;
}

export interface GainRepairQueueReconcileResult {
  seeded: number;
  reconciled: number;
  alreadySeeded: boolean;
}

/**
 * Seed/reconcile the candidate/active repair queue after historical
 * screening. Never writes policy fields. Archived or missing policies are
 * reconciled away; affected candidate/active policies get a pending entry so
 * later phases (timer repair) can recompute their gain.
 *
 * Durable by construction: the seed set is derived from STORED state — every
 * trace stamped at the current inference version → affected policies via the
 * current evidence source (`policies.source_trace_ids_json`) — never from
 * in-memory ids collected this startup. A crash between trace commits and
 * queue seeding leaves the watermark behind, so the next restart recomputes
 * the seed set from the database and no work is permanently omitted. The
 * whole reconcile (reconciliation + seeding + watermark) commits in one
 * transaction; a seeding failure rolls back and is retried on the next boot.
 */
export function reconcileGainRepairQueue(
  deps: GainRepairQueueReconcileDeps,
): GainRepairQueueReconcileResult {
  const version = deps.inferenceVersion ?? GAIN_INFERENCE_VERSION;
  const now = deps.now ?? Date.now;

  return deps.db.tx(() => {
    const reconciled = deps.gainRepair.reconcileArchivedOrMissing(deps.owner);
    const stored = deps.kv.get<
      | { version: number; ownerAgentKind: string; ownerProfileId: string; ownerWorkspaceId?: string | null }
      | null
    >(GAIN_REPAIR_QUEUE_SEED_KEY, null);
    // Exact-namespace watermark: the workspace is part of the owner identity,
    // so two owners that share kind+profile but differ by workspace must not
    // share the seed watermark (one would skip seeding for the other).
    const alreadySeeded =
      stored != null &&
      stored.version >= version &&
      stored.ownerAgentKind === deps.owner.ownerAgentKind &&
      stored.ownerProfileId === deps.owner.ownerProfileId &&
      (stored.ownerWorkspaceId ?? null) === (deps.owner.ownerWorkspaceId ?? null);
    if (alreadySeeded) return { seeded: 0, reconciled, alreadySeeded: true };

    // Derive the seed set from stored state: all member traces stamped at the
    // current inference version → affected policies via source_trace_ids_json.
    const stampedTraceIds = deps.tracesRepo.listTraceIdsStampedAt(version);
    const policyIds = deps.gainRepair.findAffectedPolicyIds(new Set(stampedTraceIds), deps.owner);
    for (const policyId of policyIds) {
      deps.gainRepair.upsertPending({
        policyId,
        ownerAgentKind: deps.owner.ownerAgentKind,
        ownerProfileId: deps.owner.ownerProfileId,
        ownerWorkspaceId: deps.owner.ownerWorkspaceId ?? null,
        reason: deps.reason ?? "inferred_evidence_updated",
        inferenceVersion: version,
        now: now(),
      });
    }
    deps.kv.set(GAIN_REPAIR_QUEUE_SEED_KEY, {
      version,
      ownerAgentKind: deps.owner.ownerAgentKind,
      ownerProfileId: deps.owner.ownerProfileId,
      ownerWorkspaceId: deps.owner.ownerWorkspaceId ?? null,
      seededAt: now(),
    });
    return { seeded: policyIds.length, reconciled, alreadySeeded: false };
  });
}
