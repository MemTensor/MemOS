import { describe, expect, it } from "vitest";

import { makeTmpDb } from "../../helpers/tmp-db.js";

function vec(arr: number[]): Float32Array {
  return new Float32Array(arr);
}

describe("storage/repos — happy paths", () => {
  it("sessions: upsert / touch / list", () => {
    const { repos, cleanup } = makeTmpDb();
    try {
      repos.sessions.upsert({
        id: "s1",
        agent: "openclaw",
        startedAt: 1,
        lastSeenAt: 1,
        meta: {},
      });
      repos.sessions.touch("s1", 42, { hostPid: 123 });
      const got = repos.sessions.getById("s1")!;
      expect(got.lastSeenAt).toBe(42);
      expect(got.meta).toEqual({ hostPid: 123 });

      const recent = repos.sessions.listRecent(10);
      expect(recent.map((s) => s.id)).toEqual(["s1"]);
    } finally {
      cleanup();
    }
  });

  it("episodes: open → append trace → close", () => {
    const { repos, cleanup } = makeTmpDb();
    try {
      repos.sessions.upsert({
        id: "s",
        agent: "openclaw",
        startedAt: 0,
        lastSeenAt: 0,
        meta: {},
      });
      repos.episodes.insert({
        id: "e1",
        sessionId: "s",
        startedAt: 1,
        endedAt: null,
        traceIds: [],
        rTask: null,
        status: "open",
      });

      expect(repos.episodes.getOpenForSession("s")!.id).toBe("e1");

      repos.episodes.appendTrace("e1", ["t1", "t2"]);
      expect(repos.episodes.getById("e1")!.traceIds).toEqual(["t1", "t2"]);

      repos.episodes.close("e1", 99, 0.8);
      const closed = repos.episodes.getById("e1")!;
      expect(closed.status).toBe("closed");
      expect(closed.endedAt).toBe(99);
      expect(closed.rTask).toBeCloseTo(0.8);
      expect(repos.episodes.getOpenForSession("s")).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("traces: insert, list with filter, bulk fetch, updateScore", () => {
    const { repos, cleanup } = makeTmpDb();
    try {
      repos.sessions.upsert({
        id: "s",
        agent: "openclaw",
        startedAt: 0,
        lastSeenAt: 0,
        meta: {},
      });
      repos.episodes.insert({
        id: "e",
        sessionId: "s",
        startedAt: 0,
        endedAt: null,
        traceIds: [],
        rTask: null,
        status: "open",
      });

      for (let i = 0; i < 3; i++) {
        repos.traces.insert({
          id: `t${i}`,
          episodeId: "e",
          sessionId: "s",
          ts: 10 * (i + 1),
          userText: `u${i}`,
          agentText: `a${i}`,
          toolCalls: [],
          reflection: null,
          value: i === 0 ? -0.9 : 0.5,
          alpha: 0.3,
          rHuman: null,
          priority: 0.1 * i,
          tags: [],
          vecSummary: vec([i, 0]),
          vecAction: null,
          schemaVersion: 1,
        });
      }

      const all = repos.traces.list({ sessionId: "s" });
      expect(all.length).toBe(3);
      expect(all[0]!.ts).toBeGreaterThan(all[1]!.ts); // newest first by default

      const highAbs = repos.traces.list({ minAbsValue: 0.8 });
      expect(highAbs.map((t) => t.id)).toEqual(["t0"]);

      const bulk = repos.traces.getManyByIds(["t0", "t2", "missing"]);
      expect(bulk.map((t) => t.id).sort()).toEqual(["t0", "t2"]);

      repos.traces.updateScore("t0", { value: -0.5, alpha: 0.6, priority: 1.5 });
      expect(repos.traces.getById("t0")!.value).toBe(-0.5);
      expect(repos.traces.getById("t0")!.priority).toBe(1.5);
    } finally {
      cleanup();
    }
  });

  it("policies: upsert + stats + vector filter by status", () => {
    const { repos, cleanup } = makeTmpDb();
    try {
      repos.policies.upsert({
        id: "p_cand",
        title: "cand",
        trigger: "",
        procedure: "",
        verification: "",
        boundary: "",
        support: 1,
        gain: 0,
        status: "candidate",
        sourceEpisodeIds: [],
        inducedBy: "proto",
        vec: vec([1, 0]),
        createdAt: 1,
        updatedAt: 1,
      });
      repos.policies.upsert({
        id: "p_active",
        title: "active",
        trigger: "",
        procedure: "",
        verification: "",
        boundary: "",
        support: 5,
        gain: 0.4,
        status: "active",
        sourceEpisodeIds: [],
        inducedBy: "proto",
        vec: vec([1, 0]),
        createdAt: 1,
        updatedAt: 1,
      });

      repos.policies.updateStats("p_cand", {
        support: 3,
        gain: 0.2,
        status: "candidate",
        updatedAt: 2,
      });
      expect(repos.policies.getById("p_cand")!.support).toBe(3);

      const active = repos.policies.list({ status: "active" });
      expect(active.map((p) => p.id)).toEqual(["p_active"]);

      const hits = repos.policies.searchByVector(vec([1, 0]), 5, {
        statusIn: ["active"],
      });
      expect(hits.map((h) => h.id)).toEqual(["p_active"]);
    } finally {
      cleanup();
    }
  });

  it("skills: insert + bumpTrial + unique name constraint", () => {
    const { repos, cleanup } = makeTmpDb();
    try {
      repos.skills.insert({
        id: "sk1",
        name: "retry-shell-with-sudo",
        status: "candidate",
        invocationGuide: "…",
        procedureJson: null,
        eta: 0,
        support: 1,
        gain: 0.1,
        trialsAttempted: 0,
        trialsPassed: 0,
        sourcePolicyIds: [],
        sourceWorldModelIds: [],
        vec: vec([1, 0]),
        createdAt: 1,
        updatedAt: 1,
      });

      expect(() =>
        repos.skills.insert({
          id: "sk2",
          name: "retry-shell-with-sudo", // same name
          status: "candidate",
          invocationGuide: "",
          procedureJson: null,
          eta: 0,
          support: 0,
          gain: 0,
          trialsAttempted: 0,
          trialsPassed: 0,
          sourcePolicyIds: [],
          sourceWorldModelIds: [],
          vec: null,
          createdAt: 1,
          updatedAt: 1,
        }),
      ).toThrow(/UNIQUE/i);

      const after = repos.skills.bumpTrial("sk1", true, 2);
      expect(after).toEqual({ trialsAttempted: 1, trialsPassed: 1, eta: 1 });
      const after2 = repos.skills.bumpTrial("sk1", false, 3);
      expect(after2.eta).toBeCloseTo(0.5);
    } finally {
      cleanup();
    }
  });

  it("feedback: insert, scoped list, polarity filter", () => {
    const { repos, cleanup } = makeTmpDb();
    try {
      repos.sessions.upsert({
        id: "s",
        agent: "openclaw",
        startedAt: 0,
        lastSeenAt: 0,
        meta: {},
      });
      repos.episodes.insert({
        id: "e",
        sessionId: "s",
        startedAt: 0,
        endedAt: null,
        traceIds: [],
        rTask: null,
        status: "open",
      });

      repos.feedback.insert({
        id: "f1",
        ts: 10,
        episodeId: "e",
        traceId: null,
        channel: "explicit",
        polarity: "positive",
        magnitude: 0.9,
        rationale: "great",
        raw: null,
      });
      repos.feedback.insert({
        id: "f2",
        ts: 20,
        episodeId: "e",
        traceId: null,
        channel: "implicit",
        polarity: "negative",
        magnitude: 0.5,
        rationale: null,
        raw: { tool: "shell" },
      });

      const forEpisode = repos.feedback.getForEpisode("e");
      expect(forEpisode.map((f) => f.id)).toEqual(["f2", "f1"]);

      const neg = repos.feedback.list({ polarity: "negative" });
      expect(neg.map((f) => f.id)).toEqual(["f2"]);
      expect(neg[0]!.raw).toEqual({ tool: "shell" });
    } finally {
      cleanup();
    }
  });

  it("candidate_pool: upsert, list by signature, prune, promote", () => {
    const { repos, cleanup } = makeTmpDb();
    try {
      repos.policies.upsert({
        id: "p1",
        title: "t",
        trigger: "",
        procedure: "",
        verification: "",
        boundary: "",
        support: 0,
        gain: 0,
        status: "candidate",
        sourceEpisodeIds: [],
        inducedBy: "",
        vec: null,
        createdAt: 0,
        updatedAt: 0,
      });
      repos.candidatePool.upsert({
        id: "c1",
        policyId: null,
        evidenceTraceIds: ["t1"],
        signature: "sig-a",
        similarity: 0.7,
        expiresAt: 1000,
      });
      repos.candidatePool.upsert({
        id: "c1",
        policyId: null,
        evidenceTraceIds: ["t1", "t2"],
        signature: "sig-a",
        similarity: 0.8,
        expiresAt: 1000,
      });
      const a = repos.candidatePool.listBySignature("sig-a");
      expect(a.length).toBe(1);
      expect(a[0]!.similarity).toBeCloseTo(0.8);
      expect(a[0]!.evidenceTraceIds).toEqual(["t1", "t2"]);

      repos.candidatePool.promote("c1", "p1");
      expect(repos.candidatePool.getById("c1")!.policyId).toBe("p1");

      const pruned = repos.candidatePool.prune(2000);
      expect(pruned).toBe(1);
      expect(repos.candidatePool.list().length).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("decision_repairs: insert, markValidated, recentForContext", () => {
    const { repos, cleanup } = makeTmpDb();
    try {
      repos.decisionRepairs.insert({
        id: "r1",
        ts: 10,
        contextHash: "h1",
        preference: "p",
        antiPattern: "a",
        highValueTraceIds: ["t1"],
        lowValueTraceIds: ["t2"],
        validated: false,
      });
      repos.decisionRepairs.insert({
        id: "r2",
        ts: 20,
        contextHash: "h1",
        preference: "p2",
        antiPattern: "a2",
        highValueTraceIds: [],
        lowValueTraceIds: [],
        validated: false,
      });
      const recent = repos.decisionRepairs.recentForContext("h1");
      expect(recent.map((r) => r.id)).toEqual(["r2", "r1"]);
      repos.decisionRepairs.markValidated("r1");
      expect(repos.decisionRepairs.getById("r1")!.validated).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("audit: append + list + listKind", () => {
    const { repos, cleanup } = makeTmpDb();
    try {
      const id1 = repos.audit.append({
        ts: 1,
        actor: "system",
        kind: "config.update",
        target: "viewer.port",
        detail: { from: 18910, to: 18920 },
      });
      repos.audit.append({
        ts: 2,
        actor: "user",
        kind: "skill.retire",
        target: "sk-id",
        detail: {},
      });
      repos.audit.append({
        ts: 3,
        actor: "system",
        kind: "config.update",
        target: "hub.enabled",
        detail: { value: true },
      });

      expect(repos.audit.getById(id1)!.detail).toEqual({ from: 18910, to: 18920 });
      expect(repos.audit.listKind("config.update", 10).map((a) => a.target)).toEqual([
        "hub.enabled",
        "viewer.port",
      ]);
      expect(repos.audit.list({ limit: 5 }).length).toBe(3);
    } finally {
      cleanup();
    }
  });

  it("kv: set/get/delete + metadata", () => {
    const { repos, cleanup } = makeTmpDb();
    try {
      repos.kv.set("system.installed_version", "2.0.0-alpha.1");
      expect(repos.kv.get("system.installed_version", "")).toBe("2.0.0-alpha.1");

      const meta = repos.kv.getWithMeta("system.installed_version", "");
      expect(meta.updatedAt).toBeGreaterThan(0);

      repos.kv.set("flags", { debug: true });
      expect(repos.kv.get<{ debug: boolean }>("flags", { debug: false }).debug).toBe(true);

      repos.kv.del("flags");
      expect(repos.kv.get("flags", null)).toBeNull();
    } finally {
      cleanup();
    }
  });
});
