/**
 * `runL3` — cross-task world-model abstraction.
 *
 * The orchestrator follows the V7 §2.4.1 recipe:
 *
 *   1. **Gather eligible L2 policies** (status = active, gain ≥ minGain,
 *      support ≥ minSupport) and split them into compatible clusters
 *      via `clusterPolicies` (domain key + centroid proximity).
 *   2. **Cooldown check**: skip clusters whose primary tag was abstracted
 *      recently — controlled by `algorithm.l3Abstraction.cooldownDays`.
 *   3. **Abstract** each surviving cluster with the `l3.abstraction`
 *      prompt (see `abstract.ts`).
 *   4. **Merge or create**: compare the draft against existing WMs that
 *      share a domain tag (see `merge.ts`). Above the similarity cutoff
 *      we update the existing row; otherwise we insert a new WM.
 *   5. **Persist evidence** — every WM row carries its source policies
 *      and source episodes so Tier-3 retrieval can trace WMs back to the
 *      L1/L2 rows that minted them.
 *
 * Pure pipeline: takes `deps` (repos, llm, log, bus) and returns a
 * `L3ProcessResult`. No globals.
 */

import type { Logger } from "../../logger/types.js";
import type { LlmClient } from "../../llm/index.js";
import { L3_ABSTRACTION_PROMPT } from "../../llm/prompts/l3-abstraction.js";
import type { Repos } from "../../storage/repos/index.js";
import { ids } from "../../id.js";
import type {
  EpisodeId,
  EpochMs,
  PolicyId,
  PolicyRow,
  TraceRow,
  WorldModelId,
} from "../../types.js";
import { abstractDraft, buildWorldModelRow } from "./abstract.js";
import { clusterPolicies } from "./cluster.js";
import {
  chooseMergeTarget,
  gatherMergeCandidates,
  mergeForUpdate,
} from "./merge.js";
import type {
  AbstractionResult,
  L3AbstractionDraft,
  L3AbstractionDraftEntry,
  L3AbstractionDraftResult,
  L3Config,
  L3Event,
  L3EventBus,
  L3ProcessInput,
  L3ProcessResult,
  PolicyCluster,
  PolicyClusterKey,
} from "./types.js";

// ─── Deps ──────────────────────────────────────────────────────────────────

export interface RunL3Deps {
  repos: Pick<Repos, "embeddingRetryQueue" | "policies" | "traces" | "worldModel" | "kv">;
  llm: LlmClient | null;
  log: Logger;
  bus?: L3EventBus;
  config: L3Config;
}

const KV_COOLDOWN_PREFIX = "l3.lastRun.";
const KV_RETRY_PREFIX = "l3.retry.";
const FAILURE_BACKOFF_MS = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000];
const RETRY_STATE_VERSION = 2;
const MAX_FAILURE_ATTEMPTS = FAILURE_BACKOFF_MS.length;

interface L3RetryState {
  version: number;
  nextRetryAt: number;
  failures: number;
  quarantined: boolean;
  reason?: string;
}

// ─── Public entry ──────────────────────────────────────────────────────────

