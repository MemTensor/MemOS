/**
 * Hub admin panel — inline version of the old `/admin` view, meant to
 * be nested inside Settings → Team Sharing when the user enables
 * hub membership. Mirrors the legacy viewer's IA where team admin
 * lived under Settings, not as a sibling nav item.
 *
 * Data: `GET /api/v1/hub/admin` — the same endpoint the standalone
 * AdminView used. Rendering is identical, minus the page header.
 */
import { useEffect, useState } from "preact/hooks";
import { api } from "../api/client";
import { t } from "../stores/i18n";
import { Icon } from "./Icon";

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

type InnerTab = "pending" | "users" | "groups";

export function HubAdminPanel() {
  const [data, setData] = useState<AdminPayload | null>(null);
  const [tab, setTab] = useState<InnerTab>("pending");
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
    return <div class="skeleton" style="height:140px" />;
  }

  // When the daemon hasn't connected to a hub yet we just show a
  // one-line hint — the user is already inside Settings → Team Sharing
  // at this point, so they can see the form fields right above.
  if (!data?.enabled) {
    return (
      <div class="muted" style="font-size:var(--fs-xs);padding:var(--sp-3) 0">
        {t("admin.disabled.desc")}
      </div>
    );
  }

  const pending = data.pending ?? [];
  const users = data.users ?? [];
  const groups = data.groups ?? [];

  return (
    <div class="vstack" style="gap:var(--sp-3)">
      <div class="segmented">
        {[
          { v: "pending" as InnerTab, k: "admin.tab.pending" as const, count: pending.length },
          { v: "users" as InnerTab, k: "admin.tab.users" as const, count: users.length },
          { v: "groups" as InnerTab, k: "admin.tab.groups" as const, count: groups.length },
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
            <div class="muted" style="font-size:var(--fs-xs);padding:var(--sp-3)">
              {t("common.empty")}
            </div>
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
                    {t("admin.approve")}
                  </button>
                  <button class="btn btn--danger btn--sm">
                    <Icon name="x" size={14} />
                    {t("admin.deny")}
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
            <div class="muted" style="font-size:var(--fs-xs);padding:var(--sp-3)">
              {t("common.empty")}
            </div>
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
            <div class="muted" style="font-size:var(--fs-xs);padding:var(--sp-3)">
              {t("common.empty")}
            </div>
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
    </div>
  );
}
