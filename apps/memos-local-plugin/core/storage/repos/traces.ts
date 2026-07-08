import type { ToolCallDTO } from "../../../agent-contract/dto.js";
import type { EmbeddingVector, EpisodeId, SessionId, ShareScope, TraceId, TraceRow } from "../../types.js";
import type { StorageDb, TraceListFilter } from "../types.js";
import { buildInClause, buildInsert, buildUpdate } from "../tx.js";
import { scanAndTopK, topKCosine, type VectorHit, type VectorRow } from "../vector.js";
import {
  buildPageClauses,
  fromBlob,
  fromJsonText,
  joinWhere,
  normalizeShareForStorage,
  nullable,
  ownerFieldsFromRaw,
  ownerParamsFromRow,
  timeRangeWhere,
  toBlob,
  toJsonText,
} from "./_helpers.js";

const COLUMNS = [
  "id",
  "episode_id",
  "session_id",
  "owner_agent_kind",
  "owner_profile_id",
  "owner_workspace_id",
  "ts",
  "user_text",
  "agent_text",
  "summary",
  "tool_calls_json",
  "reflection",
  "agent_thinking",
  "value",
  "alpha",
  "r_human",
  "priority",
  "tags_json",
  "error_signatures_json",
  "vec_summary",
  "vec_action",
  "share_scope",
  "share_target",
  "shared_at",
  "turn_id",
  "schema_version",
];

export type TraceSearchMeta = {
  ts: number;
  priority: number;
  value: number;
  episode_id: EpisodeId;
  session_id: SessionId;
  owner_agent_kind?: string;
  owner_profile_id?: string;
  owner_workspace_id?: string | null;
  tags_json?: string;
  error_signatures_json?: string;
};

/**
 * Narrow row shape returned by {@link listDedupRowsForEpisode}. Includes
 * exactly the fields the capture-side dedup path needs (see
 * `traceIdentitySignature` / `runLite` / `runLightweight` in
 * `core/capture/capture.ts`). Deliberately excludes the two big BLOB
 * columns (`vec_summary`, `vec_action`) so an episode with 500k rows
 * can be scanned without pulling ~4 GB of embeddings into JS memory —
 * the root pathology in #2076.
 */
export interface TraceDedupRow {
  ts: number;
  turnId: number;
  userText: string;
  agentText: string;
  toolCalls: ToolCallDTO[];
}

interface RawDedupRow {
  ts: number;
  turn_id: number;
  user_text: string;
  agent_text: string;
  tool_calls_json: string;
}

const DEDUP_COLUMNS = [
  "ts",
  "turn_id",
  "user_text",
  "agent_text",
  "tool_calls_json",
] as const;

