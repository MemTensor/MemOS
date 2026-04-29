/**
 * JSON-RPC 2.0 envelope + canonical method names. Used by `bridge.cts` and
 * any non-TypeScript adapter (e.g. Hermes' Python client).
 *
 * Adding a method here is non-breaking. Renaming or removing one is breaking
 * (see ARCHITECTURE.md §8).
 */

import type { ErrorCode, SerializedMemosError } from "./errors.js";

// ─── Envelope ────────────────────────────────────────────────────────────────

export type JsonRpcId = number | string;

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: P;
}

export interface JsonRpcNotification<P = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: P;
}

export interface JsonRpcSuccess<R = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: R;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: {
    /** Numeric code per JSON-RPC 2.0; we always use -32000 for app errors. */
    code: number;
    message: string;
    /** Our stable application-level error. */
    data?: SerializedMemosError;
  };
}

export type JsonRpcResponse<R = unknown> = JsonRpcSuccess<R> | JsonRpcFailure;

// JSON-RPC 2.0 reserved codes
export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;
export const JSONRPC_APPLICATION_ERROR = -32000;

// ─── Method names ────────────────────────────────────────────────────────────

/**
 * The complete method registry. Group prefixes match `core/` modules so the
 * `bridge/methods.ts` dispatcher can route mechanically.
 */
export const RPC_METHODS = {
  // ── lifecycle ──
  CORE_INIT: "core.init",
  CORE_SHUTDOWN: "core.shutdown",
  CORE_HEALTH: "core.health",

  // ── session / episode ──
  SESSION_OPEN: "session.open",
  SESSION_CLOSE: "session.close",
  EPISODE_OPEN: "episode.open",
  EPISODE_CLOSE: "episode.close",

  // ── pipeline (per turn) ──
  TURN_START: "turn.start",
  TURN_END: "turn.end",
  FEEDBACK_SUBMIT: "feedback.submit",

  // ── memory queries ──
  MEMORY_SEARCH: "memory.search",
  MEMORY_GET_TRACE: "memory.get_trace",
  MEMORY_GET_POLICY: "memory.get_policy",
  MEMORY_GET_WORLD: "memory.get_world",
  MEMORY_LIST_EPISODES: "memory.list_episodes",
  MEMORY_TIMELINE: "memory.timeline",
  MEMORY_LIST_TRACES: "memory.list_traces",
  MEMORY_LIST_WORLDS: "memory.list_world_models",

  // ── skills ──
  SKILL_LIST: "skill.list",
  SKILL_GET: "skill.get",
  SKILL_ARCHIVE: "skill.archive",

  // ── retrieval ──
  RETRIEVAL_QUERY: "retrieval.query",

  // ── config ──
  CONFIG_GET: "config.get",
  CONFIG_PATCH: "config.patch",

  // ── hub ──
  HUB_STATUS: "hub.status",
  HUB_PUBLISH: "hub.publish",
  HUB_PULL: "hub.pull",

  // ── logs ──
  LOGS_TAIL: "logs.tail",
  /** Notification: forward a log line from a non-TS adapter back into our sinks. */
  LOGS_FORWARD: "logs.forward",

  // ── events ──
  /** Notification: subscribe; the server then sends `events.notify` notifications. */
  EVENTS_SUBSCRIBE: "events.subscribe",
  EVENTS_UNSUBSCRIBE: "events.unsubscribe",
  EVENTS_NOTIFY: "events.notify",
} as const;

export type RpcMethodName = (typeof RPC_METHODS)[keyof typeof RPC_METHODS];

export function isRpcMethodName(s: string): s is RpcMethodName {
  return Object.values(RPC_METHODS).includes(s as RpcMethodName);
}

/** Map an internal `MemosError.code` to a numeric JSON-RPC code we'll report. */
export function rpcCodeForError(code: ErrorCode | undefined): number {
  if (!code) return JSONRPC_INTERNAL_ERROR;
  switch (code) {
    case "invalid_argument":
    case "config_invalid":
    case "protocol_error":
      return JSONRPC_INVALID_PARAMS;
    case "unknown_method":
      return JSONRPC_METHOD_NOT_FOUND;
    default:
      return JSONRPC_APPLICATION_ERROR;
  }
}
