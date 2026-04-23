import type {
  EmbeddingVector,
  WorldModelId,
  WorldModelRow,
  WorldModelStructure,
} from "../../types.js";
import type { PageOptions, StorageDb } from "../types.js";
import { buildInsert, buildUpdate } from "../tx.js";
import { scanAndTopK, type VectorHit } from "../vector.js";
import {
  buildPageClauses,
  fromBlob,
  fromJsonText,
  toBlob,
  toJsonText,
} from "./_helpers.js";

const COLUMNS = [
  "id",
  "title",
  "body",
  "policy_ids_json",
  "vec",
  "created_at",
  "updated_at",
  "structure_json",
  "domain_tags_json",
  "confidence",
  "source_episodes_json",
  "induced_by",
  "status",
  "archived_at",
  "share_scope",
  "share_target",
  "shared_at",
  "edited_at",
];

export interface WorldSearchMeta {
  title: string;
}

export function makeWorldModelRepo(db: StorageDb) {
  const insert = db.prepare(buildInsert({ table: "world_model", columns: COLUMNS }));
  const upsert = db.prepare(
    buildInsert({ table: "world_model", columns: COLUMNS, onConflict: "replace" }),
  );
  const updateBody = db.prepare(
    buildUpdate({
      table: "world_model",
      columns: [
        "id",
        "title",
        "body",
        "structure_json",
        "domain_tags_json",
        "policy_ids_json",
        "source_episodes_json",
        "updated_at",
        "vec",
      ],
    }),
  );
  const updateConfidence = db.prepare(
    buildUpdate({
      table: "world_model",
      columns: ["id", "confidence", "updated_at"],
    }),
  );
  const selectById = db.prepare<{ id: string }, RawWorldRow>(
    `SELECT ${COLUMNS.join(", ")} FROM world_model WHERE id=@id`,
  );
  const selectByDomain = db.prepare<{ tag: string }, RawWorldRow>(
    `SELECT ${COLUMNS.join(", ")} FROM world_model
       WHERE instr(domain_tags_json, @tag) > 0
       ORDER BY confidence DESC, updated_at DESC`,
  );

  return {
    upsert(row: WorldModelRow): void {
      upsert.run(rowToParams(row));
    },

    insert(row: WorldModelRow): void {
      insert.run(rowToParams(row));
    },

    /**
     * Update everything that gets rewritten by an L3 abstraction pass
     * (body/structure/tags/policy links/episodes/vec). Leaves confidence
     * alone — that is its own update path.
     */
    updateBody(
      id: WorldModelId,
      patch: {
        title: string;
        body: string;
        structure: WorldModelStructure;
        domainTags: string[];
        policyIds: string[];
        sourceEpisodeIds: string[];
        vec: EmbeddingVector | null;
        updatedAt: number;
      },
    ): void {
      updateBody.run({
        id,
        title: patch.title,
        body: patch.body,
        structure_json: toJsonText(patch.structure),
        domain_tags_json: toJsonText(patch.domainTags),
        policy_ids_json: toJsonText(patch.policyIds),
        source_episodes_json: toJsonText(patch.sourceEpisodeIds),
        updated_at: patch.updatedAt,
        vec: toBlob(patch.vec),
      });
    },

    updateConfidence(id: WorldModelId, confidence: number, updatedAt: number): void {
      updateConfidence.run({ id, confidence, updated_at: updatedAt });
    },

    getById(id: WorldModelId): WorldModelRow | null {
      const r = selectById.get({ id });
      if (!r) return null;
      return mapRow(r);
    },

    /**
     * Case-sensitive substring hit on the domain-tags JSON. Keeps it cheap
     * (no index needed) for our scale; retrieval callers pass quoted tags
     * like `"docker"` to avoid matching partial tokens.
     */
    findByDomainTag(tag: string): WorldModelRow[] {
      return selectByDomain.all({ tag: JSON.stringify(tag) }).map(mapRow);
    },

    list(opts: PageOptions = {}): WorldModelRow[] {
      const page = buildPageClauses(opts, "updated_at");
      const sql = `SELECT ${COLUMNS.join(", ")} FROM world_model ${page}`;
      return db.prepare<unknown, RawWorldRow>(sql).all().map(mapRow);
    },

    searchByVector(
      query: EmbeddingVector,
      k: number,
      opts: { hardCap?: number; minConfidence?: number } = {},
    ): Array<VectorHit<string, WorldSearchMeta>> {
      const where = opts.minConfidence !== undefined
        ? `vec IS NOT NULL AND confidence >= ${Number(opts.minConfidence)}`
        : "vec IS NOT NULL";
      return scanAndTopK<WorldSearchMeta>(db, "world_model", ["title"], query, k, {
        vecColumn: "vec",
        where,
        hardCap: opts.hardCap,
      });
    },

    /**
     * Keyword channel — FTS5 trigram MATCH against `world_model_fts`.
     * Indexes `title` + `body` + `domain_tags`.
     */
    searchByText(
      ftsMatch: string,
      k: number,
      opts: { minConfidence?: number } = {},
    ): Array<VectorHit<string, WorldSearchMeta>> {
      if (!ftsMatch || k <= 0) return [];
      const params: Record<string, unknown> = {
        match: ftsMatch,
        k: Math.max(1, Math.min(200, Math.floor(k))),
      };
      const conf =
        opts.minConfidence !== undefined
          ? `AND w.confidence >= ${Number(opts.minConfidence)}`
          : "";
      const sql = `
        SELECT w.id    AS id,
               w.title AS title
          FROM world_model_fts f
          JOIN world_model     w ON w.id = f.world_id
         WHERE world_model_fts MATCH @match ${conf}
         ORDER BY rank
         LIMIT @k`;
      const rows = db
        .prepare<typeof params, { id: string; title: string }>(sql)
        .all(params);
      return rows.map((r, idx) => ({
        id: r.id,
        score: 1 / (idx + 1),
        meta: { title: r.title },
      }));
    },

    /**
     * Pattern channel — substring fallback for queries that fall below
     * the trigram window (2-char CJK etc.).
     */
    searchByPattern(
      terms: readonly string[],
      k: number,
      opts: { minConfidence?: number } = {},
    ): Array<VectorHit<string, WorldSearchMeta>> {
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
          `(title LIKE @${key} ESCAPE '\\' OR body LIKE @${key} ESCAPE '\\' OR COALESCE(domain_tags_json,'') LIKE @${key} ESCAPE '\\')`,
        );
      });
      const whereParts: string[] = [`(${ors.join(" OR ")})`];
      if (opts.minConfidence !== undefined) {
        whereParts.push(`confidence >= ${Number(opts.minConfidence)}`);
      }
      const sql = `
        SELECT id, title
          FROM world_model
         WHERE ${whereParts.join(" AND ")}
         ORDER BY updated_at DESC
         LIMIT @k`;
      const rows = db
        .prepare<typeof params, { id: string; title: string }>(sql)
        .all(params);
      return rows.map((r, idx) => ({
        id: r.id,
        score: 1 / (idx + 1),
        meta: { title: r.title },
      }));
    },

    deleteById(id: WorldModelId): void {
      db.prepare<{ id: string }>(`DELETE FROM world_model WHERE id=@id`).run({ id });
    },

    /**
     * Soft archive / unarchive. When status flips to `'archived'` we
     * stamp `archived_at`; flipping back to `'active'` clears it. The
     * caller is responsible for deciding what counts as a transition.
     */
    setStatus(
      id: WorldModelId,
      status: "active" | "archived",
      updatedAt: number,
    ): void {
      db.prepare<{
        id: string;
        status: string;
        updated_at: number;
        archived_at: number | null;
      }>(
        `UPDATE world_model SET status=@status, updated_at=@updated_at, archived_at=@archived_at WHERE id=@id`,
      ).run({
        id,
        status,
        updated_at: updatedAt,
        archived_at: status === "archived" ? updatedAt : null,
      });
    },

    /**
     * Apply a share-state transition. `scope = null` clears the share.
     */
    updateShare(
      id: WorldModelId,
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
        `UPDATE world_model SET share_scope=@share_scope, share_target=@share_target, shared_at=@shared_at WHERE id=@id`,
      ).run({
        id,
        share_scope: share.scope,
        share_target: share.target ?? null,
        shared_at: share.sharedAt ?? null,
      });
    },

    /**
     * User-driven content patch from the viewer's edit modal. Limited
     * to `title` / `body`; structure, vec, confidence, policyIds are
     * owned by the L3 abstraction pipeline. Stamps `edited_at` on any
     * change.
     */
    updateContent(
      id: WorldModelId,
      patch: { title?: string; body?: string },
    ): void {
      const sets: string[] = [];
      const params: Record<string, unknown> = { id };
      if (patch.title !== undefined) {
        sets.push("title = @title");
        params.title = patch.title;
      }
      if (patch.body !== undefined) {
        sets.push("body = @body");
        params.body = patch.body;
      }
      if (sets.length === 0) return;
      sets.push("edited_at = @edited_at");
      params.edited_at = Date.now();
      const sql = `UPDATE world_model SET ${sets.join(", ")} WHERE id = @id`;
      db.prepare<typeof params>(sql).run(params);
    },
  };
}

