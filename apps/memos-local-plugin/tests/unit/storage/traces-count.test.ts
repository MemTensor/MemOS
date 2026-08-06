import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { makeTracesRepo } from "../../../core/storage/repos/traces.js";
import type { TraceRow } from "../../../agent-contract/dto.js";

describe("traces count with > 500 items", () => {
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

  it("count() should return accurate count > 500", () => {
    // Insert 600 traces
    for (let i = 0; i < 600; i++) {
      const trace: TraceRow = {
        id: `trace-${i}`,
        episodeId: `episode-${Math.floor(i / 10)}`,
        sessionId: "session-1",
        ts: Date.now() + i,
        userText: `user ${i}`,
        agentText: `agent ${i}`,
        summary: `summary ${i}`,
        toolCalls: [],
        value: 0,
        alpha: 0,
        priority: 0,
        tags: [],
        errorSignatures: [],
        turnId: i,
        schemaVersion: 1,
      };
      repo.insert(trace);
    }

    // Verify count returns 600
    const count = repo.count();
    expect(count).toBe(600);

    // Verify list with no limit still caps at 500
    const listed = repo.list({});
    expect(listed.length).toBe(500);

    // Verify list with explicit high limit also caps at 500
    const listedWithLimit = repo.list({ limit: 10000 });
    expect(listedWithLimit.length).toBe(500);
  });

  it("countTurns() should return accurate count > 500", () => {
    // Insert 600 turns (each with 2 traces)
    for (let turnId = 0; turnId < 600; turnId++) {
      for (let traceIdx = 0; traceIdx < 2; traceIdx++) {
        const trace: TraceRow = {
          id: `trace-${turnId}-${traceIdx}`,
          episodeId: `episode-${Math.floor(turnId / 10)}`,
          sessionId: "session-1",
          ts: Date.now() + turnId * 100 + traceIdx,
          userText: `user ${turnId}`,
          agentText: `agent ${turnId}`,
          summary: `summary ${turnId}`,
          toolCalls: [],
          value: 0,
          alpha: 0,
          priority: 0,
          tags: [],
          errorSignatures: [],
          turnId,
          schemaVersion: 1,
        };
        repo.insert(trace);
      }
    }

    // Verify countTurns returns 600 (unique turn keys)
    const turnCount = repo.countTurns();
    expect(turnCount).toBe(600);

    // Verify total trace count is 1200
    const traceCount = repo.count();
    expect(traceCount).toBe(1200);
  });
});
