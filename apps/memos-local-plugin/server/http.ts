/**
 * HTTP server entry point.
 *
 * Built on the Node standard library's `http` module — no framework. We
 * pay the small cost of writing a router by hand to keep the surface
 * area tiny, which in turn lets us guarantee the security properties
 * spelled out in `ALGORITHMS.md` (loopback default, API-key gating,
 * static-root escape prevention, etc.).
 *
 * ## Single-agent URL layout
 *
 * Each agent runs its own viewer on its own port:
 *
 *   - openclaw → :18799
 *   - hermes   → :18800
 *
 * The server hosts the SPA at `/`, the JSON REST API at `/api/v1/*`,
 * and the static viewer assets. There are no `/openclaw/*` /
 * `/hermes/*` URL prefixes — clients always talk to the agent's own
 * port. If both agents are installed, the root path renders a small
 * picker page that links to the *other* agent's URL (external link,
 * no reverse proxy, no peer cores).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { rootLogger } from "../core/logger/index.js";

import { buildRoutes } from "./routes/registry.js";
import { readBody, writeJson, writeNotFound, writeMethodNotAllowed } from "./middleware/io.js";
import { enforceApiKey } from "./middleware/auth.js";
import { requireSession } from "./routes/auth.js";
import { serveStatic } from "./middleware/static.js";
import type { ServerDeps, ServerHandle, ServerOptions } from "./types.js";

type AgentName = "openclaw" | "hermes";
const AGENT_NAMES: readonly AgentName[] = ["openclaw", "hermes"];

/**
 * Well-known per-agent viewer port. The picker page links to the
 * peer agent here. If a user moves a peer to a non-default port the
 * link will 404 — that's the intended trade-off for keeping the picker
 * fully static (no IPC, no port scanning).
 */
const AGENT_DEFAULT_PORTS: Record<AgentName, number> = {
  openclaw: 18799,
  hermes: 18800,
};

export async function startHttpServer(
  deps: ServerDeps,
  options: ServerOptions = {},
): Promise<ServerHandle> {
  const log = rootLogger.child({ channel: "server.http" });
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const extraHeaders = options.extraHeaders ?? {};

  const routes = buildRoutes(deps, options);

  const server = createServer(async (req, res) => {
    for (const [k, v] of Object.entries(extraHeaders)) {
      res.setHeader(k, v);
    }
    try {
      await dispatch(req, res, routes, deps, options, log);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("request.unhandled", { path: req.url, err: msg });
      if (!res.headersSent) {
        writeJson(res, 500, { error: { code: "internal", message: msg } });
      }
      try {
        res.end();
      } catch {
        // best-effort — connection may already be closed
      }
    }
  });

  // Single bind attempt. EADDRINUSE is propagated so the caller
  // (`bridge.cts` / `adapters/openclaw`) can log it and run headless.
  await new Promise<void>((resolve, reject) => {
    const onErr = (e: NodeJS.ErrnoException) => reject(e);
    server.once("error", onErr);
    server.listen(port, host, () => {
      server.off("error", onErr);
      resolve();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  const url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${actualPort}`;
  let closed = false;

  log.info("server.started", { url, port: actualPort });

  return {
    url,
    port: actualPort,
    get closed() {
      return closed;
    },
    async close() {
      if (closed) return;
      closed = true;
      // Drop any idle keep-alive sockets so server.close() doesn't hang
      // on pooled connections (e.g. from vitest's fetch).
      try { (server as any).closeIdleConnections?.(); } catch { /* noop */ }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      log.info("server.stopped", {});
    },
  };
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  routes: ReturnType<typeof buildRoutes>,
  deps: ServerDeps,
  options: ServerOptions,
  log: ReturnType<typeof rootLogger.child>,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = (req.method ?? "GET").toUpperCase();
  let pathname = url.pathname;

  const selfAgent = (options.agent ?? null) as AgentName | null;

  // Backwards-compat for the old single-port "hub/peer" layout, where
  // every URL was prefixed (`/openclaw/api/v1/...` or
  // `/hermes/...`). New installs serve the SPA at root, but old
  // bookmarks (and the old `AGENT_PREFIX` baked into older viewer
  // bundles) still hit the prefixed paths.
  //
  // Two cases:
  //   - Prefix matches THIS agent → drop the prefix and continue
  //     dispatching internally. We must NOT 302 here, because POST /
  //     PATCH / DELETE get downgraded to GET on a 302 in most browsers,
  //     which would silently corrupt mutations.
  //   - Prefix matches the OTHER agent → that agent lives on its own
  //     port now, so 302 the user there. (We accept the request-method
  //     downgrade because cross-port redirects are inherently a "follow
  //     this link" gesture; the SPA bundle on the other port re-issues
  //     mutations from form state, not from the original POST body.)
  for (const name of AGENT_NAMES) {
    const prefix = `/${name}`;
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      const tail = pathname.slice(prefix.length) || "/";
      if (name === selfAgent) {
        pathname = tail;
        break;
      }
      const peerPort = AGENT_DEFAULT_PORTS[name];
      const targetHost = req.headers["host"]?.split(":")[0] ?? "127.0.0.1";
      res.writeHead(302, {
        Location: `http://${targetHost}:${peerPort}${tail}${url.search}`,
      });
      res.end();
      return;
    }
  }

  // Static assets first — cheapest path. Serve on GET/HEAD only.
  // The root path falls through to the static handler which serves
  // `index.html` (the SPA). There is no picker page: each agent owns
  // its own port and is reachable directly. The SPA's header probes
  // the peer's well-known port and surfaces a small link if it's up.
  if ((method === "GET" || method === "HEAD") && !pathname.startsWith("/api/")) {
    const served = await serveStatic(res, pathname, options);
    if (served) return;
  }

  // API key gating — applies to every /api/* route (host-configured).
  if (pathname.startsWith("/api/") && options.apiKey) {
    const allowed = enforceApiKey(req, res, options.apiKey);
    if (!allowed) return;
  }

  // Session-cookie gating — applies only when the operator has
  // enabled password protection (i.e. `~/.../memos-plugin/.auth.json`
  // exists). Auth endpoints + `/health` are explicitly allowed so
  // the viewer can complete login even from a locked state.
  if (pathname.startsWith("/api/") && deps.home?.root) {
    const ok = requireSession(req, res, String(deps.home.root), pathname);
    if (!ok) return;
  }

  // Flat router lookup.
  const key = `${method} ${pathname}`;
  const exact = routes.getExact(key);
  if (exact) {
    const body = await readBody(req, options.maxBodyBytes ?? 1_048_576);
    const result = await exact({ req, res, url, body, deps, params: {} });
    if (!res.headersSent && result !== undefined) {
      writeJson(res, 200, result);
    }
    return;
  }

  // Pattern-route fallback (e.g. `/api/v1/traces/:id`).
  const pattern = routes.matchPattern(method, pathname);
  if (pattern) {
    const body = await readBody(req, options.maxBodyBytes ?? 1_048_576);
    const result = await pattern.handler({
      req,
      res,
      url,
      body,
      deps,
      params: pattern.params,
    });
    if (!res.headersSent && result !== undefined) {
      writeJson(res, 200, result);
    }
    return;
  }

  // Differentiate "route exists, wrong method" from "no such route".
  if (routes.pathMatches(pathname)) {
    writeMethodNotAllowed(res, method);
    return;
  }

  writeNotFound(res);
  log.debug("route.not_found", { path: pathname, method });
  void deps;
}

