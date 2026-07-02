/**
 * One place to grab a full repo bundle for a given DB handle. This is what
 * `core/pipeline/memory-core.ts` will depend on: it takes a `StorageDb` and
 * asks for everything at once.
 */

import type { StorageDb } from "../types.js";
import { makeApiLogsRepo } from "./api_logs.js";
import { makeAuditRepo } from "./audit.js";
import { makeCandidatePoolRepo } from "./candidate_pool.js";
import { makeDecisionRepairsRepo } from "./decision_repairs.js";
import { makeEmbeddingRetryQueueRepo } from "./embedding_retry_queue.js";
import { makeEpisodesRepo } from "./episodes.js";
import { makeFeedbackRepo } from "./feedback.js";
import { makeHubRepo } from "./hub.js";
import { makeKvRepo } from "./kv.js";
import { makeMigrationsRepo } from "./migrations.js";
import { makePoliciesRepo } from "./policies.js";
import { makeSessionsRepo } from "./sessions.js";
import { makeSkillTrialsRepo } from "./skill_trials.js";
import { makeSkillsRepo } from "./skills.js";
import { makeTracePolicyLinksRepo } from "./trace-policy-links.js";
import { makeTracesRepo } from "./traces.js";
import { makeWorldModelRepo } from "./world_model.js";

export interface Repos {
  apiLogs: ReturnType<typeof makeApiLogsRepo>;
  audit: ReturnType<typeof makeAuditRepo>;
  candidatePool: ReturnType<typeof makeCandidatePoolRepo>;
  decisionRepairs: ReturnType<typeof makeDecisionRepairsRepo>;
  embeddingRetryQueue: ReturnType<typeof makeEmbeddingRetryQueueRepo>;
  episodes: ReturnType<typeof makeEpisodesRepo>;
  feedback: ReturnType<typeof makeFeedbackRepo>;
  hub: ReturnType<typeof makeHubRepo>;
  kv: ReturnType<typeof makeKvRepo>;
  migrations: ReturnType<typeof makeMigrationsRepo>;
  policies: ReturnType<typeof makePoliciesRepo>;
  sessions: ReturnType<typeof makeSessionsRepo>;
  skillTrials: ReturnType<typeof makeSkillTrialsRepo>;
  skills: ReturnType<typeof makeSkillsRepo>;
  tracePolicyLinks: ReturnType<typeof makeTracePolicyLinksRepo>;
  traces: ReturnType<typeof makeTracesRepo>;
  worldModel: ReturnType<typeof makeWorldModelRepo>;
}

export function makeRepos(db: StorageDb): Repos {
  const kv = makeKvRepo(db);
  return {
    apiLogs: makeApiLogsRepo(db),
    audit: makeAuditRepo(db),
    candidatePool: makeCandidatePoolRepo(db),
    decisionRepairs: makeDecisionRepairsRepo(db),
    embeddingRetryQueue: makeEmbeddingRetryQueueRepo(db),
    episodes: makeEpisodesRepo(db),
    feedback: makeFeedbackRepo(db),
    hub: makeHubRepo(db, kv),
    kv,
    migrations: makeMigrationsRepo(db),
    policies: makePoliciesRepo(db),
    sessions: makeSessionsRepo(db),
    skillTrials: makeSkillTrialsRepo(db),
    skills: makeSkillsRepo(db),
    tracePolicyLinks: makeTracePolicyLinksRepo(db),
    traces: makeTracesRepo(db),
    worldModel: makeWorldModelRepo(db),
  };
}

// Also re-export each factory in case callers want just one.
export { makeApiLogsRepo } from "./api_logs.js";
export { makeAuditRepo } from "./audit.js";
export { makeCandidatePoolRepo } from "./candidate_pool.js";
export { makeDecisionRepairsRepo } from "./decision_repairs.js";
export { makeEmbeddingRetryQueueRepo } from "./embedding_retry_queue.js";
export { makeEpisodesRepo } from "./episodes.js";
export { makeFeedbackRepo } from "./feedback.js";
export { makeHubRepo } from "./hub.js";
export { makeKvRepo } from "./kv.js";
export { makeMigrationsRepo } from "./migrations.js";
export { makePoliciesRepo } from "./policies.js";
export { makeSessionsRepo } from "./sessions.js";
export { makeSkillTrialsRepo } from "./skill_trials.js";
export { makeSkillsRepo } from "./skills.js";
export { makeTracePolicyLinksRepo } from "./trace-policy-links.js";
export { makeTracesRepo } from "./traces.js";
export { makeWorldModelRepo } from "./world_model.js";

