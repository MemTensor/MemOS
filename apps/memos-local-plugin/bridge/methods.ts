/**
 * JSON-RPC method dispatcher for the bridge.
 *
 * Given a live `MemoryCore`, returns a function that maps a JSON-RPC
 * method + params to a promise resolving to the method's result (or
 * rejecting with a `MemosError`). The dispatcher is transport-agnostic;
 * stdio and TCP entry points both call into it.
 *
 * Routing follows the registry in `agent-contract/jsonrpc.ts` (`RPC_METHODS`).
 * Unknown methods raise `unknown_method`; malformed params raise
 * `invalid_argument`. Every error carries the stable `ErrorCode` so
 * non-TS adapters can handle them programmatically.
 */
import { MemosError, type ErrorCode } from "../agent-contract/errors.js";
import type { MemoryCore } from "../agent-contract/memory-core.js";
import {
  RPC_METHODS,
  isRpcMethodName,
  type RpcMethodName,
} from "../agent-contract/jsonrpc.js";
import type {
  AgentKind,
  EpisodeId,
  FeedbackDTO,
  RetrievalQueryDTO,
  SessionId,
  SkillDTO,
  SkillId,
  ToolOutcomeDTO,
  TurnInputDTO,
  TurnResultDTO,
} from "../agent-contract/dto.js";

export interface DispatcherOptions {
  /** Strict schema validation for `params`. Off by default (fast path). */
  strict?: boolean;
}

export interface DispatchContext {
  /** Connection-scoped unique id. Used for cancellation + log correlation. */
  connectionId?: string;
}

export type Dispatcher = (
  method: string,
  params: unknown,
  ctx?: DispatchContext,
) => Promise<unknown>;

// ─── Param helpers ──────────────────────────────────────────────────────────

function asRecord(p: unknown, method: RpcMethodName): Record<string, unknown> {
  if (p == null) return {};
  if (typeof p !== "object" || Array.isArray(p)) {
    throw new MemosError(
      "invalid_argument",
      `${method}: params must be an object, got ${typeof p}`,
    );
  }
  return p as Record<string, unknown>;
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
  method: RpcMethodName,
): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new MemosError(
      "invalid_argument",
      `${method}: '${key}' must be a non-empty string`,
    );
  }
  return v;
}

// ─── Dispatcher factory ─────────────────────────────────────────────────────

