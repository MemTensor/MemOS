/**
 * World-models view — V7 L3 "世界环境知识".
 *
 * A world model is a higher-level abstraction that summarises several
 * policies into a cohesive description of a domain. The viewer
 * browses them, opens a drawer with the full body, and supports hard
 * delete.
 *
 * Backed by:
 *   - `GET    /api/v1/world-models?limit=&offset=&q=`
 *   - `DELETE /api/v1/world-models/:id`
 */
import { useEffect, useState } from "preact/hooks";
import { api } from "../api/client";
import { t } from "../stores/i18n";
import { Icon } from "../components/Icon";
import { Pager } from "../components/Pager";
import { ShareScopePill } from "../components/ShareScopePill";
import { route } from "../stores/router";
import { clearEntryId, linkTo } from "../stores/cross-link";
import type { WorldModelDTO } from "../api/types";
import { areAllIdsSelected, toggleIdsInSelection } from "../utils/selection";
import { loadHubSharingEnabled } from "../utils/share";

interface WorldModelUsage {
  policies: Array<{
    id: string;
    title: string | null;
    status: string | null;
    gain: number | null;
  }>;
}

const DEFAULT_PAGE_SIZE = 20;

interface ListResponse {
  worldModels: WorldModelDTO[];
  limit: number;
  offset: number;
  nextOffset?: number;
  total?: number;
}

