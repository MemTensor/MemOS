/**
 * Route registry — all REST endpoints + SSE streams.
 *
 * Keep this file flat and auditable. Every route is spelled out as
 * `"METHOD /path"`. Handler signatures are:
 *
 *     (ctx) => unknown | Promise<unknown>
 *
 * Returning `undefined` means the handler already wrote the response
 * (e.g. SSE streams). Returning any other value means "serialise as
 * JSON 200".
 *
 * ## Pattern routes
 *
 * Flat `METHOD /path` keys are the default. When a path needs a
 * parameter (e.g. `/api/v1/traces/:id`), register it via
 * `routes.setPattern("METHOD /path/:foo", handler)`. The dispatcher
 * tries exact routes first, then scans patterns in registration
 * order; params land on `ctx.params`.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { ServerDeps, ServerOptions } from "../types.js";
import { parseJsonBody, writeJson } from "../middleware/io.js";

import { registerHealthRoutes } from "./health.js";
import { registerMemoryRoutes } from "./memory.js";
import { registerOverviewRoutes } from "./overview.js";
import { registerSessionRoutes } from "./session.js";
import { registerSkillRoutes } from "./skill.js";
import { registerFeedbackRoutes } from "./feedback.js";
import { registerEventsRoutes } from "./events.js";
import { registerLogsRoutes } from "./logs.js";
import { registerConfigRoutes } from "./config.js";
import { registerMetricsRoutes } from "./metrics.js";
import { registerImportExportRoutes } from "./import-export.js";
import { registerMigrateRoutes } from "./migrate.js";
import { registerHubAdminRoutes } from "./hub-admin.js";
import { registerTraceRoutes } from "./trace.js";
import { registerPoliciesRoutes } from "./policies.js";
import { registerAuthRoutes } from "./auth.js";
import { registerAdminRoutes } from "./admin.js";
import { registerModelsRoutes } from "./models.js";
import { registerApiLogsRoutes } from "./api-logs.js";
import { registerDiagRoutes } from "./diag.js";

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  body: Buffer;
  deps: ServerDeps;
  /** Parsed path params (populated by pattern routes only). */
  params: Record<string, string>;
}

export type RouteHandler = (ctx: RouteContext) => unknown | Promise<unknown>;

interface PatternRoute {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: RouteHandler;
}

/**
 * Dual-storage route map. `setPattern` registers a URL template with
 * `:param` placeholders (matched exact-segment, no regex escaping
 * needed). `set` remains the flat happy path.
 */
export class Routes {
  private exact = new Map<string, RouteHandler>();
  private patterns: PatternRoute[] = [];

  set(key: string, handler: RouteHandler): void {
    this.exact.set(key, handler);
  }

  has(key: string): boolean {
    return this.exact.has(key);
  }

  getExact(key: string): RouteHandler | undefined {
    return this.exact.get(key);
  }

  exactKeys(): IterableIterator<string> {
    return this.exact.keys();
  }

  /**
   * Register a pattern route. `key` looks like
   * `"GET /api/v1/traces/:id"`. The matcher splits on `/`, escapes
   * literal segments, and captures `:name` segments as named params.
   */
  setPattern(key: string, handler: RouteHandler): void {
    const match = key.match(/^(\w+)\s+(.+)$/);
    if (!match) throw new Error(`invalid route key: ${key}`);
    const [, method, path] = match;
    const segments = path.split("/");
    const keys: string[] = [];
    const re = segments
      .map((seg) => {
        if (seg.startsWith(":")) {
          keys.push(seg.slice(1));
          return "([^/]+)";
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("/");
    this.patterns.push({
      method,
      regex: new RegExp(`^${re}$`),
      keys,
      handler,
    });
  }

  matchPattern(
    method: string,
    pathname: string,
  ): { handler: RouteHandler; params: Record<string, string> } | null {
    for (const pat of this.patterns) {
      if (pat.method !== method) continue;
      const m = pat.regex.exec(pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      pat.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1] ?? "");
      });
      return { handler: pat.handler, params };
    }
    return null;
  }

  /** All known pathnames (exact + patterns) — used for 405 detection. */
  allPaths(): string[] {
    const out: string[] = [];
    for (const k of this.exact.keys()) out.push(k.split(" ")[1] ?? "");
    for (const p of this.patterns) out.push(p.regex.source);
    return out;
  }

  /** Patterns that match a pathname regardless of method (for 405). */
  pathMatches(pathname: string): boolean {
    for (const k of this.exact.keys()) {
      if (k.split(" ")[1] === pathname) return true;
    }
    for (const p of this.patterns) {
      if (p.regex.test(pathname)) return true;
    }
    return false;
  }
}

export function buildRoutes(
  deps: ServerDeps,
  options: ServerOptions,
): Routes {
  const routes = new Routes();
  registerHealthRoutes(routes, deps);
  registerOverviewRoutes(routes, deps);
  registerSessionRoutes(routes, deps);
  registerMemoryRoutes(routes, deps);
  registerTraceRoutes(routes, deps);
  registerPoliciesRoutes(routes, deps);
  registerSkillRoutes(routes, deps);
  registerFeedbackRoutes(routes, deps);
  registerEventsRoutes(routes, deps);
  registerLogsRoutes(routes, deps, options);
  registerConfigRoutes(routes, deps);
  registerMetricsRoutes(routes, deps);
  registerImportExportRoutes(routes, deps);
  registerMigrateRoutes(routes, deps);
  registerHubAdminRoutes(routes, deps);
  registerAuthRoutes(routes, deps);
  registerAdminRoutes(routes, deps);
  registerModelsRoutes(routes, deps);
  registerApiLogsRoutes(routes, deps);
  registerDiagRoutes(routes, deps);
  return routes;
}

// ─── Small utilities used by route modules ──────────────────────────────────

export function parseJson<T = unknown>(ctx: RouteContext): T {
  try {
    return parseJsonBody<T>(ctx.body);
  } catch (err) {
    writeJson(ctx.res, 400, {
      error: {
        code: "invalid_argument",
        message: err instanceof Error ? err.message : "invalid json",
      },
    });
    throw new Error("__response_written__");
  }
}

export function parseQuery<T = Record<string, string>>(ctx: RouteContext): T {
  const out: Record<string, string> = {};
  for (const [k, v] of ctx.url.searchParams.entries()) out[k] = v;
  return out as T;
}

export function writeError(
  ctx: RouteContext,
  status: number,
  code: string,
  message: string,
): void {
  writeJson(ctx.res, status, { error: { code, message } });
}
