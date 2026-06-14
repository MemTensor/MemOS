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
  routes.set("GET /api/v1/overview", async () => {
    // `viewer_opened` is now emitted by the SPA itself via
    // `POST /api/v1/telemetry/viewer-opened` (see
    // `viewer/src/components/App.tsx`). The previous in-memory
    // `viewerTracked` flag here was per-process and triggered on any
    // GET — including background polling and CLI tooling — so the
    // metric drifted on every bridge restart and over-counted
    // headless callers. Routing the ping through the viewer's mount
    // hook keeps the semantics honest (a browser actually opened
    // the page) and is naturally deduped by browser tab lifetime.
    const [
      health,
      episodeCount,
      skillActive, skillCandidate, skillArchived,
      policyActive, policyCandidate, policyArchived,
      worldModelCount,
      metrics,
    ] = await Promise.all([
      deps.core.health(),
      deps.core.countEpisodes(),
      deps.core.countSkills({ status: "active" }),
      deps.core.countSkills({ status: "candidate" }),
      deps.core.countSkills({ status: "archived" }),
      deps.core.countPolicies({ status: "active" }),
      deps.core.countPolicies({ status: "candidate" }),
      deps.core.countPolicies({ status: "archived" }),
      deps.core.countWorldModels(),
      // `metrics.total` is the grand total of traces — cheaper than a
      // dedicated count RPC and already cached by the core.
      deps.core.metrics({ days: 1 }),
    ]);

    const skillStats = {
      total: skillActive + skillCandidate + skillArchived,
      active: skillActive,
      candidate: skillCandidate,
      archived: skillArchived,
    };
    const policyStats = {
      total: policyActive + policyCandidate + policyArchived,
      active: policyActive,
      candidate: policyCandidate,
      archived: policyArchived,
    };

    return {
      ok: health.ok,
      version: health.version,
      episodes: episodeCount,
      traces: metrics.total,
      skills: skillStats,
      policies: policyStats,
      worldModels: worldModelCount,
      llm: health.llm,
      embedder: health.embedder,
      skillEvolver: health.skillEvolver,
      // Keep uptime on the payload so existing callers don't break,
      // even though the Overview card no longer renders it.
      uptimeMs: health.uptimeMs,
    };
  });
}
