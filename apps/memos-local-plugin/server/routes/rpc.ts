/**
 * JSON-RPC-over-HTTP route — `/api/v1/rpc`.
 *
 * Accepts a single JSON-RPC 2.0 request envelope (or a batch) and
 * dispatches via the same `makeDispatcher` the stdio bridge uses.
 * This allows the Python adapter to talk to an already-running daemon
 * over HTTP instead of spawning a new stdio bridge subprocess, which
 * eliminates zombie bridge accumulation.
 *
 * ## Protocol
 *
 * `POST /api/v1/rpc` accepts:
 * - A single JSON-RPC request: `{"jsonrpc":"2.0","id":1,"method":"turn.start","params":{...}}`
 * - A batch: `[{...}, {...}]`
 *
 * Notifications (no `id`) are accepted and return 204.
 * Responses follow JSON-RPC 2.0 spec.
 *
 * ## Security
 *
 * Inherit the same auth gating as all `/api/*` routes:
 * loopback default + optional API key + session cookie.
 */

import type { Routes } from "./registry.js";
import type { ServerDeps } from "../types.js";
import { makeDispatcher, errorCodeOf } from "../../bridge/methods.js";
import { MemosError } from "../../agent-contract/errors.js";
import type { ErrorCode } from "../../agent-contract/errors.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: { code: ErrorCode };
  };
}

const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;
const JSONRPC_INTERNAL_ERROR = -32603;

function memosErrorCodeToJsonRpc(code: ErrorCode): number {
  switch (code) {
    case "unknown_method": return JSONRPC_METHOD_NOT_FOUND;
    case "invalid_argument": return JSONRPC_INVALID_PARAMS;
    default: return JSONRPC_INTERNAL_ERROR;
  }
}

export function registerRpcRoutes(routes: Routes, deps: ServerDeps): void {
  const dispatch = makeDispatcher(deps.core, { strict: false });

  routes.set("POST /api/v1/rpc", async (ctx) => {
    let parsed: unknown;
    try {
      const text = ctx.body.toString("utf-8");
      parsed = JSON.parse(text);
    } catch {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: JSONRPC_INVALID_REQUEST, message: "Parse error" },
      } satisfies JsonRpcResponse;
    }

    // Batch support
    if (Array.isArray(parsed)) {
      const results = await Promise.all(
        parsed.map((item) => handleSingle(item, dispatch)),
      );
      return results;
    }

    return await handleSingle(parsed, dispatch);
  });
}

async function handleSingle(
  raw: unknown,
  dispatch: ReturnType<typeof makeDispatcher>,
): Promise<JsonRpcResponse> {
  if (!isRpcRequest(raw)) {
    return {
      jsonrpc: "2.0",
      id: null,
      error: { code: JSONRPC_INVALID_REQUEST, message: "Invalid Request" },
    };
  }

  // Notification — fire and forget
  if (raw.id === undefined || raw.id === null) {
    try {
      await dispatch(raw.method, raw.params);
    } catch {
      // Notifications must not return errors per spec
    }
    return undefined as unknown as JsonRpcResponse; // 204 handled by caller
  }

  try {
    const result = await dispatch(raw.method, raw.params);
    return { jsonrpc: "2.0", id: raw.id, result };
  } catch (err) {
    const code = errorCodeOf(err);
    const message =
      err instanceof MemosError ? err.message : String(err);
    return {
      jsonrpc: "2.0",
      id: raw.id,
      error: {
        code: memosErrorCodeToJsonRpc(code),
        message,
        data: { code },
      },
    };
  }
}

function isRpcRequest(v: unknown): v is JsonRpcRequest {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    obj.jsonrpc === "2.0" &&
    typeof obj.method === "string"
  );
}
