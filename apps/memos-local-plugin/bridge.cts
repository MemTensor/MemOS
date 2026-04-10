/**
 * memos-core-bridge: stdio JSON-RPC entry point.
 *
 * Two modes:
 *   1. Default (stdin pipe): short-lived, reads JSON-RPC from stdin, responds on stdout.
 *      MEMOS_BRIDGE_CONFIG='...' npx tsx bridge.cts
 *
 *   2. Daemon (--daemon): long-running, listens on a TCP port for JSON-RPC,
 *      also starts the memory viewer HTTP server.
 *      MEMOS_BRIDGE_CONFIG='...' npx tsx bridge.cts --daemon [--port 18990] [--viewer-port 18899]
 *
 * The Python adapter-openharness uses daemon mode for persistent operation.
 */

import * as readline from "readline";
import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import { initPlugin, type PluginInitOptions, type MemosLocalPlugin } from "./src/index";
import { buildContext } from "./src/config";
import { ensureSqliteBinding } from "./src/storage/ensure-binding";
import { SqliteStore } from "./src/storage/sqlite";
import { Embedder } from "./src/embedding";
import { ViewerServer } from "./src/viewer/server";

// ─── Types ───

interface JsonRpcRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

// ─── Shared logic ───

function createLogger() {
  return {
    debug: (msg: string, ..._args: unknown[]) => process.stderr.write(`[debug] ${msg}\n`),
    info: (msg: string, ..._args: unknown[]) => process.stderr.write(`[info] ${msg}\n`),
    warn: (msg: string, ..._args: unknown[]) => process.stderr.write(`[warn] ${msg}\n`),
    error: (msg: string, ..._args: unknown[]) => process.stderr.write(`[error] ${msg}\n`),
  };
}

function parseConfig(): PluginInitOptions & { branding?: Record<string, string> } {
  const raw = process.env.MEMOS_BRIDGE_CONFIG;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    process.stderr.write(`[warn] Failed to parse MEMOS_BRIDGE_CONFIG, using defaults\n`);
    return {};
  }
}

function buildPromptSection(hits: Array<{ summary: string; original_excerpt?: string; score: number }>): string {
  if (!hits || hits.length === 0) return "";
  const lines: string[] = ["<recalled_memories>"];
  for (const hit of hits) {
    lines.push(`- [score=${hit.score.toFixed(2)}] ${hit.summary}`);
    if (hit.original_excerpt) {
      lines.push(`  > ${hit.original_excerpt.slice(0, 300)}`);
    }
  }
  lines.push("</recalled_memories>");
  return lines.join("\n");
}

function getStore(plugin: MemosLocalPlugin): any {
  return plugin._store;
}

