/**
 * Analytics view — ported from the legacy `memos-local-openclaw`
 * viewer so the same KPI grid, per-day charts, recent skill
 * evolutions table, and tool-latency panel all live here.
 *
 * Data shape contract (see `core/pipeline/memory-core.ts::metrics`):
 *
 *   {
 *     total, writesToday, sessions, embeddings,
 *     dailyWrites[], dailySkillEvolutions[],
 *     skillStats { total, active, candidate, archived, evolutionRate },
 *     policyStats { total, active, candidate, archived, avgGain, avgQuality },
 *     worldModelCount,
 *     decisionRepairCount,
 *     recentEvolutions[],
 *   }
 *
 * The legacy layout groups the metrics into five rows:
 *   1. Four "stat cards" headline row — skill evolution rate, rule
 *      coverage, active rules, average quality.
 *   2. Two side-by-side bar charts — daily memory writes + daily skill
 *      evolutions.
 *   3. Recent-evolutions table.
 *   4. Tool response latency — range selector + per-tool chart + agg
 *      table.
 *   5. (legacy) Heuristic effectiveness — omitted here because V7
 *      doesn't model "heuristics" as a distinct layer.
 */
import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api/client";
import { t } from "../stores/i18n";
import { Icon } from "../components/Icon";

type Range = 7 | 30 | 90;

interface MetricsPayload {
  total: number;
  writesToday: number;
  sessions: number;
  embeddings: number;
  dailyWrites: Array<{ date: string; count: number }>;
  dailySkillEvolutions: Array<{ date: string; count: number }>;
  skillStats: {
    total: number;
    active: number;
    candidate: number;
    archived: number;
    evolutionRate: number;
  };
  policyStats: {
    total: number;
    active: number;
    candidate: number;
    archived: number;
    avgGain: number;
    avgQuality: number;
  };
  worldModelCount: number;
  decisionRepairCount: number;
  recentEvolutions: Array<{
    ts: number;
    skillId: string;
    skillName: string;
    status: "candidate" | "active" | "archived";
    sourcePolicyIds: string[];
  }>;
}

