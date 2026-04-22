import type { EmbeddingVector, PolicyId, PolicyRow } from "../../types.js";
import type { PolicyListFilter, StorageDb } from "../types.js";
import { buildInsert, buildUpdate } from "../tx.js";
import { scanAndTopK, type VectorHit } from "../vector.js";
import {
  buildPageClauses,
  fromBlob,
  fromJsonText,
  joinWhere,
  timeRangeWhere,
  toBlob,
  toJsonText,
} from "./_helpers.js";

const COLUMNS = [
  "id",
  "title",
  "trigger",
  "procedure",
  "verification",
  "boundary",
  "support",
  "gain",
  "status",
  "source_episodes_json",
  "induced_by",
  "vec",
  "created_at",
  "updated_at",
  "share_scope",
  "share_target",
  "shared_at",
  "edited_at",
];

export interface PolicySearchMeta {
  title: string;
  status: "candidate" | "active" | "archived";
  support: number;
  gain: number;
}

export function makePoliciesRepo(db: StorageDb) {
  const insert = db.prepare(buildInsert({ table: "policies", columns: COLUMNS }));
  const upsert = db.prepare(
    buildInsert({ table: "policies", columns: COLUMNS, onConflict: "replace" }),
  );
  const updateStats = db.prepare(
    buildUpdate({
      table: "policies",
      columns: ["id", "support", "gain", "status", "updated_at"],
    }),
  );
  const selectById = db.prepare<{ id: string }, RawPolicyRow>(
    `SELECT ${COLUMNS.join(", ")} FROM policies WHERE id=@id`,
  );

  return {
    insert(row: PolicyRow): void {
      insert.run(rowToParams(row));
    },

    upsert(row: PolicyRow): void {
      upsert.run(rowToParams(row));
    },

    updateStats(
      id: PolicyId,
      p: {
        support: number;
        gain: number;
        status: PolicyRow["status"];
        updatedAt: number;
      },
    ): void {
      updateStats.run({
        id,
        support: p.support,
        gain: p.gain,
        status: p.status,
        updated_at: p.updatedAt,
      });
    },

    getById(id: PolicyId): PolicyRow | null {
      const r = selectById.get({ id });
      if (!r) return null;
      return mapRow(r);
    },

    list(filter: PolicyListFilter = {}): PolicyRow[] {
      const tr = timeRangeWhere(filter, "updated_at");
      const fragments: string[] = [];
      const params: Record<string, unknown> = { ...tr.params };
      if (filter.status) {
        fragments.push(`status = @status`);
        params.status = filter.status;
      }
      if (filter.minSupport !== undefined) {
        fragments.push(`support >= @min_support`);
        params.min_support = filter.minSupport;
      }
      if (tr.sql) fragments.push(tr.sql);
      const where = joinWhere(fragments);
      const page = buildPageClauses(filter, "updated_at");
      const sql = `SELECT ${COLUMNS.join(", ")} FROM policies ${where} ${page}`;
      return db.prepare<typeof params, RawPolicyRow>(sql).all(params).map(mapRow);
    },

    searchByVector(
      query: EmbeddingVector,
      k: number,
      opts: { statusIn?: PolicyRow["status"][]; hardCap?: number } = {},
    ): Array<VectorHit<string, PolicySearchMeta>> {
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
      return scanAndTopK<PolicySearchMeta>(
        db,
        "policies",
        ["title", "status", "support", "gain"],
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

    deleteById(id: PolicyId): void {
      db.prepare<{ id: string }>(`DELETE FROM policies WHERE id=@id`).run({ id });
    },

    /**
     * Apply a share-state transition. `scope = null` clears the share
     * fields and resets `shared_at`. Mirrors `traces.updateShare`.
     */
    updateShare(
      id: PolicyId,
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
        `UPDATE policies SET share_scope=@share_scope, share_target=@share_target, shared_at=@shared_at WHERE id=@id`,
      ).run({
        id,
        share_scope: share.scope,
        share_target: share.target ?? null,
        shared_at: share.sharedAt ?? null,
      });
    },

    /**
     * User-driven content patch from the viewer's edit modal. Limited
     * to the title / trigger / procedure / verification / boundary
     * fields; status, support, gain, vec are owned by the induction
     * pipeline. Stamps `edited_at = Date.now()` on any change.
     */
    updateContent(
      id: PolicyId,
      patch: {
        title?: string;
        trigger?: string;
        procedure?: string;
        verification?: string;
        boundary?: string;
      },
    ): void {
      const sets: string[] = [];
      const params: Record<string, unknown> = { id };
      if (patch.title !== undefined) {
        sets.push("title = @title");
        params.title = patch.title;
      }
      if (patch.trigger !== undefined) {
        sets.push("trigger = @trigger");
        params.trigger = patch.trigger;
      }
      if (patch.procedure !== undefined) {
        sets.push("procedure = @procedure");
        params.procedure = patch.procedure;
      }
      if (patch.verification !== undefined) {
        sets.push("verification = @verification");
        params.verification = patch.verification;
      }
      if (patch.boundary !== undefined) {
        sets.push("boundary = @boundary");
        params.boundary = patch.boundary;
      }
      if (sets.length === 0) return;
      sets.push("edited_at = @edited_at");
      params.edited_at = Date.now();
      const sql = `UPDATE policies SET ${sets.join(", ")} WHERE id = @id`;
      db.prepare<typeof params>(sql).run(params);
    },
  };
}

interface RawPolicyRow {
  id: string;
  title: string;
  trigger: string;
  procedure: string;
  verification: string;
  boundary: string;
  support: number;
  gain: number;
  status: "candidate" | "active" | "archived";
  source_episodes_json: string;
  induced_by: string;
  vec: Buffer | null;
  created_at: number;
  updated_at: number;
  share_scope: string | null;
  share_target: string | null;
  shared_at: number | null;
  edited_at: number | null;
}

function rowToParams(row: PolicyRow): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title,
    trigger: row.trigger,
    procedure: row.procedure,
    verification: row.verification,
    boundary: row.boundary,
    support: row.support,
    gain: row.gain,
    status: row.status,
    source_episodes_json: toJsonText(row.sourceEpisodeIds),
    induced_by: row.inducedBy,
    vec: toBlob(row.vec),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    share_scope: row.share?.scope ?? null,
    share_target: row.share?.target ?? null,
    shared_at: row.share?.sharedAt ?? null,
    edited_at: row.editedAt ?? null,
  };
}

function mapRow(r: RawPolicyRow): PolicyRow {
  return {
    id: r.id,
    title: r.title,
    trigger: r.trigger,
    procedure: r.procedure,
    verification: r.verification,
    boundary: r.boundary,
    support: r.support,
    gain: r.gain,
    status: r.status,
    sourceEpisodeIds: fromJsonText(r.source_episodes_json, []),
    inducedBy: r.induced_by,
    vec: fromBlob(r.vec),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
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
