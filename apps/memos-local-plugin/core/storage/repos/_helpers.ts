/**
 * Small shared utilities for repositories. Each repo should be a dumb mapper
 * between `XxxRow` (see `core/types.ts`) and a SQLite row — any algorithm
 * logic belongs outside of storage.
 */

import { rootLogger } from "../../logger/index.js";
import { decodeVector, encodeVector } from "../vector.js";
import type { EmbeddingVector } from "../../types.js";
import type { RuntimeNamespace, ShareScope } from "../../../agent-contract/dto.js";
import {
  normalizeShareScope,
  ownerFromNamespace,
  visibilityWhere as runtimeVisibilityWhere,
} from "../../runtime/namespace.js";
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

/**
 * Maximum rows a single paged query may return. Explicit limits are honored
 * up to this ceiling instead of being clamped to a 500-row page (#2401);
 * it also bounds the result when a direct `clampLimit` caller passes
 * invalid input. Tune here, not at call sites.
 */
export const MAX_QUERY_LIMIT = 100_000;

/** True only for finite positive numbers — anything else means "all rows". */
function hasUsableLimit(n: number | undefined): n is number {
  return n !== undefined && Number.isFinite(n) && n > 0;
}

export function buildPageClauses(opts: PageOptions | undefined, tsColumn: string): string {
  const newestFirst = opts?.newestFirst !== false;
  const order = `ORDER BY ${tsColumn} ${newestFirst ? "DESC" : "ASC"}`;
  // Omitting `limit` means "all matching rows" (#2401) — the same contract
  // the episode-scan fix (#2076) pinned for `traces.list({ episodeId })`.
  // Callers that want a page must pass an explicit limit. Never silently
  // truncate scan paths (counters, dedup sweeps, clustering) to a page.
  // An invalid limit (non-finite, 0, negative) is treated the same as an
  // omitted one — it must not silently substitute a page either.
  // (SQLite has no OFFSET without LIMIT, so offset only applies when a
  // limit is present.)
  if (!hasUsableLimit(opts?.limit)) return order;
  const offset = Math.max(opts.offset ?? 0, 0);
  return `${order} LIMIT ${clampLimit(opts.limit)} OFFSET ${offset}`;
}

export function clampLimit(n: number): number {
  // Explicit limits are honored up to the MAX_QUERY_LIMIT safety ceiling
  // instead of being clamped to a 500-row page (#2401). For invalid input,
  // return the ceiling as a defensive floor — query paths never hit this
  // (buildPageClauses treats invalid limits as "no LIMIT clause"), but
  // direct callers (e.g. episodes.listClosedPage) still get a sane bound.
  if (!Number.isFinite(n) || n <= 0) return MAX_QUERY_LIMIT;
  return Math.min(Math.trunc(n), MAX_QUERY_LIMIT);
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

export function ownerColumns(): string[] {
  return ["owner_agent_kind", "owner_profile_id", "owner_workspace_id"];
}

export function ownerParamsFromRow(row: {
  ownerAgentKind?: string;
  ownerProfileId?: string;
  ownerWorkspaceId?: string | null;
}): Record<string, unknown> {
  return {
    owner_agent_kind: row.ownerAgentKind ?? "unknown",
    owner_profile_id: row.ownerProfileId ?? "default",
    owner_workspace_id: row.ownerWorkspaceId ?? null,
  };
}

export function ownerFieldsFromRaw(r: {
  owner_agent_kind?: string | null;
  owner_profile_id?: string | null;
  owner_workspace_id?: string | null;
}): {
  ownerAgentKind: string;
  ownerProfileId: string;
  ownerWorkspaceId: string | null;
} {
  return {
    ownerAgentKind: r.owner_agent_kind || "unknown",
    ownerProfileId: r.owner_profile_id || "default",
    ownerWorkspaceId: r.owner_workspace_id ?? null,
  };
}

export function defaultOwnerFields(ns?: RuntimeNamespace | null): {
  ownerAgentKind: string;
  ownerProfileId: string;
  ownerWorkspaceId: string | null;
} {
  return ns ? ownerFromNamespace(ns) : {
    ownerAgentKind: "unknown",
    ownerProfileId: "default",
    ownerWorkspaceId: null,
  };
}

export function visibilityWhere(ns: RuntimeNamespace, alias = ""): {
  sql: string;
  params: Record<string, unknown>;
} {
  return runtimeVisibilityWhere(ns, alias);
}

export function normalizeShareForStorage(scope: unknown): ShareScope {
  return normalizeShareScope(scope);
}

export function rowOr<T>(row: RawRow | undefined, map: (r: RawRow) => T): T | null {
  if (!row) return null;
  return map(row);
}
