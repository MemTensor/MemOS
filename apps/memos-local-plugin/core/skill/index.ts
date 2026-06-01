/**
 * `core/skill` public entry point.
 *
 * The Skill module owns V7 §2.5's crystallization + lifecycle. See
 * `README.md` for a tour and `ALGORITHMS.md` for the math.
 */

export {
  crystallizeDraft,
  defaultDraftValidator,
  type CrystallizeDeps,
  type CrystallizeInput,
  type CrystallizeResult,
} from "./crystallize.js";
export {
  evaluateEligibility,
  type EligibilityDecision,
  type EligibilityInput,
  type EligibilityResult,
} from "./eligibility.js";
export {
  gatherCounterExamples,
  gatherEvidence,
  gatherIncrementalEvidence,
  type EvidenceDeps,
  type EvidenceResult,
  type IncrementalEvidenceResult,
} from "./evidence.js";
export {
  computeRebuildLevel,
  policyContentHash,
  type RebuildLevel,
} from "./rebuild-level.js";
export { mergeRebuildDraft, procedureFromSkillRow } from "./merge.js";
export { resolveSkillOutputLanguage, type SkillOutputLanguage } from "./language.js";
export { normalizeSkillName, deriveNameFromText, uniquifySkillName } from "./name.js";
export {
  applyFeedback,
  recomputeEta,
  shouldArchiveIdle,
  type LifecycleUpdate,
} from "./lifecycle.js";
export {
  buildSkillRow,
  type PackagerDeps,
  type PackagerInput,
  type PackagerResult,
} from "./packager.js";
export {
  applySkillFeedback,
  runSkill,
  type RunSkillDeps,
} from "./skill.js";
export {
  isRepairCandidatePolicy,
  deriveStrictTrial,
  mintRepairCandidate,
  REPAIR_CANDIDATE_INITIAL_ETA,
  type MintRepairCandidateDeps,
} from "./repair-candidate.js";
export { attachSkillSubscriber, type SkillSubscriberDeps, type SkillSubscriberHandle } from "./subscriber.js";
export { createSkillEventBus } from "./events.js";
export { extractToolNames } from "./tool-names.js";
export {
  verifyDraft,
  type VerifyDeps,
  type VerifyInput,
  type VerifyResult,
} from "./verifier.js";
export type {
  RunSkillInput,
  RunSkillResult,
  SkillConfig,
  SkillCrystallizationDraft,
  SkillEvent,
  SkillEventBus,
  SkillEventKind,
  SkillEventListener,
  SkillExampleDraft,
  SkillFeedbackKind,
  SkillFeedbackSignal,
  SkillLifecycleTransition,
  SkillParameterDraft,
  SkillProcedure,
  SkillStepDraft,
  SkillTrigger,
  SkillCandidate,
} from "./types.js";