// ─── Embedding maintenance — SQL fast path ──────────────────────────────────
//
// `GET /api/v1/embeddings/maintenance` used to paginate every row of
// `traces` / `policies` / `world_model` / `skills` and hydrate the BLOB
// vector columns into JS purely to inspect each vector's length.
// On a ~93K-row deployment that pulled ~270 MB through better-sqlite3
// on the main thread and blocked the event loop for 4+ minutes
// (https://github.com/MemTensor/MemOS/issues/1929).
//
// This helper replaces that path with five `SELECT COUNT(*) +
// SUM(CASE WHEN ...)` queries — one per (table, vec column). Only the
// BLOB header is read (`LENGTH(vec)` does not deserialise the BLOB
// payload), so the call stays in single-millisecond territory even
// on multi-GB databases.

/** Per-kind bucket of slot counts produced by `embeddingMaintenanceCounts`. */
export interface EmbeddingCountsBucket {
  /** Number of (row × vec column) slots considered by this bucket. */
  totalSlots: number;
  /** Vec is non-null AND (expectedByteLen=0 OR LENGTH(vec) = expectedByteLen). */
  ready: number;
  /** Vec column IS NULL. */
  missing: number;
  /** Vec is non-null but its byte length ≠ expectedByteLen (only when expectedByteLen > 0). */
  dimMismatch: number;
}

export interface EmbeddingCounts {
  trace: EmbeddingCountsBucket;
  policy: EmbeddingCountsBucket;
  world_model: EmbeddingCountsBucket;
  skill: EmbeddingCountsBucket;
}

/**
 * Reusable WHERE fragment that mirrors `shouldTraceHaveEmbeddings(row)`
 * in `core/pipeline/memory-core.ts`. A trace only contributes to an
 * embedding slot if at least one of user_text / agent_text has
 * meaningful content (≥10 chars) AND the combined text is ≥20 chars.
 * Without this filter the SQL counts would balloon every short
 * "ok"/"got it" trace into a phantom "missing vector" row.
 */
const TRACE_QUALIFIES_FOR_VEC =
  "(LENGTH(TRIM(COALESCE(user_text, ''))) >= 10 " +
  "OR LENGTH(TRIM(COALESCE(agent_text, ''))) >= 10) " +
  "AND (LENGTH(TRIM(COALESCE(user_text, ''))) " +
  "+ LENGTH(TRIM(COALESCE(agent_text, ''))) >= 20)";

/**
 * Action vectors are skipped for lightweight-memory traces. Matches
 * `isLightweightMemoryTrace(row)` in `core/pipeline/memory-core.ts`:
 *   `row.tags.includes("lightweight_memory")`.
 * `tags_json` is a JSON array stored as TEXT; we match the quoted
 * element string so a tag named `"lightweight_memory_v2"` does not
 * fire a false positive.
 */
const TRACE_NOT_LIGHTWEIGHT =
  "instr(COALESCE(tags_json, ''), '\"lightweight_memory\"') = 0";

/**
 * SQL-only embedding-slot counter. Returns the same per-kind counts the
 * old slot-enumeration path used to compute in JS, but without reading
 * a single vector BLOB into JS memory.
 *
 * `expectedByteLen` is the Float32-encoded byte length the BLOB must
 * match to count as `ready` (i.e. `dimensions * 4`). Pass `0` when the
 * embedder has not been probed yet — the helper then counts any
 * non-null vector as `ready` and never reports `dimMismatch`. This
 * mirrors the pre-fix fallback where `inferStoredEmbeddingDimension`
 * returned `0` on a brand-new install.
 */
