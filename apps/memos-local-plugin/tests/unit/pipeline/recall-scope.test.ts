/**
 * Regression for cross-session transcript injection (MemOS#1532).
 *
 * A trace is a verbatim transcript (`[user] … / [assistant] …`). Injecting
 * another Session's trace at turn start makes the agent adopt that
 * conversation as its own history. Only the *automatic turn-start injection*
 * path is confined here; explicit searches, decision-repair and sub-agent
 * retrieval deliberately keep looking across history.
 *
 * Everything runs against a real temporary SQLite database through the real
 * `wrapRetrievalRepos`. No spy-of-arguments, no empty-database assertions and
 * no tautological predicates: every test asserts on rows that were actually
 * seeded and returned.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createMemoryCore,
  createPipeline,
  type PipelineDeps,
  type PipelineHandle,
} from "../../../core/pipeline/index.js";
import { wrapRetrievalRepos } from "../../../core/pipeline/retrieval-repos.js";
import { DEFAULT_CONFIG } from "../../../core/config/defaults.js";
import { resolveHome } from "../../../core/config/paths.js";
import { rootLogger } from "../../../core/logger/index.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";
import type { Embedder } from "../../../core/embedding/types.js";
import type {
  EmbeddingVector,
  EpisodeId,
  PolicyId,
  RuntimeNamespace,
  SessionId,
  TraceId,
  TraceRow,
  WorldModelId,
} from "../../../core/types.js";

const NOW = 1_700_000_000_000;
const PROFILE_ID = "main";
const NS: RuntimeNamespace = { agentKind: "openclaw", profileId: PROFILE_ID };
const PINNED_NS: RuntimeNamespace = { ...NS, sessionKey: "session-a" };

const SESSION_A = "session-a" as SessionId;
const SESSION_B = "session-b" as SessionId;
const EPISODE_A = "episode-a" as EpisodeId;
const EPISODE_B = "episode-b" as EpisodeId;
const TRACE_A = "trace-a" as TraceId;
const TRACE_B = "trace-b" as TraceId;
const TRACE_FOREIGN = "trace-foreign-profile" as TraceId;
const WORLD_MODEL_ID = "wm-from-b" as WorldModelId;
const POLICY_ID = "po-from-b" as PolicyId;

const KEYWORD = "recallscopemarker";
const ERROR_SIG = "ERR-RECALLSCOPE-42";
const DIMS = 384;

/** One shared unit vector: every seeded row and every query matches. */
const VEC = (() => {
  const v = new Float32Array(DIMS);
  v[0] = 1;
  return v as EmbeddingVector;
})();

/** Deterministic embedder so end-to-end vector retrieval actually hits. */
function fixedEmbedder(): Embedder {
  const stats = {
    hits: 0, misses: 0, requests: 0, roundTrips: 0, failures: 0,
    lastOkAt: null, lastError: null,
  };
  return {
    embedOne: async () => VEC,
    embedMany: async (texts: readonly string[]) => texts.map(() => VEC),
    stats: () => stats,
  } as unknown as Embedder;
}

/** Full-width vector: the storage layer rejects mismatched dimensions. */
function vec(first = 1, second = 0): EmbeddingVector {
  const v = new Float32Array(DIMS);
  v[0] = first;
  v[1] = second;
  return v as EmbeddingVector;
}

function traceRow(args: {
  id: TraceId;
  sessionId: SessionId;
  episodeId: EpisodeId;
  userText: string;
  vecSummary: EmbeddingVector;
  ownerProfileId?: string;
  ts?: number;
}): TraceRow {
  return {
    id: args.id,
    episodeId: args.episodeId,
    sessionId: args.sessionId,
    ownerAgentKind: "openclaw",
    ownerProfileId: args.ownerProfileId ?? PROFILE_ID,
    ownerWorkspaceId: null,
    ts: args.ts ?? NOW,
    userText: args.userText,
    agentText: "reply",
    summary: null,
    share: null,
    toolCalls: [],
    agentThinking: null,
    reflection: null,
    value: 0.8,
    alpha: 0.5,
    rHuman: null,
    priority: 0.8,
    tags: [],
    errorSignatures: [ERROR_SIG],
    vecSummary: args.vecSummary,
    vecAction: null,
    turnId: NOW,
    schemaVersion: 1,
  } as TraceRow;
}