export async function runL3(
  input: L3ProcessInput,
  deps: RunL3Deps,
): Promise<L3ProcessResult> {
  const { repos, config, log, bus } = deps;
  const startedAt: EpochMs = Date.now();
  const now = input.now ?? startedAt;
  const warnings: L3ProcessResult["warnings"] = [];
  const timings = { cluster: 0, abstract: 0, persist: 0, total: 0 };
  const abstractions: AbstractionResult[] = [];

  log.info("run.start", {
    trigger: input.trigger,
    domainTagsFilter: input.domainTagsFilter ?? null,
    sessionId: input.sessionId ?? null,
    episodeId: input.episodeId ?? null,
  });

  // ─── Step 1: Gather eligible policies + cluster ─────────────────────────
  let clusters: PolicyCluster[] = [];
  {
    const t0 = Date.now();
    const candidates = repos.policies
      .list({ status: "active" })
      .filter(
        (p) =>
          p.gain >= config.minPolicyGain &&
          p.support >= config.minPolicySupport,
      );

    const clusterLog = log.child({ channel: "core.memory.l3.cluster" });
    clusters = clusterPolicies(
      { policies: candidates },
      {
        config: {
          clusterMinSimilarity: config.clusterMinSimilarity,
          minPolicies: config.minPolicies,
          maxPoliciesPerCluster: config.maxPoliciesPerCluster ?? 20,
        },
      },
    );

    if (input.domainTagsFilter && input.domainTagsFilter.length > 0) {
      const filterSet = new Set(input.domainTagsFilter.map((t) => t.toLowerCase()));
      clusters = clusters.filter((c) => c.domainTags.some((t) => filterSet.has(t)));
    }

    clusterLog.info("clusters.built", {
      eligiblePolicies: candidates.length,
      clusters: clusters.length,
      domainTagsFilter: input.domainTagsFilter ?? null,
    });

    timings.cluster = Date.now() - t0;
  }

  emit(bus, {
    kind: "l3.abstraction.started",
    trigger: input.trigger,
    clusterCount: clusters.length,
  });

  // ─── Step 2, 3, 4: per-cluster abstract + merge/persist ─────────────────
  const abstractLog = log.child({ channel: "core.memory.l3.abstract" });
  const mergeLog = log.child({ channel: "core.memory.l3.merge" });
  const confidenceLog = log.child({ channel: "core.memory.l3.confidence" });

  for (const cluster of clusters) {
    if (cluster.policies.length < config.minPolicies) {
      abstractions.push(skipped(cluster, "too_few_policies"));
      continue;
    }

    if (!cluster.centroidVec) {
      abstractions.push(skipped(cluster, "no_centroid"));
      emit(bus, {
        kind: "l3.abstraction.skipped",
        clusterKey: cluster.key,
        reason: "no_centroid",
        policyIds: cluster.policies.map((p) => p.id),
      });
      continue;
    }

    if (isInCooldown(cluster, repos.kv, config.cooldownDays, now)) {
      abstractLog.info("cooldown.skipped", {
        clusterKey: cluster.key,
        domainTags: cluster.domainTags,
      });
      abstractions.push(skipped(cluster, "cooldown"));
      continue;
    }
    const retry = readRetryState(repos.kv.get<unknown>(retryKey(cluster), null));
    if (retry?.quarantined) {
      abstractions.push(skipped(cluster, "quarantined"));
      emit(bus, {
        kind: "l3.abstraction.skipped",
        clusterKey: cluster.key,
        reason: "quarantined",
        policyIds: cluster.policies.map((p) => p.id),
      });
      continue;
    }
    if (retry && retry.nextRetryAt > now) {
      abstractions.push(skipped(cluster, "retry_cooldown"));
      continue;
    }

    const evidenceByPolicy = loadEvidence(cluster, repos, config.traceEvidencePerPolicy);
    const episodeIds = collectEpisodeIds(cluster.policies, evidenceByPolicy);

    // Surface a per-cluster trigger episode so the LLM call's
    // `system_model_status` row can be grouped with the rest of that
    // episode's pipeline activity in the Logs viewer. Prefer the
    // explicit trigger (passed by the L2 → L3 subscriber); otherwise
    // fall back to the first contributing episode in the cluster so
    // manual / rebuild runs still get a coherent grouping.
    const triggerEpisodeId = input.episodeId ?? episodeIds[0];

    const t0 = Date.now();
    const batchSize = Math.max(1, config.maxPoliciesPerCluster ?? 20);
    const drafts: Array<{ draft: L3AbstractionDraft; policyCount: number }> = [];
    let draftRes: L3AbstractionDraftResult | null = null;
    for (let offset = 0; offset < cluster.policies.length; offset += batchSize) {
      const batchPolicies = cluster.policies.slice(offset, offset + batchSize);
      const batchPolicyIds = new Set(batchPolicies.map((policy) => policy.id));
      const batchEvidence = new Map(
        Array.from(evidenceByPolicy.entries()).filter(([policyId]) => batchPolicyIds.has(policyId)),
      );
      const batchCluster: PolicyCluster = {
        ...cluster,
        policies: batchPolicies,
      };
      const batchResult = await abstractDraft(
        { cluster: batchCluster, evidenceByPolicy: batchEvidence, episodeId: triggerEpisodeId },
        { llm: deps.llm, log: abstractLog, config },
      );
      if (!batchResult.ok) {
        draftRes = batchResult;
        break;
      }
      drafts.push({ draft: batchResult.draft, policyCount: batchPolicies.length });
    }
    draftRes ??= { ok: true, draft: combineBatchDrafts(drafts) };
    timings.abstract += Date.now() - t0;

    if (!draftRes.ok) {
      if (
        draftRes.reason === "llm_failed" ||
        draftRes.reason === "draft_invalid" ||
        draftRes.reason === "prompt_too_large"
      ) {
        recordFailure(cluster, repos.kv, now, draftRes.reason, draftRes.reason === "prompt_too_large");
      }
      const policyIds = cluster.policies.map((p) => p.id);
      abstractions.push(skipped(cluster, draftRes.reason, { episodeIds, policyIds }));
      if (draftRes.reason === "prompt_too_large") {
        emit(bus, {
          kind: "l3.abstraction.skipped",
          clusterKey: cluster.key,
          reason: draftRes.reason,
          policyIds,
        });
      } else {
        emit(bus, {
          kind: "l3.failed",
          stage: "abstract",
          error: { code: draftRes.reason, message: draftRes.detail ?? "" },
          clusterKey: cluster.key,
          policyIds,
        });
      }
      continue;
    }

    const t1 = Date.now();
    const candidatesWm = gatherMergeCandidates(cluster, { lookup: repos.worldModel, config });
    const decision = chooseMergeTarget(cluster, candidatesWm, draftRes.draft, {
      lookup: repos.worldModel,
      config,
    });
    let persisted = false;

    if (decision.kind === "update") {
      const patch = mergeForUpdate({
        existing: decision.target,
        draft: draftRes.draft,
        cluster,
        episodeIds,
      });
      try {
        repos.worldModel.updateBody(decision.target.id, {
          title: patch.title,
          body: patch.body,
          structure: patch.structure,
          domainTags: patch.domainTags,
          policyIds: patch.policyIds,
          sourceEpisodeIds: patch.sourceEpisodeIds,
          vec: patch.vec,
          updatedAt: now,
        });
        if (!patch.vec) {
          repos.embeddingRetryQueue.enqueue({
            id: `er_${ids.span()}`,
            targetKind: "world_model",
            targetId: decision.target.id,
            vectorField: "vec",
            sourceText: worldModelVectorText(patch.title, patch.body),
            now,
          });
          warnings.push({
            stage: "embed",
            message: "embedding retry queued for world model vector",
            detail: { worldModelId: decision.target.id },
          });
        }
        const bumped = clamp01(decision.target.confidence + config.confidenceDelta);
        if (bumped !== decision.target.confidence) {
          repos.worldModel.updateConfidence(decision.target.id, bumped, now);
          confidenceLog.info("confidence.bumped", {
            worldModelId: decision.target.id,
            previous: decision.target.confidence,
            next: bumped,
          });
          emit(bus, {
            kind: "l3.confidence.adjusted",
            worldModelId: decision.target.id,
            previous: decision.target.confidence,
            next: bumped,
            reason: "merge",
          });
        }
        mergeLog.info("merged", {
          worldModelId: decision.target.id,
          clusterKey: cluster.key,
          cosine: decision.cosineScore,
        });
        abstractions.push({
          clusterKey: cluster.key,
          worldModelId: decision.target.id,
          policyCount: cluster.policies.length,
          episodeIds,
          policyIds: cluster.policies.map((p) => p.id),
          skippedReason: null,
          createdNew: false,
          mergedIntoWorldId: decision.target.id,
        });
        emit(bus, {
          kind: "l3.world-model.updated",
          worldModelId: decision.target.id,
          title: patch.title,
          domainTags: patch.domainTags,
          policyIds: patch.policyIds as PolicyId[],
          confidence: bumped,
        });
        persisted = true;
      } catch (err) {
        warnings.push(stageWarn("merge", err, { clusterKey: cluster.key }));
      }
    } else {
      const wm = buildWorldModelRow({
        draft: draftRes.draft,
        cluster,
        episodeIds,
        inducedBy: `${L3_ABSTRACTION_PROMPT.id}.v${L3_ABSTRACTION_PROMPT.version}`,
        now,
      });
      const owner = ownerFromPolicies(cluster.policies);
      wm.ownerAgentKind = owner.ownerAgentKind;
      wm.ownerProfileId = owner.ownerProfileId;
      wm.ownerWorkspaceId = owner.ownerWorkspaceId;
      try {
        repos.worldModel.insert(wm);
        if (!wm.vec) {
          repos.embeddingRetryQueue.enqueue({
            id: `er_${ids.span()}`,
            targetKind: "world_model",
            targetId: wm.id,
            vectorField: "vec",
            sourceText: worldModelVectorText(wm.title, wm.body),
            now,
          });
          warnings.push({
            stage: "embed",
            message: "embedding retry queued for world model vector",
            detail: { worldModelId: wm.id },
          });
        }
        abstractions.push({
          clusterKey: cluster.key,
          worldModelId: wm.id,
          policyCount: cluster.policies.length,
          episodeIds,
          policyIds: cluster.policies.map((p) => p.id),
          skippedReason: null,
          createdNew: true,
        });
        emit(bus, {
          kind: "l3.world-model.created",
          worldModelId: wm.id,
          title: wm.title,
          domainTags: wm.domainTags,
          policyIds: wm.policyIds,
          confidence: wm.confidence,
        });
        persisted = true;
      } catch (err) {
        warnings.push(stageWarn("insert", err, { clusterKey: cluster.key }));
      }
    }

    if (persisted) {
      markCooldown(cluster, repos.kv, now);
      repos.kv.del(retryKey(cluster));
    } else {
      recordFailure(cluster, repos.kv, now);
    }
    timings.persist += Date.now() - t1;
  }

  const completedAt = Date.now();
  timings.total = completedAt - startedAt;

  log.info("run.done", {
    trigger: input.trigger,
    clusters: clusters.length,
    created: abstractions.filter((a) => a.createdNew === true).length,
    merged: abstractions.filter((a) => a.mergedIntoWorldId).length,
    skipped: abstractions.filter((a) => a.skippedReason !== null).length,
    timings,
  });

  return {
    trigger: input.trigger,
    abstractions,
    warnings,
    timings,
    startedAt,
    completedAt,
  };
}