export function makeDispatcher(
  core: MemoryCore,
  options: DispatcherOptions = {},
): Dispatcher {
  const strict = options.strict ?? false;

  return async function dispatch(
    method: string,
    params: unknown,
    _ctx?: DispatchContext,
  ) {
    if (!isRpcMethodName(method)) {
      throw new MemosError("unknown_method", `unknown JSON-RPC method: ${method}`);
    }

    switch (method) {
      // ── lifecycle ──
      case RPC_METHODS.CORE_INIT:
        await core.init();
        return { ok: true };

      case RPC_METHODS.CORE_SHUTDOWN:
        await core.shutdown();
        return { ok: true };

      case RPC_METHODS.CORE_HEALTH:
        return await core.health();

      // ── session / episode ──
      case RPC_METHODS.SESSION_OPEN: {
        const p = asRecord(params, method);
        const agent = requireString(p, "agent", method) as AgentKind;
        const sessionId =
          typeof p.sessionId === "string" && p.sessionId.length > 0
            ? (p.sessionId as SessionId)
            : undefined;
        const out = await core.openSession({ agent, sessionId });
        return { sessionId: out };
      }
      case RPC_METHODS.SESSION_CLOSE: {
        const p = asRecord(params, method);
        await core.closeSession(requireString(p, "sessionId", method) as SessionId);
        return { ok: true };
      }
      case RPC_METHODS.EPISODE_OPEN: {
        const p = asRecord(params, method);
        const sessionId = requireString(p, "sessionId", method) as SessionId;
        const episodeId =
          typeof p.episodeId === "string" ? (p.episodeId as EpisodeId) : undefined;
        const userMessage =
          typeof p.userMessage === "string" ? p.userMessage : undefined;
        const out = await core.openEpisode({ sessionId, episodeId, userMessage });
        return { episodeId: out };
      }
      case RPC_METHODS.EPISODE_CLOSE: {
        const p = asRecord(params, method);
        await core.closeEpisode(requireString(p, "episodeId", method) as EpisodeId);
        return { ok: true };
      }

      // ── turn lifecycle ──
      case RPC_METHODS.TURN_START: {
        const p = asRecord(params, method);
        if (strict) validateTurnInput(p);
        return await core.onTurnStart(p as unknown as TurnInputDTO);
      }
      case RPC_METHODS.TURN_END: {
        const p = asRecord(params, method);
        if (strict) validateTurnResult(p);
        return await core.onTurnEnd(p as unknown as TurnResultDTO);
      }
      case RPC_METHODS.FEEDBACK_SUBMIT: {
        const p = asRecord(params, method);
        const fb: Omit<FeedbackDTO, "id" | "ts"> & { ts?: number } = {
          episodeId: p.episodeId as EpisodeId | undefined,
          traceId: p.traceId as string | undefined,
          channel: p.channel as FeedbackDTO["channel"],
          polarity: p.polarity as FeedbackDTO["polarity"],
          magnitude: typeof p.magnitude === "number" ? p.magnitude : 0,
          rationale: typeof p.rationale === "string" ? p.rationale : undefined,
          raw: p.raw,
          ts: typeof p.ts === "number" ? p.ts : undefined,
        };
        return await core.submitFeedback(fb);
      }

      // ── memory queries ──
      case RPC_METHODS.MEMORY_SEARCH: {
        const p = asRecord(params, method);
        const q: RetrievalQueryDTO = {
          agent: (typeof p.agent === "string" ? p.agent : "openclaw") as AgentKind,
          sessionId: (p.sessionId as SessionId | undefined) ?? undefined,
          episodeId: (p.episodeId as EpisodeId | undefined) ?? undefined,
          query: requireString(p, "query", method),
          filters: (p.filters as Record<string, unknown> | undefined) ?? undefined,
          topK: (p.topK as RetrievalQueryDTO["topK"]) ?? undefined,
        };
        return await core.searchMemory(q);
      }
      case RPC_METHODS.MEMORY_GET_TRACE: {
        const p = asRecord(params, method);
        return await core.getTrace(requireString(p, "id", method));
      }
      case RPC_METHODS.MEMORY_GET_POLICY: {
        const p = asRecord(params, method);
        return await core.getPolicy(requireString(p, "id", method));
      }
      case RPC_METHODS.MEMORY_GET_WORLD: {
        const p = asRecord(params, method);
        return await core.getWorldModel(requireString(p, "id", method));
      }
      case RPC_METHODS.MEMORY_LIST_EPISODES: {
        const p = asRecord(params, method);
        const out = await core.listEpisodes({
          sessionId: (p.sessionId as SessionId | undefined) ?? undefined,
          limit: typeof p.limit === "number" ? p.limit : undefined,
          offset: typeof p.offset === "number" ? p.offset : undefined,
        });
        return { episodeIds: out };
      }
      case RPC_METHODS.MEMORY_TIMELINE: {
        const p = asRecord(params, method);
        const out = await core.timeline({
          episodeId: requireString(p, "episodeId", method) as EpisodeId,
        });
        return { traces: out };
      }
      case RPC_METHODS.MEMORY_LIST_TRACES: {
        const p = asRecord(params, method);
        const out = await core.listTraces({
          limit: typeof p.limit === "number" ? p.limit : undefined,
          offset: typeof p.offset === "number" ? p.offset : undefined,
          sessionId: (p.sessionId as SessionId | undefined) ?? undefined,
          q: typeof p.q === "string" ? p.q : undefined,
        });
        return { traces: out };
      }

      // ── skills ──
      case RPC_METHODS.SKILL_LIST: {
        const p = asRecord(params, method);
        const out = await core.listSkills({
          status: (p.status as SkillDTO["status"] | undefined) ?? undefined,
          limit: typeof p.limit === "number" ? p.limit : undefined,
        });
        return { skills: out };
      }
      case RPC_METHODS.SKILL_GET: {
        const p = asRecord(params, method);
        return await core.getSkill(requireString(p, "id", method) as SkillId);
      }
      case RPC_METHODS.SKILL_ARCHIVE: {
        const p = asRecord(params, method);
        await core.archiveSkill(
          requireString(p, "id", method) as SkillId,
          typeof p.reason === "string" ? p.reason : undefined,
        );
        return { ok: true };
      }

      // ── retrieval ──
      case RPC_METHODS.RETRIEVAL_QUERY: {
        // Delegated to `memory.search` for V1 — the dedicated triggers
        // (tool_driven, skill_invoke, sub_agent, decision_repair) will
        // land in V1.1 once adapters grow explicit entry points.
        const p = asRecord(params, method);
        return await core.searchMemory({
          agent: (typeof p.agent === "string" ? p.agent : "openclaw") as AgentKind,
          query: requireString(p, "query", method),
        });
      }

      // ── tool-outcome ──
      // Not registered as a public RPC yet — the core exposes the method
      // but we route it via a notification on the events stream instead.
      // Leaving a branch here would be dead code; we intentionally drop.

      // ── config / hub ──
      case RPC_METHODS.CONFIG_GET:
      case RPC_METHODS.CONFIG_PATCH:
      case RPC_METHODS.HUB_STATUS:
      case RPC_METHODS.HUB_PUBLISH:
      case RPC_METHODS.HUB_PULL:
        throw new MemosError(
          "unknown_method",
          `${method}: not implemented yet in V1`,
        );

      // ── logs + events ──
      case RPC_METHODS.LOGS_TAIL:
      case RPC_METHODS.LOGS_FORWARD:
      case RPC_METHODS.EVENTS_SUBSCRIBE:
      case RPC_METHODS.EVENTS_UNSUBSCRIBE:
        // Handled by the transport layer (SSE / notification channels).
        throw new MemosError(
          "protocol_error",
          `${method}: must be handled by the transport, not the dispatcher`,
        );

      default:
        throw new MemosError("unknown_method", `unsupported method: ${method}`);
    }
  };
}

