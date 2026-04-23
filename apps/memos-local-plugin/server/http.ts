/**
 * HTTP server entry point.
 *
 * Built on the Node standard library's `http` module — no framework. We
 * pay the small cost of writing a router by hand to keep the surface
 * area tiny, which in turn lets us guarantee the security properties
 * spelled out in `ALGORITHMS.md` (loopback default, API-key gating,
 * static-root escape prevention, etc.).
 *
 * The router is intentionally flat: route name strings live in
 * `routes/registry.ts` and are matched by exact pathname + method.
 * When route count grows past ~30 we'll revisit and introduce a real
 * trie, but for now flat keeps things auditable.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { rootLogger } from "../core/logger/index.js";

import { buildRoutes } from "./routes/registry.js";
import { readBody, writeJson, writeText, writeNotFound, writeMethodNotAllowed } from "./middleware/io.js";
import { enforceApiKey } from "./middleware/auth.js";
import { requireSession } from "./routes/auth.js";
import { getPeer, listPeers } from "./routes/hub.js";
import { serveStatic } from "./middleware/static.js";
import { request as httpRequest } from "node:http";
import type { ServerDeps, ServerHandle, ServerOptions } from "./types.js";

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

  // Bind with automatic port fallback. When the configured port is
  // already in use — typically because another agent (openclaw vs
  // hermes) installed its own viewer onto the same 18799 default —
  // we walk up to `FALLBACK_TRIES` ports until one is free. The
  // viewer's overview endpoint reports the *actual* port it bound
  // to, and the frontend cross-links between agents by probing the
  // nearby ports. This avoids the "port collision → viewer silently
  // fails to start" pitfall users hit when running both agents.
  const FALLBACK_TRIES = port === 0 ? 0 : 10;
  let boundPort = port;
  let lastErr: unknown = null;
  for (let i = 0; i <= FALLBACK_TRIES; i++) {
    const candidate = port === 0 ? 0 : port + i;
    try {
      await new Promise<void>((resolve, reject) => {
        const onErr = (e: NodeJS.ErrnoException) => reject(e);
        server.once("error", onErr);
        server.listen(candidate, host, () => {
          server.off("error", onErr);
          resolve();
        });
      });
      boundPort = candidate;
      if (i > 0) {
        log.warn("server.port_fallback", {
          requested: port,
          bound: candidate,
          tries: i,
        });
      }
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EADDRINUSE") throw err;
      // Try the next port. Small delay to be gentle under racy conditions.
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  if (lastErr) throw lastErr;

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : boundPort;
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

  const selfAgent = options.agent ?? null;
  const AGENT_NAMES = ["openclaw", "hermes"] as const;

  // ── Multi-agent path routing ────────────────────────────────────────
  // The first agent to bind the port acts as the hub. Subsequent
  // agents register under `/api/v1/hub/register` and become peers
  // that the hub proxies to under `/{peerAgent}/…`.
  //
  // Three cases:
  //   /{selfAgent}/rest → strip prefix, serve locally
  //   /{peerAgent}/rest → reverse-proxy to the peer's fallback port
  //   other             → serve locally unprefixed (back-compat)
  for (const name of AGENT_NAMES) {
    const prefix = `/${name}`;
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      // `/openclaw` (no trailing slash) — redirect so the SPA's
      // `./assets/…` URLs resolve relative to the prefix, not the
      // domain root. Without this, opening `/openclaw` (browser
      // default) fetches `/assets/…` → 404.
      if (pathname === prefix) {
        res.writeHead(302, { Location: `${prefix}/` });
        res.end();
        return;
      }
      if (name === selfAgent) {
        // Rewrite in place — downstream code sees `/api/v1/…` etc.
        pathname = pathname.slice(prefix.length) || "/";
        break;
      }
      const peer = getPeer(name);
      if (peer) {
        await proxyToPeer(req, res, peer.port, pathname, log);
        return;
      }
      // Unknown peer — fall through to 404 below (no redirect to
      // avoid boot-loops during restart).
      writeNotFound(res);
      return;
    }
  }

  // Root path: when this instance is a hub with peers, render a tiny
  // picker. Otherwise fall through to normal static serving (which
  // renders the viewer bundle).
  if (pathname === "/" && selfAgent && listPeers().length > 0) {
    writePicker(res, selfAgent, listPeers().map((p) => p.agent));
    return;
  }

  // Static assets first — cheapest path. Serve on GET/HEAD only.
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

// ─── Multi-agent helpers ───────────────────────────────────────────────────

/**
 * Reverse-proxy a request to a peer agent's loopback port. We stream
 * body and headers through so SSE endpoints (`/events`, `/logs`) and
 * large JSON responses work the same as if the peer were reached
 * directly.
 */
