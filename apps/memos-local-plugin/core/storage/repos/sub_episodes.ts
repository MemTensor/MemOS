import type { EmbeddingVector, EpisodeId, SessionId, SubEpisodeRow } from "../../types.js";
import type { PageOptions, StorageDb } from "../types.js";
import { buildInsert } from "../tx.js";
import { scanAndTopK, type VectorHit } from "../vector.js";
import { buildPageClauses, fromBlob, fromJsonText, ownerFieldsFromRaw, ownerParamsFromRow, toBlob, toJsonText } from "./_helpers.js";

const COLUMNS = [
  "id",
  "episode_id",
  "session_id",
  "owner_agent_kind",
  "owner_profile_id",
  "owner_workspace_id",
  "trace_ids_json",
  "start_trace_id",
  "end_trace_id",
  "start_ts",
  "end_ts",
  "local_goal",
  "trigger",
  "action_chain_json",
  "observations_json",
  "outcome",
  "verification",
  "failure_mode",
  "reflection",
  "alpha",
  "value",
  "priority",
  "learnability_score",
  "learnability_reasons_json",
  "tags_json",
  "error_signatures_json",
  "completeness",
  "transferability",
  "mean_value",
  "max_value",
  "min_value",
  "polarity",
  "summary",
  "vec_summary",
  "created_at",
  "updated_at",
  "meta_json",
];

export type SubEpisodeSearchMeta = {
  end_ts: number;
  priority: number;
  value: number;
  learnability_score: number;
  episode_id: EpisodeId;
  session_id: SessionId;
  owner_agent_kind?: string;
  owner_profile_id?: string;
  owner_workspace_id?: string | null;
  tags_json?: string;
  error_signatures_json?: string;
};

export interface SubEpisodeListFilter extends PageOptions {
  episodeId?: EpisodeId;
  minAbsValue?: number;
}

export function makeSubEpisodesRepo(db: StorageDb) {
  const insert = db.prepare(buildInsert({ table: "sub_episodes", columns: COLUMNS }));
  const upsert = db.prepare(
    buildInsert({ table: "sub_episodes", columns: COLUMNS, onConflict: "replace" }),
  );
  const deleteByEpisode = db.prepare<{ episode_id: EpisodeId }>(
    `DELETE FROM sub_episodes WHERE episode_id=@episode_id`,
  );
  const selectById = db.prepare<{ id: string }, RawSubEpisodeRow>(
    `SELECT ${COLUMNS.join(", ")} FROM sub_episodes WHERE id=@id`,
  );

  return {
    insert(row: SubEpisodeRow): void {
      insert.run(rowToParams(row));
    },

    upsert(row: SubEpisodeRow): void {
      upsert.run(rowToParams(row));
    },

    replaceForEpisode(episodeId: EpisodeId, rows: readonly SubEpisodeRow[]): void {
      db.tx(() => {
        deleteByEpisode.run({ episode_id: episodeId });
        for (const row of rows) upsert.run(rowToParams(row));
      });
    },

    getById(id: string): SubEpisodeRow | null {
      const row = selectById.get({ id });
      return row ? mapRow(row) : null;
    },

    listByEpisode(episodeId: EpisodeId): SubEpisodeRow[] {
      return db
        .prepare<{ episode_id: EpisodeId }, RawSubEpisodeRow>(
          `SELECT ${COLUMNS.join(", ")} FROM sub_episodes WHERE episode_id=@episode_id ORDER BY start_ts ASC`,
        )
        .all({ episode_id: episodeId })
        .map(mapRow);
    },

    list(filter: SubEpisodeListFilter = {}): SubEpisodeRow[] {
      const fragments: string[] = [];
      const params: Record<string, unknown> = {};
      if (filter.episodeId) {
        fragments.push(`episode_id = @episode_id`);
        params.episode_id = filter.episodeId;
      }
      if (filter.minAbsValue !== undefined) {
        fragments.push(`max(abs(max_value), abs(min_value)) >= @min_abs_value`);
        params.min_abs_value = filter.minAbsValue;
      }
      const where = fragments.length > 0 ? `WHERE ${fragments.join(" AND ")}` : "";
      const page = buildPageClauses(filter, "updated_at");
      return db
        .prepare<typeof params, RawSubEpisodeRow>(
          `SELECT ${COLUMNS.join(", ")} FROM sub_episodes ${where} ${page}`,
        )
        .all(params)
        .map(mapRow);
    },

    searchByVector(
      query: EmbeddingVector,
      k: number,
      opts: {
        where?: string;
        params?: Record<string, unknown>;
        hardCap?: number;
        anyOfTags?: readonly string[];
      } = {},
    ): Array<VectorHit<string, SubEpisodeSearchMeta>> {
      const params: Record<string, unknown> = { ...(opts.params ?? {}) };
      const whereParts = ["vec_summary IS NOT NULL"];
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
      return scanAndTopK<SubEpisodeSearchMeta>(
        db,
        "sub_episodes",
        [
          "end_ts",
          "priority",
          "value",
          "learnability_score",
          "episode_id",
          "session_id",
          "owner_agent_kind",
          "owner_profile_id",
          "owner_workspace_id",
          "tags_json",
          "error_signatures_json",
        ],
        query,
        k,
        {
          vecColumn: "vec_summary",
          where: whereParts.join(" AND "),
          params,
          hardCap: opts.hardCap,
        },
      );
    },

    searchByPattern(
      terms: readonly string[],
      k: number,
      opts: { where?: string; params?: Record<string, unknown> } = {},
    ): Array<VectorHit<string, SubEpisodeSearchMeta>> {
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
        const escaped = t.replace(/[\\%_]/g, (m) => `\\${m}`);
        params[key] = `%${escaped}%`;
        ors.push(
          `(summary LIKE @${key} ESCAPE '\\' OR
            local_goal LIKE @${key} ESCAPE '\\' OR
            trigger LIKE @${key} ESCAPE '\\' OR
            outcome LIKE @${key} ESCAPE '\\' OR
            verification LIKE @${key} ESCAPE '\\' OR
            action_chain_json LIKE @${key} ESCAPE '\\' OR
            observations_json LIKE @${key} ESCAPE '\\' OR
            tags_json LIKE @${key} ESCAPE '\\')`,
        );
      });
      const extra = opts.where ? ` AND (${opts.where})` : "";
      const sql = `
        SELECT id, end_ts AS ts, priority, value, learnability_score,
               episode_id, session_id, tags_json, error_signatures_json,
               owner_agent_kind, owner_profile_id, owner_workspace_id
          FROM sub_episodes
         WHERE (${ors.join(" OR ")})${extra}
         ORDER BY priority DESC, end_ts DESC
         LIMIT @k`;
      const rows = db.prepare<typeof params, RawSubEpisodeHit>(sql).all(params);
      return rows.map((r, idx) => ({
        id: r.id,
        score: 1 / (idx + 1),
        meta: {
          end_ts: r.ts,
          priority: r.priority,
          value: r.value,
          learnability_score: r.learnability_score,
          episode_id: r.episode_id,
          session_id: r.session_id,
          owner_agent_kind: r.owner_agent_kind,
          owner_profile_id: r.owner_profile_id,
          owner_workspace_id: r.owner_workspace_id,
          tags_json: r.tags_json,
          error_signatures_json: r.error_signatures_json,
        },
      }));
    },
  };
}

