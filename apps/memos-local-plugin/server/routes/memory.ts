/**
 * Memory query endpoints.
 *
 * All of these are read-only projections of core state. The viewer
 * uses them to render the timeline, trace details, and search box.
 * Write-side turn-lifecycle operations live in `session.ts` +
 * `events.ts`.
 */

import type { AgentKind, RetrievalQueryDTO } from "../../agent-contract/dto.js";
import type { ServerDeps, ServerOptions } from "../types.js";
import { parseJson, writeError, type RouteContext, type Routes } from "./registry.js";

const MAX_SEARCH_QUERY_CHARS = 512;

export function registerMemoryRoutes(
  routes: Routes,
  deps: ServerDeps,
  options: ServerOptions = {},
): void {
  const defaultAgent: AgentKind = options.agent ?? "openclaw";

  // GET variant — the viewer uses this so it can stay querystring-only.
  // `q` is the search text; `top` caps the result count per tier.
  routes.set("GET /api/v1/memory/search", async (ctx) => {
    const q = ctx.url.searchParams.get("q");
    if (!q || q.trim().length === 0) {
      // Empty query is legal — returns zero hits with tier timings.
      return { hits: [], injectedContext: "", tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 } };
    }
    if (!validateSearchQuery(ctx, q)) return;
    const top = clampTop(ctx.url.searchParams.get("top"));
    const agent = (ctx.url.searchParams.get("agent") as AgentKind | null) ?? defaultAgent;
    const sessionId = (ctx.url.searchParams.get("sessionId") ?? undefined) as string | undefined;
    return await deps.core.searchMemory({
      agent,
      query: q,
      sessionId: sessionId as never,
      topK: { tier1: top, tier2: top, tier3: top },
    });
  });

  routes.set("POST /api/v1/memory/search", async (ctx) => {
    const q = parseJson<Partial<RetrievalQueryDTO>>(ctx);
    if (!q.query || typeof q.query !== "string") {
      writeError(ctx, 400, "invalid_argument", "query is required");
      return;
    }
    if (!validateSearchQuery(ctx, q.query)) return;
    const agent: AgentKind = (q.agent as AgentKind | undefined) ?? defaultAgent;
    return await deps.core.searchMemory({
      agent,
      query: q.query,
      sessionId: q.sessionId,
      episodeId: q.episodeId,
      filters: q.filters,
      topK: q.topK,
    });
  });

  routes.set("GET /api/v1/memory/trace", async (ctx) => {
    const id = ctx.url.searchParams.get("id");
    if (!id) {
      writeError(ctx, 400, "invalid_argument", "id is required");
      return;
    }
    const trace = await deps.core.getTrace(id);
    if (trace === null) {
      writeError(ctx, 404, "not_found", `trace not found: ${id}`);
      return;
    }
    return trace;
  });

  routes.set("GET /api/v1/memory/policy", async (ctx) => {
    const id = ctx.url.searchParams.get("id");
    if (!id) {
      writeError(ctx, 400, "invalid_argument", "id is required");
      return;
    }
    const policy = await deps.core.getPolicy(id);
    if (policy === null) {
      writeError(ctx, 404, "not_found", `policy not found: ${id}`);
      return;
    }
    return policy;
  });

  routes.set("GET /api/v1/memory/world", async (ctx) => {
    const id = ctx.url.searchParams.get("id");
    if (!id) {
      writeError(ctx, 400, "invalid_argument", "id is required");
      return;
    }
    const wm = await deps.core.getWorldModel(id);
    if (wm === null) {
      writeError(ctx, 404, "not_found", `world model not found: ${id}`);
      return;
    }
    return wm;
  });
}

function validateSearchQuery(
  ctx: RouteContext,
  query: string,
): boolean {
  if (query.length <= MAX_SEARCH_QUERY_CHARS) return true;
  writeError(
    ctx,
    400,
    "invalid_argument",
    `query is too long; max ${MAX_SEARCH_QUERY_CHARS} characters`,
  );
  return false;
}

function clampTop(raw: string | null): number {
  const n = Number(raw ?? 10);
  if (!Number.isFinite(n) || n < 1) return 10;
  return Math.min(n, 50);
}