interface RawWorldRow {
  id: string;
  title: string;
  body: string;
  policy_ids_json: string;
  vec: Buffer | null;
  created_at: number;
  updated_at: number;
  structure_json: string;
  domain_tags_json: string;
  confidence: number;
  source_episodes_json: string;
  induced_by: string;
  status: string | null;
  archived_at: number | null;
  share_scope: string | null;
  share_target: string | null;
  shared_at: number | null;
  edited_at: number | null;
}

const EMPTY_STRUCTURE: WorldModelStructure = {
  environment: [],
  inference: [],
  constraints: [],
};

function rowToParams(row: WorldModelRow): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    policy_ids_json: toJsonText(row.policyIds),
    vec: toBlob(row.vec),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    structure_json: toJsonText(row.structure ?? EMPTY_STRUCTURE),
    domain_tags_json: toJsonText(row.domainTags ?? []),
    confidence: row.confidence ?? 0.5,
    source_episodes_json: toJsonText(row.sourceEpisodeIds ?? []),
    induced_by: row.inducedBy ?? "",
    status: row.status ?? "active",
    archived_at: row.archivedAt ?? null,
    share_scope: row.share?.scope ?? null,
    share_target: row.share?.target ?? null,
    shared_at: row.share?.sharedAt ?? null,
    edited_at: row.editedAt ?? null,
  };
}

function mapRow(r: RawWorldRow): WorldModelRow {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    policyIds: fromJsonText(r.policy_ids_json, []),
    vec: fromBlob(r.vec),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    structure: fromJsonText<WorldModelStructure>(r.structure_json, EMPTY_STRUCTURE),
    domainTags: fromJsonText<string[]>(r.domain_tags_json, []),
    confidence: r.confidence,
    sourceEpisodeIds: fromJsonText<string[]>(r.source_episodes_json, []),
    inducedBy: r.induced_by,
    status: r.status === "archived" ? "archived" : "active",
    archivedAt: r.archived_at,
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
