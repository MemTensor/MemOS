/**
 * Tasks view — episode-level browsing.
 *
 * In the Reflect2Evolve core, a "task" is an episode (one user query
 * with its full response arc). We expose it under the Tasks label
 * because end users think in tasks, not episodes. The row list pulls
 * from `/api/v1/episodes`; the detail drawer pulls
 * `/api/v1/episodes/:id/timeline`.
 */
import { useEffect, useState } from "preact/hooks";
import { api } from "../api/client";
import { t } from "../stores/i18n";
import { Icon } from "../components/Icon";
import { Pager } from "../components/Pager";
import { route } from "../stores/router";
import { clearEntryId, linkTo } from "../stores/cross-link";
import { ChatLog, flattenChat, type TimelineTrace } from "./tasks-chat";
import { areAllIdsSelected, toggleIdsInSelection } from "../utils/selection";

type TaskStatus = "" | "active" | "completed" | "skipped" | "failed";

interface EpisodeRow {
  id: string;
  sessionId: string;
  startedAt: number;
  endedAt?: number;
  status: "open" | "closed";
  rTask?: number | null;
  turnCount?: number;
  preview?: string;
  tags?: string[];
  skillStatus?:
    | "queued"
    | "generating"
    | "generated"
    | "upgraded"
    | "not_generated"
    | "skipped"
    | null;
  skillReason?: string | null;
  skillReasonKey?: string | null;
  skillReasonParams?: Record<string, string> | null;
  linkedSkillId?: string | null;
  closeReason?: "finalized" | "abandoned" | null;
  topicState?: "active" | "paused" | "interrupted" | "ended" | null;
  pauseReason?: string | null;
  abandonReason?: string | null;
  rewardSkipped?: boolean;
  rewardReason?: string | null;
  hasAssistantReply?: boolean;
}

interface Timeline {
  episodeId: string;
  traces: TimelineTrace[];
}

interface EpisodeListResponse {
  episodes: EpisodeRow[];
  nextOffset?: number;
  total?: number;
}

const DEFAULT_PAGE_SIZE = 20;

