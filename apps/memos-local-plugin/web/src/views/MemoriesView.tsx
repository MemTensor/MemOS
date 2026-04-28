/**
 * Memories view — paginated (prev/next), drawer-driven detail.
 *
 * Display granularity: **one user↔agent turn = one card**.
 *
 * The capture pipeline writes L1 traces at the step level (V7 §0.1
 * — one tool call → one trace, plus one trace for the final reply)
 * because every algorithm consumer (R_human backprop, L2 incremental
 * association, Tier-2 retrieval, Decision Repair) needs that step
 * granularity. The viewer collapses sibling sub-steps back into a
 * single card by grouping on `(episodeId, turnId)` — `turnId` is the
 * stable group key `step-extractor` stamps onto every trace produced
 * from the same user message.
 *
 * Bulk actions (select / delete / share / export) operate on whole
 * cards: the card-level checkbox toggles the full set of member trace
 * ids, the delete button removes every member, and so on. The drawer
 * lays out each member step as its own collapsible section so users
 * can still inspect per-tool value / reflection without leaving the
 * "one round = one memory" mental model.
 *
 * Layout (matches TasksView so all three data browsers feel alike):
 *
 *   ╭─ view-header ─────────────────────────────────────────╮
 *   │  title + subtitle                             [reset] │
 *   ╰────────────────────────────────────────────────────────╯
 *   ╭─ toolbar: search box ──────────────────────────────────╮
 *   │  [🔍 search memories …]                                │
 *   ╰────────────────────────────────────────────────────────╯
 *   ╭─ toolbar: filter chips (own row) ──────────────────────╮
 *   │  [All][User][Assistant][Tool]                          │
 *   ╰────────────────────────────────────────────────────────╯
 *   ╭─ batch-bar (shows when any card is selected) ─────────╮
 *   │  Selected N   [Select page] [Copy] [Delete] [Deselect]│
 *   ╰────────────────────────────────────────────────────────╯
 *   ┌─ card (one turn; clickable → opens drawer) ───────────┐
 *   │ ☐   summary line …                                      │
 *   │     · role · [scope] · date · V/α · tools · steps      │
 *   └──────────────────────────────────────────────────────────┘
 *   ╭─ pager ───────────────────────────────────────────────╮
 *   │  [prev]   N / total   [next]                           │
 *   ╰────────────────────────────────────────────────────────╯
 *
 * Pagination, not infinite scroll — the previous implementation hid
 * the batch-bar off the bottom of the page and made "select all"
 * unreachable on small screens. Prev/next sits at page bottom, but
 * the batch-bar is moved ABOVE the list so it's visible as soon as
 * any row is selected.
 */
import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api/client";
import { t } from "../stores/i18n";
import { Icon } from "../components/Icon";
import { route } from "../stores/router";
import type { TraceDTO } from "../api/types";

interface ListResponse {
  traces: TraceDTO[];
  limit: number;
  offset: number;
  nextOffset?: number;
  total?: number;
}

/**
 * One displayable card in the Memories list — a "user message + every
 * sub-step it produced" unit. `traces` are the raw L1 rows the
 * pipeline wrote (tool steps + final reply); `head` is the row that
 * carries the user query. `turnKey` is what the page groups on:
 * `${episodeId}:${turnId}`.
 */
interface MemoryGroup {
  turnKey: string;
  episodeId: string | null;
  ts: number;
  head: TraceDTO;
  traces: TraceDTO[];
  ids: string[];
  toolCount: number;
  toolNames: string[];
  aggValue: number;
  aggAlpha: number;
  hasReflection: boolean;
  scope: "private" | "public" | "hub";
  shared: boolean;
}

const PAGE_SIZE = 20;

