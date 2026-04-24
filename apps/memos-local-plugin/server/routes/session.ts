/**
 * Session + episode lifecycle endpoints.
 *
 * The server is a thin wrapper around `MemoryCore` here. Each method
 * maps 1:1 to the equivalent JSON-RPC call in `bridge/methods.ts`, so
 * the web viewer and an external JSON-RPC client see the same shape.
 */

import type {
  AgentKind,
  EpisodeId,
  SessionId,
} from "../../agent-contract/dto.js";
import type { ServerDeps } from "../types.js";
import { parseJson, writeError, type Routes } from "./registry.js";

export function registerSessionRoutes(routes: Routes, deps: ServerDeps): void {
  routes.set("POST /api/v1/sessions", async (ctx) => {
    const { agent, sessionId } = parseJson<{ agent?: AgentKind; sessionId?: SessionId }>(ctx);
    if (!agent) {
      writeError(ctx, 400, "invalid_argument", "agent is required");
      return;
    }
    const id = await deps.core.openSession({ agent, sessionId });
    return { sessionId: id };
  });

  routes.set("DELETE /api/v1/sessions", async (ctx) => {
    const id = ctx.url.searchParams.get("sessionId");
    if (!id) {
      writeError(ctx, 400, "invalid_argument", "sessionId is required");
      return;
    }
    await deps.core.closeSession(id as SessionId);
    return { ok: true };
  });

  routes.set("POST /api/v1/episodes", async (ctx) => {
    const { sessionId, episodeId } = parseJson<{ sessionId?: SessionId; episodeId?: EpisodeId }>(ctx);
    if (!sessionId) {
      writeError(ctx, 400, "invalid_argument", "sessionId is required");
      return;
    }
    const id = await deps.core.openEpisode({ sessionId, episodeId });
    return { episodeId: id };
  });

  routes.set("DELETE /api/v1/episodes", async (ctx) => {
    const id = ctx.url.searchParams.get("episodeId");
    if (!id) {
      writeError(ctx, 400, "invalid_argument", "episodeId is required");
      return;
    }
    await deps.core.closeEpisode(id as EpisodeId);
    return { ok: true };
  });

  routes.set("GET /api/v1/episodes", async (ctx) => {
    const sessionId = (ctx.url.searchParams.get("sessionId") as SessionId | null) ?? undefined;
    const rawLimit = numberOrUndefined(ctx.url.searchParams.get("limit"));
    const rawOffset = numberOrUndefined(ctx.url.searchParams.get("offset"));
    const limit = rawLimit && rawLimit > 0 ? rawLimit : 50;
    const offset = rawOffset && rawOffset >= 0 ? rawOffset : 0;
    // Return the rich row shape — the viewer's task list needs
    // session id / status / turn count / preview. The old `ids`-only
    // variant is still available under the `episode.list` JSON-RPC
    // method and via `?shape=ids`.
    const total = await deps.core.countEpisodes({ sessionId });
    if (ctx.url.searchParams.get("shape") === "ids") {
      const episodeIds = await deps.core.listEpisodes({ sessionId, limit, offset });
      return {
        episodeIds,
        limit,
        offset,
        total,
        nextOffset: episodeIds.length === limit ? offset + limit : undefined,
      };
    }
    const episodes = await deps.core.listEpisodeRows({ sessionId, limit, offset });
    return {
      episodes,
      limit,
      offset,
      total,
      nextOffset: episodes.length === limit ? offset + limit : undefined,
    };
  });

  // Backward-compat: legacy `/api/v1/episodes/timeline?episodeId=…`
  // still works; the preferred path `/api/v1/episodes/:id/timeline`
  // is registered in `trace.ts`.
  routes.set("GET /api/v1/episodes/timeline", async (ctx) => {
    const episodeId = ctx.url.searchParams.get("episodeId");
    if (!episodeId) {
      writeError(ctx, 400, "invalid_argument", "episodeId is required");
      return;
    }
    const traces = await deps.core.timeline({ episodeId: episodeId as EpisodeId });
    return { episodeId, traces };
  });
}

function numberOrUndefined(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
