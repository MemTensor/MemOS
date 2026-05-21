import type {
  PolicyDTO,
  SkillDTO,
  TraceDTO,
  WorldModelDTO,
} from "../../agent-contract/dto.js";
import type { ResolvedConfig } from "../config/index.js";
import type { Logger } from "../logger/types.js";
import type { HubSharedMemorySearchHit } from "../storage/repos/hub.js";
import type { Repos } from "../storage/repos/index.js";
import type { EmbeddingVector } from "../types.js";
import { HubClientRuntime, type HubClientStatus } from "./client.js";
import { HubServerRuntime } from "./server.js";

export interface HubAdminPayload {
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
  groups?: Array<{ id: string; name: string; memberCount: number }>;
}

export interface HubRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  adminSnapshot(): Promise<HubAdminPayload>;
  approveUser(userId: string): Promise<{ ok: boolean; token?: string }>;
  rejectUser(userId: string): Promise<{ ok: boolean }>;
  removeUser(userId: string): Promise<{ ok: boolean }>;
  publishTrace(trace: TraceDTO, embedding?: EmbeddingVector | null): Promise<string | null>;
  unpublishTrace(traceId: string): Promise<void>;
  publishPolicy(policy: PolicyDTO): Promise<string | null>;
  unpublishPolicy(policyId: string): Promise<void>;
  publishWorldModel(world: WorldModelDTO): Promise<string | null>;
  unpublishWorldModel(worldModelId: string): Promise<void>;
  publishSkill(skill: SkillDTO): Promise<string | null>;
  unpublishSkill(skillId: string): Promise<void>;
  searchMemories(query: string, limit?: number): Promise<HubMemorySearchHit[]>;
}

export type HubMemorySearchHit = HubSharedMemorySearchHit;

export function createHubRuntime(deps: {
  repos: Repos;
  config: ResolvedConfig;
  log: Logger;
  agent: string;
  version: string;
}): HubRuntime {
  return new DefaultHubRuntime(deps);
}

class DefaultHubRuntime implements HubRuntime {
  private server: HubServerRuntime | null = null;
  private client: HubClientRuntime | null = null;
  private status: HubAdminPayload["status"] = "disabled";
  private error: string | null = null;

  constructor(
    private readonly deps: {
      repos: Repos;
      config: ResolvedConfig;
      log: Logger;
      agent: string;
      version: string;
    },
  ) {}

  async start(): Promise<void> {
    if (!this.deps.config.hub.enabled) {
      this.status = "disabled";
      return;
    }
    this.status = "starting";
    this.error = null;
    try {
      if (this.deps.config.hub.role === "hub") {
        this.server = new HubServerRuntime({
          repo: this.deps.repos.hub,
          config: this.deps.config,
          log: this.deps.log.child({ channel: "core.hub.server" }),
          version: this.deps.version,
        });
        await this.server.start();
        this.status = "running";
      } else {
        this.client = new HubClientRuntime({
          repo: this.deps.repos.hub,
          config: this.deps.config,
          log: this.deps.log.child({ channel: "core.hub.client" }),
        });
        const conn = await this.client.start();
        this.status = conn?.userToken ? "connected" : "pending";
      }
    } catch (err) {
      this.status = "error";
      this.error = err instanceof Error ? err.message : String(err);
      this.deps.log.warn("hub.start.failed", { err: this.error });
    }
  }

  async stop(): Promise<void> {
    await this.client?.stop();
    await this.server?.stop();
    this.client = null;
    this.server = null;
  }

