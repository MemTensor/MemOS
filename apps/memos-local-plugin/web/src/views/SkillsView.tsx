/**
 * Skills view — browse + archive + download crystallized skills.
 *
 * Backed by `/api/v1/skills`. Clicking a row opens a drawer with the
 * full invocation guide, η/gain/support stats, and actions:
 *
 *   - Download as .zip   (backend writes the skill package)
 *   - Toggle visibility  (public ↔ private, for Hub sharing)
 *   - Archive
 */
import { useEffect, useState } from "preact/hooks";
import { api, withAgentPrefix } from "../api/client";
import { t } from "../stores/i18n";
import { Icon } from "../components/Icon";
import { route } from "../stores/router";
import { clearEntryId, linkTo } from "../stores/cross-link";
import type { SkillDTO } from "../api/types";

interface SkillUsage {
  sourcePolicies: Array<{
    id: string;
    title: string | null;
    status: string | null;
    gain: number | null;
  }>;
  sourceWorldModels: Array<{ id: string; title: string | null }>;
}

type StatusFilter = "" | "active" | "candidate" | "archived";

const PAGE_SIZE = 20;

export function SkillsView() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("");
  const [skills, setSkills] = useState<SkillDTO[] | null>(null);
  const [detail, setDetail] = useState<SkillDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleSel = (id: string) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const load = async (nextPage: number = 0) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      qs.set("limit", String(PAGE_SIZE));
      qs.set("offset", String(nextPage * PAGE_SIZE));
      if (status) qs.set("status", status);
      const r = await api.get<{ skills: SkillDTO[]; nextOffset?: number; total?: number }>(
        `/api/v1/skills?${qs.toString()}`,
      );
      setSkills(r.skills ?? []);
      setHasMore(r.nextOffset != null);
      setTotal(r.total ?? 0);
      setPage(nextPage);
    } catch {
      setSkills([]);
      setHasMore(false);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load(0);
  }, [status]);

  // Deep-link: `#/skills?id=sk_xxx` auto-opens the drawer.
  useEffect(() => {
    const id = route.value.params.id;
    if (!id) return;
    const ctrl = new AbortController();
    api
      .get<{ skills: SkillDTO[] }>(
        `/api/v1/skills?limit=500`,
        { signal: ctrl.signal },
      )
      .then((r) => {
        const match = (r.skills ?? []).find((s) => s.id === id);
        if (match) setDetail(match);
      })
      .catch(() => void 0);
    return () => ctrl.abort();
  }, [route.value.params.id]);

  const filtered = (skills ?? []).filter((s) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      s.name.toLowerCase().includes(q) ||
      s.invocationGuide.toLowerCase().includes(q)
    );
  });

  return (
    <>
      <div class="view-header">
        <div class="view-header__title">
          <h1>{t("skills.title")}</h1>
          <p>{t("skills.subtitle")}</p>
        </div>
        <div class="view-header__actions">
          {/*
           * Refresh — matches MemoriesView / TasksView / PoliciesView /
           * WorldModelsView. Clears search + status filter, drops
           * selection, and re-fetches page 0 so the list visibly
           * snaps back to "fresh top state". The old implementation
           * only re-queried the CURRENT page with the CURRENT filters
           * still applied, which looked like a no-op whenever the
           * filtered slice hadn't actually changed.
           */}
          <button
            class="btn btn--ghost btn--sm"
            onClick={() => {
              setQuery("");
              setStatus("");
              setSelected(new Set());
              void load(0);
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
            placeholder={t("skills.search.placeholder")}
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
        </label>
      </div>

      <div class="toolbar" style="margin-top:calc(-1 * var(--sp-2))">
        <div class="toolbar__group" role="group" aria-label={t("common.filter")}>
          {[
            { v: "" as StatusFilter, k: "common.all" as const },
            { v: "active" as StatusFilter, k: "status.active" as const },
            { v: "candidate" as StatusFilter, k: "status.candidate" as const },
            { v: "archived" as StatusFilter, k: "status.archived" as const },
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
            <div key={i} class="skeleton" style="height:64px" />
          ))}
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div class="empty">
          <div class="empty__icon">
            <Icon name="wand-sparkles" size={22} />
          </div>
          <div class="empty__title">{t("skills.empty")}</div>
          <div class="empty__hint">{t("skills.empty.hint")}</div>
        </div>
      )}

      {filtered.length > 0 && (
        <div class="list">
          {filtered.map((s) => {
            const isSel = selected.has(s.id);
            return (
              <div
                key={s.id}
                class={`mem-card${isSel ? " mem-card--selected" : ""}`}
                onClick={() => setDetail(s)}
              >
                <label
                  class="mem-card__check-wrap"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    class="mem-card__check"
                    checked={isSel}
                    onChange={() => toggleSel(s.id)}
                    aria-label="select"
                  />
                </label>
                <div class="mem-card__body">
                  <div class="mem-card__title">{s.name}</div>
                  <div class="mem-card__meta">
                    <span class={`pill pill--${s.status}`}>
                      {t(`status.${s.status}` as "status.active")}
                    </span>
                    <span class="pill pill--info" title={t("skills.version.title")}>
                      v{s.version ?? 1}
                    </span>
                    <span>η {(s.eta ?? 0).toFixed(2)}</span>
                    <span>gain {(s.gain ?? 0).toFixed(2)}</span>
                    <span>support {s.support ?? 0}</span>
                    <span>
                      {t("skills.updated.ago", {
                        at: formatWhen(s.updatedAt),
                      })}
                    </span>
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

      {(page > 0 || hasMore) && (
        <div class="pager">
          <button
            class="btn btn--ghost btn--sm"
            disabled={page === 0 || loading}
            onClick={() => void load(page - 1)}
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
            onClick={() => void load(page + 1)}
          >
            {t("common.next")}
            <Icon name="chevron-right" size={14} />
          </button>
        </div>
      )}

      {detail && (
        <SkillDrawer
          skill={detail}
          onClose={() => {
            setDetail(null);
            clearEntryId();
          }}
          onChanged={() => {
            void load(page);
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
            onClick={() => setSelected(new Set(filtered.map((s) => s.id)))}
          >
            <Icon name="check-square" size={14} />
            {t("common.selectPage")}
          </button>
          <button
            class="btn btn--danger btn--sm"
            onClick={async () => {
              if (selected.size === 0) return;
              if (!confirm(t("common.bulkDelete.confirm", { n: selected.size }))) return;
              const ids = [...selected];
              await Promise.all(
                ids.map((id) =>
                  api.post("/api/v1/skills/archive", { skillId: id }).catch(() => null),
                ),
              );
              setSelected(new Set());
              void load(page);
            }}
          >
            <Icon name="archive" size={14} />
            {t("skills.detail.archive")}
          </button>
          <div class="batch-bar__spacer" />
          <button class="btn btn--ghost btn--sm" onClick={() => setSelected(new Set())}>
            {t("common.deselect")}
          </button>
        </div>
      )}
    </>
  );
}

interface TimelineEntry {
  ts: number;
  kind: string;
  phase?: string;
  durationMs: number;
  success: boolean;
  summary?: string;
}

function SkillDrawer({
  skill,
  onClose,
  onChanged,
}: {
  skill: SkillDTO;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "share">("view");
  const [name, setName] = useState(skill.name);
  const [guide, setGuide] = useState(skill.invocationGuide ?? "");
  const [scope, setScope] = useState<"private" | "public" | "hub">(
    skill.share?.scope ?? "public",
  );
  const [busy, setBusy] = useState(false);
  const [timeline, setTimeline] = useState<TimelineEntry[] | null>(null);
  const [usage, setUsage] = useState<SkillUsage | null>(null);

  useEffect(() => {
    setName(skill.name);
    setGuide(skill.invocationGuide ?? "");
    setScope(skill.share?.scope ?? "public");
  }, [skill]);

  useEffect(() => {
    const ctrl = new AbortController();
    api
      .get<{ entries: TimelineEntry[] }>(
        `/api/v1/skills/${encodeURIComponent(skill.id)}/timeline`,
        { signal: ctrl.signal },
      )
      .then((r) => setTimeline(r.entries ?? []))
      .catch(() => setTimeline([]));
    return () => ctrl.abort();
  }, [skill.id]);

  // Separate fetch: resolve source-policy / source-world-model ids to
  // their titles so the drawer renders click-through chips instead of
  // opaque `po_xxx` strings. The server does the joins.
  useEffect(() => {
    const ctrl = new AbortController();
    api
      .get<SkillUsage>(
        `/api/v1/skills/${encodeURIComponent(skill.id)}/usage`,
        { signal: ctrl.signal },
      )
      .then(setUsage)
      .catch(() => setUsage(null));
    return () => ctrl.abort();
  }, [skill.id]);

  const archive = async () => {
    setBusy(true);
    try {
      await api.post("/api/v1/skills/archive", { skillId: skill.id });
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const reactivate = async () => {
    setBusy(true);
    try {
      await api.post("/api/v1/skills/reactivate", { skillId: skill.id });
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const hardDelete = async () => {
    if (!confirm(t("skills.act.delete.confirm", { name: skill.name }))) return;
    setBusy(true);
    try {
      await api.del(`/api/v1/skills/${encodeURIComponent(skill.id)}`);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const submitEdit = async () => {
    setBusy(true);
    try {
      await api.patch(`/api/v1/skills/${encodeURIComponent(skill.id)}`, {
        name: name.trim() || skill.name,
        invocationGuide: guide,
      });
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const submitShare = async (s: "private" | "public" | "hub" | null) => {
    setBusy(true);
    try {
      await api.post(`/api/v1/skills/${encodeURIComponent(skill.id)}/share`, {
        scope: s,
      });
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const downloadZip = () => {
    const url = withAgentPrefix(
      `/api/v1/skills/${encodeURIComponent(skill.id)}/download`,
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${skill.name.replace(/[^\w.-]+/g, "_") || "skill"}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div class="drawer-backdrop" onClick={onClose}>
      <aside class="drawer" role="dialog" onClick={(e) => e.stopPropagation()}>
        <header class="drawer__header">
          <div>
            <div class="muted mono" style="font-size:var(--fs-xs);margin-bottom:2px">
              skill {skill.id.slice(0, 16)}
            </div>
            <h2 class="drawer__title">{skill.name}</h2>
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
          {/*
           * Metadata section — styled as a text-based <dl> grid to
           * match the other drawers (Memories / Tasks / Policies /
           * WorldModels).
           */}
          <section class="card card--flat">
            <h3 class="card__title" style="font-size:var(--fs-md)">
              {t("tasks.detail.meta")}
            </h3>
            <dl style="display:grid;grid-template-columns:120px 1fr;gap:6px 16px;margin:0;font-size:var(--fs-sm)">
              <dt class="muted">{t("memories.field.status")}</dt>
              <dd>
                <span class={`pill pill--${skill.status}`}>
                  {t(`status.${skill.status}` as "status.active")}
                </span>
              </dd>
              <dt class="muted">{t("skills.detail.version")}</dt>
              <dd>v{skill.version ?? 1}</dd>
              <dt class="muted">{t("memories.field.eta")}</dt>
              <dd>{(skill.eta ?? 0).toFixed(3)}</dd>
              <dt class="muted">{t("memories.field.gain")}</dt>
              <dd>{(skill.gain ?? 0).toFixed(3)}</dd>
              <dt class="muted">{t("memories.field.support")}</dt>
              <dd>{skill.support ?? 0}</dd>
              <dt class="muted">{t("memories.field.updatedAt")}</dt>
              <dd>{formatWhen(skill.updatedAt)}</dd>
            </dl>
          </section>

          <section class="card card--flat">
            <h3 class="card__title" style="font-size:var(--fs-md)">
              {t("skills.detail.desc")}
            </h3>
            <pre
              class="mono"
              style="white-space:pre-wrap;font-size:var(--fs-sm);margin:0;color:var(--fg)"
            >
              {skill.invocationGuide || "(empty)"}
            </pre>
          </section>

          {(usage?.sourcePolicies.length ?? 0) > 0 && (
            <section class="card card--flat">
              <h3 class="card__title" style="font-size:var(--fs-md);margin-bottom:var(--sp-3)">
                {t("skills.xlink.sourcePolicies")}
              </h3>
              <div class="hstack" style="flex-wrap:wrap;gap:var(--sp-2)">
                {usage!.sourcePolicies.map((p) => (
                  <button
                    key={p.id}
                    class="pill pill--link"
                    style="cursor:pointer;border:0;font-family:inherit;font-size:var(--fs-sm)"
                    onClick={() => linkTo("policy", p.id)}
                    title={p.id}
                  >
                    {p.title ?? p.id.slice(0, 10)}
                    {p.gain != null && (
                      <span class="muted" style="margin-left:6px;font-size:var(--fs-xs)">
                        gain {p.gain.toFixed(2)}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </section>
          )}
          {(usage?.sourceWorldModels.length ?? 0) > 0 && (
            <section class="card card--flat">
              <h3 class="card__title" style="font-size:var(--fs-md);margin-bottom:var(--sp-3)">
                {t("skills.xlink.sourceWorldModels")}
              </h3>
              <div class="hstack" style="flex-wrap:wrap;gap:var(--sp-2)">
                {usage!.sourceWorldModels.map((w) => (
                  <button
                    key={w.id}
                    class="pill pill--link"
                    style="cursor:pointer;border:0;font-family:inherit;font-size:var(--fs-sm)"
                    onClick={() => linkTo("world-model", w.id)}
                    title={w.id}
                  >
                    {w.title ?? w.id.slice(0, 10)}
                  </button>
                ))}
              </div>
            </section>
          )}

          {/*
           * V7 §2.4.6 — decision guidance distilled by the crystallizer
           * from past failures + user feedback. Empty arrays mean
           * "nothing was learned yet"; we hide the section in that case
           * so the drawer stays uncluttered.
           */}
          {(skill.decisionGuidance.preference.length > 0 ||
            skill.decisionGuidance.antiPattern.length > 0) && (
            <section class="card card--flat">
              <h3 class="card__title" style="font-size:var(--fs-md);margin-bottom:var(--sp-3)">
                {t("skills.detail.decisionGuidance")}
              </h3>
              {skill.decisionGuidance.preference.length > 0 && (
                <div style="margin-bottom:var(--sp-3)">
                  <div class="muted" style="font-size:var(--fs-xs);margin-bottom:4px">
                    {t("skills.detail.decisionGuidance.prefer")}
                  </div>
                  <ul style="margin:0;padding-left:18px;font-size:var(--fs-sm);line-height:1.55">
                    {skill.decisionGuidance.preference.map((p, i) => (
                      <li key={`p-${i}`}>{p}</li>
                    ))}
                  </ul>
                </div>
              )}
              {skill.decisionGuidance.antiPattern.length > 0 && (
                <div>
                  <div class="muted" style="font-size:var(--fs-xs);margin-bottom:4px">
                    {t("skills.detail.decisionGuidance.avoid")}
                  </div>
                  <ul style="margin:0;padding-left:18px;font-size:var(--fs-sm);line-height:1.55">
                    {skill.decisionGuidance.antiPattern.map((a, i) => (
                      <li key={`a-${i}`}>{a}</li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          {/*
           * V7 §2.1 evidence_anchors — direct trace-level provenance.
           * Click-through chips deep-link into MemoriesView so the user
           * can audit "which memories justified this skill?".
           */}
          {skill.evidenceAnchors.length > 0 && (
            <section class="card card--flat">
              <h3 class="card__title" style="font-size:var(--fs-md);margin-bottom:var(--sp-3)">
                {t("skills.detail.evidenceAnchors", {
                  n: skill.evidenceAnchors.length,
                })}
              </h3>
              <div class="hstack" style="flex-wrap:wrap;gap:var(--sp-2)">
                {skill.evidenceAnchors.map((traceId) => (
                  <button
                    key={traceId}
                    class="pill pill--link mono"
                    style="cursor:pointer;border:0;font-family:var(--font-mono);font-size:var(--fs-xs)"
                    // Trace ids open the Memories tab — traces surface
                    // there one-row-per-step (collapsed by turnId into
                    // memory cards). The cross-link store doesn't have
                    // a "trace" entity kind because the user-facing
                    // unit is "memory", not "trace".
                    onClick={() => linkTo("memory", traceId)}
                    title={traceId}
                  >
                    {traceId.slice(0, 12)}
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Evolution timeline — sourced from api_logs skill_generate
              / skill_evolve events. Empty until the first crystallisation
              event is recorded; every rebuild produces one more row. */}
          <section class="card card--flat">
            <h3 class="card__title" style="font-size:var(--fs-md);margin-bottom:var(--sp-3)">
              {t("skills.detail.evolution")}
            </h3>
            {timeline === null ? (
              <div class="skeleton" style="height:60px" />
            ) : timeline.length === 0 ? (
              <div class="muted" style="font-size:var(--fs-sm)">
                {t("skills.detail.evolution.empty")}
              </div>
            ) : (
              <div class="vstack" style="gap:6px">
                {timeline.map((e, i) => (
                  <div
                    key={i}
                    class="hstack"
                    style="gap:var(--sp-3);padding:8px 10px;background:var(--bg-canvas);border-radius:var(--radius-sm);align-items:flex-start;font-size:var(--fs-sm)"
                  >
                    <span class="muted mono" style="font-size:var(--fs-xs);min-width:80px">
                      {formatWhen(e.ts)}
                    </span>
                    <span
                      class={`pill ${e.success ? "pill--active" : "pill--failed"}`}
                      style="font-size:var(--fs-2xs)"
                    >
                      {skillTimelineLabel(e.kind, e.phase)}
                    </span>
                    {/*
                     * The raw `phase` ("started" / "done" / "failed")
                     * duplicates the kind label ("结晶完成" already
                     * implies done) and renders as opaque English on
                     * the Chinese viewer. We fold it into the kind
                     * label above instead of showing a second pill.
                     */}
                    {e.summary && (
                      <span class="truncate" style="flex:1;min-width:0">
                        {e.summary}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
          </>)}

          {mode === "edit" && (
            <>
              <section class="card card--flat">
                <div class="modal__field">
                  <label>{t("skills.edit.name")}</label>
                  <input
                    class="input"
                    value={name}
                    onInput={(e) => setName((e.target as HTMLInputElement).value)}
                  />
                </div>
              </section>
              <section class="card card--flat">
                <div class="modal__field">
                  <label>{t("skills.edit.invocationGuide")}</label>
                  <textarea
                    class="textarea"
                    rows={14}
                    value={guide}
                    onInput={(e) => setGuide((e.target as HTMLTextAreaElement).value)}
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
                        name="skill-share-scope"
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
                onClick={hardDelete}
              >
                <Icon name="trash-2" size={14} />
                {t("memories.act.delete")}
              </button>
              <div class="batch-bar__spacer" />
              {skill.status === "archived" ? (
                <button
                  class="btn btn--sm"
                  disabled={busy}
                  onClick={reactivate}
                >
                  <Icon name="check-circle-2" size={14} />
                  {t("policies.act.activate")}
                </button>
              ) : (
                <button class="btn btn--sm" disabled={busy} onClick={archive}>
                  <Icon name="archive" size={14} />
                  {t("skills.detail.archive")}
                </button>
              )}
              <button class="btn btn--sm" disabled={busy} onClick={downloadZip}>
                <Icon name="download" size={14} />
                {t("skills.detail.download")}
              </button>
              <button class="btn btn--sm" disabled={busy} onClick={() => setMode("share")}>
                <Icon name="share" size={14} />
                {skill.share?.scope
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
              {skill.share?.scope && (
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

function formatWhen(ts: number | undefined): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "—";
  }
}

/**
 * Friendly label for timeline `kind`. Falls back to the raw kind when
 * the event name isn't in the lookup — new event types should still
 * render rather than silently disappear.
 *
 * For rows where the recorded kind is just the raw tool name
 * (`skill_generate` / `skill_evolve`), we use the row's `phase` field
 * to pick the most specific label: e.g. `skill_generate` + phase
 * `done` reads as "结晶完成" rather than the opaque "skill_generate".
 */
function skillTimelineLabel(kind: string, phase?: string): string {
  switch (kind) {
    case "skill.crystallized":
      return t("skills.timeline.kind.crystallized");
    case "skill.crystallization.started":
      return t("skills.timeline.kind.started");
    case "skill.rebuilt":
      return t("skills.timeline.kind.rebuilt");
    case "skill.eta.updated":
      return t("skills.timeline.kind.etaUpdated");
    case "skill.status.changed":
      return t("skills.timeline.kind.statusChanged");
    case "skill.archived":
      return t("skills.timeline.kind.archived");
    case "skill.verification.failed":
      return t("skills.timeline.kind.verifyFailed");
    case "skill.failed":
      return t("skills.timeline.kind.failed");
    case "skill_generate":
      if (phase === "started") return t("skills.timeline.kind.started");
      if (phase === "done") return t("skills.timeline.kind.crystallized");
      if (phase === "failed") return t("skills.timeline.kind.failed");
      return t("skills.timeline.kind.crystallized");
    case "skill_evolve":
      return t("skills.timeline.kind.rebuilt");
    default:
      return kind;
  }
}