export function WorldModelsView() {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<WorldModelDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [detail, setDetail] = useState<WorldModelDTO | null>(null);
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

  const load = async (opts: { q: string; page: number }) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      qs.set("limit", String(pageSize));
      qs.set("offset", String(opts.page * pageSize));
      if (opts.q) qs.set("q", opts.q);
      const res = await api.get<ListResponse>(`/api/v1/world-models?${qs.toString()}`);
      setRows(res.worldModels);
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
      void load({ q: query.trim(), page: 0 });
    }, 200);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, pageSize]);

  // Deep-link: `#/world-models?id=wm_xxx` auto-opens the drawer.
  useEffect(() => {
    const id = route.value.params.id;
    if (!id) return;
    const ctrl = new AbortController();
    api
      .get<WorldModelDTO>(
        `/api/v1/world-models/${encodeURIComponent(id)}`,
        { signal: ctrl.signal },
      )
      .then(setDetail)
      .catch(() => void 0);
    return () => ctrl.abort();
  }, [route.value.params.id]);

  const deleteModel = async (m: WorldModelDTO) => {
    if (!confirm(t("worldModels.delete.confirm"))) return;
    try {
      await api.del(`/api/v1/world-models/${encodeURIComponent(m.id)}`);
      setRows((prev) => prev.filter((r) => r.id !== m.id));
      if (detail?.id === m.id) setDetail(null);
      setToast(t("memories.delete.done"));
      setTimeout(() => setToast(null), 2200);
    } catch {
      setToast("Failed");
      setTimeout(() => setToast(null), 2200);
    }
  };
  const pageIds = rows.map((m) => m.id);
  const isPageSelected = areAllIdsSelected(selected, pageIds);

  return (
    <>
      <div class="view-header">
        <div class="view-header__title">
          <h1>{t("worldModels.title")}</h1>
          <p>{t("worldModels.subtitle")}</p>
        </div>
        <div class="view-header__actions">
          {/*
           * Refresh — same pattern as MemoriesView / PoliciesView /
           * TasksView so every list page behaves consistently. Clears
           * the search box + selection and re-fetches page 0.
           */}
          <button
            class="btn btn--ghost btn--sm"
            onClick={() => {
              setQuery("");
              setSelected(new Set());
              void load({ q: "", page: 0 });
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
            placeholder={t("worldModels.search.placeholder")}
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
        </label>
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
          <div class="empty__icon"><Icon name="globe" size={22} /></div>
          <div class="empty__title">{t("worldModels.empty")}</div>
          <div class="empty__hint">{t("worldModels.empty.hint")}</div>
        </div>
      )}

      {rows.length > 0 && (
        <div class="list">
          {rows.map((m) => {
            const isSel = selected.has(m.id);
            return (
              <div
                key={m.id}
                class={`mem-card${isSel ? " mem-card--selected" : ""}`}
                onClick={() => setDetail(m)}
              >
                <label
                  class="mem-card__check-wrap"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    class="mem-card__check"
                    checked={isSel}
                    onChange={() => toggleSel(m.id)}
                    aria-label="select"
                  />
                </label>
                <div class="mem-card__body">
                  <div class="mem-card__title">{m.title || "(untitled)"}</div>
                  <div class="mem-card__meta">
                    <ShareScopePill scope={m.share?.scope} />
                    <span class="pill pill--info" title={t("worldModels.version.title")}>
                      v{m.version ?? 1}
                    </span>
                    <span class="pill pill--info">
                      {m.policyIds.length} {t("worldModels.col.policies")}
                    </span>
                    <span>{new Date(m.updatedAt).toLocaleString()}</span>
                  </div>
                </div>
                {/*
                 * Row actions intentionally omitted — destructive
                 * operations (delete) live in the drawer footer to
                 * match the Memories / Policies / Skills views and
                 * give users a confirmation step instead of a one-
                 * click delete on a list row.
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
            void load({ q: query.trim(), page: nextPage });
          }}
        />
      )}

      {detail && (
        <WorldModelDrawer
          worldModel={detail}
          onClose={() => {
            setDetail(null);
            clearEntryId();
          }}
          onDelete={deleteModel}
          onChanged={() => {
            void load({ q: query.trim(), page });
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
                  api.del(`/api/v1/world-models/${encodeURIComponent(id)}`).catch(() => null),
                ),
              );
              setSelected(new Set());
              void load({ q: query.trim(), page });
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

/**
 * Right-side drawer with clickable policy cross-links. Loads the
 * `/usage` payload on mount so pills show readable policy titles
 * instead of raw `po_xxx` ids.
 *
 * Delete lives in the drawer footer (not on the list row) so the
 * destructive action is consistent with the Memories / Policies /
 * Skills drawers — users open the entity, review it, and then act.
 */
function WorldModelDrawer({
  worldModel,
  onClose,
  onDelete,
  onChanged,
}: {
  worldModel: WorldModelDTO;
  onClose: () => void;
  onDelete: (m: WorldModelDTO) => Promise<void> | void;
  onChanged: () => void;
}) {
  const [usage, setUsage] = useState<WorldModelUsage | null>(null);
  const [mode, setMode] = useState<"view" | "edit" | "share">("view");
  const [title, setTitle] = useState(worldModel.title);
  const [body, setBody] = useState(worldModel.body ?? "");
  const [scope, setScope] = useState<"private" | "local" | "public" | "hub">(
    worldModel.share?.scope ?? "public",
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setTitle(worldModel.title);
    setBody(worldModel.body ?? "");
    setScope(worldModel.share?.scope ?? "public");
  }, [worldModel]);

  useEffect(() => {
    const ctrl = new AbortController();
    api
      .get<WorldModelUsage>(
        `/api/v1/world-models/${encodeURIComponent(worldModel.id)}/usage`,
        { signal: ctrl.signal },
      )
      .then(setUsage)
      .catch(() => setUsage(null));
    return () => ctrl.abort();
  }, [worldModel.id]);

  const archive = async () => {
    setBusy(true);
    try {
      await api.post(
        `/api/v1/world-models/${encodeURIComponent(worldModel.id)}/archive`,
        {},
      );
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const unarchive = async () => {
    setBusy(true);
    try {
      await api.post(
        `/api/v1/world-models/${encodeURIComponent(worldModel.id)}/unarchive`,
        {},
      );
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const submitEdit = async () => {
    setBusy(true);
    try {
      await api.patch(
        `/api/v1/world-models/${encodeURIComponent(worldModel.id)}`,
        { title: title.trim() || worldModel.title, body },
      );
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const submitShare = async (s: "private" | "local" | "public" | "hub" | null) => {
    setBusy(true);
    try {
      await api.post(
        `/api/v1/world-models/${encodeURIComponent(worldModel.id)}/share`,
        { scope: s },
      );
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="drawer-backdrop" onClick={onClose}>
      <aside class="drawer" role="dialog" onClick={(e) => e.stopPropagation()}>
        <header class="drawer__header">
          <div>
            <div class="muted" style="font-size:var(--fs-xs);margin-bottom:2px">world-model</div>
            <h2 class="drawer__title">{worldModel.title}</h2>
          </div>
          <button
            class="btn btn--ghost btn--icon"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <Icon name="x" size={16} />
          </button>
        </header>
        <div class="drawer__body">
          {mode === "view" && (<>
          <section class="card card--flat">
            <h3 class="card__title" style="font-size:var(--fs-md)">
              {t("tasks.detail.meta")}
            </h3>
            <dl style="display:grid;grid-template-columns:120px 1fr;gap:6px 16px;margin:0;font-size:var(--fs-sm)">
              <dt class="muted">{t("worldModels.field.id")}</dt>
              <dd class="mono" style="word-break:break-all">{worldModel.id}</dd>
              <dt class="muted">{t("worldModels.field.version")}</dt>
              <dd>v{worldModel.version ?? 1}</dd>
              <dt class="muted">{t("memories.field.status")}</dt>
              <dd>
                <span class={`pill pill--${worldModel.status === "archived" ? "archived" : "active"}`}>
                  {t(`status.${worldModel.status}` as "status.active")}
                </span>
              </dd>
              <dt class="muted">{t("memories.field.share")}</dt>
              <dd><ShareScopePill scope={worldModel.share?.scope} /></dd>
              <dt class="muted">{t("memories.field.createdAt")}</dt>
              <dd>{new Date(worldModel.createdAt).toLocaleString()}</dd>
              <dt class="muted">{t("memories.field.updatedAt")}</dt>
              <dd>{new Date(worldModel.updatedAt).toLocaleString()}</dd>
              <dt class="muted">{t("worldModels.col.policies")}</dt>
              <dd>{worldModel.policyIds.length}</dd>
            </dl>
          </section>
          {worldModel.body && (
            <section class="card card--flat">
              <div class="muted" style="font-size:var(--fs-xs);margin-bottom:4px">
                {t("worldModels.col.body")}
              </div>
              <pre
                class="mono"
                style="white-space:pre-wrap;font-size:var(--fs-sm);margin:0"
              >
                {worldModel.body}
              </pre>
            </section>
          )}

          {/*
           * V7 §1.1 — render the structured (ℰ, ℐ, 𝒞) triple with
           * per-entry evidence chips. The body above is the rendered
           * markdown form (used by retrieval / embedder); this section
           * exposes the underlying provenance — which trace / policy
           * justified each label, click-through into MemoriesView /
           * PoliciesView. The component itself returns null when all
           * three facets are empty so we always-render unconditionally.
           */}
          <StructureSection structure={worldModel.structure} />
          {worldModel.policyIds.length > 0 && (
            <section class="card card--flat">
              <h3
                class="card__title"
                style="font-size:var(--fs-md);margin-bottom:var(--sp-3)"
              >
                {t("worldModels.col.policies")}
              </h3>
              <div class="hstack" style="flex-wrap:wrap;gap:var(--sp-2)">
                {worldModel.policyIds.map((id) => {
                  const meta = usage?.policies.find((p) => p.id === id);
                  const label = meta?.title ?? id.slice(0, 14);
                  return (
                    <button
                      key={id}
                      class="pill pill--link"
                      style="cursor:pointer;border:0;font-family:inherit;font-size:var(--fs-sm)"
                      onClick={() => linkTo("policy", id)}
                      title={id}
                    >
                      {label}
                      {meta?.gain != null && (
                        <span
                          class="muted"
                          style="margin-left:6px;font-size:var(--fs-xs)"
                        >
                          gain {meta.gain.toFixed(2)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </section>
          )}
          </>)}

          {mode === "edit" && (
            <>
              <section class="card card--flat">
                <div class="modal__field">
                  <label>{t("worldModels.edit.title")}</label>
                  <input
                    class="input"
                    value={title}
                    onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
                  />
                </div>
              </section>
              <section class="card card--flat">
                <div class="modal__field">
                  <label>{t("worldModels.edit.body")}</label>
                  <textarea
                    class="textarea"
                    rows={14}
                    value={body}
                    onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)}
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
                        name="wm-share-scope"
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
                onClick={async () => {
                  await onDelete(worldModel);
                  onClose();
                }}
              >
                <Icon name="trash-2" size={14} />
                {t("memories.act.delete")}
              </button>
              <div class="batch-bar__spacer" />
              {worldModel.status === "archived" ? (
                <button class="btn btn--sm" disabled={busy} onClick={unarchive}>
                  <Icon name="check-circle-2" size={14} />
                  {t("policies.act.activate")}
                </button>
              ) : (
                <button class="btn btn--sm" disabled={busy} onClick={archive}>
                  <Icon name="archive" size={14} />
                  {t("policies.act.retire")}
                </button>
              )}
              <button class="btn btn--sm" disabled={busy} onClick={() => setMode("share")}>
                <Icon name="share" size={14} />
                {worldModel.share?.scope
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
              {worldModel.share?.scope && (
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

// ─── Structure section (V7 §1.1 ℰ / ℐ / 𝒞 with evidence chips) ─────────

interface StructureEntry {
  label: string;
  description: string;
  evidenceIds?: string[];
}

interface StructureProp {
  environment: StructureEntry[];
  inference: StructureEntry[];
  constraints: StructureEntry[];
}

/**
 * Render the (ℰ topology / ℐ inference rules / 𝒞 constraints) triple
 * as three sub-cards. Each entry shows its label + description + a
 * row of evidence chips that deep-link back to MemoriesView (for
 * `tr_*` ids) or PoliciesView (for `po_*` ids).
 *
 * Sections with zero entries collapse silently — V7 says environment
 * cognition is allowed to be partial (e.g. only constraints, no
 * inference rules) so we don't force the user to see empty headings.
 */
function StructureSection({ structure }: { structure: StructureProp }) {
  const sections: Array<{
    titleKey:
      | "worldModels.structure.environment"
      | "worldModels.structure.inference"
      | "worldModels.structure.constraints";
    entries: StructureEntry[];
  }> = [
    { titleKey: "worldModels.structure.environment", entries: structure.environment },
    { titleKey: "worldModels.structure.inference", entries: structure.inference },
    { titleKey: "worldModels.structure.constraints", entries: structure.constraints },
  ];
  const visible = sections.filter((s) => s.entries.length > 0);
  if (visible.length === 0) return null;
  return (
    <section class="card card--flat">
      <h3
        class="card__title"
        style="font-size:var(--fs-md);margin-bottom:var(--sp-3)"
      >
        {t("worldModels.structure.title")}
      </h3>
      <div class="vstack" style="gap:var(--sp-3)">
        {visible.map((s) => (
          <div key={s.titleKey}>
            <div class="muted" style="font-size:var(--fs-xs);margin-bottom:6px">
              {t(s.titleKey)}
            </div>
            <ul style="margin:0;padding-left:18px;font-size:var(--fs-sm);line-height:1.55">
              {s.entries.map((e, i) => (
                <li key={`${s.titleKey}-${i}`} style="margin-bottom:6px">
                  <strong>{e.label}</strong>
                  {e.description ? ` — ${e.description}` : null}
                  {e.evidenceIds && e.evidenceIds.length > 0 && (
                    <div
                      class="hstack"
                      style="flex-wrap:wrap;gap:4px;margin-top:4px"
                    >
                      {e.evidenceIds.map((id) => {
                        const kind = id.startsWith("po_") ? "policy" : "memory";
                        return (
                          <button
                            key={id}
                            class="pill pill--link mono"
                            style="cursor:pointer;border:0;font-family:var(--font-mono);font-size:var(--fs-2xs)"
                            onClick={() => linkTo(kind, id)}
                            title={id}
                          >
                            {id.slice(0, 12)}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
