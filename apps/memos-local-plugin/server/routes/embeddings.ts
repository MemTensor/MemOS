/**
 * Embedding maintenance endpoints.
 *
 * The viewer uses these after importing memories or changing embedding
 * providers/models so stored vectors are consistent with the current model.
 */
import { parseJson, type Routes } from "./registry.js";
import type { ServerDeps } from "../types.js";

export function registerEmbeddingRoutes(routes: Routes, deps: ServerDeps): void {
  routes.set("GET /api/v1/embeddings/maintenance", async () => {
    return await deps.core.embeddingMaintenanceStats();
  });

  routes.set("POST /api/v1/embeddings/rebuild", async (ctx) => {
    const body = parseJson<{
      mode?: "repair" | "rebuild";
      limit?: number;
      offset?: number;
    }>(ctx);
    return await deps.core.rebuildEmbeddings(body);
  });
}