  async adminSnapshot(): Promise<HubAdminPayload> {
    const cfg = this.deps.config.hub;
    if (!cfg.enabled) return { enabled: false, status: "disabled" };
    if (cfg.role === "hub") {
      const pending = this.deps.repos.hub.listUsers("pending").map((u) => ({
        id: u.id,
        name: u.username,
        requestedAt: u.rejoinRequestedAt ?? u.createdAt,
      }));
      const contrib = this.deps.repos.hub.contributionsByUser();
      const now = Date.now();
      const users = this.deps.repos.hub
        .listUsers()
        .filter((u) => u.status === "active")
        .map((u) => ({
          id: u.id,
          name: u.username,
          connected: u.id === this.server?.ownerUserId || (!!u.lastActiveAt && now - u.lastActiveAt < 2 * 60_000),
          role: u.role,
          status: u.status,
          memoryCount: contrib[u.id]?.memoryCount ?? 0,
          skillCount: contrib[u.id]?.skillCount ?? 0,
        }));
      let url: string | undefined;
      try {
        url = this.server?.snapshot().url;
      } catch {
        url = undefined;
      }
      return {
        enabled: true,
        role: "hub",
        status: this.status,
        error: this.error ?? undefined,
        url,
        pending,
        users,
        groups: [],
      };
    }

    const clientStatus = this.client
      ? await this.client.refreshStatus()
      : clientStatusFromRepo(this.deps.repos);
    const user = clientStatus.user;
    const state = user?.status === "pending"
      ? "pending"
      : clientStatus.connected
        ? "connected"
        : "error";
    this.status = state;
    return {
      enabled: true,
      role: "client",
      status: state,
      error: clientStatus.error ?? this.error ?? undefined,
      url: clientStatus.hubUrl,
      pending: [],
      users: user
        ? [{
            id: String(user.id),
            name: String(user.username || user.name || ""),
            connected: clientStatus.connected,
            role: String(user.role || "member"),
            status: String(user.status || ""),
          }]
        : [],
      groups: [],
    };
  }

  async approveUser(userId: string): Promise<{ ok: boolean; token?: string }> {
    const approved = this.server?.approveUser(userId);
    return approved ? { ok: true, token: approved.token } : { ok: false };
  }

  async rejectUser(userId: string): Promise<{ ok: boolean }> {
    return { ok: !!this.server?.rejectUser(userId) };
  }

  async removeUser(userId: string): Promise<{ ok: boolean }> {
    return { ok: !!this.server?.removeUser(userId) };
  }

  async publishTrace(trace: TraceDTO, embedding?: EmbeddingVector | null): Promise<string | null> {
    return this.publishMemory({
      sourceTraceId: trace.id,
      sourceAgent: String(trace.ownerAgentKind || this.deps.agent),
      kind: "trace",
      summary: trace.summary || summarize(trace.userText || trace.agentText),
      content: joinBlocks([
        trace.userText ? `User:\n${trace.userText}` : "",
        trace.agentText ? `Agent:\n${trace.agentText}` : "",
      ]),
      embedding,
    });
  }

  async unpublishTrace(traceId: string): Promise<void> {
    await this.unpublishMemory(traceId);
  }

  async publishPolicy(policy: PolicyDTO): Promise<string | null> {
    return this.publishMemory({
      sourceTraceId: policy.id,
      sourceAgent: String(policy.ownerAgentKind || this.deps.agent),
      kind: "policy",
      summary: policy.title,
      content: joinBlocks([
        `Title:\n${policy.title}`,
        `Trigger:\n${policy.trigger}`,
        `Procedure:\n${policy.procedure}`,
        `Verification:\n${policy.verification}`,
        `Boundary:\n${policy.boundary}`,
      ]),
    });
  }

  async unpublishPolicy(policyId: string): Promise<void> {
    await this.unpublishMemory(policyId);
  }

  async publishWorldModel(world: WorldModelDTO): Promise<string | null> {
    return this.publishMemory({
      sourceTraceId: world.id,
      sourceAgent: String(world.ownerAgentKind || this.deps.agent),
      kind: "world_model",
      summary: world.title,
      content: joinBlocks([`Title:\n${world.title}`, world.body]),
    });
  }

