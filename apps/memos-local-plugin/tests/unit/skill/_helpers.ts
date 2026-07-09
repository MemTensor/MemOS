/**
 * Shared seeds for the `core/skill` unit + integration suites.
 *
 * Mirrors `tests/unit/memory/l3/_helpers.ts` — you seed sessions + episodes
 * via the L2 helpers, then layer policies, traces, skills on top.
 */

import type {
  EmbeddingVector,
  EpisodeId,
  EpochMs,
  PolicyId,
  PolicyRow,
  SessionId,
  SkillId,
  SkillRow,
  TraceId,
  TraceRow,
} from "../../../core/types.js";
import type { SkillConfig, SkillCrystallizationDraft } from "../../../core/skill/types.js";
import { ids as idHelpers } from "../../../core/id.js";
import type { TmpDbHandle } from "../../helpers/tmp-db.js";
import { ensureEpisode, ensureSession } from "../memory/l2/_helpers.js";

export const NOW = 1_700_000_000_000 as EpochMs;

export function vec(values: readonly number[]): EmbeddingVector {
  return new Float32Array(values) as unknown as EmbeddingVector;
}

export function makeSkillConfig(partial: Partial<SkillConfig> = {}): SkillConfig {
  return {
    minSupport: 2,
    minGain: 0.1,
    candidateTrials: 3,
    cooldownMs: 0,
    traceCharCap: 300,
    evidenceLimit: 4,
    useLlm: true,
    etaDelta: 0.1,
    archiveEta: 0.1,
    minEtaForRetrieval: 0.1,
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
  vec?: EmbeddingVector | null;
  updatedAt?: EpochMs;
}

export function seedPolicy(handle: TmpDbHandle, args: SeedPolicyArgs = {}): PolicyRow {
  const id = (args.id ?? (idHelpers.policy() as PolicyId)) as PolicyId;
  const now = args.updatedAt ?? NOW;
  const row: PolicyRow = {
    id,
    title: args.title ?? "install-system-libs-before-pip",
    trigger: args.trigger ?? "pip install errors in alpine images",
    procedure:
      args.procedure ??
      "1. detect missing lib\n2. apk add openssl-dev\n3. retry pip install",
    verification: args.verification ?? "pip install succeeds",
    boundary: args.boundary ?? "alpine musl",
    support: args.support ?? 3,
    gain: args.gain ?? 0.3,
    status: args.status ?? "active",
    sourceEpisodeIds: [...(args.sourceEpisodeIds ?? [])],
    inducedBy: "l2.l2.induction.v1",
    decisionGuidance: { preference: [], antiPattern: [] },
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
  const sessionId = args.sessionId ?? "s_skill";
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

// ─── Skills ────────────────────────────────────────────────────────────────

export interface SeedSkillArgs {
  id?: SkillId;
  name?: string;
  status?: SkillRow["status"];
  eta?: number;
  support?: number;
  gain?: number;
  trialsAttempted?: number;
  trialsPassed?: number;
  sourcePolicyIds?: readonly PolicyId[];
  invocationGuide?: string;
  updatedAt?: EpochMs;
  vec?: EmbeddingVector | null;
}

export function seedSkill(handle: TmpDbHandle, args: SeedSkillArgs = {}): SkillRow {
  const row: SkillRow = {
    id: (args.id ?? (idHelpers.skill() as SkillId)) as SkillId,
    name: args.name ?? "alpine_pip_system_libs",
    status: args.status ?? "candidate",
    invocationGuide: args.invocationGuide ?? "# placeholder",
    procedureJson: null,
    eta: args.eta ?? 0.5,
    support: args.support ?? 3,
    gain: args.gain ?? 0.3,
    trialsAttempted: args.trialsAttempted ?? 0,
    trialsPassed: args.trialsPassed ?? 0,
    sourcePolicyIds: [...(args.sourcePolicyIds ?? [])],
    sourceWorldModelIds: [],
    evidenceAnchors: [],
    vec: args.vec ?? vec([1, 0, 0]),
    createdAt: (args.updatedAt ?? NOW) as SkillRow["createdAt"],
    updatedAt: (args.updatedAt ?? NOW) as SkillRow["updatedAt"],
    version: 1,
  };
  handle.repos.skills.upsert(row);
  return row;
}

// ─── Draft factory ─────────────────────────────────────────────────────────

export function makeDraft(
  overrides: Partial<SkillCrystallizationDraft> = {},
): SkillCrystallizationDraft {
  return {
    name: "alpine_pip_system_libs",
    displayTitle: "Alpine pip install with system deps",
    summary: "Ensure system libs exist before pip install on alpine.",
    parameters: [
      { name: "package", type: "string", required: true, description: "pip package to install" },
    ],
    preconditions: ["container is alpine-based"],
    steps: [
      { title: "detect missing lib", body: "inspect the pip error for missing .so names" },
      { title: "apk add", body: "apk add openssl-dev libffi-dev" },
      { title: "retry", body: "retry pip install" },
    ],
    examples: [
      { input: "pip install cryptography", expected: "cryptography installs without errors" },
    ],
    tags: ["pip", "alpine"],
    decisionGuidance: { preference: [], antiPattern: [] },
    tools: [],
    ...overrides,
  };
}
