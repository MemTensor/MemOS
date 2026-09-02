/**
 * V7 §2.5.1 — Skill crystallization eligibility.
 *
 * A policy is eligible if **all** of:
 *   1. `policy.status === "active"` — archived / candidate policies never
 *      crystallize.
 *   2. `policy.gain >= minGain` — rewards have shown positive lift.
 *   3. `policy.support >= minSupport` — enough *distinct* episodes back it.
 *   4. Feedback-derived avoidance policies must have at least one success
 *      anchor before they can crystallize into a Skill.
 *   5. It is not already represented by a non-archived skill, OR the existing
 *      skill was built before the policy's latest `updatedAt` (→ rebuild).
 *   6. The per-policy crystallization back-off (issue #2319) has not been
 *      tripped. The check ignores stale state, so a fresh policy update
 *      (`policy.updatedAt > lastAttemptAt`) always lets a retry through.
 *
 * The check returns a structured verdict per policy so the orchestrator can
 * emit a single rollup event. We never mutate anything here — this module is
 * read-only on purpose to make it trivially unit-testable.
 */

import { now as nowMs } from "../time.js";
import type { PolicyRow, SkillRow } from "../types.js";
import type { SkillConfig } from "./types.js";

export interface EligibilityDecision {
  policy: PolicyRow;
  existingSkill: SkillRow | null;
  /** "crystallize" = fresh mint; "rebuild" = replace existing skill. */
  action: "crystallize" | "rebuild" | "skip";
  reason: string;
}

export interface EligibilityInput {
  policies: PolicyRow[];
  /**
   * Map from policyId → the latest skill (non-archived) citing it, if any.
   * Callers collect this via `skillsRepo.list()` once per run.
   */
  skillsByPolicy: Map<string, SkillRow>;
  /**
   * Wall-clock time used for back-off comparisons. Optional so existing
   * unit tests keep working — production callers thread the same
   * `nowMs()` they use elsewhere in `runSkill` for consistent timings.
   */
  now?: number;
}

export interface EligibilityResult {
  decisions: EligibilityDecision[];
  eligibleCount: number;
  skippedCount: number;
}

export function evaluateEligibility(
  input: EligibilityInput,
  config: SkillConfig,
): EligibilityResult {
  const decisions: EligibilityDecision[] = [];
  let eligibleCount = 0;
  let skippedCount = 0;
  const now = input.now ?? nowMs();

  for (const policy of input.policies) {
    const existing = input.skillsByPolicy.get(policy.id) ?? null;
    const decision = decide(policy, existing, config, now);
    decisions.push(decision);
    if (decision.action === "skip") skippedCount += 1;
    else eligibleCount += 1;
  }

  return { decisions, eligibleCount, skippedCount };
}

function decide(
  policy: PolicyRow,
  existing: SkillRow | null,
  cfg: SkillConfig,
  now: number,
): EligibilityDecision {
  // Back-off / quarantine gate — check first so a permanently-failing
  // policy is skipped before we spend cycles on the other gates. The
  // guard is skipped entirely when the state is "stale" (i.e., the
  // policy itself has been updated since we last tried it), because a
  // fresh update likely reflects new evidence and warrants a retry.
  const backoffSkip = evaluateBackoff(policy, cfg, now);
  if (backoffSkip !== null) {
    return {
      policy,
      existingSkill: existing,
      action: "skip",
      reason: backoffSkip,
    };
  }

  if (policy.status !== "active") {
    return {
      policy,
      existingSkill: existing,
      action: "skip",
      reason: `policy.status=${policy.status}`,
    };
  }
  if (policy.gain < cfg.minGain) {
    return {
      policy,
      existingSkill: existing,
      action: "skip",
      reason: `policy.gain=${fmt(policy.gain)}<${fmt(cfg.minGain)}`,
    };
  }
  if (policy.support < cfg.minSupport) {
    return {
      policy,
      existingSkill: existing,
      action: "skip",
      reason: `policy.support=${policy.support}<${cfg.minSupport}`,
    };
  }
  if (!hasSuccessAnchor(policy)) {
    return {
      policy,
      existingSkill: existing,
      action: "skip",
      reason: "policy has no success anchor",
    };
  }

  if (existing && existing.status !== "archived") {
    if (existing.updatedAt >= policy.updatedAt) {
      return {
        policy,
        existingSkill: existing,
        action: "skip",
        reason: `skill.updatedAt>=policy.updatedAt`,
      };
    }
    return {
      policy,
      existingSkill: existing,
      action: "rebuild",
      reason: `policy.updatedAt>skill.updatedAt`,
    };
  }

  return {
    policy,
    existingSkill: existing,
    action: "crystallize",
    reason: "policy satisfies minSupport + minGain + status",
  };
}

/**
 * Returns a skip reason string when the policy is currently blocked by
 * the crystallization back-off / quarantine gate, or `null` when there
 * is no active back-off (either it never failed, or the state is stale).
 */
function evaluateBackoff(
  policy: PolicyRow,
  cfg: SkillConfig,
  now: number,
): string | null {
  const bo = policy.crystallizationBackoff;
  if (!bo || bo.attempts <= 0) return null;

  // A policy update after the last attempt invalidates the back-off —
  // new evidence has arrived, retry immediately.
  if (bo.lastAttemptAt != null && policy.updatedAt > bo.lastAttemptAt) {
    return null;
  }

  if (bo.attempts >= cfg.crystallizationMaxAttempts) {
    const reason = bo.lastFailureReason ?? "unknown";
    return `crystallization-quarantined attempts=${bo.attempts} reason=${reason}`;
  }

  if (bo.backoffUntil != null && now < bo.backoffUntil) {
    return `crystallization-backoff attempts=${bo.attempts} until=${bo.backoffUntil}`;
  }

  return null;
}

function hasSuccessAnchor(policy: PolicyRow): boolean {
  if (policy.skillEligible === false) return false;
  const type = policy.experienceType ?? "success_pattern";
  if (type === "failure_avoidance" || type === "repair_instruction" || type === "preference") {
    return false;
  }
  const polarity = policy.evidencePolarity ?? "positive";
  return polarity === "positive" || polarity === "mixed";
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(3) : String(n);
}