export function AnalyticsView() {
  const [range, setRange] = useState<Range>(30);
  const [data, setData] = useState<MetricsPayload | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async (d: Range) => {
    setLoading(true);
    try {
      const r = await api.get<MetricsPayload>(`/api/v1/metrics?days=${d}`);
      setData(r);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load(range);
  }, [range]);

  const evoRate = data?.skillStats.evolutionRate ?? 0;
  const policyActivation =
    data && data.policyStats.total > 0
      ? data.policyStats.active / data.policyStats.total
      : 0;

  return (
    <>
      <div class="view-header">
        <div class="view-header__title">
          <h1>{t("analytics.title")}</h1>
          <p>{t("analytics.subtitle")}</p>
        </div>
        <div class="view-header__actions hstack">
          <span class="muted" style="font-size:var(--fs-xs)">
            {t("analytics.range.label")}
          </span>
          <div class="segmented">
            {([7, 30, 90] as Range[]).map((d) => (
              <button
                key={d}
                class="segmented__item"
                aria-pressed={range === d}
                onClick={() => setRange(d)}
              >
                {t(`analytics.range.${d}d` as "analytics.range.7d")}
              </button>
            ))}
          </div>
          <button class="btn btn--ghost btn--sm" onClick={() => void load(range)}>
            <Icon name="refresh-cw" size={14} />
            {t("common.refresh")}
          </button>
        </div>
      </div>

      {/* Row 1: V7 headline KPIs — ported 1:1 from the legacy viewer. */}
      <section class="metric-grid">
        <Metric
          label={t("analytics.kpi.evolutionRate")}
          hint={t("analytics.kpi.evolutionRate.hint")}
          value={loading ? undefined : `${Math.round(evoRate * 100)}%`}
        />
        <Metric
          label={t("analytics.kpi.policyCoverage")}
          hint={t("analytics.kpi.policyCoverage.hint")}
          value={loading ? undefined : `${Math.round(policyActivation * 100)}%`}
        />
        <Metric
          label={t("analytics.kpi.activePolicies")}
          hint={t("analytics.kpi.activePolicies.hint")}
          value={loading ? undefined : data?.policyStats.active ?? 0}
        />
        <Metric
          label={t("analytics.kpi.avgQuality")}
          hint={t("analytics.kpi.avgQuality.hint")}
          value={loading ? undefined : (data?.policyStats.avgQuality ?? 0).toFixed(2)}
        />
      </section>

      {/* Row 2: secondary KPI strip — counts for each V7 object. */}
      <section class="metric-grid" style="margin-top:var(--sp-4)">
        <Metric
          label={t("analytics.card.total")}
          value={loading ? undefined : data?.total}
        />
        <Metric
          label={t("analytics.card.sessions")}
          value={loading ? undefined : data?.sessions}
        />
        <Metric
          label={t("analytics.kpi.skillsTotal")}
          value={loading ? undefined : data?.skillStats.total}
          hint={
            data
              ? `${data.skillStats.active}·${data.skillStats.candidate}·${data.skillStats.archived}`
              : undefined
          }
        />
        <Metric
          label={t("analytics.kpi.worldModels")}
          value={loading ? undefined : data?.worldModelCount}
        />
      </section>

      {/* Row 3: two charts side by side. */}
      <section
        style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:var(--sp-4);margin-top:var(--sp-5)"
      >
        <div class="card">
          <h3 class="card__title">{t("analytics.chart.writes")}</h3>
          <BarChart data={data?.dailyWrites ?? []} loading={loading} />
        </div>
        <div class="card">
          <h3 class="card__title">{t("analytics.chart.skillEvolutions")}</h3>
          <BarChart
            data={data?.dailySkillEvolutions ?? []}
            loading={loading}
            emptyKey="analytics.chart.skillEvolutions.empty"
          />
        </div>
      </section>

      {/* Row 4: recent skill evolutions table. */}
      <section class="card" style="margin-top:var(--sp-5)">
        <h3 class="card__title">{t("analytics.evolutions.title")}</h3>
        <p class="card__subtitle" style="margin-bottom:var(--sp-3)">
          {t("analytics.evolutions.subtitle")}
        </p>
        {loading ? (
          <div class="skeleton" style="height:120px" />
        ) : data && data.recentEvolutions.length > 0 ? (
          <div style="overflow-x:auto">
            <table class="analytics-table">
              <thead>
                <tr>
                  <th style="text-align:left;width:140px">{t("analytics.evolutions.col.time")}</th>
                  <th style="text-align:left">{t("analytics.evolutions.col.skill")}</th>
                  <th style="text-align:left;width:120px">
                    {t("analytics.evolutions.col.status")}
                  </th>
                  <th style="text-align:left;width:140px">
                    {t("analytics.evolutions.col.policies")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.recentEvolutions.slice(0, 20).map((e) => (
                  <tr key={e.skillId}>
                    <td class="muted mono" style="font-size:var(--fs-xs)">
                      {new Date(e.ts).toLocaleString()}
                    </td>
                    <td class="mono">{e.skillName}</td>
                    <td>
                      <span class={`pill pill--${e.status}`}>
                        {t(`status.${e.status}` as never)}
                      </span>
                    </td>
                    <td class="muted" style="font-size:var(--fs-xs)">
                      {e.sourcePolicyIds.length > 0 ? `${e.sourcePolicyIds.length} policy` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div class="empty" style="padding:var(--sp-5) 0">
            <div class="empty__hint">{t("analytics.evolutions.empty")}</div>
          </div>
        )}
      </section>

      <ToolLatencyCard />
    </>
  );
}

// ─── Tool latency card (耗时统计) ─────────────────────────────────────────

type ToolRange = 60 | 360 | 1440 | 4_320 | 10_080 | 43_200;

interface ToolStat {
  name: string;
  calls: number;
  errors: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  lastTs: number;
}

interface ToolMetricsResponse {
  tools: ToolStat[];
  unavailableTools?: ToolCallCount[];
  toolNames?: string[];
  series?: Array<Record<string, unknown>>;
}

interface ToolCallCount {
  name: string;
  calls: number;
  errors: number;
  lastTs: number;
}

const TOOL_COLORS = [
  "#7c8cf5", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6",
  "#06b6d4", "#ec4899", "#84cc16", "#f97316", "#6366f1",
];

function ToolLatencyCard() {
  const [minutes, setMinutes] = useState<ToolRange>(1_440);
  const [rows, setRows] = useState<ToolStat[]>([]);
  const [toolNames, setToolNames] = useState<string[]>([]);
  const [series, setSeries] = useState<Array<Record<string, unknown>>>([]);
  const [unavailableTools, setUnavailableTools] = useState<ToolCallCount[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api
      .get<ToolMetricsResponse>(`/api/v1/metrics/tools?minutes=${minutes}&series=true`)
      .then((r) => {
        const nextRows = r.tools ?? [];
        const nextSeries = r.series ?? [];
        const names = r.toolNames ?? nextRows.map((tool) => tool.name);
        const namesWithLatency = names.filter((name) => {
          const row = nextRows.find((tool) => tool.name === name);
          return (
            nextSeries.some((point) => getSeriesValue(point, name) > 0) ||
            Boolean(row && (row.avgMs > 0 || row.p50Ms > 0 || row.p95Ms > 0))
          );
        });
        setRows(
          nextRows.filter((row) => namesWithLatency.includes(row.name)),
        );
        setToolNames(namesWithLatency);
        setSeries(nextSeries);
        setUnavailableTools(r.unavailableTools ?? []);
      })
      .catch(() => { setRows([]); setToolNames([]); setSeries([]); setUnavailableTools([]); })
      .finally(() => setLoading(false));
  }, [minutes]);

  const maxAvg = useMemo(() => Math.max(1, ...rows.map((r) => r.avgMs)), [rows]);

  return (
    <section class="card" style="margin-top:var(--sp-5)">
      <div class="card__header">
        <div>
          <h3 class="card__title">{t("analytics.tools.title")}</h3>
          <p class="card__subtitle">{t("analytics.tools.subtitle")}</p>
        </div>
        <div class="hstack" style="flex-wrap:wrap">
          <div class="segmented">
            {([60, 360, 1_440, 4_320, 10_080, 43_200] as ToolRange[]).map((m) => (
              <button
                key={m}
                class="segmented__item"
                aria-pressed={minutes === m}
                onClick={() => setMinutes(m)}
              >
                {toolRangeLabel(m)}
              </button>
            ))}
          </div>
        </div>
      </div>
      {loading ? (
        <div class="skeleton" style="height:280px" />
      ) : rows.length === 0 && unavailableTools.length === 0 ? (
        <div class="empty" style="padding:var(--sp-5) 0">
          <div class="empty__hint">{t("analytics.tools.empty")}</div>
        </div>
      ) : (
        <>
          {rows.length > 0 && series.length >= 2 ? (
            <ToolLineChart series={series} toolNames={toolNames} />
          ) : rows.length > 0 ? (
            <div
              class="muted"
              style="font-size:var(--fs-xs);padding:var(--sp-3) 0;text-align:center"
            >
              {t("analytics.tools.chart.insufficient")}
            </div>
          ) : null}
          {rows.length > 0 && (
            <div style="margin-top:var(--sp-4)">
              <ToolAggTable rows={rows} maxAvg={maxAvg} />
            </div>
          )}
          {unavailableTools.length > 0 && (
            <UnavailableToolList tools={unavailableTools} />
          )}
        </>
      )}
    </section>
  );
}

function UnavailableToolList({ tools }: { tools: ToolCallCount[] }) {
  return (
    <div
      class="card card--flat"
      style="margin-top:var(--sp-4);padding:var(--sp-3);background:var(--bg-canvas)"
    >
      <div class="hstack" style="justify-content:space-between;gap:var(--sp-3);margin-bottom:var(--sp-2)">
        <div>
          <div style="font-weight:var(--fw-semi);font-size:var(--fs-sm)">
            {t("analytics.tools.unavailable.title")}
          </div>
          <div class="muted" style="font-size:var(--fs-xs)">
            {t("analytics.tools.unavailable.subtitle")}
          </div>
        </div>
      </div>
      <div style="display:flex;gap:var(--sp-2);flex-wrap:wrap">
        {tools.slice(0, 12).map((tool) => (
          <span
            key={tool.name}
            class="pill pill--info"
            title={`${tool.name}: ${tool.calls} calls`}
          >
            {tool.name} · {tool.calls}
          </span>
        ))}
      </div>
    </div>
  );
}

function getSeriesValue(point: Record<string, unknown>, toolName: string): number {
  const raw = point[toolName];
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(0, raw);
  if (typeof raw === "string") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  }
  return 0;
}

function formatMinuteLabel(raw: unknown, includeDate = false): string {
  const minute = String(raw ?? "");
  if (!minute) return "";
  const label = minute.replace("T", " ");
  return includeDate || label.length <= 11 ? label : label.slice(11);
}

function ToolLineChart({
  series,
  toolNames,
}: {
  series: Array<Record<string, unknown>>;
  toolNames: string[];
}) {
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    toolName: string;
    minute: string;
    value: number;
  } | null>(null);
  // Track which tools are currently visible. Empty set = all visible.
  // Clicking a legend entry toggles the filter: first click narrows to
  // a single tool, further clicks add/remove more tools.
  const [visible, setVisible] = useState<Set<string>>(new Set());
  const isVisible = (tn: string) => visible.size === 0 || visible.has(tn);
  const visibleTools = toolNames.filter(isVisible);
  const toggleTool = (tn: string) => {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.size === 0) {
        // First click: narrow to just this tool.
        next.add(tn);
      } else if (next.has(tn)) {
        next.delete(tn);
        // If nothing is selected, revert to "show all" (empty set).
        if (next.size === 0) return new Set();
      } else {
        next.add(tn);
      }
      return next;
    });
  };

  // Widened viewBox. Left padding increased from 48 to 72 so y-axis
  // labels like "10000ms" render fully inside the viewBox instead of
  // being clipped by the container's `overflow:hidden`.
  const W = 1200;
  const H = 280;
  const pad = { t: 16, r: 18, b: 46, l: 78 };
  const cw = W - pad.l - pad.r;
  const ch = H - pad.t - pad.b;

  // Only compute max over the currently visible tools so the Y axis
  // zooms in when the user filters down.
  let maxVal = 0;
  for (const s of series) {
    for (const tn of visibleTools) {
      const v = getSeriesValue(s, tn);
      if (v > maxVal) maxVal = v;
    }
  }
  if (maxVal === 0) maxVal = 100;
  maxVal = Math.ceil(maxVal * 1.15);

  const gridLines = 5;
  const step = cw / Math.max(1, series.length - 1);
  const labelEvery = Math.max(1, Math.floor(series.length / 8));

  const toY = (v: number) => pad.t + ch - (v / maxVal) * ch;
  const toX = (i: number) => pad.l + i * step;
  const tooltipX = hover ? Math.min(W - 214, Math.max(pad.l + 8, hover.x + 10)) : 0;
  const tooltipY = hover ? Math.max(pad.t + 8, hover.y - 48) : 0;

  return (
    <div style="width:100%;border-radius:12px;position:relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        style="width:100%;height:auto;display:block"
        onMouseLeave={() => setHover(null)}
      >
        {Array.from({ length: gridLines + 1 }).map((_, i) => {
          const y = toY((maxVal / gridLines) * i);
          const val = Math.round((maxVal / gridLines) * i);
          return (
            <g key={`g-${i}`}>
              <line x1={pad.l} y1={y} x2={W - pad.r} y2={y} stroke="var(--border)" stroke-width="0.5" />
              <text x={pad.l - 8} y={y + 3} text-anchor="end" fill="var(--fg-dim)" font-size="11">{val}ms</text>
            </g>
          );
        })}
        <line x1={pad.l} y1={pad.t} x2={pad.l} y2={pad.t + ch} stroke="var(--fg-dim)" stroke-width="0.8" />
        <line x1={pad.l} y1={pad.t + ch} x2={W - pad.r} y2={pad.t + ch} stroke="var(--fg-dim)" stroke-width="0.8" />
        <text
          x={16}
          y={pad.t + ch / 2}
          transform={`rotate(-90 16 ${pad.t + ch / 2})`}
          text-anchor="middle"
          fill="var(--fg-dim)"
          font-size="12"
        >
          {t("analytics.axis.latencyMs")}
        </text>
        <text x={pad.l + cw / 2} y={H - 6} text-anchor="middle" fill="var(--fg-dim)" font-size="12">
          {t("analytics.axis.time")}
        </text>
        {series.map((s, i) => {
          if (i % labelEvery !== 0 && i !== series.length - 1) return null;
          const time = formatMinuteLabel(s.minute);
          return (
            <text key={`xl-${i}`} x={toX(i)} y={pad.t + ch + 16} text-anchor="middle" fill="var(--fg-dim)" font-size="11">
              {time}
            </text>
          );
        })}
        {toolNames.map((tn, ti) => {
          if (!isVisible(tn)) return null;
          const color = TOOL_COLORS[ti % TOOL_COLORS.length];
          const pts = series.map((s, i) => ({
            x: toX(i),
            y: toY(getSeriesValue(s, tn)),
            value: getSeriesValue(s, tn),
          }));
          if (pts.length === 0) return null;
          let d = `M${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
          for (let i = 1; i < pts.length; i++) {
            d += ` L${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)}`;
          }
          const areaD = d + ` L${pts[pts.length - 1].x.toFixed(1)} ${pad.t + ch} L${pts[0].x.toFixed(1)} ${pad.t + ch} Z`;
          return (
            <g key={`line-${tn}`}>
              <path d={areaD} fill={color} opacity="0.08" />
              <path d={d} fill="none" stroke={color} stroke-width="1.5" />
              {pts.map((p, i) => (
                <g key={`c-${i}`}>
                  <circle cx={p.x} cy={p.y} r="2.4" fill={color} />
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r="9"
                    fill="transparent"
                    onMouseEnter={() =>
                      setHover({
                        x: p.x,
                        y: p.y,
                        toolName: tn,
                        minute: formatMinuteLabel(series[i].minute, true),
                        value: p.value,
                      })
                    }
                    onMouseMove={() =>
                      setHover({
                        x: p.x,
                        y: p.y,
                        toolName: tn,
                        minute: formatMinuteLabel(series[i].minute, true),
                        value: p.value,
                      })
                    }
                  />
                </g>
              ))}
            </g>
          );
        })}
        {hover && (
          <g pointer-events="none">
            <line x1={hover.x} y1={pad.t} x2={hover.x} y2={pad.t + ch} stroke="var(--fg-dim)" stroke-width="0.8" stroke-dasharray="4 4" opacity="0.45" />
            <rect x={tooltipX} y={tooltipY} width="204" height="42" rx="8" fill="var(--bg-elev-1)" stroke="var(--border)" />
            <text x={tooltipX + 10} y={tooltipY + 16} fill="var(--fg-dim)" font-size="11">
              {hover.minute}
            </text>
            <text x={tooltipX + 10} y={tooltipY + 32} fill="var(--fg)" font-size="12" font-weight="600">
              {hover.toolName}: {hover.value}ms
            </text>
          </g>
        )}
      </svg>
      <div style="display:flex;gap:var(--sp-2);flex-wrap:wrap;margin-top:var(--sp-2);padding:0 4px">
        {toolNames.map((tn, ti) => {
          const color = TOOL_COLORS[ti % TOOL_COLORS.length];
          const active = isVisible(tn);
          return (
            <button
              key={tn}
              type="button"
              onClick={() => toggleTool(tn)}
              title={visible.size === 0
                ? `Click to show only ${tn}`
                : active
                ? `Click to hide ${tn}`
                : `Click to show ${tn}`}
              style={`
                display:flex;align-items:center;gap:6px;
                font-size:var(--fs-xs);
                padding:3px 8px;border-radius:var(--radius-sm);
                border:1px solid ${active ? "var(--border)" : "transparent"};
                background:${active ? "var(--bg-elev-1)" : "transparent"};
                color:${active ? "var(--fg)" : "var(--fg-dim)"};
                cursor:pointer;opacity:${active ? 1 : 0.55};
                transition:opacity var(--dur-xs),background var(--dur-xs);
              `}
            >
              <span
                aria-hidden="true"
                style={`width:10px;height:10px;border-radius:50%;background:${color};opacity:${active ? 1 : 0.4}`}
              />
              {tn}
            </button>
          );
        })}
        {visible.size > 0 && (
          <button
            type="button"
            onClick={() => setVisible(new Set())}
            style="font-size:var(--fs-xs);padding:3px 8px;border-radius:var(--radius-sm);border:1px solid var(--border);background:transparent;color:var(--fg-dim);cursor:pointer"
          >
            {t("analytics.tools.legend.showAll")}
          </button>
        )}
      </div>
    </div>
  );
}

function ToolAggTable({ rows, maxAvg }: { rows: ToolStat[]; maxAvg: number }) {
  return (
    <div
      style="display:grid;grid-template-columns:minmax(120px,1.2fr) 60px 70px 60px 70px 1fr;gap:var(--sp-2) var(--sp-4);font-size:var(--fs-xs)"
    >
      <div class="muted" style="font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.03em">tool</div>
      <div class="muted" style="font-size:var(--fs-2xs);text-align:right">calls</div>
      <div class="muted" style="font-size:var(--fs-2xs);text-align:right">avg ms</div>
      <div class="muted" style="font-size:var(--fs-2xs);text-align:right">p50</div>
      <div class="muted" style="font-size:var(--fs-2xs);text-align:right">p95</div>
      <div class="muted" style="font-size:var(--fs-2xs)">distribution</div>
      {rows.map((r) => {
        const pct = (r.avgMs / maxAvg) * 100;
        const errRate = r.calls > 0 ? ((r.errors / r.calls) * 100).toFixed(1) : "0";
        return (
          <>
            <div key={`${r.name}-n`} class="mono truncate">
              {r.name}
              {r.errors > 0 && (
                <span class="pill pill--failed" style="margin-left:6px">
                  {r.errors} err ({errRate}%)
                </span>
              )}
            </div>
            <div key={`${r.name}-c`} class="mono" style="text-align:right">{r.calls}</div>
            <div key={`${r.name}-a`} class="mono" style={`text-align:right;color:${latencyColor(r.avgMs)}`}>{r.avgMs}</div>
            <div key={`${r.name}-50`} class="mono" style="text-align:right">{r.p50Ms}</div>
            <div key={`${r.name}-95`} class="mono" style={`text-align:right;font-weight:600;color:${latencyColor(r.p95Ms)}`}>{r.p95Ms}</div>
            <div
              key={`${r.name}-b`}
              style={`
                height:12px;border-radius:6px;
                background:linear-gradient(90deg, ${latencyColor(r.avgMs)} ${pct}%, var(--border) ${pct}%);
                align-self:center
              `}
            />
          </>
        );
      })}
    </div>
  );
}

function toolRangeLabel(m: ToolRange): string {
  switch (m) {
    case 60:
      return t("analytics.tools.range.1h");
    case 360:
      return t("analytics.tools.range.6h");
    case 1_440:
      return t("analytics.tools.range.24h");
    case 4_320:
      return t("analytics.tools.range.3d");
    case 10_080:
      return t("analytics.tools.range.7d");
    case 43_200:
      return t("analytics.tools.range.30d");
  }
}

function latencyColor(ms: number): string {
  if (ms < 200) return "var(--green)";
  if (ms < 1000) return "var(--amber)";
  return "var(--red)";
}

// ─── Generic components ─────────────────────────────────────────────────

function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: number | string | undefined;
  hint?: string;
}) {
  return (
    <div class="metric">
      <div class="metric__label">{label}</div>
      <div class="metric__value">
        {value === undefined ? (
          <span
            class="skeleton"
            style="display:inline-block;width:80px;height:28px"
          />
        ) : typeof value === "number" ? (
          value.toLocaleString()
        ) : (
          value
        )}
      </div>
      {hint && <div class="metric__delta">{hint}</div>}
    </div>
  );
}

function BarChart({
  data,
  loading,
  emptyKey,
}: {
  data: Array<{ date: string; count: number }>;
  loading: boolean;
  emptyKey?: string;
}) {
  const max = useMemo(() => Math.max(1, ...data.map((d) => d.count)), [data]);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  if (loading) return <div class="skeleton" style="height:200px" />;
  if (data.length === 0 || data.every((d) => d.count === 0)) {
    return (
      <div class="empty" style="padding:var(--sp-5) 0">
        <div class="empty__hint">
          {t((emptyKey ?? "common.empty") as "common.empty")}
        </div>
      </div>
    );
  }

  const hovered = hoverIdx != null ? data[hoverIdx] : null;
  const W = 640;
  const H = 220;
  const pad = { t: 16, r: 16, b: 42, l: 48 };
  const cw = W - pad.l - pad.r;
  const ch = H - pad.t - pad.b;
  const gridLines = 4;
  const barGap = 3;
  const barSlot = cw / Math.max(1, data.length);
  const barWidth = Math.max(3, barSlot - barGap);
  const labelEvery = Math.max(1, Math.floor(data.length / 6));
  const toY = (value: number) => pad.t + ch - (value / max) * ch;
  const tooltipX = hoverIdx == null
    ? 0
    : Math.min(
        W - 156,
        Math.max(pad.l + 4, pad.l + hoverIdx * barSlot + barSlot / 2 + 8),
      );
  const tooltipY = hovered ? Math.max(pad.t + 4, toY(hovered.count) - 46) : 0;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style="width:100%;height:220px;display:block"
      onMouseLeave={() => setHoverIdx(null)}
    >
      {Array.from({ length: gridLines + 1 }).map((_, i) => {
        const value = Math.round((max / gridLines) * i);
        const y = toY(value);
        return (
          <g key={`bar-grid-${i}`}>
            <line x1={pad.l} y1={y} x2={W - pad.r} y2={y} stroke="var(--border)" stroke-width="0.6" />
            <text x={pad.l - 8} y={y + 4} text-anchor="end" fill="var(--fg-dim)" font-size="11">
              {value}
            </text>
          </g>
        );
      })}
      <line x1={pad.l} y1={pad.t} x2={pad.l} y2={pad.t + ch} stroke="var(--fg-dim)" stroke-width="0.8" />
      <line x1={pad.l} y1={pad.t + ch} x2={W - pad.r} y2={pad.t + ch} stroke="var(--fg-dim)" stroke-width="0.8" />
      <text
        x={14}
        y={pad.t + ch / 2}
        transform={`rotate(-90 14 ${pad.t + ch / 2})`}
        text-anchor="middle"
        fill="var(--fg-dim)"
        font-size="12"
      >
        {t("analytics.axis.count")}
      </text>
      <text x={pad.l + cw / 2} y={H - 6} text-anchor="middle" fill="var(--fg-dim)" font-size="12">
        {t("analytics.axis.date")}
      </text>
      {data.map((d, i) => {
        if (i % labelEvery !== 0 && i !== data.length - 1) return null;
        return (
          <text
            key={`bar-x-${d.date}`}
            x={pad.l + i * barSlot + barSlot / 2}
            y={pad.t + ch + 16}
            text-anchor="middle"
            fill="var(--fg-dim)"
            font-size="10"
          >
            {d.date.slice(5)}
          </text>
        );
      })}
      {data.map((d, i) => {
        const x = pad.l + i * barSlot + (barSlot - barWidth) / 2;
        const y = toY(d.count);
        const h = pad.t + ch - y;
        const isHover = hoverIdx === i;
        return (
          <rect
            key={d.date}
            x={x}
            y={y}
            width={barWidth}
            height={Math.max(2, h)}
            rx="3"
            fill="var(--accent)"
            opacity={hoverIdx !== null && !isHover ? "0.55" : "1"}
            onMouseEnter={() => setHoverIdx(i)}
            onMouseMove={() => setHoverIdx(i)}
          />
        );
      })}
      {hovered && hoverIdx != null && (
        <g pointer-events="none">
          <line
            x1={pad.l + hoverIdx * barSlot + barSlot / 2}
            y1={pad.t}
            x2={pad.l + hoverIdx * barSlot + barSlot / 2}
            y2={pad.t + ch}
            stroke="var(--fg-dim)"
            stroke-width="0.8"
            stroke-dasharray="4 4"
            opacity="0.45"
          />
          <rect x={tooltipX} y={tooltipY} width="148" height="40" rx="8" fill="var(--bg-elev-1)" stroke="var(--border)" />
          <text x={tooltipX + 10} y={tooltipY + 16} fill="var(--fg-dim)" font-size="11">
            {hovered.date}
          </text>
          <text x={tooltipX + 10} y={tooltipY + 32} fill="var(--fg)" font-size="12" font-weight="600">
            {t("analytics.axis.count")}: {hovered.count}
          </text>
        </g>
      )}
    </svg>
  );
}