/** Two Sessions under the SAME profile — the exact shape of the bug. */
function seed(repos: TmpDbHandle["repos"]): void {
  for (const [sessionId, episodeId] of [
    [SESSION_A, EPISODE_A],
    [SESSION_B, EPISODE_B],
  ] as const) {
    repos.sessions.upsert({
      id: sessionId,
      agent: "openclaw",
      ownerAgentKind: "openclaw",
      ownerProfileId: PROFILE_ID,
      ownerWorkspaceId: null,
      startedAt: NOW,
      lastSeenAt: NOW,
      meta: {},
    });
    repos.episodes.upsert({
      id: episodeId,
      sessionId,
      ownerAgentKind: "openclaw",
      ownerProfileId: PROFILE_ID,
      ownerWorkspaceId: null,
      startedAt: NOW,
      endedAt: null,
      traceIds: [],
      rTask: null,
      status: "open",
    });
  }

  // session-b's vector is deliberately closer, so a post-filter would let it
  // consume the whole Top-K budget and starve session-a (see the k=1 test).
  repos.traces.insert(traceRow({
    id: TRACE_A, sessionId: SESSION_A, episodeId: EPISODE_A,
    userText: `${KEYWORD} discussed in session a with ${ERROR_SIG}`,
    vecSummary: vec(0.9, 0.1),
  }));
  repos.traces.insert(traceRow({
    id: TRACE_B, sessionId: SESSION_B, episodeId: EPISODE_B,
    userText: `${KEYWORD} discussed in session b with ${ERROR_SIG}`,
    vecSummary: vec(1, 0),
  }));
  // A row from a different profile: `getManyByIds` must still reject it.
  repos.traces.insert(traceRow({
    id: TRACE_FOREIGN, sessionId: SESSION_A, episodeId: EPISODE_A,
    userText: `${KEYWORD} private to another profile`,
    vecSummary: vec(1, 0),
    ownerProfileId: "other-profile",
  }));

  // L2 / L3 are statement-shaped facts and must remain shareable even though
  // they were distilled from the OTHER session's episode.
  repos.worldModel.upsert({
    id: WORLD_MODEL_ID,
    ownerAgentKind: "openclaw",
    ownerProfileId: PROFILE_ID,
    ownerWorkspaceId: null,
    title: "l3-shared fact",
    body: "l3-shared fact distilled from the other session",
    structure: { environment: [], inference: [], constraints: [] },
    domainTags: ["l3-shared"],
    confidence: 0.9,
    policyIds: [],
    sourceEpisodeIds: [EPISODE_B],
    inducedBy: "unit",
    vec: vec(1, 0),
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    status: "active",
  });
  repos.policies.insert({
    id: POLICY_ID,
    ownerAgentKind: "openclaw",
    ownerProfileId: PROFILE_ID,
    ownerWorkspaceId: null,
    title: "l2-shared policy",
    trigger: "when the shared fact is needed",
    procedure: "reuse the distilled fact",
    verification: "the fact is reused",
    boundary: "unit tests only",
    support: 1,
    gain: 0.7,
    status: "active",
    sourceEpisodeIds: [EPISODE_B],
    inducedBy: "unit",
    decisionGuidance: { preference: [], antiPattern: [] },
    vec: vec(1, 0),
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function pipelineDeps(
  h: TmpDbHandle,
  recallScope: "session" | "profile",
  lightweight = true,
): PipelineDeps {
  return {
    agent: "openclaw",
    home: resolveHome("openclaw", "/tmp/memos-recall-scope-test"),
    config: {
      ...DEFAULT_CONFIG,
      algorithm: {
        ...DEFAULT_CONFIG.algorithm,
        lightweightMemory: {
          ...DEFAULT_CONFIG.algorithm.lightweightMemory,
          enabled: lightweight,
        },
        retrieval: { ...DEFAULT_CONFIG.algorithm.retrieval, recallScope },
      },
    },
    db: h.db,
    repos: h.repos,
    llm: null,
    reflectLlm: null,
    l3Llm: null,
    embedder: fixedEmbedder(),
    log: rootLogger.child({ channel: "test.recall-scope" }),
    namespace: PINNED_NS,
    now: () => NOW,
  };
}

describe("pipeline/recall-scope", () => {
  let handle: TmpDbHandle | null = null;
  let pipeline: PipelineHandle | null = null;

  beforeEach(() => {
    handle = makeTmpDb();
    seed(handle.repos);
  });

  afterEach(async () => {
    if (pipeline) {
      try { await pipeline.shutdown("test.cleanup"); } catch { /* best effort */ }
      pipeline = null;
    }
    handle?.cleanup();
    handle = null;
  });

  it("confines every trace search channel to the calling Session", () => {
    const scoped = wrapRetrievalRepos(handle!.repos, PINNED_NS, {
      recallScope: "session",
    });

    expect(scoped.traces.searchByVector(VEC, 10).map((h) => h.id)).toEqual([TRACE_A]);
    // `RetrievalRepos` marks the text channels optional; the concrete wrapper
    // always provides them, so the assertion below is safe.
    expect(scoped.traces.searchByText!("recallscopemarker", 10).map((h) => h.id)).toEqual([TRACE_A]);
    expect(scoped.traces.searchByPattern!(["recallscopemarker"], 10).map((h) => h.id)).toEqual([TRACE_A]);
    expect(
      scoped.traces.searchByErrorSignature([ERROR_SIG], 10).map((h) => h.id),
    ).toEqual([TRACE_A]);
  });

  it("pins inside SQL so the foreign row cannot consume the k=1 budget", () => {
    const scoped = wrapRetrievalRepos(handle!.repos, PINNED_NS, {
      recallScope: "session",
    });
    // Baseline: without the pin, the better-scored session-b wins the only slot.
    const open = wrapRetrievalRepos(handle!.repos, PINNED_NS);
    expect(open.traces.searchByVector(vec(1, 0), 1).map((h) => h.id)).toEqual([TRACE_B]);
    expect(scoped.traces.searchByVector(vec(1, 0), 1).map((h) => h.id)).toEqual([TRACE_A]);
  });

  it("restores cross-session recall for scope=profile", () => {
    const open = wrapRetrievalRepos(handle!.repos, PINNED_NS, {
      recallScope: "profile",
    });
    const ids = open.traces.searchByVector(VEC, 10).map((h) => h.id);
    expect(ids).toContain(TRACE_A);
    expect(ids).toContain(TRACE_B);
  });

  it("fails open when the namespace carries no sessionKey", () => {
    const scoped = wrapRetrievalRepos(handle!.repos, NS, {
      recallScope: "session",
    });
    const ids = scoped.traces.searchByVector(VEC, 10).map((h) => h.id);
    expect(ids).toContain(TRACE_A);
    expect(ids).toContain(TRACE_B);
  });

  it("keeps the namespace boundary on getManyByIds without a session pin", () => {
    const scoped = wrapRetrievalRepos(handle!.repos, PINNED_NS, {
      recallScope: "session",
    });
    const ids = scoped.traces.getManyByIds([TRACE_A, TRACE_B, TRACE_FOREIGN])
      .map((r) => r.id);
    // Both same-profile Sessions' rows survive (L2/L3 evidence support), but a
    // row from another profile is still rejected.
    expect(ids).toContain(TRACE_A);
    expect(ids).toContain(TRACE_B);
    expect(ids).not.toContain(TRACE_FOREIGN);
  });

  it("leaves L2 policies and L3 world models unconfined", () => {
    const scoped = wrapRetrievalRepos(handle!.repos, PINNED_NS, {
      recallScope: "session",
    });
    expect(scoped.worldModel.getById(WORLD_MODEL_ID)?.id).toBe(WORLD_MODEL_ID);
    expect(scoped.policies!.getById(POLICY_ID)?.id).toBe(POLICY_ID);
  });

  it("confines the real turn-start injection path", async () => {
    pipeline = createPipeline(pipelineDeps(handle!, "session"));
    const core = createMemoryCore(
      pipeline,
      resolveHome("openclaw", "/tmp/memos-recall-scope-test"),
      "test",
    );
    await core.init();

    const result = await core.onTurnStart({
      agent: "openclaw",
      sessionId: "session-a",
      userText: KEYWORD,
      ts: NOW,
    });
    const injected = String(result.injectedContext ?? "");
    expect(injected).toContain("session a");
    expect(injected).not.toContain("session b");
  });

  it("does NOT pin explicit searches (decision-repair / memos_search stay cross-session)", async () => {
    pipeline = createPipeline(pipelineDeps(handle!, "session"));
    const core = createMemoryCore(
      pipeline,
      resolveHome("openclaw", "/tmp/memos-recall-scope-test"),
      "test",
    );
    await core.init();

    const result = await core.searchMemory({
      agent: "openclaw",
      query: KEYWORD,
      topK: { tier1: 0, tier2: 5, tier3: 0 },
    });
    const body = result.hits.map((hit) => hit.snippet).join("\n");
    expect(body).toContain("session a");
    expect(body).toContain("session b");
  });

  it("does not cancel the pin with the legacy same-session exclusion", async () => {
    // With lightweight memory off, `retrieve.ts` passes
    // `excludeSessionId = <calling session>`, which emits
    // `session_id != X`. AND-ed with the pin that is `session_id = X AND
    // session_id != X` — always empty. tier-2 must drop the exclusion when
    // pinned, or this test comes back with no context at all.
    pipeline = createPipeline(pipelineDeps(handle!, "session", false));
    const core = createMemoryCore(
      pipeline,
      resolveHome("openclaw", "/tmp/memos-recall-scope-test"),
      "test",
    );
    await core.init();

    const result = await core.onTurnStart({
      agent: "openclaw",
      sessionId: "session-a",
      userText: KEYWORD,
      ts: NOW,
    });
    const injected = String(result.injectedContext ?? "");
    expect(injected).toContain("session a");
    expect(injected).not.toContain("session b");
  });
});

