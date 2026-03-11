import http from "node:http";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { SqliteStore } from "../storage/sqlite";
import type { Embedder } from "../embedding";
import { Summarizer } from "../ingest/providers";
import { findTopSimilar } from "../ingest/dedup";
import { stripInboundMetadata } from "../capture";
import { vectorSearch } from "../storage/vector";
import { TaskProcessor } from "../ingest/task-processor";
import { RecallEngine } from "../recall/engine";
import { SkillEvolver } from "../skill/evolver";
import type { Logger, Chunk, PluginContext } from "../types";
import { viewerHTML } from "./html";
import { v4 as uuid } from "uuid";

export interface ViewerServerOptions {
  store: SqliteStore;
  embedder: Embedder;
  port: number;
  log: Logger;
  dataDir: string;
  ctx?: PluginContext;
}

interface AuthState {
  passwordHash: string | null;
  sessions: Map<string, number>;
}

export class ViewerServer {
  private server: http.Server | null = null;
  private readonly store: SqliteStore;
  private readonly embedder: Embedder;
  private readonly port: number;
  private readonly log: Logger;
  private readonly dataDir: string;
  private readonly authFile: string;
  private readonly auth: AuthState;
  private readonly ctx?: PluginContext;

  private static readonly SESSION_TTL = 24 * 60 * 60 * 1000;
  private static readonly PLUGIN_VERSION: string = (() => {
    try {
      const pkgPath = path.resolve(__dirname, "../../package.json");
      return JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version ?? "unknown";
    } catch {
      return "unknown";
    }
  })();
  private resetToken: string;
  private migrationRunning = false;
  private migrationAbort = false;
  private migrationState: {
    phase: string;
    stored: number;
    skipped: number;
    merged: number;
    errors: number;
    processed: number;
    total: number;
    lastItem: any;
    done: boolean;
    stopped: boolean;
  } = { phase: "", stored: 0, skipped: 0, merged: 0, errors: 0, processed: 0, total: 0, lastItem: null, done: false, stopped: false };
  private migrationSSEClients: http.ServerResponse[] = [];

  private ppRunning = false;
  private ppAbort = false;
  private ppState: { running: boolean; done: boolean; stopped: boolean; processed: number; total: number; tasksCreated: number; skillsCreated: number; errors: number } =
    { running: false, done: false, stopped: false, processed: 0, total: 0, tasksCreated: 0, skillsCreated: 0, errors: 0 };
  private ppSSEClients: http.ServerResponse[] = [];

  constructor(opts: ViewerServerOptions) {
    this.store = opts.store;
    this.embedder = opts.embedder;
    this.port = opts.port;
    this.log = opts.log;
    this.dataDir = opts.dataDir;
    this.ctx = opts.ctx;
    this.authFile = path.join(opts.dataDir, "viewer-auth.json");
    this.auth = { passwordHash: null, sessions: new Map() };
    this.resetToken = crypto.randomBytes(16).toString("hex");
    this.loadAuth();
  }