export function MemoriesView() {
  // Pre-fill from URL `?q=` so the global search box in Header can
  // navigate here with a pending query.
  const [query, setQuery] = useState(() => route.value.params.q ?? "");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [traces, setTraces] = useState<TraceDTO[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<MemoryGroup | null>(null);
  const [toast, setToast] = useState<{ msg: string; kind: "info" | "success" | "error" } | null>(null);

  const showToast = (msg: string, kind: "info" | "success" | "error" = "success") => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 2400);
  };

  const loadPage = async (opts: { q: string; page: number }) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      qs.set("limit", String(PAGE_SIZE));
      qs.set("offset", String(opts.page * PAGE_SIZE));
      qs.set("groupByTurn", "true");
      if (opts.q) qs.set("q", opts.q);
      const res = await api.get<ListResponse>(`/api/v1/traces?${qs.toString()}`);
      setTraces(res.traces);
      setHasMore(res.nextOffset != null);
      setTotal(res.total ?? 0);
      setPage(opts.page);
    } catch {
      setTraces([]);
      setHasMore(false);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  };

  // Debounced filter — reset to page 0 on query change.
  useEffect(() => {
    const h = setTimeout(() => {
      void loadPage({ q: query.trim(), page: 0 });
    }, 200);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // Sync with URL `?q=` when the route changes (e.g. the Header's
  // global search bar navigates here while this view is already open).
  useEffect(() => {
    const routeQ = route.value.params.q ?? "";
    if (routeQ && routeQ !== query) {
      setQuery(routeQ);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.value.params.q]);

  /**
   * Bucket the page's traces by `(episodeId, turnId)` so each "user
   * message + every sub-step it produced" collapses into one card.
   */
  const groups = useMemo<MemoryGroup[]>(() => {
    return buildGroups(traces);
  }, [traces]);

  /**
   * A card is "selected" when every member trace id is in the
   * `selected` set — the per-trace store keeps the existing
   * bulk-action APIs (bulkDelete / bulkShare) unchanged.
   */
  const isGroupSelected = (g: MemoryGroup): boolean =>
    g.ids.length > 0 && g.ids.every((id) => selected.has(id));

  // Number of selected memories (turns), not raw traces. A memory card
  // contains all the tool sub-step traces of one user turn, so the
  // batch-bar count and confirm prompts must report turns or the user
  // sees inflated numbers.
  const selectedGroupCount = useMemo(
    () => groups.filter(isGroupSelected).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, selected],
  );

  const toggleGroupSel = (g: MemoryGroup) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const allIn = g.ids.every((id) => next.has(id));
      for (const id of g.ids) {
        if (allIn) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };
  const selectPage = () =>
    setSelected(new Set(groups.flatMap((g) => g.ids)));
  const deselectAll = () => setSelected(new Set());

  const bulkDelete = async () => {
    if (selected.size === 0) return;
    if (!confirm(t("memories.delete.bulkConfirm", { n: selectedGroupCount }))) return;
    try {
      const ids = [...selected];
      const res = await api.post<{ deleted: number }>(`/api/v1/traces/delete`, { ids });
      await loadPage({ q: query.trim(), page });
      setSelected(new Set());
      showToast(t("memories.delete.bulkDone", { n: res.deleted }));
    } catch {
      showToast("Failed", "error");
    }
  };

  const bulkShare = async (scope: "public" | null) => {
    if (selected.size === 0) return;
    const ids = [...selected];
    try {
      await Promise.all(
        ids.map((id) =>
          api
            .post<TraceDTO>(
              `/api/v1/traces/${encodeURIComponent(id)}/share`,
              { scope },
            )
            .catch(() => null),
        ),
      );
      await loadPage({ q: query.trim(), page });
      setSelected(new Set());
      showToast(
        scope
          ? t("memories.share.bulkDone", { n: ids.length })
          : t("memories.share.bulkRemoved", { n: ids.length }),
      );
    } catch {
      showToast("Failed", "error");
    }
  };

  const bulkExport = () => {
    if (selected.size === 0) return;
    const lines: string[] = [];
    for (const g of groups) {
      if (!isGroupSelected(g)) continue;
      const head = pickSummary(g.head);
      lines.push(`# ${head}`);
      for (const tr of g.traces) {
        if (tr.userText) lines.push(`[user] ${tr.userText}`);
        for (const tc of tr.toolCalls ?? []) lines.push(`[tool:${tc.name}] ${truncateForExport(tc)}`);
        if (tr.agentText) lines.push(`[assistant] ${tr.agentText}`);
      }
      lines.push("");
    }
    const txt = lines.join("\n");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(
        () => showToast(t("memories.copy.done", { n: selectedGroupCount })),
        () => showToast("Copy failed", "error"),
      );
    } else {
      showToast("Clipboard unavailable", "error");
    }
  };

  /**
   * Delete a whole displayed card — i.e. every L1 trace produced by
   * the same user message. We POST the full id list to the bulk
   * endpoint so partial failures don't leave an orphan group on
   * screen.
   */
  const deleteGroup = async (g: MemoryGroup) => {
    if (!confirm(t("memories.delete.confirm"))) return;
    try {
      if (g.ids.length === 1) {
        await api.del(`/api/v1/traces/${encodeURIComponent(g.ids[0]!)}`);
      } else {
        await api.post<{ deleted: number }>(`/api/v1/traces/delete`, { ids: g.ids });
      }
      await loadPage({ q: query.trim(), page });
      setSelected((prev) => {
        const n = new Set(prev);
        for (const id of g.ids) n.delete(id);
        return n;
      });
      if (detail?.turnKey === g.turnKey) setDetail(null);
      showToast(t("memories.delete.done"));
    } catch {
      showToast("Failed", "error");
    }
  };

  /**
   * The edit modal targets the **head trace** of the group — that's
   * the only row that carries `userText` / `summary` / tags (sub-steps
   * have empty user text by construction, see `step-extractor`).
   * Tool inputs / outputs are immutable.
   */
  const saveEdit = async (
    id: string,
    patch: {
      summary?: string | null;
      userText?: string;
      agentText?: string;
      tags?: string[];
    },
  ) => {
    try {
      const updated = await api.patch<TraceDTO>(
        `/api/v1/traces/${encodeURIComponent(id)}`,
        patch,
      );
      setTraces((prev) => prev.map((x) => (x.id === id ? updated : x)));
      setDetail((prev) =>
        prev ? rebuildGroupAfterTracePatch(prev, updated) : prev,
      );
      showToast(t("memories.edit.saved"));
    } catch {
      showToast("Failed", "error");
    }
  };

  /**
   * Share applies to every trace in the group — they belong to the
   * same user turn and should always be public/private together.
   */
  const applyShareGroup = async (
    g: MemoryGroup,
    scope: "private" | "public" | "hub" | null,
  ) => {
    try {
      const updates = await Promise.all(
        g.ids.map((id) =>
          api
            .post<TraceDTO>(`/api/v1/traces/${encodeURIComponent(id)}/share`, { scope })
            .catch(() => null),
        ),
      );
      const next = traces.map((x) => {
        const replacement = updates.find((u) => u && u.id === x.id);
        return replacement ?? x;
      });
      setTraces(next);
      setDetail((prev) => {
        if (!prev || prev.turnKey !== g.turnKey) return prev;
        const fresh = buildGroups(next).find((x) => x.turnKey === g.turnKey);
        return fresh ?? prev;
      });
      showToast(scope ? t("memories.share.done") : t("memories.share.removed"));
    } catch {
      showToast("Failed", "error");
    }
  };

  return (
    <>
      <div class="view-header">
        <div class="view-header__title">
          <h1>{t("memories.title")}</h1>
          <p>{t("memories.subtitle")}</p>
        </div>
        <div class="view-header__actions">
          <button
            class="btn btn--ghost btn--sm"
            onClick={() => {
              setQuery("");
              setSelected(new Set());
              void loadPage({ q: "", page: 0 });
            }}
          >
            <Icon name="refresh-cw" size={14} />
            {t("common.refresh")}
          </button>
        </div>
      </div>

      {/* Row 1: search */}
      <div class="toolbar">
        <label class="input-search">
          <Icon name="search" size={16} />
          <input
            class="input input--search"
            type="search"
            placeholder={t("memories.search.placeholder")}
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
        </label>
      </div>

      {/*
       * Batch-bar is positioned `fixed` to the bottom of the viewport
       * via its `.batch-bar` class so it stays visible even when the
       * user scrolls the list. The `padding-bottom` on the main
       * content area is adjusted below so the floating bar never
       * covers the pager.
       */}
      {selected.size > 0 && (
        <div class="batch-bar" role="region" aria-label="bulk actions">
          <span class="batch-bar__count">
            {t("common.selected", { n: selectedGroupCount })}
          </span>
          <button class="btn btn--sm" onClick={selectPage}>
            <Icon name="check-square" size={14} />
            {t("memories.bulk.selectPage")}
          </button>
          <button class="btn btn--sm" onClick={() => bulkShare("public")}>
            <Icon name="share" size={14} />
            {t("memories.bulk.share")}
          </button>
          <button class="btn btn--sm" onClick={() => bulkShare(null)}>
            <Icon name="x" size={14} />
            {t("memories.bulk.unshare")}
          </button>
          <button class="btn btn--sm" onClick={bulkExport}>
            <Icon name="copy" size={14} />
            {t("memories.bulk.export")}
          </button>
          <button class="btn btn--danger btn--sm" onClick={bulkDelete}>
            <Icon name="trash-2" size={14} />
            {t("memories.bulk.delete")}
          </button>
          <div class="batch-bar__spacer" />
          <button class="btn btn--ghost btn--sm" onClick={deselectAll}>
            {t("memories.bulk.deselect")}
          </button>
        </div>
      )}

      {loading && groups.length === 0 && (
        <div class="list">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} class="skeleton" style="height:82px" />
          ))}
        </div>
      )}

      {!loading && groups.length === 0 && (
        <div class="empty">
          <div class="empty__icon">
            <Icon name="brain-circuit" size={22} />
          </div>
          <div class="empty__title">{t("memories.empty")}</div>
          <div class="empty__hint">{t("memories.empty.hint")}</div>
        </div>
      )}

      {groups.length > 0 && (
        <div class="list">
          {groups.map((g) => {
            const isSel = isGroupSelected(g);
            const line = pickSummary(g.head);
            const scope = g.scope;
            const stepLabel =
              g.traces.length > 1
                ? t("memories.card.steps", { n: g.traces.length })
                : null;
            return (
              <div
                key={g.turnKey}
                class={`mem-card${isSel ? " mem-card--selected" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => setDetail(g)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setDetail(g);
                  }
                }}
              >
                <label
                  class="mem-card__check-wrap"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    class="mem-card__check"
                    checked={isSel}
                    onChange={() => toggleGroupSel(g)}
                    aria-label="select"
                  />
                </label>
                <div class="mem-card__body">
                  <div class="mem-card__title">{line}</div>
                  <div class="mem-card__meta">
                    <span class={`pill pill--share-${scope}`}>
                      {t(`memories.share.scope.${scope}` as never).split(" (")[0]}
                    </span>
                    <span>{formatTs(g.ts)}</span>
                    <span class="mono">
                      V {g.aggValue.toFixed(2)} · α {g.aggAlpha.toFixed(2)}
                    </span>
                    {g.toolCount > 0 && (
                      <span class="pill pill--info" title={g.toolNames.join(", ")}>
                        <Icon name="cable" size={12} />
                        {summarizeToolNames(g.head.toolCalls?.length ? g.head.toolCalls : flattenToolCallList(g))}
                      </span>
                    )}
                    {stepLabel && (
                      <span class="pill pill--info" title={stepLabel}>
                        <Icon name="layers" size={12} />
                        {stepLabel}
                      </span>
                    )}
                    {g.hasReflection && (
                      <span class="pill pill--thinking">
                        <Icon name="sparkles" size={12} />
                        {t("memories.card.reflection")}
                      </span>
                    )}
                  </div>
                </div>
                <div class="mem-card__tail">
                  <Icon name="chevron-right" size={16} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Pager */}
      {(page > 0 || hasMore) && (
        <div class="pager">
          <button
            class="btn btn--ghost btn--sm"
            disabled={page === 0 || loading}
            onClick={() => void loadPage({ q: query.trim(), page: page - 1 })}
          >
            <Icon name="chevron-left" size={14} />
            {t("common.prev")}
          </button>
          <span class="pager__info">
            {t("pager.pageOfTotal", {
              n: page + 1,
              total: Math.max(1, Math.ceil(total / PAGE_SIZE)),
            })}
          </span>
          <button
            class="btn btn--ghost btn--sm"
            disabled={!hasMore || loading}
            onClick={() => void loadPage({ q: query.trim(), page: page + 1 })}
          >
            {t("common.next")}
            <Icon name="chevron-right" size={14} />
          </button>
        </div>
      )}

      {detail && (
        <TraceDrawer
          group={detail}
          onClose={() => setDetail(null)}
          onSave={saveEdit}
          onShare={(scope) => applyShareGroup(detail, scope)}
          onDelete={() => deleteGroup(detail)}
        />
      )}

      {toast && (
        <div class="toast-stack">
          <div class={`toast toast--${toast.kind}`}>{toast.msg}</div>
        </div>
      )}
    </>
  );
}

// ─── helpers ─────────────────────────────────────────────────────────────

function pickSummary(trace: TraceDTO): string {
  const s = (trace.summary ?? "").trim();
  if (s) return s;
  const u = (trace.userText ?? "").replace(/\s+/g, " ").trim();
  if (u) return u.length > 180 ? u.slice(0, 177) + "…" : u;
  const a = (trace.agentText ?? "").replace(/\s+/g, " ").trim();
  if (a) return a.length > 180 ? a.slice(0, 177) + "…" : a;
  return "(empty trace)";
}

/**
 * Cursor-style tool-call card shown inside the memory drawer. Mirrors
 * the bubble used by `tasks-chat.tsx::ToolBubble` so a tool invocation
 * looks the same whether the user is browsing per-step memories or the
 * whole-task conversation log:
 *
 *   ┌─ T ▸ tool_name           [ok] 24ms ────────────┐
 *   │ ▸ Input                                         │
 *   │   { … }                                         │
 *   │ ▸ Output                                        │
 *   │   { … }                                         │
 *   └─────────────────────────────────────────────────┘
 *
 * Clicking each Input / Output line expands the raw payload via a
 * native `<details>` element — no extra state, no overflowing the
 * drawer height when the trace contains a 50 KB stdout dump.
 */
function ToolCallCard({
  call,
}: {
  call: {
    name: string;
    input?: unknown;
    output?: unknown;
    errorCode?: string;
    startedAt: number;
    endedAt: number;
  };
}) {
  const inputStr = formatToolPayload(call.input);
  const outputStr = formatToolPayload(call.output);
  const dur =
    call.endedAt > call.startedAt ? call.endedAt - call.startedAt : null;
  const errored = !!call.errorCode;
  return (
    <div
      class={`chat-item__bubble chat-item__bubble--tool${
        errored ? " chat-item__bubble--error" : ""
      }`}
    >
      <div class="chat-item__tool-header">
        <Icon name="cable" size={14} />
        <span class="chat-item__tool-name mono">{call.name}</span>
        {errored ? (
          <span class="pill pill--failed">{call.errorCode}</span>
        ) : (
          <span class="pill pill--active">{t("tasks.chat.tool.ok")}</span>
        )}
        {dur != null && <span class="muted mono">{dur}ms</span>}
      </div>
      {inputStr && (
        <details class="chat-item__tool-section">
          <summary class="chat-item__tool-summary">
            <Icon name="chevron-right" size={12} />
            <span class="chat-item__tool-label">
              {t("tasks.chat.tool.input")}
            </span>
          </summary>
          <pre class="chat-item__tool-pre">{clipPayload(inputStr, 4000)}</pre>
        </details>
      )}
      {outputStr && (
        <details class="chat-item__tool-section" open={errored}>
          <summary class="chat-item__tool-summary">
            <Icon name="chevron-right" size={12} />
            <span class="chat-item__tool-label">
              {t("tasks.chat.tool.output")}
            </span>
          </summary>
          <pre class="chat-item__tool-pre">{clipPayload(outputStr, 6000)}</pre>
        </details>
      )}
      {!inputStr && !outputStr && !errored && (
        <div class="chat-item__tool-empty">
          {t("tasks.chat.tool.noPayload")}
        </div>
      )}
    </div>
  );
}

function formatToolPayload(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function clipPayload(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * Render a compact "tool name pill" for the memory card meta line.
 * Surfaces what the agent actually called instead of just the count, so
 * the user can recognise at a glance which step did `bash`, which did
 * `read_file`, etc. Mirrors the way Cursor's run-history rows badge
 * recent tool invocations.
 */
function summarizeToolNames(
  calls: ReadonlyArray<{ name: string }>,
): string {
  if (calls.length === 0) return "";
  const unique = Array.from(new Set(calls.map((c) => c.name)));
  if (unique.length === 1) {
    return calls.length === 1
      ? unique[0]!
      : `${unique[0]} ×${calls.length}`;
  }
  if (unique.length <= 2) return unique.join(", ");
  return `${unique.slice(0, 2).join(", ")} +${unique.length - 2}`;
}

/**
 * Bucket the page's traces by `(episodeId, turnId)`. Within each
 * bucket, sort sub-steps by `ts ascending` and pick the first row
 * with a non-empty `userText` as the head — the `step-extractor`
 * guarantees this is the first sub-step (`subStepIdx === 0`), but we
 * fall back to "earliest by ts" so legacy rows still group cleanly.
 *
 * Aggregates exposed on the card:
 *   - `aggValue` / `aggAlpha`: arithmetic mean across members. Plain
 *     mean keeps the card honest about "how was the whole turn?";
 *     per-step values are still visible in the drawer.
 *   - `toolCount` / `toolNames`: union of every member's `toolCalls`.
 *   - `scope`: take the head's share state (siblings always share the
 *     same scope thanks to `applyShareGroup`).
 */
function buildGroups(traces: readonly TraceDTO[]): MemoryGroup[] {
  const buckets = new Map<string, TraceDTO[]>();
  const order: string[] = [];
  for (const tr of traces) {
    const key = groupKey(tr);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
      order.push(key);
    }
    bucket.push(tr);
  }
  return order.map((key) => {
    const bucket = buckets.get(key)!;
    bucket.sort((a, b) => a.ts - b.ts);
    const head =
      bucket.find((t) => (t.userText ?? "").trim().length > 0) ?? bucket[0]!;
    const tools = bucket.flatMap((t) => t.toolCalls ?? []);
    const ids = bucket.map((t) => t.id);
    const sumV = bucket.reduce((acc, t) => acc + (t.value ?? 0), 0);
    const sumA = bucket.reduce((acc, t) => acc + (t.alpha ?? 0), 0);
    const scope: "private" | "public" | "hub" = head.share?.scope ?? "private";
    return {
      turnKey: key,
      episodeId: head.episodeId ?? null,
      ts: bucket[0]!.ts,
      head,
      traces: bucket,
      ids,
      toolCount: tools.length,
      toolNames: Array.from(new Set(tools.map((tc) => tc.name))),
      aggValue: bucket.length === 0 ? 0 : sumV / bucket.length,
      aggAlpha: bucket.length === 0 ? 0 : sumA / bucket.length,
      hasReflection: bucket.some((t) => Boolean((t.reflection ?? "").trim())),
      scope,
      shared: scope !== "private",
    };
  });
}

function groupKey(tr: TraceDTO): string {
  // `turnId` is the stable key stamped by `step-extractor` — every
  // sub-step from the same user message shares it. Pair with episodeId
  // because turnId is just a ts (could repeat across episodes).
  return `${tr.episodeId ?? "_"}:${tr.turnId}`;
}

function flattenToolCallList(g: MemoryGroup): { name: string }[] {
  return g.traces.flatMap((t) => t.toolCalls ?? []);
}

function truncateForExport(tc: { input?: unknown; output?: unknown; errorCode?: string }): string {
  if (tc.errorCode) return `ERROR[${tc.errorCode}]`;
  const out = tc.output;
  if (out == null) return "(no output)";
  if (typeof out === "string") return out.slice(0, 200);
  try {
    return JSON.stringify(out).slice(0, 200);
  } catch {
    return String(out).slice(0, 200);
  }
}

/**
 * After the edit modal patches the head trace, rebuild the open
 * group so the drawer reflects the new userText / summary / tags
 * without a round-trip refetch.
 */
function rebuildGroupAfterTracePatch(prev: MemoryGroup, updated: TraceDTO): MemoryGroup {
  const traces = prev.traces.map((t) => (t.id === updated.id ? updated : t));
  const head =
    traces.find((t) => (t.userText ?? "").trim().length > 0) ?? traces[0]!;
  return { ...prev, traces, head };
}

function formatTs(ts: number): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

// ─── Right-side drawer ───────────────────────────────────────────────────

/**
 * Right-side drawer for one **MemoryGroup** (= one user turn).
 *
 * The drawer's job is two-fold:
 *   1. Show the user-facing meta the card already hinted at (timestamp,
 *      aggregate V/α, share state, optional tags) plus the head's
 *      summary + user query, so the row → detail transition feels
 *      continuous.
 *   2. Surface the full step list — every L1 trace produced from this
 *      turn — as collapsible sections so users can drill into per-step
 *      value/α/reflection without leaving the "one round = one memory"
 *      mental model. The first step (head) is expanded by default.
 *
 * Edit and share intentionally diverge in scope:
 *   - **Edit** patches the head trace only — that's the row that
 *     carries `userText` / `summary` / `tags`. Sub-steps have empty
 *     user text by construction (`step-extractor` only stamps the
 *     query onto the first sub-step) and their tool inputs/outputs
 *     are immutable.
 *   - **Share** flips every member of the group to the same scope so
 *     "this turn is public" stays a coherent mental model.
 *   - **Delete** wipes every member id so the card never half-disappears.
 */
function TraceDrawer({
  group,
  onClose,
  onSave,
  onShare,
  onDelete,
}: {
  group: MemoryGroup;
  onClose: () => void;
  onSave: (
    id: string,
    patch: {
      summary?: string | null;
      userText?: string;
      agentText?: string;
      tags?: string[];
    },
  ) => Promise<void> | void;
  onShare: (scope: "private" | "public" | "hub" | null) => Promise<void> | void;
  onDelete: () => Promise<void> | void;
}) {
  const head = group.head;
  const [mode, setMode] = useState<"view" | "edit" | "share">("view");
  const [summary, setSummary] = useState(head.summary ?? "");
  const [userText, setUserText] = useState(head.userText ?? "");
  const [agentText, setAgentText] = useState(head.agentText ?? "");
  const [tags, setTags] = useState((head.tags ?? []).join(", "));
  const [scope, setScope] = useState<"private" | "public" | "hub">(
    head.share?.scope ?? "public",
  );

  useEffect(() => {
    setSummary(head.summary ?? "");
    setUserText(head.userText ?? "");
    setAgentText(head.agentText ?? "");
    setTags((head.tags ?? []).join(", "));
    setScope(head.share?.scope ?? "public");
  }, [head]);

  const title = pickSummary(head).slice(0, 100) || t("memories.detail.fallbackTitle");

  const submitEdit = () => {
    void onSave(head.id, {
      summary: summary.trim() ? summary.trim() : null,
      userText,
      agentText,
      tags: tags
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean),
    });
    setMode("view");
  };

  const submitShare = (s: "private" | "public" | "hub" | null) => {
    void onShare(s);
    setMode("view");
  };

  return (
    <div class="drawer-backdrop" onClick={onClose}>
      <aside class="drawer" role="dialog" onClick={(e) => e.stopPropagation()}>
        <header class="drawer__header">
          <div style="min-width:0">
            <div class="muted" style="font-size:var(--fs-xs);margin-bottom:2px">
              {group.episodeId
                ? t("memories.detail.fromTask", { id: group.episodeId.slice(0, 10) })
                : t("memories.detail.oneMemory")}
            </div>
            <h2 class="drawer__title truncate">{title}</h2>
          </div>
          <button class="btn btn--ghost btn--icon" onClick={onClose} aria-label={t("common.close")}>
            <Icon name="x" size={16} />
          </button>
        </header>

        <div class="drawer__body">
          {mode === "view" && (
            <>
              <section class="card card--flat">
                <h3 class="card__title" style="font-size:var(--fs-md)">
                  {t("tasks.detail.meta")}
                </h3>
                <dl style="display:grid;grid-template-columns:160px 1fr;gap:6px 16px;margin:0;font-size:var(--fs-sm)">
                  <dt class="muted">{t("memories.field.ts")}</dt>
                  <dd>{group.ts ? new Date(group.ts).toLocaleString() : "—"}</dd>
                  <dt class="muted">{t("memories.field.value")}</dt>
                  <dd>{group.aggValue.toFixed(3)}</dd>
                  <dt class="muted">{t("memories.field.alpha")}</dt>
                  <dd>{group.aggAlpha.toFixed(3)}</dd>
                  {head.rHuman != null && (
                    <>
                      <dt class="muted">{t("memories.field.rHuman")}</dt>
                      <dd>{head.rHuman.toFixed(3)}</dd>
                    </>
                  )}
                  <dt class="muted">{t("memories.field.priority")}</dt>
                  <dd>{head.priority.toFixed(3)}</dd>
                  <dt class="muted">{t("memories.field.share")}</dt>
                  <dd>
                    <span class={`pill pill--share-${group.scope}`}>{group.scope}</span>
                  </dd>
                  {head.tags && head.tags.length > 0 && (
                    <>
                      <dt class="muted">tags</dt>
                      <dd>
                        {head.tags.map((tg) => (
                          <span key={tg} class="pill pill--info" style="margin-right:4px">
                            {tg}
                          </span>
                        ))}
                      </dd>
                    </>
                  )}
                </dl>
              </section>

              {head.summary && (
                <section class="card card--flat">
                  <div class="muted" style="font-size:var(--fs-xs);margin-bottom:4px">
                    {t("memories.field.summary")}
                  </div>
                  <div style="font-size:var(--fs-sm);line-height:1.55">{head.summary}</div>
                </section>
              )}

              {head.userText && (
                <section class="card card--flat">
                  <div class="muted" style="font-size:var(--fs-xs);margin-bottom:4px">
                    {t("memories.field.user")}
                  </div>
                  <pre class="mono" style="white-space:pre-wrap;font-size:var(--fs-sm);margin:0">
                    {head.userText}
                  </pre>
                </section>
              )}

              <StepList traces={group.traces} />
            </>
          )}

          {mode === "edit" && (
            <>
              <section class="card card--flat">
                <div class="modal__field">
                  <label>{t("memories.edit.summary")}</label>
                  <input
                    class="input"
                    value={summary}
                    onInput={(e) => setSummary((e.target as HTMLInputElement).value)}
                    placeholder="Short memory line…"
                  />
                </div>
              </section>
              <section class="card card--flat">
                <div class="modal__field">
                  <label>{t("memories.edit.user")}</label>
                  <textarea
                    class="textarea"
                    rows={3}
                    value={userText}
                    onInput={(e) => setUserText((e.target as HTMLTextAreaElement).value)}
                  />
                </div>
              </section>
              <section class="card card--flat">
                <div class="modal__field">
                  <label>{t("memories.edit.assistant")}</label>
                  <textarea
                    class="textarea"
                    rows={4}
                    value={agentText}
                    onInput={(e) => setAgentText((e.target as HTMLTextAreaElement).value)}
                  />
                </div>
              </section>
              <section class="card card--flat">
                <div class="modal__field">
                  <label>{t("memories.edit.tags")}</label>
                  <input
                    class="input"
                    value={tags}
                    onInput={(e) => setTags((e.target as HTMLInputElement).value)}
                    placeholder="docker, debug"
                  />
                </div>
              </section>
            </>
          )}

          {mode === "share" && (
            <section class="card card--flat">
              <div class="modal__field">
                <label>{t("memories.share.scope")}</label>
                <div class="vstack" style="gap:var(--sp-2)">
                  {(["private", "public", "hub"] as const).map((v) => (
                    <label
                      key={v}
                      class="hstack"
                      style="gap:var(--sp-2);cursor:pointer;padding:6px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-canvas)"
                    >
                      <input
                        type="radio"
                        name="share-scope"
                        checked={scope === v}
                        onChange={() => setScope(v)}
                      />
                      <span>{t(`memories.share.scope.${v}` as never)}</span>
                    </label>
                  ))}
                </div>
              </div>
            </section>
          )}
        </div>

        <footer class="drawer__footer">
          {mode === "view" && (
            <>
              <button class="btn btn--danger btn--sm" onClick={() => onDelete()}>
                <Icon name="trash-2" size={14} />
                {t("memories.act.delete")}
              </button>
              <div class="batch-bar__spacer" />
              <button class="btn btn--sm" onClick={() => setMode("share")}>
                <Icon name="share" size={14} />
                {group.shared ? t("memories.act.unshare") : t("memories.act.share")}
              </button>
              <button class="btn btn--primary btn--sm" onClick={() => setMode("edit")}>
                <Icon name="pencil" size={14} />
                {t("memories.act.edit")}
              </button>
            </>
          )}
          {mode === "edit" && (
            <>
              <button class="btn btn--ghost btn--sm" onClick={() => setMode("view")}>
                {t("common.cancel")}
              </button>
              <div class="batch-bar__spacer" />
              <button class="btn btn--primary btn--sm" onClick={submitEdit}>
                <Icon name="check" size={14} />
                {t("common.save")}
              </button>
            </>
          )}
          {mode === "share" && (
            <>
              {group.shared && (
                <button
                  class="btn btn--danger btn--sm"
                  onClick={() => submitShare(null)}
                >
                  <Icon name="trash-2" size={14} />
                  {t("memories.act.unshare")}
                </button>
              )}
              <div class="batch-bar__spacer" />
              <button class="btn btn--ghost btn--sm" onClick={() => setMode("view")}>
                {t("common.cancel")}
              </button>
              <button class="btn btn--primary btn--sm" onClick={() => submitShare(scope)}>
                <Icon name="share" size={14} />
                {t("memories.act.share")}
              </button>
            </>
          )}
        </footer>
      </aside>
    </div>
  );
}

/**
 * Renders every L1 trace in a group as a vertical list of
 * `<details>` blocks. Each block:
 *   - heading: step number, role pill (tool / assistant), per-step
 *     V/α (so the user can audit credit assignment)
 *   - body: the step's `agentThinking`, `agentText`, `reflection`,
 *     and any `toolCalls` rendered through the existing
 *     `ToolCallCard`. Empty fields collapse silently.
 *
 * The first step is open by default; the rest start collapsed so the
 * drawer doesn't drown the user when a turn fired a dozen tools.
 */
function StepList({ traces }: { traces: readonly TraceDTO[] }) {
  return (
    <section class="card card--flat">
      <h3 class="card__title" style="font-size:var(--fs-md);margin-bottom:var(--sp-3)">
        {t("memories.field.steps", { n: traces.length })}
      </h3>
      <div class="vstack" style="gap:var(--sp-2)">
        {traces.map((tr, idx) => {
          const tools = tr.toolCalls ?? [];
          const role = tools.length > 0 ? "tool" : "assistant";
          const roleLabel = t(`memories.filter.role.${role}` as never);
          const summary = stepHeadline(tr);
          return (
            <details
              key={tr.id}
              open={idx === 0}
              class="card card--flat"
              style="padding:var(--sp-2) var(--sp-3)"
            >
              <summary
                class="hstack"
                style="cursor:pointer;gap:var(--sp-2);align-items:center;flex-wrap:wrap"
              >
                <span class="muted mono" style="font-size:var(--fs-xs)">
                  #{idx + 1}
                </span>
                <span class={`pill pill--role-${role}`}>{roleLabel}</span>
                <span class="mono muted" style="font-size:var(--fs-xs)">
                  {new Date(tr.ts).toLocaleTimeString()}
                </span>
                <span class="mono muted" style="font-size:var(--fs-xs)">
                  V {tr.value.toFixed(2)} · α {tr.alpha.toFixed(2)}
                </span>
                <span class="truncate" style="flex:1;min-width:0;font-size:var(--fs-sm)">
                  {summary}
                </span>
              </summary>
              <div class="vstack" style="gap:var(--sp-3);margin-top:var(--sp-3)">
                {tr.agentThinking && (
                  <div>
                    <div class="muted" style="font-size:var(--fs-xs);margin-bottom:4px">
                      {t("tasks.chat.role.thinking")}
                    </div>
                    <pre class="mono" style="white-space:pre-wrap;font-size:var(--fs-sm);margin:0">
                      {tr.agentThinking}
                    </pre>
                  </div>
                )}
                {tools.length > 0 && (
                  <div class="vstack" style="gap:var(--sp-2)">
                    {tools.map((tc, i) => (
                      <ToolCallCard key={i} call={tc} />
                    ))}
                  </div>
                )}
                {tr.agentText && (
                  <div>
                    <div class="muted" style="font-size:var(--fs-xs);margin-bottom:4px">
                      {t("memories.field.assistant")}
                    </div>
                    <pre class="mono" style="white-space:pre-wrap;font-size:var(--fs-sm);margin:0">
                      {tr.agentText}
                    </pre>
                  </div>
                )}
                {tr.reflection && (
                  <div>
                    <div class="muted" style="font-size:var(--fs-xs);margin-bottom:4px">
                      {t("memories.field.takeaway")}
                    </div>
                    <pre class="mono" style="white-space:pre-wrap;font-size:var(--fs-sm);margin:0">
                      {tr.reflection}
                    </pre>
                  </div>
                )}
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}

function stepHeadline(tr: TraceDTO): string {
  const tools = tr.toolCalls ?? [];
  if (tools.length > 0) return tools.map((tc) => tc.name).join(" · ");
  const a = (tr.agentText ?? "").trim().replace(/\s+/g, " ");
  if (a) return a.length > 80 ? a.slice(0, 77) + "…" : a;
  const u = (tr.userText ?? "").trim().replace(/\s+/g, " ");
  if (u) return u.length > 80 ? u.slice(0, 77) + "…" : u;
  return "(empty step)";
}
