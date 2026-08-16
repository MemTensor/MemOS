/** Read-oriented MemOS tools exposed through DeepSeek Harness. */

import type { Context } from "@deepseek-ai/cordis";
import { defineTool, type JsonValue } from "@deepseek-ai/dsh-tools";

import type {
  RetrievalQueryDTO,
  RetrievalResultDTO,
  RuntimeNamespace,
  SessionId,
  SkillId,
  TraceId,
} from "../../agent-contract/dto.js";
import type { MemoryCore } from "../../agent-contract/memory-core.js";

import {
  DEEPSEEK_HARNESS_AGENT,
  extractDeepSeekHarnessLlmRoute,
  type DshAgentLike,
  type DshSessionLike,
} from "./bridge.js";
import type { DeepSeekHarnessLlmRoute } from "./host-llm.js";
import {
  isDeepSeekHarnessTimeout,
  waitForDeepSeekHarnessDeadline,
} from "./deadline.js";

export interface DeepSeekHarnessToolsOptions {
  core: MemoryCore;
  profileId: string;
  maxBodyChars: number;
  /** Shared foreground retrieval budget used by memos_search. */
  searchTimeoutMs?: number;
  now?: () => number;
  currentEpisode: (session: DshSessionLike) => string | undefined;
  runWithLlmRoute: <T>(
    route: DeepSeekHarnessLlmRoute,
    operation: () => Promise<T>,
  ) => Promise<T>;
}

const JSON_OUTPUT = {
  schema: {
    type: "object" as const,
    additionalProperties: true,
    properties: {
      text: { type: "string" as const, required: true },
    },
  },
  render: (_args: unknown, value: Record<string, unknown>) => [{
    type: "text" as const,
    text: typeof value["text"] === "string"
      ? value["text"]
      : JSON.stringify(value),
  }],
} as const;