  start(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          this.log.warn(`Viewer port ${this.port} in use, trying ${this.port + 1}`);
          this.server!.listen(this.port + 1, "127.0.0.1");
        } else {
          reject(err);
        }
      });
      this.server.listen(this.port, "127.0.0.1", () => {
        const addr = this.server!.address();
        const actualPort = typeof addr === "object" && addr ? addr.port : this.port;
        resolve(`http://127.0.0.1:${actualPort}`);
      });
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  getResetToken(): string {
    return this.resetToken;
  }

  // ─── Auth helpers ───

  private loadAuth(): void {
    try {
      if (fs.existsSync(this.authFile)) {
        const data = JSON.parse(fs.readFileSync(this.authFile, "utf-8"));
        this.auth.passwordHash = data.passwordHash ?? null;
      }
    } catch {
      this.log.warn("Failed to load viewer auth file, starting fresh");
    }
  }

  private saveAuth(): void {
    try {
      fs.mkdirSync(path.dirname(this.authFile), { recursive: true });
      fs.writeFileSync(this.authFile, JSON.stringify({ passwordHash: this.auth.passwordHash }));
    } catch (e) {
      this.log.warn(`Failed to save viewer auth: ${e}`);
    }
  }

  private hashPassword(pw: string): string {
    return crypto.createHash("sha256").update(pw + "memos-lite-salt-2026").digest("hex");
  }

  private createSession(): string {
    const token = crypto.randomBytes(32).toString("hex");
    this.auth.sessions.set(token, Date.now() + ViewerServer.SESSION_TTL);
    return token;
  }

  private isValidSession(req: http.IncomingMessage): boolean {
    const cookie = req.headers.cookie ?? "";
    const match = cookie.match(/memos_token=([a-f0-9]+)/);
    if (!match) return false;
    const expiry = this.auth.sessions.get(match[1]);
    if (!expiry) return false;
    if (Date.now() > expiry) { this.auth.sessions.delete(match[1]); return false; }
    return true;
  }

  private get needsSetup(): boolean {
    return this.auth.passwordHash === null;
  }

  // ─── Request routing ───

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const p = url.pathname;

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    try {
      if (p === "/api/auth/status") {
        return this.jsonResponse(res, { needsSetup: this.needsSetup, loggedIn: this.isValidSession(req) });
      }
      if (p === "/api/auth/setup" && req.method === "POST") {
        return this.handleSetup(req, res);
      }
      if (p === "/api/auth/login" && req.method === "POST") {
        return this.handleLogin(req, res);
      }
      if (p === "/api/auth/reset" && req.method === "POST") {
        return this.handlePasswordReset(req, res);
      }
      if (p === "/" || p === "/viewer") {
        return this.serveViewer(res);
      }

      if (!this.isValidSession(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }

      if (p === "/api/memories" && req.method === "GET") this.serveMemories(res, url);
      else if (p === "/api/stats") this.serveStats(res);
      else if (p === "/api/metrics") this.serveMetrics(res, url);
      else if (p === "/api/tool-metrics") this.serveToolMetrics(res, url);
      else if (p === "/api/search") this.serveSearch(req, res, url);
      else if (p === "/api/tasks" && req.method === "GET") this.serveTasks(res, url);
      else if (p.match(/^\/api\/task\/[^/]+\/retry-skill$/) && req.method === "POST") this.handleTaskRetrySkill(req, res, p);
      else if (p.startsWith("/api/task/") && req.method === "DELETE") this.handleTaskDelete(res, p);
      else if (p.startsWith("/api/task/") && req.method === "PUT") this.handleTaskUpdate(req, res, p);
      else if (p.startsWith("/api/task/") && req.method === "GET") this.serveTaskDetail(res, p);
      else if (p === "/api/skills" && req.method === "GET") this.serveSkills(res, url);
      else if (p.match(/^\/api\/skill\/[^/]+\/download$/) && req.method === "GET") this.serveSkillDownload(res, p);
      else if (p.match(/^\/api\/skill\/[^/]+\/files$/) && req.method === "GET") this.serveSkillFiles(res, p);
      else if (p.match(/^\/api\/skill\/[^/]+\/visibility$/) && req.method === "PUT") this.handleSkillVisibility(req, res, p);
      else if (p.startsWith("/api/skill/") && req.method === "DELETE") this.handleSkillDelete(res, p);
      else if (p.startsWith("/api/skill/") && req.method === "PUT") this.handleSkillUpdate(req, res, p);
      else if (p.startsWith("/api/skill/") && req.method === "GET") this.serveSkillDetail(res, p);
      else if (p === "/api/memory" && req.method === "POST") this.handleCreate(req, res);
      else if (p.startsWith("/api/memory/") && req.method === "GET") this.serveMemoryDetail(res, p);
      else if (p.startsWith("/api/memory/") && req.method === "PUT") this.handleUpdate(req, res, p);
      else if (p.startsWith("/api/memory/") && req.method === "DELETE") this.handleDelete(res, p);
      else if (p === "/api/session" && req.method === "DELETE") this.handleDeleteSession(res, url);
      else if (p === "/api/memories" && req.method === "DELETE") this.handleDeleteAll(res);
      else if (p === "/api/logs" && req.method === "GET") this.serveLogs(res, url);
      else if (p === "/api/log-tools" && req.method === "GET") this.serveLogTools(res);
      else if (p === "/api/config" && req.method === "GET") this.serveConfig(res);
      else if (p === "/api/config" && req.method === "PUT") this.handleSaveConfig(req, res);
      else if (p === "/api/auth/logout" && req.method === "POST") this.handleLogout(req, res);
      else if (p === "/api/migrate/scan" && req.method === "GET") this.handleMigrateScan(res);
      else if (p === "/api/migrate/start" && req.method === "POST") this.handleMigrateStart(req, res);
      else if (p === "/api/migrate/status" && req.method === "GET") this.handleMigrateStatus(res);
      else if (p === "/api/migrate/stream" && req.method === "GET") this.handleMigrateStream(res);
      else if (p === "/api/migrate/stop" && req.method === "POST") this.handleMigrateStop(res);
      else if (p === "/api/migrate/postprocess" && req.method === "POST") this.handlePostprocess(req, res);
      else if (p === "/api/migrate/postprocess/stream" && req.method === "GET") this.handlePostprocessStream(res);
      else if (p === "/api/migrate/postprocess/stop" && req.method === "POST") this.handlePostprocessStop(res);
      else if (p === "/api/migrate/postprocess/status" && req.method === "GET") this.handlePostprocessStatus(res);
      else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
    } catch (err) {
      this.log.error(`Viewer request error: ${err}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
  }

  // ─── Auth endpoints ───

  private handleSetup(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.needsSetup) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Password already set" }));
      return;
    }
    this.readBody(req, (body) => {
      try {
        const { password } = JSON.parse(body);
        if (!password || password.length < 4) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Password must be at least 4 characters" }));
          return;
        }
        this.auth.passwordHash = this.hashPassword(password);
        this.saveAuth();
        const token = this.createSession();
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie": `memos_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
        });
        res.end(JSON.stringify({ ok: true, message: "Password set successfully" }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  }

  private handleLogin(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(req, (body) => {
      try {
        const { password } = JSON.parse(body);
        if (this.needsSetup || this.hashPassword(password) !== this.auth.passwordHash) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid password" }));
          return;
        }
        const token = this.createSession();
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie": `memos_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
        });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  }

  private handleLogout(req: http.IncomingMessage, res: http.ServerResponse): void {
    const cookie = req.headers.cookie ?? "";
    const match = cookie.match(/memos_token=([a-f0-9]+)/);
    if (match) this.auth.sessions.delete(match[1]);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": "memos_token=; Path=/; HttpOnly; Max-Age=0",
    });
    res.end(JSON.stringify({ ok: true }));
  }

  private handlePasswordReset(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(req, (body) => {
      try {
        const { token, newPassword } = JSON.parse(body);
        if (token !== this.resetToken) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid reset token" }));
          return;
        }
        if (!newPassword || newPassword.length < 4) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Password must be at least 4 characters" }));
          return;
        }
        this.auth.passwordHash = this.hashPassword(newPassword);
        this.auth.sessions.clear();
        this.saveAuth();
        this.resetToken = crypto.randomBytes(16).toString("hex");
        this.log.info(`memos-local: password has been reset. New reset token: ${this.resetToken}`);
        const sessionToken = this.createSession();
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie": `memos_token=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
        });
        res.end(JSON.stringify({ ok: true, message: "Password reset successfully" }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  }

  // ─── Pages ───

  private serveViewer(res: http.ServerResponse): void {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0", "Pragma": "no-cache", "Expires": "0" });
    res.end(viewerHTML(ViewerServer.PLUGIN_VERSION));
  }

  // ─── Data APIs ───

  private serveMemories(res: http.ServerResponse, url: URL): void {
    const limit = Math.min(Number(url.searchParams.get("limit")) || 40, 200);
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const offset = (page - 1) * limit;
    const session = url.searchParams.get("session") ?? undefined;
    const role = url.searchParams.get("role") ?? undefined;
    const kind = url.searchParams.get("kind") ?? undefined;
    const dateFrom = url.searchParams.get("dateFrom") ?? undefined;
    const dateTo = url.searchParams.get("dateTo") ?? undefined;
    const owner = url.searchParams.get("owner") ?? undefined;
    const sortBy = url.searchParams.get("sort") === "oldest" ? "ASC" : "DESC";

    const db = (this.store as any).db;
    const conditions: string[] = [];
    const params: any[] = [];
    if (session) { conditions.push("session_key = ?"); params.push(session); }
    if (role) { conditions.push("role = ?"); params.push(role); }
    if (kind) { conditions.push("kind = ?"); params.push(kind); }
    if (owner) { conditions.push("owner = ?"); params.push(owner); }
    if (dateFrom) { conditions.push("created_at >= ?"); params.push(new Date(dateFrom).getTime()); }
    if (dateTo) { conditions.push("created_at <= ?"); params.push(new Date(dateTo).getTime()); }

    const where = conditions.length > 0 ? " WHERE " + conditions.join(" AND ") : "";
    const totalRow = db.prepare("SELECT COUNT(*) as count FROM chunks" + where).get(...params) as any;
    const rawMemories = db.prepare("SELECT * FROM chunks" + where + ` ORDER BY created_at ${sortBy} LIMIT ? OFFSET ?`).all(...params, limit, offset);
    const memories = rawMemories.map((m: any) => {
      if (m.role === "user" && m.content) {
        return { ...m, content: stripInboundMetadata(m.content) };
      }
      return m;
    });

    this.store.recordViewerEvent("list");
    this.jsonResponse(res, {
      memories, page, limit, total: totalRow.count,
      totalPages: Math.ceil(totalRow.count / limit),
    });
  }

  private serveMetrics(res: http.ServerResponse, url: URL): void {
    const days = Math.min(90, Math.max(7, Number(url.searchParams.get("days")) || 30));
    const data = this.store.getMetrics(days);
    this.jsonResponse(res, data);
  }

  private serveToolMetrics(res: http.ServerResponse, url: URL): void {
    const minutes = Math.min(1440, Math.max(10, Number(url.searchParams.get("minutes")) || 60));
    const data = this.store.getToolMetrics(minutes);
    this.jsonResponse(res, data);
  }

  private serveTasks(res: http.ServerResponse, url: URL): void {
    this.store.recordViewerEvent("tasks_list");
    const status = url.searchParams.get("status") ?? undefined;
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    const { tasks, total } = this.store.listTasks({ status, limit, offset });

    const db = (this.store as any).db;
    const items = tasks.map((t) => {
      const meta = db.prepare("SELECT skill_status FROM tasks WHERE id = ?").get(t.id) as { skill_status: string | null } | undefined;
      return {
        id: t.id,
        sessionKey: t.sessionKey,
        title: t.title,
        summary: t.summary ? (t.summary.length > 300 ? t.summary.slice(0, 297) + "..." : t.summary) : "",
        status: t.status,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        chunkCount: this.store.countChunksByTask(t.id),
        skillStatus: meta?.skill_status ?? null,
      };
    });

    this.jsonResponse(res, { tasks: items, total, limit, offset });
  }

  private serveTaskDetail(res: http.ServerResponse, urlPath: string): void {
    const taskId = urlPath.replace("/api/task/", "");
    const task = this.store.getTask(taskId);
    if (!task) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Task not found" }));
      return;
    }

    const chunks = this.store.getChunksByTask(taskId);
    const chunkItems = chunks.map((c) => {
      let text = c.role === "user" ? stripInboundMetadata(c.content) : c.content;
      if (text.length > 500) text = text.slice(0, 497) + "...";
      return { id: c.id, role: c.role, content: text, summary: c.summary, createdAt: c.createdAt };
    });

    const relatedSkills = this.store.getSkillsByTask(taskId);
    const skillLinks = relatedSkills.map((rs) => ({
      skillId: rs.skill.id,
      skillName: rs.skill.name,
      relation: rs.relation,
      versionAt: rs.versionAt,
      status: rs.skill.status,
      qualityScore: rs.skill.qualityScore,
    }));

    const db = (this.store as any).db;
    const meta = db.prepare("SELECT skill_status, skill_reason FROM tasks WHERE id = ?").get(taskId) as
      { skill_status: string | null; skill_reason: string | null } | undefined;

    this.jsonResponse(res, {
      id: task.id,
      sessionKey: task.sessionKey,
      title: task.title,
      summary: task.summary,
      status: task.status,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      chunks: chunkItems,
      skillStatus: meta?.skill_status ?? null,
      skillReason: meta?.skill_reason ?? null,
      skillLinks,
    });
  }

  private serveStats(res: http.ServerResponse): void {
    const emptyStats = {
      totalMemories: 0, totalSessions: 0, totalEmbeddings: 0, totalSkills: 0,
      embeddingProvider: this.embedder?.provider ?? "none",
      roleBreakdown: {}, kindBreakdown: {}, dedupBreakdown: {},
      timeRange: { earliest: null, latest: null },
      sessions: [],
    };

    if (!this.store || !(this.store as any).db) {
      this.jsonResponse(res, emptyStats);
      return;
    }

    try {
      const db = (this.store as any).db;
      const total = db.prepare("SELECT COUNT(*) as count FROM chunks").get() as any;
      const sessions = db.prepare("SELECT COUNT(DISTINCT session_key) as count FROM chunks").get() as any;
      const roles = db.prepare("SELECT role, COUNT(*) as count FROM chunks GROUP BY role").all() as any[];
      const timeRange = db.prepare("SELECT MIN(created_at) as earliest, MAX(created_at) as latest FROM chunks").get() as any;
      let embCount = 0;
      try { embCount = (db.prepare("SELECT COUNT(*) as count FROM embeddings").get() as any).count; } catch { /* table may not exist */ }
      const kinds = db.prepare("SELECT kind, COUNT(*) as count FROM chunks GROUP BY kind").all() as any[];
      const sessionList = db.prepare(
        "SELECT session_key, COUNT(*) as count, MIN(created_at) as earliest, MAX(created_at) as latest FROM chunks GROUP BY session_key ORDER BY latest DESC",
      ).all() as any[];

      let skillCount = 0;
      try { skillCount = (db.prepare("SELECT COUNT(*) as count FROM skills").get() as any).count; } catch { /* table may not exist yet */ }

      let dedupBreakdown: Record<string, number> = {};
      try {
        const dedupRows = db.prepare("SELECT dedup_status, COUNT(*) as count FROM chunks GROUP BY dedup_status").all() as any[];
        dedupBreakdown = Object.fromEntries(dedupRows.map((d: any) => [d.dedup_status ?? "active", d.count]));
      } catch { /* column may not exist yet */ }

      let owners: string[] = [];
      try {
        const ownerRows = db.prepare("SELECT DISTINCT owner FROM chunks WHERE owner IS NOT NULL ORDER BY owner").all() as any[];
        owners = ownerRows.map((o: any) => o.owner);
      } catch { /* column may not exist yet */ }

      this.jsonResponse(res, {
        totalMemories: total.count, totalSessions: sessions.count, totalEmbeddings: embCount,
        totalSkills: skillCount,
        embeddingProvider: this.embedder.provider,
        roleBreakdown: Object.fromEntries(roles.map((r: any) => [r.role, r.count])),
        kindBreakdown: Object.fromEntries(kinds.map((k: any) => [k.kind, k.count])),
        dedupBreakdown,
        timeRange: { earliest: timeRange.earliest, latest: timeRange.latest },
        sessions: sessionList,
        owners,
      });
    } catch (e) {
      this.log.warn(`stats error: ${e}`);
      this.jsonResponse(res, emptyStats);
    }
  }

  private async serveSearch(_req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const q = url.searchParams.get("q") ?? "";
    if (!q.trim()) { this.jsonResponse(res, { results: [], query: q }); return; }

    const role = url.searchParams.get("role") ?? undefined;
    const kind = url.searchParams.get("kind") ?? undefined;
    const dateFrom = url.searchParams.get("dateFrom") ?? undefined;
    const dateTo = url.searchParams.get("dateTo") ?? undefined;

    const passesFilter = (r: any): boolean => {
      if (role && r.role !== role) return false;
      if (kind && r.kind !== kind) return false;
      if (dateFrom && r.created_at < new Date(dateFrom).getTime()) return false;
      if (dateTo && r.created_at > new Date(dateTo).getTime()) return false;
      return true;
    };

    const db = (this.store as any).db;
    let ftsResults: any[] = [];
    try {
      ftsResults = db.prepare(
        "SELECT c.* FROM chunks_fts f JOIN chunks c ON f.rowid = c.rowid WHERE chunks_fts MATCH ? ORDER BY rank LIMIT 100",
      ).all(q).filter(passesFilter);
    } catch {
      ftsResults = db.prepare(
        "SELECT * FROM chunks WHERE content LIKE ? OR summary LIKE ? ORDER BY created_at DESC LIMIT 100",
      ).all(`%${q}%`, `%${q}%`).filter(passesFilter);
    }

    const SEMANTIC_THRESHOLD = 0.64;
    let vectorResults: any[] = [];
    let scoreMap = new Map<string, number>();
    try {
      const queryVec = await this.embedder.embedQuery(q);
      const hits = vectorSearch(this.store, queryVec, 40);
      scoreMap = new Map(hits.map(h => [h.chunkId, h.score]));
      const hitIds = new Set(hits.filter(h => h.score >= SEMANTIC_THRESHOLD).map(h => h.chunkId));
      if (hitIds.size > 0) {
        const placeholders = [...hitIds].map(() => "?").join(",");
        const rows = db.prepare(`SELECT * FROM chunks WHERE id IN (${placeholders})`).all(...hitIds).filter(passesFilter);
        rows.forEach((r: any) => { r._vscore = scoreMap.get(r.id) ?? 0; });
        rows.sort((a: any, b: any) => (b._vscore ?? 0) - (a._vscore ?? 0));
        vectorResults = rows;
      }
    } catch (err) {
      this.log.warn(`Vector search failed (falling back to FTS only): ${err}`);
    }

    const seenIds = new Set<string>();
    const merged: any[] = [];
    for (const r of vectorResults) {
      if (!seenIds.has(r.id)) { seenIds.add(r.id); merged.push(r); }
    }
    for (const r of ftsResults) {
      if (seenIds.has(r.id)) continue;
      const vscore = scoreMap.get(r.id);
      if (vscore !== undefined && vscore < SEMANTIC_THRESHOLD) continue;
      seenIds.add(r.id); merged.push(r);
    }

    const fallback = merged.length === 0 && ftsResults.length > 0;
    const results = fallback ? ftsResults.slice(0, 20) : merged;

    this.store.recordViewerEvent("search");
    this.jsonResponse(res, {
      results,
      query: q,
      vectorCount: vectorResults.length,
      ftsCount: ftsResults.length,
      total: results.length,
      fallbackFts: fallback,
    });
  }

  // ─── Skills API ───

  private serveSkills(res: http.ServerResponse, url: URL): void {
    const status = url.searchParams.get("status") ?? undefined;
    const visibility = url.searchParams.get("visibility") ?? undefined;
    let skills = this.store.listSkills({ status });
    if (visibility) {
      skills = skills.filter(s => s.visibility === visibility);
    }
    this.jsonResponse(res, { skills });
  }

  private serveSkillDetail(res: http.ServerResponse, urlPath: string): void {
    const skillId = urlPath.replace("/api/skill/", "");
    const skill = this.store.getSkill(skillId);
    if (!skill) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Skill not found" }));
      return;
    }

    const versions = this.store.getSkillVersions(skillId);
    const relatedTasks = this.store.getTasksBySkill(skillId);
    const files = fs.existsSync(skill.dirPath) ? this.walkDir(skill.dirPath, skill.dirPath) : [];

    this.jsonResponse(res, {
      skill,
      versions: versions.map(v => ({
        id: v.id,
        version: v.version,
        content: v.content,
        changelog: v.changelog,
        changeSummary: v.changeSummary,
        upgradeType: v.upgradeType,
        sourceTaskId: v.sourceTaskId,
        metrics: v.metrics,
        qualityScore: v.qualityScore,
        createdAt: v.createdAt,
      })),
      relatedTasks: relatedTasks.map(rt => ({
        task: {
          id: rt.task.id,
          title: rt.task.title,
          status: rt.task.status,
          startedAt: rt.task.startedAt,
        },
        relation: rt.relation,
      })),
      files,
    });
  }

  private serveSkillFiles(res: http.ServerResponse, urlPath: string): void {
    const skillId = urlPath.replace("/api/skill/", "").replace("/files", "");
    const skill = this.store.getSkill(skillId);
    if (!skill) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Skill not found" }));
      return;
    }

    if (!fs.existsSync(skill.dirPath)) {
      this.jsonResponse(res, { files: [], error: "Skill directory not found" });
      return;
    }

    const files = this.walkDir(skill.dirPath, skill.dirPath);
    this.jsonResponse(res, { files });
  }

  private walkDir(dir: string, root: string): Array<{ path: string; type: string; size: number }> {
    const results: Array<{ path: string; type: string; size: number }> = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(root, fullPath);
        if (entry.isDirectory()) {
          results.push(...this.walkDir(fullPath, root));
        } else {
          const stat = fs.statSync(fullPath);
          const ext = path.extname(entry.name).toLowerCase();
          let type = "file";
          if (entry.name === "SKILL.md") type = "skill";
          else if ([".sh", ".py", ".ts", ".js"].includes(ext)) type = "script";
          else if ([".md", ".txt", ".json"].includes(ext)) type = "reference";
          results.push({ path: relPath, type, size: stat.size });
        }
      }
    } catch { /* directory may not exist */ }
    return results;
  }

  private serveSkillDownload(res: http.ServerResponse, urlPath: string): void {
    const skillId = urlPath.replace("/api/skill/", "").replace("/download", "");
    const skill = this.store.getSkill(skillId);
    if (!skill) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Skill not found" }));
      return;
    }

    if (!fs.existsSync(skill.dirPath)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Skill directory not found" }));
      return;
    }

    const zipName = `${skill.name}-v${skill.version}.zip`;
    const tmpPath = path.join(require("os").tmpdir(), zipName);

    try {
      try { fs.unlinkSync(tmpPath); } catch { /* no-op */ }
      execSync(
        `cd "${path.dirname(skill.dirPath)}" && zip -r "${tmpPath}" "${path.basename(skill.dirPath)}"`,
        { timeout: 15_000 },
      );

      const data = fs.readFileSync(tmpPath);
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${zipName}"`,
        "Content-Length": String(data.length),
      });
      res.end(data);

      try { fs.unlinkSync(tmpPath); } catch { /* cleanup */ }
    } catch (err) {
      this.log.error(`Skill download zip failed: ${err}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Failed to create zip: ${err}` }));
    }
  }

  private handleSkillVisibility(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string): void {
    const segments = urlPath.split("/");
    const skillId = segments[segments.length - 2];
    this.readBody(req, (body) => {
      try {
        const parsed = JSON.parse(body);
        const visibility = parsed.visibility;
        if (visibility !== "public" && visibility !== "private") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `visibility must be 'public' or 'private', got: '${visibility}'` }));
          return;
        }
        const skill = this.store.getSkill(skillId);
        if (!skill) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Skill not found: ${skillId}` }));
          return;
        }
        this.store.setSkillVisibility(skillId, visibility);
        this.jsonResponse(res, { ok: true, skillId, visibility });
      } catch (err) {
        this.log.error(`handleSkillVisibility error: skillId=${skillId}, body=${body}, err=${err}`);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  }

  // ─── Task/Skill management ───

  private handleTaskRetrySkill(_req: http.IncomingMessage, res: http.ServerResponse, urlPath: string): void {
    const taskId = urlPath.replace("/api/task/", "").replace("/retry-skill", "");
    const task = this.store.getTask(taskId);
    if (!task) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Task not found" })); return; }
    if (task.status !== "completed") { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Only completed tasks can retry skill generation" })); return; }
    if (!this.ctx) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Plugin context not available" })); return; }

    // Clean up stale task_skills references (e.g., skill was manually deleted)
    const db = (this.store as any).db;
    db.prepare("DELETE FROM task_skills WHERE task_id = ? AND skill_id NOT IN (SELECT id FROM skills)").run(taskId);

    this.store.setTaskSkillMeta(taskId, { skillStatus: "queued", skillReason: "手动重试中..." });
    this.jsonResponse(res, { ok: true, taskId, status: "queued" });

    const ctx = this.ctx;
    const recallEngine = new RecallEngine(this.store, this.embedder, ctx);
    const evolver = new SkillEvolver(this.store, recallEngine, ctx, this.embedder);
    evolver.onTaskCompleted(task).then(() => {
      this.log.info(`Retry skill generation completed for task ${taskId}`);
    }).catch((err) => {
      this.log.error(`Retry skill generation failed for task ${taskId}: ${err}`);
      this.store.setTaskSkillMeta(taskId, { skillStatus: "skipped", skillReason: `error: ${err}` });
    });
  }

  private handleTaskDelete(res: http.ServerResponse, urlPath: string): void {
    const taskId = urlPath.replace("/api/task/", "");
    const deleted = this.store.deleteTask(taskId);
    if (!deleted) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Task not found" })); return; }
    this.jsonResponse(res, { ok: true, taskId });
  }

  private handleTaskUpdate(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string): void {
    const taskId = urlPath.replace("/api/task/", "");
    this.readBody(req, (body) => {
      try {
        const data = JSON.parse(body);
        const task = this.store.getTask(taskId);
        if (!task) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Task not found" })); return; }
        this.store.updateTask(taskId, {
          title: data.title ?? task.title,
          summary: data.summary ?? task.summary,
          status: data.status ?? task.status,
          endedAt: task.endedAt ?? undefined,
        });
        this.jsonResponse(res, { ok: true, taskId });
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  }

  private handleSkillDelete(res: http.ServerResponse, urlPath: string): void {
    const skillId = urlPath.replace("/api/skill/", "");
    const skill = this.store.getSkill(skillId);
    if (!skill) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Skill not found" })); return; }
    // Remove skill directory from disk
    try {
      if (skill.dirPath && fs.existsSync(skill.dirPath)) {
        fs.rmSync(skill.dirPath, { recursive: true, force: true });
      }
    } catch (err) {
      this.log.warn(`Failed to remove skill directory ${skill.dirPath}: ${err}`);
    }
    this.store.deleteSkill(skillId);
    this.jsonResponse(res, { ok: true, skillId });
  }

  private handleSkillUpdate(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string): void {
    const skillId = urlPath.replace("/api/skill/", "");
    this.readBody(req, (body) => {
      try {
        const data = JSON.parse(body);
        const skill = this.store.getSkill(skillId);
        if (!skill) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Skill not found" })); return; }
        this.store.updateSkill(skillId, {
          description: data.description ?? skill.description,
          version: skill.version,
          status: data.status ?? skill.status,
          installed: skill.installed,
          qualityScore: skill.qualityScore,
        });
        this.jsonResponse(res, { ok: true, skillId });
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  }

  // ─── CRUD ───

  private handleCreate(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(req, (body) => {
      try {
        const data = JSON.parse(body);
        if (!data.content || typeof data.content !== "string" || !data.content.trim()) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "content is required and must be a non-empty string" }));
          return;
        }
        const { v4: uuidv4 } = require("uuid");
        const id = uuidv4();
        const now = Date.now();
        this.store.insertChunk({
          id, sessionKey: data.session_key || "manual", turnId: `manual-${now}`, seq: 0,
          role: data.role || "user", content: data.content, kind: data.kind || "paragraph",
          summary: data.summary || data.content.slice(0, 100),
          taskId: null, skillId: null, owner: data.owner || "agent:main",
          dedupStatus: "active", dedupTarget: null, dedupReason: null,
          mergeCount: 0, lastHitAt: null, mergeHistory: "[]",
          createdAt: now, updatedAt: now, embedding: null,
        });
        this.jsonResponse(res, { ok: true, id, message: "Memory created" });
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  }

  private serveMemoryDetail(res: http.ServerResponse, urlPath: string): void {
    const chunkId = urlPath.replace("/api/memory/", "");
    const chunk = this.store.getChunk(chunkId);
    if (!chunk) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }
    const cleaned = chunk.role === "user" && chunk.content
      ? { ...chunk, content: stripInboundMetadata(chunk.content) }
      : chunk;
    this.jsonResponse(res, { memory: cleaned });
  }

  private handleUpdate(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string): void {
    const chunkId = urlPath.replace("/api/memory/", "");
    this.readBody(req, (body) => {
      try {
        const data = JSON.parse(body);
        if (data.content !== undefined && (typeof data.content !== "string" || !data.content.trim())) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "content must be a non-empty string" }));
          return;
        }
        const ok = this.store.updateChunk(chunkId, { summary: data.summary, content: data.content, role: data.role, kind: data.kind, owner: data.owner });
        if (ok) this.jsonResponse(res, { ok: true, message: "Memory updated" });
        else { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Not found" })); }
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  }

  private handleDelete(res: http.ServerResponse, urlPath: string): void {
    const chunkId = urlPath.replace("/api/memory/", "");
    if (this.store.deleteChunk(chunkId)) this.jsonResponse(res, { ok: true });
    else { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Not found" })); }
  }

  private handleDeleteSession(res: http.ServerResponse, url: URL): void {
    const key = url.searchParams.get("key");
    if (!key) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Missing key" })); return; }
    const count = this.store.deleteSession(key);
    this.jsonResponse(res, { ok: true, deleted: count });
  }

  private handleDeleteAll(res: http.ServerResponse): void {
    const result = this.store.deleteAll();
    // Clean up skills-store directory
    const skillsStoreDir = path.join(this.dataDir, "skills-store");
    try {
      if (fs.existsSync(skillsStoreDir)) {
        fs.rmSync(skillsStoreDir, { recursive: true });
        fs.mkdirSync(skillsStoreDir, { recursive: true });
        this.log.info("Cleared skills-store directory");
      }
    } catch (err) {
      this.log.warn(`Failed to clear skills-store: ${err}`);
    }
    this.jsonResponse(res, { ok: true, deleted: result });
  }

  // ─── Helpers ───

  // ─── Config API ───

  private getOpenClawConfigPath(): string {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    return path.join(home, ".openclaw", "openclaw.json");
  }

  private serveConfig(res: http.ServerResponse): void {
    try {
      const cfgPath = this.getOpenClawConfigPath();
      if (!fs.existsSync(cfgPath)) {
        this.jsonResponse(res, {});
        return;
      }
      const raw = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
      const entries = raw?.plugins?.entries ?? {};
      const pluginEntry = entries["memos-local-openclaw-plugin"]?.config
        ?? entries["memos-lite-openclaw-plugin"]?.config
        ?? entries["memos-lite"]?.config
        ?? {};
      const result: Record<string, unknown> = { ...pluginEntry };
      const topEntry = entries["memos-local-openclaw-plugin"]
        ?? entries["memos-lite-openclaw-plugin"]
        ?? entries["memos-lite"]
        ?? {};
      if (pluginEntry.viewerPort == null && topEntry.viewerPort) {
        result.viewerPort = topEntry.viewerPort;
      }
      this.jsonResponse(res, result);
    } catch (e) {
      this.log.warn(`serveConfig error: ${e}`);
      this.jsonResponse(res, {});
    }
  }

  private handleSaveConfig(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(req, (body) => {
      try {
        const newCfg = JSON.parse(body);
        const cfgPath = this.getOpenClawConfigPath();
        let raw: Record<string, unknown> = {};
        if (fs.existsSync(cfgPath)) {
          raw = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
        }

        if (!raw.plugins) raw.plugins = {};
        const plugins = raw.plugins as Record<string, unknown>;
        if (!plugins.entries) plugins.entries = {};
        const entries = plugins.entries as Record<string, unknown>;
        const entryKey = entries["memos-local-openclaw-plugin"] ? "memos-local-openclaw-plugin"
          : entries["memos-lite-openclaw-plugin"] ? "memos-lite-openclaw-plugin"
          : entries["memos-lite"] ? "memos-lite"
          : "memos-local-openclaw-plugin";
        if (!entries[entryKey]) entries[entryKey] = { enabled: true };
        const entry = entries[entryKey] as Record<string, unknown>;
        if (!entry.config) entry.config = {};
        const config = entry.config as Record<string, unknown>;

        if (newCfg.embedding) config.embedding = newCfg.embedding;
        if (newCfg.summarizer) config.summarizer = newCfg.summarizer;
        if (newCfg.skillEvolution) config.skillEvolution = newCfg.skillEvolution;
        if (newCfg.viewerPort) config.viewerPort = newCfg.viewerPort;
        if (newCfg.telemetry !== undefined) config.telemetry = newCfg.telemetry;

        fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
        fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2), "utf-8");
        this.log.info("Plugin config updated via Viewer");
        this.jsonResponse(res, { ok: true });
      } catch (e) {
        this.log.warn(`handleSaveConfig error: ${e}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
  }

  private serveLogs(res: http.ServerResponse, url: URL): void {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 200);
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
    const tool = url.searchParams.get("tool") || undefined;
    const { logs, total } = this.store.getApiLogs(limit, offset, tool);
    const page = Math.floor(offset / limit) + 1;
    const totalPages = Math.ceil(total / limit);
    this.jsonResponse(res, { logs, total, page, totalPages, limit, offset });
  }

  private serveLogTools(res: http.ServerResponse): void {
    const tools = this.store.getApiLogToolNames();
    this.jsonResponse(res, { tools });
  }

  // ─── Migration: scan OpenClaw built-in memory ───

  private getOpenClawHome(): string {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    return path.join(home, ".openclaw");
  }

  private handleMigrateScan(res: http.ServerResponse): void {
    try {
      const ocHome = this.getOpenClawHome();
      const memoryDir = path.join(ocHome, "memory");
      const sessionsDir = path.join(ocHome, "agents", "main", "sessions");

      const sqliteFiles: Array<{ file: string; chunks: number }> = [];
      if (fs.existsSync(memoryDir)) {
        for (const f of fs.readdirSync(memoryDir)) {
          if (f.endsWith(".sqlite")) {
            try {
              const Database = require("better-sqlite3");
              const db = new Database(path.join(memoryDir, f), { readonly: true });
              const row = db.prepare("SELECT COUNT(*) as cnt FROM chunks").get() as { cnt: number };
              sqliteFiles.push({ file: f, chunks: row.cnt });
              db.close();
            } catch { /* skip unreadable */ }
          }
        }
      }

      let sessionCount = 0;
      let messageCount = 0;
      if (fs.existsSync(sessionsDir)) {
        const jsonlFiles = fs.readdirSync(sessionsDir).filter(f => f.includes(".jsonl"));
        sessionCount = jsonlFiles.length;
        for (const f of jsonlFiles) {
          try {
            const content = fs.readFileSync(path.join(sessionsDir, f), "utf-8");
            const lines = content.split("\n").filter(l => l.trim());
            for (const line of lines) {
              try {
                const obj = JSON.parse(line);
                if (obj.type === "message") {
                  const role = obj.message?.role ?? obj.role;
                  if (role === "user" || role === "assistant") {
                    const mc = obj.message?.content ?? obj.content;
                    let txt = "";
                    if (typeof mc === "string") txt = mc;
                    else if (Array.isArray(mc)) txt = mc.filter((p: any) => p.type === "text" && p.text).map((p: any) => p.text).join("\n");
                    else txt = JSON.stringify(mc);
                    if (role === "user") txt = stripInboundMetadata(txt);
                    if (txt && txt.length >= 10) messageCount++;
                  }
                }
              } catch { /* skip bad lines */ }
            }
          } catch { /* skip unreadable */ }
        }
      }

      const cfgPath = this.getOpenClawConfigPath();
      let hasEmbedding = false;
      let hasSummarizer = false;
      if (fs.existsSync(cfgPath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
          const pluginCfg = raw?.plugins?.entries?.["memos-local-openclaw-plugin"]?.config ??
                            raw?.plugins?.entries?.["memos-lite"]?.config ??
                            raw?.plugins?.entries?.["memos-lite-openclaw-plugin"]?.config ?? {};
          const emb = pluginCfg.embedding;
          hasEmbedding = !!(emb && emb.provider);
          const sum = pluginCfg.summarizer;
          hasSummarizer = !!(sum && sum.provider);
        } catch { /* ignore */ }
      }

      let importedSessions: string[] = [];
      try {
        if (this.store) {
          importedSessions = this.store.getDistinctSessionKeys()
            .filter((sk: string) => sk.startsWith("openclaw-import-") || sk.startsWith("openclaw-session-"));
        }
      } catch (storeErr) {
        this.log.warn(`migrate/scan: store query failed: ${storeErr}`);
      }

      this.jsonResponse(res, {
        sqliteFiles,
        sessions: { count: sessionCount, messages: messageCount },
        totalItems: sqliteFiles.reduce((s, f) => s + f.chunks, 0) + messageCount,
        configReady: hasEmbedding && hasSummarizer,
        hasEmbedding,
        hasSummarizer,
        hasImportedData: importedSessions.length > 0,
        importedSessionCount: importedSessions.length,
      });
    } catch (e) {
      this.log.warn(`migrate/scan error: ${e}`);
      this.jsonResponse(res, {
        sqliteFiles: [],
        sessions: { count: 0, messages: 0 },
        totalItems: 0,
        configReady: false,
        hasEmbedding: false,
        hasSummarizer: false,
        hasImportedData: false,
        importedSessionCount: 0,
        error: String(e),
      });
    }
  }

  // ─── Migration: start import with SSE progress ───

  private broadcastSSE(event: string, data: unknown): void {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    this.migrationSSEClients = this.migrationSSEClients.filter(c => {
      try { c.write(msg); return true; } catch { return false; }
    });
  }

  private handleMigrateStatus(res: http.ServerResponse): void {
    this.jsonResponse(res, {
      running: this.migrationRunning,
      ...this.migrationState,
    });
  }

  private handleMigrateStop(res: http.ServerResponse): void {
    if (!this.migrationRunning) {
      this.jsonResponse(res, { ok: false, error: "not_running" });
      return;
    }
    this.migrationAbort = true;
    this.jsonResponse(res, { ok: true });
  }

  private handleMigrateStream(res: http.ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    if (this.migrationRunning) {
      res.write(`event: state\ndata: ${JSON.stringify(this.migrationState)}\n\n`);
      this.migrationSSEClients.push(res);
      res.on("close", () => {
        this.migrationSSEClients = this.migrationSSEClients.filter(c => c !== res);
      });
    } else if (this.migrationState.done) {
      const evtName = this.migrationState.stopped ? "stopped" : "done";
      res.write(`event: state\ndata: ${JSON.stringify(this.migrationState)}\n\n`);
      res.write(`event: ${evtName}\ndata: ${JSON.stringify({ ok: true })}\n\n`);
      res.end();
    } else {
      res.end();
    }
  }

  private handleMigrateStart(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (this.migrationRunning) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(`event: state\ndata: ${JSON.stringify(this.migrationState)}\n\n`);
      this.migrationSSEClients.push(res);
      res.on("close", () => {
        this.migrationSSEClients = this.migrationSSEClients.filter(c => c !== res);
      });
      return;
    }

    this.readBody(req, (body) => {
      let opts: { sources?: string[]; concurrency?: number } = {};
      try { opts = JSON.parse(body); } catch { /* defaults */ }

      const concurrency = Math.max(1, Math.min(opts.concurrency ?? 1, 8));

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });

      this.migrationSSEClients.push(res);
      res.on("close", () => {
        this.migrationSSEClients = this.migrationSSEClients.filter(c => c !== res);
      });

      this.migrationAbort = false;
      this.migrationState = { phase: "", stored: 0, skipped: 0, merged: 0, errors: 0, processed: 0, total: 0, lastItem: null, done: false, stopped: false };

      const send = (event: string, data: unknown) => {
        if (event === "item") {
          const d = data as any;
          if (d.status === "stored") this.migrationState.stored++;
          else if (d.status === "skipped" || d.status === "duplicate") this.migrationState.skipped++;
          else if (d.status === "merged") this.migrationState.merged++;
          else if (d.status === "error") this.migrationState.errors++;
          this.migrationState.processed = d.index ?? this.migrationState.processed + 1;
          this.migrationState.total = d.total ?? this.migrationState.total;
          this.migrationState.lastItem = d;
        } else if (event === "phase") {
          this.migrationState.phase = (data as any).phase;
        } else if (event === "progress") {
          this.migrationState.total = (data as any).total ?? this.migrationState.total;
        }
        this.broadcastSSE(event, data);
      };

      this.migrationRunning = true;
      this.runMigration(send, opts.sources, concurrency).finally(() => {
        this.migrationRunning = false;
        this.migrationState.done = true;
        if (this.migrationAbort) {
          this.migrationState.stopped = true;
          this.broadcastSSE("stopped", { ok: true, ...this.migrationState });
        } else {
          this.broadcastSSE("done", { ok: true });
        }
        for (const c of this.migrationSSEClients) {
          try { c.end(); } catch { /* ignore */ }
        }
        this.migrationSSEClients = [];
        this.migrationAbort = false;
      });
    });
  }

  private async runMigration(
    send: (event: string, data: unknown) => void,
    sources?: string[],
    concurrency: number = 1,
  ): Promise<void> {
    const ocHome = this.getOpenClawHome();
    const importSqlite = !sources || sources.includes("sqlite");
    const importSessions = !sources || sources.includes("sessions");

    let totalProcessed = 0;
    let totalStored = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    const cfgPath = this.getOpenClawConfigPath();
    let summarizerCfg: any;
    let strongCfg: any;
    try {
      const raw = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
      const pluginCfg = raw?.plugins?.entries?.["memos-local-openclaw-plugin"]?.config ??
                        raw?.plugins?.entries?.["memos-lite"]?.config ??
                        raw?.plugins?.entries?.["memos-lite-openclaw-plugin"]?.config ?? {};
      summarizerCfg = pluginCfg.summarizer;
      strongCfg = pluginCfg.skillEvolution?.summarizer;
    } catch { /* no config */ }

    const summarizer = new Summarizer(summarizerCfg, this.log, strongCfg);

    // Phase 1: Import SQLite memory chunks
    if (importSqlite) {
      const memoryDir = path.join(ocHome, "memory");
      if (fs.existsSync(memoryDir)) {
        const files = fs.readdirSync(memoryDir).filter(f => f.endsWith(".sqlite"));
        for (const file of files) {
          if (this.migrationAbort) break;
          send("phase", { phase: "sqlite", file });
          try {
            const Database = require("better-sqlite3");
            const db = new Database(path.join(memoryDir, file), { readonly: true });
            const rows = db.prepare("SELECT id, path, text, updated_at FROM chunks ORDER BY updated_at ASC").all() as Array<{
              id: string; path: string; text: string; updated_at: number;
            }>;
            db.close();

            const agentId = file.replace(".sqlite", "");
            send("progress", { total: rows.length, processed: 0, phase: "sqlite", file });

            for (let i = 0; i < rows.length; i++) {
              if (this.migrationAbort) break;
              const row = rows[i];
              totalProcessed++;

              const contentHash = crypto.createHash("sha256").update(row.text).digest("hex");
              if (this.store.chunkExistsByContent(`openclaw-import-${agentId}`, "assistant", row.text)) {
                totalSkipped++;
                send("item", {
                  index: i + 1,
                  total: rows.length,
                  status: "skipped",
                  preview: row.text.slice(0, 120),
                  source: file,
                  reason: "duplicate",
                });
                continue;
              }

              const importOwner = `agent:${agentId}`;

              // Exact hash dedup within same agent
              const existingByHash = this.store.findActiveChunkByHash(row.text, importOwner);
              if (existingByHash) {
                totalSkipped++;
                send("item", {
                  index: i + 1,
                  total: rows.length,
                  status: "skipped",
                  preview: row.text.slice(0, 120),
                  source: file,
                  reason: "exact duplicate within agent",
                });
                continue;
              }

              try {
                const summary = await summarizer.summarize(row.text);
                let embedding: number[] | null = null;
                try {
                  [embedding] = await this.embedder.embed([summary]);
                } catch (err) {
                  this.log.warn(`Migration embed failed: ${err}`);
                }

                let dedupStatus: "active" | "duplicate" | "merged" = "active";
                let dedupTarget: string | null = null;
                let dedupReason: string | null = null;

                if (embedding) {
                  const importThreshold = this.ctx?.config?.dedup?.similarityThreshold ?? 0.60;
                  const dedupOwnerFilter = [importOwner];
                  const topSimilar = findTopSimilar(this.store, embedding, importThreshold, 5, this.log, dedupOwnerFilter);
                  if (topSimilar.length > 0) {
                    const candidates = topSimilar.map((s, idx) => {
                      const chunk = this.store.getChunk(s.chunkId);
                      return { index: idx + 1, summary: chunk?.summary ?? "", chunkId: s.chunkId };
                    }).filter(c => c.summary);

                    if (candidates.length > 0) {
                      const dedupResult = await summarizer.judgeDedup(summary, candidates);
                      if (dedupResult?.action === "DUPLICATE" && dedupResult.targetIndex) {
                        const targetId = candidates[dedupResult.targetIndex - 1]?.chunkId;
                        if (targetId) {
                          dedupStatus = "duplicate";
                          dedupTarget = targetId;
                          dedupReason = dedupResult.reason;
                        }
                      } else if (dedupResult?.action === "UPDATE" && dedupResult.targetIndex && dedupResult.mergedSummary) {
                        const targetId = candidates[dedupResult.targetIndex - 1]?.chunkId;
                        if (targetId) {
                          this.store.updateChunkSummaryAndContent(targetId, dedupResult.mergedSummary, row.text);
                          try {
                            const [newEmb] = await this.embedder.embed([dedupResult.mergedSummary]);
                            if (newEmb) this.store.upsertEmbedding(targetId, newEmb);
                          } catch { /* best-effort */ }
                          dedupStatus = "merged";
                          dedupTarget = targetId;
                          dedupReason = dedupResult.reason;
                        }
                      }
                    }
                  }
                }

                const chunkId = uuid();
                const chunk: Chunk = {
                  id: chunkId,
                  sessionKey: `openclaw-import-${agentId}`,
                  turnId: `import-${row.id}`,
                  seq: 0,
                  role: "assistant",
                  content: row.text,
                  kind: "paragraph",
                  summary,
                  embedding: null,
                  taskId: null,
                  skillId: null,
                  owner: `agent:${agentId}`,
                  dedupStatus,
                  dedupTarget,
                  dedupReason,
                  mergeCount: 0,
                  lastHitAt: null,
                  mergeHistory: "[]",
                  createdAt: row.updated_at * 1000,
                  updatedAt: row.updated_at * 1000,
                };

                this.store.insertChunk(chunk);
                if (embedding && dedupStatus === "active") {
                  this.store.upsertEmbedding(chunkId, embedding);
                }

                totalStored++;
                send("item", {
                  index: i + 1,
                  total: rows.length,
                  status: dedupStatus === "active" ? "stored" : dedupStatus,
                  preview: row.text.slice(0, 120),
                  summary: summary.slice(0, 80),
                  source: file,
                });
              } catch (err) {
                totalErrors++;
                send("item", {
                  index: i + 1,
                  total: rows.length,
                  status: "error",
                  preview: row.text.slice(0, 120),
                  source: file,
                  error: String(err).slice(0, 200),
                });
              }
            }
          } catch (err) {
            send("error", { file, error: String(err) });
            totalErrors++;
          }
        }
      }
    }

    // Phase 2: Import session JSONL files from ALL agents (supports parallel by agent)
    if (importSessions) {
      const agentsDir = path.join(ocHome, "agents");
      const agentGroups: Map<string, Array<{ file: string; filePath: string }>> = new Map();
      if (fs.existsSync(agentsDir)) {
        for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            const sessDir = path.join(agentsDir, entry.name, "sessions");
            if (fs.existsSync(sessDir)) {
              const jsonlFiles = fs.readdirSync(sessDir).filter(f => f.includes(".jsonl")).sort();
              if (jsonlFiles.length > 0) {
                agentGroups.set(entry.name, jsonlFiles.map(f => ({ file: f, filePath: path.join(sessDir, f) })));
              }
            }
          }
        }
      }

      const agentIds = Array.from(agentGroups.keys());
      const allFileCount = Array.from(agentGroups.values()).reduce((s, g) => s + g.length, 0);
      send("phase", { phase: "sessions", files: allFileCount, agents: agentIds, concurrency });

      // Count total messages across all agents
      let totalMsgs = 0;
      for (const files of agentGroups.values()) {
        for (const { filePath } of files) {
          try {
            const raw = fs.readFileSync(filePath, "utf-8");
            for (const line of raw.split("\n")) {
              if (!line.trim()) continue;
              try {
                const obj = JSON.parse(line);
                if (obj.type === "message") {
                  const role = obj.message?.role ?? obj.role;
                  if (role === "user" || role === "assistant") {
                    const mc = obj.message?.content ?? obj.content;
                    let txt = "";
                    if (typeof mc === "string") txt = mc;
                    else if (Array.isArray(mc)) txt = mc.filter((p: any) => p.type === "text" && p.text).map((p: any) => p.text).join("\n");
                    else txt = JSON.stringify(mc);
                    if (role === "user") txt = stripInboundMetadata(txt);
                    if (txt && txt.length >= 10) totalMsgs++;
                  }
                }
              } catch { /* skip */ }
            }
          } catch { /* skip */ }
        }
      }

      // Thread-safe counters for parallel execution
      let globalMsgIdx = 0;
      const incIdx = () => ++globalMsgIdx;

      // Import one agent's sessions sequentially
      const importAgent = async (agentId: string, files: Array<{ file: string; filePath: string }>) => {
        const agentOwner = `agent:${agentId}`;
        for (const { file, filePath } of files) {
          if (this.migrationAbort) break;
          const sessionId = file.replace(/\.jsonl.*$/, "");

          try {
            const fileStream = fs.createReadStream(filePath, { encoding: "utf-8" });
            const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

            for await (const line of rl) {
              if (this.migrationAbort) break;
              if (!line.trim()) continue;
              let obj: any;
              try { obj = JSON.parse(line); } catch { continue; }
              if (obj.type !== "message") continue;
              const msgRole = obj.message?.role ?? obj.role;
              if (msgRole !== "user" && msgRole !== "assistant") continue;

              const msgContent = obj.message?.content ?? obj.content;
              let content: string;
              if (typeof msgContent === "string") {
                content = msgContent;
              } else if (Array.isArray(msgContent)) {
                content = msgContent
                  .filter((p: any) => p.type === "text" && p.text)
                  .map((p: any) => p.text)
                  .join("\n");
              } else {
                content = JSON.stringify(msgContent);
              }
              if (msgRole === "user") {
                content = stripInboundMetadata(content);
              }
              if (!content || content.length < 10) continue;

              const idx = incIdx();
              totalProcessed++;

              const sessionKey = `openclaw-session-${sessionId}`;
              if (this.store.chunkExistsByContent(sessionKey, msgRole, content)) {
                totalSkipped++;
                send("item", { index: idx, total: totalMsgs, status: "skipped", preview: content.slice(0, 120), source: file, agent: agentId, role: msgRole, reason: "duplicate" });
                continue;
              }

              const existingByHash = this.store.findActiveChunkByHash(content, agentOwner);
              if (existingByHash) {
                totalSkipped++;
                send("item", { index: idx, total: totalMsgs, status: "skipped", preview: content.slice(0, 120), source: file, agent: agentId, role: msgRole, reason: "exact duplicate within agent" });
                continue;
              }

              try {
                const summary = await summarizer.summarize(content);
                let embedding: number[] | null = null;
                try {
                  [embedding] = await this.embedder.embed([summary]);
                } catch (err) {
                  this.log.warn(`Migration embed failed: ${err}`);
                }

                let dedupStatus: "active" | "duplicate" | "merged" = "active";
                let dedupTarget: string | null = null;
                let dedupReason: string | null = null;

                if (embedding) {
                  const importThreshold = this.ctx?.config?.dedup?.similarityThreshold ?? 0.60;
                  const dedupOwnerFilter = [agentOwner];
                  const topSimilar = findTopSimilar(this.store, embedding, importThreshold, 5, this.log, dedupOwnerFilter);
                  if (topSimilar.length > 0) {
                    const candidates = topSimilar.map((s, i) => {
                      const chunk = this.store.getChunk(s.chunkId);
                      return { index: i + 1, summary: chunk?.summary ?? "", chunkId: s.chunkId };
                    }).filter(c => c.summary);

                    if (candidates.length > 0) {
                      const dedupResult = await summarizer.judgeDedup(summary, candidates);
                      if (dedupResult?.action === "DUPLICATE" && dedupResult.targetIndex) {
                        const targetId = candidates[dedupResult.targetIndex - 1]?.chunkId;
                        if (targetId) { dedupStatus = "duplicate"; dedupTarget = targetId; dedupReason = dedupResult.reason; }
                      } else if (dedupResult?.action === "UPDATE" && dedupResult.targetIndex && dedupResult.mergedSummary) {
                        const targetId = candidates[dedupResult.targetIndex - 1]?.chunkId;
                        if (targetId) {
                          this.store.updateChunkSummaryAndContent(targetId, dedupResult.mergedSummary, content);
                          try { const [newEmb] = await this.embedder.embed([dedupResult.mergedSummary]); if (newEmb) this.store.upsertEmbedding(targetId, newEmb); } catch { /* best-effort */ }
                          dedupStatus = "merged"; dedupTarget = targetId; dedupReason = dedupResult.reason;
                        }
                      }
                    }
                  }
                }

                const chunkId = uuid();
                const msgTs = obj.message?.timestamp ?? obj.timestamp;
                const ts = msgTs ? new Date(msgTs).getTime() : Date.now();
                const chunk: Chunk = {
                  id: chunkId, sessionKey, turnId: `import-${agentId}-${sessionId}-${idx}`, seq: 0,
                  role: msgRole as any, content, kind: "paragraph", summary, embedding: null,
                  taskId: null, skillId: null, owner: agentOwner, dedupStatus, dedupTarget, dedupReason,
                  mergeCount: 0, lastHitAt: null, mergeHistory: "[]", createdAt: ts, updatedAt: ts,
                };

                this.store.insertChunk(chunk);
                if (embedding && dedupStatus === "active") this.store.upsertEmbedding(chunkId, embedding);

                totalStored++;
                send("item", { index: idx, total: totalMsgs, status: dedupStatus === "active" ? "stored" : dedupStatus, preview: content.slice(0, 120), summary: summary.slice(0, 80), source: file, agent: agentId, role: msgRole });
              } catch (err) {
                totalErrors++;
                send("item", { index: idx, total: totalMsgs, status: "error", preview: content.slice(0, 120), source: file, agent: agentId, error: String(err).slice(0, 200) });
              }
            }
          } catch (err) {
            send("error", { file, agent: agentId, error: String(err) });
            totalErrors++;
          }
        }
      };

      // Execute agents with concurrency control
      const agentEntries = Array.from(agentGroups.entries());
      if (concurrency <= 1 || agentEntries.length <= 1) {
        for (const [agentId, files] of agentEntries) {
          if (this.migrationAbort) break;
          send("progress", { total: totalMsgs, processed: globalMsgIdx, phase: "sessions", agent: agentId });
          await importAgent(agentId, files);
        }
      } else {
        // Parallel: run up to `concurrency` agents at once
        let cursor = 0;
        const runBatch = async () => {
          while (cursor < agentEntries.length && !this.migrationAbort) {
            const batch: Promise<void>[] = [];
            const batchStart = cursor;
            while (batch.length < concurrency && cursor < agentEntries.length) {
              const [agentId, files] = agentEntries[cursor++];
              send("progress", { total: totalMsgs, processed: globalMsgIdx, phase: "sessions", agent: agentId, parallel: true });
              batch.push(importAgent(agentId, files));
            }
            await Promise.all(batch);
          }
        };
        await runBatch();
      }
    }

    send("progress", { total: totalProcessed, processed: totalProcessed, phase: "done" });
    send("summary", { totalProcessed, totalStored, totalSkipped, totalErrors });
  }

  // ─── Post-processing: independent task/skill generation ───

  private handlePostprocess(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (this.ppRunning) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "postprocess already running" }));
      return;
    }
    if (!this.ctx) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "plugin context not available — please restart the gateway" }));
      return;
    }

    this.readBody(req, (body) => {
      let opts: { enableTasks?: boolean; enableSkills?: boolean; concurrency?: number } = {};
      try { opts = JSON.parse(body); } catch { /* defaults */ }

      const concurrency = Math.max(1, Math.min(opts.concurrency ?? 1, 8));

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });

      this.ppSSEClients.push(res);
      res.on("close", () => { this.ppSSEClients = this.ppSSEClients.filter(c => c !== res); });

      this.ppAbort = false;
      this.ppState = { running: true, done: false, stopped: false, processed: 0, total: 0, tasksCreated: 0, skillsCreated: 0, errors: 0 };

      const send = (event: string, data: unknown) => {
        this.broadcastPPSSE(event, data);
      };

      this.ppRunning = true;
      this.runPostprocess(send, !!opts.enableTasks, !!opts.enableSkills, concurrency).finally(() => {
        this.ppRunning = false;
        this.ppState.running = false;
        this.ppState.done = true;
        if (this.ppAbort) {
          this.ppState.stopped = true;
          this.broadcastPPSSE("stopped", { ...this.ppState });
        } else {
          this.broadcastPPSSE("done", { ...this.ppState });
        }
        for (const c of this.ppSSEClients) { try { c.end(); } catch { /* */ } }
        this.ppSSEClients = [];
        this.ppAbort = false;
      });
    });
  }

  private handlePostprocessStream(res: http.ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    if (this.ppRunning) {
      res.write(`event: state\ndata: ${JSON.stringify(this.ppState)}\n\n`);
      this.ppSSEClients.push(res);
      res.on("close", () => { this.ppSSEClients = this.ppSSEClients.filter(c => c !== res); });
    } else if (this.ppState.done) {
      const evt = this.ppState.stopped ? "stopped" : "done";
      res.write(`event: ${evt}\ndata: ${JSON.stringify(this.ppState)}\n\n`);
      res.end();
    } else {
      res.end();
    }
  }

  private handlePostprocessStop(res: http.ServerResponse): void {
    this.ppAbort = true;
    this.jsonResponse(res, { ok: true });
  }

  private handlePostprocessStatus(res: http.ServerResponse): void {
    this.jsonResponse(res, this.ppState);
  }

  private broadcastPPSSE(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.ppSSEClients) {
      try { c.write(payload); } catch { /* */ }
    }
  }

  private async runPostprocess(
    send: (event: string, data: unknown) => void,
    enableTasks: boolean,
    enableSkills: boolean,
    concurrency: number = 1,
  ): Promise<void> {
    const ctx = this.ctx!;

    const importSessions = this.store.getDistinctSessionKeys()
      .filter((sk: string) => sk.startsWith("openclaw-import-") || sk.startsWith("openclaw-session-"));

    type PendingItem = { sessionKey: string; action: "full" | "skill-only"; owner: string };
    const pendingItems: PendingItem[] = [];
    let skippedCount = 0;

    const ownerMap = this.store.getSessionOwnerMap(importSessions);

    for (const sk of importSessions) {
      const hasTask = this.store.hasTaskForSession(sk);
      const hasSkill = this.store.hasSkillForSessionTask(sk);
      const owner = ownerMap.get(sk) ?? "agent:main";

      if (enableTasks && !hasTask) {
        pendingItems.push({ sessionKey: sk, action: "full", owner });
      } else if (enableSkills && hasTask && !hasSkill) {
        pendingItems.push({ sessionKey: sk, action: "skill-only", owner });
      } else {
        skippedCount++;
      }
    }

    // Group pending items by agent (owner)
    const agentGroups = new Map<string, PendingItem[]>();
    for (const item of pendingItems) {
      const group = agentGroups.get(item.owner) ?? [];
      group.push(item);
      agentGroups.set(item.owner, group);
    }

    this.ppState.total = pendingItems.length;
    send("info", {
      totalSessions: importSessions.length,
      alreadyProcessed: skippedCount,
      pending: pendingItems.length,
      agents: Array.from(agentGroups.keys()),
      concurrency,
    });
    send("progress", { processed: 0, total: pendingItems.length });

    let globalIdx = 0;
    const incIdx = () => ++globalIdx;

    // Process one agent's sessions sequentially
    const processAgent = async (agentOwner: string, items: PendingItem[]) => {
      const taskProcessor = new TaskProcessor(this.store, ctx);
      let skillEvolver: SkillEvolver | null = null;

      if (enableSkills) {
        const recallEngine = new RecallEngine(this.store, this.embedder, ctx);
        skillEvolver = new SkillEvolver(this.store, recallEngine, ctx);
        taskProcessor.onTaskCompleted(async (task) => {
          try {
            await skillEvolver!.onTaskCompleted(task);
            this.ppState.skillsCreated++;
            send("skill", { taskId: task.id, title: task.title, agent: agentOwner });
          } catch (err) {
            this.log.warn(`Postprocess skill evolution error (${agentOwner}): ${err}`);
          }
        });
      }

      for (const { sessionKey, action } of items) {
        if (this.ppAbort) break;
        const idx = incIdx();
        this.ppState.processed = globalIdx;

        send("item", {
          index: idx,
          total: pendingItems.length,
          session: sessionKey,
          agent: agentOwner,
          step: "processing",
          action,
        });

        try {
          if (action === "full") {
            await taskProcessor.onChunksIngested(sessionKey, Date.now());
            const activeTask = this.store.getActiveTask(sessionKey);
            if (activeTask) {
              await taskProcessor.finalizeTask(activeTask);
              const finalized = this.store.getTask(activeTask.id);
              this.ppState.tasksCreated++;
              send("item", {
                index: idx, total: pendingItems.length, session: sessionKey, agent: agentOwner,
                step: "done", taskTitle: finalized?.title || "", taskStatus: finalized?.status || "",
              });
            } else {
              send("item", {
                index: idx, total: pendingItems.length, session: sessionKey, agent: agentOwner,
                step: "done", taskTitle: "(no chunks)",
              });
            }
          } else if (action === "skill-only" && skillEvolver) {
            const completedTasks = this.store.getCompletedTasksForSession(sessionKey);
            let skillGenerated = false;
            for (const task of completedTasks) {
              if (this.ppAbort) break;
              try {
                await skillEvolver.onTaskCompleted(task);
                this.ppState.skillsCreated++;
                skillGenerated = true;
                send("skill", { taskId: task.id, title: task.title, agent: agentOwner });
              } catch (err) {
                this.log.warn(`Skill evolution error (${agentOwner}) task=${task.id}: ${err}`);
              }
            }
            send("item", {
              index: idx, total: pendingItems.length, session: sessionKey, agent: agentOwner,
              step: "done", taskTitle: completedTasks[0]?.title || sessionKey, action: "skill-only", skillGenerated,
            });
          }
        } catch (err) {
          this.ppState.errors++;
          this.log.warn(`Postprocess error (${agentOwner}) ${sessionKey}: ${err}`);
          send("item", {
            index: idx, total: pendingItems.length, session: sessionKey, agent: agentOwner,
            step: "error", error: String(err).slice(0, 200),
          });
        }

        send("progress", { processed: globalIdx, total: pendingItems.length });
      }
    };

    // Execute agents with concurrency control
    const agentEntries = Array.from(agentGroups.entries());
    if (concurrency <= 1 || agentEntries.length <= 1) {
      for (const [agentOwner, items] of agentEntries) {
        if (this.ppAbort) break;
        await processAgent(agentOwner, items);
      }
    } else {
      let cursor = 0;
      while (cursor < agentEntries.length && !this.ppAbort) {
        const batch: Promise<void>[] = [];
        while (batch.length < concurrency && cursor < agentEntries.length) {
          const [agentOwner, items] = agentEntries[cursor++];
          batch.push(processAgent(agentOwner, items));
        }
        await Promise.all(batch);
      }
    }
  }

  private readBody(req: http.IncomingMessage, cb: (body: string) => void): void {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => cb(body));
  }

  private jsonResponse(res: http.ServerResponse, data: unknown): void {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
  }
}
