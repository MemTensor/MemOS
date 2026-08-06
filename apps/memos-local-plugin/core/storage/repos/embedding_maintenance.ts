/**
 * SQL-only embedding maintenance stats.
 *
 * Regression fix for issue #1929: `/api/v1/embeddings/maintenance` used to
 * paginate every trace/policy/world_model/skill row through JS just to
 * inspect vector byte lengths, hydrating hundreds of MB of BLOBs into the
 * Node heap and blocking the event loop for minutes on production DBs
 * (93K traces × 2 vectors × 1536 dims × 4 bytes ≈ 1.1 GB pread64 traffic).
 *
 * The strategy is a single `SELECT COUNT(*) + SUM(CASE WHEN ...)` per
 * `(table, vec column)` pair, using `LENGTH(vec)` for the dimension
 * comparison. SQLite's `LENGTH()` on a BLOB column returns the byte length
 * from the row header and does not deserialise the buffer, so the maintenance
 * call now stays in the same asymptotic ballpark as `SELECT COUNT(*) FROM t`.
 *
 * The two pre-fix semantic filters are preserved verbatim inside the WHERE
 * clauses so per-bucket counts do not shift for already-installed users:
 *
 *   - `shouldTraceHaveEmbeddings` (short-text traces skipped) → SQL
 *     `LENGTH(TRIM(user_text)) / LENGTH(TRIM(agent_text))` predicates.
 *   - `isLightweightMemoryTrace` (lightweight traces skip vec_action) →
 *     `instr(COALESCE(tags_json, ''), '"lightweight_memory"') = 0`
 *     predicate for the vec_action count only.
 */

import type { StorageDb } from "../types.js";

/** Little-endian Float32 element size. Matches `core/storage/vector.ts`. */
export const FLOAT32_BYTES = 4;

export interface EmbeddingCountsBucket {
  /** Number of `(row, vec column)` slots included in the bucket. */
  totalSlots: number;
  /**
   * Vec is non-NULL and either `expectedByteLen === 0` (dimension not
   * probed yet) or `LENGTH(vec) === expectedByteLen`.
   */
  ready: number;
  /** Vec is SQL NULL. */
  missing: number;
  /**
   * Vec is non-NULL and its byte length ≠ `expectedByteLen`
   * (only meaningful when `expectedByteLen > 0`).
   */
  dimMismatch: number;
}

export interface EmbeddingCounts {
  trace: EmbeddingCountsBucket;
  policy: EmbeddingCountsBucket;
  world_model: EmbeddingCountsBucket;
  skill: EmbeddingCountsBucket;
}

interface CountRow {
  total: number | null;
  missing: number | null;
  dim_mismatch: number | null;
  ready: number | null;
}

interface CountArgs {
  expected_byte_len: number;
}

/**
 * SQL for the four `(table, vec column)` slots. Each query returns
 * `(total, missing, dim_mismatch, ready)` for a single slot in one round-trip.
 *
 * `LENGTH(vec)` on a BLOB column returns the stored byte count without
 * deserialising the BLOB into JS memory — this is the whole point of the
 * fix (see #1929 evidence: 99.96 % of the pre-fix time was in `pread64`).
 */
const TRACE_QUALIFICATION =
  "(LENGTH(TRIM(user_text)) >= 10 OR LENGTH(TRIM(agent_text)) >= 10) " +
  "AND (LENGTH(TRIM(user_text)) + LENGTH(TRIM(agent_text)) >= 20)";

/** Build the count SQL for a single (table, column) slot. */
function slotSql(
  table: string,
  column: string,
  extraWhere: string = "",
): string {
  const clauses: string[] = [];
  if (table === "traces") clauses.push(TRACE_QUALIFICATION);
  if (extraWhere) clauses.push(extraWhere);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return `
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN ${column} IS NULL THEN 1 ELSE 0 END) AS missing,
      SUM(CASE WHEN ${column} IS NOT NULL
                AND @expected_byte_len > 0
                AND LENGTH(${column}) <> @expected_byte_len
               THEN 1 ELSE 0 END) AS dim_mismatch,
      SUM(CASE WHEN ${column} IS NOT NULL
                AND (@expected_byte_len = 0 OR LENGTH(${column}) = @expected_byte_len)
               THEN 1 ELSE 0 END) AS ready
    FROM ${table}
    ${where}
  `;
}