export function makeTracesRepo(db: StorageDb) {
  const insert = db.prepare(buildInsert({ table: "traces", columns: COLUMNS }));
  const upsert = db.prepare(
    buildInsert({ table: "traces", columns: COLUMNS, onConflict: "replace" }),
  );
  const updateScalars = db.prepare(
    buildUpdate({
      table: "traces",
      columns: ["id", "value", "alpha", "r_human", "priority"],
    }),
  );
  const selectById = db.prepare<{ id: string }, RawTraceRow>(
    `SELECT ${COLUMNS.join(", ")} FROM traces WHERE id=@id`,
  );

  return {
    insert(row: TraceRow): void {
      insert.run(rowToParams(row));
    },

    upsert(row: TraceRow): void {
      upsert.run(rowToParams(row));
    },

    updateScore(
      id: TraceId,
      scores: { value: number; alpha: number; rHuman?: number | null; priority: number },
    ): void {
      updateScalars.run({
        id,
        value: scores.value,
        alpha: scores.alpha,
        r_human: nullable(scores.rHuman ?? null) as number | null,
        priority: scores.priority,
      });
    },

    getById(id: TraceId): TraceRow | null {
      const r = selectById.get({ id });
      if (!r) return null;
      return mapRow(r);
    },

    getManyByIds(ids: readonly TraceId[]): TraceRow[] {
      if (ids.length === 0) return [];
      const placeholders = buildInClause(ids.length);
      const sql = `SELECT ${COLUMNS.join(", ")} FROM traces WHERE id ${placeholders}`;
      const rows = db.prepare<readonly string[], RawTraceRow>(sql).all(ids);
      return rows.map(mapRow);
    },

    /**
     * Cheap existence check: does ANY trace in `ids` carry a timestamp
     * strictly greater than `ts`?
     *
     * Designed for the startup "dirty-closed-episode" scan in
     * `memory-core.init()` — the old code path called
     * `getManyByIds(ids).some(tr => tr.ts > ts)`, which hydrated every
     * column (embedding BLOBs, full `tool_calls_json` text, agent text)
     * purely to inspect a single number. On multi-hundred-MB databases
     * that single call dwarfed everything else during bridge bootstrap
     * (https://github.com/MemTensor/MemOS/issues/1787).
     *
     * This helper issues a single `SELECT 1 ... LIMIT 1` per chunk.
     * SQLite short-circuits as soon as it finds one match, so the cost
     * is O(chunk size) rather than O(total trace bytes).
     */
    hasAnyNewerThan(ids: readonly TraceId[], ts: number): boolean {
      if (ids.length === 0) return false;
      // Process in chunks to avoid hitting parameter limits.
      const CHUNK_SIZE = 900;
      for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
        const chunk = ids.slice(i, i + CHUNK_SIZE);
        const placeholders = buildInClause(chunk.length);
        const sql = `SELECT 1 FROM traces WHERE id ${placeholders} AND ts > ? LIMIT 1`;
        const row = db.prepare<[...string[], number], { 1: number }>(sql).get([...chunk, ts]);
        if (row) return true;
      }
      return false;
    },

    /**
     * Count how many of the given IDs actually exist in the `traces` table.
     *
     * Used by the reward-dirty check
     * (https://github.com/MemTensor/MemOS/issues/1966) to tolerate "ghost"
     * trace IDs — entries that linger in `episodes.trace_ids_json` but whose
     * backing trace row was deleted (manual cleanup, schema migration, etc.).
     * Without this, comparing `reward.traceCount` against
     * `episode.traceIds.length` triggers an infinite rescore loop whenever
     * `length` includes ghosts that the reward pipeline already filtered out.
     *
     * Uses a single `SELECT COUNT(*)` per chunk so the cost is independent of
     * row size — embedding BLOBs and `tool_calls_json` are never read.
     */
    countExisting(ids: readonly TraceId[]): number {
      if (ids.length === 0) return 0;
      // De-duplicate so the count reflects distinct IDs, matching the
      // semantics of `getManyByIds(ids).length` which also dedupes.
      const dedup = Array.from(new Set(ids));
      const CHUNK_SIZE = 900;
      let total = 0;
      for (let i = 0; i < dedup.length; i += CHUNK_SIZE) {
        const chunk = dedup.slice(i, i + CHUNK_SIZE);
        const placeholders = buildInClause(chunk.length);
        const sql = `SELECT COUNT(*) AS n FROM traces WHERE id ${placeholders}`;
        const row = db
          .prepare<readonly string[], { n: number }>(sql)
          .get(chunk);
        total += row?.n ?? 0;
      }
      return total;
    },

    /**
     * Return the subset of `ids` that actually exist in the `traces` table,
     * preserving the input order and de-duplicating. Companion to
     * `countExisting`; used by `episodes.appendTrace` to strip ghost IDs at
     * write time (#1966).
     */
    filterExistingIds(ids: readonly TraceId[]): TraceId[] {
      if (ids.length === 0) return [];
      const dedup = Array.from(new Set(ids));
      const existing = new Set<string>();
      const CHUNK_SIZE = 900;
      for (let i = 0; i < dedup.length; i += CHUNK_SIZE) {
        const chunk = dedup.slice(i, i + CHUNK_SIZE);
        const placeholders = buildInClause(chunk.length);
        const sql = `SELECT id FROM traces WHERE id ${placeholders}`;
        const rows = db.prepare<readonly string[], { id: string }>(sql).all(chunk);
        for (const r of rows) existing.add(r.id);
      }
      return dedup.filter((id) => existing.has(id));
    },

    list(filter: TraceListFilter = {}): TraceRow[] {
      const tr = timeRangeWhere(filter, "ts");
      const fragments: string[] = [];
      const params: Record<string, unknown> = { ...tr.params };
      if (filter.sessionId) {
        fragments.push(`session_id = @session_id`);
        params.session_id = filter.sessionId;
      }
      if (filter.episodeId) {
        fragments.push(`episode_id = @episode_id`);
        params.episode_id = filter.episodeId;
      }
      if (filter.ownerAgentKind) {
        fragments.push(`owner_agent_kind = @owner_agent_kind`);
        params.owner_agent_kind = filter.ownerAgentKind;
      }
      if (filter.ownerProfileId) {
        fragments.push(`owner_profile_id = @owner_profile_id`);
        params.owner_profile_id = filter.ownerProfileId;
      }
      if (filter.minAbsValue !== undefined) {
        fragments.push(`abs(value) >= @min_abs_value`);
        params.min_abs_value = filter.minAbsValue;
      }
      if (tr.sql) fragments.push(tr.sql);
      const where = joinWhere(fragments);
      const page = buildPageClauses(filter, "ts");
      const sql = `SELECT ${COLUMNS.join(", ")} FROM traces ${where} ${page}`;
      return db.prepare<typeof params, RawTraceRow>(sql).all(params).map(mapRow);
    },

    /**
     * Full episode-scoped trace fetch with NO pagination cap.
     *
     * The paginated `list({ episodeId })` path silently truncates to
     * `PageOptions.limit`, which caps at 500 by default. That cap
     * breaks capture-side dedup (#2076): when an episode grows past
     * the cap, the next runLite / runReflect only sees the newest
     * 500 rows, treats every older step as "novel", and re-inserts
     * the whole tail every cycle. In the reporter's 4.2 GB / 6.8 GB
     * failure, 518,375 trace rows had shrunk to 80,583 distinct
     * `(episode_id, turn_id, user_text, agent_text, tool_calls_json)`
     * signatures — 84 % duplicates driven by exactly this loop.
     *
     * Use this helper for any dedup / reconciliation read that must
     * see the whole episode. All hot fields required by dedup are
     * projected, so a caller that only needs `ts`, `turnId`, or the
     * identity signature can still iterate at full speed without
     * paying the paginated round trips.
     *
     * Rows are ordered by `ts ASC` so the causal chain matches the
     * order runLite / runReflect built.
     */
    listAllForEpisode(episodeId: EpisodeId | string): TraceRow[] {
      if (!episodeId) return [];
      const sql = `SELECT ${COLUMNS.join(
        ", ",
      )} FROM traces WHERE episode_id = @episode_id ORDER BY ts ASC`;
      const rows = db
        .prepare<{ episode_id: string }, RawTraceRow>(sql)
        .all({ episode_id: String(episodeId) });
      return rows.map(mapRow);
    },

    /**
     * Streaming, narrow-projection sibling of {@link listAllForEpisode}.
     *
     * Every capture-side dedup call-site (see `runLite`, `runLightweight`,
     * `persistRows` in `core/capture/capture.ts`) needs only the five
     * dedup identity fields — never the `vec_summary` / `vec_action`
     * BLOBs which dominate row size. This helper projects exactly those
     * columns and streams via `.iterate()` so peak memory scales with
     * the scalar payload, not the total embedding footprint.
     *
     * Same episode-scoping / `ts ASC` ordering contract as
     * `listAllForEpisode`; the two are drop-in siblings for callers that
     * only need dedup identity.
     */
    listDedupRowsForEpisode(episodeId: EpisodeId | string): TraceDedupRow[] {
      if (!episodeId) return [];
      const sql = `SELECT ${DEDUP_COLUMNS.join(
        ", ",
      )} FROM traces WHERE episode_id = @episode_id ORDER BY ts ASC`;
      const stmt = db.prepare<{ episode_id: string }, RawDedupRow>(sql);
      const rows: TraceDedupRow[] = [];
      for (const r of stmt.iterate({ episode_id: String(episodeId) })) {
        rows.push({
          ts: r.ts,
          turnId: r.turn_id,
          userText: r.user_text,
          agentText: r.agent_text,
          toolCalls: fromJsonText<ToolCallDTO[]>(r.tool_calls_json, []),
        });
      }
      return rows;
    },

    /**
     * Total row count matching the same filter (no limit/offset).
     * Used by list endpoints so the viewer can show "Page N of M".
     */
    count(
      filter: Omit<TraceListFilter, "limit" | "offset"> = {},
      visibility?: { sql: string; params: Record<string, unknown> },
    ): number {
      const tr = timeRangeWhere(filter, "ts");
      const fragments: string[] = [];
      const params: Record<string, unknown> = { ...tr.params };
      if (filter.sessionId) {
        fragments.push(`session_id = @session_id`);
        params.session_id = filter.sessionId;
      }
      if (filter.episodeId) {
        fragments.push(`episode_id = @episode_id`);
        params.episode_id = filter.episodeId;
      }
      if (filter.ownerAgentKind) {
        fragments.push(`owner_agent_kind = @owner_agent_kind`);
        params.owner_agent_kind = filter.ownerAgentKind;
      }
      if (filter.ownerProfileId) {
        fragments.push(`owner_profile_id = @owner_profile_id`);
        params.owner_profile_id = filter.ownerProfileId;
      }
      if (filter.minAbsValue !== undefined) {
        fragments.push(`abs(value) >= @min_abs_value`);
        params.min_abs_value = filter.minAbsValue;
      }
      if (visibility) {
        fragments.push(visibility.sql);
        Object.assign(params, visibility.params);
      }
      if (tr.sql) fragments.push(tr.sql);
      const where = joinWhere(fragments);
      const sql = `SELECT COUNT(*) AS n FROM traces ${where}`;
      const row = db.prepare<typeof params, { n: number }>(sql).get(params);
      return row?.n ?? 0;
    },

    /**
     * Count distinct (episode_id, turn_id) groups — i.e. "memory turns",
     * where one user query + its tool sub-steps + final reply are
     * counted as 1. Used by the Memories viewer for accurate pagination.
     */
    countTurns(
      filter: Omit<TraceListFilter, "limit" | "offset"> = {},
      visibility?: { sql: string; params: Record<string, unknown> },
    ): number {
      const fragments: string[] = [];
      const params: Record<string, unknown> = {};
      if (filter.sessionId) {
        fragments.push(`session_id = @session_id`);
        params.session_id = filter.sessionId;
      }
      if (filter.episodeId) {
        fragments.push(`episode_id = @episode_id`);
        params.episode_id = filter.episodeId;
      }
      if (filter.ownerAgentKind) {
        fragments.push(`owner_agent_kind = @owner_agent_kind`);
        params.owner_agent_kind = filter.ownerAgentKind;
      }
      if (filter.ownerProfileId) {
        fragments.push(`owner_profile_id = @owner_profile_id`);
        params.owner_profile_id = filter.ownerProfileId;
      }
      if (visibility) {
        fragments.push(visibility.sql);
        Object.assign(params, visibility.params);
      }
      const where = joinWhere(fragments);
      const sql = `SELECT COUNT(*) AS n FROM (SELECT DISTINCT episode_id, turn_id FROM traces ${where})`;
      const row = db.prepare<typeof params, { n: number }>(sql).get(params);
      return row?.n ?? 0;
    },

    /**
     * List paginated turn keys (episode_id, turn_id) ordered by the
     * turn's most recent trace timestamp DESC. The viewer uses this to
     * fetch a page of "memories" (1 turn = 1 memory).
     */
    listTurnKeys(
      filter: TraceListFilter = {},
      visibility?: { sql: string; params: Record<string, unknown> },
    ): Array<{ episodeId: string | null; turnId: number; maxTs: number }> {
      const fragments: string[] = [];
      const params: Record<string, unknown> = {};
      if (filter.sessionId) {
        fragments.push(`session_id = @session_id`);
        params.session_id = filter.sessionId;
      }
      if (filter.episodeId) {
        fragments.push(`episode_id = @episode_id`);
        params.episode_id = filter.episodeId;
      }
      if (filter.ownerAgentKind) {
        fragments.push(`owner_agent_kind = @owner_agent_kind`);
        params.owner_agent_kind = filter.ownerAgentKind;
      }
      if (filter.ownerProfileId) {
        fragments.push(`owner_profile_id = @owner_profile_id`);
        params.owner_profile_id = filter.ownerProfileId;
      }
      if (visibility) {
        fragments.push(visibility.sql);
        Object.assign(params, visibility.params);
      }
      const where = joinWhere(fragments);
      const limit = Math.max(1, Math.min(10_000, filter.limit ?? 50));
      const offset = Math.max(0, filter.offset ?? 0);
      params.limit = limit;
      params.offset = offset;
      const sql = `SELECT episode_id, turn_id, MAX(ts) as max_ts FROM traces ${where} GROUP BY episode_id, turn_id ORDER BY max_ts DESC LIMIT @limit OFFSET @offset`;
      const rows = db
        .prepare<typeof params, { episode_id: string | null; turn_id: number; max_ts: number }>(sql)
        .all(params);
      return rows.map((r) => ({ episodeId: r.episode_id, turnId: r.turn_id, maxTs: r.max_ts }));
    },

    /**
     * Fetch all traces belonging to the given (episodeId, turnId) pairs.
     * Returned rows are ordered by ts ascending so the frontend can
     * render the conversation in chronological order.
     */
    listByTurnKeys(keys: ReadonlyArray<{ episodeId: string | null; turnId: number }>): TraceRow[] {
      if (keys.length === 0) return [];
      const conditions: string[] = [];
      const params: Record<string, unknown> = {};
      keys.forEach((k, i) => {
        if (k.episodeId == null) {
          conditions.push(`(episode_id IS NULL AND turn_id = @turn_${i})`);
        } else {
          conditions.push(`(episode_id = @ep_${i} AND turn_id = @turn_${i})`);
          params[`ep_${i}`] = k.episodeId;
        }
        params[`turn_${i}`] = k.turnId;
      });
      const sql = `SELECT ${COLUMNS.join(", ")} FROM traces WHERE ${conditions.join(" OR ")} ORDER BY ts ASC`;
      return db.prepare<typeof params, RawTraceRow>(sql).all(params).map(mapRow);
    },

    /**
     * Vector top-K over `vec_summary` (or `vec_action` if `kind='action'`).
     * The caller passes any extra SQL filter (e.g. same-episode only).
     */
    searchByVector(
      query: EmbeddingVector,
      k: number,
      opts: {
        kind?: "summary" | "action";
        where?: string;
        params?: Record<string, unknown>;
        hardCap?: number;
        /**
         * Tag-based pre-filter. Candidate row survives if ANY of its stored
         * tags appears in this list (`instr(tags_json, '"docker"') > 0`).
         * Pass empty or undefined to disable.
         */
        anyOfTags?: readonly string[];
      } = {},
    ): Array<VectorHit<string, TraceSearchMeta>> {
      const kind = opts.kind ?? "summary";
      const vecColumn = kind === "action" ? "vec_action" : "vec_summary";
      const params: Record<string, unknown> = { ...(opts.params ?? {}) };
      const whereParts = [`${vecColumn} IS NOT NULL`];
      if (opts.where) whereParts.push(opts.where);
      if (opts.anyOfTags && opts.anyOfTags.length > 0) {
        const tagOrs: string[] = [];
        opts.anyOfTags.forEach((tag, i) => {
          const key = `tag_${i}`;
          params[key] = `"${String(tag).replace(/["\\]/g, "\\$&")}"`;
          tagOrs.push(`instr(tags_json, @${key}) > 0`);
        });
        whereParts.push(`(${tagOrs.join(" OR ")})`);
      }
      return scanAndTopK<TraceSearchMeta>(
        db,
        "traces",
        [
          "ts",
          "priority",
          "value",
          "episode_id",
          "session_id",
          "owner_agent_kind",
          "owner_profile_id",
          "owner_workspace_id",
          "tags_json",
        ],
        query,
        k,
        {
          vecColumn,
          where: whereParts.join(" AND "),
          params,
          hardCap: opts.hardCap,
        },
      );
    },

    /**
     * Convenience: in-memory top-K against pre-fetched rows (used when caller
     * has already filtered candidates by other criteria).
     */
    topKAgainstRows<TMeta>(
      query: EmbeddingVector,
      rows: VectorRow<TraceId, TMeta>[],
      k: number,
    ): Array<VectorHit<TraceId, TMeta>> {
      return topKCosine(query, rows, k);
    },

    /**
     * Keyword channel — FTS5 trigram MATCH against `traces_fts`.
     *
     * Returns rank-ordered hits with the same `meta` shape as
     * `searchByVector` so the retrieval ranker can fuse channels via
     * RRF. We don't surface the raw FTS rank here — the caller scores
     * by reciprocal rank in `keyword.reciprocalRankScore`.
     */
    searchByText(
      ftsMatch: string,
      k: number,
      opts: {
        where?: string;
        params?: Record<string, unknown>;
      } = {},
    ): Array<VectorHit<string, TraceSearchMeta>> {
      if (!ftsMatch || k <= 0) return [];
      const params: Record<string, unknown> = {
        ...(opts.params ?? {}),
        match: ftsMatch,
        k: Math.max(1, Math.min(500, Math.floor(k))),
      };
      const extra = opts.where ? `AND (${opts.where})` : "";
      const sql = `
        SELECT t.id          AS id,
               -bm25(traces_fts) AS score,
               t.ts          AS ts,
               t.priority    AS priority,
               t.value       AS value,
               t.episode_id  AS episode_id,
               t.session_id  AS session_id,
               t.owner_agent_kind AS owner_agent_kind,
               t.owner_profile_id AS owner_profile_id,
               t.owner_workspace_id AS owner_workspace_id,
               t.tags_json   AS tags_json,
               t.error_signatures_json AS error_signatures_json
          FROM traces_fts f
          JOIN traces      t ON t.id = f.trace_id
         WHERE traces_fts MATCH @match ${extra}
         ORDER BY rank
         LIMIT @k`;
      const rows = db
        .prepare<typeof params, RawHit>(sql)
        .all(params);
      return rows.map((r, idx) => ({
        id: r.id,
        // Translate FTS rank → score in [0, 1] that's monotone-decreasing.
        // bm25() returns a negative log-prob (smaller magnitude = better);
        // we keep its raw negation for diagnostics but reset score below
        // by index so the ranker's RRF doesn't depend on bm25 magnitude.
        score: 1 / (idx + 1),
        meta: {
          ts: r.ts,
          priority: r.priority,
          value: r.value,
          episode_id: r.episode_id as EpisodeId,
          session_id: r.session_id as SessionId,
          owner_agent_kind: r.owner_agent_kind,
          owner_profile_id: r.owner_profile_id,
          owner_workspace_id: r.owner_workspace_id,
          tags_json: r.tags_json,
          error_signatures_json: r.error_signatures_json,
        },
      }));
    },

    /**
     * Pattern channel — substring fallback for queries that fall below
     * the trigram tokenizer's window (e.g. 2-char Chinese names).
     *
     * Each term in `terms` is searched as `LIKE %term%` over the same
     * text columns the FTS index covers. Multiple terms are OR-ed.
     */
    searchByPattern(
      terms: readonly string[],
      k: number,
      opts: {
        where?: string;
        params?: Record<string, unknown>;
      } = {},
    ): Array<VectorHit<string, TraceSearchMeta>> {
      if (!terms || terms.length === 0 || k <= 0) return [];
      const dedup = Array.from(new Set(terms.map((t) => String(t).trim()).filter(Boolean)));
      if (dedup.length === 0) return [];
      const params: Record<string, unknown> = {
        ...(opts.params ?? {}),
        k: Math.max(1, Math.min(500, Math.floor(k))),
      };
      const ors: string[] = [];
      dedup.slice(0, 16).forEach((t, i) => {
        const key = `pat_${i}`;
        // Escape SQL LIKE wildcards in the user term so a literal `%`
        // doesn't accidentally match everything.
        const escaped = t.replace(/[\\%_]/g, (m) => `\\${m}`);
        params[key] = `%${escaped}%`;
        ors.push(
          `(user_text LIKE @${key} ESCAPE '\\' OR
            agent_text LIKE @${key} ESCAPE '\\' OR
            COALESCE(summary,'') LIKE @${key} ESCAPE '\\' OR
            COALESCE(reflection,'') LIKE @${key} ESCAPE '\\' OR
            tags_json LIKE @${key} ESCAPE '\\')`,
        );
      });
      const extra = opts.where ? ` AND (${opts.where})` : "";
      const sql = `
        SELECT id, ts, priority, value, episode_id, session_id, tags_json,
               owner_agent_kind, owner_profile_id, owner_workspace_id,
               error_signatures_json
          FROM traces
         WHERE (${ors.join(" OR ")})${extra}
         ORDER BY ts DESC
         LIMIT @k`;
      const rows = db.prepare<typeof params, RawHit>(sql).all(params);
      return rows.map((r, idx) => ({
        id: r.id,
        score: 1 / (idx + 1),
        meta: {
          ts: r.ts,
          priority: r.priority,
          value: r.value,
          episode_id: r.episode_id as EpisodeId,
          session_id: r.session_id as SessionId,
          owner_agent_kind: r.owner_agent_kind,
          owner_profile_id: r.owner_profile_id,
          owner_workspace_id: r.owner_workspace_id,
          tags_json: r.tags_json,
          error_signatures_json: r.error_signatures_json,
        },
      }));
    },

    /**
     * V7 §2.6 structural match — exact-substring lookup on stored error
     * signatures. Returns full `TraceRow` objects, newest first, capped
     * at `limit`. Case-sensitive (signatures are normalised verbatim).
     *
     * If the caller provides multiple `anyOfFragments`, rows that match
     * ANY fragment survive. Empty array returns `[]`.
     */
    searchByErrorSignature(
      anyOfFragments: readonly string[],
      limit: number,
      opts: {
        where?: string;
        params?: Record<string, unknown>;
      } = {},
    ): TraceRow[] {
      if (!anyOfFragments || anyOfFragments.length === 0) return [];
      // Dedup + cap so a runaway caller doesn't blow up the query size.
      const frags = Array.from(new Set(anyOfFragments))
        .filter((f) => typeof f === "string" && f.length >= 6)
        .slice(0, 8);
      if (frags.length === 0) return [];
      const params: Record<string, unknown> = { ...(opts.params ?? {}) };
      const ors: string[] = [];
      frags.forEach((frag, i) => {
        const key = `sig_${i}`;
        // Store as a quoted JSON string fragment so `instr()` matches the
        // exact element boundary (preventing "foo" from matching "foobar").
        params[key] = `"${frag.replace(/["\\]/g, "\\$&")}"`;
        ors.push(`instr(error_signatures_json, @${key}) > 0`);
      });
      const whereParts = [`(${ors.join(" OR ")})`];
      if (opts.where) whereParts.push(opts.where);
      const sql = `SELECT ${COLUMNS.join(
        ", ",
      )} FROM traces WHERE ${whereParts.join(" AND ")} ORDER BY ts DESC LIMIT @limit`;
      params.limit = Math.max(1, Math.min(200, Math.floor(limit)));
      const rows = db.prepare<typeof params, RawTraceRow>(sql).all(params);
      return rows.map(mapRow);
    },

    deleteById(id: TraceId): void {
      // The FTS trigger should remove this row, but doing it explicitly
      // makes deletion idempotent across pre-release DBs with older schemas.
      db.prepare<{ id: string }>(`DELETE FROM traces_fts WHERE trace_id=@id`).run({ id });
      db.prepare<{ id: string }>(`DELETE FROM traces WHERE id=@id`).run({ id });
    },

    /**
     * Partial content patch applied by the viewer's "Edit" modal.
     * Only user-facing text fields are mutable — `ts`, `value`,
     * `alpha`, `priority`, and vectors are owned by the capture /
     * reward pipeline and must NOT be rewritten from the UI.
     */
    updateBody(
      id: TraceId,
      patch: {
        summary?: string | null;
        userText?: string;
        agentText?: string;
        tags?: readonly string[];
      },
    ): void {
      const sets: string[] = [];
      const params: Record<string, unknown> = { id };
      if (patch.summary !== undefined) {
        sets.push("summary = @summary");
        params.summary = patch.summary;
      }
      if (patch.userText !== undefined) {
        sets.push("user_text = @user_text");
        params.user_text = patch.userText;
      }
      if (patch.agentText !== undefined) {
        sets.push("agent_text = @agent_text");
        params.agent_text = patch.agentText;
      }
      if (patch.tags !== undefined) {
        sets.push("tags_json = @tags_json");
        params.tags_json = toJsonText(normalizeTags(patch.tags));
      }
      if (sets.length === 0) return;
      const sql = `UPDATE traces SET ${sets.join(", ")} WHERE id = @id`;
      db.prepare<typeof params>(sql).run(params);
    },

    updateVector(
      id: TraceId,
      field: "vecSummary" | "vecAction",
      vec: EmbeddingVector,
    ): boolean {
      const column = field === "vecAction" ? "vec_action" : "vec_summary";
      const res = db.prepare<{ id: string; vec: Buffer }>(
        `UPDATE traces SET ${column}=@vec WHERE id=@id`,
      ).run({ id, vec: toBlob(vec)! });
      return res.changes > 0;
    },

    /**
     * Fill in reflection + α for a trace that was previously written
     * in the "lite" capture phase (reflection=null, α=0). Invoked
     * at topic-end by the reflect-phase capture pass, which sees the
     * full causal chain and batch-scores every step of the episode
     * at once. Intentionally narrow: no other columns mutate.
     */
    updateReflection(
      id: TraceId,
      patch: { reflection: string | null; alpha: number },
    ): void {
      db.prepare<{
        id: string;
        reflection: string | null;
        alpha: number;
      }>(
        `UPDATE traces SET reflection=@reflection, alpha=@alpha WHERE id=@id`,
      ).run({
        id,
        reflection: patch.reflection,
        alpha: patch.alpha,
      });
    },

    /**
     * Apply a share-state transition. `scope = null` un-shares. The
     * viewer calls this after (optionally) pushing the payload to
     * the Hub — so the pipeline only records local state, never
     * performs the network call itself.
     */
    updateShare(
      id: TraceId,
      share: {
        scope: ShareScope | null;
        target?: string | null;
        sharedAt?: number | null;
      },
    ): void {
      db.prepare<{
        id: string;
        share_scope: string | null;
        share_target: string | null;
        shared_at: number | null;
      }>(
        `UPDATE traces SET share_scope=@share_scope, share_target=@share_target, shared_at=@shared_at WHERE id=@id`,
      ).run({
        id,
        share_scope: normalizeShareForStorage(share.scope),
        share_target: share.target ?? null,
        shared_at: share.sharedAt ?? null,
      });
    },
  };
}

