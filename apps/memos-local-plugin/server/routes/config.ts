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
 *
 * Client-supplied PATCH bodies that fail schema validation (Typebox
 * `NumberInRange`, type mismatch, etc.) must surface as HTTP 4xx — not
 * 500 — so concurrent search/onTurnStart calls are not poisoned by a
 * misbehaving viewer or admin script. We catch `MemosError`s with the
 * `config_invalid` / `config_write_failed` codes here and translate
 * them to 400 `invalid_argument`. Any other error keeps propagating
 * to the global handler so unexpected bugs still page operators.
 *
 * Issue #1929 — the rerun harness contract tests
 * (`test_invalid_type_does_not_crash_or_corrupt`,
 * `test_concurrent_patch_and_search_no_5xx`,
 * `test_extreme_max_age_at_int_max_no_crash`) explicitly assert
 * `status_code < 500` on every malformed PATCH; without this guard the
 * server would 500 on each one and trip the harness.
 */
import { MemosError } from "../../agent-contract/errors.js";
import type { ServerDeps } from "../types.js";
import { parseJson, writeError, type Routes } from "./registry.js";

/**
 * Error codes raised by `core/config/{index,writer}.ts` that originate
 * from client input (a bad PATCH body) rather than from a server bug.
 * We map these to HTTP 400. Everything else bubbles up to the global
 * 500 handler so operators get paged on real bugs.
 */
const CLIENT_INPUT_CONFIG_ERRORS: ReadonlySet<string> = new Set([
  "config_invalid",
  "config_write_failed",
]);

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
    try {
      return await deps.core.patchConfig(patch);
    } catch (err) {
      if (MemosError.is(err) && CLIENT_INPUT_CONFIG_ERRORS.has(err.code)) {
        writeError(ctx, 400, "invalid_argument", err.message);
        return;
      }
      throw err;
    }
  });
}