function normalizeRow(row: CountRow | undefined): EmbeddingCountsBucket {
  if (!row) {
    return { totalSlots: 0, ready: 0, missing: 0, dimMismatch: 0 };
  }
  return {
    totalSlots: row.total ?? 0,
    ready: row.ready ?? 0,
    missing: row.missing ?? 0,
    dimMismatch: row.dim_mismatch ?? 0,
  };
}

/**
 * Count embedding slots per (table, vec column) purely with SQL.
 *
 * MUST NOT read or decode any BLOB into JS. Total wall-clock work is
 * `O(rows)` SQL scan touching only BLOB header bytes.
 *
 * @param db - open storage handle (better-sqlite3 wrapper).
 * @param opts.expectedByteLen - `dimensions * 4` for a known Float32
 *   dimension, or `0` when the dimension has not been probed yet. In the
 *   `0` fallback every non-NULL vector counts as ready and dimMismatch
 *   is always 0 — matches the pre-fix "any non-null = ready" behaviour
 *   that `inferStoredEmbeddingDimension(slots)` used to fall back to.
 */
export function embeddingMaintenanceCounts(
  db: StorageDb,
  opts: { expectedByteLen: number },
): EmbeddingCounts {
  const args: CountArgs = {
    expected_byte_len: Math.max(0, Math.floor(opts.expectedByteLen) || 0),
  };

  const traceSummary = db
    .prepare<CountArgs, CountRow>(slotSql("traces", "vec_summary"))
    .get(args);
  const traceAction = db
    .prepare<CountArgs, CountRow>(
      slotSql(
        "traces",
        "vec_action",
        "instr(COALESCE(tags_json, ''), '\"lightweight_memory\"') = 0",
      ),
    )
    .get(args);
  const policy = db
    .prepare<CountArgs, CountRow>(slotSql("policies", "vec"))
    .get(args);
  const worldModel = db
    .prepare<CountArgs, CountRow>(slotSql("world_model", "vec"))
    .get(args);
  const skill = db
    .prepare<CountArgs, CountRow>(slotSql("skills", "vec"))
    .get(args);

  const summary = normalizeRow(traceSummary);
  const action = normalizeRow(traceAction);

  return {
    trace: {
      totalSlots: summary.totalSlots + action.totalSlots,
      ready: summary.ready + action.ready,
      missing: summary.missing + action.missing,
      dimMismatch: summary.dimMismatch + action.dimMismatch,
    },
    policy: normalizeRow(policy),
    world_model: normalizeRow(worldModel),
    skill: normalizeRow(skill),
  };
}

interface ModeRow {
  byte_len: number;
  n: number;
}

/**
 * Infer the dominant stored embedding byte length by GROUP BY the byte
 * length of every non-NULL `traces.vec_summary` BLOB. Returns the byte
 * length with the highest row count, or 0 when the DB has no vectors
 * (brand-new install).
 *
 * Cheap replacement for the pre-fix
 * `inferStoredEmbeddingDimension(collectEmbeddingSlots())` path — which had
 * to hydrate every BLOB in memory before it could measure any single one.
 * We now let SQLite do the length arithmetic and just pick the mode.
 */
export function inferStoredEmbeddingByteLen(db: StorageDb): number {
  const rows = db
    .prepare<undefined, ModeRow>(
      `SELECT LENGTH(vec_summary) AS byte_len, COUNT(*) AS n
       FROM traces
       WHERE vec_summary IS NOT NULL AND LENGTH(vec_summary) > 0
       GROUP BY LENGTH(vec_summary)
       ORDER BY n DESC
       LIMIT 1`,
    )
    .all();
  if (rows.length === 0) return 0;
  return rows[0]!.byte_len;
}
