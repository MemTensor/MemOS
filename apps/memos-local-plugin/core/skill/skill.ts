/**
 * V7 §2.5 — Skill crystallization orchestrator.
 *
 * High-level flow (also drawn in `ALGORITHMS.md`):
 *
 *   1. gather candidate policies (`policyId` hint OR all active policies).
 *   2. evaluate eligibility via `eligibility.ts` — per-policy verdict.
 *   3. for each `crystallize` or `rebuild` decision:
 *        a. pull evidence traces.
 *        b. call `SKILL_CRYSTALLIZE_PROMPT` → normalised draft.
 *        c. run `verifier.verifyDraft` — heuristic consistency check.
 *        d. build a `SkillRow` via `packager.buildSkillRow`.
 *        e. upsert into `skills`. Emit `skill.crystallized`.
 *        f. if verified & trials not already met → status stays
 *           `candidate`; if the rebuild supersedes an existing active
 *           skill, new rows always start as `candidate` so they're
 *           re-tested before surfacing.
 *   4. emit a rollup event (`skill.eligibility.checked`).
 *
 * The orchestrator never mutates state on its own; every write is a
 * repo.upsert call that the transaction wrapper keeps atomic.
 */

import type { Embedder } from "../embedding/types.js";
import type { LlmClient } from "../llm/types.js";
import type { Logger } from "../logger/types.js";
import type { Repos } from "../storage/repos/index.js";
import { now as nowMs } from "../time.js";
import { ids } from "../id.js";
import type {
  PolicyRow,
  SkillId,
  SkillRow,
  TraceRow,
} from "../types.js";
import {
  crystallizeDraft,
  defaultDraftValidator,
  type CrystallizeResult,
} from "./crystallize.js";
import { evaluateEligibility } from "./eligibility.js";
import {
  gatherCounterExamples,
  gatherEvidence,
  gatherIncrementalEvidence,
  type AnnotatedTrace,
} from "./evidence.js";
import { mergeRebuildDraft, procedureFromSkillRow } from "./merge.js";
import { computeRebuildLevel, type RebuildLevel } from "./rebuild-level.js";
import { resolveSkillOutputLanguage } from "./language.js";
import { normalizeSkillName, uniquifySkillName } from "./name.js";
import {
  applyFeedback,
  recomputeEta,
} from "./lifecycle.js";
import { buildSkillRow } from "./packager.js";
import type {
  RunSkillInput,
  RunSkillResult,
  SkillConfig,
  SkillEventBus,
  SkillFeedbackKind,
  SkillProcedure,
} from "./types.js";
import { verifyDraft } from "./verifier.js";

const SEMANTIC_DUPLICATE_SKILL_SIMILARITY = 0.95;

export interface RunSkillDeps {
  repos: Repos;
  embedder: Embedder | null;
  llm: LlmClient | null;
  log: Logger;
  bus: SkillEventBus;
  config: SkillConfig;
}