export function registerDeepSeekHarnessTools(
  ctx: Context,
  options: DeepSeekHarnessToolsOptions,
): () => void {
  const bodyCap = options.maxBodyChars;
  const searchTimeoutMs = options.searchTimeoutMs ?? 3_000;
  const now = options.now ?? (() => Date.now());
  const disposers: Array<() => void> = [];

  try {

  disposers.push(ctx.tools.register(defineTool({
    name: "memos_search",
    description:
      "Search long-term MemOS memory across prior traces, learned policies, world models, and skills. " +
      "Use this before claiming that earlier user context is unavailable.",
    parameters: {
      query: {
        type: "string",
        required: true,
        description: "A concise free-text memory query.",
      },
      maxResults: {
        type: "integer",
        description: "Maximum results per tier (1-50).",
      },
      tier1topK: { type: "integer", description: "Skill result limit (0-100)." },
      tier2topK: { type: "integer", description: "Trace/policy result limit (0-100)." },
      tier3topK: { type: "integer", description: "World-model result limit (0-100)." },
      sessionScope: {
        type: "boolean",
        description: "Restrict results to the current DSH session.",
      },
    },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const query = requireText(args.query, "query");
      const agent = toolAgent(exec.agent);
      const namespace = namespaceFor(agent?.session, options.profileId);
      const sessionId = args.sessionScope === true ? agent?.id : undefined;
      const deadlineAt = now() + searchTimeoutMs;
      const searchQuery: RetrievalQueryDTO = {
          agent: DEEPSEEK_HARNESS_AGENT,
          namespace,
          sessionId: sessionId as SessionId | undefined,
          query,
          reason: "tool_driven",
          deadlineAt,
          llmFilterMalformedRetries: 0,
          topK: topKFromArgs(args),
      };
      let timedOut = false;
      let result: RetrievalResultDTO;
      try {
        const operation = runWithToolLlmRoute(options, agent, () => observeAbort(
          exec.signal,
          () => options.core.searchMemory(searchQuery, {
            signal: exec.signal,
            foreground: true,
          }),
        ));
        result = await waitForDeepSeekHarnessDeadline(operation, {
          deadlineAt,
          signal: exec.signal,
          now,
          timeoutMessage: `MemOS search exceeded ${searchTimeoutMs}ms`,
        });
      } catch (error) {
        if (!isDeepSeekHarnessTimeout(error)) throw error;
        timedOut = true;
        result = {
          query: searchQuery,
          hits: [],
          injectedContext: "",
          tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
        };
      }
      const hits = result.hits.map((hit) => ({
        tier: hit.tier,
        refKind: hit.refKind,
        refId: hit.refId,
        score: hit.score,
        snippet: clip(hit.snippet, bodyCap),
      }));
      return {
        text: formatHits(hits),
        hits,
        tierLatencyMs: result.tierLatencyMs,
        ...(timedOut ? { timedOut: true } : {}),
      };
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: "memos_get",
    description:
      "Fetch bounded details for one MemOS trace, learned policy, or world model by its id.",
    parameters: {
      id: { type: "string", required: true, description: "Memory item id." },
      kind: {
        type: "string",
        enum: ["trace", "policy", "world_model"],
        description: "Memory kind; defaults to trace.",
      },
    },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const id = requireText(args.id, "id");
      const kind = args.kind ?? "trace";
      const agent = toolAgent(exec.agent);
      const namespace = namespaceFor(agent?.session, options.profileId);
      if (kind === "trace") {
        const trace = await runWithToolLlmRoute(options, agent, () => observeAbort(
          exec.signal,
          () => options.core.getTrace(id as TraceId, namespace),
        ));
        if (!trace) return notFound(kind, id);
        const body = clip(trace.agentText || trace.summary || trace.userText, bodyCap);
        return jsonResult({
          text: body || `Found trace ${trace.id}.`,
          found: true,
          kind,
          id: trace.id,
          body,
          meta: {
            episodeId: trace.episodeId,
            ts: trace.ts,
            value: trace.value,
            userText: clip(trace.userText, bodyCap),
            reflection: clip(trace.reflection, bodyCap),
            toolCalls: trace.toolCalls.map((tool) => ({
              name: tool.name,
              errorCode: tool.errorCode ?? null,
            })),
          },
        });
      }
      if (kind === "policy") {
        const policy = await runWithToolLlmRoute(options, agent, () => observeAbort(
          exec.signal,
          () => options.core.getPolicy(id, namespace),
        ));
        if (!policy) return notFound(kind, id);
        const body = clip(`${policy.title}\n\n${policy.procedure}`, bodyCap);
        return jsonResult({
          text: body,
          found: true,
          kind,
          id: policy.id,
          body,
          meta: {
            trigger: clip(policy.trigger, bodyCap),
            verification: clip(policy.verification, bodyCap),
            boundary: clip(policy.boundary, bodyCap),
            gain: policy.gain,
            support: policy.support,
            status: policy.status,
          },
        });
      }
      const worldModel = await runWithToolLlmRoute(options, agent, () => observeAbort(
        exec.signal,
        () => options.core.getWorldModel(id, namespace),
      ));
      if (!worldModel) return notFound(kind, id);
      const body = clip(worldModel.body, bodyCap);
      return jsonResult({
        text: `${worldModel.title}\n\n${body}`.trim(),
        found: true,
        kind,
        id: worldModel.id,
        body,
        meta: {
          title: worldModel.title,
          policyIds: worldModel.policyIds,
          status: worldModel.status,
          version: worldModel.version,
        },
      });
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: "memos_timeline",
    description:
      "Return the ordered MemOS traces for one episode to reconstruct an earlier task.",
    parameters: {
      episodeId: { type: "string", required: true },
      limit: { type: "integer", description: "Maximum traces (1-100)." },
    },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const episodeId = requireText(args.episodeId, "episodeId");
      const limit = boundedInteger(args.limit, 20, 1, 100);
      const agent = toolAgent(exec.agent);
      const namespace = namespaceFor(agent?.session, options.profileId);
      const traces = (await runWithToolLlmRoute(options, agent, () => observeAbort(
        exec.signal,
        () => options.core.timeline({
          episodeId,
          namespace,
        }),
      ))).slice(0, limit);
      const items = traces.map((trace) => ({
        id: trace.id,
        ts: trace.ts,
        userText: clip(trace.userText, bodyCap),
        agentText: clip(trace.agentText, bodyCap),
        value: trace.value,
        toolCalls: trace.toolCalls.map((tool) => ({
          name: tool.name,
          errorCode: tool.errorCode ?? null,
        })),
      }));
      return {
        text: items.length === 0
          ? `No traces found for episode "${episodeId}".`
          : `Episode ${episodeId} timeline:\n\n${items.map((item, i) =>
            `${i + 1}. ${item.userText || item.agentText || item.id}`).join("\n")}`,
        episodeId,
        traces: items,
      };
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: "memos_environment",
    description:
      "Inspect learned world/environment knowledge, including repository structure, constraints, and recurring patterns.",
    parameters: {
      query: { type: "string", description: "Optional keyword filter." },
      limit: { type: "integer", description: "Maximum world models (1-30)." },
    },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      const limit = boundedInteger(args.limit, 5, 1, 30);
      const agent = toolAgent(exec.agent);
      const namespace = namespaceFor(agent?.session, options.profileId);
      const models = await runWithToolLlmRoute(options, agent, () => observeAbort(
        exec.signal,
        () => options.core.listWorldModels({
          limit,
          q: query || undefined,
          namespace,
        }),
      ));
      const environments = models.map((model) => ({
        id: model.id,
        title: model.title,
        body: clip(model.body, bodyCap),
        status: model.status,
        version: model.version,
        policyIds: model.policyIds,
      }));
      return {
        text: environments.length === 0
          ? "No learned environments found."
          : environments.map((model, i) =>
            `${i + 1}. [${model.id}] ${model.title}\n${model.body}`).join("\n\n"),
        environments,
      };
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: "memos_skill_list",
    description:
      "List reusable skills crystallized from successful prior work.",
    parameters: {
      status: {
        type: "string",
        enum: ["candidate", "active", "archived"],
      },
      limit: { type: "integer", description: "Maximum skills (1-50)." },
    },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const limit = boundedInteger(args.limit, 10, 1, 50);
      const agent = toolAgent(exec.agent);
      const namespace = namespaceFor(agent?.session, options.profileId);
      const skills = await runWithToolLlmRoute(options, agent, () => observeAbort(
        exec.signal,
        () => options.core.listSkills({
          status: args.status,
          limit,
          namespace,
        }),
      ));
      const items = skills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        status: skill.status,
        eta: skill.eta,
        support: skill.support,
        gain: skill.gain,
        invocationGuide: clip(skill.invocationGuide, bodyCap),
      }));
      return {
        text: items.length === 0
          ? "No skills found."
          : items.map((skill, i) =>
            `${i + 1}. [${skill.id}] ${skill.name} (${skill.status})\n${skill.invocationGuide}`).join("\n\n"),
        skills: items,
      };
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: "memos_skill_get",
    description:
      "Load one crystallized MemOS skill and record that it was selected for the current task.",
    parameters: {
      id: { type: "string", required: true, description: "Skill id." },
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const id = requireText(args.id, "id");
      const agent = toolAgent(exec.agent);
      const sessionId = agent?.id;
      const namespace = namespaceFor(agent?.session, options.profileId);
      const skill = await runWithToolLlmRoute(options, agent, () => observeAbort(
        exec.signal,
        () => options.core.getSkill(id as SkillId, {
          recordUse: true,
          recordTrial: true,
          sessionId: sessionId as SessionId | undefined,
          episodeId: agent?.session ? options.currentEpisode(agent.session) : undefined,
          toolCallId: String(exec.callId),
          namespace,
        }),
      ));
      if (!skill) return notFound("skill", id);
      const guide = clip(skill.invocationGuide, bodyCap);
      return {
        text: `${skill.name}\n\n${guide}`.trim(),
        found: true,
        id: skill.id,
        name: skill.name,
        status: skill.status,
        invocationGuide: guide,
        eta: skill.eta,
        support: skill.support,
        gain: skill.gain,
      };
    },
  })));
  } catch (error) {
    disposeAll(disposers);
    throw error;
  }

  return () => disposeAll(disposers);
}

