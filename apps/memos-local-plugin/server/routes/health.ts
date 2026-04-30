/**
 * Health + status endpoints.
 *
 * Kept boring on purpose — viewer polls these at 1–5s intervals, so
 * any allocation here compounds. The `health()` call on the core is
 * expected to be O(1) (cached).
 */

import type { ServerDeps } from "../types.js";
import type { RouteContext, Routes } from "./registry.js";

export function registerHealthRoutes(routes: Routes, deps: ServerDeps): void {
  routes.set("GET /api/v1/health", async () => {
    const health = await deps.core.health();
    const bridge = deps.bridgeStatus?.();
    return bridge ? { ...health, bridge } : health;
  });
  routes.set("GET /api/v1/ping", () => ({ ok: true, ts: Date.now() }));
  void ({} as RouteContext);
}
