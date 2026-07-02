/**
 * Stable error codes returned across module + bridge boundaries. Adapters in
 * any language should pattern-match on `code`, never on `message` text.
 *
 * Adding a code here is non-breaking. Removing or repurposing one is breaking.
 */

export const ERROR_CODES = {
  // ── Generic ──
  INVALID_ARGUMENT: "invalid_argument",
  NOT_FOUND: "not_found",
  ALREADY_EXISTS: "already_exists",
  CONFLICT: "conflict",
  INTERNAL: "internal",
  UNSUPPORTED: "unsupported",

  // ── Lifecycle ──
  NOT_INITIALIZED: "not_initialized",
  ALREADY_SHUT_DOWN: "already_shut_down",

  // ── Config / Filesystem ──
  CONFIG_INVALID: "config_invalid",
  CONFIG_MISSING: "config_missing",
  CONFIG_WRITE_FAILED: "config_write_failed",
  PATH_NOT_WRITABLE: "path_not_writable",

  // ── Memory domain ──
  SESSION_NOT_FOUND: "session_not_found",
  EPISODE_NOT_FOUND: "episode_not_found",
  TRACE_NOT_FOUND: "trace_not_found",
  POLICY_NOT_FOUND: "policy_not_found",
  WORLD_MODEL_NOT_FOUND: "world_model_not_found",
  SKILL_NOT_FOUND: "skill_not_found",
  FEEDBACK_NOT_FOUND: "feedback_not_found",

  // ── LLM / Embedding ──
  LLM_UNAVAILABLE: "llm_unavailable",
  LLM_RATE_LIMITED: "llm_rate_limited",
  LLM_TIMEOUT: "llm_timeout",
  LLM_OUTPUT_MALFORMED: "llm_output_malformed",
  EMBEDDING_UNAVAILABLE: "embedding_unavailable",

  // ── Algorithm preconditions ──
  INSUFFICIENT_EVIDENCE: "insufficient_evidence",
  VERIFICATION_FAILED: "verification_failed",

  // ── Bridge / RPC ──
  UNKNOWN_METHOD: "unknown_method",
  PROTOCOL_ERROR: "protocol_error",
  TRANSPORT_CLOSED: "transport_closed",

  // ── Hub ──
  HUB_AUTH_FAILED: "hub_auth_failed",
  HUB_UNREACHABLE: "hub_unreachable",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface SerializedMemosError {
  name: "MemosError";
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export class MemosError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "MemosError";
    this.code = code;
    this.details = details;
  }

  toJSON(): SerializedMemosError {
    return { name: "MemosError", code: this.code, message: this.message, details: this.details };
  }

  static is(err: unknown): err is MemosError {
    return err instanceof MemosError || (
      typeof err === "object" && err !== null
      && (err as { name?: unknown }).name === "MemosError"
      && typeof (err as { code?: unknown }).code === "string"
    );
  }
}
