/**
 * Memory tools exposed to OpenClaw agents.
 *
 * Each tool is a thin wrapper around a `MemoryCore` method. We use the
 * **factory form** of `registerTool` (see `openclaw/src/plugins/tool-types.ts`)
 * so each tool has access to the trusted `OpenClawPluginToolContext`
 * (agentId / sessionKey / sessionId / workspaceDir), which lets us scope
 * searches to the current agent or session on demand.
 *
 * Tool execution signature follows pi-agent-core's `AnyAgentTool`:
 *
 *   execute(toolCallId: string, params: Static<typeof parameters>) => unknown
 *
 * Tools stay *stateless*: the bridge owns cursors, the core owns memory.
 * Each tool is idempotent and re-entrant.
 */
import { Type, type Static } from "@sinclair/typebox";

import type { AgentKind, SkillId, TraceId } from "../../agent-contract/dto.js";
import type { MemoryCore } from "../../agent-contract/memory-core.js";

import { bridgeSessionId } from "./bridge.js";
import type {
  AgentToolDescriptor,
  HostLogger,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "./openclaw-api.js";

export interface ToolsOptions {
  agent: AgentKind;
  core?: MemoryCore;
  getCore?: () => MemoryCore | null | Promise<MemoryCore | null>;
  log: HostLogger;
  /** Cap on how many characters we return per snippet. */
  maxBodyChars?: number;
}

const DEFAULT_BODY_CAP = 1200;

// ─── Parameter schemas ─────────────────────────────────────────────────────

const MemorySearchParams = Type.Object({
  query: Type.String({ minLength: 1, description: "Free-text query (2–5 key words)." }),
  maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 10 })),
  sessionScope: Type.Optional(
    Type.Boolean({
      default: false,
      description: "Restrict results to the current session only.",
    }),
  ),
});
type MemorySearchParamsT = Static<typeof MemorySearchParams>;

const MemoryGetParams = Type.Object({
  id: Type.String({ minLength: 1 }),
  kind: Type.Optional(
    Type.Union(
      [Type.Literal("trace"), Type.Literal("policy"), Type.Literal("world_model")],
      { default: "trace" },
    ),
  ),
});
type MemoryGetParamsT = Static<typeof MemoryGetParams>;

const MemoryTimelineParams = Type.Object({
  episodeId: Type.String({ minLength: 1 }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
});
type MemoryTimelineParamsT = Static<typeof MemoryTimelineParams>;

const SkillListParams = Type.Object({
  status: Type.Optional(
    Type.Union([
      Type.Literal("candidate"),
      Type.Literal("active"),
      Type.Literal("archived"),
    ]),
  ),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 10 })),
});
type SkillListParamsT = Static<typeof SkillListParams>;

const SkillGetParams = Type.Object({ id: Type.String({ minLength: 1 }) });
type SkillGetParamsT = Static<typeof SkillGetParams>;

const EnvironmentQueryParams = Type.Object({
  query: Type.Optional(
    Type.String({
      description:
        "Free-text keyword to narrow down (optional; omit to list all environments).",
    }),
  ),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, default: 5 })),
});
type EnvironmentQueryParamsT = Static<typeof EnvironmentQueryParams>;

// ─── Helpers ───────────────────────────────────────────────────────────────

