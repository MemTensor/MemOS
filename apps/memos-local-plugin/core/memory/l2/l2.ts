/**
 * `runL2` — the one-episode-in/many-policy-updates-out orchestrator.
 *
 * Called by `subscriber.ts` on every `reward.updated` event. Steps:
 *
 *   1. Associate each high-V trace with an existing policy (cosine + sig).
 *      Matched traces bump `support` and feed the with-set for gain.
 *   2. Traces that don't match are added to `l2_candidate_pool`, keyed by
 *      their PatternSignature.
 *   3. We scan the pool for buckets with ≥ `minEpisodesForInduction` distinct
 *      episodes and run the `l2.induction` prompt on each.
 *   4. Successful drafts become new `candidate` policies; associated
 *      candidate-pool rows are promoted (policy_id filled in).
 *   5. For every policy touched (either via association or induction) we
 *      recompute `gain`, `support`, `status` and persist.
 *
 * Pure pipeline — takes deps (repos, llm, log, bus) and returns a
 * `L2ProcessResult`. No globals.
 */

import { ERROR_CODES, MemosError } from "../../../agent-contract/errors.js";
import type { Logger } from "../../logger/types.js";
import type { LlmClient } from "../../llm/index.js";
import type {
  EpisodeId,
  EpochMs,
  PolicyId,
  PolicyRow,
  TraceRow,
} from "../../types.js";
import type { Repos } from "../../storage/repos/index.js";
import { ids } from "../../id.js";
import { L2_INDUCTION_PROMPT } from "../../llm/prompts/l2-induction.js";
import { associateTraces } from "./associate.js";
import { makeCandidatePool } from "./candidate-pool.js";
import { buildPolicyRow, induceDraft } from "./induce.js";
import { applyGain, computeGain } from "./gain.js";
import { signatureOf } from "./signature.js";
import { tracePolicySimilarity } from "./similarity.js";
import type {
  AssociationResult,
  InductionResult,
  L2Config,
  L2Event,
  L2EventBus,
  L2ProcessInput,
  L2ProcessResult,
} from "./types.js";

export interface RunL2Deps {
  repos: Pick<Repos, "candidatePool" | "embeddingRetryQueue" | "policies" | "traces">;
  db: Parameters<typeof makeCandidatePool>[0]["db"];
  llm: LlmClient | null;
  log: Logger;
  bus?: L2EventBus;
  config: L2Config;
  /** Thresholds that live alongside config.algorithm.skill — passed through. */
  thresholds: { minSupport: number; minGain: number; archiveGain: number };
}

