/**
 * V7 §2.5.1 — Skill crystallization eligibility.
 *
 * A policy is eligible if **all** of:
 *   1. `policy.status === "active"` — archived / candidate policies never
 *      crystallize.
 *   2. `policy.gain >= minGain` — rewards have shown positive lift.
 *   3. `policy.support >= minSupport` — enough *distinct* episodes back it.
 *   4. It is not already represented by a non-archived skill, OR the existing
 *      skill was built before the policy's latest `updatedAt` (→ rebuild).
 *
 * The check returns a structured verdict per policy so the orchestrator can
 * emit a single rollup event. We never mutate anything here — this module is
 * read-only on purpose to make it trivially unit-testable.
 */

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

  for (const policy of input.policies) {
    const existing = input.skillsByPolicy.get(policy.id) ?? null;
    const decision = decide(policy, existing, config);
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
): EligibilityDecision {
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

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(3) : String(n);
}
