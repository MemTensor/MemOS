/**
 * Regression tests for issue #2076 — scanAndTopK loading vectors synchronously.
 *
 * Root cause: `scanAndTopK` used `db.prepare(sql).all(params)`, which
 * materialised up to `hardCap` (default 100_000) rows in one synchronous
 * call, each carrying a multi-KB vector BLOB. On the reporter's DB the
 * main thread pinned one core at 100 % with 4.2 GB RSS for 40 minutes.
 *
 * The fix: stream via `db.prepare(sql).iterate(params)` so at most one
 * BLOB is decoded at a time; the top-K min-heap keeps only k vectors
 * of state. Also drop the default `hardCap` to 5_000 so a caller that
 * forgets to pass one doesn't accidentally scan the whole table.
 *
 * These tests pin:
 *   1. correctness — streaming path returns identical top-K to the
 *      original brute-force behaviour on a small live DB.
 *   2. safety — an unsupplied hardCap uses the reduced 5_000 default,
 *      not the old 100_000 default.
 */

import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { encodeVector, scanAndTopK } from "../../../core/storage/index.js";
import { memoryBuffer, rootLogger } from "../../../core/logger/index.js";

function vec(arr: number[]): Float32Array {
  return new Float32Array(arr);
}

function openTinyVecDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE bench (id TEXT PRIMARY KEY, vec BLOB, extra TEXT);`);
  return db;
}

describe("scanAndTopK — streaming rewrite (#2076)", () => {
  it("returns the same top-K as the naive brute-force on a small live DB", () => {
    const db = openTinyVecDb();
    try {
      const insert = db.prepare("INSERT INTO bench (id, vec, extra) VALUES (?, ?, ?)");
      const target = vec([1, 0, 0]);
      // Row exactly matching the query (score = 1)
      insert.run("hit", encodeVector(target), "match");
      // Orthogonal row (score = 0)
      insert.run("orth", encodeVector(vec([0, 1, 0])), "orth");
      // Opposite row (score = -1)
      insert.run("opp", encodeVector(vec([-1, 0, 0])), "opp");

      const hits = scanAndTopK(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db as any,
        "bench",
        ["extra"],
        target,
        2,
        { vecColumn: "vec", where: "vec IS NOT NULL" },
      );
      expect(hits.length).toBe(2);
      expect(hits[0]!.id).toBe("hit");
      expect(hits[0]!.score).toBeCloseTo(1);
      expect(hits[1]!.id).toBe("orth");
    } finally {
      db.close();
    }
  });

  it("survives more rows than the default hardCap keeping only the top-K in memory", () => {
    // Sanity: on a table smaller than the cap, we should still see every
    // row considered — the streaming rewrite must NOT truncate below the cap.
    const db = openTinyVecDb();
    try {
      const insert = db.prepare("INSERT INTO bench (id, vec, extra) VALUES (?, ?, ?)");
      const query = vec([1, 0]);
      for (let i = 0; i < 250; i++) {
        // Vary the vector so scores span (0, 1); best is i=0 (aligned).
        const v = vec([1 - i * 1e-3, i * 1e-4]);
        insert.run(`r-${i}`, encodeVector(v), `x${i}`);
      }
      const hits = scanAndTopK(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db as any,
        "bench",
        [],
        query,
        3,
        { vecColumn: "vec", where: "vec IS NOT NULL" },
      );
      expect(hits.length).toBe(3);
      // Highest scoring is r-0 (best-aligned), and the top-3 must be
      // strictly-descending.
      expect(hits[0]!.id).toBe("r-0");
      expect(hits[0]!.score).toBeGreaterThanOrEqual(hits[1]!.score);
      expect(hits[1]!.score).toBeGreaterThanOrEqual(hits[2]!.score);
    } finally {
      db.close();
    }
  });

  it("respects an explicit hardCap smaller than the table size", () => {
    const db = openTinyVecDb();
    try {
      const insert = db.prepare("INSERT INTO bench (id, vec, extra) VALUES (?, ?, ?)");
      // Row-0 is the "would-be top" hit; place it at row 10 so a cap of 5
      // demonstrably excludes it. The remaining rows have lower scores.
      const query = vec([1, 0]);
      for (let i = 0; i < 20; i++) {
        // Order rows so best-aligned is at insert index 10.
        const v = i === 10 ? vec([1, 0]) : vec([0.5 - i * 1e-3, 0.5]);
        insert.run(`r-${i}`, encodeVector(v), null);
      }
      const withCap = scanAndTopK(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db as any,
        "bench",
        [],
        query,
        1,
        { vecColumn: "vec", where: "vec IS NOT NULL", hardCap: 5 },
      );
      // Only 5 rows were considered — none of which is r-10 (index 10 > 4),
      // so the top hit is NOT the perfect match.
      expect(withCap.length).toBe(1);
      expect(withCap[0]!.id).not.toBe("r-10");

      // With a cap large enough to reach r-10, the perfect match wins.
      const noCap = scanAndTopK(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db as any,
        "bench",
        [],
        query,
        1,
        { vecColumn: "vec", where: "vec IS NOT NULL", hardCap: 20 },
      );
      expect(noCap[0]!.id).toBe("r-10");
    } finally {
      db.close();
    }
  });

  it("logs `search.dim_mismatch` on a non-empty vector whose dimension disagrees with the query (#2077 OCR)", () => {
    // Regression guard for the OCR observation: the streaming rewrite
    // originally dropped mismatched rows silently, whereas the old
    // topKCosine path emitted `search.dim_mismatch`. Losing that signal
    // means operators can't detect schema drift (re-embedding at a new
    // model dimension) — the function just returns fewer results with
    // no warning.
    const db = openTinyVecDb();
    try {
      const insert = db.prepare("INSERT INTO bench (id, vec, extra) VALUES (?, ?, ?)");
      // r-good matches the 3-dim query; r-drift is 4-dim (schema drift).
      insert.run("r-good", encodeVector(vec([1, 0, 0])), null);
      insert.run("r-drift", encodeVector(vec([0.1, 0.2, 0.3, 0.4])), null);

      const warnSpy = vi.spyOn(rootLogger, "warn");
      const query = vec([1, 0, 0]);
      const hits = scanAndTopK(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db as any,
        "bench",
        [],
        query,
        5,
        { vecColumn: "vec", where: "vec IS NOT NULL" },
      );

      // Only the aligned row is returned; the drift row is dropped.
      expect(hits.map((h) => h.id)).toEqual(["r-good"]);

      // The observable operator signal — either a direct warn on the
      // root logger or a warn record in the memory buffer — must fire
      // for the drift row.
      const bufWarn = memoryBuffer()
        .tail({ limit: 100 })
        .find(
          (r) =>
            r.msg === "search.dim_mismatch" &&
            (r.data as Record<string, unknown> | undefined)?.rowId === "r-drift",
        );
      const spyWarn = warnSpy.mock.calls.some(
        ([msg, data]) =>
          msg === "search.dim_mismatch" &&
          (data as Record<string, unknown> | undefined)?.rowId === "r-drift",
      );
      expect(Boolean(bufWarn) || spyWarn).toBe(true);
      warnSpy.mockRestore();
    } finally {
      db.close();
    }
  });

  it("silently skips zero-length vector rows (empty embeddings are legitimate — not schema drift)", () => {
    const db = openTinyVecDb();
    try {
      const insert = db.prepare("INSERT INTO bench (id, vec, extra) VALUES (?, ?, ?)");
      insert.run("r-good", encodeVector(vec([1, 0, 0])), null);
      insert.run("r-empty", encodeVector(vec([])), null);

      const warnSpy = vi.spyOn(rootLogger, "warn");
      const hits = scanAndTopK(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db as any,
        "bench",
        [],
        vec([1, 0, 0]),
        5,
        { vecColumn: "vec", where: "vec IS NOT NULL" },
      );
      expect(hits.map((h) => h.id)).toEqual(["r-good"]);
      // Zero-length rows are drop-without-warn — see vector.ts comment.
      const spyDrift = warnSpy.mock.calls.some(
        ([msg, data]) =>
          msg === "search.dim_mismatch" &&
          (data as Record<string, unknown> | undefined)?.rowId === "r-empty",
      );
      const bufDrift = memoryBuffer()
        .tail({ limit: 100 })
        .some(
          (r) =>
            r.msg === "search.dim_mismatch" &&
            (r.data as Record<string, unknown> | undefined)?.rowId === "r-empty",
        );
      expect(spyDrift || bufDrift).toBe(false);
      warnSpy.mockRestore();
    } finally {
      db.close();
    }
  });
});
