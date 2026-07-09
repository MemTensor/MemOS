import type { PluginContext } from "../types";
import type { SqliteStore } from "../storage/sqlite";
import type { HubMemoryDetail, HubScope, HubSearchResult, HubSkillSearchResult } from "../sharing/types";

export interface ResolvedHubClient {
  hubUrl: string;
  userToken: string;
  userId: string;
  username: string;
  role: string;
}

export async function resolveHubClient(store: SqliteStore, ctx: PluginContext, overrides?: { hubAddress?: string; userToken?: string }): Promise<ResolvedHubClient> {
  const persisted = store.getClientHubConnection() as any;
  if (persisted?.hubUrl && persisted?.userToken) {
    return {
      hubUrl: normalizeHubUrl(String(persisted.hubUrl)),
      userToken: String(persisted.userToken),
      userId: String(persisted.userId),
      username: String(persisted.username ?? ""),
      role: String(persisted.role ?? "member"),
    };
  }

  const hubAddress = overrides?.hubAddress ?? ctx.config.sharing?.client?.hubAddress ?? "";
  const userToken = overrides?.userToken ?? ctx.config.sharing?.client?.userToken ?? "";
  if (!hubAddress || !userToken) {
    throw new Error("hub client connection is not configured");
  }

  const hubUrl = normalizeHubUrl(hubAddress);
  const me = await hubRequestJson(hubUrl, userToken, "/api/v1/hub/me", { method: "GET" }) as any;

  return {
    hubUrl,
    userToken,
    userId: String(me.id),
    username: String(me.username ?? ""),
    role: String(me.role ?? "member"),
  };
}

export async function hubListMemories(
  store: SqliteStore,
  ctx: PluginContext,
  input?: { limit?: number; hubAddress?: string; userToken?: string },
): Promise<{ memories: Array<any> }> {
  const client = await resolveHubClient(store, ctx, { hubAddress: input?.hubAddress, userToken: input?.userToken });
  const url = new URL(`${client.hubUrl}/api/v1/hub/memories`);
  if (input?.limit != null) url.searchParams.set("limit", String(input.limit));
  return hubRequestJson(url.origin, client.userToken, `${url.pathname}${url.search}`, {
    method: "GET",
  }) as Promise<{ memories: Array<any> }>;
}

export async function hubListTasks(
  store: SqliteStore,
  ctx: PluginContext,
  input?: { limit?: number; hubAddress?: string; userToken?: string },
): Promise<{ tasks: Array<any> }> {
  const client = await resolveHubClient(store, ctx, { hubAddress: input?.hubAddress, userToken: input?.userToken });
  const url = new URL(`${client.hubUrl}/api/v1/hub/tasks`);
  if (input?.limit != null) url.searchParams.set("limit", String(input.limit));
  return hubRequestJson(url.origin, client.userToken, `${url.pathname}${url.search}`, {
    method: "GET",
  }) as Promise<{ tasks: Array<any> }>;
}

export async function hubListSkills(
  store: SqliteStore,
  ctx: PluginContext,
  input?: { limit?: number; hubAddress?: string; userToken?: string },
): Promise<{ skills: Array<any> }> {
  const client = await resolveHubClient(store, ctx, { hubAddress: input?.hubAddress, userToken: input?.userToken });
  const url = new URL(`${client.hubUrl}/api/v1/hub/skills/list`);
  if (input?.limit != null) url.searchParams.set("limit", String(input.limit));
  return hubRequestJson(url.origin, client.userToken, `${url.pathname}${url.search}`, {
    method: "GET",
  }) as Promise<{ skills: Array<any> }>;
}

export async function hubSearchMemories(
  store: SqliteStore,
  ctx: PluginContext,
  input: { query: string; maxResults?: number; scope?: HubScope; hubAddress?: string; userToken?: string },
): Promise<HubSearchResult> {
  const client = await resolveHubClient(store, ctx, { hubAddress: input.hubAddress, userToken: input.userToken });
  return hubRequestJson(client.hubUrl, client.userToken, "/api/v1/hub/search", {
    method: "POST",
    body: JSON.stringify({
      query: input.query,
      maxResults: input.maxResults,
      scope: input.scope,
    }),
  }) as Promise<HubSearchResult>;
}


