/**
 * Logs view — structured trail of `memory_search` and `memory_add`
 * calls. Mirrors the legacy `memos-local-openclaw` v1 logs page so
 * each row shows the retrieved / filtered candidates (with scores
 * and origin tags) for search and the per-turn stored items for
 * ingest — not just raw log text.
 *
 * Backing data: `GET /api/v1/api-logs?tool=…&limit=&offset=`
 *   - Response row shape (ApiLogDTO): { id, toolName, inputJson,
 *     outputJson, durationMs, success, calledAt }
 *   - Both JSON blobs are stored verbatim and the client is the
 *     single source of truth for how to render them — per-tool
 *     templates live in this file, one per known tool name.
 *
 * If a new `toolName` appears in the stream, we gracefully fall back
 * to a generic pretty-printed JSON card so it's still visible.
 */
import { useEffect, useState } from "preact/hooks";
import { api } from "../api/client";
import { t } from "../stores/i18n";
import { Icon } from "../components/Icon";
import { Pager } from "../components/Pager";
import type { ApiLogDTO } from "../api/types";

type ToolFilter =
  | ""
  | "memory_search"
  | "memory_add"
  | "skill_generate"
  | "skill_evolve"
  | "policy_generate"
  | "policy_evolve"
  | "world_model_generate"
  | "world_model_evolve"
  | "task_done"
  | "task_failed"
  | "session_relation_classify"
  | "system_error"
  | "system_model_status";

/**
 * Frontend log-tag categories. Each tag maps to one or more backend
 * `toolName` values. We collapse each subsystem's generate/evolve
 * pair into a single tag since users care about "skill events"
 * rather than distinguishing "initial crystallization" from
 * "subsequent evolution" at a glance.
 */
type LogTag =
  | ""
  | "memory_add"
  | "memory_search"
  | "task"
  | "skill"
  | "policy"
  | "world"
  | "session"
  // Infrastructure-layer failures (embedding / summary LLM /
  // skillEvolver provider errors). The bootstrap layer drops a
  // `system_error` row into api_logs every time a model facade
  // throws, so users can correlate Overview red dots with concrete
  // upstream messages without tailing the server logs.
  | "system";

const LOG_TAGS: Array<{ v: LogTag; k: string }> = [
  { v: "", k: "common.all" },
  { v: "memory_add", k: "logs.tag.memoryAdd" },
  { v: "memory_search", k: "logs.tag.memorySearch" },
  { v: "task", k: "logs.tag.task" },
  { v: "skill", k: "logs.tag.skill" },
  { v: "policy", k: "logs.tag.policy" },
  { v: "world", k: "logs.tag.world" },
  { v: "session", k: "logs.tag.session" },
  { v: "system", k: "logs.tag.system" },
];

/**
 * Backend `toolName` values that each frontend tag selects. When the
 * array has exactly one entry, we send `?tool=` to the server for
 * efficient filtering; otherwise (generate + evolve, or task_done +
 * task_failed) we over-fetch and filter client-side.
 */
const ALLOWED_TOOLS: Record<LogTag, readonly ToolFilter[]> = {
  "": [],
  memory_add: ["memory_add"],
  memory_search: ["memory_search"],
  task: ["task_done", "task_failed"],
  skill: ["skill_generate", "skill_evolve"],
  policy: ["policy_generate", "policy_evolve"],
  world: ["world_model_generate", "world_model_evolve"],
  session: ["session_relation_classify"],
  system: ["system_error", "system_model_status"],
};

interface ApiLogsResponse {
  logs: ApiLogDTO[];
  total: number;
  limit: number;
  offset: number;
  nextOffset?: number;
}

const DEFAULT_PAGE_SIZE = 25;
const CHAIN_FETCH_LIMIT = 800;

type ViewMode = "chain" | "list";