export async function runL2(
  input: L2ProcessInput,
  deps: RunL2Deps,
): Promise<L2ProcessResult> {
  const { repos, log, bus, config, thresholds } = deps;
  const startedAt: EpochMs = Date.now();
  const warnings: L2ProcessResult["warnings"] = [];
  const timings = { associate: 0, candidate: 0, induce: 0, gain: 0, persist: 0, total: 0 };

  const eligibleTraces = input.traces.filter((t) => t.value >= config.minTraceValue && !!(t.vecSummary ?? t.vecAction));
  log.info("run.start", {
    episodeId: input.episodeId,
    sessionId: input.sessionId,
    traceCount: input.traces.length,
    eligibleCount: eligibleTraces.length,
    trigger: input.trigger,
  });

  // ─── Step 1: Associate ──────────────────────────────────────────────────
  let associations: AssociationResult[] = [];
  {
    const t0 = Date.now();
    associations = associateTraces(eligibleTraces, {
      repos,
      log: log.child({ channel: "core.memory.l2.associate" }),
      config: { minSimilarity: config.minSimilarity, poolFactor: 4 },
    });
    timings.associate = Date.now() - t0;
  }

  // Attach signatures and emit per-trace events.
  for (const a of associations) {
    const tr = eligibleTraces.find((t) => t.id === a.traceId);
    if (!tr) continue;
    a.signature = signatureOf(tr);
    if (a.matchedPolicyId) {
      emit(bus, {
        kind: "l2.trace.associated",
        episodeId: input.episodeId,
        traceId: a.traceId,
        policyId: a.matchedPolicyId,
        similarity: a.matchSimilarity,
      });
    }
  }

  // ─── Step 2: Candidate pool for unmatched traces ────────────────────────
  const pool = makeCandidatePool({ db: deps.db, repos });
  {
    const t0 = Date.now();
    const ttlMs = config.candidateTtlDays * 24 * 60 * 60 * 1000;
    for (let i = 0; i < associations.length; i++) {
      const a = associations[i];
      if (a.matchedPolicyId) continue;
      const tr = eligibleTraces.find((t) => t.id === a.traceId);
      if (!tr) continue;
      try {
        const r = pool.addCandidate({ trace: tr, ttlMs, now: input.now });
        a.addedToCandidatePool = true;
        emit(bus, {
          kind: "l2.candidate.added",
          episodeId: input.episodeId,
          traceId: tr.id,
          signature: r.signature,
          candidateId: r.candidateId,
        });
      } catch (err) {
        warnings.push(stageWarn("candidate", err, { traceId: tr.id }));
      }
    }
    timings.candidate = Date.now() - t0;
  }

  // ─── Step 3: Induction on any ready buckets ─────────────────────────────
  const inductions: InductionResult[] = [];
  const touched = new Map<PolicyId, PolicyRow>();
  /**
   * Track traces that WERE the induction evidence for each freshly-
   * minted policy. We need this in Step 4: when a policy is induced,
   * its evidence traces are by definition the `with` set for gain
   * computation. Without this bookkeeping, Step 4 would see zero
   * `withIds` (associations were computed in Step 1 before this policy
   * existed) and incorrectly score the new policy as gain = −V̄_episode,
   * leaving it stuck in `candidate` forever. This was a real bug
   * observed in end-to-end testing.
   */
  const inductionEvidenceByPolicy = new Map<PolicyId, Set<string>>();

  {
    const t0 = Date.now();
    const ready = pool.bucketsReadyForInduction({
      minDistinctEpisodes: config.minEpisodesForInduction,
      now: input.now,
    });
    for (const bucket of ready) {
      const traces = bucket.evidenceTraceIds
        .map((id) => repos.traces.getById(id))
        .filter((t): t is TraceRow => !!t);
      const epIds = bucket.episodeIds as EpisodeId[];
      if (traces.length === 0 || epIds.length < config.minEpisodesForInduction) {
        inductions.push({
          signature: bucket.signature,
          policyId: null,
          poolSize: bucket.candidateIds.length,
          episodeIds: epIds,
          traceIds: bucket.evidenceTraceIds,
          skippedReason: "too_few_episodes",
        });
        continue;
      }

      // Cheap duplicate detection — if any of these traces already cosine-match
      // an existing policy, skip induction and let association handle it.
      const dup = findExistingMatch(traces, repos, config.minSimilarity);
      if (dup) {
        inductions.push({
          signature: bucket.signature,
          policyId: dup.id,
          poolSize: bucket.candidateIds.length,
          episodeIds: epIds,
          traceIds: bucket.evidenceTraceIds,
          skippedReason: "duplicate_of",
          duplicateOfPolicyId: dup.id,
        });
        pool.promote(bucket.candidateIds, dup.id);
        touched.set(dup.id, dup);
        const evidence = inductionEvidenceByPolicy.get(dup.id) ?? new Set<string>();
        for (const id of bucket.evidenceTraceIds) evidence.add(id);
        inductionEvidenceByPolicy.set(dup.id, evidence);
        continue;
      }

      const draftRes = await induceDraft(
        {
          evidenceTraces: pickOnePerEpisode(traces),
          episodeIds: epIds,
          signatureLabel: bucket.signature,
          charCap: config.inductionTraceCharCap,
          triggerEpisodeId: input.episodeId,
        },
        {
          llm: config.useLlm ? deps.llm : null,
          log: log.child({ channel: "core.memory.l2.induce" }),
          validate: (d) => {
            if (!d.procedure) {
              throw new MemosError(ERROR_CODES.LLM_OUTPUT_MALFORMED, "draft missing procedure");
            }
          },
        },
      );
      if (!draftRes.ok) {
        inductions.push({
          signature: bucket.signature,
          policyId: null,
          poolSize: bucket.candidateIds.length,
          episodeIds: epIds,
          traceIds: bucket.evidenceTraceIds,
          skippedReason: draftRes.reason,
        });
        continue;
      }

      const policy = buildPolicyRow({
        draft: draftRes.draft,
        episodeIds: epIds,
        evidenceTraces: traces,
        inducedBy: `${L2_INDUCTION_PROMPT.id}.v${L2_INDUCTION_PROMPT.version}`,
        now: input.now ?? Date.now(),
      });
      const owner = ownerFromTraces(traces);
      policy.ownerAgentKind = owner.ownerAgentKind;
      policy.ownerProfileId = owner.ownerProfileId;
      policy.ownerWorkspaceId = owner.ownerWorkspaceId;
      const duplicate = findExistingContentDuplicate(policy, repos);
      if (duplicate) {
        const merged = mergePolicyEvidence(duplicate, policy, input.now ?? Date.now());
        repos.policies.upsert(merged);
        pool.promote(bucket.candidateIds, duplicate.id);
        touched.set(duplicate.id, merged);
        inductionEvidenceByPolicy.set(
          duplicate.id,
          new Set(bucket.evidenceTraceIds as string[]),
        );
        inductions.push({
          signature: bucket.signature,
          policyId: duplicate.id,
          poolSize: bucket.candidateIds.length,
          episodeIds: epIds,
          traceIds: bucket.evidenceTraceIds,
          skippedReason: "duplicate_of",
          duplicateOfPolicyId: duplicate.id,
        });
        continue;
      }
      try {
        repos.policies.insert(policy);
        if (!policy.vec) {
          repos.embeddingRetryQueue.enqueue({
            id: `er_${ids.span()}`,
            targetKind: "policy",
            targetId: policy.id,
            vectorField: "vec",
            sourceText: policyVectorText(policy),
            now: input.now ?? Date.now(),
          });
          warnings.push({
            stage: "embed",
            message: "embedding retry queued for policy vector",
            detail: { policyId: policy.id },
          });
        }
        pool.promote(bucket.candidateIds, policy.id);
        touched.set(policy.id, policy);
        inductionEvidenceByPolicy.set(
          policy.id,
          new Set(bucket.evidenceTraceIds as string[]),
        );
        inductions.push({
          signature: bucket.signature,
          policyId: policy.id,
          poolSize: bucket.candidateIds.length,
          episodeIds: epIds,
          traceIds: bucket.evidenceTraceIds,
          skippedReason: null,
        });
        emit(bus, {
          kind: "l2.policy.induced",
          episodeId: input.episodeId,
          policyId: policy.id,
          signature: bucket.signature,
          evidenceTraceIds: bucket.evidenceTraceIds,
          evidenceEpisodeIds: epIds,
          title: policy.title,
        });
      } catch (err) {
        warnings.push(stageWarn("induce.persist", err, { signature: bucket.signature }));
      }
    }
    timings.induce = Date.now() - t0;
  }

  // Pre-load any policies touched through association.
  for (const a of associations) {
    if (!a.matchedPolicyId) continue;
    if (touched.has(a.matchedPolicyId)) continue;
    const p = repos.policies.getById(a.matchedPolicyId);
    if (p) touched.set(a.matchedPolicyId, p);
  }

  // ─── Step 4: Recompute gain + persist updates ───────────────────────────
  {
    const t0 = Date.now();
    for (const policy of touched.values()) {
      // `withIds` starts from cross-episode associations (Step 1)…
      const withIds = new Set<string>();
      for (const a of associations) if (a.matchedPolicyId === policy.id) withIds.add(a.traceId);
      // …and is augmented with the induction evidence for freshly
      // minted policies. Traces that triggered the induction are, by
      // construction, positive examples of the policy pattern. They
      // belong in the `with` set for gain computation (see V7 §0.6 eq.
      // 4 / §2.4.5 row ③: G = V̄_with − V̄_without).
      const inductionIds = inductionEvidenceByPolicy.get(policy.id);
      if (inductionIds) {
        for (const id of inductionIds) withIds.add(id);
      }

      // Gain is computed over ALL traces currently in scope — the
      // current episode's traces PLUS the induction evidence traces
      // (which may come from earlier episodes). Previously we only
      // used `input.traces`, which meant a policy induced from two
      // past episodes would see an empty `withTraces` and tank its
      // gain. Pull missing induction traces from the repo.
      const traceById = new Map<string, TraceRow>();
      for (const t of input.traces) traceById.set(t.id, t);
      if (inductionIds) {
        for (const id of inductionIds) {
          if (traceById.has(id)) continue;
          const t = repos.traces.getById(id as TraceRow["id"]);
          if (t) traceById.set(t.id, t);
        }
      }
      const allTraces = Array.from(traceById.values());

      const withTraces: TraceRow[] = allTraces.filter((t) => withIds.has(t.id));
      const withoutTraces: TraceRow[] = allTraces.filter((t) => !withIds.has(t.id));

      const gain = computeGain(
        { policyId: policy.id, withTraces, withoutTraces },
        { tauSoftmax: config.tauSoftmax },
      );

      // `deltaSupport` must reflect only the *new* positive evidence
      // we just observed — both fresh associations AND the induction
      // evidence for a newly-minted policy. Previously only `withIds`
      // from associations contributed, so a new policy's support
      // stayed at 0 until someone re-associated in a later round.
      const deltaSupport = withIds.size;

      const persisted = applyGain({
        gain,
        deltaSupport,
        currentStatus: policy.status,
        thresholds,
        currentSupport: policy.support,
        now: input.now ?? Date.now(),
        persist: ({ policyId, support, gain: g, status, updatedAt }) =>
          repos.policies.updateStats(policyId, { support, gain: g, status, updatedAt }),
      });

      emit(bus, {
        kind: "l2.policy.updated",
        episodeId: input.episodeId,
        policyId: policy.id,
        status: persisted.status,
        support: persisted.support,
        gain: persisted.gain,
      });
    }
    timings.gain = Date.now() - t0;
  }

  timings.persist = 0; // reserved for future split
  const completedAt = Date.now();
  timings.total = completedAt - startedAt;

  log.info("run.done", {
    episodeId: input.episodeId,
    sessionId: input.sessionId,
    associations: associations.filter((a) => !!a.matchedPolicyId).length,
    candidates: associations.filter((a) => a.addedToCandidatePool).length,
    inductions: inductions.filter((i) => !!i.policyId).length,
    touchedPolicies: touched.size,
    timings,
  });

  return {
    episodeId: input.episodeId,
    sessionId: input.sessionId,
    associations,
    inductions,
    touchedPolicyIds: Array.from(touched.keys()),
    warnings,
    timings,
    startedAt,
    completedAt,
  };
}