export async function hubSearchSkills(
  store: SqliteStore,
  ctx: PluginContext,
  input: { query: string; maxResults?: number; hubAddress?: string; userToken?: string },
): Promise<HubSkillSearchResult> {
  const client = await resolveHubClient(store, ctx, { hubAddress: input.hubAddress, userToken: input.userToken });
  const url = new URL(`${client.hubUrl}/api/v1/hub/skills`);
  url.searchParams.set("query", input.query);
  if (input.maxResults != null) url.searchParams.set("maxResults", String(input.maxResults));
  return hubRequestJson(url.origin, client.userToken, `${url.pathname}${url.search}`, {
    method: "GET",
  }) as Promise<HubSkillSearchResult>;
}

export async function hubGetMemoryDetail(
  store: SqliteStore,
  ctx: PluginContext,
  input: { remoteHitId: string; hubAddress?: string; userToken?: string },
): Promise<HubMemoryDetail> {
  const client = await resolveHubClient(store, ctx, { hubAddress: input.hubAddress, userToken: input.userToken });
  const detail = await hubRequestJson(client.hubUrl, client.userToken, "/api/v1/hub/memory-detail", {
    method: "POST",
    body: JSON.stringify({
      remoteHitId: input.remoteHitId,
    }),
  }) as Omit<HubMemoryDetail, "remoteHitId">;

  return {
    remoteHitId: input.remoteHitId,
    content: String(detail.content ?? ""),
    summary: String(detail.summary ?? ""),
    source: {
      ts: Number(detail.source?.ts ?? 0),
      role: String(detail.source?.role ?? "assistant") as any,
    },
  };
}

export async function hubUpdateUsername(
  store: SqliteStore,
  ctx: PluginContext,
  newUsername: string,
): Promise<{ ok: boolean; username: string; userToken: string }> {
  const client = await resolveHubClient(store, ctx);
  const persisted = store.getClientHubConnection();
  const result = await hubRequestJson(client.hubUrl, client.userToken, "/api/v1/hub/me/update-profile", {
    method: "POST",
    body: JSON.stringify({ username: newUsername }),
  }) as { ok: boolean; username: string; userToken: string };
  if (result.ok && result.userToken) {
    store.setClientHubConnection({
      hubUrl: client.hubUrl,
      userId: client.userId,
      username: result.username,
      userToken: result.userToken,
      role: client.role as "admin" | "member",
      connectedAt: Date.now(),
      identityKey: persisted?.identityKey || "",
      lastKnownStatus: "active",
      hubInstanceId: persisted?.hubInstanceId || "",
    });
  }
  return result;
}

let _cachedClientIp: string | null = null;
function getClientIp(): string {
  if (_cachedClientIp !== null) return _cachedClientIp;
  try {
    const os = require("os");
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] ?? []) {
        if (net.family === "IPv4" && !net.internal) { _cachedClientIp = net.address; return _cachedClientIp!; }
      }
    }
  } catch { /* browser or no os module */ }
  _cachedClientIp = "";
  return "";
}

const HUB_FETCH_TIMEOUT_MS = 25_000;

export async function hubRequestJson(
  hubUrl: string,
  userToken: string,
  route: string,
  init: RequestInit = {},
): Promise<unknown> {
  const clientIp = getClientIp();
  const timeoutSignal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(HUB_FETCH_TIMEOUT_MS)
      : undefined;
  const mergedSignal =
    timeoutSignal && init.signal
      ? AbortSignal.any([timeoutSignal, init.signal])
      : (timeoutSignal ?? init.signal);
  const res = await fetch(`${normalizeHubUrl(hubUrl)}${route}`, {
    ...init,
    ...(mergedSignal ? { signal: mergedSignal } : {}),
    headers: {
      authorization: `Bearer ${userToken}`,
      ...(clientIp ? { "x-client-ip": clientIp } : {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`hub request failed (${res.status}): ${body || res.statusText}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

export function normalizeHubUrl(hubAddress: string): string {
  const trimmed = hubAddress.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}
