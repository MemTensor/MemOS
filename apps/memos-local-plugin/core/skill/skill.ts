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
} from "../types.js";
import {
  crystallizeDraft,
  defaultDraftValidator,
  type CrystallizeResult,
} from "./crystallize.js";
import { evaluateEligibility } from "./eligibility.js";
import { gatherEvidence } from "./evidence.js";
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
} from "./types.js";
import { verifyDraft } from "./verifier.js";

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
    const counterExamples = gatherCounterExamples(decision.policy, repos);

    const tCrystallize = nowMs();
    const crystResult = await runCrystallize(
      decision.policy,
      evidence.traces,
      counterExamples,
      skillsByPolicy,
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

    const tVerify = nowMs();
    const verdict = verifyDraft(
      { draft: crystResult.draft, evidence: evidence.traces },
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
    const built = await buildSkillRow(
      {
        draft: crystResult.draft,
        policy: decision.policy,
        evidenceEpisodeIds: evidence.episodeIds,
        // V7 §2.1 — persist the L1 trace ids so the viewer can render
        // click-through "evidence" chips back to MemoriesView and
        // future audits / rebuilds don't have to re-mine evidence.
        evidenceTraceIds: evidence.traces.map((t) => t.id),
        existing: decision.existingSkill,
      },
      {
        embedder: deps.embedder,
        log: log.child({ channel: "core.skill.packager" }),
        config,
      },
    );
    // Candidate always — verifier ok is not enough to auto-promote.
    // Lifecycle transitions happen via feedback, never on insert.
    const row: SkillRow = { ...built.row, status: "candidate" };

    // If rebuilding, start from the existing skill's trial counters but
    // reset η toward the recomputed value — existing practitioner skills
    // lose credibility when the underlying policy shifts materially.
    if (decision.action === "rebuild" && decision.existingSkill) {
      row.eta = recomputeEta(decision.existingSkill, decision.policy, config);
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

async function runCrystallize(
  policy: PolicyRow,
  evidence: Parameters<typeof verifyDraft>[0]["evidence"],
  counterExamples: Parameters<typeof verifyDraft>[0]["evidence"],
  skillsByPolicy: Map<string, SkillRow>,
  deps: RunSkillDeps,
): Promise<CrystallizeResult> {
  const namingSpace = Array.from(
    new Set(Array.from(skillsByPolicy.values()).map((s) => s.name)),
  );
  return crystallizeDraft(
    { policy, evidence, counterExamples, namingSpace },
    {
      llm: deps.llm,
      log: deps.log.child({ channel: "core.skill.crystallize" }),
      config: deps.config,
      validate: defaultDraftValidator,
    },
  );
}

/**
 * Pull traces from the policy's source episodes that scored V < 0.
 * These are the failures the policy is supposed to prevent — perfect
 * raw material for `decision_guidance.anti_pattern`. We cap the count
 * at 5 (matching `evidenceLimit` order of magnitude) so the prompt
 * stays bounded.
 */
function gatherCounterExamples(
  policy: PolicyRow,
  repos: Repos,
): Parameters<typeof verifyDraft>[0]["evidence"] {
  if (policy.sourceEpisodeIds.length === 0) return [];
  const out: ReturnType<typeof repos.traces.list> = [];
  for (const episodeId of policy.sourceEpisodeIds) {
    const traces = repos.traces.list({ episodeId, limit: 20 });
    for (const t of traces) {
      if (Number.isFinite(t.value) && t.value < 0) out.push(t);
    }
  }
  // Lowest V first — the worst failures get spoken about loudest.
  out.sort((a, b) => a.value - b.value);
  return out.slice(0, 5);
}
