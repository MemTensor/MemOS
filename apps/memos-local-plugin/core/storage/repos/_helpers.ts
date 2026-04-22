/**
 * Small shared utilities for repositories. Each repo should be a dumb mapper
 * between `XxxRow` (see `core/types.ts`) and a SQLite row — any algorithm
 * logic belongs outside of storage.
 */

import { rootLogger } from "../../logger/index.js";
import { decodeVector, encodeVector } from "../vector.js";
import type { EmbeddingVector } from "../../types.js";
import type { PageOptions, RawRow, TimeRange } from "../types.js";

export const repoLog = rootLogger.child({ channel: "storage.repos" });

export function toJsonText(v: unknown): string {
  return JSON.stringify(v ?? null);
}

export function fromJsonText<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw !== "string") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function toBlob(v: EmbeddingVector | null | undefined): Buffer | null {
  if (!v) return null;
  return encodeVector(v);
}

export function fromBlob(v: unknown): EmbeddingVector | null {
  if (v === null || v === undefined) return null;
  if (!(v instanceof Buffer) && !(v instanceof Uint8Array)) return null;
  return decodeVector(v as Buffer);
}

export function nullable<T>(v: T | undefined): T | null {
  return v === undefined ? null : v;
}

export function buildPageClauses(opts: PageOptions | undefined, tsColumn: string): string {
  const newestFirst = opts?.newestFirst !== false;
  const limit = clampLimit(opts?.limit ?? 50);
  const offset = Math.max(opts?.offset ?? 0, 0);
  return `ORDER BY ${tsColumn} ${newestFirst ? "DESC" : "ASC"} LIMIT ${limit} OFFSET ${offset}`;
}

export function clampLimit(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(Math.trunc(n), 500);
}

export function timeRangeWhere(
  range: TimeRange | undefined,
  column: string,
): { sql: string; params: Record<string, number> } {
  if (!range) return { sql: "", params: {} };
  const params: Record<string, number> = {};
  const parts: string[] = [];
  if (range.fromMs !== undefined) {
    parts.push(`${column} >= @range_from`);
    params.range_from = range.fromMs;
  }
  if (range.toMs !== undefined) {
    parts.push(`${column} <= @range_to`);
    params.range_to = range.toMs;
  }
  return { sql: parts.join(" AND "), params };
}

/** Merge several fragment clauses into one `WHERE ...` string (or empty). */
export function joinWhere(fragments: Array<string | undefined>): string {
  const parts = fragments.filter((p): p is string => Boolean(p && p.trim()));
  if (parts.length === 0) return "";
  return `WHERE ${parts.join(" AND ")}`;
}

export function rowOr<T>(row: RawRow | undefined, map: (r: RawRow) => T): T | null {
  if (!row) return null;
  return map(row);
}