export function embeddingMaintenanceCounts(
  db: StorageDb,
  opts: { expectedByteLen: number },
): EmbeddingCounts {
  const expectedByteLen = Math.max(0, Math.floor(opts.expectedByteLen || 0));
  return {
    trace: traceCounts(db, expectedByteLen),
    policy: simpleCounts(db, "policies", "vec", expectedByteLen),
    world_model: simpleCounts(db, "world_model", "vec", expectedByteLen),
    skill: simpleCounts(db, "skills", "vec", expectedByteLen),
  };
}

function traceCounts(db: StorageDb, expectedByteLen: number): EmbeddingCountsBucket {
  const summary = countColumn(db, {
    table: "traces",
    column: "vec_summary",
    expectedByteLen,
    whereExtra: TRACE_QUALIFIES_FOR_VEC,
  });
  const action = countColumn(db, {
    table: "traces",
    column: "vec_action",
    expectedByteLen,
    whereExtra: `${TRACE_QUALIFIES_FOR_VEC} AND ${TRACE_NOT_LIGHTWEIGHT}`,
  });
  return {
    totalSlots: summary.totalSlots + action.totalSlots,
    ready: summary.ready + action.ready,
    missing: summary.missing + action.missing,
    dimMismatch: summary.dimMismatch + action.dimMismatch,
  };
}

function simpleCounts(
  db: StorageDb,
  table: string,
  column: string,
  expectedByteLen: number,
): EmbeddingCountsBucket {
  return countColumn(db, { table, column, expectedByteLen });
}

interface CountColumnOpts {
  table: string;
  column: string;
  expectedByteLen: number;
  whereExtra?: string;
}

interface CountColumnRow {
  total: number;
  missing: number;
  dim_mismatch: number;
  ready: number;
}

function countColumn(db: StorageDb, opts: CountColumnOpts): EmbeddingCountsBucket {
  const { table, column, expectedByteLen, whereExtra } = opts;
  // `expectedByteLen` is interpolated as a positive integer literal
  // (not a parameter) so the comparison is constant-folded by SQLite
  // and the helper has nothing to bind on small / empty databases.
  // Values come from `Math.floor(...)` on a JS number — no user input
  // reaches this string.
  const lenLiteral = expectedByteLen.toString();
  const dimEnabled = expectedByteLen > 0;
  const dimMismatchExpr = dimEnabled
    ? `${column} IS NOT NULL AND LENGTH(${column}) <> ${lenLiteral}`
    : "0";
  const readyExpr = dimEnabled
    ? `${column} IS NOT NULL AND LENGTH(${column}) = ${lenLiteral}`
    : `${column} IS NOT NULL`;
  const whereClause = whereExtra ? ` WHERE ${whereExtra}` : "";
  const sql =
    `SELECT COUNT(*) AS total, ` +
    `SUM(CASE WHEN ${column} IS NULL THEN 1 ELSE 0 END) AS missing, ` +
    `SUM(CASE WHEN ${dimMismatchExpr} THEN 1 ELSE 0 END) AS dim_mismatch, ` +
    `SUM(CASE WHEN ${readyExpr} THEN 1 ELSE 0 END) AS ready ` +
    `FROM ${table}${whereClause}`;
  const row = db.prepare<undefined, CountColumnRow>(sql).get();
  return {
    totalSlots: row?.total ?? 0,
    ready: row?.ready ?? 0,
    missing: row?.missing ?? 0,
    dimMismatch: row?.dim_mismatch ?? 0,
  };
}

/**
 * Cheap mode-finder used when the embedder has not been probed yet so
 * `dimensions` is still `0`. Returns the BLOB byte length that occurs
 * most often in stored `traces.vec_summary` rows (or 0 if no vectors
 * are stored at all). Uses a single `GROUP BY LENGTH(vec_summary)` —
 * the BLOB header is touched, the BLOB body is not.
 */
export function inferStoredEmbeddingByteLen(db: StorageDb): number {
  const sql =
    "SELECT LENGTH(vec_summary) AS len, COUNT(*) AS n " +
    "FROM traces WHERE vec_summary IS NOT NULL " +
    "GROUP BY len ORDER BY n DESC LIMIT 1";
  const row = db
    .prepare<undefined, { len: number | null; n: number }>(sql)
    .get();
  return row?.len ?? 0;
}
