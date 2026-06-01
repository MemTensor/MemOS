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
  EpisodeListItemDTO,
  SessionId,
} from "../../agent-contract/dto.js";
import {
  deriveEpisodeStatus,
  parseTaskStatusFilter,
} from "../../agent-contract/episode-status.js";
import type { ServerDeps } from "../types.js";
import { parseJson, writeError, type Routes } from "./registry.js";

/**
 * Upper bound for the in-memory scan window when the request applies
 * a status / preview filter. The episode table is small in practice
 * (≤ a few thousand rows per workspace), so a single bulk fetch +
 * in-memory filter is far simpler than pushing the derivation rules
 * down into SQL — and matches what `countEpisodes` already does.
 */
const FILTER_SCAN_LIMIT = 5_000;

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
    const ownerAgentKind = (ctx.url.searchParams.get("ownerAgentKind") || undefined) as
      | AgentKind
      | undefined;
    const ownerProfileId = ctx.url.searchParams.get("ownerProfileId") || undefined;
    const q = (ctx.url.searchParams.get("q") || "").trim().toLowerCase();
    const status = parseTaskStatusFilter(ctx.url.searchParams.get("status"));
    const rawLimit = numberOrUndefined(ctx.url.searchParams.get("limit"));
    const rawOffset = numberOrUndefined(ctx.url.searchParams.get("offset"));
    const limit = rawLimit && rawLimit > 0 ? rawLimit : 50;
    const offset = rawOffset && rawOffset >= 0 ? rawOffset : 0;

    // The legacy `?shape=ids` path is unaffected by `status` /
    // preview filtering — JSON-RPC callers ask for raw ids only.
    if (ctx.url.searchParams.get("shape") === "ids") {
      const total = await deps.core.countEpisodes({
        sessionId,
        ownerAgentKind,
        ownerProfileId,
        includeAllNamespaces: true,
      });
      const episodeIds = await deps.core.listEpisodes({ sessionId, limit, offset });
      return {
        episodeIds,
        limit,
        offset,
        total,
        nextOffset: episodeIds.length === limit ? offset + limit : undefined,
      };
    }

    // Filtered path (q OR status): scan a wide window and apply
    // both filters in memory, then paginate over the *filtered* set.
    // This guarantees `total` / `nextOffset` reflect what the viewer
    // actually shows — without it the chip-group filter on the
    // Tasks page reported "no matches" while the pager still claimed
    // there were more pages worth of data. `ownerAgentKind` /
    // `ownerProfileId` are passed straight to core so the multi-agent
    // namespace filter still wins before the in-memory derivation.
    if (q || status) {
      let rows = await deps.core.listEpisodeRows({
        sessionId,
        limit: FILTER_SCAN_LIMIT,
        offset: 0,
        ownerAgentKind,
        ownerProfileId,
        includeAllNamespaces: true,
      });
      if (q) {
        rows = rows.filter(
          (ep: EpisodeListItemDTO) =>
            ep.id.toLowerCase().includes(q) ||
            (!!ep.preview && ep.preview.toLowerCase().includes(q)),
        );
      }
      if (status) {
        rows = rows.filter((ep: EpisodeListItemDTO) => deriveEpisodeStatus(ep) === status);
      }
      const paged = rows.slice(offset, offset + limit);
      return {
        episodes: paged,
        limit,
        offset,
        total: rows.length,
        nextOffset: rows.length > offset + limit ? offset + limit : undefined,
      };
    }

    // Default (unfiltered) path: rely on the dedicated count query so
    // we don't pay for a 5 k-row scan on every viewer page-flip.
    const total = await deps.core.countEpisodes({
      sessionId,
      ownerAgentKind,
      ownerProfileId,
      includeAllNamespaces: true,
    });
    const episodes = await deps.core.listEpisodeRows({
      sessionId,
      limit,
      offset,
      ownerAgentKind,
      ownerProfileId,
      includeAllNamespaces: true,
    });
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
