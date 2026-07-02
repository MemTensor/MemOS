/**
 * `core/feedback` — public entry point.
 *
 * Implements V7 §2.4.6 (Decision Repair) and §6.3 (just-in-time
 * guidance after N tool failures). This module has two external-facing
 * flows that share an orchestrator:
 *
 *   1. `attachFeedbackSubscriber({...}).recordToolFailure(...)` — the
 *      adapter hook called on every tool failure. When a burst is
 *      detected, a `DecisionRepairDraft` is synthesised and persisted.
 *   2. `attachFeedbackSubscriber({...}).submitUserFeedback(...)` — raw
 *      user text. Classified, and if the shape is negative / preference
 *      the orchestrator runs the same synthesise/persist/attach pipeline.
 *
 * The orchestrator is available directly via `runRepair` for callers
 * that want to bypass the subscriber (e.g. a CLI debug command).
 */

export { classifyFeedback } from "./classifier.js";
export { contextHashOf, createFailureSignals } from "./signals.js";
export { gatherRepairEvidence } from "./evidence.js";
export { synthesizeDraft } from "./synthesize.js";
export { attachRepairToPolicies, runRepair } from "./feedback.js";
export { createFeedbackEventBus } from "./events.js";
export { attachFeedbackSubscriber } from "./subscriber.js";

export type {
  ClassifiedFeedback,
  DecisionRepairDraft,
  FailureBurst,
  FailureRecord,
  FailureState,
  FeedbackConfig,
  FeedbackEvent,
  FeedbackEventBus,
  FeedbackEventKind,
  FeedbackEventListener,
  RepairInput,
  RepairResult,
  RepairTrigger,
  UserFeedbackShape,
} from "./types.js";

export type { EvidenceResult as RepairEvidenceResult } from "./evidence.js";

export type {
  SynthesizeInput,
  SynthesizeResult,
  SynthesizeDeps,
} from "./synthesize.js";

export type { RepairDeps } from "./feedback.js";

export type {
  FeedbackSubscriberDeps,
  FeedbackSubscriberHandle,
  RecordToolCallInput,
  SubmitUserFeedbackInput,
} from "./subscriber.js";
