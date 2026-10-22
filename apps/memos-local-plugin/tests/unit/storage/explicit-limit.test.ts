import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { makeTracesRepo } from "../../../core/storage/repos/traces.js";
import { clampLimit, MAX_QUERY_LIMIT } from "../../../core/storage/repos/_helpers.js";
import type { TraceRow } from "../../../agent-contract/dto.js";

// #2401 regression: an EXPLICIT `limit` must be honored (up to
// MAX_QUERY_LIMIT) instead of being silently rewritten to the 500-row
// default page. Before this fix `traces.list({ limit: 10_000 })` returned
// at most 500 rows, so the viewer's "memory writes per day" chart only
// ever saw the newest 500 traces (~2 days at typical volume) and the
// `sessions` / `embeddings` cards undercounted. Omitting `limit` keeps the
// 500-row default page — that contract is unchanged.
describe("explicit list limits are honored (#2401)", () => {
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

  it("clampLimit honors explicit limits up to MAX_QUERY_LIMIT", () => {
    expect(clampLimit(10_000)).toBe(10_000);
    expect(clampLimit(100_000)).toBe(MAX_QUERY_LIMIT);
    // Beyond the ceiling: bounded, not rejected.
    expect(clampLimit(250_000)).toBe(MAX_QUERY_LIMIT);
    // Small explicit pages still work.
    expect(clampLimit(5)).toBe(5);
    // Invalid / missing input keeps the 500-row default page.
    expect(clampLimit(0)).toBe(500);
    expect(clampLimit(-5)).toBe(500);
    expect(clampLimit(Number.NaN)).toBe(500);
  });

  it("list({ limit }) returns every row a bulk caller asked for", () => {
    const DAY = 86_400_000;
    const now = 1_700_000_000_000;
    for (let i = 0; i < 600; i++) {
      // Three distinct days so a day-bucketing caller (metrics) would see
      // non-zero counts on days that fall outside the newest-500 window.
      const ts = now - (i % 3) * DAY + i;
      const trace: TraceRow = {
        id: `trace-${i}`,
        episodeId: "episode-1",
        sessionId: `session-${i % 3}`,
        ts,
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

    // Bulk read used by metrics(): must see all 600 rows, not 500.
    const bulk = repo.list({ limit: 10_000 });
    expect(bulk).toHaveLength(600);

    // …and the rows it previously lost were the OLDEST ones (newest-first
    // ordering), which is exactly what emptied the left side of the
    // viewer's daily-writes chart.
    const oldestVisible = Math.min(...bulk.map((t) => t.ts));
    // Smallest seeded ts is `now - 2*DAY + 2` (i === 2, 5, 8, …).
    expect(oldestVisible).toBe(now - 2 * DAY + 2);
    const distinctDays = new Set(bulk.map((t) => Math.floor(t.ts / DAY)));
    expect(distinctDays.size).toBe(3);

    // The implicit default page stays 500 rows — callers that omit
    // `limit` keep their existing behavior.
    expect(repo.list()).toHaveLength(500);
  });
});
