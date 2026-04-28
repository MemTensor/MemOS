/**
 * Trace + episode path-param endpoints.
 *
 * These routes use the pattern matcher (`routes.setPattern`) so the
 * viewer can do `GET /api/v1/traces/<id>` and
 * `GET /api/v1/episodes/<id>/timeline` without query-string gymnastics.
 * The unparameterised endpoints `/api/v1/memory/trace?id=…` live on
 * for backward compatibility.
 */
import type { EpisodeId, SessionId } from "../../agent-contract/dto.js";
import type { ServerDeps } from "../types.js";
import { parseJson, writeError, type Routes } from "./registry.js";

export function registerTraceRoutes(routes: Routes, deps: ServerDeps): void {
  /**
   * GET /api/v1/traces
   *   ?limit=50         (max 500)
   *   &offset=0
   *   &sessionId=<id>   (optional filter)
   *   &q=<substring>    (optional case-insensitive summary/text filter)
   *
   * Returns: { traces: TraceDTO[], limit, offset, nextOffset? }
   *
   * Used by the Memories viewer as its primary "list" endpoint so
   * users can see their memory entries even when semantic retrieval
   * would miss them (fresh install, empty query, embedder offline).
   */
  routes.set("GET /api/v1/traces", async (ctx) => {
    const params = ctx.url.searchParams;
    const parsedLimit = Number(params.get("limit"));
    const parsedOffset = Number(params.get("offset"));
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50;
    const offset = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;
    const sessionId = params.get("sessionId") || undefined;
    const q = params.get("q") || undefined;
    // When `groupByTurn=true`, pagination treats each (episodeId, turnId)
    // pair as one "memory" — matching the viewer's grouped display where
    // a user query + its tool steps + final reply collapse into one card.
    const groupByTurn = params.get("groupByTurn") === "true";
    const traces = await deps.core.listTraces({
      limit,
      offset,
      sessionId: sessionId as SessionId | undefined,
      q,
      groupByTurn,
    });
    const total = await deps.core.countTraces({
      sessionId: sessionId as SessionId | undefined,
      q,
      groupByTurn,
    });
    // When grouping, `traces.length === limit` is no longer a reliable
    // "has more" signal (a single turn can yield many traces). Use the
    // total count instead to detect a next page.
    const nextOffset = groupByTurn
      ? offset + limit < total ? offset + limit : undefined
      : traces.length === limit ? offset + limit : undefined;
    return {
      traces,
      limit,
      offset,
      total,
      nextOffset,
    };
  });

  routes.setPattern("GET /api/v1/traces/:id", async (ctx) => {
    const id = ctx.params.id;
    if (!id) {
      writeError(ctx, 400, "invalid_argument", "id is required");
      return;
    }
    const trace = await deps.core.getTrace(id);
    if (!trace) {
      writeError(ctx, 404, "not_found", `trace not found: ${id}`);
      return;
    }
    return trace;
  });

  /**
   * PATCH /api/v1/traces/:id — viewer's edit modal. Mutable fields:
   * summary, userText, agentText, tags. Returns the updated DTO.
   */
  routes.setPattern("PATCH /api/v1/traces/:id", async (ctx) => {
    const id = ctx.params.id;
    if (!id) {
      writeError(ctx, 400, "invalid_argument", "id is required");
      return;
    }
    const body = parseJson<{
      summary?: string | null;
      userText?: string;
      agentText?: string;
      tags?: string[];
    }>(ctx);
    const updated = await deps.core.updateTrace(id, body);
    if (!updated) {
      writeError(ctx, 404, "not_found", `trace not found: ${id}`);
      return;
    }
    return updated;
  });

  /**
   * DELETE /api/v1/traces/:id — hard delete. Idempotent: returns
   * `{ deleted: false }` when the id is unknown.
   */
  routes.setPattern("DELETE /api/v1/traces/:id", async (ctx) => {
    const id = ctx.params.id;
    if (!id) {
      writeError(ctx, 400, "invalid_argument", "id is required");
      return;
    }
    return await deps.core.deleteTrace(id);
  });

  /**
   * POST /api/v1/traces/delete — bulk delete.
   *   body: { ids: string[] }
   * Used by the viewer's "批量删除" bar.
   */
  routes.set("POST /api/v1/traces/delete", async (ctx) => {
    const body = parseJson<{ ids?: unknown }>(ctx);
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((v): v is string => typeof v === "string" && v.length > 0)
      : [];
    if (ids.length === 0) {
      writeError(ctx, 400, "invalid_argument", "ids[] is required");
      return;
    }
    return await deps.core.deleteTraces(ids);
  });

  /**
   * POST /api/v1/traces/:id/share — set or clear the share state.
   *   body: {
   *     scope: 'private' | 'public' | 'hub' | null,
   *     target?: string,
   *     anonymize?: boolean  // (reserved; currently advisory only)
   *   }
   */
  routes.setPattern("POST /api/v1/traces/:id/share", async (ctx) => {
    const id = ctx.params.id;
    if (!id) {
      writeError(ctx, 400, "invalid_argument", "id is required");
      return;
    }
    const body = parseJson<{
      scope?: "private" | "public" | "hub" | null;
      target?: string | null;
    }>(ctx);
    const scope = body.scope === undefined ? "public" : body.scope;
    const updated = await deps.core.shareTrace(id, {
      scope: scope ?? null,
      target: body.target ?? null,
      sharedAt: scope ? Date.now() : null,
    });
    if (!updated) {
      writeError(ctx, 404, "not_found", `trace not found: ${id}`);
      return;
    }
    return updated;
  });

  routes.setPattern("GET /api/v1/episodes/:id/timeline", async (ctx) => {
    const id = ctx.params.id as EpisodeId | undefined;
    if (!id) {
      writeError(ctx, 400, "invalid_argument", "id is required");
      return;
    }
    const traces = await deps.core.timeline({ episodeId: id });
    return { episodeId: id, traces };
  });
}
