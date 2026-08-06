/** Public entry for `core/capture`. */

export {
  createCaptureRunner,
  type CaptureDeps,
  type CaptureRunner,
} from "./capture.js";
export {
  attachCaptureSubscriber,
  type CaptureSubscription,
  type CaptureSubscriberOptions,
} from "./subscriber.js";
export { createCaptureEventBus } from "./events.js";
export { extractSteps } from "./step-extractor.js";
export { normalizeSteps } from "./normalizer.js";
export { extractReflection } from "./reflection-extractor.js";
export { synthesizeReflection } from "./reflection-synth.js";
export { scoreReflection, disabledScore } from "./alpha-scorer.js";
export {
  batchScoreReflections,
  type BatchScoreInput,
  type BatchScoreOptions,
  type BatchScoreResult,
  BATCH_OP_TAG as CAPTURE_BATCH_OP_TAG,
} from "./batch-scorer.js";
export { embedSteps } from "./embedder.js";
export type {
  CaptureConfig,
  CaptureEvent,
  CaptureEventBus,
  CaptureEventKind,
  CaptureEventListener,
  CaptureInput,
  CaptureResult,
  NormalizedStep,
  ReflectionScore,
  ScoredStep,
  StepCandidate,
  TraceCandidate,
} from "./types.js";
