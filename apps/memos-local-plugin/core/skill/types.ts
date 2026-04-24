/**
 * Internal DTOs for the Skill crystallizer.
 *
 * Public surface is exported through `index.ts`; these types live here so the
 * module's subparts (eligibility, evidence, crystallize, lifecycle…) can pull
 * them without creating a cycle.
 */

import type {
  EpisodeId,
  PolicyRow,
  SkillId,
  SkillRow,
  TraceRow,
} from "../types.js";

/**
 * Parameters describing one argument of a skill, produced by the
 * `SKILL_CRYSTALLIZE_PROMPT`.
 */
export interface SkillParameterDraft {
  name: string;
  type: "string" | "number" | "boolean" | "enum";
  required: boolean;
  description: string;
  enumValues?: string[];
}

/**
 * One procedure step. Stored inside `SkillRow.procedureJson.steps`.
 */
export interface SkillStepDraft {
  title: string;
  body: string;
}

/**
 * One example of how to invoke the skill.
 */
export interface SkillExampleDraft {
  input: string;
  expected: string;
}

/**
 * Full shape serialised into `SkillRow.procedureJson`. Structured so the
 * viewer can render every field without re-parsing the invocation guide.
 */
export interface SkillProcedure {
  summary: string;
  parameters: SkillParameterDraft[];
  preconditions: string[];
  steps: SkillStepDraft[];
  examples: SkillExampleDraft[];
  decisionGuidance: { preference: string[]; antiPattern: string[] };
  tags: string[];
}

/**
 * Crystallization draft produced by the LLM + normaliser. Ready to be
 * converted into a `SkillRow` via `packager.buildSkillRow`.
 */
export interface SkillCrystallizationDraft {
  name: string;
  displayTitle: string;
  summary: string;
  parameters: SkillParameterDraft[];
  preconditions: string[];
  steps: SkillStepDraft[];
  examples: SkillExampleDraft[];
  tags: string[];
}

/**
 * Config slice the skill module reads from `algorithm.skill.*`.
 */
export interface SkillConfig {
  minSupport: number;
  minGain: number;
  /**
   * Number of trials a skill must accumulate while in `candidate`
   * status before it can graduate to `active` (or be archived for
   * insufficient η). Previously named `probationaryTrials`.
   */
  candidateTrials: number;
  /**
   * Cooldown (ms) before a skill that failed verification is retried. Keeps
   * the LLM from burning tokens on a borderline policy every reward-update.
   */
  cooldownMs: number;
  /**
   * Max chars of each trace included in the crystallize prompt.
   */
  traceCharCap: number;
  /**
   * Max number of evidence traces fed to the LLM per skill.
   */
  evidenceLimit: number;
  /**
   * When true, call `skill.crystallize`. When false, collect eligibility
   * events but never call the LLM (cost-sensitive mode).
   */
  useLlm: boolean;
  /** η delta applied per positive/negative user feedback (capped [0, 1]). */
  etaDelta: number;
  /** Archive active skills whose η falls below this. */
  archiveEta: number;
  /** Below this η, skills never surface in Tier-1 — matches retrieval config. */
  minEtaForRetrieval: number;
}

/**
 * Wrapper around a policy selected for crystallization.
 */
export interface SkillCandidate {
  policy: PolicyRow;
  /** Supporting traces (already sorted by V desc). */
  evidence: TraceRow[];
  /** Distinct episodes covered by `evidence`. */
  episodeIds: EpisodeId[];
  existingSkill: SkillRow | null;
  reasonSkipped?: string;
}

/**
 * Event emitted when a skill transitions through its lifecycle.
 */
export type SkillLifecycleTransition =
  | "crystallized"
  | "verified"
  | "rejected"
  | "promoted"
  | "demoted"
  | "archived"
  | "rebuilt";

/**
 * Kind of user / runtime signal that drives an η update.
 */
export type SkillFeedbackKind =
  | "trial.pass"
  | "trial.fail"
  | "user.positive"
  | "user.negative"
  | "reward.updated";

export interface SkillFeedbackSignal {
  skillId: SkillId;
  kind: SkillFeedbackKind;
  /** Optional magnitude override (defaults to `etaDelta` for user feedback). */
  magnitude?: number;
  ts: number;
}

