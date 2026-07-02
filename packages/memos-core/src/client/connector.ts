import type { Logger, MemosLocalConfig } from "../types";
import type { UserRole, UserStatus } from "../sharing/types";
import type { SqliteStore } from "../storage/sqlite";
import { hubRequestJson, normalizeHubUrl } from "./hub";

export interface HubSessionInfo {
  hubUrl: string;
  userId: string;
  username: string;
  userToken: string;
  role: UserRole;
  connectedAt: number;
  identityKey?: string;
}

export interface HubStatusInfo {
  connected: boolean;
  hubUrl?: string;
  user: null | {
    id: string;
    username: string;
    role: UserRole;
    status: UserStatus | string;
    groups?: Array<{ id: string; name: string }>;
  };
}

export async function connectToHub(store: SqliteStore, config: MemosLocalConfig, log?: Logger): Promise<HubSessionInfo> {
  const hubAddress = config.sharing?.client?.hubAddress ?? "";
  let userToken = config.sharing?.client?.userToken ?? "";

  if (!userToken) {
    const persisted = store.getClientHubConnection();
    if (persisted?.userToken) userToken = persisted.userToken;
  }

  if (!userToken && config.sharing?.client?.teamToken) {
    if (!log) throw new Error("hub client connection is not configured (no userToken, has teamToken but no logger for auto-join)");

    // If DB has a pending connection (userId exists, no token), check registration-status first
    const persisted = store.getClientHubConnection();
    if (persisted?.userId && !persisted.userToken && hubAddress) {
      const hubUrl = normalizeHubUrl(hubAddress);
      const teamToken = config.sharing.client!.teamToken!;
      try {
        const result = await hubRequestJson(hubUrl, "", "/api/v1/hub/registration-status", {
          method: "POST",
          body: JSON.stringify({ teamToken, userId: persisted.userId }),
        }) as any;
        if (result.status === "active" && result.userToken) {
          log.info(`Pending user approved! Connecting with token. userId=${persisted.userId}`);
          let approvedHubInstanceId = persisted.hubInstanceId || "";
          if (!approvedHubInstanceId) {
            try {
              const info = await hubRequestJson(hubUrl, "", "/api/v1/hub/info", { method: "GET" }) as any;
              approvedHubInstanceId = String(info?.hubInstanceId ?? "");
            } catch { /* best-effort */ }
          }
          store.setClientHubConnection({
            hubUrl,
            userId: persisted.userId,
            username: persisted.username || "",
            userToken: result.userToken,
            role: "member",
            connectedAt: Date.now(),
            identityKey: persisted.identityKey || "",
            lastKnownStatus: "active",
            hubInstanceId: approvedHubInstanceId,
          });
          return store.getClientHubConnection()!;
        }
        if (result.status === "pending") {
          throw new PendingApprovalError(persisted.userId);
        }
        if (result.status === "rejected") {
          throw new Error("Join request was rejected by the Hub admin.");
        }
        if (result.status === "blocked") {
          throw new Error("Your account has been blocked by the Hub admin.");
        }
        if (result.status === "left" || result.status === "removed") {
          log.info(`User status is "${result.status}", will try to rejoin.`);
        }
      } catch (err) {
        if (err instanceof PendingApprovalError) throw err;
        log.warn(`registration-status check failed, falling back to autoJoinHub: ${err}`);
      }
    }

    return autoJoinHub(store, config, log);
  }

  if (!hubAddress || !userToken) {
    throw new Error("hub client connection is not configured");
  }

  const hubUrl = normalizeHubUrl(hubAddress);
  const [me, info] = await Promise.all([
    hubRequestJson(hubUrl, userToken, "/api/v1/hub/me", { method: "GET" }),
    hubRequestJson(hubUrl, "", "/api/v1/hub/info", { method: "GET" }).catch(() => null),
  ]) as [any, any];
  const persisted = store.getClientHubConnection();
  store.setClientHubConnection({
    hubUrl,
    userId: String(me.id),
    username: String(me.username ?? ""),
    userToken,
    role: String(me.role ?? "member") as UserRole,
    connectedAt: Date.now(),
    identityKey: persisted?.identityKey || String(me.identityKey ?? ""),
    lastKnownStatus: "active",
    hubInstanceId: String(info?.hubInstanceId ?? persisted?.hubInstanceId ?? ""),
  });
  return store.getClientHubConnection()!;
}

