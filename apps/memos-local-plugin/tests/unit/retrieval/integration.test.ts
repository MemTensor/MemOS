import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createRetrievalEventBus,
  repairRetrieve,
  subAgentRetrieve,
  skillInvokeRetrieve,
  toolDrivenRetrieve,
  turnStartRetrieve,
  type RetrievalDeps,
  type RetrievalEmbedder,
} from "../../../core/retrieval/index.js";
import type {
  EmbeddingVector,
  EpisodeId,
  SessionId,
  SkillId,
  TraceId,
  WorldModelId,
} from "../../../core/types.js";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";

const NOW = 1_700_000_000_000;

function vec(arr: number[]): EmbeddingVector {
  return Float32Array.from(arr) as unknown as EmbeddingVector;
}

/** Fake embedder returns a constant query vector so we can assert determinism. */
const fakeEmbedder: RetrievalEmbedder = {
  embed: async () => vec([1, 0, 0]),
};

function seed(handle: TmpDbHandle) {
  handle.repos.sessions.upsert({
    id: "s1" as SessionId,
    agent: "openclaw",
    startedAt: NOW,
    lastSeenAt: NOW,
    meta: {},
  });
  handle.repos.episodes.upsert({
    id: "ep1" as EpisodeId,
    sessionId: "s1" as SessionId,
    startedAt: NOW as never,
    endedAt: null,
    traceIds: [],
    rTask: null,
    status: "open",
  });

  // Two traces on the query axis [1,0,0]; one off-axis.
  const insertTrace = (id: string, value: number, priority: number, v: number[], tags: string[]) => {
    handle.repos.traces.insert({
      id: id as TraceId,
      episodeId: "ep1" as EpisodeId,
      sessionId: "s1" as SessionId,
      ts: NOW as never,
      userText: `user text ${id}`,
      agentText: `agent text ${id}`,
      toolCalls: [],
      reflection: `${id}-ref`,
      value: value as never,
      alpha: 0.5 as never,
      rHuman: null,
      priority: priority as never,
      tags,
      vecSummary: vec(v),
      vecAction: null,
      turnId: 0 as never,
      schemaVersion: 1,
    });
  };
  insertTrace("t_hi", 0.9, 0.9, [1, 0, 0], ["docker"]);
  insertTrace("t_med", 0.3, 0.3, [0.9, 0.1, 0], ["docker"]);
  insertTrace("t_off", 0.5, 0.5, [0, 1, 0], ["pip"]);

  handle.repos.skills.upsert({
    id: "sk_docker" as SkillId,
    name: "run-docker-compose",
    status: "active",
    invocationGuide: "docker compose up -d",
    procedureJson: null,
    eta: 0.85,
    support: 3,
    gain: 0.6,
    trialsAttempted: 5,
    trialsPassed: 4,
    sourcePolicyIds: [],
    sourceWorldModelIds: [],
    evidenceAnchors: [],
    vec: vec([1, 0, 0]),
    createdAt: NOW as never,
    updatedAt: NOW as never,
    version: 1,
  });
  handle.repos.skills.upsert({
    id: "sk_weak" as SkillId,
    name: "weak-skill",
    status: "active",
    invocationGuide: "nope",
    procedureJson: null,
    eta: 0.1, // below minSkillEta
    support: 1,
    gain: 0,
    trialsAttempted: 1,
    trialsPassed: 0,
    sourcePolicyIds: [],
    sourceWorldModelIds: [],
    evidenceAnchors: [],
    vec: vec([1, 0, 0]),
    createdAt: NOW as never,
    updatedAt: NOW as never,
    version: 1,
  });

  handle.repos.worldModel.upsert({
    id: "wm_docker" as WorldModelId,
    title: "docker-compose model",
    body: "containers talk via compose network",
    structure: { environment: [], inference: [], constraints: [] },
    domainTags: [],
    confidence: 0.9,
    policyIds: [],
    sourceEpisodeIds: [],
    inducedBy: "",
    vec: vec([1, 0, 0]),
    createdAt: NOW as never,
    updatedAt: NOW as never,
    status: "active",
  });
}

function makeDeps(handle: TmpDbHandle): RetrievalDeps {
  return {
    repos: {
      skills: handle.repos.skills,
      traces: handle.repos.traces,
      worldModel: handle.repos.worldModel,
    },
    embedder: fakeEmbedder,
    config: {
      tier1TopK: 2,
      tier2TopK: 3,
      tier3TopK: 1,
      candidatePoolFactor: 4,
      weightCosine: 0.6,
      weightPriority: 0.4,
      mmrLambda: 0.7,
      includeLowValue: false,
      rrfConstant: 60,
      minSkillEta: 0.5,
      minTraceSim: 0.3,
      tagFilter: "auto",
      decayHalfLifeDays: 30,
      llmFilterEnabled: false,
      llmFilterMaxKeep: 4,
      llmFilterMinCandidates: 1,
    },
    now: () => NOW as never,
  };
}

