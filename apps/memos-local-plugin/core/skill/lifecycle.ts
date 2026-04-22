/**
 * V7 §2.5.4 — Skill lifecycle.
 *
 * A skill moves through three visible states: `candidate`, `active`,
 * `archived`. Transitions are driven by:
 *
 *   - **Trials**: `trialsAttempted` grows on every `trial.pass` / `trial.fail`
 *     feedback signal. Once `trialsAttempted >= candidateTrials` we check
 *     the success ratio + η and promote to `active` or bounce back.
 *   - **Reward**: `reward.updated` on the source policy bubbles into
 *     `recomputeEta`, which re-seeds η from the policy's updated gain.
 *   - **User thumbs**: direct `user.positive` / `user.negative` signals
 *     adjust η by `etaDelta`.
 *
 * Everything here is pure over a `SkillRow`. The orchestrator calls these
 * helpers inside a `tx` so updates are atomic and auditable.
 */

import type { PolicyRow, SkillRow } from "../types.js";
import type {
  SkillConfig,
  SkillFeedbackKind,
  SkillLifecycleTransition,
} from "./types.js";

export interface LifecycleUpdate {
  status: SkillRow["status"];
  eta: number;
  trialsAttempted: number;
  trialsPassed: number;
  transition?: SkillLifecycleTransition;
}

/**
 * Apply one feedback signal to a skill. Returns the post-update state.
 */
export function applyFeedback(
  skill: SkillRow,
  kind: SkillFeedbackKind,
  cfg: SkillConfig,
  magnitude?: number,
): LifecycleUpdate {
  switch (kind) {
    case "trial.pass":
      return applyTrial(skill, true, cfg);
    case "trial.fail":
      return applyTrial(skill, false, cfg);
    case "user.positive":
      return applyThumbs(skill, +1, cfg, magnitude);
    case "user.negative":
      return applyThumbs(skill, -1, cfg, magnitude);
    case "reward.updated":
      return applyRewardDrift(skill, cfg, magnitude ?? 0);
    default:
      return snapshot(skill);
  }
}

function applyTrial(
  skill: SkillRow,
  passed: boolean,
  cfg: SkillConfig,
): LifecycleUpdate {
  const trialsAttempted = skill.trialsAttempted + 1;
  const trialsPassed = skill.trialsPassed + (passed ? 1 : 0);
  // Beta posterior: mean = (α + passed) / (α + β + attempted)
  //   α = β = 1 (uniform prior)
  const eta = clamp01((trialsPassed + 1) / (trialsAttempted + 2));
  let status: SkillRow["status"] = skill.status;
  let transition: SkillLifecycleTransition | undefined;

  if (status === "candidate" && trialsAttempted >= cfg.candidateTrials) {
    if (eta >= cfg.minEtaForRetrieval) {
      status = "active";
      transition = "promoted";
    } else {
      status = "archived";
      transition = "archived";
    }
  }

  if (status === "active" && eta < cfg.archiveEta) {
    status = "archived";
    transition = "archived";
  }

  return { status, eta, trialsAttempted, trialsPassed, transition };
}

function applyThumbs(
  skill: SkillRow,
  sign: 1 | -1,
  cfg: SkillConfig,
  magnitudeOverride: number | undefined,
): LifecycleUpdate {
  const delta = (magnitudeOverride ?? cfg.etaDelta) * sign;
  const eta = clamp01(skill.eta + delta);
  let status = skill.status;
  let transition: SkillLifecycleTransition | undefined;

  if (skill.status === "archived" && eta >= cfg.minEtaForRetrieval) {
    status = "candidate";
    transition = "promoted";
  } else if (skill.status !== "archived" && eta < cfg.archiveEta) {
    status = "archived";
    transition = "archived";
  }

  return {
    status,
    eta,
    trialsAttempted: skill.trialsAttempted,
    trialsPassed: skill.trialsPassed,
    transition,
  };
}

function applyRewardDrift(
  skill: SkillRow,
  cfg: SkillConfig,
  magnitude: number,
): LifecycleUpdate {
  const bounded = clamp01(magnitude);
  // Blend eta with the new policy gain (70% old, 30% new). This avoids
  // whiplash on a single noisy reward update.
  const eta = clamp01(0.7 * skill.eta + 0.3 * bounded);
  let status = skill.status;
  let transition: SkillLifecycleTransition | undefined;
  if (skill.status !== "archived" && eta < cfg.archiveEta) {
    status = "archived";
    transition = "demoted";
  }
  return {
    status,
    eta,
    trialsAttempted: skill.trialsAttempted,
    trialsPassed: skill.trialsPassed,
    transition,
  };
}

function snapshot(skill: SkillRow): LifecycleUpdate {
  return {
    status: skill.status,
    eta: skill.eta,
    trialsAttempted: skill.trialsAttempted,
    trialsPassed: skill.trialsPassed,
  };
}

/**
 * Recompute the η a freshly-built skill should carry given its source
 * policy's latest gain + support. Used when we detect policy drift large
 * enough to rebuild a skill.
 */
export function recomputeEta(
  skill: SkillRow,
  policy: PolicyRow,
  cfg: SkillConfig,
): number {
  if (skill.trialsAttempted > 0) return clamp01(skill.eta);
  const baseline = clamp01(policy.gain);
  return clamp01(Math.max(cfg.minEtaForRetrieval, baseline));
}

/**
 * Decide if a skill has decayed enough to archive without any new
 * evidence (e.g. it has been inactive with a low-eta source policy).
 * Used by the orchestrator's periodic `lifecycle.tick`.
 */
export function shouldArchiveIdle(
  skill: SkillRow,
  idleMs: number,
  cfg: SkillConfig,
  now: number,
): boolean {
  if (skill.status !== "active") return false;
  const age = now - skill.updatedAt;
  if (age < idleMs) return false;
  return skill.eta < cfg.minEtaForRetrieval;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
