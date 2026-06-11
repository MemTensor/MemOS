import { createHash } from "node:crypto";
import os from "node:os";

import type { ResolvedConfig } from "../config/index.js";
import type { Logger } from "../logger/types.js";
import type { ClientHubConnection } from "../storage/repos/hub.js";

type HubRepo = import("../storage/repos/index.js").Repos["hub"];

const REQUEST_TIMEOUT_MS = 20_000;

export interface HubClientStatus {
  connected: boolean;
  hubUrl?: string;
  user: null | Record<string, unknown>;
  error?: string;
}

export class PendingApprovalError extends Error {
  constructor(public readonly userId: string) {
    super("Awaiting hub admin approval");
    this.name = "PendingApprovalError";
  }
}

export class HubClientRuntime {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pendingPollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly deps: {
      repo: HubRepo;
      config: ResolvedConfig;
      log: Logger;
    },
  ) {}

  async start(): Promise<ClientHubConnection | null> {
    const hubAddress = this.deps.config.hub.address;
    const hubUrl = normalizeHubUrl(hubAddress);
    if (!hubUrl) {
      throw new Error("hub.address is required when hub.role=client");
    }

    try {
      const conn = await this.connect(hubUrl);
      this.startHeartbeat();
      return conn;
    } catch (err) {
      if (err instanceof PendingApprovalError) {
        this.deps.log.info("hub.client.pending_approval", { userId: err.userId, hubUrl });
        this.startPendingPoll();
        return this.deps.repo.getClientConnection();
      }
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pendingPollTimer) clearInterval(this.pendingPollTimer);
    this.heartbeatTimer = null;
    this.pendingPollTimer = null;
  }

  status(): HubClientStatus {
    const conn = this.deps.repo.getClientConnection();
    if (!conn) return { connected: false, user: null };
    return {
      connected: !!conn.userToken && conn.lastKnownStatus === "active",
      hubUrl: conn.hubUrl,
      user: {
        id: conn.userId,
        username: conn.username,
        name: conn.username,
        role: conn.role,
        status: conn.lastKnownStatus || (conn.userToken ? "active" : "pending"),
      },
    };
  }

  async refreshStatus(): Promise<HubClientStatus> {
    const conn = this.deps.repo.getClientConnection();
    const configuredHubUrl = normalizeHubUrl(this.deps.config.hub.address);
    const hubUrl = conn?.hubUrl || configuredHubUrl;
    if (!hubUrl) return { connected: false, user: null };

    if (conn?.hubUrl && configuredHubUrl && conn.hubUrl !== configuredHubUrl) {
      this.deps.repo.setClientConnection({
        ...conn,
        hubUrl: configuredHubUrl,
        userToken: "",
        lastKnownStatus: "hub_changed",
      });
      return this.status();
    }

    const persistedToken = conn?.userToken || "";
    const legacyConfiguredToken = secretValue(this.deps.config.hub.userToken);
    const userToken = persistedToken || legacyConfiguredToken;
    const teamToken = secretValue(this.deps.config.hub.teamToken);

    if (!teamToken) {
      if (conn) {
        this.deps.repo.setClientConnection({
          ...conn,
          hubUrl,
          userToken: "",
          lastKnownStatus: "missing_team_token",
        });
      }
      return { ...this.status(), error: "hub.teamToken is required to join a hub" };
    }

    if (conn?.userId) {
      try {
        const checked = await this.checkRegistrationStatus(hubUrl, conn, teamToken);
        if (checked) {
          this.stopPendingPoll();
          this.startHeartbeat();
          return await this.refreshActiveUser(hubUrl, checked.userToken, checked);
        }
      } catch (err) {
        if (err instanceof PendingApprovalError) return this.status();
        if (isInvalidTeamTokenHubError(err)) {
          this.markConnectionStatus(conn, hubUrl, "invalid_team_token");
          return { ...this.status(), error: "invalid_team_token" };
        }
        if (isUsernameTakenHubError(err)) {
          this.markConnectionStatus(conn, hubUrl, "username_taken");
          return { ...this.status(), error: "username_taken" };
        }
        this.deps.log.debug("hub.client.registration_status_refresh_failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
      return this.status();
    }

    if (!userToken) return this.status();

    try {
      const refreshed = await this.refreshActiveUser(hubUrl, userToken, conn ?? undefined);
      const latestConn = this.deps.repo.getClientConnection();
      if (latestConn?.userId) {
        const checked = await this.checkRegistrationStatus(hubUrl, latestConn, teamToken);
        if (checked) return await this.refreshActiveUser(hubUrl, checked.userToken, checked);
      }
      this.stopPendingPoll();
      this.startHeartbeat();
      return refreshed;
    } catch (err) {
      if (err instanceof PendingApprovalError) return this.status();
      if (isInvalidTeamTokenHubError(err)) {
        const latestConn = this.deps.repo.getClientConnection();
        if (latestConn) this.markConnectionStatus(latestConn, hubUrl, "invalid_team_token");
        return { ...this.status(), error: "invalid_team_token" };
      }
      if (isUsernameTakenHubError(err)) {
        const latestConn = this.deps.repo.getClientConnection();
        if (latestConn) this.markConnectionStatus(latestConn, hubUrl, "username_taken");
        return { ...this.status(), error: "username_taken" };
      }
      if (conn && isUnauthorizedHubError(err)) {
        if (teamToken) {
          try {
            const checked = await this.checkRegistrationStatus(hubUrl, conn, teamToken);
            if (checked) {
              this.stopPendingPoll();
              this.startHeartbeat();
              return await this.refreshActiveUser(hubUrl, checked.userToken, checked);
            }
          } catch (statusErr) {
            if (statusErr instanceof PendingApprovalError) return this.status();
            if (isInvalidTeamTokenHubError(statusErr)) {
              this.markConnectionStatus(conn, hubUrl, "invalid_team_token");
              return { ...this.status(), error: "invalid_team_token" };
            }
            if (isUsernameTakenHubError(statusErr)) {
              this.markConnectionStatus(conn, hubUrl, "username_taken");
              return { ...this.status(), error: "username_taken" };
            }
            this.deps.log.debug("hub.client.registration_status_refresh_failed", {
              err: statusErr instanceof Error ? statusErr.message : String(statusErr),
            });
          }
        }
        this.deps.repo.setClientConnection({
          ...conn,
          hubUrl,
          userToken: "",
          lastKnownStatus: "token_expired",
        });
        return this.status();
      }
      this.deps.log.debug("hub.client.status_refresh_failed", {
        err: err instanceof Error ? err.message : String(err),
      });
      return this.status();
    }
  }

  async requestJson<T>(route: string, init: RequestInit = {}): Promise<T> {
    const conn = this.deps.repo.getClientConnection();
    if (!conn?.hubUrl || !conn.userToken) {
      throw new Error("hub client is not connected");
    }
    return hubRequestJson<T>(conn.hubUrl, conn.userToken, route, init);
  }

  private async connect(hubUrl: string): Promise<ClientHubConnection> {
    const persisted = this.deps.repo.getClientConnection();
    const persistedToken = persisted?.userToken || "";
    // `hub.userToken` is kept only for legacy/manual configs. Normal
    // users join with a team token; the approved member credential is
    // stored in client_hub_connection.
    const legacyConfiguredToken = secretValue(this.deps.config.hub.userToken);
    const teamToken = secretValue(this.deps.config.hub.teamToken);

    if (!teamToken) {
      if (persisted) this.markConnectionStatus(persisted, hubUrl, "missing_team_token");
      throw new Error("hub.teamToken is required to join a hub");
    }

    if (persisted?.userId) {
      try {
        const checked = await this.checkRegistrationStatus(hubUrl, persisted, teamToken);
        if (checked) return checked;
      } catch (err) {
        if (err instanceof PendingApprovalError) throw err;
        if (isInvalidTeamTokenHubError(err)) {
          this.markConnectionStatus(persisted, hubUrl, "invalid_team_token");
          throw err;
        }
        if (isUsernameTakenHubError(err)) {
          this.markConnectionStatus(persisted, hubUrl, "username_taken");
          throw err;
        }
        if (!isHubNotFoundError(err)) throw err;
        this.markConnectionStatus(persisted, hubUrl, "not_registered");
      }
    }

    const userToken = persistedToken || legacyConfiguredToken;
    if (userToken) {
      try {
        const [me, info] = await Promise.all([
          hubRequestJson<Record<string, unknown>>(hubUrl, userToken, "/api/v1/hub/me", { method: "GET" }),
          hubRequestJson<Record<string, unknown>>(hubUrl, "", "/api/v1/hub/info", { method: "GET" })
            .catch((): Record<string, unknown> => ({})),
        ]);
        const conn: ClientHubConnection = {
          hubUrl,
          userId: String(me.id ?? ""),
          username: String(me.username ?? me.name ?? ""),
          userToken,
          role: String(me.role ?? "member") === "admin" ? "admin" : "member",
          connectedAt: Date.now(),
          identityKey: persisted?.identityKey || "",
          lastKnownStatus: "active",
          hubInstanceId: String(info.hubInstanceId ?? persisted?.hubInstanceId ?? ""),
        };
        const checked = await this.checkRegistrationStatus(hubUrl, conn, teamToken);
        if (checked) return checked;
        this.deps.repo.setClientConnection(conn);
        this.rememberJoinConfig(hubUrl, teamToken);
        return conn;
      } catch (err) {
        if (!isUnauthorizedHubError(err)) throw err;
        this.deps.log.info("hub.client.token_rejected_rejoin", { hubUrl });
        if (persisted?.userId) {
          const checked = await this.checkRegistrationStatus(hubUrl, {
            ...persisted,
            hubUrl,
            userToken: "",
            lastKnownStatus: "unknown",
          }, teamToken);
          if (checked) return checked;
        }
      }
    }

    if (!teamToken) {
      throw new Error("hub.teamToken is required to join a hub");
    }
    return this.autoJoin(hubUrl, teamToken, persisted);
  }

  private async refreshActiveUser(
    hubUrl: string,
    userToken: string,
    existing?: ClientHubConnection,
  ): Promise<HubClientStatus> {
    const [me, info] = await Promise.all([
      hubRequestJson<Record<string, unknown>>(hubUrl, userToken, "/api/v1/hub/me", { method: "GET" }),
      hubRequestJson<Record<string, unknown>>(hubUrl, "", "/api/v1/hub/info", { method: "GET" })
        .catch((): Record<string, unknown> => ({})),
    ]);
    const conn: ClientHubConnection = {
      hubUrl,
      userId: String(me.id ?? existing?.userId ?? ""),
      username: String(me.username ?? me.name ?? existing?.username ?? ""),
      userToken,
      role: String(me.role ?? existing?.role ?? "member") === "admin" ? "admin" : "member",
      connectedAt: Date.now(),
      identityKey: existing?.identityKey || "",
      lastKnownStatus: String(me.status ?? "active"),
      hubInstanceId: String(info.hubInstanceId ?? existing?.hubInstanceId ?? ""),
    };
    this.deps.repo.setClientConnection(conn);
    return this.status();
  }

  private async checkRegistrationStatus(
    hubUrl: string,
    persisted: ClientHubConnection,
    teamToken: string,
  ): Promise<ClientHubConnection | null> {
    const result = await hubRequestJson<Record<string, unknown>>(hubUrl, "", "/api/v1/hub/registration-status", {
      method: "POST",
      body: JSON.stringify({
        teamToken,
        userId: persisted.userId,
        username: this.currentUsername(),
        identityKey: persisted.identityKey,
      }),
    });
    const status = String(result.status || "");
    if (status === "active" && result.userToken) {
      const conn: ClientHubConnection = {
        ...persisted,
        hubUrl,
        userId: String(result.userId || persisted.userId),
        username: String(result.username || persisted.username || this.currentUsername()),
        userToken: String(result.userToken),
        connectedAt: Date.now(),
        identityKey: String(result.identityKey || persisted.identityKey || ""),
        lastKnownStatus: "active",
      };
      this.deps.repo.setClientConnection(conn);
      this.rememberJoinConfig(hubUrl, teamToken);
      return conn;
    }
    if (status === "pending") {
      this.deps.repo.setClientConnection({
        ...persisted,
        hubUrl,
        userId: String(result.userId || persisted.userId),
        username: String(result.username || persisted.username || this.currentUsername()),
        userToken: "",
        identityKey: String(result.identityKey || persisted.identityKey || ""),
        lastKnownStatus: "pending",
      });
      this.rememberJoinConfig(hubUrl, teamToken);
      throw new PendingApprovalError(String(result.userId || persisted.userId));
    }
    if (status) {
      this.deps.repo.setClientConnection({
        ...persisted,
        hubUrl,
        username: String(result.username || persisted.username || this.currentUsername()),
        userToken: "",
        lastKnownStatus: status,
      });
      this.rememberJoinConfig(hubUrl, teamToken);
    }
    return null;
  }

  private async autoJoin(
    hubUrl: string,
    teamToken: string,
    persisted: ClientHubConnection | null,
  ): Promise<ClientHubConnection> {
    const hostname = os.hostname() || "unknown";
    const username = this.currentUsername();
    const info = await hubRequestJson<Record<string, unknown>>(hubUrl, "", "/api/v1/hub/info", { method: "GET" })
      .catch((): Record<string, unknown> => ({}));
    const result = await hubRequestJson<Record<string, unknown>>(hubUrl, "", "/api/v1/hub/join", {
      method: "POST",
      body: JSON.stringify({
        teamToken,
        username,
        deviceName: hostname,
        identityKey: persisted?.identityKey || "",
        clientIp: firstLanIp(),
      }),
    });
    const identityKey = String(result.identityKey || persisted?.identityKey || "");
    if (result.status === "pending") {
      const pending: ClientHubConnection = {
        hubUrl,
        userId: String(result.userId || ""),
        username,
        userToken: "",
        role: "member",
        connectedAt: Date.now(),
        identityKey,
        lastKnownStatus: "pending",
        hubInstanceId: String(info.hubInstanceId ?? ""),
      };
      this.deps.repo.setClientConnection(pending);
      this.rememberJoinConfig(hubUrl, teamToken);
      throw new PendingApprovalError(pending.userId);
    }
    if (result.status !== "active" || !result.userToken) {
      throw new Error(`hub join failed: ${JSON.stringify(result)}`);
    }
    const conn: ClientHubConnection = {
      hubUrl,
      userId: String(result.userId || ""),
      username,
      userToken: String(result.userToken),
      role: "member",
      connectedAt: Date.now(),
      identityKey,
      lastKnownStatus: "active",
      hubInstanceId: String(info.hubInstanceId ?? ""),
    };
    this.deps.repo.setClientConnection(conn);
    this.rememberJoinConfig(hubUrl, teamToken);
    return conn;
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      void this.requestJson("/api/v1/hub/heartbeat", { method: "POST" })
        .catch((err) => this.deps.log.debug("hub.client.heartbeat_failed", {
          err: err instanceof Error ? err.message : String(err),
        }));
    }, 30_000);
  }

  private startPendingPoll(): void {
    if (this.pendingPollTimer) return;
    this.pendingPollTimer = setInterval(() => {
      const hubUrl = normalizeHubUrl(this.deps.config.hub.address);
      const teamToken = secretValue(this.deps.config.hub.teamToken);
      const persisted = this.deps.repo.getClientConnection();
      if (!hubUrl || !teamToken || !persisted?.userId) return;
      void this.checkRegistrationStatus(hubUrl, persisted, teamToken)
        .then((conn) => {
          if (conn) {
            this.deps.log.info("hub.client.approved", { userId: conn.userId, hubUrl });
            if (this.pendingPollTimer) clearInterval(this.pendingPollTimer);
            this.pendingPollTimer = null;
            this.startHeartbeat();
          }
        })
        .catch((err) => {
          if (err instanceof PendingApprovalError) return;
          this.deps.log.debug("hub.client.pending_poll_failed", {
            err: err instanceof Error ? err.message : String(err),
          });
        });
    }, 30_000);
  }

  private stopPendingPoll(): void {
    if (!this.pendingPollTimer) return;
    clearInterval(this.pendingPollTimer);
    this.pendingPollTimer = null;
  }

  private markConnectionStatus(conn: ClientHubConnection, hubUrl: string, status: string): void {
    this.deps.repo.setClientConnection({
      ...conn,
      hubUrl,
      userToken: "",
      lastKnownStatus: status,
    });
  }

  private rememberJoinConfig(hubUrl: string, teamToken: string): void {
    this.deps.repo.setClientJoinConfig({
      hubUrl: normalizeHubUrl(hubUrl),
      teamTokenHash: hashTeamToken(teamToken),
    });
  }

  private currentUsername(): string {
    return this.deps.config.hub.nickname || os.userInfo().username || "user";
  }
}

