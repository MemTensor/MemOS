/**
 * Regression tests for issue #2076 — dedup pagination cap causing unbounded
 * re-insertion.
 *
 * Root cause: capture.ts dedup callers used `tracesRepo.list({ episodeId })`,
 * which is paginated and silently truncates to 500 rows. Any episode with
 * more than 500 rows would see the older rows re-inserted as "novel" every
 * runLite/runReflect cycle. The fix is uncapped episode reconciliation reads
 * (`listAllForEpisode(episodeId)` and the legacy `list({ episodeId })` path
 * when no explicit page was requested).
 *
 * These tests pin the new contract: give me EVERY row for the episode, no
 * matter how large it grew, so callers can compute the full "already seen"
 * signature set.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { makeTracesRepo } from "../../../core/storage/repos/traces.js";
import type { TraceRow } from "../../../agent-contract/dto.js";

describe("traces.listAllForEpisode — uncapped episode fetch (#2076)", () => {
  let db: Database.Database;
  let repo: ReturnType<typeof makeTracesRepo>;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE traces (
        id TEXT PRIMARY KEY,
        episode_id TEXT,
        session_id TEXT NOT NULL,
        owner_agent_kind TEXT,
        owner_profile_id TEXT,
        owner_workspace_id TEXT,
        ts INTEGER NOT NULL,
        user_text TEXT,
        agent_text TEXT,
        summary TEXT,
        tool_calls_json TEXT,
        reflection TEXT,
        agent_thinking TEXT,
        value REAL NOT NULL DEFAULT 0,
        alpha REAL NOT NULL DEFAULT 0,
        r_human REAL,
        priority REAL NOT NULL DEFAULT 0,
        tags_json TEXT,
        error_signatures_json TEXT,
        vec_summary BLOB,
        vec_action BLOB,
        share_scope TEXT,
        share_target TEXT,
        shared_at INTEGER,
        turn_id INTEGER NOT NULL DEFAULT 0,
        schema_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX idx_traces_episode_ts ON traces(episode_id, ts);
    `);
    // Cast around the type check — Database.Database duck-types StorageDb enough
    // for these repo methods (prepare/all/get/run/iterate).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repo = makeTracesRepo(db as any);
  });

  function makeTrace(overrides: Partial<TraceRow> & { id: string; ts: number; turnId: number }): TraceRow {
    return {
      id: overrides.id,
      episodeId: overrides.episodeId ?? "ep-huge",
      sessionId: overrides.sessionId ?? "sess-1",
      ts: overrides.ts,
      userText: overrides.userText ?? `user ${overrides.id}`,
      agentText: overrides.agentText ?? `agent ${overrides.id}`,
      summary: overrides.summary ?? null,
      toolCalls: overrides.toolCalls ?? [],
      value: overrides.value ?? 0,
      alpha: overrides.alpha ?? 0,
      priority: overrides.priority ?? 0,
      tags: overrides.tags ?? [],
      errorSignatures: overrides.errorSignatures ?? [],
      turnId: overrides.turnId,
      schemaVersion: overrides.schemaVersion ?? 1,
    };
  }

  it("returns EVERY trace for an episode, even when count exceeds the 500 pagination cap", () => {
    // Insert 750 traces in one episode — more than the paginated 500 default
    // that `list({ episodeId })` silently truncated to.
    const N = 750;
    for (let i = 0; i < N; i++) {
      repo.insert(makeTrace({ id: `t-${i}`, ts: 1_000 + i, turnId: i }));
    }

    const all = repo.listAllForEpisode("ep-huge");
    expect(all.length).toBe(N);

    // Also cross-check the ts set spans the full inserted range, so a caller
    // computing `new Set(all.map(t => t.ts))` sees every timestamp.
    const tsSet = new Set(all.map((t) => t.ts));
    expect(tsSet.has(1_000)).toBe(true);
    expect(tsSet.has(1_000 + N - 1)).toBe(true);
  });

  it("keeps legacy episode-only list() calls uncapped unless the caller asks for a page", () => {
    const N = 750;
    for (let i = 0; i < N; i++) {
      repo.insert(makeTrace({ id: `t-${i}`, ts: 1_000 + i, turnId: i }));
    }

    const unpaged = repo.list({ episodeId: "ep-huge" });
    expect(unpaged.length).toBe(N);

    const paged = repo.list({ episodeId: "ep-huge", limit: 25 });
    expect(paged.length).toBe(25);
  });

  it("scopes strictly by episodeId — other episodes' rows are excluded", () => {
    repo.insert(makeTrace({ id: "a1", episodeId: "ep-a", ts: 100, turnId: 1 }));
    repo.insert(makeTrace({ id: "a2", episodeId: "ep-a", ts: 101, turnId: 2 }));
    repo.insert(makeTrace({ id: "b1", episodeId: "ep-b", ts: 200, turnId: 1 }));

    const a = repo.listAllForEpisode("ep-a");
    expect(a.map((r) => r.id).sort()).toEqual(["a1", "a2"]);
    const b = repo.listAllForEpisode("ep-b");
    expect(b.map((r) => r.id)).toEqual(["b1"]);
  });

  it("returns [] for an episode with no traces", () => {
    expect(repo.listAllForEpisode("ep-missing")).toEqual([]);
  });

  it("orders rows by ts ascending — so callers see the causal chain the same way runLite / runReflect built it", () => {
    // Insert out-of-order to defeat any implicit rowid order.
    repo.insert(makeTrace({ id: "t-third", ts: 300, turnId: 3 }));
    repo.insert(makeTrace({ id: "t-first", ts: 100, turnId: 1 }));
    repo.insert(makeTrace({ id: "t-second", ts: 200, turnId: 2 }));

    const rows = repo.listAllForEpisode("ep-huge");
    expect(rows.map((r) => r.ts)).toEqual([100, 200, 300]);
  });
});

describe("traces.listDedupRowsForEpisode — narrow-projection dedup helper (#2077 OCR)", () => {
  let db: Database.Database;
  let repo: ReturnType<typeof makeTracesRepo>;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE traces (
        id TEXT PRIMARY KEY,
        episode_id TEXT,
        session_id TEXT NOT NULL,
        owner_agent_kind TEXT,
        owner_profile_id TEXT,
        owner_workspace_id TEXT,
        ts INTEGER NOT NULL,
        user_text TEXT,
        agent_text TEXT,
        summary TEXT,
        tool_calls_json TEXT,
        reflection TEXT,
        agent_thinking TEXT,
        value REAL NOT NULL DEFAULT 0,
        alpha REAL NOT NULL DEFAULT 0,
        r_human REAL,
        priority REAL NOT NULL DEFAULT 0,
        tags_json TEXT,
        error_signatures_json TEXT,
        vec_summary BLOB,
        vec_action BLOB,
        share_scope TEXT,
        share_target TEXT,
        shared_at INTEGER,
        turn_id INTEGER NOT NULL DEFAULT 0,
        schema_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX idx_traces_episode_ts_dedup ON traces(episode_id, ts);
    `);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repo = makeTracesRepo(db as any);
  });

  function makeTrace(
    overrides: Partial<TraceRow> & { id: string; ts: number; turnId: number },
  ): TraceRow {
    return {
      id: overrides.id,
      episodeId: overrides.episodeId ?? "ep-dedup",
      sessionId: overrides.sessionId ?? "sess-1",
      ts: overrides.ts,
      userText: overrides.userText ?? `user ${overrides.id}`,
      agentText: overrides.agentText ?? `agent ${overrides.id}`,
      summary: overrides.summary ?? null,
      toolCalls: overrides.toolCalls ?? [],
      value: overrides.value ?? 0,
      alpha: overrides.alpha ?? 0,
      priority: overrides.priority ?? 0,
      tags: overrides.tags ?? [],
      errorSignatures: overrides.errorSignatures ?? [],
      turnId: overrides.turnId,
      schemaVersion: overrides.schemaVersion ?? 1,
    };
  }

  it("returns only the five dedup fields — no vecSummary / vecAction / tags / summary", () => {
    // Populate an artificial 8 KB BLOB into vec_summary / vec_action so
    // any accidental full-column projection would show up in memory tests.
    const bigVec = new Float32Array(1024).fill(0.5);
    repo.insert(
      makeTrace({
        id: "t-1",
        ts: 100,
        turnId: 1,
        toolCalls: [{ name: "get", input: { url: "https://example.com" } }],
      }),
    );
    // Poke a vector directly so the row has a heavy payload we can prove
    // the narrow helper does NOT hydrate.
    repo.updateVector("t-1", "vecSummary", bigVec);
    repo.updateVector("t-1", "vecAction", bigVec);

    const rows = repo.listDedupRowsForEpisode("ep-dedup");
    expect(rows.length).toBe(1);
    const [row] = rows;
    // Just the five dedup fields — nothing more.
    expect(Object.keys(row!).sort()).toEqual(
      ["agentText", "toolCalls", "ts", "turnId", "userText"].sort(),
    );
    expect(row!.toolCalls).toEqual([
      { name: "get", input: { url: "https://example.com" } },
    ]);
  });

  it("returns [] for empty episode / missing episodeId", () => {
    expect(repo.listDedupRowsForEpisode("nope")).toEqual([]);
    expect(repo.listDedupRowsForEpisode("")).toEqual([]);
  });

  it("streams every trace for an episode past the 500-row paginated cap", () => {
    // Same regression guard as `listAllForEpisode` — the narrow path
    // must also be uncapped, or callers get silent under-dedup.
    const N = 750;
    for (let i = 0; i < N; i++) {
      repo.insert(makeTrace({ id: `t-${i}`, ts: 1_000 + i, turnId: i }));
    }
    const rows = repo.listDedupRowsForEpisode("ep-dedup");
    expect(rows.length).toBe(N);
    expect(rows[0]!.ts).toBe(1_000);
    expect(rows[N - 1]!.ts).toBe(1_000 + N - 1);
  });

  it("scopes strictly by episode and orders by ts ASC — matches listAllForEpisode contract", () => {
    repo.insert(makeTrace({ id: "b1", episodeId: "ep-b", ts: 200, turnId: 1 }));
    repo.insert(makeTrace({ id: "a-third", ts: 300, turnId: 3 }));
    repo.insert(makeTrace({ id: "a-first", ts: 100, turnId: 1 }));
    repo.insert(makeTrace({ id: "a-second", ts: 200, turnId: 2 }));

    const a = repo.listDedupRowsForEpisode("ep-dedup");
    expect(a.map((r) => r.ts)).toEqual([100, 200, 300]);
    const b = repo.listDedupRowsForEpisode("ep-b");
    expect(b.length).toBe(1);
    expect(b[0]!.ts).toBe(200);
  });
});
