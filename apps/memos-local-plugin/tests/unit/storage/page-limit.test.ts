/**
 * Regression tests for issue #2401 — storage layer silently truncating to
 * 500 rows.
 *
 * Two defects lived in `core/storage/repos/_helpers.ts`:
 *   - `clampLimit` hard-capped every explicit limit at 500, so callers
 *     asking for "all rows" via a large limit (`limit: 100_000`, the
 *     established "uncapped window" idiom) still got the newest 500.
 *   - `buildPageClauses` treated "caller passed no limit" as
 *     "caller wants a 500-row page", silently truncating the no-limit
 *     scan paths (L3 policy clustering, L2 candidate sweeps, q-substring
 *     counting, ...).
 *
 * The contract being pinned here matches #2076's episode-scan fix:
 * an explicit limit is respected (up to a high safety ceiling), and no
 * limit means no LIMIT clause.
 */

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";

import { buildPageClauses, clampLimit } from "../../../core/storage/repos/_helpers.js";
import { makeTracesRepo } from "../../../core/storage/repos/traces.js";
import { makeTmpDb } from "../../helpers/tmp-db.js";
import type { PolicyRow, TraceRow } from "../../../core/types.js";

describe("clampLimit — explicit limits are respected (#2401)", () => {
  it("does not cap large explicit limits at 500", () => {
    expect(clampLimit(100_000)).toBeGreaterThan(500);
    expect(clampLimit(5_000)).toBe(5_000);
    expect(clampLimit(1_000)).toBe(1_000);
  });

  it("keeps small explicit limits untouched", () => {
    expect(clampLimit(20)).toBe(20);
    expect(clampLimit(1)).toBe(1);
  });

  it("falls back to a sane positive page size for invalid input", () => {
    expect(clampLimit(0)).toBeGreaterThan(0);
    expect(clampLimit(-5)).toBeGreaterThan(0);
    expect(clampLimit(Number.NaN)).toBeGreaterThan(0);
  });
});

describe("buildPageClauses — no limit means no LIMIT (#2401)", () => {
  it("omits LIMIT when the caller passes no options at all", () => {
    const sql = buildPageClauses(undefined, "updated_at");
    expect(sql).not.toMatch(/LIMIT/);
    expect(sql).toMatch(/ORDER BY updated_at DESC/);
  });

  it("omits the page clause when the caller passes an options object without limit", () => {
    // SQLite has no OFFSET without LIMIT, so an offset without a limit is
    // not a page request — the full ordered result set comes back.
    const sql = buildPageClauses({ newestFirst: false, offset: 10 }, "ts");
    expect(sql).not.toMatch(/LIMIT/);
    expect(sql).toMatch(/ORDER BY ts ASC/);
  });

  it("keeps the LIMIT clause when a limit is given", () => {
    expect(buildPageClauses({ limit: 20 }, "ts")).toMatch(/LIMIT 20 OFFSET 0/);
  });

  it("respects a large explicit limit instead of clamping to 500", () => {
    expect(buildPageClauses({ limit: 100_000 }, "ts")).toMatch(/LIMIT 100000 OFFSET 0/);
  });
});

describe("repo list with > 500 rows (#2401)", () => {
  function seedPolicy(id: string, i: number): PolicyRow {
    return {
      id: id as PolicyRow["id"],
      ownerAgentKind: "openclaw",
      ownerProfileId: "main",
      ownerWorkspaceId: null,
      title: `policy ${i}`,
      trigger: "",
      procedure: "",
      verification: "",
      boundary: "",
      support: 1,
      gain: 0,
      status: i % 2 === 0 ? "active" : "candidate",
      sourceEpisodeIds: [],
      inducedBy: "test",
      decisionGuidance: { preference: [], antiPattern: [] },
      vec: null,
      createdAt: 1_700_000_000_000 + i,
      updatedAt: 1_700_000_000_000 + i,
    };
  }

  it("policies.list without limit returns every matching row (L3/L2 scan paths)", () => {
    const { repos, cleanup } = makeTmpDb();
    try {
      const N = 600;
      for (let i = 0; i < N; i++) {
        repos.policies.upsert(seedPolicy(`p_${i}`, i));
      }

      // l3.ts / decision-guidance / retrieval-repos call shape: no limit.
      expect(repos.policies.list({ status: "active" })).toHaveLength(300);
      expect(repos.policies.list({ status: "candidate" })).toHaveLength(300);
      // l2.ts dedup call shape: explicit large limit must not clamp to 500.
      expect(repos.policies.list({ limit: 5_000 })).toHaveLength(N);
    } finally {
      cleanup();
    }
  });

  it("policies.count stays exact regardless of list paging", () => {
    const { repos, cleanup } = makeTmpDb();
    try {
      const N = 600;
      for (let i = 0; i < N; i++) {
        repos.policies.upsert(seedPolicy(`p_${i}`, i));
      }
      expect(repos.policies.count({ status: "active" })).toBe(300);
      expect(repos.policies.count()).toBe(N);
    } finally {
      cleanup();
    }
  });

  it("traces.list without limit returns every matching row (q-substring counting path)", () => {
    const db = new Database(":memory:");
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
    `);
    const repo = makeTracesRepo(db);
    const N = 600;
    for (let i = 0; i < N; i++) {
      const trace: TraceRow = {
        id: `trace-${i}`,
        episodeId: `episode-${Math.floor(i / 10)}`,
        sessionId: "session-1",
        ts: 1_700_000_000_000 + i,
        userText: `user ${i}`,
        agentText: `agent ${i}`,
        summary: null,
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

    // countTraces q-path call shape: filter only, no limit/offset.
    expect(repo.list({ sessionId: "session-1" })).toHaveLength(N);
    db.close();
  });
});
