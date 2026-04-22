/**
 * Config read/write endpoints.
 *
 *   GET   /api/v1/config    → current resolved `config.yaml` with
 *                             sensitive fields masked as `"••••"`.
 *   PATCH /api/v1/config    → deep-merge a partial object into
 *                             `config.yaml`. Secrets left as `""` or
 *                             `"••••"` are ignored (so the UI can
 *                             rehydrate the form without wiping keys).
 *
 * Writes go through `core/config/writer.ts::patchConfig`, which
 * preserves comments + field order and re-applies `chmod 600`.
 */
import type { ServerDeps } from "../types.js";
import { parseJson, writeError, type Routes } from "./registry.js";

export function registerConfigRoutes(routes: Routes, deps: ServerDeps): void {
  routes.set("GET /api/v1/config", async () => {
    return await deps.core.getConfig();
  });

  routes.set("PATCH /api/v1/config", async (ctx) => {
    const patch = parseJson<Record<string, unknown>>(ctx);
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      writeError(ctx, 400, "invalid_argument", "body must be a JSON object");
      return;
    }
    return await deps.core.patchConfig(patch);
  });
}
