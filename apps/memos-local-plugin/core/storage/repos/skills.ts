import type { EmbeddingVector, SkillId, SkillRow } from "../../types.js";
import type { SkillListFilter, StorageDb } from "../types.js";
import { buildInsert, buildUpdate } from "../tx.js";
import { scanAndTopK, type VectorHit } from "../vector.js";
import {
  buildPageClauses,
  fromBlob,
  fromJsonText,
  joinWhere,
  toBlob,
  toJsonText,
} from "./_helpers.js";

const COLUMNS = [
  "id",
  "name",
  "status",
  "invocation_guide",
  "procedure_json",
  "eta",
  "support",
  "gain",
  "trials_attempted",
  "trials_passed",
  "source_policies_json",
  "source_world_json",
  "vec",
  "created_at",
  "updated_at",
  "version",
  "share_scope",
  "share_target",
  "shared_at",
  "edited_at",
  "evidence_anchors_json",
];

export interface SkillSearchMeta {
  name: string;
  status: SkillRow["status"];
  eta: number;
  gain: number;
}

export function makeSkillsRepo(db: StorageDb) {
  const insert = db.prepare(buildInsert({ table: "skills", columns: COLUMNS }));
  const upsert = db.prepare(
    buildInsert({ table: "skills", columns: COLUMNS, onConflict: "replace" }),
  );
  const updateStatus = db.prepare(
    buildUpdate({ table: "skills", columns: ["id", "status", "updated_at"] }),
  );
  const updateTrials = db.prepare(
    buildUpdate({
      table: "skills",
      columns: ["id", "trials_attempted", "trials_passed", "eta", "updated_at"],
    }),
  );
  const selectById = db.prepare<{ id: string }, RawSkillRow>(
    `SELECT ${COLUMNS.join(", ")} FROM skills WHERE id=@id`,
  );
  const selectByName = db.prepare<{ name: string }, RawSkillRow>(
    `SELECT ${COLUMNS.join(", ")} FROM skills WHERE name=@name`,
  );

  return {
    insert(row: SkillRow): void {
      insert.run(rowToParams(row));
    },

    upsert(row: SkillRow): void {
      upsert.run(rowToParams(row));
    },

    setStatus(id: SkillId, status: SkillRow["status"], updatedAt: number): void {
      updateStatus.run({ id, status, updated_at: updatedAt });
    },

    bumpTrial(
      id: SkillId,
      passed: boolean,
      updatedAt: number,
    ): { trialsAttempted: number; trialsPassed: number; eta: number } {
      const row = selectById.get({ id });
      if (!row) throw new Error(`[skills] bumpTrial: not found: ${id}`);
      const trialsAttempted = row.trials_attempted + 1;
      const trialsPassed = row.trials_passed + (passed ? 1 : 0);
      const eta = trialsAttempted === 0 ? 0 : trialsPassed / trialsAttempted;
      updateTrials.run({
        id,
        trials_attempted: trialsAttempted,
        trials_passed: trialsPassed,
        eta,
        updated_at: updatedAt,
      });
      return { trialsAttempted, trialsPassed, eta };
    },

    getById(id: SkillId): SkillRow | null {
      const r = selectById.get({ id });
      return r ? mapRow(r) : null;
    },

    getByName(name: string): SkillRow | null {
      const r = selectByName.get({ name });
      return r ? mapRow(r) : null;
    },

    list(filter: SkillListFilter = {}): SkillRow[] {
      const fragments: string[] = [];
      const params: Record<string, unknown> = {};
      if (filter.status) {
        fragments.push(`status = @status`);
        params.status = filter.status;
      }
      if (filter.minEta !== undefined) {
        fragments.push(`eta >= @min_eta`);
        params.min_eta = filter.minEta;
      }
      const where = joinWhere(fragments);
      const page = buildPageClauses(filter, "updated_at");
      const sql = `SELECT ${COLUMNS.join(", ")} FROM skills ${where} ${page}`;
      return db.prepare<typeof params, RawSkillRow>(sql).all(params).map(mapRow);
    },

    count(filter: Omit<SkillListFilter, "limit" | "offset"> = {}): number {
      const fragments: string[] = [];
      const params: Record<string, unknown> = {};
      if (filter.status) {
        fragments.push(`status = @status`);
        params.status = filter.status;
      }
      if (filter.minEta !== undefined) {
        fragments.push(`eta >= @min_eta`);
        params.min_eta = filter.minEta;
      }
      const where = joinWhere(fragments);
      const sql = `SELECT COUNT(*) AS n FROM skills ${where}`;
      return db.prepare<typeof params, { n: number }>(sql).get(params)?.n ?? 0;
    },

    searchByVector(
      query: EmbeddingVector,
      k: number,
      opts: { statusIn?: SkillRow["status"][]; hardCap?: number } = {},
    ): Array<VectorHit<string, SkillSearchMeta>> {
      const statusIn = opts.statusIn;
      const whereParts: string[] = ["vec IS NOT NULL"];
      const params: Record<string, unknown> = {};
      if (statusIn && statusIn.length > 0) {
        const placeholders = statusIn.map((_, i) => `@status_${i}`).join(",");
        whereParts.push(`status IN (${placeholders})`);
        statusIn.forEach((s, i) => {
          params[`status_${i}`] = s;
        });
      }
      return scanAndTopK<SkillSearchMeta>(
        db,
        "skills",
        ["name", "status", "eta", "gain"],
        query,
        k,
        {
          vecColumn: "vec",
          where: whereParts.join(" AND "),
          params,
          hardCap: opts.hardCap,
        },
      );
    },

    /**
     * Keyword channel — FTS5 trigram MATCH against `skills_fts`.
     * Indices `name` + `invocation_guide`. Returns hits with the same
     * `meta` shape `searchByVector` produces so the retrieval ranker
     * can fuse channels via RRF.
     */
    searchByText(
      ftsMatch: string,
      k: number,
      opts: { statusIn?: SkillRow["status"][] } = {},
    ): Array<VectorHit<string, SkillSearchMeta>> {
      if (!ftsMatch || k <= 0) return [];
      const params: Record<string, unknown> = {
        match: ftsMatch,
        k: Math.max(1, Math.min(200, Math.floor(k))),
      };
      const whereParts: string[] = [];
      if (opts.statusIn && opts.statusIn.length > 0) {
        const placeholders = opts.statusIn.map((_, i) => `@status_${i}`).join(",");
        whereParts.push(`s.status IN (${placeholders})`);
        opts.statusIn.forEach((st, i) => {
          params[`status_${i}`] = st;
        });
      }
      const extra = whereParts.length > 0 ? ` AND ${whereParts.join(" AND ")}` : "";
      const sql = `
        SELECT s.id   AS id,
               s.name AS name,
               s.status AS status,
               s.eta  AS eta,
               s.gain AS gain
          FROM skills_fts f
          JOIN skills      s ON s.id = f.skill_id
         WHERE skills_fts MATCH @match${extra}
         ORDER BY rank
         LIMIT @k`;
      const rows = db
        .prepare<typeof params, { id: string; name: string; status: SkillRow["status"]; eta: number; gain: number }>(sql)
        .all(params);
      return rows.map((r, idx) => ({
        id: r.id,
        score: 1 / (idx + 1),
        meta: { name: r.name, status: r.status, eta: r.eta, gain: r.gain },
      }));
    },

    /**
     * Pattern channel — substring fallback for short queries (e.g. 2-char
     * CJK). Searched over `name` + `invocation_guide`.
     */
    searchByPattern(
      terms: readonly string[],
      k: number,
      opts: { statusIn?: SkillRow["status"][] } = {},
    ): Array<VectorHit<string, SkillSearchMeta>> {
      if (!terms || terms.length === 0 || k <= 0) return [];
      const dedup = Array.from(new Set(terms.map((t) => String(t).trim()).filter(Boolean)));
      if (dedup.length === 0) return [];
      const params: Record<string, unknown> = {
        k: Math.max(1, Math.min(200, Math.floor(k))),
      };
      const ors: string[] = [];
      dedup.slice(0, 16).forEach((t, i) => {
        const key = `pat_${i}`;
        const escaped = t.replace(/[\\%_]/g, (m) => `\\${m}`);
        params[key] = `%${escaped}%`;
        ors.push(
          `(name LIKE @${key} ESCAPE '\\' OR invocation_guide LIKE @${key} ESCAPE '\\')`,
        );
      });
      const whereParts: string[] = [`(${ors.join(" OR ")})`];
      if (opts.statusIn && opts.statusIn.length > 0) {
        const placeholders = opts.statusIn.map((_, i) => `@status_${i}`).join(",");
        whereParts.push(`status IN (${placeholders})`);
        opts.statusIn.forEach((st, i) => {
          params[`status_${i}`] = st;
        });
      }
      const sql = `
        SELECT id, name, status, eta, gain
          FROM skills
         WHERE ${whereParts.join(" AND ")}
         ORDER BY updated_at DESC
         LIMIT @k`;
      const rows = db
        .prepare<typeof params, { id: string; name: string; status: SkillRow["status"]; eta: number; gain: number }>(sql)
        .all(params);
      return rows.map((r, idx) => ({
        id: r.id,
        score: 1 / (idx + 1),
        meta: { name: r.name, status: r.status, eta: r.eta, gain: r.gain },
      }));
    },

    deleteById(id: SkillId): void {
      db.prepare<{ id: string }>(`DELETE FROM skills WHERE id=@id`).run({ id });
    },

    /**
     * Apply a share-state transition. `scope = null` clears the share
     * fields and resets `shared_at`. Mirrors `traces.updateShare`.
     */
    updateShare(
      id: SkillId,
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
        `UPDATE skills SET share_scope=@share_scope, share_target=@share_target, shared_at=@shared_at WHERE id=@id`,
      ).run({
        id,
        share_scope: share.scope,
        share_target: share.target ?? null,
        shared_at: share.sharedAt ?? null,
      });
    },

    /**
     * User-driven content patch from the viewer's edit modal. Only the
     * narrowly user-facing fields are mutable here; trial counters,
     * vectors, and source ids stay owned by the algorithm pipeline.
     * Stamps `edited_at = Date.now()` whenever any field changes.
     */
    updateContent(
      id: SkillId,
      patch: { name?: string; invocationGuide?: string },
    ): void {
      const sets: string[] = [];
      const params: Record<string, unknown> = { id };
      if (patch.name !== undefined) {
        sets.push("name = @name");
        params.name = patch.name;
      }
      if (patch.invocationGuide !== undefined) {
        sets.push("invocation_guide = @invocation_guide");
        params.invocation_guide = patch.invocationGuide;
      }
      if (sets.length === 0) return;
      sets.push("edited_at = @edited_at");
      params.edited_at = Date.now();
      const sql = `UPDATE skills SET ${sets.join(", ")} WHERE id = @id`;
      db.prepare<typeof params>(sql).run(params);
    },

    updateVector(id: SkillId, vec: EmbeddingVector): boolean {
      const res = db.prepare<{ id: string; vec: Buffer; updated_at: number }>(
        `UPDATE skills SET vec=@vec, updated_at=@updated_at WHERE id=@id`,
      ).run({ id, vec: toBlob(vec)!, updated_at: Date.now() });
      return res.changes > 0;
    },
  };
}

