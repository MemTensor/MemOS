/**
 * Admin view — team-sharing management (users / groups / pending
 * approvals). When team sharing is disabled in config, we show a
 * dedicated onboarding empty state that links to the Settings → Hub
 * tab instead of rendering a dead UI.
 */
import { useEffect, useState } from "preact/hooks";
import { api } from "../api/client";
import { t } from "../stores/i18n";
import { Icon } from "../components/Icon";
import { navigate } from "../stores/router";

interface AdminPayload {
  enabled: boolean;
  role?: "hub" | "client";
  pending?: Array<{
    id: string;
    name: string;
    requestedAt: number;
    groupName?: string;
  }>;
  users?: Array<{
    id: string;
    name: string;
    groupName?: string;
    connected: boolean;
  }>;
  groups?: Array<{ id: string; name: string; memberCount: number }>;
}

type Tab = "pending" | "users" | "groups";

export function AdminView() {
  const [data, setData] = useState<AdminPayload | null>(null);
  const [tab, setTab] = useState<Tab>("pending");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ctrl = new AbortController();
    api
      .get<AdminPayload>("/api/v1/hub/admin", { signal: ctrl.signal })
      .then(setData)
      .catch(() => setData({ enabled: false }))
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, []);

  if (loading) {
    return (
      <>
        <div class="view-header">
          <div class="view-header__title">
            <h1>{t("admin.title")}</h1>
            <p>{t("admin.subtitle")}</p>
          </div>
        </div>
        <div class="skeleton" style="height:180px" />
      </>
    );
  }

  if (!data?.enabled) {
    return (
      <>
        <div class="view-header">
          <div class="view-header__title">
            <h1>{t("admin.title")}</h1>
            <p>{t("admin.subtitle")}</p>
          </div>
        </div>
        <div class="empty">
          <div class="empty__icon">
            <Icon name="shield" size={22} />
          </div>
          <div class="empty__title">{t("admin.disabled.title")}</div>
          <div class="empty__hint">{t("admin.disabled.desc")}</div>
          <div style="margin-top:var(--sp-4)">
            <button class="btn btn--primary" onClick={() => navigate("/settings")}>
              <Icon name="settings-2" size={14} />
              {t("nav.settings")}
            </button>
          </div>
        </div>
      </>
    );
  }

  const pending = data.pending ?? [];
  const users = data.users ?? [];
  const groups = data.groups ?? [];

  return (
    <>
      <div class="view-header">
        <div class="view-header__title">
          <h1>{t("admin.title")}</h1>
          <p>{t("admin.subtitle")}</p>
        </div>
      </div>

      <div class="segmented" style="margin-bottom:var(--sp-5)">
        {[
          { v: "pending" as Tab, k: "admin.tab.pending" as const, count: pending.length },
          { v: "users" as Tab, k: "admin.tab.users" as const, count: users.length },
          { v: "groups" as Tab, k: "admin.tab.groups" as const, count: groups.length },
        ].map((o) => (
          <button
            key={o.v}
            class="segmented__item"
            aria-pressed={tab === o.v}
            onClick={() => setTab(o.v)}
          >
            {t(o.k)} {o.count > 0 && <span class="muted">· {o.count}</span>}
          </button>
        ))}
      </div>

      {tab === "pending" && (
        <div class="list">
          {pending.length === 0 ? (
            <EmptyTab label={t("common.empty")} />
          ) : (
            pending.map((p) => (
              <div key={p.id} class="row" style="cursor:default">
                <div class="row__body">
                  <div class="row__title">{p.name}</div>
                  <div class="row__meta">
                    {p.groupName && <span>{p.groupName}</span>}
                    <span>{new Date(p.requestedAt).toLocaleString()}</span>
                  </div>
                </div>
                <div class="row__tail">
                  <button class="btn btn--sm">
                    <Icon name="check" size={14} />
                    Approve
                  </button>
                  <button class="btn btn--danger btn--sm">
                    <Icon name="x" size={14} />
                    Deny
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {tab === "users" && (
        <div class="list">
          {users.length === 0 ? (
            <EmptyTab label={t("common.empty")} />
          ) : (
            users.map((u) => (
              <div key={u.id} class="row" style="cursor:default">
                <div class="row__body">
                  <div class="row__title">{u.name}</div>
                  <div class="row__meta">
                    <span class={`pill pill--${u.connected ? "active" : "subtle"}`}>
                      <span class="dot" /> {u.connected ? "online" : "offline"}
                    </span>
                    {u.groupName && <span>{u.groupName}</span>}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {tab === "groups" && (
        <div class="list">
          {groups.length === 0 ? (
            <EmptyTab label={t("common.empty")} />
          ) : (
            groups.map((g) => (
              <div key={g.id} class="row" style="cursor:default">
                <div class="row__body">
                  <div class="row__title">{g.name}</div>
                  <div class="row__meta">
                    <span>{g.memberCount} members</span>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </>
  );
}

function EmptyTab({ label }: { label: string }) {
  return (
    <div class="empty">
      <div class="empty__hint">{label}</div>
    </div>
  );
}