function clip(s: string | undefined, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function sessionFromCtx(ctx: OpenClawPluginToolContext | undefined): string | undefined {
  const sessionKey = ctx?.sessionKey;
  if (!sessionKey) return undefined;
  const agentId = ctx?.agentId ?? "main";
  return bridgeSessionId(agentId, sessionKey);
}

async function resolveCore(opts: ToolsOptions): Promise<MemoryCore> {
  const core = opts.core ?? (await opts.getCore?.());
  if (!core) {
    throw new Error("MemOS Local runtime is not ready yet");
  }
  return core;
}

// ─── Registration ──────────────────────────────────────────────────────────

export function registerOpenClawTools(api: OpenClawPluginApi, opts: ToolsOptions): void {
  const bodyCap = opts.maxBodyChars ?? DEFAULT_BODY_CAP;

  // ── memory_search ──
  api.registerTool(
    (ctx: OpenClawPluginToolContext): AgentToolDescriptor<typeof MemorySearchParams> => ({
      name: "memory_search",
      label: "Memory Search",
      description:
        "Search the local MemOS memory (traces + policies + world models + skills). " +
        "Returns a ranked list of grounded snippets. Prefer this before claiming prior " +
        "context is unavailable.",
      parameters: MemorySearchParams,
      async execute(_toolCallId: string, params: MemorySearchParamsT) {
        const started = Date.now();
        const core = await resolveCore(opts);
        const sessionId = params.sessionScope ? sessionFromCtx(ctx) : undefined;
        const result = await core.searchMemory({
          agent: opts.agent,
          sessionId: sessionId as never,
          query: params.query,
          topK: {
            tier1: Math.min(params.maxResults ?? 10, 50),
            tier2: Math.min(params.maxResults ?? 10, 50),
            tier3: Math.min(params.maxResults ?? 10, 50),
          },
        });
        return {
          hits: result.hits.map((h) => ({
            tier: h.tier,
            refKind: h.refKind,
            refId: h.refId,
            score: h.score,
            snippet: clip(h.snippet, bodyCap),
          })),
          totalMs: Date.now() - started,
        };
      },
    }),
    { name: "memory_search" },
  );

  // ── memory_get ──
  api.registerTool(
    (_ctx: OpenClawPluginToolContext): AgentToolDescriptor<typeof MemoryGetParams> => ({
      name: "memory_get",
      label: "Memory Get",
      description:
        'Fetch the full body of a memory item by id. `kind` can be "trace" (default), ' +
        '"policy", or "world_model".',
      parameters: MemoryGetParams,
      async execute(_toolCallId: string, params: MemoryGetParamsT) {
        const core = await resolveCore(opts);
        const kind = params.kind ?? "trace";
        if (kind === "trace") {
          const trace = await core.getTrace(params.id as TraceId);
          if (!trace) return { found: false, kind, id: params.id, body: "", meta: {} };
          return {
            found: true,
            kind,
            id: trace.id,
            body: clip(trace.agentText, bodyCap),
            meta: {
              episodeId: trace.episodeId,
              ts: trace.ts,
              value: trace.value,
              reflection: clip(trace.reflection, bodyCap),
              userText: clip(trace.userText, bodyCap),
              toolCalls: trace.toolCalls.map((tc) => ({
                name: tc.name,
                success: !tc.errorCode,
                errorCode: tc.errorCode,
              })),
            },
          };
        }
        if (kind === "policy") {
          const policy = await core.getPolicy(params.id);
          if (!policy) return { found: false, kind, id: params.id, body: "", meta: {} };
          return {
            found: true,
            kind,
            id: policy.id,
            body: `${policy.title}\n\n${policy.procedure}`,
            meta: {
              trigger: policy.trigger,
              verification: policy.verification,
              boundary: policy.boundary,
              gain: policy.gain,
              support: policy.support,
              status: policy.status,
            },
          };
        }
        const wm = await core.getWorldModel(params.id);
        if (!wm) return { found: false, kind, id: params.id, body: "", meta: {} };
        return {
          found: true,
          kind,
          id: wm.id,
          body: clip(wm.body, bodyCap),
          meta: { title: wm.title, policyIds: wm.policyIds },
        };
      },
    }),
    { name: "memory_get" },
  );

  // ── memory_timeline ──
  api.registerTool(
    (_ctx: OpenClawPluginToolContext): AgentToolDescriptor<typeof MemoryTimelineParams> => ({
      name: "memory_timeline",
      label: "Memory Timeline",
      description:
        "Return the ordered traces inside a single episode. Useful for reconstructing " +
        "conversation flow and debugging.",
      parameters: MemoryTimelineParams,
      async execute(_toolCallId: string, params: MemoryTimelineParamsT) {
        const core = await resolveCore(opts);
        const traces = await core.timeline({ episodeId: params.episodeId as never });
        const limited = traces.slice(0, params.limit ?? 20);
        return {
          episodeId: params.episodeId,
          traces: limited.map((t) => ({
            id: t.id,
            ts: t.ts,
            userText: clip(t.userText, bodyCap),
            agentText: clip(t.agentText, bodyCap),
            toolCalls: t.toolCalls.map((tc) => ({ name: tc.name, error: tc.errorCode })),
            value: t.value,
          })),
        };
      },
    }),
    { name: "memory_timeline" },
  );

  // ── skill_list ──
  api.registerTool(
    (_ctx: OpenClawPluginToolContext): AgentToolDescriptor<typeof SkillListParams> => ({
      name: "skill_list",
      label: "Skill List",
      description:
        "List callable skills the agent can invoke. Filter by status (candidate | active | archived).",
      parameters: SkillListParams,
      async execute(_toolCallId: string, params: SkillListParamsT) {
        const core = await resolveCore(opts);
        const skills = await core.listSkills({
          status: params.status,
          limit: params.limit,
        });
        return {
          skills: skills.map((s) => ({
            id: s.id,
            name: s.name,
            status: s.status,
            eta: s.eta,
            support: s.support,
            gain: s.gain,
            invocationGuide: clip(s.invocationGuide, bodyCap),
          })),
        };
      },
    }),
    { name: "skill_list" },
  );

  // ── memory_environment ──
  //
  // Dedicated Tier-3 lookup. The turn-start injector already folds
  // environment knowledge into `prependContext`, but during a long
  // tool-driven chain the model may want to re-fetch a specific
  // domain ("what did we learn about this project's build system?")
  // without re-triggering a full tier1+2+3 search. This tool returns
  // only the world-model snippets so the agent can inject domain
  // knowledge on demand.
  api.registerTool(
    (_ctx: OpenClawPluginToolContext): AgentToolDescriptor<typeof EnvironmentQueryParams> => ({
      name: "memory_environment",
      label: "Environment Knowledge",
      description:
        "Return the agent's accumulated environment knowledge (L3 world models) — " +
        "structural facts, behavioural rules and constraints learnt across episodes. " +
        "Use this before deciding how to navigate an unfamiliar project: you already " +
        "know where code lives, which commands run, and what to avoid.",
      parameters: EnvironmentQueryParams,
      async execute(_toolCallId: string, params: EnvironmentQueryParamsT) {
        const query = (params.query ?? "").trim();
        const cap = Math.min(Math.max(1, params.limit ?? 5), 30);
        // No query → return the most recently updated world models
        // directly. Avoids paying for an LLM filter pass when the
        // agent just wants a quick "what do we know about here?"
        // dump.
        const core = await resolveCore(opts);
        if (!query) {
          const rows = await core.listWorldModels({ limit: cap, offset: 0 });
          return {
            worldModels: rows.map((w) => ({
              id: w.id,
              title: w.title,
              body: clip(w.body, bodyCap),
              policyIds: w.policyIds,
              updatedAt: w.updatedAt,
            })),
            queried: false,
          };
        }
        // With a query, go through `searchMemory` so tag filters +
        // cosine ranking apply, then keep only the tier-3 hits.
        const res = await core.searchMemory({
          agent: opts.agent,
          query,
          topK: { tier1: 0, tier2: 0, tier3: cap },
        });
        const tier3 = res.hits.filter((h) => h.tier === 3);
        return {
          worldModels: tier3.map((h) => ({
            id: h.refId,
            title: (h.snippet ?? "").split("\n")[0]?.replace(/^World model:\s*/, "") ?? "",
            body: clip(h.snippet ?? "", bodyCap),
            policyIds: [],
            score: h.score,
          })),
          queried: true,
        };
      },
    }),
    { name: "memory_environment" },
  );

  // ── skill_get ──
  api.registerTool(
    (_ctx: OpenClawPluginToolContext): AgentToolDescriptor<typeof SkillGetParams> => ({
      name: "skill_get",
      label: "Skill Get",
      description: "Return the full invocation guide for a crystallized skill.",
      parameters: SkillGetParams,
      async execute(_toolCallId: string, params: SkillGetParamsT) {
        const core = await resolveCore(opts);
        const skill = await core.getSkill(params.id as SkillId);
        if (!skill) return { found: false, skill: null };
        return {
          found: true,
          skill: {
            id: skill.id,
            name: skill.name,
            status: skill.status,
            eta: skill.eta,
            gain: skill.gain,
            support: skill.support,
            invocationGuide: skill.invocationGuide,
            sourcePolicyIds: skill.sourcePolicyIds,
            sourceWorldModelIds: skill.sourceWorldModelIds,
            createdAt: skill.createdAt,
            updatedAt: skill.updatedAt,
          },
        };
      },
    }),
    { name: "skill_get" },
  );
}

/** Exposed for tests + documentation. */
export const TOOL_SCHEMAS = {
  memory_search: MemorySearchParams,
  memory_get: MemoryGetParams,
  memory_timeline: MemoryTimelineParams,
  memory_environment: EnvironmentQueryParams,
  skill_list: SkillListParams,
  skill_get: SkillGetParams,
} as const;
