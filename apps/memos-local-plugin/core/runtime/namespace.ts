import { createHash } from "node:crypto";
import type {
  AgentKind,
  RuntimeNamespace,
  ShareScope,
} from "../../agent-contract/dto.js";

export const DEFAULT_PROFILE_ID = "default";

export interface OwnerFields {
  ownerAgentKind: AgentKind;
  ownerProfileId: string;
  ownerWorkspaceId: string | null;
}

export interface VisibilityWhere {
  sql: string;
  params: Record<string, unknown>;
}

export function normalizeNamespace(
  input: Partial<RuntimeNamespace> | null | undefined,
  fallbackAgent: AgentKind = "unknown",
): RuntimeNamespace {
  const agentKind = cleanId(input?.agentKind) || String(fallbackAgent || "unknown");
  const profileId = cleanId(input?.profileId) || DEFAULT_PROFILE_ID;
  const workspacePath = cleanPath(input?.workspacePath);
  const workspaceId =
    cleanId(input?.workspaceId) || (workspacePath ? hashWorkspace(workspacePath) : undefined);
  const sessionKey = cleanText(input?.sessionKey);
  const profileLabel = cleanText(input?.profileLabel);
  return {
    agentKind,
    profileId,
    ...(profileLabel ? { profileLabel } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(workspacePath ? { workspacePath } : {}),
    ...(sessionKey ? { sessionKey } : {}),
  };
}

export function namespaceFromHints(
  agent: AgentKind,
  hints?: Record<string, unknown> | null,
  fallback?: RuntimeNamespace,
): RuntimeNamespace {
  const embedded = asNamespace(hints?.namespace);
  const agentIdentity = cleanId(hints?.agentIdentity);
  const profileId =
    embedded?.profileId ||
    agentIdentity ||
    deriveHermesProfileId(cleanText(hints?.hermesHome)) ||
    cleanId(hints?.profileId) ||
    fallback?.profileId;
  return normalizeNamespace(
    {
      agentKind: embedded?.agentKind || cleanId(hints?.agentKind) || fallback?.agentKind || agent,
      profileId,
      profileLabel:
        embedded?.profileLabel ||
        cleanText(hints?.profileLabel) ||
        cleanText(hints?.agentIdentity) ||
        fallback?.profileLabel,
      workspaceId: embedded?.workspaceId || cleanId(hints?.workspaceId) || fallback?.workspaceId,
      workspacePath:
        embedded?.workspacePath ||
        cleanPath(hints?.workspaceDir) ||
        cleanPath(hints?.agentDir) ||
        cleanPath(hints?.workspacePath) ||
        fallback?.workspacePath,
      sessionKey: embedded?.sessionKey || cleanText(hints?.sessionKey) || fallback?.sessionKey,
    },
    agent,
  );
}

export function ownerFromNamespace(ns: RuntimeNamespace): OwnerFields {
  const normalized = normalizeNamespace(ns, ns.agentKind);
  return {
    ownerAgentKind: normalized.agentKind,
    ownerProfileId: normalized.profileId,
    ownerWorkspaceId: normalized.workspaceId ?? null,
  };
}

export function ownerParams(ns: RuntimeNamespace, prefix = "owner"): Record<string, unknown> {
  const owner = ownerFromNamespace(ns);
  return {
    [`${prefix}_agent_kind`]: owner.ownerAgentKind,
    [`${prefix}_profile_id`]: owner.ownerProfileId,
    [`${prefix}_workspace_id`]: owner.ownerWorkspaceId,
  };
}

export function normalizeShareScope(scope: unknown): ShareScope {
  if (scope === "local" || scope === "public" || scope === "hub") return scope;
  return "private";
}

export function visibilityWhere(
  ns: RuntimeNamespace | null | undefined,
  alias = "",
): VisibilityWhere {
  const col = (name: string) => `${alias ? `${alias}.` : ""}${name}`;
  const normalized = normalizeNamespace(ns, ns?.agentKind ?? "unknown");
  return {
    sql:
      `((` +
      `${col("owner_agent_kind")} = @vis_owner_agent_kind AND ` +
      `${col("owner_profile_id")} = @vis_owner_profile_id` +
      `) OR COALESCE(${col("share_scope")}, 'private') IN ('local', 'public', 'hub'))`,
    params: {
      vis_owner_agent_kind: normalized.agentKind,
      vis_owner_profile_id: normalized.profileId,
    },
  };
}

export function ownerWhere(
  ns: RuntimeNamespace | null | undefined,
  alias = "",
): VisibilityWhere {
  const col = (name: string) => `${alias ? `${alias}.` : ""}${name}`;
  const normalized = normalizeNamespace(ns, ns?.agentKind ?? "unknown");
  return {
    sql:
      `${col("owner_agent_kind")} = @owner_agent_kind AND ` +
      `${col("owner_profile_id")} = @owner_profile_id`,
    params: {
      owner_agent_kind: normalized.agentKind,
      owner_profile_id: normalized.profileId,
    },
  };
}

export function isVisibleTo(
  row: {
    ownerAgentKind?: AgentKind;
    ownerProfileId?: string;
    share?: { scope?: ShareScope | string | null } | null;
  },
  ns: RuntimeNamespace,
): boolean {
  const scope = normalizeShareScope(row.share?.scope);
  if (scope === "local" || scope === "public" || scope === "hub") return true;
  if (
    (!row.ownerAgentKind || row.ownerAgentKind === "unknown") &&
    (!row.ownerProfileId || row.ownerProfileId === DEFAULT_PROFILE_ID)
  ) {
    return true;
  }
  const normalized = normalizeNamespace(ns, ns.agentKind);
  return (
    row.ownerAgentKind === normalized.agentKind &&
    row.ownerProfileId === normalized.profileId
  );
}

export function namespaceMeta(ns: RuntimeNamespace): Record<string, unknown> {
  const normalized = normalizeNamespace(ns, ns.agentKind);
  return {
    namespace: normalized,
    ownerAgentKind: normalized.agentKind,
    ownerProfileId: normalized.profileId,
    ownerWorkspaceId: normalized.workspaceId ?? null,
  };
}

function asNamespace(value: unknown): RuntimeNamespace | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const agentKind = cleanId(record.agentKind);
  const profileId = cleanId(record.profileId);
  if (!agentKind && !profileId) return null;
  return normalizeNamespace({
    agentKind: agentKind || "unknown",
    profileId: profileId || DEFAULT_PROFILE_ID,
    profileLabel: cleanText(record.profileLabel),
    workspaceId: cleanId(record.workspaceId),
    workspacePath: cleanPath(record.workspacePath),
    sessionKey: cleanText(record.sessionKey),
  });
}

function deriveHermesProfileId(hermesHome: string | undefined): string | undefined {
  if (!hermesHome) return undefined;
  const normalized = hermesHome.replace(/\\/g, "/").replace(/\/+$/, "");
  const match = /\/profiles\/([^/]+)$/.exec(normalized);
  if (match?.[1]) return cleanId(match[1]);
  if (normalized.endsWith("/.hermes")) return DEFAULT_PROFILE_ID;
  return undefined;
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function cleanPath(value: unknown): string | undefined {
  return cleanText(value);
}

function cleanId(value: unknown): string | undefined {
  const trimmed = cleanText(value);
  if (!trimmed) return undefined;
  return trimmed.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || undefined;
}

function hashWorkspace(workspacePath: string): string {
  return createHash("sha256").update(workspacePath).digest("hex").slice(0, 16);
}
