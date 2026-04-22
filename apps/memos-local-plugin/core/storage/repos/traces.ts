import type { EmbeddingVector, EpisodeId, SessionId, TraceId, TraceRow } from "../../types.js";
import type { StorageDb, TraceListFilter } from "../types.js";
import { buildInClause, buildInsert, buildUpdate } from "../tx.js";
import { scanAndTopK, topKCosine, type VectorHit, type VectorRow } from "../vector.js";
import {
  buildPageClauses,
  fromBlob,
  fromJsonText,
  joinWhere,
  nullable,
  timeRangeWhere,
  toBlob,
  toJsonText,
} from "./_helpers.js";

const COLUMNS = [
  "id",
  "episode_id",
  "session_id",
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
  tags_json?: string;
  error_signatures_json?: string;
};

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
        ["ts", "priority", "value", "episode_id", "session_id", "tags_json"],
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
        scope: "private" | "public" | "hub" | null;
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
        share_scope: share.scope,
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
  tags_json: string;
  error_signatures_json: string;
}

interface RawTraceRow {
  id: string;
  episode_id: string;
  session_id: string;
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
  turn_id: number | null;
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
    share_scope: row.share?.scope ?? null,
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
            scope: r.share_scope as "private" | "public" | "hub",
            target: r.share_target,
            sharedAt: r.shared_at,
          }
        : null,
    turnId: r.turn_id,
    schemaVersion: r.schema_version,
  };
}
