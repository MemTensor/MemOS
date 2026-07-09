/**
 * Live event stream (SSE).
 *
 * `GET /api/v1/events` returns a `text/event-stream` connection that
 * emits every `CoreEvent` the algorithm core produces. Each message
 * is a single `data:` line containing the JSON-serialised event.
 *
 * Clients reconnect with `Last-Event-ID`; the event type and id map
 * to the `CoreEvent.kind` + `CoreEvent.id` fields, letting a simple
 * JavaScript `EventSource` fan events out to typed listeners.
 */

import type { CoreEvent } from "../../agent-contract/events.js";
import type { ServerDeps } from "../types.js";
import type { RouteContext, Routes } from "./registry.js";

const KEEPALIVE_MS = 20_000;

export function registerEventsRoutes(routes: Routes, deps: ServerDeps): void {
  routes.set("GET /api/v1/events", (ctx) => handleEventStream(ctx, deps));
}

function handleEventStream(ctx: RouteContext, deps: ServerDeps): undefined {
  const { res } = ctx;
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(":ok\n\n");
  res.flushHeaders?.();

  const writeEvent = (evt: CoreEvent) => {
    if (res.writableEnded) return;
    try {
      res.write(`event: ${evt.type}\n`);
      res.write(`id: ${evt.seq}\n`);
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    } catch {
      // socket died — cleanup happens on 'close'
    }
  };

  // Replay the most-recent events so late-connecting clients (e.g. the
  // viewer's Overview panel opened after the agent already finished a
  // turn) see non-empty activity immediately. Live subscription handles
  // everything from this point forward.
  try {
    const backlog = deps.core.getRecentEvents();
    for (const evt of backlog) writeEvent(evt);
  } catch {
    // Replay is best-effort — don't let a buffer hiccup prevent live
    // subscription from wiring up.
  }

  const unsubscribe = deps.core.subscribeEvents(writeEvent);
  const keepalive = setInterval(() => {
    if (res.writableEnded) return;
    try {
      res.write(":ka\n\n");
    } catch {
      // ignore — the cleanup path covers this
    }
  }, KEEPALIVE_MS);

  const cleanup = () => {
    clearInterval(keepalive);
    try { unsubscribe(); } catch { /* noop */ }
    try { if (!res.writableEnded) res.end(); } catch { /* noop */ }
  };

  ctx.req.on("close", cleanup);
  ctx.req.on("error", cleanup);
  return undefined;
}

