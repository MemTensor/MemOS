/**
 * API-key gate.
 *
 * The server listens on loopback by default, so anyone on the local
 * machine can hit it regardless. In cross-machine / multi-user
 * scenarios the host sets `apiKey` — which this middleware enforces
 * on every `/api/*` request.
 *
 * Clients can supply the key via either `Authorization: Bearer …` or
 * `x-api-key` header. 401 is returned for missing/wrong keys; we do
 * NOT 403 because that would leak whether the resource exists.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { writeJson } from "./io.js";

export function enforceApiKey(
  req: IncomingMessage,
  res: ServerResponse,
  apiKey: string,
): boolean {
  const presented =
    extractBearer(req.headers["authorization"]) ??
    headerValue(req.headers["x-api-key"]) ??
    "";
  if (presented === apiKey) return true;
  writeJson(res, 401, { error: { code: "unauthenticated", message: "api key required" } });
  return false;
}

function extractBearer(h: string | string[] | undefined): string | undefined {
  const v = headerValue(h);
  if (!v) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(v);
  return m ? m[1].trim() : undefined;
}

function headerValue(h: string | string[] | undefined): string | undefined {
  if (Array.isArray(h)) return h[0];
  return h;
}