// ─── Validators (strict mode) ───────────────────────────────────────────────

function validateTurnInput(p: Record<string, unknown>): void {
  requireKey(p, "agent", "string", "turn.start");
  requireKey(p, "sessionId", "string", "turn.start");
  requireKey(p, "userText", "string", "turn.start");
  requireKey(p, "ts", "number", "turn.start");
}

function validateTurnResult(p: Record<string, unknown>): void {
  requireKey(p, "agent", "string", "turn.end");
  requireKey(p, "sessionId", "string", "turn.end");
  requireKey(p, "episodeId", "string", "turn.end");
  requireKey(p, "agentText", "string", "turn.end");
  if (!Array.isArray(p.toolCalls)) {
    throw new MemosError(
      "invalid_argument",
      "turn.end: 'toolCalls' must be an array",
    );
  }
  requireKey(p, "ts", "number", "turn.end");
}

function requireKey(
  p: Record<string, unknown>,
  key: string,
  type: "string" | "number",
  method: string,
): void {
  const v = p[key];
  if (typeof v !== type) {
    throw new MemosError(
      "invalid_argument",
      `${method}: '${key}' must be a ${type}`,
    );
  }
}

// ─── Error code helpers (re-exported for transports) ────────────────────────

export function errorCodeOf(err: unknown): ErrorCode {
  if (err instanceof MemosError) return err.code;
  return "internal";
}

/** ToolOutcomeDTO is used elsewhere but referenced here for completeness. */
export type { ToolOutcomeDTO };