interface RawSkillRow {
  id: string;
  name: string;
  status: SkillRow["status"];
  invocation_guide: string;
  procedure_json: string;
  eta: number;
  support: number;
  gain: number;
  trials_attempted: number;
  trials_passed: number;
  source_policies_json: string;
  source_world_json: string;
  vec: Buffer | null;
  created_at: number;
  updated_at: number;
  version: number;
  share_scope: string | null;
  share_target: string | null;
  shared_at: number | null;
  edited_at: number | null;
  evidence_anchors_json: string;
}

function rowToParams(row: SkillRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    invocation_guide: row.invocationGuide,
    procedure_json: toJsonText(row.procedureJson ?? null),
    eta: row.eta,
    support: row.support,
    gain: row.gain,
    trials_attempted: row.trialsAttempted,
    trials_passed: row.trialsPassed,
    source_policies_json: toJsonText(row.sourcePolicyIds),
    source_world_json: toJsonText(row.sourceWorldModelIds),
    vec: toBlob(row.vec),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    version: row.version ?? 1,
    share_scope: row.share?.scope ?? null,
    share_target: row.share?.target ?? null,
    shared_at: row.share?.sharedAt ?? null,
    edited_at: row.editedAt ?? null,
    evidence_anchors_json: toJsonText(row.evidenceAnchors),
  };
}

function mapRow(r: RawSkillRow): SkillRow {
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    invocationGuide: r.invocation_guide,
    procedureJson: fromJsonText(r.procedure_json, null),
    eta: r.eta,
    support: r.support,
    gain: r.gain,
    trialsAttempted: r.trials_attempted,
    trialsPassed: r.trials_passed,
    sourcePolicyIds: fromJsonText(r.source_policies_json, []),
    sourceWorldModelIds: fromJsonText(r.source_world_json, []),
    evidenceAnchors: fromJsonText(r.evidence_anchors_json, []),
    vec: fromBlob(r.vec),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    version: r.version ?? 1,
    share:
      r.share_scope != null
        ? {
            scope: r.share_scope as "private" | "public" | "hub",
            target: r.share_target,
            sharedAt: r.shared_at,
          }
        : null,
    editedAt: r.edited_at,
  };
}
