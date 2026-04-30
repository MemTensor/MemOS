/**
 * HTTP server — unit tests.
 *
 * Spins up the real server on a random loopback port (`port: 0`) and
 * hits it with `fetch`. We stub the `MemoryCore` so the tests stay
 * hermetic; the server just has to route + serialise + auth.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startHttpServer } from "../../../server/index.js";
import type { ServerHandle } from "../../../server/index.js";
import type { MemoryCore } from "../../../agent-contract/memory-core.js";

function stubCore(): MemoryCore {
  return {
    init: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    health: vi.fn(async () => ({
      ok: true,
      version: "test",
      uptimeMs: 1,
      agent: "openclaw",
      paths: { home: "/tmp", config: "/tmp/c", db: "/tmp/db", skills: "/tmp/s", logs: "/tmp/l" },
      llm: { available: false, provider: "mock" },
      embedder: { available: false, provider: "mock", dim: 0 },
    })),
    openSession: vi.fn(async ({ agent }) => `${agent}:s1`),
    closeSession: vi.fn(async () => {}),
    openEpisode: vi.fn(async ({ sessionId }) => `${sessionId}:e1`),
    closeEpisode: vi.fn(async () => {}),
    onTurnStart: vi.fn(async () => ({
      query: { agent: "openclaw", query: "" },
      hits: [],
      injectedContext: "",
      tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
    })),
    onTurnEnd: vi.fn(async () => ({ traceId: "t1", episodeId: "e1" })),
    submitFeedback: vi.fn(async (fb) => ({
      id: "fb1",
      ts: 1,
      channel: fb.channel,
      polarity: fb.polarity,
      magnitude: fb.magnitude,
      rationale: fb.rationale,
      raw: fb.raw,
      traceId: fb.traceId,
      episodeId: fb.episodeId,
    })),
    recordToolOutcome: vi.fn(),
    searchMemory: vi.fn(async (q) => ({
      query: q,
      hits: [{ tier: 1 as const, refId: "r1", refKind: "skill" as const, score: 0.9, snippet: "hit" }],
      injectedContext: "hit",
      tierLatencyMs: { tier1: 1, tier2: 1, tier3: 1 },
    })),
    getTrace: vi.fn(async (id) => ({ id, step: 0, ts: 0, role: "user", text: "t" } as any)),
    updateTrace: vi.fn(async (id) => ({ id } as any)),
    deleteTrace: vi.fn(async () => ({ deleted: true })),
    deleteTraces: vi.fn(async () => ({ deleted: 0 })),
    shareTrace: vi.fn(async (id) => ({ id, share: { scope: "public" } } as any)),
    getPolicy: vi.fn(async (id) => ({ id, title: "p", status: "active" } as any)),
    listPolicies: vi.fn(async () => []),
    setPolicyStatus: vi.fn(async (id, status) => ({ id, status } as any)),
    deletePolicy: vi.fn(async () => ({ deleted: false })),
    sharePolicy: vi.fn(async (id, share) => ({ id, share } as any)),
    updatePolicy: vi.fn(async (id, patch) => ({ id, ...patch } as any)),
    editPolicyGuidance: vi.fn(async (id) => ({ id } as any)),
    getWorldModel: vi.fn(async () => null),
    listWorldModels: vi.fn(async () => []),
    deleteWorldModel: vi.fn(async () => ({ deleted: false })),
    shareWorldModel: vi.fn(async (id, share) => ({ id, status: "active", share } as any)),
    updateWorldModel: vi.fn(async (id, patch) => ({ id, status: "active", ...patch } as any)),
    archiveWorldModel: vi.fn(async (id) => ({ id, status: "archived" } as any)),
    unarchiveWorldModel: vi.fn(async (id) => ({ id, status: "active" } as any)),
    listEpisodes: vi.fn(async () => ["e1", "e2"]),
    listEpisodeRows: vi.fn(async () => [
      {
        id: "e1",
        sessionId: "s1",
        startedAt: 1,
        endedAt: 2,
        status: "closed" as const,
        rTask: 0.5,
        turnCount: 2,
        preview: "hello",
      },
      {
        id: "e2",
        sessionId: "s1",
        startedAt: 3,
        status: "open" as const,
        turnCount: 0,
        rTask: null,
      },
    ]),
    countEpisodes: vi.fn(async () => 2),
    timeline: vi.fn(async () => [{ id: "t1", step: 0, ts: 0 } as any]),
    listTraces: vi.fn(async () => [
      {
        id: "tr-1",
        episodeId: "e1",
        sessionId: "s1",
        ts: 100,
        userText: "hello",
        agentText: "hi",
        summary: "greeted",
        toolCalls: [],
        value: 0.5,
        alpha: 0.5,
        priority: 0.5,
      },
    ] as any),
    countTraces: vi.fn(async () => 1),
    listApiLogs: vi.fn(async () => ({ logs: [], total: 0 })),
    listSkills: vi.fn(async () => []),
    countSkills: vi.fn(async () => 0),
    getSkill: vi.fn(async (id) => ({
      id,
      name: "test-skill",
      status: "active",
      invocationGuide: "use this when X",
      version: 2,
    } as any)),
    archiveSkill: vi.fn(async () => {}),
    deleteSkill: vi.fn(async () => ({ deleted: true })),
    reactivateSkill: vi.fn(async (id) => ({ id, status: "active" } as any)),
    updateSkill: vi.fn(async (id, patch) => ({ id, ...patch } as any)),
    shareSkill: vi.fn(async (id, share) => ({ id, share } as any)),
    getConfig: vi.fn(async () => ({ version: 1 })),
    patchConfig: vi.fn(async () => ({ version: 1, llm: { provider: "openai_compatible" } })),
    metrics: vi.fn(async () => ({
      total: 0,
      writesToday: 0,
      sessions: 0,
      embeddings: 0,
      dailyWrites: [],
    })),
    exportBundle: vi.fn(async () => ({
      version: 1 as const,
      exportedAt: 0,
      traces: [],
      policies: [],
      worldModels: [],
      skills: [],
    })),
    importBundle: vi.fn(async () => ({ imported: 0, skipped: 0 })),
    subscribeEvents: vi.fn(() => () => {}),
    subscribeLogs: vi.fn(() => () => {}),
    forwardLog: vi.fn(),
  } as unknown as MemoryCore;
}

describe("HTTP server — REST routes", () => {
  let handle: ServerHandle;
  let core: MemoryCore;

  beforeEach(async () => {
    core = stubCore();
    handle = await startHttpServer({ core }, { port: 0 });
  });

  afterEach(async () => {
    await handle.close();
  });

  it("GET /api/v1/ping returns ok", async () => {
    const r = await fetch(`${handle.url}/api/v1/ping`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ ok: true, ts: expect.any(Number) });
  });

  it("GET /api/v1/health calls core.health", async () => {
    const r = await fetch(`${handle.url}/api/v1/health`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ ok: true, version: "test" });
    expect(core.health).toHaveBeenCalled();
  });

  it("GET /api/v1/health includes optional bridge status", async () => {
    await handle.close();
    handle = await startHttpServer({
      core,
      bridgeStatus: () => ({
        status: "connected",
        lastOkAt: 123,
        lastErrorAt: null,
        lastError: null,
      }),
    }, { port: 0 });

    const r = await fetch(`${handle.url}/api/v1/health`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.bridge).toEqual({
      status: "connected",
      lastOkAt: 123,
      lastErrorAt: null,
      lastError: null,
    });
  });

  it("POST /api/v1/sessions opens a session", async () => {
    const r = await fetch(`${handle.url}/api/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "openclaw" }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toEqual({ sessionId: "openclaw:s1" });
    expect(core.openSession).toHaveBeenCalledWith({ agent: "openclaw", sessionId: undefined });
  });

  it("POST /api/v1/sessions rejects missing agent", async () => {
    const r = await fetch(`${handle.url}/api/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as any;
    expect(body.error.code).toBe("invalid_argument");
  });

  it("POST /api/v1/memory/search proxies to searchMemory", async () => {
    const r = await fetch(`${handle.url}/api/v1/memory/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "testing", agent: "openclaw" }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.hits).toHaveLength(1);
    expect(core.searchMemory).toHaveBeenCalledWith(
      expect.objectContaining({ query: "testing", agent: "openclaw" }),
    );
  });

  it("GET /api/v1/memory/trace?id=t1 returns the trace", async () => {
    const r = await fetch(`${handle.url}/api/v1/memory/trace?id=t1`);
    expect(r.status).toBe(200);
    expect(core.getTrace).toHaveBeenCalledWith("t1");
  });

  it("GET /api/v1/memory/trace returns 404 for unknown ids", async () => {
    (core.getTrace as any).mockResolvedValueOnce(null);
    const r = await fetch(`${handle.url}/api/v1/memory/trace?id=missing`);
    expect(r.status).toBe(404);
  });

  it("GET /api/v1/episodes returns rich rows", async () => {
    const r = await fetch(`${handle.url}/api/v1/episodes`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { episodes: Array<{ id: string; status: string; turnCount: number }> };
    expect(body.episodes.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(body.episodes[0].status).toBe("closed");
    expect(body.episodes[0].turnCount).toBe(2);
  });

  it("GET /api/v1/episodes?shape=ids returns legacy id-only shape", async () => {
    const r = await fetch(`${handle.url}/api/v1/episodes?shape=ids`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { episodeIds: string[] };
    expect(body.episodeIds).toEqual(["e1", "e2"]);
  });

  it("POST /api/v1/feedback accepts explicit polarity", async () => {
    const r = await fetch(`${handle.url}/api/v1/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "explicit", polarity: "positive", magnitude: 0.7 }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body).toMatchObject({
      id: "fb1",
      channel: "explicit",
      polarity: "positive",
      magnitude: 0.7,
    });
  });

  it("POST /api/v1/feedback returns trace_not_found for stale trace ids", async () => {
    (core.getTrace as any).mockResolvedValueOnce(null);
    const r = await fetch(`${handle.url}/api/v1/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: "explicit",
        polarity: "negative",
        magnitude: 1,
        traceId: "trace-not-real",
      }),
    });
    expect(r.status).toBe(404);
    const body = (await r.json()) as any;
    expect(body.error.code).toBe("trace_not_found");
    expect(core.submitFeedback).not.toHaveBeenCalled();
  });

  it("GET /api/v1/traces lists newest-first traces (used by Memories panel)", async () => {
    const r = await fetch(`${handle.url}/api/v1/traces?limit=25&q=hi`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      traces: Array<{ id: string; summary?: string | null }>;
      limit: number;
      offset: number;
    };
    expect(body.limit).toBe(25);
    expect(body.offset).toBe(0);
    expect(Array.isArray(body.traces)).toBe(true);
    expect(body.traces[0]?.id).toBe("tr-1");
    expect(body.traces[0]?.summary).toBe("greeted");
    // The route must forward the query string into the core call.
    expect(core.listTraces).toHaveBeenCalledWith({
      limit: 25,
      offset: 0,
      sessionId: undefined,
      q: "hi",
      groupByTurn: false,
    });
  });

  it("GET /api/v1/traces/:id resolves via pattern route", async () => {
    const r = await fetch(`${handle.url}/api/v1/traces/t-42`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { id: string };
    expect(body.id).toBe("t-42");
    // Dispatcher strips route prefix and passes `t-42` to core.getTrace.
    expect(core.getTrace).toHaveBeenCalledWith("t-42");
  });

  it("GET /api/v1/episodes/:id/timeline returns {episodeId, traces}", async () => {
    const r = await fetch(`${handle.url}/api/v1/episodes/e1/timeline`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { episodeId: string; traces: unknown[] };
    expect(body.episodeId).toBe("e1");
    expect(Array.isArray(body.traces)).toBe(true);
  });

  it("GET /api/v1/metrics returns aggregate counts", async () => {
    const r = await fetch(`${handle.url}/api/v1/metrics?days=7`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { total: number; dailyWrites: unknown[] };
    expect(body.total).toBe(0);
    expect(Array.isArray(body.dailyWrites)).toBe(true);
  });

  it("GET /api/v1/config returns resolved config", async () => {
    const r = await fetch(`${handle.url}/api/v1/config`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { version: number };
    expect(body.version).toBe(1);
  });

  it("PATCH /api/v1/config applies a partial", async () => {
    const r = await fetch(`${handle.url}/api/v1/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ llm: { provider: "openai_compatible" } }),
    });
    expect(r.status).toBe(200);
    expect(core.patchConfig).toHaveBeenCalledWith({
      llm: { provider: "openai_compatible" },
    });
  });

  it("GET /api/v1/export returns a JSON bundle", async () => {
    const r = await fetch(`${handle.url}/api/v1/export`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { version: number; traces: unknown[] };
    expect(body.version).toBe(1);
    expect(Array.isArray(body.traces)).toBe(true);
  });

  it("POST /api/v1/import accepts JSON bundles", async () => {
    const r = await fetch(`${handle.url}/api/v1/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, traces: [] }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { imported: number; skipped: number };
    expect(body.imported).toBe(0);
  });

  it("GET /api/v1/hub/admin returns {enabled:false} when sharing is off", async () => {
    const r = await fetch(`${handle.url}/api/v1/hub/admin`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { enabled: boolean };
    expect(body.enabled).toBe(false);
  });

  // ─── Connectivity smoke tests ─────────────────────────────────────────
  // These pin the contract between the viewer's REST client and the
  // server. Every endpoint the viewer touches (see
  // `web/src/**/*.tsx::api.get/post/patch`) is exercised here.

  it("GET /api/v1/overview returns the summary shape the viewer expects", async () => {
    const r = await fetch(`${handle.url}/api/v1/overview`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok?: boolean;
      version?: string;
      uptimeMs?: number;
      episodes?: number;
      skills?: { total: number; active: number; candidate: number; archived: number };
    };
    expect(typeof body.episodes).toBe("number");
    expect(typeof body.skills?.total).toBe("number");
    expect(typeof body.skills?.active).toBe("number");
    // The viewer reads `ok` + `version` too (OverviewView → health).
    expect(body.ok).toBe(true);
    expect(body.version).toBe("test");
  });

  it("GET /api/v1/skills returns { skills: [...] } (not a bare array)", async () => {
    const r = await fetch(`${handle.url}/api/v1/skills?limit=5`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { skills: unknown[] };
    expect(Array.isArray(body.skills)).toBe(true);
  });

  it("GET /api/v1/skills?status=active filters by status", async () => {
    const r = await fetch(`${handle.url}/api/v1/skills?limit=5&status=active`);
    expect(r.status).toBe(200);
    // We can't assert on row content (stub returns []), but we CAN
    // assert the shape the viewer relies on.
    const body = (await r.json()) as { skills: unknown[] };
    expect(Array.isArray(body.skills)).toBe(true);
  });

  it("POST /api/v1/skills/archive accepts a skillId body", async () => {
    const r = await fetch(`${handle.url}/api/v1/skills/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skillId: "sk_1" }),
    });
    expect(r.status).toBe(200);
    expect(core.archiveSkill).toHaveBeenCalledWith("sk_1", undefined);
  });

  it("GET /api/v1/migrate/openclaw/scan returns the scan result shape", async () => {
    const r = await fetch(`${handle.url}/api/v1/migrate/openclaw/scan`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { found: boolean; path?: string; agent?: string };
    // `found` is always a boolean regardless of whether the legacy DB
    // is on disk. The viewer uses this to toggle the "Run migration"
    // button. The path is hard-coded to the openclaw layout.
    expect(typeof body.found).toBe("boolean");
    expect(body.agent).toBe("openclaw");
    if (body.path) expect(body.path).toMatch(/\.openclaw\/memos-local\/memos\.db$/);
  });

  it("POST /api/v1/migrate/openclaw/run returns { imported: {...} } even when empty", async () => {
    const r = await fetch(`${handle.url}/api/v1/migrate/openclaw/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    // Acceptable: 200 when the DB is absent with `{ imported: {...} }`
    // OR 404 when the server reports "no legacy db". Either way the
    // viewer handles both.
    expect([200, 404]).toContain(r.status);
    const body = (await r.json()) as {
      imported?: Record<string, number>;
      error?: { message?: string };
    };
    if (r.status === 200) {
      expect(typeof body.imported).toBe("object");
    } else {
      expect(body.error).toBeDefined();
      // 404 must mention the openclaw legacy path so the user knows
      // which file we tried to read.
      expect(body.error?.message ?? "").toMatch(/\.openclaw\//);
    }
  });

  it("GET /api/v1/migrate/hermes/scan reports the hermes legacy path", async () => {
    const r = await fetch(`${handle.url}/api/v1/migrate/hermes/scan`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { found: boolean; path?: string; agent?: string };
    expect(body.agent).toBe("hermes");
    // The hermes legacy plugin nested its data under
    // `~/.hermes/memos-state/memos-local/memos.db` (not the openclaw
    // layout). This test is what would have caught the original bug.
    if (body.path) expect(body.path).toMatch(/\.hermes\/memos-state\/memos-local\/memos\.db$/);
  });

  it("POST /api/v1/migrate/hermes/run targets the hermes legacy path", async () => {
    const r = await fetch(`${handle.url}/api/v1/migrate/hermes/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect([200, 404]).toContain(r.status);
    const body = (await r.json()) as {
      agent?: string;
      path?: string;
      error?: { message?: string };
    };
    if (r.status === 200) {
      expect(body.agent).toBe("hermes");
      expect(body.path ?? "").toMatch(/\.hermes\/memos-state\/memos-local\/memos\.db$/);
    } else {
      expect(body.error?.message ?? "").toMatch(/\.hermes\/memos-state\//);
    }
  });

  it("GET /api/v1/migrate/legacy/scan picks the path from options.agent (default openclaw)", async () => {
    const r = await fetch(`${handle.url}/api/v1/migrate/legacy/scan`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { found: boolean; path?: string; agent?: string };
    // The default server fixture omits `options.agent`; the migrate
    // route falls back to openclaw.
    expect(body.agent).toBe("openclaw");
  });

  it("GET /api/v1/migrate/legacy/scan honours options.agent='hermes'", async () => {
    const local = await startHttpServer({ core }, { port: 0, agent: "hermes" });
    try {
      const r = await fetch(`${local.url}/api/v1/migrate/legacy/scan`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { found: boolean; path?: string; agent?: string };
      expect(body.agent).toBe("hermes");
      if (body.path) expect(body.path).toMatch(/\.hermes\/memos-state\/memos-local\/memos\.db$/);
    } finally {
      await local.close();
    }
  });

  it("DELETE /api/v1/skills/:id hard-deletes", async () => {
    const r = await fetch(`${handle.url}/api/v1/skills/sk_1`, { method: "DELETE" });
    expect(r.status).toBe(200);
    expect(core.deleteSkill).toHaveBeenCalledWith("sk_1");
  });

  it("POST /api/v1/skills/reactivate flips an archived skill back to active", async () => {
    const r = await fetch(`${handle.url}/api/v1/skills/reactivate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "sk_1" }),
    });
    expect(r.status).toBe(200);
    expect(core.reactivateSkill).toHaveBeenCalledWith("sk_1");
  });

  it("POST /api/v1/skills/reactivate 404s when skill is unknown", async () => {
    (core.reactivateSkill as any).mockResolvedValueOnce(null);
    const r = await fetch(`${handle.url}/api/v1/skills/reactivate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "missing" }),
    });
    expect(r.status).toBe(404);
  });

  it("PATCH /api/v1/skills/:id forwards the editable fields", async () => {
    const r = await fetch(`${handle.url}/api/v1/skills/sk_1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "renamed", invocationGuide: "do X" }),
    });
    expect(r.status).toBe(200);
    expect(core.updateSkill).toHaveBeenCalledWith("sk_1", {
      name: "renamed",
      invocationGuide: "do X",
    });
  });

  it("POST /api/v1/skills/:id/share defaults to scope=public when omitted", async () => {
    const r = await fetch(`${handle.url}/api/v1/skills/sk_1/share`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(200);
    expect(core.shareSkill).toHaveBeenCalledWith(
      "sk_1",
      expect.objectContaining({ scope: "public", target: null }),
    );
  });

  it("POST /api/v1/skills/:id/share with scope=null clears the share", async () => {
    const r = await fetch(`${handle.url}/api/v1/skills/sk_1/share`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: null }),
    });
    expect(r.status).toBe(200);
    expect(core.shareSkill).toHaveBeenCalledWith(
      "sk_1",
      expect.objectContaining({ scope: null, sharedAt: null }),
    );
  });

  it("GET /api/v1/skills/:id/download returns a zip body", async () => {
    const r = await fetch(`${handle.url}/api/v1/skills/sk_1/download`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/zip");
    const buf = Buffer.from(await r.arrayBuffer());
    // PKZIP local-file-header magic.
    expect(buf.slice(0, 4).toString("hex")).toBe("504b0304");
    const nameLen = buf.readUInt16LE(26);
    const extraLen = buf.readUInt16LE(28);
    const fileSize = buf.readUInt32LE(22);
    const name = buf.subarray(30, 30 + nameLen).toString("utf8");
    const start = 30 + nameLen + extraLen;
    const md = buf.subarray(start, start + fileSize).toString("utf8");
    expect(name).toBe("test-skill/SKILL.md");
    expect(md).toMatch(/^---\nname: "test-skill"\ndescription: "use this when X"\n---\n/);
  });

  it("PATCH /api/v1/policies/:id accepts a status-only body (back-compat)", async () => {
    const r = await fetch(`${handle.url}/api/v1/policies/p_1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    });
    expect(r.status).toBe(200);
    expect(core.setPolicyStatus).toHaveBeenCalledWith("p_1", "active");
  });

  it("PATCH /api/v1/policies/:id accepts content fields", async () => {
    const r = await fetch(`${handle.url}/api/v1/policies/p_1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "new title", trigger: "when X" }),
    });
    expect(r.status).toBe(200);
    expect(core.updatePolicy).toHaveBeenCalledWith("p_1", {
      title: "new title",
      trigger: "when X",
    });
  });

  it("PATCH /api/v1/policies/:id rejects an empty body", async () => {
    const r = await fetch(`${handle.url}/api/v1/policies/p_1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
  });

  it("POST /api/v1/policies/:id/share forwards scope/target", async () => {
    const r = await fetch(`${handle.url}/api/v1/policies/p_1/share`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "hub", target: "memx://abc" }),
    });
    expect(r.status).toBe(200);
    expect(core.sharePolicy).toHaveBeenCalledWith(
      "p_1",
      expect.objectContaining({ scope: "hub", target: "memx://abc" }),
    );
  });

  it("PATCH /api/v1/world-models/:id forwards body + status", async () => {
    const r = await fetch(`${handle.url}/api/v1/world-models/wm_1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "T", body: "B", status: "archived" }),
    });
    expect(r.status).toBe(200);
    expect(core.updateWorldModel).toHaveBeenCalledWith("wm_1", {
      title: "T",
      body: "B",
      status: "archived",
    });
  });

  it("POST /api/v1/world-models/:id/archive flips status", async () => {
    const r = await fetch(`${handle.url}/api/v1/world-models/wm_1/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(200);
    expect(core.archiveWorldModel).toHaveBeenCalledWith("wm_1");
  });

  it("POST /api/v1/world-models/:id/unarchive reverses the archive", async () => {
    const r = await fetch(`${handle.url}/api/v1/world-models/wm_1/unarchive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(200);
    expect(core.unarchiveWorldModel).toHaveBeenCalledWith("wm_1");
  });

  it("POST /api/v1/world-models/:id/share forwards the share state", async () => {
    const r = await fetch(`${handle.url}/api/v1/world-models/wm_1/share`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "public" }),
    });
    expect(r.status).toBe(200);
    expect(core.shareWorldModel).toHaveBeenCalledWith(
      "wm_1",
      expect.objectContaining({ scope: "public" }),
    );
  });

  it("unknown route returns 404 json", async () => {
    const r = await fetch(`${handle.url}/api/v1/no-such-thing`);
    expect(r.status).toBe(404);
    const body = (await r.json()) as any;
    expect(body.error.code).toBe("not_found");
  });

  it("wrong method returns 405 json", async () => {
    const r = await fetch(`${handle.url}/api/v1/ping`, { method: "DELETE" });
    expect(r.status).toBe(405);
  });
});

describe("HTTP server — static files", () => {
  const os = require("node:os") as typeof import("node:os");
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memos-static-"));
    fs.writeFileSync(path.join(tmpRoot, "index.html"), "<h1>hello viewer</h1>");
    fs.writeFileSync(path.join(tmpRoot, "app.js"), "console.log('app');");
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("serves index.html at /", async () => {
    const core = stubCore();
    const handle = await startHttpServer({ core }, { port: 0, staticRoot: tmpRoot });
    try {
      const r = await fetch(`${handle.url}/`);
      expect(r.status).toBe(200);
      const body = await r.text();
      expect(body).toContain("hello viewer");
    } finally {
      await handle.close();
    }
  });

  it("serves js with correct content-type", async () => {
    const core = stubCore();
    const handle = await startHttpServer({ core }, { port: 0, staticRoot: tmpRoot });
    try {
      const r = await fetch(`${handle.url}/app.js`);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type") ?? "").toContain("application/javascript");
    } finally {
      await handle.close();
    }
  });

  it("rejects directory traversal", async () => {
    const core = stubCore();
    const handle = await startHttpServer({ core }, { port: 0, staticRoot: tmpRoot });
    try {
      const r = await fetch(`${handle.url}/..%2Fetc%2Fpasswd`);
      expect([403, 404]).toContain(r.status);
    } finally {
      await handle.close();
    }
  });

  it("404s when file missing and no route matches", async () => {
    const core = stubCore();
    const handle = await startHttpServer({ core }, { port: 0, staticRoot: tmpRoot });
    try {
      const r = await fetch(`${handle.url}/missing.txt`);
      expect(r.status).toBe(404);
    } finally {
      await handle.close();
    }
  });
});

describe("HTTP server — API key gating", () => {
  it("rejects request without api key", async () => {
    const core = stubCore();
    const handle = await startHttpServer({ core }, { port: 0, apiKey: "secret-123" });
    try {
      const r = await fetch(`${handle.url}/api/v1/ping`);
      expect(r.status).toBe(401);
    } finally {
      await handle.close();
    }
  });

  it("accepts request with matching x-api-key", async () => {
    const core = stubCore();
    const handle = await startHttpServer({ core }, { port: 0, apiKey: "secret-123" });
    try {
      const r = await fetch(`${handle.url}/api/v1/ping`, {
        headers: { "x-api-key": "secret-123" },
      });
      expect(r.status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it("accepts request with matching Authorization: Bearer", async () => {
    const core = stubCore();
    const handle = await startHttpServer({ core }, { port: 0, apiKey: "secret-123" });
    try {
      const r = await fetch(`${handle.url}/api/v1/ping`, {
        headers: { authorization: "Bearer secret-123" },
      });
      expect(r.status).toBe(200);
    } finally {
      await handle.close();
    }
  });
});
