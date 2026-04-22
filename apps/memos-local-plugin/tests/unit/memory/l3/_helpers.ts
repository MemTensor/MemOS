/**
 * Seed helpers + type shortcuts for L3 unit + integration tests.
 *
 * L3 runs over `policies` + `traces` + `world_model`, all of which are
 * FK-linked back to `sessions` / `episodes`. These helpers keep every
 * test quick to read and consistent in how they seed the graph.
 */

import type { EmbeddingVector } from "../../../../core/types.js";
import { ids as idHelpers } from "../../../../core/id.js";
import type {
  EpisodeId,
  EpochMs,
  PolicyId,
  PolicyRow,
  SessionId,
  TraceId,
  TraceRow,
  WorldModelId,
  WorldModelRow,
  WorldModelStructure,
} from "../../../../core/types.js";
import type { TmpDbHandle } from "../../../helpers/tmp-db.js";
import {
  ensureEpisode,
  ensureSession,
} from "../l2/_helpers.js";

export const NOW = 1_700_000_000_000 as EpochMs;

export function vec(values: readonly number[]): EmbeddingVector {
  return new Float32Array(values) as unknown as EmbeddingVector;
}

// ─── Seed — session + episode + policy + trace ─────────────────────────────

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
  vec?: EmbeddingVector | null;
}

export function seedPolicy(handle: TmpDbHandle, args: SeedPolicyArgs = {}): PolicyRow {
  const id = (args.id ?? (idHelpers.policy() as PolicyId)) as PolicyId;
  const now = NOW;
  const row: PolicyRow = {
    id,
    title: args.title ?? "install system libs first",
    trigger: args.trigger ?? "pip install fails for compiled wheels in Alpine",
    procedure: args.procedure ?? "1. detect missing lib; 2. apk add; 3. retry pip",
    verification: args.verification ?? "pip install succeeds without errors",
    boundary: args.boundary ?? "alpine / musl based images",
    support: args.support ?? 3,
    gain: args.gain ?? 0.3,
    status: args.status ?? "active",
    sourceEpisodeIds: [...(args.sourceEpisodeIds ?? [])],
    inducedBy: "l2.l2.induction.v1",
    vec: args.vec ?? vec([1, 0, 0]),
    createdAt: now,
    updatedAt: now,
  };
  handle.repos.policies.insert(row);
  return row;
}

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
}

export function seedTrace(handle: TmpDbHandle, args: SeedTraceArgs): TraceRow {
  const sessionId = args.sessionId ?? "s_l3";
  ensureEpisode(handle, args.episodeId, sessionId);
  const row: TraceRow = {
    id: (args.id ?? idHelpers.trace()) as TraceId,
    episodeId: args.episodeId as EpisodeId,
    sessionId: sessionId as SessionId,
    ts: NOW,
    userText: args.userText ?? "",
    agentText: args.agentText ?? "",
    toolCalls: [],
    reflection: args.reflection ?? null,
    value: args.value ?? 0.7,
    alpha: 0.6 as TraceRow["alpha"],
    rHuman: null,
    priority: 0,
    tags: args.tags ?? [],
    vecSummary: args.vec ?? vec([1, 0, 0]),
    vecAction: null,
    schemaVersion: 1,
  };
  handle.repos.traces.insert(row);
  return row;
}

export function seedSessionOnly(handle: TmpDbHandle, id: string): void {
  ensureSession(handle, id);
}

// ─── Seed — existing world model ───────────────────────────────────────────

export interface SeedWorldModelArgs {
  id?: WorldModelId;
  title?: string;
  body?: string;
  domainTags?: string[];
  confidence?: number;
  policyIds?: readonly PolicyId[];
  sourceEpisodeIds?: readonly EpisodeId[];
  vec?: EmbeddingVector | null;
  structure?: WorldModelStructure;
}

export function seedWorldModel(
  handle: TmpDbHandle,
  args: SeedWorldModelArgs = {},
): WorldModelRow {
  const id = (args.id ?? ("wm_seed" as WorldModelId)) as WorldModelId;
  const row: WorldModelRow = {
    id,
    title: args.title ?? "alpine python dependency model",
    body: args.body ?? "# summary\nstuff",
    structure: args.structure ?? {
      environment: [],
      inference: [],
      constraints: [],
    },
    domainTags: args.domainTags ?? ["alpine", "python"],
    confidence: args.confidence ?? 0.5,
    policyIds: [...(args.policyIds ?? [])],
    sourceEpisodeIds: [...(args.sourceEpisodeIds ?? [])],
    inducedBy: "l3.abstraction.v1",
    vec: args.vec ?? vec([1, 0, 0]),
    createdAt: NOW,
    updatedAt: NOW,
    status: "active",
  };
  handle.repos.worldModel.upsert(row);
  return row;
}
