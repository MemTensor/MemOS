/**
 * Analytics endpoints.
 *
 *   GET /api/v1/metrics?days=N
 *     High-level KPIs (totals, daily histogram). Thin adapter over
 *     `core.metrics()`.
 *
 *   GET /api/v1/metrics/tools?minutes=N  (alias: ?days=N)
 *     Per-tool call latency + success-rate table. Data source: the
 *     `api_logs` table, which records every plugin internal operation
 *     (memory_search / memory_add / policy_generate / skill_generate /
 *     world_model_generate / task_done / task_failed) with its
 *     `durationMs` and `success` flag. We also fold in any agent-side
 *     tool invocations recorded on `traces.tool_calls_json` so the
 *     panel covers both plugin subsystems and external tools.
 *
 *     Output shape mirrors the legacy `memos-local-openclaw` plugin so
 *     the frontend `ToolLatencyCard` can consume it unchanged.
 */
import type { ServerDeps } from "../types.js";
import type { Routes } from "./registry.js";

interface ToolStat {
  name: string;
  calls: number;
  errors: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  lastTs: number;
}

export function registerMetricsRoutes(routes: Routes, deps: ServerDeps): void {
  routes.set("GET /api/v1/metrics", async (ctx) => {
    const raw = ctx.url.searchParams.get("days");
    const days = raw ? Number(raw) : undefined;
    return await deps.core.metrics({
      days: Number.isFinite(days) ? days : undefined,
    });
  });

  routes.set("GET /api/v1/metrics/tools", async (ctx) => {
    const params = ctx.url.searchParams;
    // Prefer `minutes` (legacy viewer used that unit); fall back to
    // `days` for back-compat. Clamp 1 minute — 30 days.
    const rawMinutes = Number(params.get("minutes"));
    const rawDays = Number(params.get("days"));
    const windowMinutes = Number.isFinite(rawMinutes) && rawMinutes > 0
      ? Math.min(30 * 24 * 60, rawMinutes)
      : Number.isFinite(rawDays) && rawDays > 0
      ? Math.min(30 * 24 * 60, rawDays * 24 * 60)
      : 24 * 60; // default 24h
    const sinceMs = Date.now() - windowMinutes * 60 * 1000;

    const wantSeries = params.get("series") === "true";
    const buckets = new Map<string, number[]>();
    const errors = new Map<string, number>();
    const lastTs = new Map<string, number>();
    // Per-minute time series keyed by "YYYY-MM-DDTHH:MM" → { [tool]: ms[] }
    const minuteBuckets = new Map<string, Map<string, number[]>>();

    const bump = (name: string, durMs: number, ok: boolean, ts: number): void => {
      if (!buckets.has(name)) buckets.set(name, []);
      buckets.get(name)!.push(Math.max(0, durMs));
      if (!ok) errors.set(name, (errors.get(name) ?? 0) + 1);
      lastTs.set(name, Math.max(lastTs.get(name) ?? 0, ts));
      if (wantSeries) {
        const d = new Date(ts);
        const minute = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
        if (!minuteBuckets.has(minute)) minuteBuckets.set(minute, new Map());
        const mb = minuteBuckets.get(minute)!;
        if (!mb.has(name)) mb.set(name, []);
        mb.get(name)!.push(Math.max(0, durMs));
      }
    };

    // 1. Plugin internal operations — from api_logs. We only surface
    // entries that represent **actual tool/handler calls the agent
    // made or the user cares about latency for**: `memory_search`
    // and `memory_add`. Purely internal pipeline lifecycle events
    // (`task_done`, `task_failed`, `skill_generate`, `skill_evolve`,
    // `policy_generate`, `policy_evolve`, `world_model_generate`,
    // `world_model_evolve`) are skipped — they clutter the chart
    // with names like "task_failed" that users don't recognise as
    // tools, and their timings reflect background work rather than
    // response latency.
    const PUBLIC_API_LOG_TOOLS = new Set(["memory_search", "memory_add"]);
    const { logs } = await deps.core.listApiLogs({ limit: 5_000, offset: 0 });
    for (const lg of logs) {
      if (lg.calledAt < sinceMs) continue;
      if (!PUBLIC_API_LOG_TOOLS.has(lg.toolName)) continue;
      bump(lg.toolName, lg.durationMs, lg.success, lg.calledAt);
    }

    // 2. External tool calls embedded in traces — covers bash / grep /
    // web / whatever the agent ran. Fold them in with the api_logs
    // rows so the panel answers "is anything slow?" regardless of
    // whether the slowness was internal or user-visible.
    const traces = await deps.core.listTraces({ limit: 2_000, offset: 0 });
    for (const tr of traces) {
      if (tr.ts < sinceMs) continue;
      for (const tc of tr.toolCalls ?? []) {
        const name = tc.name ?? "unknown";
        const dur = Math.max(0, (tc.endedAt ?? tr.ts) - (tc.startedAt ?? tr.ts));
        bump(name, dur, !tc.errorCode, tc.endedAt ?? tr.ts);
      }
    }

    const tools: ToolStat[] = [];
    for (const [name, durs] of buckets) {
      durs.sort((a, b) => a - b);
      const n = durs.length;
      const avg = n > 0 ? durs.reduce((s, v) => s + v, 0) / n : 0;
      const p50 = n > 0 ? durs[Math.floor(n * 0.5)]! : 0;
      const p95 = n > 0 ? durs[Math.min(n - 1, Math.floor(n * 0.95))]! : 0;
      tools.push({
        name,
        calls: n,
        errors: errors.get(name) ?? 0,
        avgMs: Math.round(avg),
        p50Ms: Math.round(p50),
        p95Ms: Math.round(p95),
        lastTs: lastTs.get(name) ?? 0,
      });
    }
    tools.sort((a, b) => b.calls - a.calls);
    const toolNames = tools.map((t) => t.name);

    let series: Array<Record<string, unknown>> | undefined;
    if (wantSeries && minuteBuckets.size > 0) {
      const sorted = [...minuteBuckets.keys()].sort();
      series = sorted.map((minute) => {
        const mb = minuteBuckets.get(minute)!;
        const row: Record<string, unknown> = { minute };
        for (const name of toolNames) {
          const arr = mb.get(name);
          row[name] = arr && arr.length > 0
            ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length)
            : 0;
        }
        return row;
      });
    }

    return {
      tools,
      toolNames,
      series,
      windowMinutes,
      windowDays: Math.round(windowMinutes / 1440) || 1,
    };
  });
}