function disposeAll(disposers: Array<() => void>): void {
  for (const dispose of disposers.splice(0).reverse()) dispose();
}

async function observeAbort<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const result = await operation();
  signal.throwIfAborted();
  return result;
}

function runWithToolLlmRoute<T>(
  options: DeepSeekHarnessToolsOptions,
  agent: DshAgentLike | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const route = agent === undefined
    ? undefined
    : extractDeepSeekHarnessLlmRoute(agent);
  return route === undefined
    ? operation()
    : options.runWithLlmRoute(route, operation);
}

function toolAgent(value: unknown): DshAgentLike | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as Partial<DshAgentLike>;
  return typeof candidate.id === "string" && candidate.session !== undefined
    ? candidate as DshAgentLike
    : undefined;
}

function namespaceFor(
  session: DshSessionLike | undefined,
  profileId: string,
): RuntimeNamespace {
  const preset = session?.header?.["agentPreset"];
  const resolvedProfileId = typeof preset === "string" && preset.trim()
    ? preset.trim()
    : profileId;
  return {
    agentKind: DEEPSEEK_HARNESS_AGENT,
    profileId: resolvedProfileId,
    profileLabel: resolvedProfileId,
    workspacePath: session?.header?.cwd,
    sessionKey: session?.id,
  };
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

function topKFromArgs(args: {
  maxResults?: number;
  tier1topK?: number;
  tier2topK?: number;
  tier3topK?: number;
}): { tier1: number; tier2: number; tier3: number } | undefined {
  const shared = args.maxResults === undefined
    ? undefined
    : boundedInteger(args.maxResults, 10, 1, 50);
  const tier1 = args.tier1topK === undefined
    ? shared
    : boundedInteger(args.tier1topK, 0, 0, 100);
  const tier2 = args.tier2topK === undefined
    ? shared
    : boundedInteger(args.tier2topK, 0, 0, 100);
  const tier3 = args.tier3topK === undefined
    ? shared
    : boundedInteger(args.tier3topK, 0, 0, 100);
  return tier1 === undefined && tier2 === undefined && tier3 === undefined
    ? undefined
    : {
      tier1: tier1 ?? 0,
      tier2: tier2 ?? 0,
      tier3: tier3 ?? 0,
    };
}

function clip(value: string | undefined | null, maxChars: number): string {
  if (!value) return "";
  return value.length <= maxChars
    ? value
    : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function formatHits(
  hits: Array<{ refKind: string; refId: string; score: number; snippet: string }>,
): string {
  if (hits.length === 0) return "No relevant memories found.";
  return `Found ${hits.length} memories:\n\n${hits.map((hit, i) =>
    `${i + 1}. [${hit.refKind}:${hit.refId}] ${hit.snippet} (score=${hit.score.toFixed(3)})`,
  ).join("\n")}`;
}

function notFound(kind: string, id: string) {
  return jsonResult({
    text: `No ${kind} memory found for id "${id}".`,
    found: false,
    kind,
    id,
  });
}

function jsonResult(
  value: Record<string, unknown> & { text: string },
): { text: string } & Record<string, JsonValue> {
  // The tool runtime requires canonical lossless JSON. Round-tripping here
  // removes TypeScript-only `undefined` fields introduced by union inference
  // and detaches DTO objects before they cross into DSH.
  return JSON.parse(JSON.stringify(value)) as { text: string } & Record<string, JsonValue>;
}