// ─── Events ───────────────────────────────────────────────────────────────

export type SkillEventKind =
  | "skill.eligibility.checked"
  | "skill.crystallization.started"
  | "skill.crystallized"
  | "skill.verification.passed"
  | "skill.verification.failed"
  | "skill.status.changed"
  | "skill.eta.updated"
  | "skill.archived"
  | "skill.rebuilt"
  | "skill.failed";

export interface SkillEventBase<K extends SkillEventKind> {
  kind: K;
  at: number;
}

export interface SkillEligibilityCheckedEvent
  extends SkillEventBase<"skill.eligibility.checked"> {
  totalPolicies: number;
  eligible: number;
  skipped: Array<{ policyId: string; reason: string }>;
}

export interface SkillCrystallizationStartedEvent
  extends SkillEventBase<"skill.crystallization.started"> {
  policyId: string;
  evidenceCount: number;
}

export interface SkillCrystallizedEvent
  extends SkillEventBase<"skill.crystallized"> {
  skillId: SkillId;
  name: string;
  policyId: string;
  status: SkillRow["status"];
}

export interface SkillVerificationPassedEvent
  extends SkillEventBase<"skill.verification.passed"> {
  skillId: SkillId;
  coverage: number;
}

export interface SkillVerificationFailedEvent
  extends SkillEventBase<"skill.verification.failed"> {
  skillId: SkillId;
  reason: string;
}

export interface SkillStatusChangedEvent
  extends SkillEventBase<"skill.status.changed"> {
  skillId: SkillId;
  previous: SkillRow["status"];
  next: SkillRow["status"];
  transition: SkillLifecycleTransition;
}

export interface SkillEtaUpdatedEvent
  extends SkillEventBase<"skill.eta.updated"> {
  skillId: SkillId;
  previous: number;
  next: number;
  trialsAttempted: number;
  trialsPassed: number;
  reason: SkillFeedbackKind | "bulk";
}

export interface SkillArchivedEvent extends SkillEventBase<"skill.archived"> {
  skillId: SkillId;
  reason: "eta-floor" | "manual" | "policy-rebuilt";
}

export interface SkillRebuiltEvent extends SkillEventBase<"skill.rebuilt"> {
  skillId: SkillId;
  policyId: string;
}

export interface SkillFailedEvent extends SkillEventBase<"skill.failed"> {
  policyId?: string;
  skillId?: SkillId;
  stage: "eligibility" | "evidence" | "crystallize" | "verify" | "persist";
  reason: string;
}

export type SkillEvent =
  | SkillEligibilityCheckedEvent
  | SkillCrystallizationStartedEvent
  | SkillCrystallizedEvent
  | SkillVerificationPassedEvent
  | SkillVerificationFailedEvent
  | SkillStatusChangedEvent
  | SkillEtaUpdatedEvent
  | SkillArchivedEvent
  | SkillRebuiltEvent
  | SkillFailedEvent;

export type SkillEventListener = (event: SkillEvent) => void;

export interface SkillEventBus {
  on(kind: SkillEventKind, listener: SkillEventListener): () => void;
  onAny(listener: SkillEventListener): () => void;
  emit(evt: SkillEvent): void;
  listenerCount(kind?: SkillEventKind): number;
}

// ─── Orchestrator input/output ────────────────────────────────────────────

export type SkillTrigger =
  | "l2.policy.induced"
  | "l2.policy.status_changed"
  | "reward.updated"
  | "manual"
  | "rebuild"
  | "lifecycle.tick";

export interface RunSkillInput {
  trigger: SkillTrigger;
  /** Restrict run to a single policy id when set. */
  policyId?: string;
  /** Restrict run to a single skill id (for rebuild / verify flows). */
  skillId?: SkillId;
}

export interface RunSkillResult {
  trigger: SkillTrigger;
  evaluated: number;
  crystallized: number;
  rebuilt: number;
  rejected: number;
  startedAt: number;
  completedAt: number;
  warnings: Array<{ policyId?: string; skillId?: SkillId; reason: string }>;
  timings: { eligibility: number; crystallize: number; verify: number; persist: number };
}