export async function runSkill(
  input: RunSkillInput,
  deps: RunSkillDeps,
): Promise<RunSkillResult> {
  const startedAt = nowMs();
  const { log, config, bus, repos } = deps;

  log.info("skill.run.start", { trigger: input.trigger, policyId: input.policyId });

  const policies = gatherPolicies(input, repos);
  const skillsByPolicy = buildSkillIndex(repos);
  const timings = { eligibility: 0, crystallize: 0, verify: 0, persist: 0 };
  const warnings: RunSkillResult["warnings"] = [];

  const tEligibility = nowMs();
  const eligibility = evaluateEligibility({ policies, skillsByPolicy }, config);
  timings.eligibility = nowMs() - tEligibility;

  bus.emit({
    kind: "skill.eligibility.checked",
    at: nowMs(),
    totalPolicies: policies.length,
    eligible: eligibility.eligibleCount,
    skipped: eligibility.decisions
      .filter((d) => d.action === "skip")
      .map((d) => ({ policyId: d.policy.id, reason: d.reason })),
  });

  let evaluated = 0;
  let crystallized = 0;
  let rebuilt = 0;
  let rejected = 0;

  for (const decision of eligibility.decisions) {
    if (decision.action === "skip") continue;
    evaluated += 1;

    const evidence = gatherEvidence(decision.policy, {
      repos,
      config,
    });
    const incremental =
      decision.action === "rebuild" && decision.existingSkill
        ? gatherIncrementalEvidence(decision.policy, decision.existingSkill, {
            repos,
            config,
          })
        : { traces: [], poolAfterDedupe: 0 };

    const rebuildMeta =
      decision.action === "rebuild" && decision.existingSkill
        ? computeRebuildLevel({
            policy: decision.policy,
            existingSkill: decision.existingSkill,
            incrementalEvidence: incremental.traces.map((a) => a.trace),
          })
        : null;
    const outputLanguage = resolveSkillOutputLanguage(decision.policy, config);
    const existingProc = decision.existingSkill
      ? procedureFromSkillRow(decision.existingSkill.procedureJson)
      : null;
    const renameAllowed = Boolean(
      decision.action === "rebuild" &&
      decision.existingSkill?.repairOrigin &&
      rebuildMeta?.level === "L2" &&
      !(existingProc?.graduatedFromRepairName ?? false),
    );

    if (rebuildMeta) {
      log.info("skill.rebuild.level", {
        policyId: decision.policy.id,
        skillId: decision.existingSkill!.id,
        level: rebuildMeta.level,
        incrementalCount: rebuildMeta.incrementalCount,
        evidencePoolAfterDedupe: evidence.poolAfterDedupe,
        incrementalPoolAfterDedupe: incremental.poolAfterDedupe,
        evidence_outcome_counts: evidence.outcomeCounts,
        evidence_pool_excluded_failure_count: evidence.excludedFailureCount,
      });
    } else if (decision.action === "crystallize") {
      log.info("skill.crystallize.evidence", {
        policyId: decision.policy.id,
        evidence_outcome_counts: evidence.outcomeCounts,
        evidence_pool_excluded_failure_count: evidence.excludedFailureCount,
      });
    }

    if (evidence.traces.length === 0) {
      warnings.push({ policyId: decision.policy.id, reason: "no-evidence" });
      bus.emit({
        kind: "skill.failed",
        at: nowMs(),
        policyId: decision.policy.id,
        stage: "evidence",
        reason: "no-evidence",
      });
      continue;
    }

    bus.emit({
      kind: "skill.crystallization.started",
      at: nowMs(),
      policyId: decision.policy.id,
      evidenceCount: evidence.traces.length,
    });

    // V7 §2.4.6 — gather negative evidence (V < 0) from the same
    // episodes so the crystallizer can write concrete `anti_pattern`
    // lines that contrast positive vs negative actions in the same
    // context. Empty when no negatives exist — that's fine; the
    // crystallizer still produces a valid skill, just without bonus
    // anti-pattern guidance derived from contrast.
    const counterExamples = gatherCounterExamples(decision.policy, { repos, config });

    const tCrystallize = nowMs();
    const crystResult = await runCrystallize(
      {
        policy: decision.policy,
        evidence: evidence.traces,
        counterExamples,
        skillsByPolicy,
        action: decision.action,
        existingSkill: decision.existingSkill,
        incremental: incremental.traces,
        rebuildLevel: rebuildMeta?.level,
        outputLanguage,
        renameAllowed,
      },
      deps,
    );
    timings.crystallize += nowMs() - tCrystallize;

    if (!crystResult.ok) {
      rejected += 1;
      warnings.push({
        policyId: decision.policy.id,
        reason: crystResult.skippedReason,
      });
      bus.emit({
        kind: "skill.failed",
        at: nowMs(),
        policyId: decision.policy.id,
        stage: "crystallize",
        reason: crystResult.skippedReason,
        modelRefusal: crystResult.modelRefusal,
      });
      continue;
    }

    let draft = crystResult.draft;
    if (decision.action === "rebuild" && decision.existingSkill && rebuildMeta) {
      draft = mergeRebuildDraft(draft, existingProc, {
        level: rebuildMeta.level,
        lockName: renameAllowed ? undefined : decision.existingSkill.name,
        changedSections: crystResult.changedSections,
      });
    }
    if (renameAllowed) {
      const existingNames = new Set(
        repos.skills.list({ limit: 500 }).map((s) => s.name),
      );
      existingNames.delete(decision.existingSkill!.name);
      draft.name = uniquifySkillName(
        normalizeSkillName(draft.name || decision.existingSkill!.name),
        existingNames,
      );
    }

    const tVerify = nowMs();
    const verdict = verifyDraft(
      { draft, evidence: evidence.traces.map((a) => a.trace) },
      { log: log.child({ channel: "core.skill.verifier" }) },
    );
    timings.verify += nowMs() - tVerify;

    if (!verdict.ok) {
      rejected += 1;
      warnings.push({
        policyId: decision.policy.id,
        reason: verdict.reason ?? "verify-failed",
      });
      bus.emit({
        kind: "skill.verification.failed",
        at: nowMs(),
        skillId: "sk_placeholder" as SkillId,
        reason: verdict.reason ?? "verify-failed",
      });
      continue;
    }

    const tPersist = nowMs();
    const evidenceUserTexts = evidence.traces
      .map((a) => a.trace.userText?.trim())
      .filter((q) => q.length > 0);

    const built = await buildSkillRow(
      {
        draft,
        policy: decision.policy,
        evidenceEpisodeIds: evidence.episodeIds,
        // V7 §2.1 — persist the L1 trace ids so the viewer can render
        // click-through "evidence" chips back to MemoriesView and
        // future audits / rebuilds don't have to re-mine evidence.
        evidenceTraceIds: evidence.traces.map((a) => a.trace.id),
        evidenceUserTexts,
        existing: decision.existingSkill,
        outputLanguage,
      },
      {
        embedder: deps.embedder,
        log: log.child({ channel: "core.skill.packager" }),
        config,
      },
    );
    // Candidate always — verifier ok is not enough to auto-promote.
    // Lifecycle transitions happen via feedback, never on insert.
    let row: SkillRow = { ...built.row, status: "candidate" };
    if (renameAllowed && row.procedureJson && typeof row.procedureJson === "object") {
      (row.procedureJson as { graduatedFromRepairName?: boolean }).graduatedFromRepairName = true;
    }

    // If rebuilding, start from the existing skill's trial counters but
    // reset η toward the recomputed value — existing practitioner skills
    // lose credibility when the underlying policy shifts materially.
    if (decision.action === "rebuild" && decision.existingSkill) {
      const recomputed = recomputeEta(decision.existingSkill, decision.policy, config);
      // Q4: a repair candidate that earned trust via real trials must not have
      // it wiped when a later positive feedback rebuilds it into a success-
      // backed skill — take the higher of earned vs. recomputed η. (The
      // rebuilt row drops `repairOrigin`, so it graduates on normal thresholds.)
      row.eta = decision.existingSkill.repairOrigin
        ? Math.max(recomputed, decision.existingSkill.eta)
        : recomputed;
    }

    if (decision.action === "crystallize") {
      const duplicate = findSemanticDuplicateSkill(row, repos);
      if (duplicate) {
        row = mergeSemanticDuplicateSkill(duplicate, row, config.evidenceLimit);
      }
    }

    repos.skills.upsert(row);
    if (!row.vec && deps.embedder) {
      repos.embeddingRetryQueue.enqueue({
        id: `er_${ids.span()}`,
        targetKind: "skill",
        targetId: row.id,
        vectorField: "vec",
        sourceText: built.vecSource || row.invocationGuide || row.name,
        now: nowMs(),
      });
      warnings.push({
        skillId: row.id,
        reason: "embedding retry queued for skill vector",
      });
    }
    timings.persist += nowMs() - tPersist;

    if (decision.action === "rebuild") rebuilt += 1;
    else crystallized += 1;

    bus.emit({
      kind: "skill.verification.passed",
      at: nowMs(),
      skillId: row.id,
      coverage: verdict.coverage,
    });
    bus.emit({
      kind: "skill.crystallized",
      at: nowMs(),
      skillId: row.id,
      name: row.name,
      policyId: decision.policy.id,
      status: row.status,
    });
    if (decision.action === "rebuild" && decision.existingSkill) {
      bus.emit({
        kind: "skill.rebuilt",
        at: nowMs(),
        skillId: row.id,
        policyId: decision.policy.id,
      });
    }
  }

  const completedAt = nowMs();
  log.info("skill.run.done", {
    trigger: input.trigger,
    evaluated,
    crystallized,
    rebuilt,
    rejected,
    warnings: warnings.length,
    timings,
  });

  return {
    trigger: input.trigger,
    evaluated,
    crystallized,
    rebuilt,
    rejected,
    startedAt,
    completedAt,
    warnings,
    timings,
  };
}