interface RawSubEpisodeRow {
  id: string;
  episode_id: EpisodeId;
  session_id: string;
  owner_agent_kind: string;
  owner_profile_id: string;
  owner_workspace_id: string | null;
  trace_ids_json: string;
  start_trace_id: string;
  end_trace_id: string;
  start_ts: number;
  end_ts: number;
  local_goal: string;
  trigger: string;
  action_chain_json: string;
  observations_json: string;
  outcome: string;
  verification: string;
  failure_mode: string | null;
  reflection: string | null;
  alpha: number;
  value: number;
  priority: number;
  learnability_score: number;
  learnability_reasons_json: string;
  tags_json: string;
  error_signatures_json: string;
  completeness: number;
  transferability: number;
  mean_value: number;
  max_value: number;
  min_value: number;
  polarity: SubEpisodeRow["polarity"];
  summary: string;
  vec_summary: Buffer | null;
  created_at: number;
  updated_at: number;
  meta_json: string;
}

interface RawSubEpisodeHit {
  id: string;
  ts: number;
  priority: number;
  value: number;
  learnability_score: number;
  episode_id: EpisodeId;
  session_id: SessionId;
  owner_agent_kind: string;
  owner_profile_id: string;
  owner_workspace_id: string | null;
  tags_json: string;
  error_signatures_json: string;
}

function rowToParams(row: SubEpisodeRow): Record<string, unknown> {
  return {
    id: row.id,
    episode_id: row.episodeId,
    session_id: row.sessionId,
    ...ownerParamsFromRow(row),
    trace_ids_json: toJsonText(row.traceIds),
    start_trace_id: row.startTraceId,
    end_trace_id: row.endTraceId,
    start_ts: row.startTs,
    end_ts: row.endTs,
    local_goal: row.localGoal,
    trigger: row.trigger,
    action_chain_json: toJsonText(row.actionChain),
    observations_json: toJsonText(row.observations),
    outcome: row.outcome,
    verification: row.verification,
    failure_mode: row.failureMode,
    reflection: row.reflection,
    alpha: row.alpha,
    value: row.value,
    priority: row.priority,
    learnability_score: row.learnabilityScore,
    learnability_reasons_json: toJsonText(row.learnabilityReasons),
    tags_json: toJsonText(row.tags),
    error_signatures_json: toJsonText(row.errorSignatures),
    completeness: row.completeness,
    transferability: row.transferability,
    mean_value: row.meanValue,
    max_value: row.maxValue,
    min_value: row.minValue,
    polarity: row.polarity,
    summary: row.summary,
    vec_summary: toBlob(row.vecSummary),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    meta_json: toJsonText(row.meta ?? {}),
  };
}

function mapRow(row: RawSubEpisodeRow): SubEpisodeRow {
  return {
    id: row.id,
    episodeId: row.episode_id,
    sessionId: row.session_id,
    ...ownerFieldsFromRaw(row),
    traceIds: fromJsonText(row.trace_ids_json, []),
    startTraceId: row.start_trace_id,
    endTraceId: row.end_trace_id,
    startTs: row.start_ts,
    endTs: row.end_ts,
    localGoal: row.local_goal,
    trigger: row.trigger,
    actionChain: fromJsonText(row.action_chain_json, []),
    observations: fromJsonText(row.observations_json, []),
    outcome: row.outcome,
    verification: row.verification,
    failureMode: row.failure_mode,
    reflection: row.reflection,
    alpha: row.alpha,
    value: row.value,
    priority: row.priority,
    learnabilityScore: row.learnability_score,
    learnabilityReasons: fromJsonText(row.learnability_reasons_json, []),
    tags: fromJsonText(row.tags_json, []),
    errorSignatures: fromJsonText(row.error_signatures_json, []),
    completeness: row.completeness,
    transferability: row.transferability,
    meanValue: row.mean_value,
    maxValue: row.max_value,
    minValue: row.min_value,
    polarity: row.polarity,
    summary: row.summary,
    vecSummary: fromBlob(row.vec_summary),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    meta: fromJsonText(row.meta_json, {}),
  };
}