export async function hubRequestJson<T>(
  hubUrl: string,
  userToken: string,
  route: string,
  init: RequestInit = {},
): Promise<T> {
  const timeoutSignal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      : undefined;
  const mergedSignal =
    timeoutSignal && init.signal
      ? AbortSignal.any([timeoutSignal, init.signal])
      : (timeoutSignal ?? init.signal);
  const extraHeaders: Record<string, string> = {};
  if (userToken) extraHeaders.authorization = `Bearer ${userToken}`;
  if (init.body) extraHeaders["content-type"] = "application/json";
  const res = await fetch(`${normalizeHubUrl(hubUrl)}${route}`, {
    ...init,
    ...(mergedSignal ? { signal: mergedSignal } : {}),
    headers: mergeHeaders(init.headers, extraHeaders),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`hub request failed (${res.status}): ${text || res.statusText}`);
  }
  if (res.status === 204) return null as T;
  return await res.json() as T;
}

export function normalizeHubUrl(hubAddress: string): string {
  const trimmed = hubAddress.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

function secretValue(value: string): string {
  return value === "__memos_secret__" ? "" : value.trim();
}

function isUnauthorizedHubError(err: unknown): boolean {
  return err instanceof Error && /\(401\)|unauthorized/i.test(err.message);
}

function isInvalidTeamTokenHubError(err: unknown): boolean {
  return err instanceof Error && /\(403\).*invalid_team_token|invalid_team_token/i.test(err.message);
}

function isHubNotFoundError(err: unknown): boolean {
  return err instanceof Error && /\(404\)|not_found/i.test(err.message);
}

function isUsernameTakenHubError(err: unknown): boolean {
  return err instanceof Error && /\(409\).*username_taken|username_taken/i.test(err.message);
}

function hashTeamToken(teamToken: string): string {
  return createHash("sha256").update(teamToken).digest("hex");
}

function firstLanIp(): string {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const net of entries ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "";
}

function mergeHeaders(base: RequestInit["headers"] | undefined, extra: Record<string, string>): Headers {
  const headers = new Headers(base);
  for (const [key, value] of Object.entries(extra)) {
    headers.set(key, value);
  }
  return headers;
}