interface RawHit {
  id: string;
  ts: number;
  priority: number;
  value: number;
  episode_id: string;
  session_id: string;
  owner_agent_kind: string;
  owner_profile_id: string;
  owner_workspace_id: string | null;
  tags_json: string;
  error_signatures_json: string;
}

interface RawTraceRow {
  id: string;
  episode_id: string;
  session_id: string;
  owner_agent_kind: string;
  owner_profile_id: string;
  owner_workspace_id: string | null;
  ts: number;
  user_text: string;
  agent_text: string;
  summary: string | null;
  tool_calls_json: string;
  reflection: string | null;
  agent_thinking: string | null;
  value: number;
  alpha: number;
  r_human: number | null;
  priority: number;
  tags_json: string;
  error_signatures_json: string;
  vec_summary: Buffer | null;
  vec_action: Buffer | null;
  share_scope: string | null;
  share_target: string | null;
  shared_at: number | null;
  turn_id: number;
  schema_version: number;
}

function normalizeSignatures(sigs: readonly string[] | undefined): string[] {
  if (!sigs || sigs.length === 0) return [];
  const seen = new Set<string>();
  for (const raw of sigs) {
    const s = String(raw).trim();
    if (s.length < 6 || s.length > 200) continue;
    seen.add(s);
  }
  // Small cap + stable order to keep row size bounded.
  return [...seen].slice(0, 4);
}