function ownerFromTraces(traces: readonly TraceRow[]): {
  ownerAgentKind: string;
  ownerProfileId: string;
  ownerWorkspaceId: string | null;
} {
  const first = traces[0];
  return {
    ownerAgentKind: first?.ownerAgentKind ?? "unknown",
    ownerProfileId: first?.ownerProfileId ?? "default",
    ownerWorkspaceId: first?.ownerWorkspaceId ?? null,
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function emit(bus: L2EventBus | undefined, evt: L2Event): void {
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

function policyVectorText(policy: PolicyRow): string {
  return [
    policy.title,
    policy.trigger,
    policy.procedure,
    policy.verification,
    policy.boundary,
  ].filter(Boolean).join("\n");
}

function pickOnePerEpisode(traces: readonly TraceRow[]): TraceRow[] {
  const byEp = new Map<string, TraceRow>();
  for (const t of traces) {
    const cur = byEp.get(t.episodeId);
    if (!cur || t.value > cur.value) byEp.set(t.episodeId, t);
  }
  return Array.from(byEp.values());
}

function findExistingMatch(
  traces: readonly TraceRow[],
  repos: Pick<Repos, "policies">,
  minSimilarity: number,
): PolicyRow | null {
  for (const t of traces) {
    const vec = t.vecSummary ?? t.vecAction ?? null;
    if (!vec) continue;
    const hits = repos.policies.searchByVector(vec, 5, {
      statusIn: ["active", "candidate"],
    });
    for (const h of hits) {
      const p = repos.policies.getById(h.id);
      if (!p) continue;
      const s = tracePolicySimilarity(t, p, null);
      if (s.score >= minSimilarity) return p;
    }
  }
  return null;
}

function findExistingContentDuplicate(
  policy: PolicyRow,
  repos: Pick<Repos, "policies">,
): PolicyRow | null {
  const target = policyContentKey(policy);
  let best: { row: PolicyRow; score: PolicyNearDuplicateScore } | null = null;
  for (const existing of repos.policies.list({ limit: 5_000 })) {
    if (!sameOwnerScope(existing, policy)) continue;
    if (policyContentKey(existing) === target && policyOptionalFieldsCompatible(existing, policy)) {
      return existing;
    }
    const score = policyNearDuplicateScore(existing, policy);
    if (score.match && (!best || score.weighted > best.score.weighted)) {
      best = { row: existing, score };
    }
  }
  return best?.row ?? null;
}

function policyOptionalFieldsCompatible(
  a: Pick<PolicyRow, "boundary" | "verification">,
  b: Pick<PolicyRow, "boundary" | "verification">,
): boolean {
  const boundary = optionalFieldSimilarity(a.boundary, b.boundary);
  const verification = optionalFieldSimilarity(a.verification, b.verification);
  return (
    !boundaryPolarityConflicts(a.boundary, b.boundary) &&
    (boundary == null || boundary >= POLICY_NEAR_DUP_BOUNDARY_MIN) &&
    (verification == null || verification >= POLICY_NEAR_DUP_BOUNDARY_MIN)
  );
}

function mergePolicyEvidence(existing: PolicyRow, incoming: PolicyRow, now: number): PolicyRow {
  return {
    ...existing,
    sourceEpisodeIds: uniqueEpisodes([
      ...existing.sourceEpisodeIds,
      ...incoming.sourceEpisodeIds,
    ]),
    vec: existing.vec ?? incoming.vec,
    updatedAt: now as PolicyRow["updatedAt"],
  };
}

function policyContentKey(policy: Pick<PolicyRow, "title" | "trigger" | "procedure">): string {
  return [
    normalizePolicyText(policy.title),
    normalizePolicyText(policy.trigger),
    normalizePolicyText(policy.procedure),
  ].join("\n");
}

const POLICY_NEAR_DUP_TITLE_MIN = 0.9;
const POLICY_NEAR_DUP_TRIGGER_MIN = 0.8;
const POLICY_NEAR_DUP_PROCEDURE_MIN = 0.7;
const POLICY_NEAR_DUP_BOUNDARY_MIN = 0.45;

interface PolicyNearDuplicateScore {
  match: boolean;
  title: number;
  trigger: number;
  procedure: number;
  weighted: number;
  boundary: number | null;
  verification: number | null;
}

function policyNearDuplicateScore(
  a: Pick<PolicyRow, "title" | "trigger" | "procedure" | "boundary" | "verification">,
  b: Pick<PolicyRow, "title" | "trigger" | "procedure" | "boundary" | "verification">,
): PolicyNearDuplicateScore {
  const title = textSimilarity(a.title, b.title);
  const trigger = textSimilarity(a.trigger, b.trigger);
  const procedure = textSimilarity(a.procedure, b.procedure);
  const weighted = title * 0.45 + trigger * 0.25 + procedure * 0.3;
  const boundary = optionalFieldSimilarity(a.boundary, b.boundary);
  const verification = optionalFieldSimilarity(a.verification, b.verification);
  const optionalFieldsCompatible =
    !boundaryPolarityConflicts(a.boundary, b.boundary) &&
    (boundary == null || boundary >= POLICY_NEAR_DUP_BOUNDARY_MIN) &&
    (verification == null || verification >= POLICY_NEAR_DUP_BOUNDARY_MIN);
  const contentFieldMatches =
    title >= POLICY_NEAR_DUP_TITLE_MIN ||
    trigger >= POLICY_NEAR_DUP_TRIGGER_MIN ||
    procedure >= POLICY_NEAR_DUP_PROCEDURE_MIN;
  return {
    match: contentFieldMatches && optionalFieldsCompatible,
    title,
    trigger,
    procedure,
    weighted,
    boundary,
    verification,
  };
}

function normalizePolicyText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[，,、;；:：。.!！?？"'“”‘’`()[\]{}（）【】]/g, "")
    .replace(/(?:^|\s)\d+[.)、]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function optionalFieldSimilarity(a: string, b: string): number | null {
  const aa = normalizePolicyText(a);
  const bb = normalizePolicyText(b);
  if (!aa || !bb) return null;
  return textSimilarity(aa, bb);
}

function boundaryPolarityConflicts(a: string, b: string): boolean {
  const aa = splitBoundaryPolarity(a);
  const bb = splitBoundaryPolarity(b);
  if (!aa || !bb) return false;
  return (
    (Boolean(aa.positive) && Boolean(bb.negative) && textSimilarity(aa.positive, bb.negative) >= 0.45) ||
    (Boolean(bb.positive) && Boolean(aa.negative) && textSimilarity(bb.positive, aa.negative) >= 0.45)
  );
}

function splitBoundaryPolarity(value: string): { positive: string; negative: string } | null {
  const text = value.trim();
  if (!text || !text.includes("不适用")) return null;
  const [positiveRaw, ...negativeParts] = text.split(/不适用于|不适用/);
  const negative = negativeParts.join(" ");
  return {
    positive: positiveRaw.replace(/仅适用于|只适用于|适用于/g, "").trim(),
    negative: negative.replace(/仅适用于|只适用于|适用于/g, "").trim(),
  };
}

function textSimilarity(a: string, b: string): number {
  const aa = normalizePolicyText(a);
  const bb = normalizePolicyText(b);
  if (!aa || !bb) return aa === bb ? 1 : 0;
  if (aa === bb) return 1;
  const gramsA = charGrams(aa);
  const gramsB = charGrams(bb);
  let overlap = 0;
  for (const [gram, countA] of gramsA) {
    const countB = gramsB.get(gram);
    if (countB) overlap += Math.min(countA, countB);
  }
  const totalA = Array.from(gramsA.values()).reduce((sum, n) => sum + n, 0);
  const totalB = Array.from(gramsB.values()).reduce((sum, n) => sum + n, 0);
  return totalA + totalB === 0 ? 0 : (2 * overlap) / (totalA + totalB);
}

function charGrams(value: string): Map<string, number> {
  const chars = Array.from(value.replace(/\s+/g, ""));
  const grams = new Map<string, number>();
  if (chars.length <= 2) {
    const key = chars.join("");
    grams.set(key, 1);
    return grams;
  }
  for (let i = 0; i < chars.length - 1; i++) {
    const gram = `${chars[i]}${chars[i + 1]}`;
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

function sameOwnerScope(a: PolicyRow, b: PolicyRow): boolean {
  return (
    (a.ownerAgentKind ?? "unknown") === (b.ownerAgentKind ?? "unknown") &&
    (a.ownerProfileId ?? "default") === (b.ownerProfileId ?? "default") &&
    (a.ownerWorkspaceId ?? null) === (b.ownerWorkspaceId ?? null)
  );
}

function uniqueEpisodes(ids: readonly EpisodeId[]): EpisodeId[] {
  return Array.from(new Set(ids));
}
