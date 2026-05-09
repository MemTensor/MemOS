/**
 * Shared seeds + factories for the `core/feedback` unit + integration tests.
 *
 * Mirrors `tests/unit/skill/_helpers.ts` — every test that writes traces or
 * policies goes through these helpers so sessions/episodes are FK-safe and
 * timestamps are deterministic.
 */

import type {
  EmbeddingVector,
  EpisodeId,
  EpochMs,
  PolicyId,
  PolicyRow,
  SessionId,
  TraceId,
  TraceRow,
} from "../../../core/types.js";
import type { FeedbackConfig } from "../../../core/feedback/types.js";
import { ids as idHelpers } from "../../../core/id.js";
import type { TmpDbHandle } from "../../helpers/tmp-db.js";
import { ensureEpisode, ensureSession } from "../memory/l2/_helpers.js";

export const NOW = 1_700_000_000_000 as EpochMs;

export function vec(values: readonly number[]): EmbeddingVector {
  return new Float32Array(values) as unknown as EmbeddingVector;
}

export function makeFeedbackConfig(
  partial: Partial<FeedbackConfig> = {},
): FeedbackConfig {
  return {
    failureThreshold: 3,
    failureWindow: 5,
    valueDelta: 0.5,
    useLlm: true,
    attachToPolicy: true,
    cooldownMs: 60_000,
    traceCharCap: 500,
    evidenceLimit: 4,
    ...partial,
  };
}

// ─── Policies ─────────────────────────────────────────────────────────────

export interface SeedPolicyArgs {
  id?: PolicyId;
  title?: string;
  trigger?: string;
  procedure?: string;
  verification?: string;
  boundary?: string;
  status?: PolicyRow["status"];
  support?: number;
  gain?: number;
  sourceEpisodeIds?: readonly EpisodeId[];
  decisionGuidance?: { preference: string[]; antiPattern: string[] };
  vec?: EmbeddingVector | null;
  updatedAt?: EpochMs;
}

export function seedPolicy(
  handle: TmpDbHandle,
  args: SeedPolicyArgs = {},
): PolicyRow {
  const id = (args.id ?? (idHelpers.policy() as PolicyId)) as PolicyId;
  const now = args.updatedAt ?? NOW;
  const row: PolicyRow = {
    id,
    title: args.title ?? "retry-with-backoff",
    trigger: args.trigger ?? "tool fails transient",
    procedure: args.procedure ?? "1. detect\n2. wait 1s\n3. retry",
    verification: args.verification ?? "tool succeeds",
    boundary: args.boundary ?? "",
    support: args.support ?? 3,
    gain: args.gain ?? 0.3,
    status: args.status ?? "active",
    sourceEpisodeIds: [...(args.sourceEpisodeIds ?? [])],
    inducedBy: "l2.l2.induction.v1",
    decisionGuidance: args.decisionGuidance ?? { preference: [], antiPattern: [] },
    vec: args.vec ?? vec([1, 0, 0]),
    createdAt: now,
    updatedAt: now,
  };
  handle.repos.policies.insert(row);
  return row;
}

// ─── Traces ────────────────────────────────────────────────────────────────

export interface SeedTraceArgs {
  id?: string;
  episodeId: string;
  sessionId?: string;
  userText?: string;
  agentText?: string;
  reflection?: string | null;
  value?: number;
  tags?: string[];
  vec?: EmbeddingVector | null;
  toolCalls?: TraceRow["toolCalls"];
}

export function seedTrace(handle: TmpDbHandle, args: SeedTraceArgs): TraceRow {
  const sessionId = args.sessionId ?? "s_feedback";
  ensureEpisode(handle, args.episodeId, sessionId);
  const row: TraceRow = {
    id: (args.id ?? idHelpers.trace()) as TraceId,
    episodeId: args.episodeId as EpisodeId,
    sessionId: sessionId as SessionId,
    ts: NOW,
    userText: args.userText ?? "",
    agentText: args.agentText ?? "",
    toolCalls: args.toolCalls ?? [],
    reflection: args.reflection ?? null,
    value: args.value ?? 0.7,
    alpha: 0.6 as TraceRow["alpha"],
    rHuman: null,
    priority: 0,
    tags: args.tags ?? [],
    vecSummary: args.vec ?? vec([1, 0, 0]),
    vecAction: null,
    turnId: NOW,
    schemaVersion: 1,
  };
  handle.repos.traces.insert(row);
  return row;
}

export function seedSessionOnly(handle: TmpDbHandle, id: string): void {
  ensureSession(handle, id);
}