export async function getHubStatus(store: SqliteStore, config: MemosLocalConfig): Promise<HubStatusInfo> {
  const conn = store.getClientHubConnection();
  const configHubAddress = config.sharing?.client?.hubAddress || "";
  const hubAddress = conn?.hubUrl || (configHubAddress ? normalizeHubUrl(configHubAddress) : "");
  const userToken = conn?.userToken || config.sharing?.client?.userToken || "";

  if (conn && configHubAddress && conn.hubUrl && normalizeHubUrl(configHubAddress) !== conn.hubUrl) {
    store.setClientHubConnection({
      ...conn,
      hubUrl: normalizeHubUrl(configHubAddress),
      userToken: "",
      lastKnownStatus: "hub_changed",
    });
    return { connected: false, user: null };
  }

  if (conn && conn.userId && (!userToken || userToken === "")) {
    const teamToken = config.sharing?.client?.teamToken ?? "";
    if (hubAddress && teamToken) {
      try {
        const result = await hubRequestJson(normalizeHubUrl(hubAddress), "", "/api/v1/hub/registration-status", {
          method: "POST",
          body: JSON.stringify({ teamToken, userId: conn.userId }),
        }) as any;
        if (result.status === "pending") {
          return {
            connected: false,
            hubUrl: normalizeHubUrl(hubAddress),
            user: {
              id: conn.userId,
              username: conn.username || "",
              role: "member",
              status: "pending",
            },
          };
        }
        if (result.status === "active" && result.userToken) {
          store.setClientHubConnection({
            hubUrl: normalizeHubUrl(hubAddress),
            userId: conn.userId,
            username: conn.username || "",
            userToken: result.userToken,
            role: "member",
            connectedAt: Date.now(),
            identityKey: conn.identityKey || "",
            lastKnownStatus: "active",
            hubInstanceId: conn.hubInstanceId || "",
          });
          const me = await hubRequestJson(normalizeHubUrl(hubAddress), result.userToken, "/api/v1/hub/me", { method: "GET" }) as any;
          return {
            connected: true,
            hubUrl: normalizeHubUrl(hubAddress),
            user: {
              id: String(me.id),
              username: String(me.username ?? ""),
              role: String(me.role ?? "member") as UserRole,
              status: String(me.status ?? "active"),
            },
          };
        }
        if (result.status === "rejected") {
          return {
            connected: false,
            hubUrl: normalizeHubUrl(hubAddress),
            user: {
              id: conn.userId,
              username: conn.username || "",
              role: "member",
              status: "rejected",
            },
          };
        }
      } catch { /* fall through */ }
    }
    return { connected: false, user: null };
  }

  if (!hubAddress || !userToken) {
    return { connected: false, user: null };
  }

  try {
    const me = await hubRequestJson(normalizeHubUrl(hubAddress), userToken, "/api/v1/hub/me", { method: "GET" }) as any;
    const latestUsername = String(me.username ?? "");
    const latestRole = String(me.role ?? "member") as UserRole;
    if (conn && (conn.username !== latestUsername || conn.role !== latestRole)) {
      store.setClientHubConnection({
        ...conn,
        username: latestUsername,
        role: latestRole,
        lastKnownStatus: "active",
      });
    }
    return {
      connected: true,
      hubUrl: normalizeHubUrl(hubAddress),
      user: {
        id: String(me.id),
        username: latestUsername,
        role: latestRole,
        status: String(me.status ?? "active"),
        groups: Array.isArray(me.groups) ? me.groups : [],
      },
    };
  } catch (err: any) {
    const is401 = typeof err?.message === "string" && err.message.includes("(401)");
    if (is401 && conn) {
      const teamToken = config.sharing?.client?.teamToken ?? "";
      if (hubAddress && teamToken) {
        try {
          const regResult = await hubRequestJson(normalizeHubUrl(hubAddress), "", "/api/v1/hub/registration-status", {
            method: "POST",
            body: JSON.stringify({ teamToken, userId: conn.userId }),
          }) as any;
          if (regResult.status === "active" && regResult.userToken) {
            const updatedConn = {
              ...conn,
              hubUrl: normalizeHubUrl(hubAddress),
              userToken: regResult.userToken,
              connectedAt: Date.now(),
              lastKnownStatus: "active",
            };
            store.setClientHubConnection(updatedConn);
            try {
              const me = await hubRequestJson(normalizeHubUrl(hubAddress), regResult.userToken, "/api/v1/hub/me", { method: "GET" }) as any;
              const latestUsername = String(me.username ?? "");
              const latestRole = String(me.role ?? "member") as UserRole;
              if (latestUsername !== conn.username || latestRole !== conn.role) {
                store.setClientHubConnection({ ...updatedConn, username: latestUsername, role: latestRole });
              }
              return {
                connected: true,
                hubUrl: normalizeHubUrl(hubAddress),
                user: {
                  id: String(me.id),
                  username: latestUsername,
                  role: latestRole,
                  status: String(me.status ?? "active"),
                  groups: Array.isArray(me.groups) ? me.groups : [],
                },
              };
            } catch { /* fall through to token-only return */ }
            return {
              connected: true,
              hubUrl: normalizeHubUrl(hubAddress),
              user: { id: conn.userId, username: conn.username || "", role: conn.role as UserRole || "member", status: "active" },
            };
          }
          const realStatus = regResult.status as string;
          store.setClientHubConnection({ ...conn, userToken: "", lastKnownStatus: realStatus });
          return {
            connected: false,
            hubUrl: normalizeHubUrl(hubAddress),
            user: { id: conn.userId, username: conn.username || "", role: "member", status: realStatus },
          };
        } catch { /* registration-status also failed, fall through */ }
      }
      store.setClientHubConnection({ ...conn, userToken: "", lastKnownStatus: "token_expired" });
      return {
        connected: false,
        hubUrl: normalizeHubUrl(hubAddress),
        user: { id: conn.userId, username: conn.username || "", role: "member", status: "token_expired" },
      };
    }
    return { connected: false, user: null };
  }
}