function ownerFromPolicies(policies: readonly { ownerAgentKind?: string; ownerProfileId?: string; ownerWorkspaceId?: string | null }[]): {
  ownerAgentKind: string;
  ownerProfileId: string;
  ownerWorkspaceId: string | null;
} {
  const first = policies[0];
  return {
    ownerAgentKind: first?.ownerAgentKind ?? "unknown",
    ownerProfileId: first?.ownerProfileId ?? "default",
    ownerWorkspaceId: first?.ownerWorkspaceId ?? null,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function emit(bus: L3EventBus | undefined, evt: L3Event): void {
  if (!bus) return;
  bus.emit(evt);
}

function stageWarn(
  stage: string,
  err: unknown,
  detail?: Record<string, unknown>,
): { stage: string; message: string; detail?: Record<string, unknown> } {
  const message = err instanceof Error ? err.message : String(err);
  return { stage, message, detail };
}

function worldModelVectorText(title: string, body: string): string {
  return [title.trim(), body.trim()].filter(Boolean).join("\n\n") || "(empty)";
}

function combineBatchDrafts(
  drafts: readonly { draft: L3AbstractionDraft; policyCount: number }[],
): L3AbstractionDraft {
  const first = drafts[0]!;
  const weightedPolicyCount = drafts.reduce((sum, item) => sum + item.policyCount, 0);
  return {
    title: first.draft.title,
    domainTags: dedupeStrings(drafts.flatMap((item) => item.draft.domainTags)),
    environment: combineDraftEntries(drafts.flatMap((item) => item.draft.environment)),
    inference: combineDraftEntries(drafts.flatMap((item) => item.draft.inference)),
    constraints: combineDraftEntries(drafts.flatMap((item) => item.draft.constraints)),
    body: dedupeStrings(drafts.map((item) => item.draft.body).filter(Boolean)).join("\n\n---\n\n"),
    confidence:
      drafts.reduce(
        (sum, item) => sum + item.draft.confidence * item.policyCount,
        0,
      ) / weightedPolicyCount,
    supersedesWorldIds: Array.from(
      new Set(drafts.flatMap((item) => item.draft.supersedesWorldIds ?? [])),
    ),
  };
}

function combineDraftEntries(
  entries: readonly L3AbstractionDraftEntry[],
): L3AbstractionDraftEntry[] {
  const combined = new Map<string, L3AbstractionDraftEntry>();
  for (const entry of entries) {
    const key = `${entry.label.trim().toLowerCase()}\u0000${entry.description.trim().toLowerCase()}`;
    const previous = combined.get(key);
    if (!previous) {
      combined.set(key, { ...entry, evidenceIds: dedupeStrings(entry.evidenceIds ?? []) });
      continue;
    }
    previous.evidenceIds = dedupeStrings([
      ...(previous.evidenceIds ?? []),
      ...(entry.evidenceIds ?? []),
    ]);
  }
  return Array.from(combined.values());
}

function dedupeStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function skipped(
  cluster: PolicyCluster,
  reason: Exclude<AbstractionResult["skippedReason"], null>,
  extra?: { episodeIds?: EpisodeId[]; policyIds?: PolicyId[] },
): AbstractionResult {
  return {
    clusterKey: cluster.key,
    worldModelId: null,
    policyCount: cluster.policies.length,
    episodeIds: extra?.episodeIds ?? [],
    policyIds: extra?.policyIds ?? cluster.policies.map((p) => p.id),
    skippedReason: reason,
  };
}

function loadEvidence(
  cluster: PolicyCluster,
  repos: Pick<Repos, "traces">,
  cap: number,
): Map<PolicyId, readonly TraceRow[]> {
  const out = new Map<PolicyId, readonly TraceRow[]>();
  if (cap <= 0) {
    for (const p of cluster.policies) out.set(p.id, []);
    return out;
  }
  for (const p of cluster.policies) {
    const epIds = p.sourceEpisodeIds.slice(0, Math.min(3, cap + 1));
    const traces: TraceRow[] = [];
    for (const ep of epIds) {
      const forEpisode = repos.traces.list({ episodeId: ep, limit: 8 });
      const best = forEpisode
        .filter((t) => (t.vecSummary ?? t.vecAction) !== null)
        .sort((a, b) => b.value - a.value)
        .slice(0, cap);
      for (const t of best) {
        if (!traces.some((prev) => prev.id === t.id)) traces.push(t);
        if (traces.length >= cap) break;
      }
      if (traces.length >= cap) break;
    }
    out.set(p.id, traces);
  }
  return out;
}

function collectEpisodeIds(
  policies: readonly PolicyRow[],
  evidenceByPolicy: Map<PolicyId, readonly TraceRow[]>,
): EpisodeId[] {
  const set = new Set<string>();
  for (const p of policies) for (const ep of p.sourceEpisodeIds) set.add(ep);
  for (const arr of evidenceByPolicy.values()) for (const t of arr) set.add(t.episodeId);
  return Array.from(set) as EpisodeId[];
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// ─── Cooldown bookkeeping ───────────────────────────────────────────────────

function cooldownKey(cluster: PolicyCluster): string {
  const primary = cluster.domainTags[0] ?? cluster.key;
  return `${KV_COOLDOWN_PREFIX}${primary}`;
}

function retryKey(cluster: PolicyCluster): string {
  return retryKeyFor(cluster.key, cluster.policies.map((p) => p.id));
}

function retryKeyFor(clusterKey: PolicyClusterKey, policyIds: readonly PolicyId[]): string {
  const members = policyIds.map((id) => String(id)).sort().join(",");
  return `${KV_RETRY_PREFIX}${clusterKey}:${members}`;
}

/** Clear a retry/quarantine record after a config or prompt fix. */
export function clearL3RetryState(
  clusterKey: PolicyClusterKey,
  policyIds: readonly PolicyId[],
  kv: Repos["kv"],
): void {
  kv.del(retryKeyFor(clusterKey, policyIds));
}

function recordFailure(
  cluster: PolicyCluster,
  kv: Repos["kv"],
  now: number,
  reason?: string,
  quarantine = false,
): void {
  const previous = readRetryState(kv.get<unknown>(retryKey(cluster), null));
  const failures = Math.min((previous?.failures ?? 0) + 1, MAX_FAILURE_ATTEMPTS);
  const delay = FAILURE_BACKOFF_MS[failures - 1] ?? FAILURE_BACKOFF_MS[FAILURE_BACKOFF_MS.length - 1]!;
  kv.set<L3RetryState>(retryKey(cluster), {
    version: RETRY_STATE_VERSION,
    failures,
    nextRetryAt: now + delay,
    quarantined: quarantine || failures >= MAX_FAILURE_ATTEMPTS,
    ...(reason ? { reason } : {}),
  });
}

function readRetryState(raw: unknown): L3RetryState | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const failures = typeof row.failures === "number" && Number.isFinite(row.failures)
    ? Math.max(0, Math.floor(row.failures))
    : 0;
  const nextRetryAt = typeof row.nextRetryAt === "number" && Number.isFinite(row.nextRetryAt)
    ? row.nextRetryAt
    : 0;
  if (failures <= 0 && nextRetryAt <= 0) return null;
  return {
    version: typeof row.version === "number" ? row.version : 1,
    failures,
    nextRetryAt,
    quarantined: row.quarantined === true,
    reason: typeof row.reason === "string" ? row.reason : undefined,
  };
}

function isInCooldown(
  cluster: PolicyCluster,
  kv: Repos["kv"],
  cooldownDays: number,
  now: number,
): boolean {
  if (cooldownDays <= 0) return false;
  const last = kv.get<number>(cooldownKey(cluster), 0);
  if (!last || last <= 0) return false;
  const cooldownMs = cooldownDays * 24 * 60 * 60 * 1000;
  return now - last < cooldownMs;
}

function markCooldown(
  cluster: PolicyCluster,
  kv: Repos["kv"],
  now: number,
): void {
  kv.set<number>(cooldownKey(cluster), now);
}

// ─── Public confidence adjustment (used by feedback/subscriber) ─────────────

export function adjustConfidence(
  worldModelId: WorldModelId,
  polarity: "positive" | "negative",
  deps: Pick<RunL3Deps, "repos" | "config" | "log" | "bus">,
  now: number = Date.now(),
): { previous: number; next: number } | null {
  const row = deps.repos.worldModel.getById(worldModelId);
  if (!row) return null;
  const delta = polarity === "positive" ? deps.config.confidenceDelta : -deps.config.confidenceDelta;
  const next = clamp01(row.confidence + delta);
  if (next === row.confidence) return { previous: row.confidence, next };

  deps.repos.worldModel.updateConfidence(worldModelId, next, now);
  const log = deps.log.child({ channel: "core.memory.l3.feedback" });
  log.info("confidence.adjusted", {
    worldModelId,
    previous: row.confidence,
    next,
    polarity,
  });
  if (deps.bus) {
    deps.bus.emit({
      kind: "l3.confidence.adjusted",
      worldModelId,
      previous: row.confidence,
      next,
      reason: `feedback.${polarity}`,
    });
  }
  return { previous: row.confidence, next };
}
