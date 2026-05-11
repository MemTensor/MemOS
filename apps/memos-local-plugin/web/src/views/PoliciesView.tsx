/**
 * Policies view — V7 L2 "经验".
 *
 * Policies are crystallised action patterns: trigger + procedure +
 * verification + boundary. The viewer uses this tab to browse them,
 * toggle status (candidate / active / archived), and hard-delete.
 *
 * Backed by:
 *   - `GET    /api/v1/policies?limit=&offset=&q=&status=`
 *   - `PATCH  /api/v1/policies/:id   { status }`
 *   - `DELETE /api/v1/policies/:id`
 */
import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api/client";
import { t } from "../stores/i18n";
import { Icon } from "../components/Icon";
import { Pager } from "../components/Pager";
import { ShareScopePill } from "../components/ShareScopePill";
import { route } from "../stores/router";
import { clearEntryId, linkTo } from "../stores/cross-link";
import type { PolicyDTO } from "../api/types";
import { areAllIdsSelected, toggleIdsInSelection } from "../utils/selection";
import { loadHubSharingEnabled } from "../utils/share";

interface PolicyUsage {
  skills: Array<{ id: string; name: string; status: string; eta: number }>;
  worldModels: Array<{ id: string; title: string }>;
  sourceEpisodes: string[];
}

const DEFAULT_PAGE_SIZE = 20;

type StatusFilter = "" | "candidate" | "active" | "archived";

interface ListResponse {
  policies: PolicyDTO[];
  limit: number;
  offset: number;
  nextOffset?: number;
  total?: number;
}