  async unpublishWorldModel(worldModelId: string): Promise<void> {
    await this.unpublishMemory(worldModelId);
  }

  async publishSkill(skill: SkillDTO): Promise<string | null> {
    const payload = {
      metadata: {
        id: skill.id,
        name: skill.name,
        invocationGuide: skill.invocationGuide,
        version: skill.version,
        qualityScore: skill.eta,
      },
      bundle: {
        invocationGuide: skill.invocationGuide,
        decisionGuidance: skill.decisionGuidance,
        evidenceAnchors: skill.evidenceAnchors,
        sourcePolicyIds: skill.sourcePolicyIds,
        sourceWorldModelIds: skill.sourceWorldModelIds,
      },
    };
    if (this.server) {
      return this.server.publishSkillAsOwner({
        sourceSkillId: skill.id,
        name: skill.name,
        invocationGuide: skill.invocationGuide,
        version: skill.version,
        qualityScore: skill.eta,
        bundle: payload.bundle,
      }).id;
    }
    const result = await this.client?.requestJson<{ skillId?: string }>("/api/v1/hub/skills/publish", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return result?.skillId ?? null;
  }

  async unpublishSkill(skillId: string): Promise<void> {
    if (this.server) {
      this.server.unpublishSkillAsOwner(skillId);
      return;
    }
    await this.client?.requestJson("/api/v1/hub/skills/unpublish", {
      method: "POST",
      body: JSON.stringify({ sourceSkillId: skillId }),
    });
  }

  async searchMemories(
    query: string,
    limit = 5,
  ): Promise<HubMemorySearchHit[]> {
    if (!this.deps.config.hub.enabled) return [];
    if (this.server) {
      return this.server.searchMemories(query, limit);
    }
    const result = await this.client?.requestJson<{ memories?: HubMemorySearchHit[] }>(
      "/api/v1/hub/memories/search",
      {
        method: "POST",
        body: JSON.stringify({
          query,
          limit,
        }),
      },
    );
    return result?.memories ?? [];
  }

  private async publishMemory(input: {
    sourceTraceId: string;
    sourceAgent: string;
    kind: string;
    summary: string;
    content: string;
    embedding?: EmbeddingVector | null;
  }): Promise<string | null> {
    if (this.server) {
      return this.server.publishMemoryAsOwner({
        ...input,
        summary: truncate(input.summary, 500),
        content: truncate(input.content, 20_000),
      }).id;
    }
    const result = await this.client?.requestJson<{ memoryId?: string }>("/api/v1/hub/memories/share", {
      method: "POST",
      body: JSON.stringify({
        memory: {
          ...input,
          sourceChunkId: input.sourceTraceId,
          summary: truncate(input.summary, 500),
          content: truncate(input.content, 20_000),
          embedding: input.embedding ? Array.from(input.embedding) : undefined,
        },
      }),
    });
    return result?.memoryId ?? null;
  }

  private async unpublishMemory(sourceTraceId: string): Promise<void> {
    if (this.server) {
      this.server.unpublishMemoryAsOwner(sourceTraceId);
      return;
    }
    await this.client?.requestJson("/api/v1/hub/memories/unshare", {
      method: "POST",
      body: JSON.stringify({ sourceTraceId }),
    });
  }
}

function clientStatusFromRepo(repos: Repos): HubClientStatus {
  const conn = repos.hub.getClientConnection();
  if (!conn) return { connected: false, user: null };
  return {
    connected: !!conn.userToken && conn.lastKnownStatus === "active",
    hubUrl: conn.hubUrl,
    user: {
      id: conn.userId,
      username: conn.username,
      role: conn.role,
      status: conn.lastKnownStatus,
    },
  };
}

function joinBlocks(blocks: string[]): string {
  return blocks.filter(Boolean).join("\n\n");
}

function summarize(text: string): string {
  return truncate(text.replace(/\s+/g, " ").trim(), 160);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}