export function LogsView() {
  const [viewMode, setViewMode] = useState<ViewMode>("chain");
  const [tag, setTag] = useState<LogTag>("");
  const [query, setQuery] = useState("");
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [logs, setLogs] = useState<ApiLogDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  // Chain cards collapse by default. The set holds the *expanded*
  // chain keys so the natural "everything closed" state needs no
  // initialisation when filters change.
  const [expandedChains, setExpandedChains] = useState<Set<string>>(new Set());

  // Chain mode always over-fetches a wide window so episode-level
  // grouping has enough material to work with. List mode keeps the
  // legacy single-tool SQL filter for cheap pagination.
  const currentAllowed = ALLOWED_TOOLS[tag];
  const clientFilterActive =
    viewMode === "chain" ||
    currentAllowed.length > 1 ||
    query.trim().length > 0 ||
    failuresOnly;

  const load = async (opts: {
    tag: LogTag;
    page: number;
    query: string;
    viewMode: ViewMode;
    failuresOnly: boolean;
  }) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      const allowed = ALLOWED_TOOLS[opts.tag];
      const needsClient =
        opts.viewMode === "chain" ||
        allowed.length > 1 ||
        opts.query.trim().length > 0 ||
        opts.failuresOnly;
      const limit =
        opts.viewMode === "chain"
          ? CHAIN_FETCH_LIMIT
          : needsClient
          ? 500
          : pageSize;
      qs.set("limit", String(limit));
      qs.set("offset", String(needsClient ? 0 : opts.page * pageSize));
      // Tool-side SQL filtering is a list-mode optimisation. Chain
      // mode intentionally fetches across tools so grouped events
      // form a complete pipeline trace.
      if (opts.viewMode === "list" && allowed.length === 1) {
        qs.set("tool", allowed[0]!);
      }
      const res = await api.get<ApiLogsResponse>(`/api/v1/api-logs?${qs.toString()}`);
      setLogs(res.logs);
      setTotal(needsClient ? res.logs.length : res.total);
      setPage(opts.page);
    } catch {
      setLogs([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load({ tag, page: 0, query, viewMode, failuresOnly });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tag, pageSize, viewMode, failuresOnly]);

  // Debounced client-side refresh when the search query changes.
  useEffect(() => {
    const h = setTimeout(() => {
      void load({ tag, page: 0, query, viewMode, failuresOnly });
    }, 200);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, pageSize]);

  const toggleExpand = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleChain = (key: string) => {
    setExpandedChains((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Client-side filter + paginate when needed. List view keeps tag
  // and search active per-row; chain view filters chains as a whole
  // (any matching event is enough to keep the chain visible).
  const needle = query.trim().toLowerCase();
  const filtered = clientFilterActive
    ? logs.filter((log) => {
        if (currentAllowed.length > 0 && !currentAllowed.includes(log.toolName as ToolFilter)) return false;
        if (failuresOnly && log.success) return false;
        if (!needle) return true;
        const hay = `${log.toolName} ${log.inputJson ?? ""} ${log.outputJson ?? ""}`.toLowerCase();
        return hay.includes(needle);
      })
    : logs;
  const pagedRows = clientFilterActive
    ? filtered.slice(page * pageSize, (page + 1) * pageSize)
    : filtered;
  const displayTotal = clientFilterActive ? filtered.length : total;

  // Chain view: regroup by episodeId (fallback sessionId). Filters
  // are applied as "match any event in the chain".
  const allChains = viewMode === "chain" ? aggregateChains(logs) : [];
  const filteredChains =
    viewMode === "chain"
      ? allChains.filter((chain) => {
          if (currentAllowed.length > 0) {
            const hit = chain.events.some((ev) =>
              currentAllowed.includes(ev.log.toolName as ToolFilter),
            );
            if (!hit) return false;
          }
          if (failuresOnly && chain.failureCount === 0) return false;
          if (!needle) return true;
          if (chain.episodeId?.toLowerCase().includes(needle)) return true;
          if (chain.sessionId?.toLowerCase().includes(needle)) return true;
          return chain.events.some((ev) => {
            const hay =
              `${ev.log.toolName} ${ev.log.inputJson ?? ""} ${ev.log.outputJson ?? ""}`.toLowerCase();
            return hay.includes(needle);
          });
        })
      : [];
  const chainEventCount = filteredChains.reduce(
    (acc, c) => acc + c.events.length,
    0,
  );

  return (
    <>
      <div class="view-header">
        <div class="view-header__title">
          <h1>{t("logs.title")}</h1>
          <p>{t("logs.subtitle")}</p>
        </div>
        <div class="view-header__actions hstack">
          <div class="toolbar__group" role="group" aria-label="view mode">
            <button
              class="chip"
              aria-pressed={viewMode === "chain"}
              onClick={() => setViewMode("chain")}
              title="按 episode 聚合的链路时间线"
            >
              链路视图
            </button>
            <button
              class="chip"
              aria-pressed={viewMode === "list"}
              onClick={() => setViewMode("list")}
              title="按调用时间倒序的扁平列表"
            >
              列表视图
            </button>
          </div>
          <button
            class="chip"
            aria-pressed={failuresOnly}
            onClick={() => setFailuresOnly((v) => !v)}
            title="只显示失败 / 含失败的链路"
          >
            仅看失败
          </button>
          <button
            class="btn btn--ghost btn--sm"
            onClick={() => void load({ tag, page, query, viewMode, failuresOnly })}
            disabled={loading}
          >
            <Icon name="refresh-cw" size={14} class={loading ? "spin" : ""} />
            {t("common.refresh")}
          </button>
        </div>
      </div>

      {/* Row 1: search box — same pattern as Memories / Tasks. */}
      <div class="toolbar">
        <label class="input-search">
          <Icon name="search" size={16} />
          <input
            class="input input--search"
            type="search"
            autoComplete="off"
            spellcheck={false}
            placeholder={t("logs.search.placeholder")}
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
        </label>
      </div>

      {/* Row 2: flat tag chips, same as other views. */}
      <div class="toolbar" style="margin-top:calc(-1 * var(--sp-2))">
        <div class="toolbar__group" role="group" aria-label={t("common.filter")}>
          {LOG_TAGS.map((c) => (
            <button
              key={c.v}
              class="chip"
              aria-pressed={tag === c.v}
              onClick={() => setTag(c.v)}
            >
              {t(c.k as never)}
            </button>
          ))}
        </div>
        <div class="toolbar__spacer" />
        {viewMode === "chain" ? (
          filteredChains.length > 0 && (
            <span class="muted" style="font-size:var(--fs-xs)">
              {filteredChains.length} 条链路 · {chainEventCount} 事件
            </span>
          )
        ) : (
          displayTotal > 0 && (
            <span class="muted" style="font-size:var(--fs-xs)">
              {t("logs.totalRows", { n: displayTotal })}
            </span>
          )
        )}
      </div>

      {loading && (
        viewMode === "chain"
          ? filteredChains.length === 0
          : pagedRows.length === 0
      ) && (
        <div class="list">
          {[0, 1, 2].map((i) => (
            <div key={i} class="skeleton" style="height:96px" />
          ))}
        </div>
      )}

      {!loading &&
        (viewMode === "chain"
          ? filteredChains.length === 0
          : pagedRows.length === 0) && (
          <div class="empty">
            <div class="empty__icon">
              <Icon name="scroll-text" size={22} />
            </div>
            <div class="empty__title">{t("logs.empty.title")}</div>
            <div class="empty__hint">{t("logs.empty.hint")}</div>
          </div>
        )}

      {viewMode === "chain" && filteredChains.length > 0 && (
        <>
          <div
            class="hstack"
            style="gap:var(--sp-2);justify-content:flex-end;font-size:var(--fs-xs)"
          >
            <button
              class="btn btn--ghost btn--sm"
              onClick={() =>
                setExpandedChains(new Set(filteredChains.map((c) => c.key)))
              }
              disabled={
                filteredChains.every((c) => expandedChains.has(c.key))
              }
            >
              全部展开
            </button>
            <button
              class="btn btn--ghost btn--sm"
              onClick={() => setExpandedChains(new Set())}
              disabled={expandedChains.size === 0}
            >
              全部折叠
            </button>
          </div>
          <div class="vstack" style="gap:var(--sp-3)">
            {filteredChains.map((chain) => (
              <ChainCard
                key={chain.key}
                chain={chain}
                expanded={expandedChains.has(chain.key)}
                onToggle={() => toggleChain(chain.key)}
                expandedRows={expanded}
                onToggleRow={toggleExpand}
              />
            ))}
          </div>
        </>
      )}

      {viewMode === "list" && pagedRows.length > 0 && (
        <div class="list">
          {pagedRows.map((lg) => (
            <LogCard
              key={lg.id}
              log={lg}
              expanded={expanded.has(lg.id)}
              onToggle={() => toggleExpand(lg.id)}
            />
          ))}
        </div>
      )}

      {viewMode === "list" && displayTotal > pageSize && (
        <Pager
          page={page}
          totalItems={displayTotal}
          pageSize={pageSize}
          loading={loading}
          onPageSizeChange={setPageSize}
          onPageChange={(nextPage) => {
            if (clientFilterActive) setPage(nextPage);
            else void load({ tag, page: nextPage, query, viewMode, failuresOnly });
          }}
        />
      )}
    </>
  );
}

// ─── One log row ─────────────────────────────────────────────────────────

function LogCard({
  log,
  expanded,
  onToggle,
}: {
  log: ApiLogDTO;
  expanded: boolean;
  onToggle: () => void;
}) {
  const input = parseJson(log.inputJson);
  const output = parseJson(log.outputJson);
  return (
    <div class={`log-card${expanded ? " log-card--expanded" : ""}`}>
      <header class="log-card__header" onClick={onToggle}>
        <span
          class={`log-card__status log-card__status--${log.success ? "ok" : "fail"}`}
          aria-hidden="true"
        />
        <span class={`pill pill--tool pill--tool-${sanitize(log.toolName)}`}>
          {log.toolName}
        </span>
        <span class="log-card__summary">{buildSummary(log, input, output)}</span>
        <span class="muted mono" style="font-size:var(--fs-xs)">
          {formatLogDuration(log)}
        </span>
        <span class="muted" style="font-size:var(--fs-xs)">
          {formatTs(log.calledAt)}
        </span>
        <Icon name={expanded ? "chevron-up" : "chevron-down"} size={14} />
      </header>

      {expanded && (
        <div class="log-card__body">
          <LogDetailBody log={log} input={input} output={output} />
        </div>
      )}
    </div>
  );
}

function LogDetailBody({
  log,
  input,
  output,
}: {
  log: ApiLogDTO;
  input: unknown;
  output: unknown;
}) {
  if (log.toolName === "memory_search") {
    return <MemorySearchDetail input={input} output={output} />;
  }
  if (log.toolName === "memory_add") {
    return <MemoryAddDetail input={input} output={output} />;
  }
  if (log.toolName === "system_error") {
    return <SystemErrorDetail output={output} />;
  }
  if (log.toolName === "system_model_status") {
    return <SystemModelStatusDetail output={output} />;
  }
  if (log.toolName === "session_relation_classify") {
    return <RelationClassifyDetail input={input} output={output} />;
  }
  if (
    log.toolName.startsWith("skill_") ||
    log.toolName.startsWith("policy_") ||
    log.toolName.startsWith("world_model_") ||
    log.toolName.startsWith("task_")
  ) {
    return <LifecycleDetail input={input} output={output} tool={log.toolName} />;
  }
  return <GenericDetail input={input} output={output} />;
}

// ─── memory_search template ─────────────────────────────────────────────

interface SearchInput {
  query?: string;
  agent?: string;
  sessionId?: string;
  episodeId?: string | null;
  type?: string;
}
interface SearchOutput {
  candidates?: SearchCandidate[];
  hubCandidates?: SearchCandidate[];
  filtered?: SearchCandidate[];
  droppedByLlm?: SearchCandidate[];
  stats?: RetrievalStatsPayload;
  error?: string;
}
interface RetrievalStatsPayload {
  raw?: number;
  ranked?: number;
  droppedByThreshold?: number;
  thresholdFloor?: number;
  topRelevance?: number;
  llmFilter?: {
    outcome?: string;
    kept?: number;
    dropped?: number;
    sufficient?: boolean | null;
  };
  channelHits?: Record<string, number>;
  queryTokens?: number;
  queryTags?: string[];
  embedding?: {
    attempted?: boolean;
    ok?: boolean;
    degraded?: boolean;
    errorCode?: string;
    errorMessage?: string;
  };
}
interface SearchCandidate {
  tier?: number;
  refKind?: string;
  refId?: string;
  score?: number;
  snippet?: string;
  role?: string;
  summary?: string;
  content?: string;
  origin?: string;
  owner?: string;
}

function MemorySearchDetail({
  input,
  output,
}: {
  input: unknown;
  output: unknown;
}) {
  const inp = (input ?? {}) as SearchInput;
  const out = (output ?? {}) as SearchOutput;
  const candidates = out.candidates ?? [];
  const hub = out.hubCandidates ?? [];
  const filtered = out.filtered ?? [];
  const dropped = out.droppedByLlm ?? [];
  return (
    <div class="vstack" style="gap:var(--sp-4)">
      {inp.query && (
        <section class="card card--flat">
          <div class="muted" style="font-size:var(--fs-xs);margin-bottom:4px">
            {t("logs.search.query")}
          </div>
          <div style="font-size:var(--fs-sm);line-height:1.6">{inp.query}</div>
        </section>
      )}
      {out.error ? (
        <section
          class="card card--flat"
          style="border-color:var(--danger);background:var(--danger-soft)"
        >
          <div class="muted" style="font-size:var(--fs-xs);margin-bottom:4px;color:var(--danger)">
            error
          </div>
          <div class="mono" style="font-size:var(--fs-sm)">{out.error}</div>
        </section>
      ) : (
        <>
          {out.stats && <RetrievalFunnel stats={out.stats} />}
          <CandidateSection
            title={t("logs.search.initial")}
            count={candidates.length}
            rows={candidates}
            emptyLabel={t("logs.search.noCandidates")}
          />
          {hub.length > 0 && (
            <CandidateSection
              title={t("logs.search.hub")}
              count={hub.length}
              rows={hub}
            />
          )}
          <CandidateSection
            title={t("logs.search.filtered")}
            count={filtered.length}
            rows={filtered}
            emptyLabel={
              candidates.length > 0
                ? t("logs.search.noneRelevant")
                : t("logs.search.noCandidates")
            }
            variant="filtered"
          />
          {dropped.length > 0 && (
            <CandidateSection
              title={t("logs.search.droppedByLlm")}
              count={dropped.length}
              rows={dropped}
              variant="dropped"
            />
          )}
        </>
      )}
    </div>
  );
}

function RetrievalFunnel({ stats }: { stats: RetrievalStatsPayload }) {
  const raw = stats.raw ?? 0;
  const ranked = stats.ranked ?? 0;
  const dropped = stats.droppedByThreshold ?? 0;
  const lf = stats.llmFilter ?? {};
  const kept = lf.kept;
  const outcome = lf.outcome ?? "unknown";
  const fmtNum = (n: number | undefined, digits = 3) =>
    typeof n === "number" && Number.isFinite(n) ? n.toFixed(digits) : "—";
  const channelEntries = Object.entries(stats.channelHits ?? {}).filter(
    ([, v]) => typeof v === "number" && v > 0,
  );
  return (
    <section class="card card--flat">
      <div class="hstack" style="margin-bottom:var(--sp-2)">
        <span style="font-size:var(--fs-sm);font-weight:var(--fw-semi)">
          {t("logs.search.funnel")}
        </span>
      </div>
      <div
        class="hstack"
        style="gap:var(--sp-3);flex-wrap:wrap;font-size:var(--fs-xs)"
      >
        {stats.embedding?.degraded && (
          <span class="pill pill--failed">
            embedder degraded · {stats.embedding.errorCode ?? stats.embedding.errorMessage ?? "failed"}
          </span>
        )}
        <span class="pill pill--info">raw {raw}</span>
        <span class="pill pill--info">ranked {ranked}</span>
        {dropped > 0 && (
          <span class="pill pill--failed">dropped≥floor {dropped}</span>
        )}
        {typeof kept === "number" && (
          <span class="pill pill--active">llm kept {kept}</span>
        )}
        <span class="pill">outcome {outcome}</span>
        {lf.sufficient !== null && lf.sufficient !== undefined && (
          <span class={`pill ${lf.sufficient ? "pill--active" : "pill--failed"}`}>
            sufficient {String(lf.sufficient)}
          </span>
        )}
        <span class="muted">
          floor {fmtNum(stats.thresholdFloor)} · top {fmtNum(stats.topRelevance)}
        </span>
      </div>
      {channelEntries.length > 0 && (
        <div
          class="hstack"
          style="gap:var(--sp-2);flex-wrap:wrap;font-size:var(--fs-xs);margin-top:var(--sp-2)"
        >
          {channelEntries.map(([ch, n]) => (
            <span key={ch} class="pill">
              {ch} · {n}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function CandidateSection({
  title,
  count,
  rows,
  emptyLabel,
  variant,
}: {
  title: string;
  count: number;
  rows: SearchCandidate[];
  emptyLabel?: string;
  variant?: "filtered" | "dropped";
}) {
  return (
    <section class="card card--flat">
      <div class="hstack" style="margin-bottom:var(--sp-2)">
        <span style="font-size:var(--fs-sm);font-weight:var(--fw-semi)">{title}</span>
        <span
          class={`pill ${
            variant === "filtered"
              ? "pill--active"
              : variant === "dropped"
              ? "pill--failed"
              : "pill--info"
          }`}
        >
          {count}
        </span>
      </div>
      {rows.length === 0 && emptyLabel ? (
        <div class="muted" style="font-size:var(--fs-xs)">{emptyLabel}</div>
      ) : (
        <div class="vstack" style="gap:6px">
          {rows.slice(0, 20).map((c, i) => (
            <CandidateRow key={i} c={c} />
          ))}
          {rows.length > 20 && (
            <div class="muted" style="font-size:var(--fs-xs)">
              …(+{rows.length - 20} more)
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function CandidateRow({ c }: { c: SearchCandidate }) {
  const score = typeof c.score === "number" ? c.score : 0;
  const band = score >= 0.7 ? "high" : score >= 0.4 ? "mid" : "low";
  const text = (c.summary ?? c.snippet ?? c.content ?? "").toString();
  return (
    <div
      class="hstack"
      style="gap:var(--sp-3);padding:8px 10px;background:var(--bg-canvas);border-radius:var(--radius-sm);align-items:flex-start"
    >
      <span class={`log-score log-score--${band}`}>{score.toFixed(3)}</span>
      {c.role && (
        <span class={`pill pill--role-${sanitize(c.role)}`}>{c.role}</span>
      )}
      {c.refKind && (
        <span class="pill pill--info" style="font-size:var(--fs-2xs)">
          {c.refKind}
        </span>
      )}
      {c.origin && c.origin !== "local" && (
        <span class="pill pill--info" style="font-size:var(--fs-2xs)">
          {c.origin}
        </span>
      )}
      {c.owner && (
        <span class="muted" style="font-size:var(--fs-xs)">
          {c.owner}
        </span>
      )}
      <div
        style="flex:1;min-width:0;font-size:var(--fs-xs);line-height:1.55;white-space:pre-wrap;word-break:break-word"
      >
        {text || "(empty)"}
      </div>
    </div>
  );
}

// ─── memory_add template ────────────────────────────────────────────────

interface AddInput {
  sessionId?: string;
  episodeId?: string;
  turnCount?: number;
}
interface AddOutput {
  stats?: string;
  stored?: number;
  warnings?: Array<{ stage: string; message: string }>;
  details?: AddDetail[];
}
interface AddDetail {
  role?: string;
  action?: "stored" | "dedup" | "merged" | "error" | "exact-dup";
  summary?: string | null;
  content?: string;
  traceId?: string;
  reason?: string;
}

function MemoryAddDetail({
  input,
  output,
}: {
  input: unknown;
  output: unknown;
}) {
  const inp = (input ?? {}) as AddInput;
  const out = (output ?? {}) as AddOutput;
  const details = out.details ?? [];
  const warnings = out.warnings ?? [];
  return (
    <div class="vstack" style="gap:var(--sp-4)">
      <section class="card card--flat">
        <div class="hstack" style="gap:var(--sp-2);flex-wrap:wrap">
          {out.stored != null && (
            <span class="pill pill--active">stored {out.stored}</span>
          )}
          {inp.turnCount != null && (
            <span class="pill pill--info">{inp.turnCount} turns</span>
          )}
          {warnings.length > 0 && (
            <span class="pill pill--failed">{warnings.length} warn</span>
          )}
          {inp.sessionId && (
            <span class="muted mono" style="font-size:var(--fs-xs)">
              session {inp.sessionId.slice(0, 16)}
            </span>
          )}
          {inp.episodeId && (
            <span class="muted mono" style="font-size:var(--fs-xs)">
              episode {inp.episodeId.slice(0, 16)}
            </span>
          )}
        </div>
      </section>

      {warnings.length > 0 && (
        <section
          class="card card--flat"
          style="border-color:var(--warning);background:var(--warning-soft)"
        >
          <div style="font-size:var(--fs-xs);color:var(--warning);margin-bottom:4px">
            {t("logs.add.warnings")}
          </div>
          <ul style="margin:0;padding-left:20px;font-size:var(--fs-sm)">
            {warnings.map((w, i) => (
              <li key={i}>
                <span class="mono" style="font-size:var(--fs-xs)">{w.stage}</span>{" "}
                {w.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      {details.length > 0 && (
        <section class="card card--flat">
          <div
            class="muted"
            style="font-size:var(--fs-xs);margin-bottom:var(--sp-2)"
          >
            {t("logs.add.details")}
          </div>
          <div class="vstack" style="gap:6px">
            {details.map((d, i) => (
              <div
                key={i}
                class="hstack"
                style="gap:var(--sp-3);padding:8px 10px;background:var(--bg-canvas);border-radius:var(--radius-sm);align-items:flex-start"
              >
                <span class={`pill pill--action pill--action-${d.action}`}>
                  {d.action ?? "—"}
                </span>
                {d.role && (
                  <span class={`pill pill--role-${sanitize(d.role)}`}>
                    {d.role}
                  </span>
                )}
                <div
                  style="flex:1;min-width:0;font-size:var(--fs-xs);line-height:1.55;white-space:pre-wrap;word-break:break-word"
                >
                  {d.summary || d.content || "(empty)"}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ─── Lifecycle template (skill / policy / world / task) ────────────────

function LifecycleDetail({
  input,
  output,
  tool,
}: {
  input: unknown;
  output: unknown;
  tool: string;
}) {
  const inp = (input as Record<string, unknown> | null) ?? {};
  const out = (output as Record<string, unknown> | null) ?? {};
  return (
    <div class="vstack" style="gap:var(--sp-3)">
      <section class="card card--flat">
        <div class="muted" style="font-size:var(--fs-xs);margin-bottom:4px">
          {tool}
        </div>
        <div class="hstack" style="gap:var(--sp-2);flex-wrap:wrap">
          {Object.entries(inp)
            .filter(([_, v]) => v != null && v !== "")
            .slice(0, 8)
            .map(([k, v]) => (
              <span
                key={k}
                class="pill pill--info"
                style="font-family:var(--font-mono);font-size:var(--fs-2xs)"
              >
                {k}: {truncate(String(v), 40)}
              </span>
            ))}
        </div>
      </section>
      <section class="card card--flat">
        <div class="muted" style="font-size:var(--fs-xs);margin-bottom:4px">
          event
        </div>
        <pre
          class="mono"
          style="white-space:pre-wrap;font-size:var(--fs-xs);margin:0"
        >
          {JSON.stringify(out, null, 2)}
        </pre>
      </section>
    </div>
  );
}

// ─── session_relation_classify template ─────────────────────────────────

interface RelationClassifyInput {
  sessionId?: string;
  prevEpisodeId?: string;
  source?: string;
  gapMs?: number;
  mergeMode?: boolean;
  withinMergeWindow?: boolean;
  prevUserText?: string;
  prevAssistantText?: string;
  newUserText?: string;
}

interface RelationClassifyOutput {
  relation?: string;
  confidence?: number;
  reason?: string;
  signals?: string[];
  llmModel?: string;
  action?: string;
}

function RelationClassifyDetail({
  input,
  output,
}: {
  input: unknown;
  output: unknown;
}) {
  const inp = (input ?? {}) as RelationClassifyInput;
  const out = (output ?? {}) as RelationClassifyOutput;
  return (
    <div class="vstack" style="gap:var(--sp-3)">
      <section class="card card--flat">
        <div class="hstack" style="gap:var(--sp-2);margin-bottom:8px;flex-wrap:wrap">
          {out.relation && <span class="pill pill--active">relation: {out.relation}</span>}
          {typeof out.confidence === "number" && (
            <span class="pill pill--info">confidence: {out.confidence.toFixed(2)}</span>
          )}
          {out.action && <span class="pill">action: {out.action}</span>}
          {out.llmModel && <span class="pill">llm: {out.llmModel}</span>}
        </div>
        {out.reason && (
          <div class="mono" style="font-size:var(--fs-sm);line-height:1.5;word-break:break-word">
            {out.reason}
          </div>
        )}
        {out.signals && out.signals.length > 0 && (
          <div class="hstack" style="gap:var(--sp-2);margin-top:8px;flex-wrap:wrap">
            {out.signals.map((signal) => (
              <span key={signal} class="pill pill--info">{signal}</span>
            ))}
          </div>
        )}
      </section>
      <section class="card card--flat">
        <div class="hstack" style="gap:var(--sp-2);margin-bottom:8px;flex-wrap:wrap">
          {inp.source && <span class="pill">source: {inp.source}</span>}
          {inp.prevEpisodeId && <span class="pill">prev: {inp.prevEpisodeId}</span>}
          {typeof inp.gapMs === "number" && <span class="pill">gapMs: {inp.gapMs}</span>}
          <span class="pill">mergeMode: {String(inp.mergeMode)}</span>
          <span class="pill">withinWindow: {String(inp.withinMergeWindow)}</span>
        </div>
        <div class="grid grid--2" style="gap:var(--sp-3)">
          <TextPreview title="prev user" value={inp.prevUserText} />
          <TextPreview title="new user" value={inp.newUserText} />
        </div>
        {inp.prevAssistantText && (
          <div style="margin-top:var(--sp-3)">
            <TextPreview title="prev assistant" value={inp.prevAssistantText} />
          </div>
        )}
      </section>
    </div>
  );
}

function TextPreview({ title, value }: { title: string; value?: string }) {
  return (
    <div>
      <div class="muted" style="font-size:var(--fs-xs);margin-bottom:4px">
        {title}
      </div>
      <pre
        class="mono"
        style="white-space:pre-wrap;font-size:var(--fs-xs);margin:0;word-break:break-word"
      >
        {value || "(empty)"}
      </pre>
    </div>
  );
}

// ─── system_error template ──────────────────────────────────────────────

interface SystemErrorPayload {
  role?: "embedding" | "llm" | "skillEvolver";
  provider?: string;
  model?: string;
  message?: string;
  code?: string;
  at?: number;
}

interface SystemModelStatusPayload extends SystemErrorPayload {
  status?: "ok" | "fallback" | "error";
  fallbackProvider?: string;
  fallbackModel?: string;
  op?: string;
  episodeId?: string;
  phase?: string;
}

/**
 * Detail view for a `system_error` row. The bootstrap-installed sink
 * stores a flat `{ role, provider, model, message, code, at }` blob so
 * the renderer is intentionally minimal — one prominent red error line
 * plus a row of metadata pills.
 */
function SystemErrorDetail({ output }: { output: unknown }) {
  const out = (output ?? {}) as SystemErrorPayload;
  const role = out.role ?? "(unknown)";
  return (
    <div class="vstack" style="gap:var(--sp-3)">
      <section
        class="card card--flat"
        style="border-color:var(--danger);background:var(--danger-soft)"
      >
        <div
          class="muted"
          style="font-size:var(--fs-xs);margin-bottom:4px;color:var(--danger)"
        >
          {t("logs.system.role", { role: roleLabel(role) })}
        </div>
        <div class="mono" style="font-size:var(--fs-sm);line-height:1.5;word-break:break-word">
          {out.message || "(no message)"}
        </div>
      </section>
      <div class="hstack" style="gap:var(--sp-2);flex-wrap:wrap">
        {out.provider && (
          <span class="pill pill--info" style="font-family:var(--font-mono)">
            provider: {out.provider}
          </span>
        )}
        {out.model && (
          <span class="pill pill--info" style="font-family:var(--font-mono)">
            model: {out.model}
          </span>
        )}
        {out.code && (
          <span class="pill pill--failed" style="font-family:var(--font-mono)">
            code: {out.code}
          </span>
        )}
      </div>
    </div>
  );
}

function SystemModelStatusDetail({ output }: { output: unknown }) {
  const out = (output ?? {}) as SystemModelStatusPayload;
  const status = out.status ?? "error";
  const role = out.role ?? "(unknown)";
  const tone =
    status === "ok"
      ? { border: "var(--success)", bg: "var(--success-soft)", pill: "pill--active" }
      : status === "fallback"
      ? { border: "#f59e0b", bg: "rgba(245, 158, 11, 0.12)", pill: "pill--info" }
      : { border: "var(--danger)", bg: "var(--danger-soft)", pill: "pill--failed" };
  return (
    <div class="vstack" style="gap:var(--sp-3)">
      <section
        class="card card--flat"
        style={`border-color:${tone.border};background:${tone.bg}`}
      >
        <div class="hstack" style="gap:var(--sp-2);margin-bottom:6px;flex-wrap:wrap">
          <span class={`pill ${tone.pill}`}>{status}</span>
          <span class="pill pill--info">{roleLabel(role)}</span>
          {out.op && <span class="pill">op: {out.op}</span>}
          {out.episodeId && <span class="pill">episode: {out.episodeId}</span>}
          {out.phase && <span class="pill">phase: {out.phase}</span>}
          {out.provider && <span class="pill">provider: {out.provider}</span>}
          {out.model && <span class="pill">model: {out.model}</span>}
          {out.fallbackProvider && (
            <span class="pill pill--info">fallback: {out.fallbackProvider}</span>
          )}
        </div>
        {out.message && (
          <div class="mono" style="font-size:var(--fs-sm);line-height:1.5;word-break:break-word">
            {out.message}
          </div>
        )}
      </section>
    </div>
  );
}

function roleLabel(role: string): string {
  switch (role) {
    case "embedding":
      return t("logs.system.role.embedding");
    case "llm":
      return t("logs.system.role.llm");
    case "skillEvolver":
      return t("logs.system.role.skillEvolver");
    default:
      return role;
  }
}

/**
 * Title-bracket label for `system_*` log entries. Prefer the concrete
 * `op` (e.g. `skill.crystallize`, `l3.abstraction.v1`) since the role
 * alone ("摘要模型" / "技能进化模型") is not actionable when scanning
 * the chain timeline. Collapse doubled phase prefixes that come out of
 * the backend op naming convention (`l2.l2.induction.v2` →
 * `l2.induction.v2`, `retrieval.retrieval.filter.v3` →
 * `retrieval.filter.v3`).
 */
function formatOpLabel(op: string | undefined, role: string): string {
  const trimmed = (op ?? "").trim();
  if (!trimmed) return roleLabel(role);
  const parts = trimmed.split(".");
  if (parts.length >= 2 && parts[0] === parts[1]) {
    return [parts[0], ...parts.slice(2)].join(".");
  }
  return trimmed;
}

// ─── Generic fallback ───────────────────────────────────────────────────

function GenericDetail({
  input,
  output,
}: {
  input: unknown;
  output: unknown;
}) {
  return (
    <div class="vstack" style="gap:var(--sp-3)">
      <section class="card card--flat">
        <div class="muted" style="font-size:var(--fs-xs);margin-bottom:4px">
          input
        </div>
        <pre
          class="mono"
          style="white-space:pre-wrap;font-size:var(--fs-xs);margin:0"
        >
          {JSON.stringify(input, null, 2)}
        </pre>
      </section>
      <section class="card card--flat">
        <div class="muted" style="font-size:var(--fs-xs);margin-bottom:4px">
          output
        </div>
        <pre
          class="mono"
          style="white-space:pre-wrap;font-size:var(--fs-xs);margin:0"
        >
          {typeof output === "string" ? output : JSON.stringify(output, null, 2)}
        </pre>
      </section>
    </div>
  );
}

// ─── helpers ────────────────────────────────────────────────────────────

function formatLogDuration(log: ApiLogDTO): string {
  if (log.durationMs > 0) return `${log.durationMs}ms`;
  if (isLifecycleTool(log.toolName)) return "—";
  return "<1ms";
}

function isLifecycleTool(toolName: string): boolean {
  return (
    toolName.startsWith("skill_") ||
    toolName.startsWith("policy_") ||
    toolName.startsWith("world_model_") ||
    toolName.startsWith("task_")
  );
}

function parseJson(s: string): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/**
 * Human-readable summary shown on the collapsed log row. The key
 * constraint: the user must be able to SKIM the page and know what
 * happened without expanding each row. For lifecycle events that
 * means pulling the actual skill / policy / world-model name, not
 * the id.
 *
 * Precedence per tool:
 *   - memory_search  → the query + kept/total counts
 *   - memory_add     → first 3 per-turn summaries (already meaningful)
 *   - skill_*        → `output.name` (e.g. "write_python_function_with_types")
 *   - policy_*       → `output.title` (e.g. "Write Python function …")
 *   - world_model_*  → `output.title`
 *   - task_done/failed → "R=… · source=…"
 *   - unknown        → tool name as last resort
 */
function buildSummary(log: ApiLogDTO, input: unknown, output: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  const out = (output ?? {}) as Record<string, unknown>;

  if (log.toolName === "memory_search") {
    const q = (inp.query as string | undefined) ?? "(empty)";
    const kept = (out.filtered as unknown[] | undefined)?.length ?? 0;
    const totalN = (out.candidates as unknown[] | undefined)?.length ?? 0;
    return `"${truncate(q, 60)}" — kept ${kept}/${totalN}`;
  }
  if (log.toolName === "memory_add") {
    const details = (out.details as AddDetail[] | undefined) ?? [];
    if (details.length > 0) {
      const pieces = details
        .slice(0, 3)
        .map((d) => {
          const text = (d.summary ?? d.content ?? "").toString().trim();
          return text ? truncate(text, 80) : "(empty)";
        })
        .filter(Boolean);
      const more = details.length > 3 ? ` +${details.length - 3}` : "";
      return pieces.join(" · ") + more;
    }
    const s = (out.stored as number | undefined) ?? 0;
    const turns = (inp.turnCount as number | undefined) ?? 0;
    return `stored=${s}, turns=${turns}`;
  }

  // Lifecycle events. Prefer the most semantic label the pipeline
  // stamped onto the event payload (skill.name / policy.title /
  // world_model.title), falling back to the input side, and only
  // finally to a truncated id.
  if (log.toolName.startsWith("skill_")) {
    const name =
      (out.name as string | undefined) ??
      (inp.name as string | undefined);
    if (name) return name;
    const id = (out.skillId as string | undefined) ?? (inp.skillId as string | undefined);
    return id ? `skill ${truncate(id, 24)}` : log.toolName;
  }
  if (log.toolName.startsWith("policy_")) {
    const title =
      (out.title as string | undefined) ??
      (inp.title as string | undefined);
    if (title) return title;
    const id = (out.policyId as string | undefined) ?? (inp.policyId as string | undefined);
    return id ? `policy ${truncate(id, 24)}` : log.toolName;
  }
  if (log.toolName.startsWith("world_model_")) {
    const title =
      (out.title as string | undefined) ??
      (inp.title as string | undefined);
    if (title) return title;
    const id =
      (out.worldModelId as string | undefined) ??
      (inp.worldModelId as string | undefined);
    return id ? `world model ${truncate(id, 24)}` : log.toolName;
  }
  if (log.toolName === "system_error") {
    const role = (out.role as string | undefined) ?? "?";
    const op = (out.op as string | undefined) ?? "";
    const message = (out.message as string | undefined) ?? "";
    const provider = (out.provider as string | undefined) ?? "";
    const head = `[${formatOpLabel(op, role)}]`;
    const tail = message
      ? truncate(message, 80)
      : provider
      ? provider
      : "(no message)";
    return `${head} ${tail}`;
  }
  if (log.toolName === "system_model_status") {
    const role = (out.role as string | undefined) ?? "?";
    const op = (out.op as string | undefined) ?? "";
    const status = (out.status as string | undefined) ?? "?";
    const provider = (out.provider as string | undefined) ?? "";
    const model = (out.model as string | undefined) ?? "";
    const message = (out.message as string | undefined) ?? "";
    const bits = [`[${formatOpLabel(op, role)}]`, status];
    if (provider || model) bits.push([provider, model].filter(Boolean).join("/"));
    if (message) bits.push(truncate(message, 60));
    return bits.join(" · ");
  }
  if (log.toolName === "session_relation_classify") {
    const relation = (out.relation as string | undefined) ?? "?";
    const confidence =
      typeof out.confidence === "number" ? (out.confidence as number).toFixed(2) : "?";
    const action = (out.action as string | undefined) ?? "";
    const reason = (out.reason as string | undefined) ?? "";
    return [
      `${relation} (${confidence})`,
      action,
      reason ? truncate(reason, 80) : "",
    ].filter(Boolean).join(" · ");
  }
  if (log.toolName === "task_done" || log.toolName === "task_failed") {
    const rHuman = typeof out.rHuman === "number" ? (out.rHuman as number).toFixed(2) : null;
    const source = (out.source as string | undefined) ?? "";
    const ep = (inp.episodeId as string | undefined) ?? "";
    const bits: string[] = [];
    if (rHuman != null) bits.push(`R=${rHuman}`);
    if (source) bits.push(source);
    if (ep) bits.push(`ep ${truncate(ep, 16)}`);
    return bits.length > 0 ? bits.join(" · ") : log.toolName;
  }

  // Unknown tool — show whatever title-ish field we can find.
  const fallback =
    (out.title as string | undefined) ??
    (inp.title as string | undefined) ??
    "";
  return fallback ? truncate(fallback, 80) : log.toolName;
}

function truncate(s: string, n: number): string {
  const oneLine = String(s).replace(/\s+/g, " ").trim();
  return oneLine.length > n ? oneLine.slice(0, n - 1) + "…" : oneLine;
}

function formatTs(ts: number): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

function sanitize(s: string): string {
  return s.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
}

// ─── Chain view (episode-correlated timeline) ───────────────────────────
//
// The flat per-tool list is good for spot-checks but it makes the
// retrieval → ingest → reward → policy → skill → world cascade
// hard to follow. The chain view re-groups the same `api_logs`
// rows by `episodeId` (fallback `sessionId`) and renders each
// group as an ordered timeline. We extract correlation IDs and a
// coarse `stage` purely on the client from the existing JSON so
// no backend change is required.

type StageKind =
  | "topic"
  | "retrieval"
  | "ingest"
  | "task"
  | "policy"
  | "skill"
  | "world"
  | "system"
  | "other";

interface ChainEvent {
  log: ApiLogDTO;
  input: unknown;
  output: unknown;
  stage: StageKind;
  stagePhase?: string;
  episodeId?: string;
  sessionId?: string;
  traceIds: string[];
  policyId?: string;
  skillId?: string;
  worldModelId?: string;
  /** Set when this event is an infrastructure heartbeat (e.g. embedding model). */
  infraKind?: "embedding";
}

interface Chain {
  /** "ep:..." | "ss:..." | "solo:..." | "infra:embedding" */
  key: string;
  episodeId?: string;
  sessionId?: string;
  events: ChainEvent[];
  startedAt: number;
  lastAt: number;
  failureCount: number;
  /** Distinct stage kinds seen in this chain. */
  stagesSeen: Set<StageKind>;
  /**
   * Marks "infrastructure" chains that don't belong to any single
   * episode (e.g. embedding model heartbeats fired throughout multiple
   * episodes). Rendered with a compact summary instead of a per-event
   * timeline.
   */
  infraKind?: "embedding";
}

function pickStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function buildChainEvent(log: ApiLogDTO): ChainEvent {
  const input = parseJson(log.inputJson);
  const output = parseJson(log.outputJson);
  const inp = (input ?? {}) as Record<string, unknown>;
  const out = (output ?? {}) as Record<string, unknown>;

  const traceIds: string[] = [];
  let episodeId: string | undefined;
  let sessionId: string | undefined;
  let policyId: string | undefined;
  let skillId: string | undefined;
  let worldModelId: string | undefined;
  let stage: StageKind = "other";
  let stagePhase: string | undefined;
  let infraKind: ChainEvent["infraKind"];

  if (log.toolName === "memory_search") {
    stage = "retrieval";
    sessionId = pickStr(inp.sessionId);
    episodeId = pickStr(inp.episodeId);
    stagePhase = pickStr(inp.type) ?? "search";
  } else if (log.toolName === "memory_add") {
    stage = "ingest";
    sessionId = pickStr(inp.sessionId);
    episodeId = pickStr(inp.episodeId);
    stagePhase = pickStr(inp.phase) ?? "store";
    const details = (out.details as Array<{ traceId?: string }> | undefined) ?? [];
    for (const d of details) if (d?.traceId) traceIds.push(d.traceId);
  } else if (log.toolName === "session_relation_classify") {
    stage = "topic";
    sessionId = pickStr(inp.sessionId);
    episodeId = pickStr(inp.prevEpisodeId);
    stagePhase = pickStr(out.relation);
  } else if (log.toolName === "task_done" || log.toolName === "task_failed") {
    stage = "task";
    sessionId = pickStr(inp.sessionId) ?? pickStr(out.sessionId);
    episodeId = pickStr(inp.episodeId) ?? pickStr(out.episodeId);
    stagePhase = log.toolName === "task_done" ? "done" : "failed";
  } else if (log.toolName.startsWith("policy_")) {
    stage = "policy";
    policyId = pickStr(inp.policyId) ?? pickStr(out.policyId);
    episodeId = pickStr(out.episodeId) ?? pickStr(inp.episodeId);
    stagePhase = pickStr(inp.phase) ?? log.toolName.replace("policy_", "");
  } else if (log.toolName.startsWith("skill_")) {
    stage = "skill";
    skillId = pickStr(inp.skillId) ?? pickStr(out.skillId);
    policyId = pickStr(out.policyId) ?? pickStr(inp.policyId);
    episodeId = pickStr(out.episodeId) ?? pickStr(inp.episodeId);
    stagePhase =
      pickStr(inp.kind) ??
      pickStr(inp.phase) ??
      log.toolName.replace("skill_", "");
  } else if (log.toolName.startsWith("world_model_")) {
    stage = "world";
    worldModelId = pickStr(inp.worldModelId) ?? pickStr(out.worldModelId);
    episodeId = pickStr(out.episodeId) ?? pickStr(inp.episodeId);
    stagePhase = pickStr(inp.phase) ?? log.toolName.replace("world_model_", "");
  } else if (log.toolName.startsWith("system_")) {
    stage = "system";
    episodeId = pickStr(out.episodeId) ?? pickStr(inp.episodeId);
    stagePhase = pickStr(out.role) ?? pickStr(out.status);
    // Embedding model status events fire on every embed call (capture,
    // L2, L3, retrieval) and aren't tied to a single episode. Route
    // them into a dedicated "infrastructure heartbeat" chain so they
    // don't pollute the episode timelines.
    if (
      log.toolName === "system_model_status" &&
      pickStr(out.role) === "embedding"
    ) {
      infraKind = "embedding";
      episodeId = undefined;
      sessionId = undefined;
    }
  }

  return {
    log,
    input,
    output,
    stage,
    stagePhase,
    episodeId,
    sessionId,
    traceIds,
    policyId,
    skillId,
    worldModelId,
    infraKind,
  };
}

function aggregateChains(logs: ApiLogDTO[]): Chain[] {
  const map = new Map<string, Chain>();
  for (const log of logs) {
    const evt = buildChainEvent(log);
    const key =
      evt.infraKind === "embedding"
        ? "infra:embedding"
        : evt.episodeId
        ? `ep:${evt.episodeId}`
        : evt.sessionId
        ? `ss:${evt.sessionId}`
        : `solo:${log.id}`;
    let chain = map.get(key);
    if (!chain) {
      chain = {
        key,
        episodeId: evt.episodeId,
        sessionId: evt.sessionId,
        events: [],
        startedAt: log.calledAt,
        lastAt: log.calledAt,
        failureCount: 0,
        stagesSeen: new Set(),
        infraKind: evt.infraKind,
      };
      map.set(key, chain);
    }
    chain.events.push(evt);
    if (!chain.episodeId && evt.episodeId) chain.episodeId = evt.episodeId;
    if (!chain.sessionId && evt.sessionId) chain.sessionId = evt.sessionId;
    chain.startedAt = Math.min(chain.startedAt, log.calledAt);
    chain.lastAt = Math.max(chain.lastAt, log.calledAt);
    if (!log.success) chain.failureCount += 1;
    chain.stagesSeen.add(evt.stage);
  }
  for (const c of map.values()) {
    // Newest event first inside each chain — operators usually scan
    // the most recent step (the one that just failed, or the latest
    // skill update) before walking back to look at upstream context.
    c.events.sort(
      (a, b) => b.log.calledAt - a.log.calledAt || b.log.id - a.log.id,
    );
  }
  return Array.from(map.values()).sort((a, b) => b.lastAt - a.lastAt);
}

const STAGE_LABEL: Record<StageKind, string> = {
  topic: "话题",
  retrieval: "检索",
  ingest: "记录",
  task: "任务",
  policy: "经验",
  skill: "技能",
  world: "环境",
  system: "系统",
  other: "其他",
};

function stageLabel(stage: StageKind): string {
  return STAGE_LABEL[stage] ?? stage;
}

function shortId(id: string, n = 12): string {
  return id.length > n ? id.slice(0, n) + "…" : id;
}

function ChainCard({
  chain,
  expanded,
  onToggle,
  expandedRows,
  onToggleRow,
}: {
  chain: Chain;
  expanded: boolean;
  onToggle: () => void;
  expandedRows: Set<number>;
  onToggleRow: (id: number) => void;
}) {
  if (chain.infraKind === "embedding") {
    return (
      <InfraHeartbeatCard
        chain={chain}
        expanded={expanded}
        onToggle={onToggle}
        expandedRows={expandedRows}
        onToggleRow={onToggleRow}
      />
    );
  }
  const ep = chain.episodeId;
  const sn = chain.sessionId;
  // When collapsed, give a one-line peek at the most recent event so
  // the user can scan the page without expanding every chain.
  const latest = chain.events[0];
  return (
    <div
      class="card card--flat"
      style="padding:var(--sp-3);display:flex;flex-direction:column;gap:var(--sp-3)"
    >
      <button
        type="button"
        onClick={onToggle}
        class="hstack"
        style="width:100%;gap:var(--sp-2);flex-wrap:wrap;align-items:center;background:transparent;border:none;padding:0;cursor:pointer;text-align:left;color:var(--fg)"
      >
        <Icon name={expanded ? "chevron-down" : "chevron-right"} size={14} />
        {ep ? (
          <span
            class="pill pill--info"
            style="font-family:var(--font-mono);font-size:var(--fs-2xs)"
            title={ep}
          >
            episode {shortId(ep, 16)}
          </span>
        ) : sn ? (
          <span
            class="pill"
            style="font-family:var(--font-mono);font-size:var(--fs-2xs)"
            title={sn}
          >
            session {shortId(sn, 16)}
          </span>
        ) : (
          latest && (
            <>
              <span
                class="pill"
                style={`background:${stageColor(latest.stage)};color:#fff;border-color:transparent;font-size:var(--fs-2xs)`}
              >
                {stageLabel(latest.stage)}
              </span>
              <span
                class="mono muted"
                style="font-size:var(--fs-2xs)"
                title={latest.log.toolName}
              >
                {latest.log.toolName}
              </span>
            </>
          )
        )}
        {sn && ep && (
          <span
            class="muted mono"
            style="font-size:var(--fs-2xs)"
            title={sn}
          >
            session {shortId(sn, 12)}
          </span>
        )}
        <span class="muted" style="font-size:var(--fs-xs)">
          {chain.events.length} 事件
        </span>
        {chain.failureCount > 0 && (
          <span class="pill pill--failed">{chain.failureCount} 失败</span>
        )}
        <div class="toolbar__spacer" />
        <span class="muted" style="font-size:var(--fs-xs)">
          {formatTs(chain.startedAt)}
          {chain.startedAt !== chain.lastAt
            ? ` → ${formatTs(chain.lastAt)}`
            : ""}
        </span>
      </button>

      {!expanded && latest && (
        <div
          class="hstack muted"
          style="gap:var(--sp-2);font-size:var(--fs-xs);align-items:center"
        >
          <span
            class="pill"
            style={`background:${stageColor(latest.stage)};color:#fff;border-color:transparent;font-size:var(--fs-2xs)`}
          >
            {stageLabel(latest.stage)}
          </span>
          <span class="mono" style="font-size:var(--fs-2xs)">
            最新
          </span>
          <span
            style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
            title={buildSummary(latest.log, latest.input, latest.output)}
          >
            {buildSummary(latest.log, latest.input, latest.output)}
          </span>
        </div>
      )}

      {expanded && (
        <div class="vstack" style="gap:6px">
          {chain.events.map((ev) => (
            <ChainEventRow
              key={ev.log.id}
              ev={ev}
              expanded={expandedRows.has(ev.log.id)}
              onToggle={() => onToggleRow(ev.log.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Compact summary card for "infrastructure" chains (currently only the
 * embedding model heartbeat). Embedding status events fire on every
 * embed call, so rendering one row per event would drown the chain
 * view. Instead we show a single card with status counts plus the most
 * recent provider/model/error, and let the user expand to see the raw
 * timeline if they need to debug.
 */
function InfraHeartbeatCard({
  chain,
  expanded,
  onToggle,
  expandedRows,
  onToggleRow,
}: {
  chain: Chain;
  expanded: boolean;
  onToggle: () => void;
  expandedRows: Set<number>;
  onToggleRow: (id: number) => void;
}) {
  let okCount = 0;
  let errCount = 0;
  let fallbackCount = 0;
  let lastProvider: string | undefined;
  let lastModel: string | undefined;
  let lastError: string | undefined;
  let lastErrorAt: number | undefined;
  for (const ev of chain.events) {
    const out = (ev.output ?? {}) as Record<string, unknown>;
    const status = pickStr(out.status);
    if (status === "ok") okCount += 1;
    else if (status === "fallback") fallbackCount += 1;
    else errCount += 1;
    if (!lastProvider) lastProvider = pickStr(out.provider);
    if (!lastModel) lastModel = pickStr(out.model);
    if (!lastError && (status === "error" || status === "fallback")) {
      lastError = pickStr(out.message);
      lastErrorAt = ev.log.calledAt;
    }
  }
  const total = chain.events.length;
  return (
    <div
      class="card card--flat"
      style="padding:var(--sp-3);display:flex;flex-direction:column;gap:var(--sp-3)"
    >
      <button
        type="button"
        onClick={onToggle}
        class="hstack"
        style="width:100%;gap:var(--sp-2);flex-wrap:wrap;align-items:center;background:transparent;border:none;padding:0;cursor:pointer;text-align:left;color:var(--fg)"
      >
        <Icon name={expanded ? "chevron-down" : "chevron-right"} size={14} />
        <span
          class="pill"
          style="background:#475569;color:#fff;border-color:transparent;font-size:var(--fs-2xs)"
          title="基础设施心跳:不属于任何具体 episode 的模型可用性事件"
        >
          基础设施心跳
        </span>
        <span class="pill pill--info" style="font-size:var(--fs-2xs)">
          嵌入模型 · {total} 次
        </span>
        {okCount > 0 && (
          <span
            class="pill"
            style="background:rgba(22,163,74,0.12);color:#16a34a;border-color:transparent;font-size:var(--fs-2xs)"
          >
            ok {okCount}
          </span>
        )}
        {fallbackCount > 0 && (
          <span
            class="pill"
            style="background:rgba(217,119,6,0.12);color:#d97706;border-color:transparent;font-size:var(--fs-2xs)"
          >
            fallback {fallbackCount}
          </span>
        )}
        {errCount > 0 && (
          <span class="pill pill--failed" style="font-size:var(--fs-2xs)">
            error {errCount}
          </span>
        )}
        <div class="toolbar__spacer" />
        <span class="muted" style="font-size:var(--fs-xs)">
          {formatTs(chain.startedAt)}
          {chain.startedAt !== chain.lastAt
            ? ` → ${formatTs(chain.lastAt)}`
            : ""}
        </span>
      </button>

      {!expanded && (
        <div
          class="hstack muted"
          style="gap:var(--sp-2);font-size:var(--fs-xs);align-items:center;flex-wrap:wrap"
        >
          {(lastProvider || lastModel) && (
            <span class="mono" style="font-size:var(--fs-2xs)">
              {lastProvider ?? "?"} · {lastModel ?? "?"}
            </span>
          )}
          {lastError ? (
            <span
              style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--danger)"
              title={lastError}
            >
              最近异常: {lastError}
              {lastErrorAt ? ` (${formatTs(lastErrorAt)})` : ""}
            </span>
          ) : (
            <span class="muted" style="font-size:var(--fs-2xs)">
              所有心跳正常
            </span>
          )}
        </div>
      )}

      {expanded && (
        <div class="vstack" style="gap:6px">
          {chain.events.map((ev) => (
            <ChainEventRow
              key={ev.log.id}
              ev={ev}
              expanded={expandedRows.has(ev.log.id)}
              onToggle={() => onToggleRow(ev.log.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ChainEventRow({
  ev,
  expanded,
  onToggle,
}: {
  ev: ChainEvent;
  expanded: boolean;
  onToggle: () => void;
}) {
  const ok = ev.log.success;
  return (
    <div
      style="border:1px solid var(--border-subtle);border-radius:var(--radius-sm);background:var(--bg-canvas)"
    >
      <button
        type="button"
        onClick={onToggle}
        class="hstack"
        style="width:100%;padding:6px 10px;gap:var(--sp-2);background:transparent;border:none;cursor:pointer;text-align:left;align-items:center;color:var(--fg)"
      >
        <span
          aria-hidden="true"
          style={`flex:0 0 8px;width:8px;height:8px;border-radius:50%;background:${ok ? "var(--success)" : "var(--danger)"}`}
        />
        <span
          class="pill"
          style={`background:${stageColor(ev.stage)};color:#fff;border-color:transparent;font-size:var(--fs-2xs)`}
        >
          {stageLabel(ev.stage)}
        </span>
        {ev.stagePhase && (
          <span class="pill" style="font-size:var(--fs-2xs)">{ev.stagePhase}</span>
        )}
        <span class="mono muted" style="font-size:var(--fs-2xs)">
          {ev.log.toolName}
        </span>
        <span
          style="flex:1;min-width:0;font-size:var(--fs-xs);line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg)"
          title={buildSummary(ev.log, ev.input, ev.output)}
        >
          {buildSummary(ev.log, ev.input, ev.output)}
        </span>
        <span class="muted mono" style="font-size:var(--fs-2xs)">
          {formatLogDuration(ev.log)}
        </span>
        <span class="muted" style="font-size:var(--fs-2xs)">
          {formatTs(ev.log.calledAt)}
        </span>
        <Icon name={expanded ? "chevron-up" : "chevron-down"} size={14} />
      </button>
      {expanded && (
        <div
          style="padding:8px 10px;border-top:1px solid var(--border-subtle)"
        >
          <LogDetailBody log={ev.log} input={ev.input} output={ev.output} />
        </div>
      )}
    </div>
  );
}

function stageColor(stage: StageKind): string {
  switch (stage) {
    case "topic":
      return "#7c3aed";
    case "retrieval":
      return "#2563eb";
    case "ingest":
      return "#0891b2";
    case "task":
      return "#16a34a";
    case "policy":
      return "#d97706";
    case "skill":
      return "#db2777";
    case "world":
      return "#0d9488";
    case "system":
      return "#dc2626";
    default:
      return "#6b7280";
  }
}