export function PoliciesView() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("");
  const [rows, setRows] = useState<PolicyDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [detail, setDetail] = useState<PolicyDTO | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleSel = (id: string) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  useEffect(() => {
    const ctrl = new AbortController();
    void loadHubSharingEnabled({ force: true, signal: ctrl.signal });
    return () => ctrl.abort();
  }, []);

  const load = async (opts: { q: string; status: StatusFilter; page: number }) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      qs.set("limit", String(pageSize));
      qs.set("offset", String(opts.page * pageSize));
      if (opts.q) qs.set("q", opts.q);
      if (opts.status) qs.set("status", opts.status);
      const res = await api.get<ListResponse>(`/api/v1/policies?${qs.toString()}`);
      setRows(res.policies);
      setHasMore(res.nextOffset != null);
      setTotal(res.total ?? 0);
      setPage(opts.page);
    } catch {
      setRows([]);
      setHasMore(false);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const h = setTimeout(() => {
      void load({ q: query.trim(), status, page: 0 });
    }, 200);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, status, pageSize]);

  // Deep-link: `#/policies?id=po_xxx` auto-opens the row's drawer.
  // Lets other views (Skills / WorldModels / Tasks) link straight
  // into a specific policy without the user searching for it.
  useEffect(() => {
    const id = route.value.params.id;
    if (!id) return;
    const ctrl = new AbortController();
    api
      .get<PolicyDTO>(
        `/api/v1/policies/${encodeURIComponent(id)}`,
        { signal: ctrl.signal },
      )
      .then((p) => setDetail(p))
      .catch(() => void 0);
    return () => ctrl.abort();
  }, [route.value.params.id]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  };
  const pageIds = rows.map((p) => p.id);
  const isPageSelected = areAllIdsSelected(selected, pageIds);

  const setPolicyStatus = async (p: PolicyDTO, next: PolicyDTO["status"]) => {
    try {
      const updated = await api.patch<PolicyDTO>(
        `/api/v1/policies/${encodeURIComponent(p.id)}`,
        { status: next },
      );
      setRows((prev) => prev.map((r) => (r.id === p.id ? updated : r)));
      showToast("OK");
    } catch {
      showToast("Failed");
    }
  };

  const deletePolicy = async (p: PolicyDTO) => {
    if (!confirm(t("policies.delete.confirm"))) return;
    try {
      await api.del(`/api/v1/policies/${encodeURIComponent(p.id)}`);
      setRows((prev) => prev.filter((r) => r.id !== p.id));
      if (detail?.id === p.id) setDetail(null);
      showToast(t("memories.delete.done"));
    } catch {
      showToast("Failed");
    }
  };

  const statuses: Array<{ v: StatusFilter; k: string }> = useMemo(
    () => [
      { v: "", k: t("policies.filter.all") },
      { v: "candidate", k: t("policies.filter.candidate") },
      { v: "active", k: t("policies.filter.active") },
      { v: "archived", k: t("policies.filter.archived") },
    ],
    [],
  );

  return (
    <>
      <div class="view-header">
        <div class="view-header__title">
          <h1>{t("policies.title")}</h1>
          <p>{t("policies.subtitle")}</p>
        </div>
        <div class="view-header__actions">
          {/*
           * Refresh — mirrors MemoriesView. Clears search + status
           * filter, drops selection, and re-fetches page 0 so the user
           * sees freshly-induced policies without a full page reload.
           */}
          <button
            class="btn btn--ghost btn--sm"
            onClick={() => {
              setQuery("");
              setStatus("");
              setSelected(new Set());
              void load({ q: "", status: "", page: 0 });
            }}
          >
            <Icon name="refresh-cw" size={14} />
            {t("common.refresh")}
          </button>
        </div>
      </div>

      {/* Row 1: search box */}
      <div class="toolbar">
        <label class="input-search">
          <Icon name="search" size={16} />
          <input
            class="input input--search"
            type="search"
            placeholder={t("policies.search.placeholder")}
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
        </label>
      </div>

      {/* Row 2: filter chips — own row, matches TasksView / MemoriesView */}
      <div class="toolbar" style="margin-top:calc(-1 * var(--sp-2))">
        <div class="toolbar__group" role="group" aria-label={t("common.filter")}>
          {statuses.map((s) => (
            <button
              key={s.v}
              class="chip"
              aria-pressed={status === s.v}
              onClick={() => setStatus(s.v)}
            >
              {s.k}
            </button>
          ))}
        </div>
      </div>

      {loading && rows.length === 0 && (
        <div class="list">
          {[0, 1, 2].map((i) => (
            <div key={i} class="skeleton" style="height:68px" />
          ))}
        </div>
      )}
      {!loading && rows.length === 0 && (
        <div class="empty">
          <div class="empty__icon"><Icon name="sparkles" size={22} /></div>
          <div class="empty__title">{t("policies.empty")}</div>
          <div class="empty__hint">{t("policies.empty.hint")}</div>
        </div>
      )}

      {rows.length > 0 && (
        <div class="list">
          {rows.map((p) => {
            const isSel = selected.has(p.id);
            return (
            <div
              key={p.id}
              class={`mem-card${isSel ? " mem-card--selected" : ""}`}
              onClick={() => setDetail(p)}
            >
              <label
                class="mem-card__check-wrap"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="checkbox"
                  class="mem-card__check"
                  checked={isSel}
                  onChange={() => toggleSel(p.id)}
                  aria-label="select"
                />
              </label>
              <div class="mem-card__body">
                <div class="mem-card__title">{p.title || "(untitled)"}</div>
                <div class="mem-card__meta">
                  <ShareScopePill scope={p.share?.scope} />
                  <span class={`pill pill--${p.status}`}>{t(`status.${p.status}` as never)}</span>
                  <span>support {p.support}</span>
                  <span>gain {p.gain.toFixed(2)}</span>
                  {(p.preference?.length ?? 0) > 0 && (
                    <span
                      class="pill pill--active"
                      title={t("policies.guidance.preferTitle")}
                    >
                      {t("policies.guidance.prefer")} {p.preference.length}
                    </span>
                  )}
                  {(p.antiPattern?.length ?? 0) > 0 && (
                    <span
                      class="pill pill--failed"
                      title={t("policies.guidance.avoidTitle")}
                    >
                      {t("policies.guidance.avoid")} {p.antiPattern.length}
                    </span>
                  )}
                  <span>{new Date(p.updatedAt).toLocaleString()}</span>
                </div>
              </div>
              {/*
               * Lifecycle actions live in the drawer footer (PolicyDrawer).
               * The row itself stays clean with just title + meta + chevron,
               * matching the other list views.
               */}
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
            void load({ q: query.trim(), status, page: nextPage });
          }}
        />
      )}

      {detail && (
        <PolicyDrawer
          policy={detail}
          onClose={() => {
            setDetail(null);
            clearEntryId();
          }}
          onUpdated={(updated) => {
            setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
            setDetail(updated);
          }}
          onStatusChange={async (p, next) => {
            await setPolicyStatus(p, next);
            // refresh the drawer with the new status.
            setDetail((cur) => (cur ? { ...cur, status: next } : cur));
          }}
          onDelete={(p) => deletePolicy(p)}
        />
      )}

      {selected.size > 0 && (
        <div class="batch-bar" role="region" aria-label="bulk actions">
          <span class="batch-bar__count">
            {t("common.selected", { n: selected.size })}
          </span>
          <button
            class="btn btn--sm"
            onClick={() => setSelected((prev) => toggleIdsInSelection(prev, pageIds))}
          >
            <Icon name="check-square" size={14} />
            {isPageSelected ? t("common.deselectPage") : t("common.selectPage")}
          </button>
          <button
            class="btn btn--danger btn--sm"
            onClick={async () => {
              if (selected.size === 0) return;
              if (!confirm(t("common.bulkDelete.confirm", { n: selected.size }))) return;
              const ids = [...selected];
              await Promise.all(
                ids.map((id) =>
                  api.del(`/api/v1/policies/${encodeURIComponent(id)}`).catch(() => null),
                ),
              );
              setSelected(new Set());
              void load({ q: query.trim(), status, page });
            }}
          >
            <Icon name="trash-2" size={14} />
            {t("common.bulkDelete")}
          </button>
          <div class="batch-bar__spacer" />
          <button class="btn btn--ghost btn--sm" onClick={() => setSelected(new Set())}>
            {t("common.deselect")}
          </button>
        </div>
      )}

      {toast && (
        <div class="toast-stack">
          <div class="toast toast--info">{toast}</div>
        </div>
      )}
    </>
  );
}

function PolicyDrawer({
  policy,
  onClose,
  onUpdated,
  onStatusChange,
  onDelete,
}: {
  policy: PolicyDTO;
  onClose: () => void;
  onUpdated?: (p: PolicyDTO) => void;
  onStatusChange: (p: PolicyDTO, next: "active" | "candidate" | "archived") => Promise<void> | void;
  onDelete: (p: PolicyDTO) => Promise<void> | void;
}) {
  const [usage, setUsage] = useState<PolicyUsage | null>(null);
  const [showGuidanceEditor, setShowGuidanceEditor] = useState(false);
  const [mode, setMode] = useState<"view" | "edit" | "share">("view");
  const [title, setTitle] = useState(policy.title);
  const [trigger, setTrigger] = useState(policy.trigger);
  const [procedure, setProcedure] = useState(policy.procedure);
  const [verification, setVerification] = useState(policy.verification);
  const [boundary, setBoundary] = useState(policy.boundary);
  const [scope, setScope] = useState<"private" | "local" | "public" | "hub">(
    policy.share?.scope ?? "public",
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setTitle(policy.title);
    setTrigger(policy.trigger);
    setProcedure(policy.procedure);
    setVerification(policy.verification);
    setBoundary(policy.boundary);
    setScope(policy.share?.scope ?? "public");
  }, [policy]);

  const submitEdit = async () => {
    setBusy(true);
    try {
      const updated = await api.patch<PolicyDTO>(
        `/api/v1/policies/${encodeURIComponent(policy.id)}`,
        {
          title: title.trim() || policy.title,
          trigger,
          procedure,
          verification,
          boundary,
        },
      );
      if (onUpdated) onUpdated(updated);
      setMode("view");
    } finally {
      setBusy(false);
    }
  };

  const submitShare = async (s: "private" | "local" | "public" | "hub" | null) => {
    setBusy(true);
    try {
      const updated = await api.post<PolicyDTO>(
        `/api/v1/policies/${encodeURIComponent(policy.id)}/share`,
        { scope: s },
      );
      if (onUpdated) onUpdated(updated);
      setMode("view");
    } finally {
      setBusy(false);
    }
  };

  // Load the cross-link payload (skills / world-models / source
  // episodes that reference this policy). Kept server-side so the
  // drawer shows chips with real names, not raw ids.
  useEffect(() => {
    const ctrl = new AbortController();
    api
      .get<PolicyUsage>(
        `/api/v1/policies/${encodeURIComponent(policy.id)}/usage`,
        { signal: ctrl.signal },
      )
      .then(setUsage)
      .catch(() => setUsage(null));
    return () => ctrl.abort();
  }, [policy.id]);

  return (
    <div class="drawer-backdrop" onClick={onClose}>
      <aside class="drawer" role="dialog" onClick={(e) => e.stopPropagation()}>
        <header class="drawer__header">
          <div>
            <div class="muted mono" style="font-size:var(--fs-xs);margin-bottom:2px">
              policy {policy.id}
            </div>
            <h2 class="drawer__title">{policy.title}</h2>
          </div>
          <button class="btn btn--ghost btn--icon" onClick={onClose} aria-label={t("common.close")}>
            <Icon name="x" size={16} />
          </button>
        </header>
        <div class="drawer__body">
          {mode === "view" && (<>
          <section class="card card--flat">
            <h3 class="card__title" style="font-size:var(--fs-md)">{t("tasks.detail.meta")}</h3>
            <dl style="display:grid;grid-template-columns:120px 1fr;gap:6px 16px;margin:0;font-size:var(--fs-sm)">
              <dt class="muted">{t("memories.field.status")}</dt><dd><span class={`pill pill--${policy.status}`}>{t(`status.${policy.status}` as never)}</span></dd>
              <dt class="muted">{t("memories.field.share")}</dt><dd><ShareScopePill scope={policy.share?.scope} /></dd>
              <dt class="muted">{t("memories.field.support")}</dt><dd>{policy.support}</dd>
              <dt class="muted">{t("memories.field.gain")}</dt><dd>{policy.gain.toFixed(3)}</dd>
              <dt class="muted">{t("memories.field.createdAt")}</dt><dd>{new Date(policy.createdAt).toLocaleString()}</dd>
              <dt class="muted">{t("memories.field.updatedAt")}</dt><dd>{new Date(policy.updatedAt).toLocaleString()}</dd>
            </dl>
          </section>
          <Section title={t("policies.col.trigger")} body={policy.trigger} />
          <Section title={t("policies.col.procedure")} body={policy.procedure} />
          <Section title={t("policies.col.verification")} body={policy.verification} />
          <Section title={t("policies.col.boundary")} body={policy.boundary} />

          {/* ── Decision guidance — editable ──────────────────────────
              Fed by the feedback pipeline (`attachRepairToPolicies`),
              but also editable here so users can add "prefer" / "avoid"
              lines manually before the pipeline has produced any. */}
          <section class="card card--flat">
            <div
              class="hstack"
              style="justify-content:space-between;margin-bottom:var(--sp-2);align-items:center"
            >
              <h3 class="card__title" style="font-size:var(--fs-md);margin:0">
                {t("policies.guidance.title")}
              </h3>
              <button
                class="btn btn--ghost btn--sm"
                onClick={() => setShowGuidanceEditor((v) => !v)}
              >
                <Icon name={showGuidanceEditor ? "x" : "plus"} size={14} />
                {showGuidanceEditor
                  ? t("common.cancel")
                  : t("policies.guidance.add")}
              </button>
            </div>

            {(policy.preference?.length ?? 0) === 0 &&
              (policy.antiPattern?.length ?? 0) === 0 &&
              !showGuidanceEditor && (
                <div class="muted" style="font-size:var(--fs-sm);line-height:1.6">
                  {t("policies.guidance.empty")}
                </div>
              )}

            {(policy.preference?.length ?? 0) > 0 && (
              <GuidanceList
                title={t("policies.guidance.preferSection")}
                entries={policy.preference}
                variant="prefer"
              />
            )}
            {(policy.antiPattern?.length ?? 0) > 0 && (
              <GuidanceList
                title={t("policies.guidance.avoidSection")}
                entries={policy.antiPattern}
                variant="avoid"
              />
            )}

            {showGuidanceEditor && (
              <GuidanceEditor
                policyId={policy.id}
                onSaved={(p) => {
                  if (onUpdated) onUpdated(p);
                  setShowGuidanceEditor(false);
                }}
              />
            )}
          </section>

          {/* ── Cross-links ────────────────────────────────────────── */}
          <CrossLinkSection
            title={t("policies.xlink.skills")}
            entries={
              usage?.skills.map((s) => ({
                id: s.id,
                label: `${s.name} · η ${s.eta.toFixed(2)} · ${s.status}`,
              })) ?? []
            }
            kind="skill"
          />
          <CrossLinkSection
            title={t("policies.xlink.worldModels")}
            entries={
              usage?.worldModels.map((w) => ({ id: w.id, label: w.title })) ?? []
            }
            kind="world-model"
          />
          <CrossLinkSection
            title={t("policies.xlink.sourceEpisodes")}
            entries={
              (usage?.sourceEpisodes ?? []).map((id) => ({
                id,
                label: `Task ${id.slice(0, 10)}`,
              }))
            }
            kind="task"
          />
          </>)}

          {mode === "edit" && (
            <>
              <section class="card card--flat">
                <div class="modal__field">
                  <label>{t("policies.col.title")}</label>
                  <input
                    class="input"
                    value={title}
                    onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
                  />
                </div>
              </section>
              <section class="card card--flat">
                <div class="modal__field">
                  <label>{t("policies.col.trigger")}</label>
                  <textarea
                    class="textarea"
                    rows={3}
                    value={trigger}
                    onInput={(e) => setTrigger((e.target as HTMLTextAreaElement).value)}
                  />
                </div>
              </section>
              <section class="card card--flat">
                <div class="modal__field">
                  <label>{t("policies.col.procedure")}</label>
                  <textarea
                    class="textarea"
                    rows={6}
                    value={procedure}
                    onInput={(e) => setProcedure((e.target as HTMLTextAreaElement).value)}
                  />
                </div>
              </section>
              <section class="card card--flat">
                <div class="modal__field">
                  <label>{t("policies.col.verification")}</label>
                  <textarea
                    class="textarea"
                    rows={3}
                    value={verification}
                    onInput={(e) => setVerification((e.target as HTMLTextAreaElement).value)}
                  />
                </div>
              </section>
              <section class="card card--flat">
                <div class="modal__field">
                  <label>{t("policies.col.boundary")}</label>
                  <textarea
                    class="textarea"
                    rows={3}
                    value={boundary}
                    onInput={(e) => setBoundary((e.target as HTMLTextAreaElement).value)}
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
                  {(["private", "local", "public", "hub"] as const).map((v) => (
                    <label
                      key={v}
                      class="hstack"
                      style="gap:var(--sp-2);cursor:pointer;padding:6px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-canvas)"
                    >
                      <input
                        type="radio"
                        name="policy-share-scope"
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
              <button
                class="btn btn--danger btn--sm"
                disabled={busy}
                onClick={async () => { await onDelete(policy); onClose(); }}
              >
                <Icon name="trash-2" size={14} />
                {t("memories.act.delete")}
              </button>
              <div class="batch-bar__spacer" />
              {policy.status === "archived" ? (
                <button
                  class="btn btn--sm"
                  disabled={busy}
                  onClick={() => onStatusChange(policy, "active")}
                >
                  <Icon name="check-circle-2" size={14} />
                  {t("policies.act.activate")}
                </button>
              ) : (
                <button
                  class="btn btn--sm"
                  disabled={busy}
                  onClick={() => onStatusChange(policy, "archived")}
                >
                  <Icon name="archive" size={14} />
                  {t("policies.act.archive")}
                </button>
              )}
              {policy.status === "candidate" ? (
                <button
                  class="btn btn--sm"
                  disabled={busy}
                  onClick={() => onStatusChange(policy, "active")}
                >
                  <Icon name="check-circle-2" size={14} />
                  {t("policies.act.activate")}
                </button>
              ) : (
                <button
                  class="btn btn--sm"
                  disabled={busy}
                  onClick={() => onStatusChange(policy, "candidate")}
                >
                  <Icon name="refresh-cw" size={14} />
                  {t("policies.act.candidate")}
                </button>
              )}
              <button
                class="btn btn--sm"
                disabled={busy}
                onClick={() => setMode("share")}
              >
                <Icon name="share" size={14} />
                {policy.share?.scope
                  ? t("memories.act.unshare")
                  : t("memories.act.share")}
              </button>
              <button
                class="btn btn--primary btn--sm"
                disabled={busy}
                onClick={() => setMode("edit")}
              >
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
              <button
                class="btn btn--primary btn--sm"
                disabled={busy}
                onClick={submitEdit}
              >
                <Icon name="check" size={14} />
                {t("common.save")}
              </button>
            </>
          )}
          {mode === "share" && (
            <>
              {policy.share?.scope && (
                <button
                  class="btn btn--danger btn--sm"
                  disabled={busy}
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
              <button
                class="btn btn--primary btn--sm"
                disabled={busy}
                onClick={() => submitShare(scope)}
              >
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

function GuidanceEditor({
  policyId,
  onSaved,
}: {
  policyId: string;
  onSaved: (updated: PolicyDTO) => void;
}) {
  const [preferText, setPreferText] = useState("");
  const [avoidText, setAvoidText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const preference = preferText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const antiPattern = avoidText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (preference.length === 0 && antiPattern.length === 0) {
      setError(t("policies.guidance.emptyInput"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await api.post<PolicyDTO>(
        `/api/v1/policies/${encodeURIComponent(policyId)}/guidance`,
        { preference, antiPattern },
      );
      onSaved(updated);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      class="vstack"
      style="gap:var(--sp-3);margin-top:var(--sp-3);padding:var(--sp-3);background:var(--bg-canvas);border-radius:var(--radius-sm);border:1px dashed var(--border)"
    >
      <div class="modal__field">
        <label>
          <span
            class="pill pill--active"
            style="font-size:var(--fs-2xs);margin-right:6px"
          >
            {t("policies.guidance.prefer")}
          </span>
          {t("policies.guidance.preferInputHint")}
        </label>
        <textarea
          class="textarea"
          rows={3}
          value={preferText}
          onInput={(e) => setPreferText((e.target as HTMLTextAreaElement).value)}
          placeholder={t("policies.guidance.preferPlaceholder")}
        />
      </div>
      <div class="modal__field">
        <label>
          <span
            class="pill pill--failed"
            style="font-size:var(--fs-2xs);margin-right:6px"
          >
            {t("policies.guidance.avoid")}
          </span>
          {t("policies.guidance.avoidInputHint")}
        </label>
        <textarea
          class="textarea"
          rows={3}
          value={avoidText}
          onInput={(e) => setAvoidText((e.target as HTMLTextAreaElement).value)}
          placeholder={t("policies.guidance.avoidPlaceholder")}
        />
      </div>
      {error && (
        <div style="color:var(--danger);font-size:var(--fs-sm)">{error}</div>
      )}
      <div class="hstack" style="justify-content:flex-end">
        <button class="btn btn--primary btn--sm" onClick={submit} disabled={saving}>
          <Icon name={saving ? "loader-2" : "check"} size={14} class={saving ? "spin" : ""} />
          {t("common.save")}
        </button>
      </div>
    </div>
  );
}

function CrossLinkSection({
  title,
  entries,
  kind,
}: {
  title: string;
  entries: Array<{ id: string; label: string }>;
  kind: Parameters<typeof linkTo>[0];
}) {
  if (entries.length === 0) return null;
  return (
    <section class="card card--flat">
      <h3 class="card__title" style="font-size:var(--fs-md);margin-bottom:var(--sp-3)">
        {title}
      </h3>
      <div class="hstack" style="flex-wrap:wrap;gap:var(--sp-2)">
        {entries.map((e) => (
          <button
            key={e.id}
            class="pill pill--link"
            style="cursor:pointer;border:0;font-family:inherit;font-size:var(--fs-sm)"
            onClick={() => linkTo(kind, e.id)}
            title={e.id}
          >
            {e.label}
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * Render a preference / anti-pattern list as a labelled card. Variant
 * just switches the leading pill + icon so the two sections feel
 * visually distinct — mirrors the legacy `skill_heuristics` UI where
 * avoid rules were tinted red and prefer rules green.
 */
function GuidanceList({
  title,
  entries,
  variant,
}: {
  title: string;
  entries: string[];
  variant: "prefer" | "avoid";
}) {
  return (
    <section class="card card--flat">
      <div
        class="hstack"
        style="gap:var(--sp-2);margin-bottom:var(--sp-2);align-items:center"
      >
        <span
          class={`pill ${variant === "prefer" ? "pill--active" : "pill--failed"}`}
          style="font-size:var(--fs-2xs)"
        >
          {variant === "prefer"
            ? t("policies.guidance.prefer")
            : t("policies.guidance.avoid")}
        </span>
        <span style="font-size:var(--fs-sm);font-weight:var(--fw-semi)">
          {title}
        </span>
      </div>
      <ul style="margin:0;padding-left:20px;font-size:var(--fs-sm);line-height:1.7">
        {entries.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
    </section>
  );
}

function Section({ title, body }: { title: string; body: string }) {
  if (!body) return null;
  return (
    <section class="card card--flat">
      <div class="muted" style="font-size:var(--fs-xs);margin-bottom:4px">{title}</div>
      <pre class="mono" style="white-space:pre-wrap;font-size:var(--fs-sm);margin:0">{body}</pre>
    </section>
  );
}
