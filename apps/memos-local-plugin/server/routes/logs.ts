/**
 * Live log stream (SSE) + tail endpoint.
 *
 * - `GET /api/v1/logs/tail?n=200` — returns the most recent N logs
 *   as JSON. Used on initial page load before the SSE attaches.
 * - `GET /api/v1/logs` — SSE stream of every `LogRecord` post
 *   redaction. Always applies server-side rate limiting (see
 *   `ALGORITHMS.md` §S4).
 */

import type { LogRecord } from "../../agent-contract/log-record.js";
import type { ServerDeps, ServerOptions } from "../types.js";
import { writeJson } from "../middleware/io.js";
import type { RouteContext, Routes } from "./registry.js";

const KEEPALIVE_MS = 20_000;
const MAX_RATE_PER_SECOND = 200;

export function registerLogsRoutes(
  routes: Routes,
  deps: ServerDeps,
  options: ServerOptions,
): void {
  const tailSize = Math.max(10, Math.min(options.logTailSize ?? 200, 5_000));

  routes.set("GET /api/v1/logs/tail", async (ctx) => {
    const n = Math.min(
      Math.max(parseInt(ctx.url.searchParams.get("n") ?? String(tailSize), 10) || tailSize, 1),
      tailSize,
    );
    const tail = deps.logTail?.() ?? [];
    const sliced = tail.slice(-n);
    return { logs: sliced };
  });

  routes.set("GET /api/v1/logs", (ctx) => handleLogStream(ctx, deps, tailSize));
}

function handleLogStream(
  ctx: RouteContext,
  deps: ServerDeps,
  tailSize: number,
): undefined {
  const { res } = ctx;
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(":ok\n\n");
  res.flushHeaders?.();

  let tokenBucket = MAX_RATE_PER_SECOND;
  const refillTimer = setInterval(() => {
    tokenBucket = MAX_RATE_PER_SECOND;
  }, 1_000);

  // Initial hydration with the tail (best-effort — skipped if unavailable).
  try {
    const tail = deps.logTail?.() ?? [];
    for (const rec of tail.slice(-tailSize)) {
      if (res.writableEnded) break;
      writeLog(ctx, rec);
    }
  } catch {
    // Don't fail the stream on a bad tail snapshot.
  }

  const unsubscribe = deps.core.subscribeLogs((rec) => {
    if (tokenBucket <= 0) return;
    tokenBucket--;
    writeLog(ctx, rec);
  });

  const keepalive = setInterval(() => {
    if (res.writableEnded) return;
    try { res.write(":ka\n\n"); } catch { /* noop */ }
  }, KEEPALIVE_MS);

  const cleanup = () => {
    clearInterval(keepalive);
    clearInterval(refillTimer);
    try { unsubscribe(); } catch { /* noop */ }
    try { if (!res.writableEnded) res.end(); } catch { /* noop */ }
  };
  ctx.req.on("close", cleanup);
  ctx.req.on("error", cleanup);
  return undefined;
}

function writeLog(ctx: RouteContext, rec: LogRecord): void {
  if (ctx.res.writableEnded) return;
  try {
    ctx.res.write(`event: log\n`);
    ctx.res.write(`data: ${JSON.stringify(rec)}\n\n`);
  } catch {
    // connection closing — cleanup path will fire
  }
}

// Kept for type-soundness even though unused at runtime.
void writeJson;