describe("retrieval/integration", () => {
  let handle: TmpDbHandle;
  beforeEach(() => {
    handle = makeTmpDb({ agent: "openclaw" });
    seed(handle);
  });
  afterEach(() => handle.cleanup());

  it("turn_start returns snippets across tiers + emits events", async () => {
    const bus = createRetrievalEventBus();
    const events: string[] = [];
    bus.on((e) => events.push(e.kind));

    const res = await turnStartRetrieve(
      makeDeps(handle),
      {
        reason: "turn_start",
        agent: "openclaw",
        sessionId: "s1" as SessionId,
        userText: "run docker compose",
        ts: NOW as never,
      },
      { events: bus },
    );

    expect(res.packet.snippets.length).toBeGreaterThan(0);
    expect(res.stats.tier1Count).toBeGreaterThanOrEqual(1);
    expect(res.stats.tier2Count).toBeGreaterThanOrEqual(1);
    expect(res.stats.tier3Count).toBeGreaterThanOrEqual(1);
    expect(events).toEqual(["retrieval.started", "retrieval.done"]);

    // Expect the weak skill to be filtered out.
    const skillIds = res.packet.snippets
      .filter((s) => s.refKind === "skill")
      .map((s) => String(s.refId));
    expect(skillIds).toContain("sk_docker");
    expect(skillIds).not.toContain("sk_weak");
  });

  it("tool_driven skips tier1 (no skill snippets)", async () => {
    const res = await toolDrivenRetrieve(makeDeps(handle), {
      reason: "tool_driven",
      agent: "openclaw",
      sessionId: "s1" as SessionId,
      tool: "memory_search",
      args: { query: "docker compose" },
      ts: NOW as never,
    });
    expect(res.stats.tier1Count).toBe(0);
    expect(res.packet.snippets.every((s) => s.refKind !== "skill")).toBe(true);
  });

  it("skill_invoke is tier1-heavy", async () => {
    const res = await skillInvokeRetrieve(makeDeps(handle), {
      reason: "skill_invoke",
      agent: "openclaw",
      sessionId: "s1" as SessionId,
      skillId: "sk_docker" as SkillId,
      query: "run docker compose up",
      ts: NOW as never,
    });
    const skillSnippets = res.packet.snippets.filter((s) => s.refKind === "skill");
    expect(skillSnippets.length).toBeGreaterThanOrEqual(1);
  });

  it("sub_agent skips tier1", async () => {
    const res = await subAgentRetrieve(makeDeps(handle), {
      reason: "sub_agent",
      agent: "openclaw",
      sessionId: "s1" as SessionId,
      mission: "docker plan",
      profile: "planner",
      ts: NOW as never,
    });
    expect(res.stats.tier1Count).toBe(0);
  });

  it("decision_repair with failureCount=0 returns null", async () => {
    const res = await repairRetrieve(makeDeps(handle), {
      reason: "decision_repair",
      agent: "openclaw",
      sessionId: "s1" as SessionId,
      failingTool: "docker.run",
      failureCount: 0,
      ts: NOW as never,
    });
    expect(res).toBeNull();
  });

  it("decision_repair includes low-value traces", async () => {
    // Add a zero-priority anti-pattern.
    handle.repos.traces.insert({
      id: "anti" as TraceId,
      episodeId: "ep1" as EpisodeId,
      sessionId: "s1" as SessionId,
      ts: NOW as never,
      userText: "bad docker cmd",
      agentText: "this fails every time",
      toolCalls: [],
      reflection: "don't do this",
      value: -0.8 as never,
      alpha: 0.8 as never,
      rHuman: null,
      priority: 0 as never,
      tags: ["docker"],
      vecSummary: vec([1, 0, 0]),
      vecAction: null,
      turnId: 0 as never,
      schemaVersion: 1,
    });

    const res = await repairRetrieve(makeDeps(handle), {
      reason: "decision_repair",
      agent: "openclaw",
      sessionId: "s1" as SessionId,
      failingTool: "docker.run",
      failureCount: 3,
      lastErrorCode: "NETWORK_REFUSED",
      ts: NOW as never,
    });
    expect(res).not.toBeNull();
    expect(res!.packet.snippets.length).toBeGreaterThan(0);
  });

  it("emits retrieval.failed on embedder error (degraded, not thrown)", async () => {
    const deps: RetrievalDeps = {
      ...makeDeps(handle),
      embedder: {
        embed: async () => {
          throw new Error("boom");
        },
      },
    };
    const bus = createRetrievalEventBus();
    const kinds: string[] = [];
    bus.on((e) => kinds.push(e.kind));
    const res = await turnStartRetrieve(
      deps,
      {
        reason: "turn_start",
        agent: "openclaw",
        sessionId: "s1" as SessionId,
        userText: "anything",
        ts: NOW as never,
      },
      { events: bus },
    );
    // Graceful degradation: empty packet + started + done, not a throw.
    expect(res.packet.snippets.length).toBe(0);
    expect(res.stats.emptyPacket).toBe(true);
    expect(res.stats.embedding).toMatchObject({
      attempted: true,
      ok: false,
      degraded: true,
      errorMessage: "boom",
    });
    expect(kinds).toEqual(["retrieval.started", "retrieval.done"]);
  });

  it("does not call the query embedder for blank turn-start text", async () => {
    let calls = 0;
    const deps: RetrievalDeps = {
      ...makeDeps(handle),
      embedder: {
        embed: async () => {
          calls++;
          throw new Error("should not be called");
        },
      },
    };

    const res = await turnStartRetrieve(deps, {
      reason: "turn_start",
      agent: "openclaw",
      sessionId: "s1" as SessionId,
      userText: "   ",
      ts: NOW as never,
    });

    expect(calls).toBe(0);
    expect(res.stats.embedding).toMatchObject({
      attempted: false,
      ok: false,
      degraded: false,
    });
  });
});
