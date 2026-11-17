import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { makeTracesRepo } from "../../../core/storage/repos/traces.js";
import type { TraceRow } from "../../../agent-contract/dto.js";

/**
 * `getManyByIds` chunking regression tests (https://github.com/MemTensor/MemOS/issues/2509).
 *
 * The method must chunk its `IN (…)` clause like every sibling in the same file
 * (`hasAnyNewerThan`, `countExisting`, `filterExistingIds` — all at CHUNK_SIZE 900).
 * Before the fix it built a single IN() with one placeholder per id, so any call
 * with more ids than SQLite's bound-parameter limit (32766 on SQLite ≥ 3.32)
 * threw `too many SQL variables` and 500'd every read path that hydrates
 * episode traces (`/api/v1/episodes`, `/api/v1/diag/*`).
 *
 * The dedupe semantics documented at `traces.ts` (`getManyByIds(ids).length`
 * also dedupes) must survive chunking: a duplicate id must never yield a
 * duplicate row, including duplicates that land in different chunks.
 */
describe("traces getManyByIds chunking", () => {
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
      CREATE INDEX idx_traces_ts ON traces(ts);
      CREATE INDEX idx_traces_episode_turn ON traces(episode_id, turn_id, ts);
    `);
    repo = makeTracesRepo(db);
  });

  function makeTrace(id: string): TraceRow {
    return {
      id,
      episodeId: "episode-1",
      sessionId: "session-1",
      ts: 1_700_000_000_000,
      userText: `user ${id}`,
      agentText: `agent ${id}`,
      summary: `summary ${id}`,
      toolCalls: [],
      value: 0,
      alpha: 0,
      priority: 0,
      tags: [],
      errorSignatures: [],
      turnId: 0,
      schemaVersion: 1,
    };
  }

  function insertTraces(n: number, prefix = "trace"): void {
    const insert = db.transaction(() => {
      for (let i = 0; i < n; i++) repo.insert(makeTrace(`${prefix}-${i}`));
    });
    insert();
  }

  it("returns [] for an empty id list", () => {
    expect(repo.getManyByIds([])).toEqual([]);
  });

  it("returns every row for exactly 900 ids (chunk boundary)", () => {
    insertTraces(900);
    const ids = Array.from({ length: 900 }, (_, i) => `trace-${i}`);
    const rows = repo.getManyByIds(ids);
    expect(rows.length).toBe(900);
    expect(new Set(rows.map((r) => r.id)).size).toBe(900);
  });

  it("returns every row for 901 ids (crosses one chunk boundary)", () => {
    insertTraces(901);
    const ids = Array.from({ length: 901 }, (_, i) => `trace-${i}`);
    const rows = repo.getManyByIds(ids);
    expect(rows.length).toBe(901);
    expect(new Set(rows.map((r) => r.id)).size).toBe(901);
  });

  it("dedupes duplicate ids across chunk boundaries", () => {
    insertTraces(950);
    // 950 unique ids, each listed twice (1900 entries) so duplicates land in
    // both chunks of a 900-sized split.
    const ids: string[] = [];
    for (let i = 0; i < 950; i++) {
      ids.push(`trace-${i}`);
      ids.push(`trace-${i}`);
    }
    const rows = repo.getManyByIds(ids);
    expect(rows.length).toBe(950);
    expect(new Set(rows.map((r) => r.id)).size).toBe(950);
  });

  it("returns only rows that exist for missing ids", () => {
    insertTraces(10);
    const ids = ["trace-1", "ghost-1", "trace-2", "ghost-2"];
    const rows = repo.getManyByIds(ids);
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(["trace-1", "trace-2"]));
  });

  it("returns every row past SQLite's 32766 bound-parameter limit", () => {
    // The #2509 field case: a single episode's trace_ids_json grows past the
    // limit (94k ids there). 33000 unique ids exceed SQLite's default
    // SQLITE_MAX_VARIABLE_NUMBER (32766) and must not throw.
    insertTraces(33000);
    const ids = Array.from({ length: 33000 }, (_, i) => `trace-${i}`);
    const rows = repo.getManyByIds(ids);
    expect(rows.length).toBe(33000);
    expect(new Set(rows.map((r) => r.id)).size).toBe(33000);
  });
});
