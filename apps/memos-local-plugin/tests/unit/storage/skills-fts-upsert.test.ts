/**
 * Regression guard for issue #2363:
 *
 * `skills.upsert` compiles to `INSERT OR REPLACE INTO skills`. SQLite implements
 * REPLACE by internally deleting the conflicting row and then inserting the new
 * one. Per SQLite's docs, the row-delete happens WITHOUT firing DELETE triggers
 * unless `PRAGMA recursive_triggers` is ON. Because SQLite defaults that pragma
 * to OFF (and better-sqlite3 does not override it), the AFTER DELETE trigger
 * `skills_fts_ad` never fires on upsert-on-conflict, leaving the old FTS row
 * behind while the AFTER INSERT trigger appends a fresh one. `skills_fts` then
 * accumulates orphan rows relative to `skills`, and `searchByText` starts to
 * rank/paginate over duplicate/stale hits.
 *
 * These tests exercise the DB layer directly (no core.skill pipeline needed) so
 * the failing case is obvious.
 */

import { describe, expect, it } from "vitest";

import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";

function vec(arr: number[]): Float32Array {
  return new Float32Array(arr);
}

function baseSkill(handle: TmpDbHandle, opts: {
  id: string;
  name: string;
  invocationGuide: string;
}) {
  handle.repos.skills.upsert({
    id: opts.id as never,
    name: opts.name,
    status: "active",
    invocationGuide: opts.invocationGuide,
    procedureJson: null,
    eta: 0.5,
    support: 1,
    gain: 0.2,
    trialsAttempted: 0,
    trialsPassed: 0,
    sourcePolicyIds: [],
    sourceWorldModelIds: [],
    evidenceAnchors: [],
    vec: vec([1, 0, 0]),
    createdAt: 0 as never,
    updatedAt: 0 as never,
    version: 1,
  });
}

function countFts(handle: TmpDbHandle, table: string, idCol: string, id: string): number {
  return (
    handle.db
      .prepare<{ id: string }, { n: number }>(
        `SELECT COUNT(*) AS n FROM ${table} WHERE ${idCol} = @id`,
      )
      .get({ id })?.n ?? 0
  );
}

describe("storage/skills — upsert keeps skills_fts consistent (regression #2363)", () => {
  it("upserting an existing skill does not leave an orphan skills_fts row", () => {
    const handle = makeTmpDb();
    try {
      const id = "sk_upsert_2363";
      baseSkill(handle, {
        id,
        name: "original name",
        invocationGuide: "originalguideneedle",
      });

      // Sanity: the AFTER INSERT trigger populated the FTS side.
      expect(countFts(handle, "skills_fts", "skill_id", id)).toBe(1);

      // Upsert same id with new indexed content. Under recursive_triggers=OFF,
      // the internal REPLACE delete skips the AFTER DELETE trigger, so the old
      // FTS row is left behind AND the AFTER INSERT trigger appends a new one.
      baseSkill(handle, {
        id,
        name: "revised name",
        invocationGuide: "revisedguideneedle",
      });

      // Base row is still a single row (REPLACE semantics on `skills`).
      const skillRows = handle.db
        .prepare<{ id: string }, { n: number }>(
          `SELECT COUNT(*) AS n FROM skills WHERE id = @id`,
        )
        .get({ id })?.n;
      expect(skillRows).toBe(1);

      // FTS side must mirror the base row: exactly one entry for this skill.
      expect(countFts(handle, "skills_fts", "skill_id", id)).toBe(1);

      // Global invariant: skills_fts row count matches skills row count.
      const total = handle.db
        .prepare<unknown, { skills: number; fts: number }>(
          `SELECT (SELECT COUNT(*) FROM skills) AS skills,
                  (SELECT COUNT(*) FROM skills_fts) AS fts`,
        )
        .get();
      expect(total?.fts).toBe(total?.skills);
    } finally {
      handle.cleanup();
    }
  });

  it("stale invocation-guide text no longer matches after upsert", () => {
    const handle = makeTmpDb();
    try {
      const id = "sk_stale_2363";
      baseSkill(handle, {
        id,
        name: "docker syslib install fix",
        invocationGuide: "obsoletetokenalpha kubernetes pod restart",
      });

      // Pre-upsert: the old token should hit.
      const preHits = handle.repos.skills.searchByText('"obsoletetokenalpha"', 10);
      expect(preHits.map((h) => h.id)).toContain(id);

      baseSkill(handle, {
        id,
        name: "docker syslib install fix",
        invocationGuide: "freshtokenbeta kubernetes pod restart",
      });

      // Post-upsert: the old token must NOT hit any longer — otherwise the
      // repos.searchByText ranker will surface stale content.
      const staleHits = handle.repos.skills.searchByText('"obsoletetokenalpha"', 10);
      expect(staleHits.map((h) => h.id)).not.toContain(id);

      const freshHits = handle.repos.skills.searchByText('"freshtokenbeta"', 10);
      expect(freshHits.map((h) => h.id)).toContain(id);
    } finally {
      handle.cleanup();
    }
  });

  it("connection sets recursive_triggers ON so REPLACE-driven deletes fire triggers", () => {
    const handle = makeTmpDb();
    try {
      const rt = (handle.db.raw.pragma("recursive_triggers") as Array<{
        recursive_triggers: number;
      }>)[0]?.recursive_triggers;
      expect(rt).toBe(1);
    } finally {
      handle.cleanup();
    }
  });
});
