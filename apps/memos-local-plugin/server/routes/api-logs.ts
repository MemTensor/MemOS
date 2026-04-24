/**
 * `GET /api/v1/api-logs` — paged listing of the structured `api_logs`
 * table (defined in the squashed initial schema). Fuels the viewer's
 * Logs page which renders rich per-tool templates for `memory_search`
 * and `memory_add`.
 *
 * Query parameters:
 *   - `tool`    optional tool-name filter (e.g. `memory_search`)
 *   - `limit`   default 50, capped server-side at 500
 *   - `offset`  default 0
 *
 * Response:
 *   { logs: ApiLogDTO[], total: number, limit, offset, nextOffset? }
 */
import type { ServerDeps } from "../types.js";
import type { Routes } from "./registry.js";

export function registerApiLogsRoutes(routes: Routes, deps: ServerDeps): void {
  routes.set("GET /api/v1/api-logs", async (ctx) => {
    const params = ctx.url.searchParams;
    const parsedLimit = Number(params.get("limit"));
    const parsedOffset = Number(params.get("offset"));
    const limit =
      Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50;
    const offset =
      Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;
    const tool = params.get("tool") || undefined;
    const res = await deps.core.listApiLogs({
      toolName: tool,
      limit,
      offset,
    });
    return {
      ...res,
      limit,
      offset,
      nextOffset: offset + res.logs.length < res.total ? offset + res.logs.length : undefined,
    };
  });

  /**
   * `GET /api/v1/api-logs/tools` — compact list of tool names
   * currently in the table, for the viewer's filter dropdown. We
   * don't expose a dedicated repo method — the counts are cheap to
   * derive from two `listApiLogs` calls.
   */
  routes.set("GET /api/v1/api-logs/tools", async () => {
    // Stable order for the filter dropdown. The viewer groups these
    // into "memory" / "skill" / "experience" / "domain" / "task" sub-
    // categories in the UI — keeping the server list flat keeps the
    // API simple. Any tool name not in this list still appears if the
    // user passes it via `?tool=` explicitly.
    const tools = [
      "memory_search",
      "memory_add",
      "skill_generate",
      "skill_evolve",
      "policy_generate",
      "policy_evolve",
      "world_model_generate",
      "world_model_evolve",
      "task_done",
      "task_failed",
    ] as const;
    const rows = await Promise.all(
      tools.map(async (t) => {
        const r = await deps.core.listApiLogs({ toolName: t, limit: 1, offset: 0 });
        return { tool: t, count: r.total };
      }),
    );
    return { tools: rows };
  });
}
