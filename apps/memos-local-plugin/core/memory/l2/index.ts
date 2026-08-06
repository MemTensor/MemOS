/**
 * Public API for `core/memory/l2` — cross-task L2 policy induction &
 * association (V7 §2.4.1 + §2.4.5).
 *
 * Keep this surface minimal:
 *   - the orchestrator (`runL2`),
 *   - the subscriber bridge from the reward pipeline,
 *   - the event bus factory,
 *   - the types callers actually consume.
 *
 * Internal helpers (signature hashing, similarity math) stay module-private.
 */

export { runL2, type RunL2Deps } from "./l2.js";
export {
  attachL2Subscriber,
  type L2SubscriberDeps,
  type L2SubscriberHandle,
} from "./subscriber.js";
export { createL2EventBus } from "./events.js";
export { signatureOf, parseSignature, componentsOf, bucketKeyOf } from "./signature.js";
export {
  tracePolicySimilarity,
  valueWeightedMean,
  arithmeticMeanValue,
  centroid,
} from "./similarity.js";
export { induceDraft, buildPolicyRow, type InduceInput, type InduceDeps } from "./induce.js";
export { computeGain, nextStatus, applyGain, partition } from "./gain.js";
export { makeCandidatePool, candidateIdFor, signatureHash } from "./candidate-pool.js";
export type {
  AssociationResult,
  InductionResult,
  InductionDraft,
  InductionDraftResult,
  GainResult,
  GainInput,
  L2Config,
  L2Event,
  L2EventBus,
  L2EventKind,
  L2EventListener,
  L2ProcessInput,
  L2ProcessResult,
  PatternSignature,
  SignatureComponents,
} from "./types.js";