function normalizeTags(tags: readonly string[] | undefined): string[] {
  if (!tags || tags.length === 0) return [];
  const seen = new Set<string>();
  for (const t of tags) {
    const n = String(t).trim().toLowerCase();
    if (n.length === 0 || n.length > 48) continue;
    seen.add(n);
  }
  return [...seen].sort();
}

function rowToParams(row: TraceRow): Record<string, unknown> {
  return {
    id: row.id,
    episode_id: row.episodeId,
    session_id: row.sessionId,
    ...ownerParamsFromRow(row),
    ts: row.ts,
    user_text: row.userText,
    agent_text: row.agentText,
    summary: row.summary ?? null,
    tool_calls_json: toJsonText(row.toolCalls ?? []),
    reflection: row.reflection ?? null,
    agent_thinking: row.agentThinking ?? null,
    value: row.value,
    alpha: row.alpha,
    r_human: row.rHuman ?? null,
    priority: row.priority,
    tags_json: toJsonText(normalizeTags(row.tags)),
    error_signatures_json: toJsonText(normalizeSignatures(row.errorSignatures)),
    vec_summary: toBlob(row.vecSummary),
    vec_action: toBlob(row.vecAction),
    share_scope: normalizeShareForStorage(row.share?.scope),
    share_target: row.share?.target ?? null,
    shared_at: row.share?.sharedAt ?? null,
    turn_id: row.turnId ?? null,
    schema_version: row.schemaVersion,
  };
}

function mapRow(r: RawTraceRow): TraceRow {
  return {
    id: r.id,
    episodeId: r.episode_id,
    sessionId: r.session_id,
    ...ownerFieldsFromRaw(r),
    ts: r.ts,
    userText: r.user_text,
    agentText: r.agent_text,
    summary: r.summary ?? null,
    toolCalls: fromJsonText(r.tool_calls_json, []),
    reflection: r.reflection,
    agentThinking: r.agent_thinking ?? null,
    value: r.value,
    alpha: r.alpha,
    rHuman: r.r_human,
    priority: r.priority,
    tags: fromJsonText<string[]>(r.tags_json, []),
    errorSignatures: fromJsonText<string[]>(r.error_signatures_json, []),
    vecSummary: fromBlob(r.vec_summary),
    vecAction: fromBlob(r.vec_action),
    share:
      r.share_scope != null
        ? {
            scope: normalizeShareForStorage(r.share_scope) as ShareScope,
            target: r.share_target,
            sharedAt: r.shared_at,
          }
        : null,
    turnId: r.turn_id,
    schemaVersion: r.schema_version,
  };
}
