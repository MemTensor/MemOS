import type { DecisionRepairRow } from "../../types.js";
import type { PageOptions, StorageDb } from "../types.js";
import { buildInsert } from "../tx.js";
import {
  buildPageClauses,
  fromJsonText,
  joinWhere,
  ownerFieldsFromRaw,
  ownerParamsFromRow,
  toJsonText,
} from "./_helpers.js";

const COLUMNS = [
  "id",
  "owner_agent_kind",
  "owner_profile_id",
  "owner_workspace_id",
  "ts",
  "context_hash",
  "preference",
  "anti_pattern",
  "high_value_traces_json",
  "low_value_traces_json",
  "validated",
];

export function makeDecisionRepairsRepo(db: StorageDb) {
  const insert = db.prepare(buildInsert({ table: "decision_repairs", columns: COLUMNS }));
  const selectByContext = db.prepare<{ ctx: string }, RawRepairRow>(
    `SELECT ${COLUMNS.join(", ")} FROM decision_repairs WHERE context_hash=@ctx ORDER BY ts DESC LIMIT 5`,
  );
  const selectById = db.prepare<{ id: string }, RawRepairRow>(
    `SELECT ${COLUMNS.join(", ")} FROM decision_repairs WHERE id=@id`,
  );
  const validate = db.prepare<{ id: string }>(
    `UPDATE decision_repairs SET validated=1 WHERE id=@id`,
  );

  return {
    insert(row: DecisionRepairRow): void {
      insert.run({
        id: row.id,
        ...ownerParamsFromRow(row),
        ts: row.ts,
        context_hash: row.contextHash,
        preference: row.preference,
        anti_pattern: row.antiPattern,
        high_value_traces_json: toJsonText(row.highValueTraceIds),
        low_value_traces_json: toJsonText(row.lowValueTraceIds),
        validated: row.validated ? 1 : 0,
      });
    },

    getById(id: string): DecisionRepairRow | null {
      const r = selectById.get({ id });
      return r ? mapRow(r) : null;
    },

    recentForContext(contextHash: string): DecisionRepairRow[] {
      return selectByContext.all({ ctx: contextHash }).map(mapRow);
    },

    markValidated(id: string): void {
      validate.run({ id });
    },

    list(opts: PageOptions = {}): DecisionRepairRow[] {
      const where = joinWhere([]);
      const page = buildPageClauses(opts, "ts");
      const sql = `SELECT ${COLUMNS.join(", ")} FROM decision_repairs ${where} ${page}`;
      return db.prepare<unknown, RawRepairRow>(sql).all().map(mapRow);
    },
  };
}

interface RawRepairRow {
  id: string;
  owner_agent_kind: string;
  owner_profile_id: string;
  owner_workspace_id: string | null;
  ts: number;
  context_hash: string;
  preference: string;
  anti_pattern: string;
  high_value_traces_json: string;
  low_value_traces_json: string;
  validated: number;
}

function mapRow(r: RawRepairRow): DecisionRepairRow {
  return {
    id: r.id,
    ...ownerFieldsFromRaw(r),
    ts: r.ts,
    contextHash: r.context_hash,
    preference: r.preference,
    antiPattern: r.anti_pattern,
    highValueTraceIds: fromJsonText(r.high_value_traces_json, []),
    lowValueTraceIds: fromJsonText(r.low_value_traces_json, []),
    validated: r.validated !== 0,
  };
}
