import type { EpisodeId, SkillId, SkillTrialRow } from "../../types.js";
import type { StorageDb } from "../types.js";
import { buildInsert } from "../tx.js";
import { fromJsonText, toJsonText } from "./_helpers.js";

const COLUMNS = [
  "id",
  "skill_id",
  "session_id",
  "episode_id",
  "trace_id",
  "turn_id",
  "tool_call_id",
  "status",
  "created_at",
  "resolved_at",
  "evidence_json",
];

export function makeSkillTrialsRepo(db: StorageDb) {
  const insert = db.prepare(buildInsert({ table: "skill_trials", columns: COLUMNS }));
  const selectPendingForEpisodeSkill = db.prepare<
    { skill_id: string; episode_id: string },
    RawSkillTrialRow
  >(
    `SELECT ${COLUMNS.join(", ")}
       FROM skill_trials
      WHERE skill_id=@skill_id AND episode_id=@episode_id AND status='pending'
      LIMIT 1`,
  );
  const selectPendingForEpisode = db.prepare<{ episode_id: string }, RawSkillTrialRow>(
    `SELECT ${COLUMNS.join(", ")}
       FROM skill_trials
      WHERE episode_id=@episode_id AND status='pending'
      ORDER BY created_at ASC`,
  );
  const resolve = db.prepare<{
    id: string;
    status: SkillTrialRow["status"];
    resolved_at: number;
    evidence_json: string;
  }>(
    `UPDATE skill_trials
        SET status=@status,
            resolved_at=@resolved_at,
            evidence_json=@evidence_json
      WHERE id=@id AND status='pending'`,
  );

  return {
    createPending(row: SkillTrialRow): SkillTrialRow {
      const existing = selectPendingForEpisodeSkill.get({
        skill_id: row.skillId,
        episode_id: row.episodeId,
      });
      if (existing) return mapRow(existing);
      insert.run(rowToParams(row));
      return row;
    },

    listPendingForEpisode(episodeId: EpisodeId): SkillTrialRow[] {
      return selectPendingForEpisode
        .all({ episode_id: episodeId })
        .map(mapRow);
    },

    resolve(
      id: string,
      status: Exclude<SkillTrialRow["status"], "pending">,
      resolvedAt: number,
      evidence: Record<string, unknown>,
    ): boolean {
      const res = resolve.run({
        id,
        status,
        resolved_at: resolvedAt,
        evidence_json: toJsonText(evidence),
      });
      return res.changes > 0;
    },
  };
}

interface RawSkillTrialRow {
  id: string;
  skill_id: string;
  session_id: string | null;
  episode_id: string;
  trace_id: string | null;
  turn_id: number | null;
  tool_call_id: string | null;
  status: SkillTrialRow["status"];
  created_at: number;
  resolved_at: number | null;
  evidence_json: string;
}

function rowToParams(row: SkillTrialRow): Record<string, unknown> {
  return {
    id: row.id,
    skill_id: row.skillId,
    session_id: row.sessionId,
    episode_id: row.episodeId,
    trace_id: row.traceId,
    turn_id: row.turnId,
    tool_call_id: row.toolCallId,
    status: row.status,
    created_at: row.createdAt,
    resolved_at: row.resolvedAt,
    evidence_json: toJsonText(row.evidence),
  };
}

function mapRow(row: RawSkillTrialRow): SkillTrialRow {
  return {
    id: row.id,
    skillId: row.skill_id as SkillId,
    sessionId: row.session_id,
    episodeId: row.episode_id as EpisodeId,
    traceId: row.trace_id,
    turnId: row.turn_id,
    toolCallId: row.tool_call_id,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    evidence: fromJsonText<Record<string, unknown>>(row.evidence_json, {}),
  };
}
