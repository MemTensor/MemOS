import type { EmbeddingVector, PolicyId, PolicyRow } from "../../types.js";
import type { PolicyListFilter, StorageDb } from "../types.js";
import { buildInsert, buildUpdate } from "../tx.js";
import { scanAndTopK, type VectorHit } from "../vector.js";
import {
  buildPageClauses,
  fromBlob,
  fromJsonText,
  joinWhere,
  normalizeShareForStorage,
  ownerFieldsFromRaw,
  ownerParamsFromRow,
  timeRangeWhere,
  toBlob,
  toJsonText,
} from "./_helpers.js";

const COLUMNS = [
  "id",
  "owner_agent_kind",
  "owner_profile_id",
  "owner_workspace_id",
  "title",
  "trigger",
  "procedure",
  "verification",
  "boundary",
  "support",
  "gain",
  "status",
  "experience_type",
  "evidence_polarity",
  "salience",
  "confidence",
  "source_episodes_json",
  "source_feedback_ids_json",
  "source_trace_ids_json",
  "induced_by",
  "decision_guidance_json",
  "verifier_meta_json",
  "skill_eligible",
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
  experience_type?: NonNullable<PolicyRow["experienceType"]>;
  evidence_polarity?: NonNullable<PolicyRow["evidencePolarity"]>;
  salience?: number;
  confidence?: number;
  owner_agent_kind?: string;
  owner_profile_id?: string;
  owner_workspace_id?: string | null;
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

    count(filter: Omit<PolicyListFilter, "limit" | "offset"> = {}): number {
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
      const sql = `SELECT COUNT(*) AS n FROM policies ${where}`;
      return db.prepare<typeof params, { n: number }>(sql).get(params)?.n ?? 0;
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
        [
          "title",
          "status",
          "support",
          "gain",
          "experience_type",
          "evidence_polarity",
          "salience",
          "confidence",
          "owner_agent_kind",
          "owner_profile_id",
          "owner_workspace_id",
        ],
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
        scope: "private" | "local" | "public" | "hub" | null;
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
        share_scope: normalizeShareForStorage(share.scope),
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

    updateVector(id: PolicyId, vec: EmbeddingVector): boolean {
      const res = db.prepare<{ id: string; vec: Buffer; updated_at: number }>(
        `UPDATE policies SET vec=@vec, updated_at=@updated_at WHERE id=@id`,
      ).run({ id, vec: toBlob(vec)!, updated_at: Date.now() });
      return res.changes > 0;
    },
  };
}

interface RawPolicyRow {
  id: string;
  owner_agent_kind: string;
  owner_profile_id: string;
  owner_workspace_id: string | null;
  title: string;
  trigger: string;
  procedure: string;
  verification: string;
  boundary: string;
  support: number;
  gain: number;
  status: "candidate" | "active" | "archived";
  experience_type: NonNullable<PolicyRow["experienceType"]> | null;
  evidence_polarity: NonNullable<PolicyRow["evidencePolarity"]> | null;
  salience: number | null;
  confidence: number | null;
  source_episodes_json: string;
  source_feedback_ids_json: string | null;
  source_trace_ids_json: string | null;
  induced_by: string;
  decision_guidance_json: string;
  verifier_meta_json: string | null;
  skill_eligible: number | null;
  vec: Buffer | null;
  created_at: number;
  updated_at: number;
  share_scope: string | null;
  share_target: string | null;
  shared_at: number | null;
  edited_at: number | null;
}

const EMPTY_GUIDANCE: PolicyRow["decisionGuidance"] = Object.freeze({
  preference: [] as string[],
  antiPattern: [] as string[],
});