async function handleRequest(plugin: MemosLocalPlugin, method: string, params: Record<string, unknown>): Promise<unknown> {
  const searchTool = plugin.tools.find((t) => t.name === "memory_search");
  const timelineTool = plugin.tools.find((t) => t.name === "memory_timeline");
  const getTool = plugin.tools.find((t) => t.name === "memory_get");

  switch (method) {
    case "search": {
      if (!searchTool) throw new Error("memory_search tool not available");
      const t0 = Date.now();
      const searchResult = await searchTool.handler(params);
      try {
        const store = getStore(plugin);
        if (store && store.recordApiLog) {
          const sr = searchResult as any;
          const hits: any[] = sr?.hits ?? sr?.local?.hits ?? [];
          const hubHits: any[] = sr?.hub?.hits ?? [];
          const candidates = hits.map((h: any) => ({
            score: h.score ?? 0,
            role: h.source?.role ?? h.role ?? "user",
            summary: h.summary ?? "",
            content: (h.original_excerpt ?? h.summary ?? "").slice(0, 200),
            origin: h.origin ?? "local",
            owner: h.owner ?? "",
          }));
          const hubCandidates = hubHits.map((h: any) => ({
            score: h.score ?? 0,
            role: h.source?.role ?? h.role ?? "assistant",
            summary: h.summary ?? (h.excerpt ?? "").slice(0, 200),
            content: (h.excerpt ?? h.summary ?? "").slice(0, 200),
            origin: "hub-remote",
            ownerName: h.ownerName ?? "",
            sourceAgent: h.sourceAgent ?? "",
          }));
          const logOutput = JSON.stringify({
            candidates,
            hubCandidates,
            filtered: candidates,
          });
          store.recordApiLog("memory_search", params, logOutput, Date.now() - t0, true);
        }
      } catch (_) { /* non-fatal */ }
      return searchResult;
    }
    case "recent": {
      const limit = (params.limit as number) ?? 20;
      const ownerFilter = params.owner ? [params.owner as string, "public"] : undefined;
      const store = getStore(plugin);
      let sql = `SELECT id, summary, content, role, session_key, created_at, owner
                 FROM chunks WHERE dedup_status = 'active'`;
      const sqlParams: unknown[] = [];
      if (ownerFilter) {
        sql += ` AND owner IN (${ownerFilter.map(() => "?").join(",")})`;
        sqlParams.push(...ownerFilter);
      }
      sql += ` ORDER BY created_at DESC LIMIT ?`;
      sqlParams.push(limit);
      const rows = (store as any).db.prepare(sql).all(...sqlParams) as Array<{
        id: string; summary: string; content: string; role: string;
        session_key: string; created_at: number; owner: string;
      }>;
      return {
        memories: rows.map(r => ({
          id: r.id,
          summary: r.summary || r.content?.slice(0, 200),
          content: r.content,
          role: r.role,
          sessionKey: r.session_key,
          createdAt: r.created_at,
          owner: r.owner,
        })),
        total: rows.length,
      };
    }
    case "ingest": {
      const messages = (params.messages ?? []) as Array<{ role: string; content: string }>;
      const sessionKey = (params.sessionId as string) ?? "default";
      const owner = (params.owner as string) ?? undefined;
      const t0 = Date.now();
      plugin.onConversationTurn(messages, sessionKey, owner);
      try {
        const store = getStore(plugin);
        if (store && store.recordApiLog) {
          const details = messages.map(m => ({ role: m.role, content: (m.content || "").slice(0, 200) }));
          store.recordApiLog("memory_add", { session: sessionKey, messages: messages.length, details, owner }, JSON.stringify({ ok: true }), Date.now() - t0, true);
        }
      } catch (_) { /* non-fatal */ }
      return { ok: true };
    }
    case "build_prompt": {
      if (!searchTool) throw new Error("memory_search tool not available");
      const result = (await searchTool.handler(params)) as { hits?: Array<{ summary: string; original_excerpt?: string; score: number }> };
      const hits = result.hits ?? [];
      const section = buildPromptSection(hits);
      return { section, hitCount: hits.length };
    }
    case "timeline": {
      if (!timelineTool) throw new Error("memory_timeline tool not available");
      return await timelineTool.handler(params);
    }
    case "get": {
      if (!getTool) throw new Error("memory_get tool not available");
      return await getTool.handler(params);
    }
    case "flush": {
      await plugin.flush();
      return { ok: true };
    }
    case "ping": {
      return { pong: true };
    }
    case "shutdown": {
      await plugin.shutdown();
      return { ok: true };
    }
    default:
      throw new Error(`unknown method: ${method}`);
  }
}

// ─── Stdio mode (original) ───

async function runStdio(): Promise<void> {
  const configOpts = parseConfig();
  const log = createLogger();

  const opts: PluginInitOptions = {
    stateDir: configOpts.stateDir,
    workspaceDir: configOpts.workspaceDir ?? process.cwd(),
    config: configOpts.config,
    log,
  };

  let plugin: MemosLocalPlugin;
  try {
    plugin = initPlugin(opts);
    log.info("Bridge: plugin initialized (stdio mode)");
  } catch (err) {
    process.stderr.write(`[fatal] Failed to initialize plugin: ${err}\n`);
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin });

  rl.on("line", async (line: string) => {
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line);
    } catch {
      process.stderr.write(`[warn] Invalid JSON: ${line}\n`);
      return;
    }
    try {
      if (req.method === "shutdown") {
        await plugin.shutdown();
        process.stdout.write(JSON.stringify({ id: req.id, result: { ok: true } }) + "\n");
        process.exit(0);
      }
      const result = await handleRequest(plugin, req.method, req.params);
      process.stdout.write(JSON.stringify({ id: req.id, result: result ?? { ok: true } }) + "\n");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      process.stdout.write(JSON.stringify({ id: req.id, error: message }) + "\n");
    }
  });

  rl.on("close", async () => {
    log.info("Bridge: stdin closed, shutting down");
    await plugin.shutdown();
    process.exit(0);
  });
}

