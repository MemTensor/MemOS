/**
 * `api_logs` repository — structured log of the user-facing memory
 * operations (`memory_search`, `memory_add`). Mirrors the legacy
 * `memos-local-openclaw` plugin's table so the new viewer can render
 * the same rich JSON payloads (candidates, filtered, hub results,
 * ingestion stats, …).
 *
 * Schema: see `core/storage/migrations/007-api-logs.sql`.
 *
 * Write path: invoked synchronously inside the pipeline whenever we
 * complete a `memory.search` retrieval (adapter tool bridge) or an
 * `agent_end`-driven ingest turn.
 *
 * Read path: paginated newest-first by `called_at`. The viewer tails
 * the table via `GET /api/v1/api-logs`.
 */

import type { StorageDb } from "../types.js";

export interface ApiLogRow {
  id: number;
  toolName: string;
  inputJson: string;
  outputJson: string;
  durationMs: number;
  success: boolean;
  calledAt: number;
}

export interface ApiLogInsert {
  toolName: string;
  input: unknown;
  output: unknown;
  durationMs: number;
  success: boolean;
  calledAt?: number;
}

export interface ApiLogFilter {
  /** Filter by a single tool name. */
  toolName?: string;
  /** Filter by several tool names while preserving newest-first pagination. */
  toolNames?: readonly string[];
  /** Default 50; max 500 to keep viewer paint times sane. */
  limit?: number;
  offset?: number;
}

export function makeApiLogsRepo(db: StorageDb) {
  const insert = db.prepare<
    {
      tool_name: string;
      input_json: string;
      output_json: string;
      duration_ms: number;
      success: number;
      called_at: number;
    }
  >(
    `INSERT INTO api_logs (tool_name, input_json, output_json, duration_ms, success, called_at)
     VALUES (@tool_name, @input_json, @output_json, @duration_ms, @success, @called_at)`,
  );

  const countAll = db.prepare<{}, { n: number }>(
    `SELECT COUNT(*) AS n FROM api_logs`,
  );
  const countByTool = db.prepare<{ tool_name: string }, { n: number }>(
    `SELECT COUNT(*) AS n FROM api_logs WHERE tool_name = @tool_name`,
  );
  const selectAll = db.prepare<
    { limit: number; offset: number },
    RawRow
  >(
    `SELECT id, tool_name, input_json, output_json, duration_ms, success, called_at
     FROM api_logs
     ORDER BY called_at DESC, id DESC
     LIMIT @limit OFFSET @offset`,
  );
  const selectByTool = db.prepare<
    { tool_name: string; limit: number; offset: number },
    RawRow
  >(
    `SELECT id, tool_name, input_json, output_json, duration_ms, success, called_at
     FROM api_logs
     WHERE tool_name = @tool_name
     ORDER BY called_at DESC, id DESC
     LIMIT @limit OFFSET @offset`,
  );

  const countByToolNames = (toolNames: readonly string[]): number => {
    const names = normalizeToolNames(toolNames);
    if (names.length === 0) return countAll.get({})?.n ?? 0;
    if (names.length === 1) {
      return countByTool.get({ tool_name: names[0]! })?.n ?? 0;
    }
    const params = namedToolParams(names);
    const placeholders = Object.keys(params).map((key) => `@${key}`).join(", ");
    const row = db
      .prepare<Record<string, string>, { n: number }>(
        `SELECT COUNT(*) AS n FROM api_logs WHERE tool_name IN (${placeholders})`,
      )
      .get(params);
    return row?.n ?? 0;
  };

  const selectByToolNames = (
    toolNames: readonly string[],
    limit: number,
    offset: number,
  ): RawRow[] => {
    const names = normalizeToolNames(toolNames);
    if (names.length === 0) return selectAll.all({ limit, offset });
    if (names.length === 1) {
      return selectByTool.all({ tool_name: names[0]!, limit, offset });
    }
    const toolParams = namedToolParams(names);
    const placeholders = Object.keys(toolParams).map((key) => `@${key}`).join(", ");
    return db
      .prepare<Record<string, string | number>, RawRow>(
        `SELECT id, tool_name, input_json, output_json, duration_ms, success, called_at
         FROM api_logs
         WHERE tool_name IN (${placeholders})
         ORDER BY called_at DESC, id DESC
         LIMIT @limit OFFSET @offset`,
      )
      .all({ ...toolParams, limit, offset });
  };

  return {
    insert(row: ApiLogInsert): void {
      insert.run({
        tool_name: row.toolName,
        input_json: typeof row.input === "string" ? row.input : safeStringify(row.input),
        output_json: typeof row.output === "string" ? row.output : safeStringify(row.output),
        duration_ms: Math.max(0, Math.floor(row.durationMs)),
        success: row.success ? 1 : 0,
        called_at: row.calledAt ?? Date.now(),
      });
    },

    count(filter: Pick<ApiLogFilter, "toolName" | "toolNames"> = {}): number {
      if (filter.toolNames?.length) {
        return countByToolNames(filter.toolNames);
      }
      if (filter.toolName) {
        return countByTool.get({ tool_name: filter.toolName })?.n ?? 0;
      }
      return countAll.get({})?.n ?? 0;
    },

    list(filter: ApiLogFilter = {}): ApiLogRow[] {
      const limit = Math.max(1, Math.min(500, filter.limit ?? 50));
      const offset = Math.max(0, filter.offset ?? 0);
      const rows = filter.toolNames?.length
        ? selectByToolNames(filter.toolNames, limit, offset)
        : filter.toolName
        ? selectByTool.all({ tool_name: filter.toolName, limit, offset })
        : selectAll.all({ limit, offset });
      return rows.map(mapRow);
    },
  };
}

function normalizeToolNames(toolNames: readonly string[]): string[] {
  return [...new Set(toolNames.map((name) => name.trim()).filter(Boolean))];
}

function namedToolParams(toolNames: readonly string[]): Record<string, string> {
  return Object.fromEntries(toolNames.map((name, index) => [`tool_${index}`, name]));
}

interface RawRow {
  id: number;
  tool_name: string;
  input_json: string;
  output_json: string;
  duration_ms: number;
  success: number;
  called_at: number;
}

function mapRow(r: RawRow): ApiLogRow {
  return {
    id: r.id,
    toolName: r.tool_name,
    inputJson: r.input_json,
    outputJson: r.output_json,
    durationMs: r.duration_ms,
    success: !!r.success,
    calledAt: r.called_at,
  };
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v ?? {});
  } catch {
    return "{}";
  }
}
