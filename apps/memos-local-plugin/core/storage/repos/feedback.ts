import type { EpisodeId, FeedbackId, FeedbackRow, TraceId } from "../../types.js";
import type { FeedbackListFilter, StorageDb } from "../types.js";
import { buildInsert } from "../tx.js";
import {
  buildPageClauses,
  fromJsonText,
  joinWhere,
  timeRangeWhere,
  toJsonText,
} from "./_helpers.js";

const COLUMNS = [
  "id",
  "ts",
  "episode_id",
  "trace_id",
  "channel",
  "polarity",
  "magnitude",
  "rationale",
  "raw_json",
];

export function makeFeedbackRepo(db: StorageDb) {
  const insert = db.prepare(buildInsert({ table: "feedback", columns: COLUMNS }));
  const selectById = db.prepare<{ id: string }, RawFeedbackRow>(
    `SELECT ${COLUMNS.join(", ")} FROM feedback WHERE id=@id`,
  );
  const selectForTrace = db.prepare<{ id: string }, RawFeedbackRow>(
    `SELECT ${COLUMNS.join(", ")} FROM feedback WHERE trace_id=@id ORDER BY ts DESC`,
  );
  const selectForEpisode = db.prepare<{ id: string }, RawFeedbackRow>(
    `SELECT ${COLUMNS.join(", ")} FROM feedback WHERE episode_id=@id ORDER BY ts DESC`,
  );

  return {
    insert(row: FeedbackRow): void {
      insert.run({
        id: row.id,
        ts: row.ts,
        episode_id: row.episodeId ?? null,
        trace_id: row.traceId ?? null,
        channel: row.channel,
        polarity: row.polarity,
        magnitude: row.magnitude,
        rationale: row.rationale ?? null,
        raw_json: toJsonText(row.raw ?? null),
      });
    },

    getById(id: FeedbackId): FeedbackRow | null {
      const r = selectById.get({ id });
      return r ? mapRow(r) : null;
    },

    getForTrace(id: TraceId): FeedbackRow[] {
      return selectForTrace.all({ id }).map(mapRow);
    },

    getForEpisode(id: EpisodeId): FeedbackRow[] {
      return selectForEpisode.all({ id }).map(mapRow);
    },

    list(filter: FeedbackListFilter = {}): FeedbackRow[] {
      const tr = timeRangeWhere(filter, "ts");
      const fragments: string[] = [];
      const params: Record<string, unknown> = { ...tr.params };
      if (filter.episodeId) {
        fragments.push(`episode_id = @episode_id`);
        params.episode_id = filter.episodeId;
      }
      if (filter.traceId) {
        fragments.push(`trace_id = @trace_id`);
        params.trace_id = filter.traceId;
      }
      if (filter.polarity) {
        fragments.push(`polarity = @polarity`);
        params.polarity = filter.polarity;
      }
      if (tr.sql) fragments.push(tr.sql);
      const where = joinWhere(fragments);
      const page = buildPageClauses(filter, "ts");
      const sql = `SELECT ${COLUMNS.join(", ")} FROM feedback ${where} ${page}`;
      return db.prepare<typeof params, RawFeedbackRow>(sql).all(params).map(mapRow);
    },
  };
}

interface RawFeedbackRow {
  id: string;
  ts: number;
  episode_id: string | null;
  trace_id: string | null;
  channel: FeedbackRow["channel"];
  polarity: FeedbackRow["polarity"];
  magnitude: number;
  rationale: string | null;
  raw_json: string;
}

function mapRow(r: RawFeedbackRow): FeedbackRow {
  return {
    id: r.id,
    ts: r.ts,
    episodeId: r.episode_id,
    traceId: r.trace_id,
    channel: r.channel,
    polarity: r.polarity,
    magnitude: r.magnitude,
    rationale: r.rationale,
    raw: fromJsonText<unknown>(r.raw_json, null),
  };
}