async function proxyToPeer(
  req: IncomingMessage,
  res: ServerResponse,
  peerPort: number,
  pathname: string,
  log: ReturnType<typeof rootLogger.child>,
): Promise<void> {
  const originalUrl = req.url ?? "/";
  // Preserve query string — `req.url` is `pathname?search` already.
  const search = originalUrl.includes("?")
    ? originalUrl.slice(originalUrl.indexOf("?"))
    : "";
  const upstreamPath = pathname + search;

  // Strip hop-by-hop + host headers; pass everything else through.
  const upstreamHeaders: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue;
    const lower = k.toLowerCase();
    if (lower === "host" || lower === "connection" || lower === "content-length") continue;
    upstreamHeaders[k] = v;
  }

  return new Promise<void>((resolve) => {
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port: peerPort,
        method: req.method ?? "GET",
        path: upstreamPath,
        headers: upstreamHeaders,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers as Record<string, string | string[]>);
        upRes.pipe(res);
        upRes.on("end", resolve);
        upRes.on("error", () => resolve());
      },
    );
    upstream.on("error", (err) => {
      log.warn("hub.proxy.failed", { port: peerPort, err: err.message });
      if (!res.headersSent) {
        writeJson(res, 502, {
          error: {
            code: "peer_unreachable",
            message: `peer on port ${peerPort} did not respond: ${err.message}`,
          },
        });
      }
      resolve();
    });
    req.pipe(upstream);
  });
}

/**
 * Minimal HTML picker shown at `/` when the hub knows about at least
 * one peer. Clicking a row hard-navigates to `/{agent}/`.
 */
function writePicker(res: ServerResponse, selfAgent: string, peerNames: string[]): void {
  const options = [selfAgent, ...peerNames.filter((n) => n !== selfAgent)];
  const items = options
    .map(
      (agent) => `
      <a href="/${agent}/" class="card">
        <div class="agent">${agent}</div>
        <div class="sub">Open the ${agent} memory viewer →</div>
      </a>`,
    )
    .join("");
  const html = `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8">
  <title>MemOS — Choose agent</title>
  <link rel="icon" type="image/svg+xml" href="https://statics.memtensor.com.cn/logo/color-m.svg">
  <style>
    :root{--bg:#0f1117;--card:#181b23;--fg:#e4e6eb;--sub:#8b8fa4;--acc:#7c8cf5}
    @media(prefers-color-scheme:light){:root{--bg:#f5f6fa;--card:#fff;--fg:#1a1d2e;--sub:#5a5f76}}
    body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 Inter,-apple-system,sans-serif;
         min-height:100vh;display:flex;align-items:center;justify-content:center}
    .wrap{max-width:420px;width:90%;text-align:center}
    h1{font-size:18px;margin:0 0 8px;font-weight:600}
    p{color:var(--sub);margin:0 0 32px;font-size:13px}
    .card{display:block;background:var(--card);border:1px solid rgba(255,255,255,.07);
          border-radius:12px;padding:16px 20px;text-decoration:none;color:inherit;margin:8px 0;
          transition:border-color .15s}
    .card:hover{border-color:var(--acc)}
    .agent{font-size:16px;font-weight:600;text-transform:capitalize}
    .sub{color:var(--sub);font-size:12px;margin-top:4px}
    img{width:48px;height:48px;margin-bottom:16px}
  </style>
</head>
<body><div class="wrap">
  <img src="https://statics.memtensor.com.cn/logo/color-m.svg" alt="MemOS">
  <h1>Choose an agent</h1>
  <p>This machine is running multiple agents. Pick one to open its memory viewer.</p>
  ${items}
</div></body></html>`;
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}