export function TasksView() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<TaskStatus>("");
  const [rows, setRows] = useState<EpisodeRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [detail, setDetail] = useState<EpisodeRow | null>(null);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleSel = (id: string) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const loadPage = (nextPage: number) => {
    const ctrl = new AbortController();
    setLoading(true);
    const qs = new URLSearchParams();
    qs.set("limit", String(pageSize));
    qs.set("offset", String(nextPage * pageSize));
    api
      .get<EpisodeListResponse>(
        `/api/v1/episodes?${qs.toString()}`,
        { signal: ctrl.signal },
      )
      .then((r) => {
        setRows(r.episodes ?? []);
        setHasMore(r.nextOffset != null);
        setTotal(r.total ?? 0);
        setPage(nextPage);
      })
      .catch(() => {
        setRows([]);
        setHasMore(false);
        setTotal(0);
      })
      .finally(() => setLoading(false));
    return ctrl;
  };

  useEffect(() => {
    if (route.value.params.id) return;
    const ctrl = loadPage(0);
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageSize, route.value.params.id]);

  useEffect(() => {
    const id = route.value.params.id;
    if (!id) return;
    const ctrl = new AbortController();
    void openLinkedEpisode(id, ctrl.signal);
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.value.params.id, pageSize]);

  const openLinkedEpisode = async (id: string, signal: AbortSignal) => {
    setQuery("");
    setStatus("");
    setLoading(true);
    try {
      const pageSizeForLookup = pageSize;
      const targetPage = await findEpisodePage(id, pageSizeForLookup, signal);
      const qs = new URLSearchParams();
      qs.set("limit", String(pageSizeForLookup));
      qs.set("offset", String(targetPage * pageSizeForLookup));
      const res = await api.get<EpisodeListResponse>(
        `/api/v1/episodes?${qs.toString()}`,
        { signal },
      );
      const nextRows = res.episodes ?? [];
      setRows(nextRows);
      setHasMore(res.nextOffset != null);
      setTotal(res.total ?? 0);
      setPage(targetPage);
      const match = nextRows.find((r) => r.id === id);
      if (match) setDetail(match);
    } catch {
      // Ignore aborted or stale deep links; the list stays as-is.
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    if (!detail) {
      setTimeline(null);
      return;
    }
    const ctrl = new AbortController();
    api
      .get<Timeline>(`/api/v1/episodes/${encodeURIComponent(detail.id)}/timeline`, {
        signal: ctrl.signal,
      })
      .then(setTimeline)
      .catch(() => setTimeline(null));
    return () => ctrl.abort();
  }, [detail?.id]);

  const filtered = (rows ?? []).filter((r) => {
    if (query) {
      const q = query.toLowerCase();
      const hay = `${r.preview ?? ""} ${r.id}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (status) {
      const derived = deriveStatus(r);
      if (derived !== status) return false;
    }
    return true;
  });
  const pageIds = filtered.map((r) => r.id);
  const isPageSelected = areAllIdsSelected(selected, pageIds);

  const togglePageSelection = () => {
    setSelected((prev) => toggleIdsInSelection(prev, pageIds));
  };
  const deselectAll = () => setSelected(new Set());
  const bulkDelete = async () => {
    if (selected.size === 0) return;
    if (!confirm(t("common.bulkDelete.confirm", { n: selected.size }))) return;
    const ids = [...selected];
    await Promise.all(
      ids.map((id) =>
        api
          .del(`/api/v1/episodes?episodeId=${encodeURIComponent(id)}`)
          .catch(() => null),
      ),
    );
    setSelected(new Set());
    loadPage(page);
  };

  return (
    <>
      <div class="view-header">
        <div class="view-header__title">
          <h1>{t("tasks.title")}</h1>
          <p>{t("tasks.subtitle")}</p>
        </div>
        <div class="view-header__actions">
          {/*
           * Refresh — same affordance MemoriesView exposes. Clears the
           * search + status filter, drops any multi-select, and reloads
           * page 0 so the user can instantly see the freshest task list
           * after the agent produced a new episode in the background.
           */}
          <button
            class="btn btn--ghost btn--sm"
            onClick={() => {
              setQuery("");
              setStatus("");
              setSelected(new Set());
              loadPage(0);
            }}
          >
            <Icon name="refresh-cw" size={14} />
            {t("common.refresh")}
          </button>
        </div>
      </div>

      <div class="toolbar">
        <label class="input-search">
          <Icon name="search" size={16} />
          <input
            class="input input--search"
            type="search"
            placeholder={t("tasks.search.placeholder")}
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
        </label>
      </div>

      <div class="toolbar" style="margin-top:calc(-1 * var(--sp-2))">
        <div class="toolbar__group" role="group" aria-label={t("common.filter")}>
          {[
            { v: "" as TaskStatus, k: "common.all" as const },
            { v: "active" as TaskStatus, k: "status.active" as const },
            { v: "completed" as TaskStatus, k: "status.completed" as const },
            { v: "skipped" as TaskStatus, k: "status.skipped" as const },
            { v: "failed" as TaskStatus, k: "status.failed" as const },
          ].map((opt) => (
            <button
              key={opt.v}
              class="chip"
              aria-pressed={status === opt.v}
              onClick={() => setStatus(opt.v)}
            >
              {t(opt.k)}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div class="list">
          {[0, 1, 2].map((i) => (
            <div key={i} class="skeleton" style="height:62px" />
          ))}
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div class="empty">
          <div class="empty__icon">
            <Icon name="list-checks" size={22} />
          </div>
          <div class="empty__title">{t("tasks.empty")}</div>
        </div>
      )}

      {filtered.length > 0 && (
        <div class="list">
          {filtered.map((r) => {
            const isSel = selected.has(r.id);
            const taskStatus = deriveStatus(r);
            // Hide the "skill pipeline queued / generating" placeholder
            // for tasks that won't ever produce a skill anyway. A
            // skipped or failed task gets bounced out of the pipeline
            // before crystallization, so showing "等待中" / "生成中" is
            // misleading — the queue isn't actually advancing.
            const showSkillStatus =
              !!r.skillStatus &&
              !(
                (taskStatus === "skipped" || taskStatus === "failed") &&
                (r.skillStatus === "queued" || r.skillStatus === "generating")
              );
            return (
              <div
                key={r.id}
                class={`mem-card${isSel ? " mem-card--selected" : ""}`}
                onClick={() => setDetail(r)}
              >
                <label
                  class="mem-card__check-wrap"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    class="mem-card__check"
                    checked={isSel}
                    onChange={() => toggleSel(r.id)}
                    aria-label="select"
                  />
                </label>
                <div class="mem-card__body">
                  <div class="mem-card__title">
                    {r.preview || t("tasks.untitled")}
                  </div>
                  <div class="mem-card__meta">
                    <span class={`pill pill--${taskStatus}`}>
                      {t(`status.${taskStatus}` as "status.active")}
                    </span>
                    {showSkillStatus && (
                      <span
                        class={`pill pill--skill-${r.skillStatus}`}
                        title={r.skillReasonKey
                          ? t(r.skillReasonKey as any, r.skillReasonParams ?? undefined)
                          : r.skillReason ?? undefined}
                      >
                        {t(`tasks.skill.${r.skillStatus}` as never)}
                      </span>
                    )}
                    <span>{new Date(r.startedAt).toLocaleString()}</span>
                    {typeof r.turnCount === "number" && (
                      <span>{r.turnCount} turns</span>
                    )}
                    {r.rTask != null && <span>R {r.rTask.toFixed(2)}</span>}
                  </div>
                  {statusReason(r) && (
                    <div
                      class="muted"
                      style="font-size:var(--fs-xs);line-height:1.5"
                    >
                      {statusReason(r)}
                    </div>
                  )}
                </div>
                <div class="mem-card__tail">
                  <Icon name="chevron-right" size={16} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {(page > 0 || hasMore) && (
        <Pager
          page={page}
          totalItems={total}
          pageSize={pageSize}
          hasMore={hasMore}
          loading={loading}
          onPageSizeChange={setPageSize}
          onPageChange={(nextPage) => {
            loadPage(nextPage);
          }}
        />
      )}

      {detail && (
        <TaskDrawer
          episode={detail}
          timeline={timeline}
          onClose={() => {
            setDetail(null);
            clearEntryId();
          }}
        />
      )}

      {selected.size > 0 && (
        <div class="batch-bar" role="region" aria-label="bulk actions">
          <span class="batch-bar__count">
            {t("common.selected", { n: selected.size })}
          </span>
          <button class="btn btn--sm" onClick={togglePageSelection}>
            <Icon name="check-square" size={14} />
            {isPageSelected ? t("common.deselectPage") : t("common.selectPage")}
          </button>
          <button class="btn btn--danger btn--sm" onClick={bulkDelete}>
            <Icon name="trash-2" size={14} />
            {t("common.bulkDelete")}
          </button>
          <div class="batch-bar__spacer" />
          <button class="btn btn--ghost btn--sm" onClick={deselectAll}>
            {t("common.deselect")}
          </button>
        </div>
      )}
    </>
  );
}

async function findEpisodePage(
  id: string,
  pageSize: number,
  signal: AbortSignal,
): Promise<number> {
  const scanLimit = 5_000;
  let offset = 0;
  while (true) {
    const qs = new URLSearchParams();
    qs.set("shape", "ids");
    qs.set("limit", String(scanLimit));
    qs.set("offset", String(offset));
    const res = await api.get<{
      episodeIds: string[];
      nextOffset?: number;
    }>(`/api/v1/episodes?${qs.toString()}`, { signal });
    const index = (res.episodeIds ?? []).indexOf(id);
    if (index >= 0) return Math.floor((offset + index) / pageSize);
    if (res.nextOffset == null) return 0;
    offset = res.nextOffset;
  }
}

// Keep this in lockstep with `core/pipeline/memory-core.ts::deriveSkillStatus`:
// only a clearly-negative reward is shown as "failed / 反例". Slight
// negatives or below-threshold positives still read as "completed" in
// the task list — the soft-fail framing (未达沉淀阈值) lives on the
// skill pipeline pill, not the main task status.
const R_NEGATIVE_FLOOR = -0.5;

function deriveStatus(r: EpisodeRow): "active" | "completed" | "skipped" | "failed" {
  if (r.status === "open") return "active";
  // Recently-finalized grace window: the user may still be chatting.
  if (r.closeReason === "finalized" && r.endedAt) {
    const ageMs = Date.now() - r.endedAt;
    if (ageMs < 2 * 60 * 1000) return "active";
  }
  // Reward-scored episodes are classified by R_task regardless of how
  // they were closed (finalized or abandoned).
  if (r.rTask != null && r.rTask <= R_NEGATIVE_FLOOR) return "failed";
  if (r.rTask != null) return "completed";
  if (r.rewardSkipped) return "skipped";
  // If the skill pipeline produced a skill for this episode (via L2
  // policy linkage), the task contributed meaningful knowledge — show
  // "completed" even when rTask is null (e.g. plugin crashed after
  // skill generation but before rTask was persisted to the episode).
  if (r.skillStatus === "generated" || r.skillStatus === "upgraded") return "completed";
  if (r.closeReason === "abandoned") return "skipped";
  if ((r.turnCount ?? 0) >= 2) return "completed";
  return "skipped";
}

/**
 * Human-readable explanation for a non-active task status.
 *
 * Resolution order (most specific first):
 *   1. `abandonReason` from the pipeline (pre-localised).
 *   2. Explicit `closeReason === "abandoned"` without a specific
 *      `abandonReason` — e.g. relation classifier closed the old
 *      session via `new_task` and the pipeline is waiting for a
 *      future turn.
 *   3. Reward skip reason from the reward pipeline (tool-heavy,
 *      trivial, too short, etc.) — authoritative when present.
 *   4. `hasAssistantReply === false` — the user turn landed but the
 *      assistant turn never arrived. This is almost always a bridge /
 *      host issue, *not* a "too brief to summarize" problem.
 *   5. `rTask == null` — reward pipeline hasn't scored it yet or the
 *      LLM scorer failed silently.
 *   6. `failed` branch — R_task < 0.
 *   7. Generic fallback.
 */
function statusReason(r: EpisodeRow): string | null {
  const s = deriveStatus(r);
  if (s === "active") {
    if (r.topicState === "interrupted") return t("tasks.active.reason.interrupted" as any);
    if (r.topicState === "paused") return t("tasks.active.reason.paused" as any);
    return null;
  }
  if (s === "completed") return null;

  if (r.abandonReason && r.abandonReason.trim().length > 0) {
    if (r.abandonReason.includes("插件上次未正常退出")) {
      return t("tasks.abandonReason.uncleanExit" as any);
    }
    return r.abandonReason;
  }

  if (s === "skipped") {
    if (r.closeReason === "abandoned") {
      return t("tasks.skip.reason.abandoned");
    }
    if (r.rewardReason && r.rewardReason.trim().length > 0) {
      return r.rewardReason;
    }
    if (r.hasAssistantReply === false) {
      return t("tasks.skip.reason.noAssistant");
    }
    if (r.rTask == null) {
      return t("tasks.skip.reason.rewardPending");
    }
    return t("tasks.skip.reason.default");
  }

  if (s === "failed") {
    if (typeof r.rTask === "number") {
      return t("tasks.fail.reason.withReward", { rTask: r.rTask.toFixed(2) });
    }
    return t("tasks.fail.reason.default");
  }

  return null;
}

function skillBorder(status: NonNullable<EpisodeRow["skillStatus"]>): string {
  switch (status) {
    case "generated":
    case "upgraded":
      return "var(--green)";
    case "not_generated":
      return "var(--red)";
    case "skipped":
      return "var(--amber)";
    case "queued":
    case "generating":
    default:
      return "var(--border)";
  }
}

function skillIcon(
  status: NonNullable<EpisodeRow["skillStatus"]>,
): "check-circle-2" | "circle-alert" | "clock" | "wand-sparkles" {
  switch (status) {
    case "generated":
    case "upgraded":
      return "check-circle-2";
    case "not_generated":
      return "circle-alert";
    case "skipped":
      return "circle-alert";
    case "queued":
      return "clock";
    case "generating":
      return "wand-sparkles";
    default:
      return "clock";
  }
}

// ─── Task drawer ─────────────────────────────────────────────────────────

function TaskDrawer({
  episode,
  timeline,
  onClose,
}: {
  episode: EpisodeRow;
  timeline: Timeline | null;
  onClose: () => void;
}) {
  return (
    <div class="drawer-backdrop" onClick={onClose}>
      <aside class="drawer" role="dialog" onClick={(e) => e.stopPropagation()}>
        <header class="drawer__header">
          <div>
            <div class="muted mono" style="font-size:var(--fs-xs);margin-bottom:2px">
              {t("tasks.detail.id", { id: episode.id.slice(0, 12) })}
            </div>
            <h2 class="drawer__title">
              {episode.preview?.slice(0, 80) || t("tasks.detail.fallbackTitle")}
            </h2>
          </div>
          <button class="btn btn--ghost btn--icon" onClick={onClose} aria-label={t("common.close")}>
            <Icon name="x" size={16} />
          </button>
        </header>

        <div class="drawer__body">
          {statusReason(episode) && (
            <section
              class="card card--flat"
              style={`border-left:3px solid ${
                deriveStatus(episode) === "failed" ? "var(--red)" : "var(--text-muted)"
              }`}
            >
              <div class="hstack" style="gap:var(--sp-2);align-items:flex-start">
                <Icon
                  name={deriveStatus(episode) === "failed" ? "circle-alert" : "info"}
                  size={14}
                />
                <p style="margin:0;font-size:var(--fs-sm);line-height:1.55">
                  {statusReason(episode)}
                </p>
              </div>
            </section>
          )}
          <section class="card card--flat">
            <h3 class="card__title" style="font-size:var(--fs-md)">
              {t("tasks.detail.meta")}
            </h3>
            <dl style="display:grid;grid-template-columns:120px 1fr;gap:6px 16px;margin:0;font-size:var(--fs-sm)">
              <dt class="muted">{t("memories.field.status")}</dt>
              <dd>
                <span class={`pill pill--${deriveStatus(episode)}`}>
                  {t(`status.${deriveStatus(episode)}` as "status.active")}
                </span>
              </dd>
              <dt class="muted">{t("memories.field.startedAt")}</dt>
              <dd>{new Date(episode.startedAt).toLocaleString()}</dd>
              {episode.endedAt && (
                <>
                  <dt class="muted">{t("memories.field.endedAt")}</dt>
                  <dd>{new Date(episode.endedAt).toLocaleString()}</dd>
                </>
              )}
              <dt class="muted">{t("memories.field.session")}</dt>
              <dd class="mono truncate">{episode.sessionId.slice(0, 40)}</dd>
              {episode.rTask != null && (
                <>
                  <dt class="muted">{t("memories.field.rTask")}</dt>
                  <dd>{episode.rTask.toFixed(3)}</dd>
                </>
              )}
            </dl>
          </section>

          {/*
           * Skill pipeline section — mirrors the legacy plugin's
           * "Skill 生成/升级" drawer. Shows the user WHY a task
           * didn't produce a skill (reward missing, policy didn't
           * crystallise, etc.), plus a link to the produced skill
           * when the pipeline completed successfully.
           *
           * We hide the placeholder "queued / generating" pill on
           * skipped or failed tasks — the pipeline isn't actually
           * progressing for those, so showing a queue indicator
           * misleads the reader into thinking work is still pending.
           */}
          {episode.skillStatus &&
            !(
              (deriveStatus(episode) === "skipped" ||
                deriveStatus(episode) === "failed") &&
              (episode.skillStatus === "queued" ||
                episode.skillStatus === "generating")
            ) && (
            <section
              class="card card--flat"
              style={`border-left:3px solid ${skillBorder(episode.skillStatus)}`}
            >
              <div class="card__header" style="margin-bottom:var(--sp-2)">
                <h3
                  class="card__title"
                  style="font-size:var(--fs-md);margin:0;display:flex;gap:var(--sp-2);align-items:center"
                >
                  <Icon name={skillIcon(episode.skillStatus)} size={14} />
                  {t(`tasks.skill.${episode.skillStatus}` as never)}
                </h3>
                {episode.linkedSkillId && (
                  <button
                    class="btn btn--ghost btn--sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      linkTo("skill", episode.linkedSkillId!);
                    }}
                  >
                    <Icon name="arrow-up-right" size={12} />
                    {t("tasks.skill.openSkill")}
                  </button>
                )}
              </div>
              {(episode.skillReasonKey || episode.skillReason) && (
                <p
                  class="muted"
                  style="font-size:var(--fs-sm);line-height:1.6;margin:0"
                >
                  {episode.skillReasonKey
                    ? t(episode.skillReasonKey as any, episode.skillReasonParams ?? undefined)
                    : episode.skillReason}
                </p>
              )}
            </section>
          )}

          {/*
           * Conversation log — a proper chat view. Mirrors the
           * legacy `.task-chunk-item` layout: user bubbles flipped
           * to the right, assistant bubbles to the left, tool
           * replies in amber. This replaces the old "related
           * memories" row list which showed V/α metrics instead of
           * the actual conversation text.
           */}
          <section class="card card--flat">
            <h3 class="card__title" style="font-size:var(--fs-md);margin-bottom:var(--sp-3)">
              {t("tasks.detail.chat")}
            </h3>
            {!timeline ? (
              <div class="skeleton" style="height:80px" />
            ) : timeline.traces.length === 0 ? (
              <div class="empty" style="padding:var(--sp-4) 0">
                <div class="empty__hint">{t("tasks.detail.chat.empty")}</div>
              </div>
            ) : (
              <ChatLog messages={flattenChat(timeline.traces)} />
            )}
          </section>
        </div>
      </aside>
    </div>
  );
}