// ─── Daemon mode (TCP + Viewer) ───

async function runDaemon(tcpPort: number, viewerPort: number): Promise<void> {
  const configOpts = parseConfig();
  const log = createLogger();
  const stateDir = configOpts.stateDir ?? `${process.env.HOME}/.openharness/memos-state`;

  const opts: PluginInitOptions = {
    stateDir,
    workspaceDir: configOpts.workspaceDir ?? process.cwd(),
    config: configOpts.config,
    log,
  };

  let plugin: MemosLocalPlugin;
  try {
    plugin = initPlugin(opts);
    log.info("Bridge: plugin initialized (daemon mode)");
  } catch (err) {
    process.stderr.write(`[fatal] Failed to initialize plugin: ${err}\n`);
    process.exit(1);
  }

  // Start viewer
  let viewerUrl = "";
  try {
    const ctx = buildContext(stateDir, process.cwd(), configOpts.config, log);
    ensureSqliteBinding(log);
    const store = new SqliteStore(ctx.config.storage!.dbPath!, log);
    const embedder = new Embedder(ctx.config.embedding, log);
    const viewer = new ViewerServer({ store, embedder, port: viewerPort, log, dataDir: stateDir, ctx, branding: configOpts.branding });
    viewerUrl = await viewer.start();
    log.info(`Viewer started at ${viewerUrl}`);
  } catch (err) {
    log.warn(`Viewer failed to start: ${err}`);
  }

  // Start TCP JSON-RPC server
  const server = net.createServer((socket) => {
    const rl = readline.createInterface({ input: socket });
    rl.on("line", async (line: string) => {
      let req: JsonRpcRequest;
      try {
        req = JSON.parse(line);
      } catch {
        return;
      }
      try {
        if (req.method === "get_viewer_url") {
          socket.write(JSON.stringify({ id: req.id, result: { url: viewerUrl } }) + "\n");
          return;
        }
        if (req.method === "shutdown_daemon") {
          await plugin.shutdown();
          socket.write(JSON.stringify({ id: req.id, result: { ok: true } }) + "\n");
          server.close();
          process.exit(0);
        }
        const result = await handleRequest(plugin, req.method, req.params);
        socket.write(JSON.stringify({ id: req.id, result: result ?? { ok: true } }) + "\n");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        socket.write(JSON.stringify({ id: req.id, error: message }) + "\n");
      }
    });
  });

  server.listen(tcpPort, "127.0.0.1", () => {
    log.info(`Bridge daemon listening on 127.0.0.1:${tcpPort}`);

    // Write PID file for management
    const pidDir = path.join(stateDir, "daemon");
    fs.mkdirSync(pidDir, { recursive: true });
    fs.writeFileSync(path.join(pidDir, "bridge.pid"), String(process.pid));
    fs.writeFileSync(path.join(pidDir, "bridge.port"), String(tcpPort));
    if (viewerUrl) {
      fs.writeFileSync(path.join(pidDir, "viewer.url"), viewerUrl);
    }

    // Output the info line to stdout for the launcher to capture
    process.stdout.write(JSON.stringify({ daemonPort: tcpPort, viewerUrl, pid: process.pid }) + "\n");
  });

  // Prevent EPIPE crashes when launcher closes stdout/stderr pipes
  process.stdout?.on("error", () => {});
  process.stderr?.on("error", () => {});

  // Cleanup on exit
  const cleanup = () => {
    const pidDir = path.join(stateDir, "daemon");
    try { fs.unlinkSync(path.join(pidDir, "bridge.pid")); } catch {}
    try { fs.unlinkSync(path.join(pidDir, "bridge.port")); } catch {}
    try { fs.unlinkSync(path.join(pidDir, "viewer.url")); } catch {}
  };
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
}

// ─── Entry ───

const args = process.argv.slice(2);
if (args.includes("--daemon")) {
  const portIdx = args.indexOf("--port");
  const viewerPortIdx = args.indexOf("--viewer-port");
  const tcpPort = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : 18990;
  const viewerPort = viewerPortIdx >= 0 ? parseInt(args[viewerPortIdx + 1], 10) : 18899;
  runDaemon(tcpPort, viewerPort);
} else {
  runStdio();
}
