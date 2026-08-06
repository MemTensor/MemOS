/**
 * Hub status panel — inline Team Sharing status. Hub mode exposes
 * approval/member management; client mode only shows this node's join
 * status.
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
  status?: "disabled" | "starting" | "running" | "pending" | "connected" | "error";
  error?: string;
  url?: string;
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
    role?: string;
    status?: string;
    memoryCount?: number;
    skillCount?: number;
  }>;
}

type InnerTab = "pending" | "users";

export function HubAdminPanel({ hasUnsavedHubChanges = false }: { hasUnsavedHubChanges?: boolean }) {
  const [data, setData] = useState<AdminPayload | null>(null);
  const [tab, setTab] = useState<InnerTab>("pending");
  const [loading, setLoading] = useState(true);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  const load = (signal?: AbortSignal) => {
    setLoading(true);
    return api
      .get<AdminPayload>("/api/v1/hub/admin", { signal })
      .then(setData)
      .catch(() => setData({ enabled: false }))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, []);

  const decide = async (userId: string, action: "approve" | "reject" | "remove") => {
    if (action === "remove" && !confirm(t("admin.remove.confirm"))) return;
    setBusyUserId(userId);
    try {
      const route = action === "approve"
        ? "approve-user"
        : action === "reject"
          ? "reject-user"
          : "remove-user";
      await api.post(`/api/v1/hub/admin/${route}`, { userId });
      await load();
    } finally {
      setBusyUserId(null);
    }
  };

  if (loading) {
    return <div class="skeleton" style="height:140px" />;
  }

  if (hasUnsavedHubChanges) {
    return (
      <div
        style="font-size:var(--fs-xs);padding:var(--sp-3);border:1px dashed var(--border);border-radius:var(--radius-md);background:var(--bg-canvas);color:var(--fg-muted)"
      >
        {t("admin.unsaved.desc")}
      </div>
    );
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
  const primaryUser = users[0];

  if (data.role === "client") {
    return (
      <div class="vstack" style="gap:var(--sp-3)">
        <div class="hstack" style="gap:var(--sp-2);justify-content:space-between;align-items:flex-start;flex-wrap:wrap">
          <div class="muted" style="font-size:var(--fs-xs)">
            {data.url ? `${data.status ?? "client"} · ${data.url}` : data.status ?? "client"}
            {data.error ? ` · ${data.error}` : ""}
          </div>
          <button class="btn btn--ghost btn--sm" onClick={() => void load()} disabled={loading}>
            <Icon name="refresh-cw" size={14} />
            {t("common.refresh")}
          </button>
        </div>

        <div class="list">
          {primaryUser ? (
            <div class="row" style="cursor:default">
              <div class="row__body">
                <div class="row__title">{primaryUser.name || t("admin.client.unknownMember")}</div>
                <div class="row__meta">
                  <span class={`pill pill--${primaryUser.connected ? "active" : "subtle"}`}>
                    <span class="dot" /> {clientStatusLabel(primaryUser.status, primaryUser.connected)}
                  </span>
                  {primaryUser.role && <span>{primaryUser.role}</span>}
                </div>
              </div>
            </div>
          ) : (
            <div class="muted" style="font-size:var(--fs-xs);padding:var(--sp-3)">
              {t("admin.client.notJoined")}
            </div>
          )}
        </div>

        <div class="muted" style="font-size:var(--fs-xs)">
          {data.status === "pending"
            ? t("admin.client.pendingDesc")
            : data.status === "connected"
              ? t("admin.client.connectedDesc")
              : t("admin.client.refreshDesc")}
        </div>
      </div>
    );
  }

  return (
    <div class="vstack" style="gap:var(--sp-3)">
      <div class="hstack" style="gap:var(--sp-2);justify-content:space-between;align-items:flex-start;flex-wrap:wrap">
        <div class="muted" style="font-size:var(--fs-xs)">
          {data.role === "hub" && data.url ? `${data.status ?? "running"} · ${data.url}` : data.status ?? data.role}
          {data.error ? ` · ${data.error}` : ""}
        </div>
        <button class="btn btn--ghost btn--sm" onClick={() => void load()} disabled={loading}>
          <Icon name="refresh-cw" size={14} />
          {t("common.refresh")}
        </button>
      </div>

      <div class="segmented">
        {[
          { v: "pending" as InnerTab, k: "admin.tab.pending" as const, count: pending.length },
          { v: "users" as InnerTab, k: "admin.tab.users" as const, count: users.length },
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
                  <button
                    class="btn btn--sm"
                    disabled={!!busyUserId}
                    onClick={() => void decide(p.id, "approve")}
                  >
                    <Icon name="check" size={14} />
                    {t("admin.approve")}
                  </button>
                  <button
                    class="btn btn--danger btn--sm"
                    disabled={!!busyUserId}
                    onClick={() => void decide(p.id, "reject")}
                  >
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
                      <span class="dot" /> {u.connected ? "online" : u.status || "offline"}
                    </span>
                    {u.role && <span>{u.role}</span>}
                    {u.groupName && <span>{u.groupName}</span>}
                    {typeof u.memoryCount === "number" && <span>{u.memoryCount} memories</span>}
                    {typeof u.skillCount === "number" && <span>{u.skillCount} skills</span>}
                  </div>
                </div>
                {u.role !== "admin" && (
                  <div class="row__tail">
                    <button
                      class="btn btn--danger btn--sm"
                      disabled={!!busyUserId}
                      onClick={() => void decide(u.id, "remove")}
                    >
                      <Icon name="x" size={14} />
                      {t("admin.remove")}
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function clientStatusLabel(status: string | undefined, connected: boolean): string {
  if (connected) return t("admin.client.connected");
  if (status === "pending") return t("admin.client.pending");
  if (status === "rejected") return t("admin.client.rejected");
  if (status === "blocked") return t("admin.client.blocked");
  if (status === "removed") return t("admin.client.removed");
  if (status === "token_expired") return t("admin.client.tokenExpired");
  if (status === "invalid_team_token") return t("admin.client.invalidTeamToken");
  if (status === "missing_team_token") return t("admin.client.missingTeamToken");
  if (status === "hub_changed") return t("admin.client.hubChanged");
  if (status === "not_registered") return t("admin.client.notRegistered");
  if (status === "username_taken") return t("admin.client.usernameTaken");
  return status || t("admin.client.disconnected");
}