/**
 * Apply one feedback signal to an existing skill and emit the appropriate
 * events. Used by the subscriber on explicit user feedback and by the
 * orchestrator on trial outcomes.
 */
export function applySkillFeedback(
  skillId: SkillId,
  kind: SkillFeedbackKind,
  deps: RunSkillDeps,
  magnitude?: number,
): SkillRow | null {
  const skill = deps.repos.skills.getById(skillId);
  if (!skill) {
    deps.log.warn("skill.feedback.missing", { skillId, kind });
    return null;
  }
  const update = applyFeedback(skill, kind, deps.config, magnitude);
  const next: SkillRow = {
    ...skill,
    status: update.status,
    eta: update.eta,
    trialsAttempted: update.trialsAttempted,
    trialsPassed: update.trialsPassed,
    updatedAt: nowMs() as SkillRow["updatedAt"],
  };
  deps.repos.skills.upsert(next);

  deps.bus.emit({
    kind: "skill.eta.updated",
    at: nowMs(),
    skillId,
    previous: skill.eta,
    next: update.eta,
    trialsAttempted: update.trialsAttempted,
    trialsPassed: update.trialsPassed,
    reason: kind,
  });

  if (update.transition) {
    deps.bus.emit({
      kind: "skill.status.changed",
      at: nowMs(),
      skillId,
      previous: skill.status,
      next: update.status,
      transition: update.transition,
    });
    if (update.status === "archived") {
      deps.bus.emit({
        kind: "skill.archived",
        at: nowMs(),
        skillId,
        reason: kind === "reward.updated" ? "policy-rebuilt" : "eta-floor",
      });
    }
  }

  return next;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function gatherPolicies(input: RunSkillInput, repos: Repos): PolicyRow[] {
  if (input.policyId) {
    const single = repos.policies.getById(input.policyId);
    return single ? [single] : [];
  }
  return repos.policies.list({ status: "active", limit: 200 });
}

function buildSkillIndex(repos: Repos): Map<string, SkillRow> {
  const out = new Map<string, SkillRow>();
  const all = repos.skills.list({ limit: 500 });
  for (const s of all) {
    if (s.status === "archived") continue;
    for (const pid of s.sourcePolicyIds) {
      if (!out.has(pid)) out.set(pid, s);
    }
  }
  return out;
}

function findSemanticDuplicateSkill(
  incoming: SkillRow,
  repos: Repos,
): SkillRow | null {
  if (!incoming.vec) return null;
  const hits = repos.skills.searchByVector(incoming.vec, 20, {
    statusIn: ["candidate", "active"],
    hardCap: 500,
  });
  for (const hit of hits) {
    if (hit.score < SEMANTIC_DUPLICATE_SKILL_SIMILARITY) continue;
    const existing = repos.skills.getById(hit.id as SkillId);
    if (!existing || existing.id === incoming.id || existing.status === "archived") continue;
    if (isDeterministicSkillMatch(existing, incoming)) return existing;
  }
  return null;
}

function isDeterministicSkillMatch(existing: SkillRow, incoming: SkillRow): boolean {
  if ((existing.ownerAgentKind ?? "unknown") !== (incoming.ownerAgentKind ?? "unknown")) {
    return false;
  }
  if ((existing.ownerProfileId ?? "default") !== (incoming.ownerProfileId ?? "default")) {
    return false;
  }
  const existingProcedure = procedureFromSkillRow(existing.procedureJson);
  const incomingProcedure = procedureFromSkillRow(incoming.procedureJson);
  if (!existingProcedure || !incomingProcedure) return false;
  if (!sameOutputLanguage(existingProcedure, incomingProcedure)) return false;
  return sameTools(existingProcedure, incomingProcedure);
}

function sameOutputLanguage(a: SkillProcedure, b: SkillProcedure): boolean {
  if (!a.outputLanguage || !b.outputLanguage) return false;
  return a.outputLanguage === b.outputLanguage;
}

function sameTools(a: SkillProcedure, b: SkillProcedure): boolean {
  const left = normalizeToolSet(a.tools);
  const right = normalizeToolSet(b.tools);
  if (left.length !== right.length) return false;
  return left.every((tool, idx) => tool === right[idx]);
}

function normalizeToolSet(tools: readonly string[] | undefined): string[] {
  return Array.from(
    new Set((tools ?? []).map((tool) => tool.trim().toLowerCase()).filter(Boolean)),
  ).sort();
}

function mergeSemanticDuplicateSkill(
  existing: SkillRow,
  incoming: SkillRow,
  evidenceLimit: number,
): SkillRow {
  return {
    ...existing,
    support: Math.max(existing.support, incoming.support),
    gain: Math.max(existing.gain, incoming.gain),
    sourcePolicyIds: dedupeIds([...incoming.sourcePolicyIds, ...existing.sourcePolicyIds]),
    sourceWorldModelIds: dedupeIds([
      ...existing.sourceWorldModelIds,
      ...incoming.sourceWorldModelIds,
    ]),
    evidenceAnchors: dedupeIds([
      ...incoming.evidenceAnchors,
      ...existing.evidenceAnchors,
    ]).slice(0, Math.max(0, evidenceLimit)),
    vec: existing.vec ?? incoming.vec,
    updatedAt: incoming.updatedAt,
  };
}

function dedupeIds<T extends string>(ids: readonly T[]): T[] {
  return Array.from(new Set(ids));
}

interface RunCrystallizeArgs {
  policy: PolicyRow;
  evidence: AnnotatedTrace[];
  counterExamples: AnnotatedTrace[];
  skillsByPolicy: Map<string, SkillRow>;
  action: "crystallize" | "rebuild";
  existingSkill: SkillRow | null;
  incremental: AnnotatedTrace[];
  rebuildLevel?: RebuildLevel;
  outputLanguage: "zh" | "en";
  renameAllowed: boolean;
}

async function runCrystallize(
  args: RunCrystallizeArgs,
  deps: RunSkillDeps,
): Promise<CrystallizeResult> {
  const { policy, evidence, counterExamples, skillsByPolicy, action, existingSkill } =
    args;
  const namingSpace = Array.from(
    new Set(Array.from(skillsByPolicy.values()).map((s) => s.name)),
  );
  const triggerEpisodeId =
    policy.sourceEpisodeIds[policy.sourceEpisodeIds.length - 1] ??
    policy.sourceEpisodeIds[0];
  return crystallizeDraft(
    {
      policy,
      evidence,
      counterExamples,
      namingSpace,
      episodeId: triggerEpisodeId,
      mode: action === "rebuild" ? "rebuild" : "crystallize",
      existingSkill,
      incrementalEvidence: args.incremental,
      rebuildLevel: args.rebuildLevel,
      outputLanguage: args.outputLanguage,
      renameAllowed: args.renameAllowed,
    },
    {
      llm: deps.llm,
      log: deps.log.child({ channel: "core.skill.crystallize" }),
      config: deps.config,
      validate: defaultDraftValidator,
    },
  );
}
