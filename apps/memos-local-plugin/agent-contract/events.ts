/**
 * Exhaustive list of core event types. Every observable thing the algorithm
 * does emits one of these. Adding or renaming a literal is a versioned change
 * (see ARCHITECTURE.md §8) — also update docs/EVENTS.md in the same commit.
 */

export const CORE_EVENTS = [
  // ─── Sessions / Episodes ───
  "session.opened",
  "session.closed",
  "episode.opened",
  "episode.closed",

  // ─── L1 traces ───
  "trace.created",
  "trace.value_updated",
  "trace.priority_decayed",

  // ─── L2 policies ───
  "l2.candidate_added",
  "l2.candidate_expired",
  "l2.associated",
  "l2.induced",
  "l2.revised",
  "l2.boundary_shrunk",

  // ─── L3 world models ───
  "l3.abstracted",
  "l3.revised",

  // ─── Feedback ───
  "feedback.received",
  "feedback.classified",
  "reward.computed",

  // ─── Skills ───
  "skill.crystallized",
  "skill.eta_updated",
  "skill.boundary_updated",
  "skill.archived",
  "skill.repaired",

  // ─── Decision repair ───
  "decision_repair.generated",
  "decision_repair.validated",

  // ─── Retrieval ───
  "retrieval.triggered",
  "retrieval.tier1.hit",
  "retrieval.tier2.hit",
  "retrieval.tier3.hit",
  "retrieval.empty",

  // ─── Hub (team sharing) ───
  "hub.client_connected",
  "hub.client_disconnected",
  "hub.share_published",
  "hub.share_received",

  // ─── System ───
  "system.started",
  "system.shutdown",
  "system.error",
  "system.config_changed",
  "system.update_available",
] as const;

export type CoreEventType = (typeof CORE_EVENTS)[number];

export function isCoreEventType(s: string): s is CoreEventType {
  return (CORE_EVENTS as readonly string[]).includes(s);
}

/**
 * Generic event envelope. Every emitted event has the same shape so SSE
 * clients can parse uniformly without dispatching on `type` first.
 */
export interface CoreEvent<T = unknown> {
  /** Stable event type (one of `CORE_EVENTS`). */
  type: CoreEventType;
  /** Millisecond UTC epoch when the event was created. */
  ts: number;
  /** Monotonically increasing per-process sequence number (for ordering). */
  seq: number;
  /** Optional correlation id (e.g. traceId / sessionId) for stitching. */
  correlationId?: string;
  /** Event-specific payload. Strongly typed in `docs/EVENTS.md`. */
  payload: T;
}