function rowToParams(row: PolicyRow): Record<string, unknown> {
  return {
    id: row.id,
    ...ownerParamsFromRow(row),
    title: row.title,
    trigger: row.trigger,
    procedure: row.procedure,
    verification: row.verification,
    boundary: row.boundary,
    support: row.support,
    gain: row.gain,
    status: row.status,
    experience_type: row.experienceType ?? "success_pattern",
    evidence_polarity: row.evidencePolarity ?? "positive",
    salience: row.salience ?? 0,
    confidence: row.confidence ?? 0.5,
    source_episodes_json: toJsonText(row.sourceEpisodeIds),
    source_feedback_ids_json: toJsonText(row.sourceFeedbackIds ?? []),
    source_trace_ids_json: toJsonText(row.sourceTraceIds ?? []),
    induced_by: row.inducedBy,
    decision_guidance_json: toJsonText({
      preference: row.decisionGuidance.preference,
      antiPattern: row.decisionGuidance.antiPattern,
    }),
    verifier_meta_json: toJsonText(row.verifierMeta ?? null),
    skill_eligible: row.skillEligible === false ? 0 : 1,
    vec: toBlob(row.vec),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    share_scope: normalizeShareForStorage(row.share?.scope),
    share_target: row.share?.target ?? null,
    shared_at: row.share?.sharedAt ?? null,
    edited_at: row.editedAt ?? null,
  };
}

function mapRow(r: RawPolicyRow): PolicyRow {
  return {
    id: r.id,
    ...ownerFieldsFromRaw(r),
    title: r.title,
    trigger: r.trigger,
    procedure: r.procedure,
    verification: r.verification,
    boundary: r.boundary,
    support: r.support,
    gain: r.gain,
    status: r.status,
    experienceType: normalizeExperienceType(r.experience_type),
    evidencePolarity: normalizeEvidencePolarity(r.evidence_polarity),
    salience: finiteOr(r.salience, 0),
    confidence: finiteOr(r.confidence, 0.5),
    sourceEpisodeIds: fromJsonText(r.source_episodes_json, []),
    sourceFeedbackIds: fromJsonText(r.source_feedback_ids_json ?? "[]", []),
    sourceTraceIds: fromJsonText(r.source_trace_ids_json ?? "[]", []),
    inducedBy: r.induced_by,
    decisionGuidance: parseGuidance(r.decision_guidance_json),
    verifierMeta: fromJsonText<Record<string, unknown> | null>(
      r.verifier_meta_json ?? "null",
      null,
    ),
    skillEligible: r.skill_eligible == null ? true : r.skill_eligible !== 0,
    vec: fromBlob(r.vec),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    share:
      r.share_scope != null
        ? {
            scope: normalizeShareForStorage(r.share_scope) as "private" | "local" | "public" | "hub",
            target: r.share_target,
            sharedAt: r.shared_at,
          }
        : null,
    editedAt: r.edited_at,
  };
}

/**
 * Deserialise the `decision_guidance_json` column into the typed
 * `{ preference, antiPattern }` shape. Defensively guards against
 * malformed JSON (returns the empty pair) since the column carries
 * LLM-derived content that may someday surprise us. Both arrays are
 * coerced to `string[]` to keep the read side honest even if a
 * future writer puts non-strings in there.
 */
function parseGuidance(raw: string): PolicyRow["decisionGuidance"] {
  if (!raw) return { ...EMPTY_GUIDANCE };
  try {
    const parsed = JSON.parse(raw) as Partial<PolicyRow["decisionGuidance"]>;
    return {
      preference: Array.isArray(parsed.preference)
        ? parsed.preference.map((s) => String(s))
        : [],
      antiPattern: Array.isArray(parsed.antiPattern)
        ? parsed.antiPattern.map((s) => String(s))
        : [],
    };
  } catch {
    return { ...EMPTY_GUIDANCE };
  }
}

function normalizeExperienceType(
  raw: NonNullable<PolicyRow["experienceType"]> | null | undefined,
): NonNullable<PolicyRow["experienceType"]> {
  switch (raw) {
    case "success_pattern":
    case "repair_validated":
    case "failure_avoidance":
    case "repair_instruction":
    case "preference":
    case "verifier_feedback":
    case "procedural":
      return raw;
    default:
      return "success_pattern";
  }
}

function normalizeEvidencePolarity(
  raw: NonNullable<PolicyRow["evidencePolarity"]> | null | undefined,
): NonNullable<PolicyRow["evidencePolarity"]> {
  switch (raw) {
    case "positive":
    case "negative":
    case "neutral":
    case "mixed":
      return raw;
    default:
      return "positive";
  }
}

function finiteOr(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
