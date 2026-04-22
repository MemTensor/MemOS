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
  toolNames?: string[];
  series?: Array<Record<string, unknown>>;
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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api
      .get<ToolMetricsResponse>(`/api/v1/metrics/tools?minutes=${minutes}&series=true`)
      .then((r) => {
        setRows(r.tools ?? []);
        setToolNames(r.toolNames ?? (r.tools ?? []).map((t) => t.name));
        setSeries(r.series ?? []);
      })
      .catch(() => { setRows([]); setToolNames([]); setSeries([]); })
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
      ) : rows.length === 0 ? (
        <div class="empty" style="padding:var(--sp-5) 0">
          <div class="empty__hint">{t("analytics.tools.empty")}</div>
        </div>
      ) : (
        <>
          {series.length >= 2 ? (
            <ToolLineChart series={series} toolNames={toolNames} />
          ) : (
            <div
              class="muted"
              style="font-size:var(--fs-xs);padding:var(--sp-3) 0;text-align:center"
            >
              {t("analytics.tools.chart.insufficient")}
            </div>
          )}
          <div style="margin-top:var(--sp-4)">
            <ToolAggTable rows={rows} maxAvg={maxAvg} />
          </div>
        </>
      )}
    </section>
  );
}

function ToolLineChart({
  series,
  toolNames,
}: {
  series: Array<Record<string, unknown>>;
  toolNames: string[];
}) {
  // Track which tools are currently visible. Empty set = all visible.
  // Clicking a legend entry toggles the filter: first click narrows to
  // a single tool, further clicks add/remove more tools.
  const [visible, setVisible] = useState<Set<string>>(new Set());
  const isVisible = (tn: string) => visible.size === 0 || visible.has(tn);
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
  const pad = { t: 16, r: 16, b: 32, l: 72 };
  const cw = W - pad.l - pad.r;
  const ch = H - pad.t - pad.b;

  // Only compute max over the currently visible tools so the Y axis
  // zooms in when the user filters down.
  let maxVal = 0;
  for (const s of series) {
    for (const tn of toolNames) {
      if (!isVisible(tn)) continue;
      const v = Number(s[tn]) || 0;
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

  return (
    <div style="width:100%;border-radius:12px;position:relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        style="width:100%;height:auto;display:block"
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
        {series.map((s, i) => {
          if (i % labelEvery !== 0 && i !== series.length - 1) return null;
          const minute = String(s.minute ?? "");
          const time = minute.length > 11 ? minute.slice(11) : minute;
          return (
            <text key={`xl-${i}`} x={toX(i)} y={H - 6} text-anchor="middle" fill="var(--fg-dim)" font-size="11">
              {time}
            </text>
          );
        })}
        {toolNames.map((tn, ti) => {
          if (!isVisible(tn)) return null;
          const color = TOOL_COLORS[ti % TOOL_COLORS.length];
          const pts = series.map((s, i) => ({
            x: toX(i),
            y: toY(Number(s[tn]) || 0),
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
                <circle key={`c-${i}`} cx={p.x} cy={p.y} r="2" fill={color}>
                  <title>{`${String(series[i].minute)}: ${tn} ${Number(series[i][tn]) || 0}ms`}</title>
                </circle>
              ))}
            </g>
          );
        })}
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

  return (
    <div style="display:flex;flex-direction:column;gap:0;position:relative">
      {/* Hover tooltip — the only place we show the date + count. */}
      {hovered && (
        <div
          style={`
            position:absolute;top:-4px;left:50%;transform:translateX(-50%);
            background:var(--bg-elev-1);border:1px solid var(--border);
            border-radius:var(--radius-sm);padding:4px 8px;
            font-size:var(--fs-xs);color:var(--fg);white-space:nowrap;
            box-shadow:var(--shadow-sm);z-index:2;pointer-events:none
          `}
        >
          <span class="mono" style="color:var(--fg-dim);margin-right:6px">
            {hovered.date}
          </span>
          <span style="font-weight:600">{hovered.count}</span>
        </div>
      )}

      <div
        style="display:grid;grid-auto-flow:column;gap:2px;align-items:end;height:180px;padding-top:12px"
        onMouseLeave={() => setHoverIdx(null)}
      >
        {data.map((d, i) => {
          const pct = (d.count / max) * 100;
          const isHover = hoverIdx === i;
          return (
            <div
              key={d.date}
              onMouseEnter={() => setHoverIdx(i)}
              style={`
                height:${Math.max(2, pct)}%;
                background:linear-gradient(180deg, ${isHover ? "var(--accent-strong, var(--accent))" : "var(--accent)"}, color-mix(in srgb, var(--accent) 40%, transparent));
                border-radius:var(--radius-sm);
                min-width:6px;
                transition:height var(--dur-md) var(--ease-out), background var(--dur-xs);
                cursor:pointer;
                opacity:${hoverIdx !== null && !isHover ? "0.6" : "1"};
              `}
            />
          );
        })}
      </div>
    </div>
  );
}