export async function autoJoinHub(
  store: SqliteStore,
  config: MemosLocalConfig,
  log: Logger,
): Promise<HubSessionInfo> {
  const hubAddress = config.sharing?.client?.hubAddress ?? "";
  const teamToken = config.sharing?.client?.teamToken ?? "";
  if (!hubAddress || !teamToken) {
    throw new Error("hubAddress and teamToken are required for auto-join");
  }
  const hubUrl = normalizeHubUrl(hubAddress);
  const osModule = typeof globalThis.process !== "undefined" ? await import("os") : null;
  const hostname = osModule ? osModule.hostname() : "unknown";
  const nickname = config.sharing?.client?.nickname;
  const username = nickname || (osModule ? osModule.userInfo().username : "user");
  let clientIp = "";
  if (osModule) {
    const nets = osModule.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] ?? []) {
        if (net.family === "IPv4" && !net.internal) { clientIp = net.address; break; }
      }
      if (clientIp) break;
    }
  }

  const persisted = store.getClientHubConnection();
  const existingIdentityKey = persisted?.identityKey || "";

  log.info(`Joining Hub at ${hubUrl} as "${username}"...`);
  let hubInstanceId = "";
  try {
    const info = await hubRequestJson(hubUrl, "", "/api/v1/hub/info", { method: "GET" }) as any;
    hubInstanceId = String(info?.hubInstanceId ?? "");
  } catch { /* best-effort */ }

  const result = await hubRequestJson(hubUrl, "", "/api/v1/hub/join", {
    method: "POST",
    body: JSON.stringify({ teamToken, username, deviceName: hostname, clientIp, identityKey: existingIdentityKey }),
  }) as any;

  const returnedIdentityKey = String(result.identityKey || existingIdentityKey || "");

  if (result.status === "pending") {
    log.info(`Join request submitted, awaiting admin approval. userId=${result.userId}`);
    store.setClientHubConnection({
      hubUrl,
      userId: String(result.userId),
      username,
      userToken: "",
      role: "member",
      connectedAt: Date.now(),
      identityKey: returnedIdentityKey,
      lastKnownStatus: "pending",
      hubInstanceId,
    });
    throw new PendingApprovalError(result.userId);
  }

  if (result.status === "rejected") {
    throw new Error(`Join request was rejected by the Hub admin.`);
  }

  if (result.status === "blocked") {
    throw new Error(`Your account has been blocked by the Hub admin.`);
  }

  if (!result.userToken) {
    throw new Error(`Hub join failed: ${JSON.stringify(result)}`);
  }

  log.info(`Joined Hub successfully! userId=${result.userId}`);
  store.setClientHubConnection({
    hubUrl,
    userId: String(result.userId),
    username,
    userToken: result.userToken,
    role: "member",
    connectedAt: Date.now(),
    identityKey: returnedIdentityKey,
    lastKnownStatus: "active",
    hubInstanceId,
  });
  return store.getClientHubConnection()!;
}

export class PendingApprovalError extends Error {
  public readonly userId: string;
  constructor(userId: string) {
    super("Awaiting admin approval");
    this.name = "PendingApprovalError";
    this.userId = userId;
  }
}
