/**
 * Aggregated overview endpoint.
 *
 * The viewer's Overview tab wants a single payload describing the
 * rough state of the system: how many memories (traces), tasks
 * (episodes), experiences (L2 policies), environment knowledge
 * entries (L3 world models), and skills. We compose this from
 * existing `MemoryCore` methods so the core contract doesn't have to
 * grow an "overview" method.
 *
 * The response also includes the `health()` block so the frontend
 * header and overview share one payload shape — no schema changes on
 * either side when we add a new metric (e.g. model names).
 */

import type { ServerDeps } from "../types.js";
import type { Routes } from "./registry.js";

export function registerOverviewRoutes(routes: Routes, deps: ServerDeps): void {
  let viewerTracked = false;
  routes.set("GET /api/v1/overview", async () => {
    if (!viewerTracked) {
      viewerTracked = true;
      deps.telemetry?.trackViewerOpened();
    }
    const [health, episodeIds, skills, policies, worldModels, metrics] =
      await Promise.all([
        deps.core.health(),
        deps.core.listEpisodes({ limit: 5_000 }),
        deps.core.listSkills({ limit: 500 }),
        // Core only exposes `listPolicies({ status? })`; the viewer wants
        // the grand total + per-status so we request the biggest page and
        // break it down here. 500 is plenty — fresh installs have dozens.
        deps.core.listPolicies({ limit: 500 }),
        deps.core.listWorldModels({ limit: 500 }),
        // `metrics.total` is the grand total of traces — cheaper than a
        // dedicated count RPC and already cached by the core.
        deps.core.metrics({ days: 1 }),
      ]);

    const skillStats = {
      total: skills.length,
      active: skills.filter((s) => s.status === "active").length,
      candidate: skills.filter((s) => s.status === "candidate").length,
      archived: skills.filter((s) => s.status === "archived").length,
    };
    const policyStats = {
      total: policies.length,
      active: policies.filter((p) => p.status === "active").length,
      candidate: policies.filter((p) => p.status === "candidate").length,
      archived: policies.filter((p) => p.status === "archived").length,
    };

    return {
      ok: health.ok,
      version: health.version,
      episodes: episodeIds.length,
      traces: metrics.total,
      skills: skillStats,
      policies: policyStats,
      worldModels: worldModels.length,
      llm: health.llm,
      embedder: health.embedder,
      skillEvolver: health.skillEvolver,
      // Keep uptime on the payload so existing callers don't break,
      // even though the Overview card no longer renders it.
      uptimeMs: health.uptimeMs,
    };
  });
}
