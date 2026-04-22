import http from "node:http";
import os from "node:os";
import crypto from "node:crypto";
import { execSync, exec, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { SqliteStore } from "../storage/sqlite";
import type { Embedder } from "../embedding";
import { Summarizer, modelHealth } from "../ingest/providers";
import { findTopSimilar } from "../ingest/dedup";
import { stripInboundMetadata } from "../capture";
import { vectorSearch } from "../storage/vector";
import { TaskProcessor } from "../ingest/task-processor";
import { RecallEngine } from "../recall/engine";
import { SkillEvolver } from "../skill/evolver";
import { resolveConfig } from "../config";
import { getHubStatus } from "../client/connector";
import { type ResolvedHubClient, hubGetMemoryDetail, hubListMemories, hubListTasks, hubListSkills, hubRequestJson, hubSearchMemories, hubSearchSkills, hubUpdateUsername, normalizeHubUrl, resolveHubClient } from "../client/hub";
import { buildSkillBundleForHub, fetchHubSkillBundle, restoreSkillBundleFromHub } from "../client/skill-sync";
import type { Logger, Chunk, PluginContext, MemosLocalConfig } from "../types";
import { viewerHTML } from "./html";
import { v4 as uuid } from "uuid";

export interface MigrationStepFailureCounts {
  summarization: number;
  dedup: number;
  embedding: number;
}

export interface MigrationStateSnapshot {
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
  stepFailures: MigrationStepFailureCounts;
  success: boolean;
}

function createInitialStepFailures(): MigrationStepFailureCounts {
  return { summarization: 0, dedup: 0, embedding: 0 };
}

export function computeMigrationSuccess(state: Pick<MigrationStateSnapshot, "errors" | "stepFailures">): boolean {
  const sf = state.stepFailures;
  return state.errors === 0 && sf.summarization === 0 && sf.dedup === 0 && sf.embedding === 0;
}

export function createInitialMigrationState(): MigrationStateSnapshot {
  const stepFailures = createInitialStepFailures();
  return {
    phase: "",
    stored: 0,
    skipped: 0,
    merged: 0,
    errors: 0,
    processed: 0,
    total: 0,
    lastItem: null,
    done: false,
    stopped: false,
    stepFailures,
    success: computeMigrationSuccess({ errors: 0, stepFailures }),
  };
}

export function applyMigrationItemToState(state: MigrationStateSnapshot, d: any): void {
  if (d.status === "stored") state.stored++;
  else if (d.status === "skipped" || d.status === "duplicate") state.skipped++;
  else if (d.status === "merged") state.merged++;
  else if (d.status === "error") state.errors++;

  if (Array.isArray(d.stepFailures)) {
    for (const step of d.stepFailures) {
      if (step === "summarization") state.stepFailures.summarization++;
      else if (step === "dedup") state.stepFailures.dedup++;
      else if (step === "embedding") state.stepFailures.embedding++;
    }
  }

  state.processed = d.index ?? state.processed + 1;
  state.total = d.total ?? state.total;
  state.lastItem = d;
  state.success = computeMigrationSuccess(state);
}

export interface ViewerServerOptions {
  store: SqliteStore;
  embedder: Embedder;
  port: number;
  log: Logger;
  dataDir: string;
  ctx?: PluginContext;
  defaultHubPort?: number;
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
  private readonly cookieName: string;
  private readonly defaultHubPort: number;

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
  private migrationState: MigrationStateSnapshot = createInitialMigrationState();
  private migrationSSEClients: http.ServerResponse[] = [];

  private ppRunning = false;
  private ppAbort = false;
  private ppState: { running: boolean; done: boolean; stopped: boolean; processed: number; total: number; tasksCreated: number; skillsCreated: number; errors: number; skippedSessions: number; totalSessions: number } =
    { running: false, done: false, stopped: false, processed: 0, total: 0, tasksCreated: 0, skillsCreated: 0, errors: 0, skippedSessions: 0, totalSessions: 0 };
  private ppSSEClients: http.ServerResponse[] = [];

  private notifSSEClients: http.ServerResponse[] = [];
  private notifPollTimer?: ReturnType<typeof setInterval>;
  private lastKnownNotifCount = 0;
  private hubHeartbeatTimer?: ReturnType<typeof setInterval>;
  private static readonly HUB_HEARTBEAT_INTERVAL_MS = 45_000;
  private static readonly STALE_TASK_TIMEOUT_MS = 4 * 60 * 60 * 1000;
  private staleFinalizeRunning = false;

  constructor(opts: ViewerServerOptions) {
    this.store = opts.store;
    this.embedder = opts.embedder;
    this.port = opts.port;
    this.log = opts.log;
    this.dataDir = opts.dataDir;
    this.ctx = opts.ctx;
    this.authFile = path.join(opts.dataDir, "viewer-auth.json");
    this.auth = { passwordHash: null, sessions: new Map() };
    this.cookieName = `memos_token_${opts.port}`;
    this.defaultHubPort = opts.defaultHubPort ?? 18800;
    this.resetToken = crypto.randomBytes(16).toString("hex");
    this.loadAuth();
  }

  private getHubPort(): number {
    const configured = this.ctx?.config?.sharing?.hub?.port;
    if (configured && configured !== 18800) return configured;
    return this.defaultHubPort;
  }

  start(): Promise<string> {
    const MAX_PORT_RETRIES = 5;
    return new Promise((resolve, reject) => {
      let retries = 0;
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && retries < MAX_PORT_RETRIES) {
          retries++;
          const nextPort = this.port + retries;
          this.log.warn(`Viewer port ${this.port + retries - 1} in use, trying ${nextPort}`);
          this.server!.listen(nextPort, "0.0.0.0");
        } else if (err.code === "EADDRINUSE") {
          reject(new Error(`Viewer failed to find open port after ${MAX_PORT_RETRIES} retries (tried ${this.port}–${this.port + MAX_PORT_RETRIES})`));
        } else {
          reject(err);
        }
      });
      this.server.listen(this.port, "0.0.0.0", () => {
        const addr = this.server!.address();
        const actualPort = typeof addr === "object" && addr ? addr.port : this.port;
        this.autoCleanupPolluted();
        this.startHubHeartbeat();
        resolve(`http://127.0.0.1:${actualPort}`);
      });
    });
  }

  private autoCleanupPolluted(): void {
    try {
      const polluted = this.store.findPollutedUserChunks();
      let deleted = 0;
      for (const { id } of polluted) {
        if (this.store.deleteChunk(id)) deleted++;
      }
      const fixed = this.store.fixMixedUserChunks();
      if (deleted > 0 || fixed > 0) {
        this.log.info(`Auto-cleanup: removed ${deleted} polluted chunks, fixed ${fixed} mixed user+assistant chunks`);
      }
    } catch (err) {
      this.log.warn(`Auto-cleanup failed: ${err}`);
    }
  }

  stop(): void {
    this.stopHubHeartbeat();
    this.stopNotifPoll();
    for (const c of this.notifSSEClients) { try { c.end(); } catch {} }
    this.notifSSEClients = [];
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
    const re = new RegExp(`${this.cookieName}=([a-f0-9]+)`);
    const match = cookie.match(re);
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
      else if (p === "/api/memories/share-local" && req.method === "POST") this.handleMemoryLocalShare(req, res);
      else if (p === "/api/memories/unshare-local" && req.method === "POST") this.handleMemoryLocalUnshare(req, res);
      else if (p.match(/^\/api\/memory\/[^/]+\/scope$/) && req.method === "PUT") this.handleMemoryScope(req, res, p);
      else if (p.match(/^\/api\/task\/[^/]+\/scope$/) && req.method === "PUT") this.handleTaskScope(req, res, p);
      else if (p.match(/^\/api\/skill\/[^/]+\/scope$/) && req.method === "PUT") this.handleSkillScope(req, res, p);
      else if (p === "/api/stats") this.serveStats(res, url);
      else if (p === "/api/metrics") this.serveMetrics(res, url);
      else if (p === "/api/tool-metrics") this.serveToolMetrics(res, url);
      else if (p === "/api/search") this.serveSearch(req, res, url);
      else if (p === "/api/tasks" && req.method === "GET") this.serveTasks(res, url);
      else if (p === "/api/task-search" && req.method === "GET") this.serveTaskSearch(res, url);
      else if (p.match(/^\/api\/task\/[^/]+\/retry-skill$/) && req.method === "POST") this.handleTaskRetrySkill(req, res, p);
      else if (p.startsWith("/api/task/") && req.method === "DELETE") this.handleTaskDelete(res, p);
      else if (p.startsWith("/api/task/") && req.method === "PUT") this.handleTaskUpdate(req, res, p);
      else if (p.startsWith("/api/task/") && req.method === "GET") this.serveTaskDetail(res, p);
      else if (p === "/api/skills" && req.method === "GET") this.serveSkills(res, url);
      else if (p.match(/^\/api\/skill\/[^/]+\/download$/) && req.method === "GET") this.serveSkillDownload(res, p);
      else if (p.match(/^\/api\/skill\/[^/]+\/files$/) && req.method === "GET") this.serveSkillFiles(res, p);
      else if (p.match(/^\/api\/skill\/[^/]+\/visibility$/) && req.method === "PUT") this.handleSkillVisibility(req, res, p);
      else if (p.match(/^\/api\/skill\/[^/]+\/disable$/) && req.method === "PUT") this.handleSkillDisable(res, p);
      else if (p.match(/^\/api\/skill\/[^/]+\/enable$/) && req.method === "PUT") this.handleSkillEnable(res, p);
      else if (p.startsWith("/api/skill/") && req.method === "DELETE") this.handleSkillDelete(res, p);
      else if (p.startsWith("/api/skill/") && req.method === "PUT") this.handleSkillUpdate(req, res, p);
      else if (p.startsWith("/api/skill/") && req.method === "GET") this.serveSkillDetail(res, p);
      else if (p.startsWith("/api/memory/") && req.method === "GET") this.serveMemoryDetail(res, p);
      else if (p.startsWith("/api/memory/") && req.method === "PUT") this.handleUpdate(req, res, p);
      else if (p.startsWith("/api/memory/") && req.method === "DELETE") this.handleDelete(res, p);
      else if (p === "/api/session" && req.method === "DELETE") this.handleDeleteSession(res, url);
      else if (p === "/api/memories" && req.method === "DELETE") this.handleDeleteAll(res);
      else if (p === "/api/logs" && req.method === "GET") this.serveLogs(res, url);
      else if (p === "/api/log-tools" && req.method === "GET") this.serveLogTools(res);
      else if (p === "/api/sharing/status" && req.method === "GET") this.serveSharingStatus(res);
      else if (p === "/api/sharing/pending-users" && req.method === "GET") this.serveSharingPendingUsers(res);
      else if (p === "/api/sharing/approve-user" && req.method === "POST") this.handleSharingApproveUser(req, res);
      else if (p === "/api/sharing/reject-user" && req.method === "POST") this.handleSharingRejectUser(req, res);
      else if (p === "/api/sharing/remove-user" && req.method === "POST") this.handleSharingRemoveUser(req, res);
      else if (p === "/api/sharing/change-role" && req.method === "POST") this.handleSharingChangeRole(req, res);
      else if (p === "/api/sharing/retry-join" && req.method === "POST") this.handleRetryJoin(req, res);
      else if (p === "/api/sharing/leave" && req.method === "POST") this.handleLeaveTeam(req, res);
      else if (p === "/api/sharing/search/memories" && req.method === "POST") this.handleSharingMemorySearch(req, res);
      else if (p === "/api/sharing/memories/list" && req.method === "GET") this.serveSharingMemoryList(res, url);
      else if (p === "/api/sharing/tasks/list" && req.method === "GET") this.serveSharingTaskList(res, url);
      else if (p === "/api/sharing/skills/list" && req.method === "GET") this.serveSharingSkillList(res, url);
      else if (p === "/api/sharing/memory-detail" && req.method === "POST") this.handleSharingMemoryDetail(req, res);
      else if (p === "/api/sharing/search/skills" && req.method === "GET") this.serveSharingSkillSearch(res, url);
      else if (p === "/api/sharing/tasks/share" && req.method === "POST") this.handleSharingTaskShare(req, res);
      else if (p === "/api/sharing/tasks/unshare" && req.method === "POST") this.handleSharingTaskUnshare(req, res);
      else if (p === "/api/sharing/update-username" && req.method === "POST") this.handleUpdateUsername(req, res);
      else if (p === "/api/sharing/rename-user" && req.method === "POST") this.handleAdminRenameUser(req, res);
      else if (p === "/api/sharing/test-hub" && req.method === "POST") this.handleTestHubConnection(req, res);
      else if (p === "/api/sharing/memories/share" && req.method === "POST") this.handleSharingMemoryShare(req, res);
      else if (p === "/api/sharing/memories/unshare" && req.method === "POST") this.handleSharingMemoryUnshare(req, res);
      else if (p === "/api/sharing/skills/pull" && req.method === "POST") this.handleSharingSkillPull(req, res);
      else if (p === "/api/sharing/skills/share" && req.method === "POST") this.handleSharingSkillShare(req, res);
      else if (p === "/api/sharing/skills/unshare" && req.method === "POST") this.handleSharingSkillUnshare(req, res);
      else if (p === "/api/sharing/users" && req.method === "GET") this.serveSharingUsers(res);
      else if (p === "/api/sharing/notifications" && req.method === "GET") this.serveSharingNotifications(res, url);
      else if (p === "/api/sharing/notifications/read" && req.method === "POST") this.handleSharingNotificationsRead(req, res);
      else if (p === "/api/sharing/notifications/clear" && req.method === "POST") this.handleSharingNotificationsClear(req, res);
      else if (p === "/api/sharing/sync-hub-removal" && req.method === "POST") this.handleSyncHubRemoval(req, res);
      else if (p === "/api/notifications/stream" && req.method === "GET") this.handleNotifSSE(req, res);
      else if (p === "/api/admin/shared-tasks" && req.method === "GET") this.serveAdminSharedTasks(res);
      else if (p.match(/^\/api\/admin\/shared-tasks\/[^/]+\/detail$/) && req.method === "GET") this.serveHubTaskDetail(res, p);
      else if (p.match(/^\/api\/admin\/shared-tasks\/[^/]+$/) && req.method === "DELETE") this.handleAdminDeleteTask(res, p);
      else if (p === "/api/admin/shared-skills" && req.method === "GET") this.serveAdminSharedSkills(res);
      else if (p.match(/^\/api\/admin\/shared-skills\/[^/]+\/detail$/) && req.method === "GET") this.serveHubSkillDetail(res, p);
      else if (p.match(/^\/api\/admin\/shared-skills\/[^/]+$/) && req.method === "DELETE") this.handleAdminDeleteSkill(res, p);
      else if (p === "/api/admin/shared-memories" && req.method === "GET") this.serveAdminSharedMemories(res);
      else if (p.match(/^\/api\/admin\/shared-memories\/[^/]+$/) && req.method === "DELETE") this.handleAdminDeleteMemory(res, p);
      else if (p === "/api/local-ips" && req.method === "GET") this.serveLocalIPs(res);
      else if (p === "/api/config" && req.method === "GET") this.serveConfig(res);
      else if (p === "/api/config" && req.method === "PUT") this.handleSaveConfig(req, res);
      else if (p === "/api/test-model" && req.method === "POST") this.handleTestModel(req, res);
      else if (p === "/api/model-health" && req.method === "GET") this.serveModelHealth(res);
      else if (p === "/api/fallback-model" && req.method === "GET") this.serveFallbackModel(res);
      else if (p === "/api/update-check" && req.method === "GET") this.handleUpdateCheck(res);
      else if (p === "/api/update-install" && req.method === "POST") this.handleUpdateInstall(req, res);
      else if (p === "/api/auth/logout" && req.method === "POST") this.handleLogout(req, res);
      else if (p === "/api/cleanup-polluted" && req.method === "POST") this.handleCleanupPolluted(res);
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
          "Set-Cookie": `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
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
          "Set-Cookie": `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
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
    const re = new RegExp(`${this.cookieName}=([a-f0-9]+)`);
    const match = cookie.match(re);
    if (match) this.auth.sessions.delete(match[1]);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": `${this.cookieName}=; Path=/; HttpOnly; Max-Age=0`,
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
          "Set-Cookie": `${this.cookieName}=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
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
    const dateFrom = url.searchParams.get("dateFrom") ?? undefined;
    const dateTo = url.searchParams.get("dateTo") ?? undefined;
    const owner = url.searchParams.get("owner") ?? undefined;
    const sortBy = url.searchParams.get("sort") === "oldest" ? "ASC" : "DESC";

    const db = (this.store as any).db;
    const conditions: string[] = [];
    const params: any[] = [];
    if (session) { conditions.push("session_key = ?"); params.push(session); }
    if (role) { conditions.push("role = ?"); params.push(role); }
    if (owner && owner.startsWith("agent:")) {
      conditions.push("(owner = ? OR owner = 'public')");
      params.push(owner);
    } else if (owner) {
      conditions.push("owner = ?"); params.push(owner);
    }
    if (dateFrom) { conditions.push("created_at >= ?"); params.push(new Date(dateFrom).getTime()); }
    if (dateTo) { conditions.push("created_at <= ?"); params.push(new Date(dateTo).getTime()); }

    const where = conditions.length > 0 ? " WHERE " + conditions.join(" AND ") : "";
    const totalRow = db.prepare("SELECT COUNT(*) as count FROM chunks" + where).get(...params) as any;
    const rawMemories = db.prepare("SELECT * FROM chunks" + where + ` ORDER BY CASE WHEN dedup_status IN ('duplicate','merged') THEN 1 ELSE 0 END ASC, created_at ${sortBy} LIMIT ? OFFSET ?`).all(...params, limit, offset);
    const findMergeSources = db.prepare("SELECT id, summary, role FROM chunks WHERE dedup_target = ? AND (dedup_status = 'merged' OR dedup_status = 'duplicate')");

    const chunkIds = rawMemories.map((m: any) => m.id);
    const sharingMap = new Map<string, { visibility: string; group_id: string | null }>();
    const localShareMap = new Map<string, { original_owner: string; shared_at: number }>();
    if (chunkIds.length > 0) {
      try {
        const placeholders = chunkIds.map(() => "?").join(",");
        if (this.sharingRole === "hub") {
          const sharedRows = db.prepare(`SELECT source_chunk_id, visibility, group_id FROM hub_memories WHERE source_chunk_id IN (${placeholders})`).all(...chunkIds) as Array<{ source_chunk_id: string; visibility: string; group_id: string | null }>;
          for (const r of sharedRows) sharingMap.set(r.source_chunk_id, r);
        } else {
          const teamMetaRows = db.prepare(`SELECT chunk_id, visibility, group_id FROM team_shared_chunks WHERE chunk_id IN (${placeholders})`).all(...chunkIds) as Array<{ chunk_id: string; visibility: string; group_id: string | null }>;
          for (const r of teamMetaRows) sharingMap.set(r.chunk_id, { visibility: r.visibility, group_id: r.group_id });
        }
        const localRows = db.prepare(`SELECT chunk_id, original_owner, shared_at FROM local_shared_memories WHERE chunk_id IN (${placeholders})`).all(...chunkIds) as Array<{ chunk_id: string; original_owner: string; shared_at: number }>;
        for (const r of localRows) localShareMap.set(r.chunk_id, r);
      } catch {
      }
    }
    const memories = rawMemories.map((m: any) => {
      const out: any = m.role === "user" && m.content ? { ...m, content: stripInboundMetadata(m.content) } : { ...m };
      if (out.merge_count > 0) {
        const sources = findMergeSources.all(m.id) as Array<{ id: string; summary: string; role: string }>;
        out.merge_sources = sources;
      }
      const shared = sharingMap.get(m.id);
      const localShared = localShareMap.get(m.id);
      out.sharingVisibility = shared?.visibility ?? null;
      out.sharingGroupId = shared?.group_id ?? null;
      out.localSharing = out.owner === "public";
      out.localSharingManaged = !!localShared;
      out.localOriginalOwner = localShared?.original_owner ?? null;
      return out;
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
    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");
    if (fromParam) {
      const fromMs = new Date(fromParam).getTime();
      const toMs = toParam ? new Date(toParam).getTime() : Date.now();
      if (isNaN(fromMs) || isNaN(toMs)) {
        this.jsonResponse(res, { error: "Invalid date" }, 400);
        return;
      }
      const diffMin = Math.max(10, Math.min(43200, Math.round((toMs - fromMs) / 60000)));
      const data = this.store.getToolMetrics(diffMin, fromMs, toMs);
      this.jsonResponse(res, data);
      return;
    }
    const minutes = Math.min(43200, Math.max(10, Number(url.searchParams.get("minutes")) || 60));
    const data = this.store.getToolMetrics(minutes);
    this.jsonResponse(res, data);
  }

  private serveTasks(res: http.ServerResponse, url: URL): void {
    this.store.recordViewerEvent("tasks_list");
    const status = url.searchParams.get("status") ?? undefined;
    const owner = url.searchParams.get("owner") ?? undefined;
    const session = url.searchParams.get("session") ?? undefined;
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    const { tasks, total } = this.store.listTasks({ status, limit, offset, owner, session });

    const db = (this.store as any).db;
    const items = tasks.map((t) => {
      const meta = db.prepare("SELECT skill_status, owner FROM tasks WHERE id = ?").get(t.id) as { skill_status: string | null; owner: string | null } | undefined;
      const hubTask = this.getHubTaskForLocal(t.id);
      const share = this.resolveTaskTeamShareForApi(t.id, hubTask);
      return {
        id: t.id,
        sessionKey: t.sessionKey,
        title: t.title,
        summary: t.summary ?? "",
        status: t.status,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        chunkCount: this.store.countChunksByTask(t.id),
        skillStatus: meta?.skill_status ?? null,
        owner: meta?.owner ?? "agent:main",
        sharingVisibility: share.visibility,
      };
    });

    this.backfillTaskEmbeddings(items);
    this.jsonResponse(res, { tasks: items, total, limit, offset });
    this.autoFinalizeStaleTasks();
  }

  private getTaskAutoFinalizeMs(): number {
    const hours = this.ctx?.config?.taskAutoFinalizeHours;
    if (hours !== undefined && hours !== null) return hours * 60 * 60 * 1000;
    try {
      const cfgPath = this.getOpenClawConfigPath();
      if (fs.existsSync(cfgPath)) {
        const raw = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
        const entries = raw?.plugins?.entries ?? {};
        const pluginCfg = entries["memos-local-openclaw-plugin"]?.config
          ?? entries["memos-local"]?.config ?? {};
        if (pluginCfg.taskAutoFinalizeHours !== undefined) return pluginCfg.taskAutoFinalizeHours * 60 * 60 * 1000;
      }
    } catch { /* fall through */ }
    return ViewerServer.STALE_TASK_TIMEOUT_MS;
  }

  private autoFinalizeStaleTasks(): void {
    if (this.staleFinalizeRunning || !this.ctx) return;
    const thresholdMs = this.getTaskAutoFinalizeMs();
    if (thresholdMs <= 0) return;
    const db = (this.store as any).db;
    const now = Date.now();
    let staleTasks: Array<{ id: string }>;
    try {
      staleTasks = db.prepare(`
        SELECT t.id
        FROM tasks t
        LEFT JOIN chunks c ON c.task_id = t.id
        WHERE t.status = 'active'
        GROUP BY t.id
        HAVING (? - COALESCE(MAX(c.created_at), t.started_at)) > ?
      `).all(now, thresholdMs) as Array<{ id: string }>;
    } catch { return; }
    if (staleTasks.length === 0) return;

    this.staleFinalizeRunning = true;
    const hours = Math.round(thresholdMs / 3600000);
    this.log.info(`Auto-finalizing ${staleTasks.length} stale active task(s) (idle > ${hours}h)`);
    const tp = new TaskProcessor(this.store, this.ctx);
    (async () => {
      for (const row of staleTasks) {
        const task = this.store.getTask(row.id);
        if (!task || task.status !== "active") continue;
        try {
          await tp.finalizeTask(task);
          this.log.info(`Auto-finalized stale task=${task.id}`);
        } catch (err) {
          this.log.warn(`Failed to auto-finalize task=${task.id}: ${err}`);
        }
      }
    })().catch((err) => this.log.warn(`autoFinalizeStaleTasks error: ${err}`))
      .finally(() => { this.staleFinalizeRunning = false; });
  }

  private async serveTaskSearch(res: http.ServerResponse, url: URL): Promise<void> {
    const q = (url.searchParams.get("q") ?? "").trim();
    if (!q) { this.jsonResponse(res, { tasks: [], total: 0 }); return; }

    const owner = url.searchParams.get("owner") ?? undefined;
    const maxResults = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));

    const scoreMap = new Map<string, number>();

    if (this.embedder) {
      try {
        const [queryVec] = await this.embedder.embed([q]);
        const allEmb = this.store.getTaskEmbeddings(owner);
        for (const { taskId, vector } of allEmb) {
          let dot = 0, normA = 0, normB = 0;
          for (let i = 0; i < queryVec.length && i < vector.length; i++) {
            dot += queryVec[i] * vector[i];
            normA += queryVec[i] * queryVec[i];
            normB += vector[i] * vector[i];
          }
          const sim = normA > 0 && normB > 0 ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
          if (sim > 0.3) scoreMap.set(taskId, sim);
        }
      } catch { /* embedding unavailable, fall through to FTS */ }
    }

    const ftsResults = this.store.taskFtsSearch(q, maxResults, owner);
    for (const { taskId, score } of ftsResults) {
      const existing = scoreMap.get(taskId) ?? 0;
      scoreMap.set(taskId, Math.max(existing, score * 0.8));
    }

    const sorted = [...scoreMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxResults);

    const db = (this.store as any).db;
    const tasks = sorted.map(([taskId, score]) => {
      const t = this.store.getTask(taskId);
      if (!t) return null;
      const meta = db.prepare("SELECT skill_status, owner FROM tasks WHERE id = ?").get(taskId) as { skill_status: string | null; owner: string | null } | undefined;
      const hubTask = this.getHubTaskForLocal(taskId);
      const ts = this.resolveTaskTeamShareForApi(taskId, hubTask);
      return {
        id: t.id, sessionKey: t.sessionKey, title: t.title,
        summary: t.summary ?? "", status: t.status,
        startedAt: t.startedAt, endedAt: t.endedAt,
        chunkCount: this.store.countChunksByTask(t.id),
        skillStatus: meta?.skill_status ?? null,
        owner: meta?.owner ?? "agent:main",
        sharingVisibility: ts.visibility,
        score,
      };
    }).filter(Boolean);

    this.jsonResponse(res, { tasks, total: tasks.length });
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
      const text = c.role === "user" ? stripInboundMetadata(c.content) : c.content;
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
    const hubTask = this.getHubTaskForLocal(taskId);
    const ts = this.resolveTaskTeamShareForApi(taskId, hubTask);

    this.jsonResponse(res, {
      id: task.id,
      sessionKey: task.sessionKey,
      title: task.title,
      summary: task.summary,
      status: task.status,
      owner: task.owner ?? "agent:main",
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      chunks: chunkItems,
      skillStatus: meta?.skill_status ?? null,
      skillReason: meta?.skill_reason ?? null,
      skillLinks,
      sharingVisibility: ts.visibility,
      sharingGroupId: ts.groupId,
      hubTaskId: ts.hasHubLink,
    });
  }

  private serveStats(res: http.ServerResponse, url?: URL): void {
    const emptyStats = {
      totalMemories: 0, totalSessions: 0, totalEmbeddings: 0, totalSkills: 0, totalTasks: 0,
      embeddingProvider: this.embedder?.provider ?? "none",
      dedupBreakdown: {},
      timeRange: { earliest: null, latest: null },
      sessions: [],
    };

    if (!this.store || !(this.store as any).db) {
      this.jsonResponse(res, emptyStats);
      return;
    }

    const ownerFilter = url?.searchParams.get("owner") ?? "";

    try {
      const db = (this.store as any).db;
      const total = db.prepare("SELECT COUNT(*) as count FROM chunks").get() as any;
      const sessions = db.prepare("SELECT COUNT(DISTINCT session_key) as count FROM chunks").get() as any;
      const timeRange = db.prepare("SELECT MIN(created_at) as earliest, MAX(created_at) as latest FROM chunks WHERE dedup_status = 'active'").get() as any;
      const MIN_VALID_TS = 1704067200000; // 2024-01-01
      if (timeRange.earliest != null && timeRange.earliest < MIN_VALID_TS) {
        timeRange.earliest = db.prepare("SELECT MIN(created_at) as v FROM chunks WHERE dedup_status = 'active' AND created_at >= ?").get(MIN_VALID_TS) as any;
        timeRange.earliest = timeRange.earliest?.v ?? null;
      }
      if (timeRange.latest != null && timeRange.latest < MIN_VALID_TS) {
        timeRange.latest = null;
      }
      let embCount = 0;
      try { embCount = (db.prepare("SELECT COUNT(*) as count FROM embeddings").get() as any).count; } catch { /* table may not exist */ }
      let sessionQuery: string;
      let sessionParams: any[];
      if (ownerFilter && ownerFilter.startsWith("agent:")) {
        sessionQuery = "SELECT session_key, COUNT(*) as count, MIN(created_at) as earliest, MAX(created_at) as latest FROM chunks WHERE (owner = ? OR owner = 'public') GROUP BY session_key ORDER BY latest DESC";
        sessionParams = [ownerFilter];
      } else if (ownerFilter) {
        sessionQuery = "SELECT session_key, COUNT(*) as count, MIN(created_at) as earliest, MAX(created_at) as latest FROM chunks WHERE owner = ? GROUP BY session_key ORDER BY latest DESC";
        sessionParams = [ownerFilter];
      } else {
        sessionQuery = "SELECT session_key, COUNT(*) as count, MIN(created_at) as earliest, MAX(created_at) as latest FROM chunks GROUP BY session_key ORDER BY latest DESC";
        sessionParams = [];
      }
      const sessionList = db.prepare(sessionQuery).all(...sessionParams) as any[];

      let taskSessionList: Array<{ session_key: string; count: number; earliest: number | null; latest: number | null }> = [];
      try {
        taskSessionList = db.prepare(
          "SELECT session_key, COUNT(*) as count, MIN(started_at) as earliest, MAX(COALESCE(updated_at, started_at)) as latest FROM tasks GROUP BY session_key ORDER BY latest DESC",
        ).all() as any[];
      } catch { /* tasks table may not exist yet */ }

      let skillSessionList: Array<{ session_key: string; count: number; earliest: number | null; latest: number | null }> = [];
      try {
        skillSessionList = db.prepare(
          `SELECT t.session_key as session_key, COUNT(DISTINCT ts.skill_id) as count,
                  MIN(t.started_at) as earliest, MAX(COALESCE(t.updated_at, t.started_at)) as latest
             FROM task_skills ts JOIN tasks t ON t.id = ts.task_id
            GROUP BY t.session_key
            ORDER BY latest DESC`,
        ).all() as any[];
      } catch { /* task_skills may not exist yet */ }

      let skillCount = 0;
      try { skillCount = (db.prepare("SELECT COUNT(*) as count FROM skills").get() as any).count; } catch { /* table may not exist yet */ }

      let taskCount = 0;
      try { taskCount = (db.prepare("SELECT COUNT(*) as count FROM tasks").get() as any).count; } catch { /* table may not exist yet */ }

      let dedupBreakdown: Record<string, number> = {};
      try {
        const dedupRows = db.prepare("SELECT dedup_status, COUNT(*) as count FROM chunks GROUP BY dedup_status").all() as any[];
        dedupBreakdown = Object.fromEntries(dedupRows.map((d: any) => [d.dedup_status ?? "active", d.count]));
      } catch { /* column may not exist yet */ }

      let owners: string[] = [];
      try {
        const ownerRows = db.prepare(`
          SELECT DISTINCT owner FROM (
            SELECT owner FROM chunks WHERE owner IS NOT NULL AND owner LIKE 'agent:%'
            UNION
            SELECT owner FROM tasks WHERE owner IS NOT NULL AND owner LIKE 'agent:%'
            UNION
            SELECT owner FROM skills WHERE owner IS NOT NULL AND owner LIKE 'agent:%'
          ) ORDER BY owner
        `).all() as any[];
        owners = ownerRows.map((o: any) => o.owner);
      } catch { /* column may not exist yet */ }

      let currentAgentOwner = "agent:main";
      try {
        const latest = db.prepare("SELECT owner FROM chunks WHERE owner IS NOT NULL AND owner LIKE 'agent:%' ORDER BY created_at DESC LIMIT 1").get() as any;
        if (latest?.owner) currentAgentOwner = latest.owner;
      } catch { /* best-effort */ }

      this.jsonResponse(res, {
        totalMemories: total.count, totalSessions: sessions.count, totalEmbeddings: embCount,
        totalSkills: skillCount, totalTasks: taskCount,
        embeddingProvider: this.embedder.provider,
        dedupBreakdown,
        timeRange: { earliest: timeRange.earliest, latest: timeRange.latest },
        sessions: sessionList,
        taskSessions: taskSessionList,
        skillSessions: skillSessionList,
        owners,
        currentAgentOwner,
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
    const session = url.searchParams.get("session") ?? undefined;
    const owner = url.searchParams.get("owner") ?? undefined;
    const dateFrom = url.searchParams.get("dateFrom") ?? undefined;
    const dateTo = url.searchParams.get("dateTo") ?? undefined;

    const passesFilter = (r: any): boolean => {
      if (role && r.role !== role) return false;
      if (session && r.session_key !== session) return false;
      if (owner && r.owner !== owner) return false;
      if (dateFrom && r.created_at < new Date(dateFrom).getTime()) return false;
      if (dateTo && r.created_at > new Date(dateTo).getTime()) return false;
      return true;
    };

    const ftsFilters: string[] = [];
    const likeFilters: string[] = [];
    const sqlParams: any[] = [];
    if (session) { ftsFilters.push("c.session_key = ?"); likeFilters.push("session_key = ?"); sqlParams.push(session); }
    if (owner) { ftsFilters.push("c.owner = ?"); likeFilters.push("owner = ?"); sqlParams.push(owner); }
    const ftsWhere = ftsFilters.length > 0 ? " AND " + ftsFilters.join(" AND ") : "";
    const likeWhere = likeFilters.length > 0 ? " AND " + likeFilters.join(" AND ") : "";

    const db = (this.store as any).db;
    let ftsResults: any[] = [];
    try {
      ftsResults = db.prepare(
        `SELECT c.* FROM chunks_fts f JOIN chunks c ON f.rowid = c.rowid WHERE chunks_fts MATCH ?${ftsWhere} ORDER BY rank LIMIT 100`,
      ).all(q, ...sqlParams).filter(passesFilter);
    } catch { /* FTS syntax error, fall through */ }
    if (ftsResults.length === 0) {
      try {
        ftsResults = db.prepare(
          `SELECT * FROM chunks WHERE (content LIKE ? OR summary LIKE ?)${likeWhere} ORDER BY created_at DESC LIMIT 100`,
        ).all(`%${q}%`, `%${q}%`, ...sqlParams).filter(passesFilter);
      } catch (err) {
        this.log.warn(`LIKE search failed: ${err}`);
      }
    }

    const SEMANTIC_THRESHOLD = 0.64;
    const VECTOR_TIMEOUT_MS = 8000;
    let vectorResults: any[] = [];
    let scoreMap = new Map<string, number>();
    try {
      const vecPromise = (async () => {
        const queryVec = await this.embedder.embedQuery(q);
        return vectorSearch(this.store, queryVec, 40);
      })();
      const hits = await Promise.race([
        vecPromise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), VECTOR_TIMEOUT_MS)),
      ]);
      if (hits) {
        scoreMap = new Map(hits.map(h => [h.chunkId, h.score]));
        const hitIds = new Set(hits.filter(h => h.score >= SEMANTIC_THRESHOLD).map(h => h.chunkId));
        if (hitIds.size > 0) {
          const placeholders = [...hitIds].map(() => "?").join(",");
          const rows = db.prepare(`SELECT * FROM chunks WHERE id IN (${placeholders})${likeWhere}`).all(...hitIds, ...sqlParams).filter(passesFilter);
          rows.forEach((r: any) => { r._vscore = scoreMap.get(r.id) ?? 0; });
          rows.sort((a: any, b: any) => (b._vscore ?? 0) - (a._vscore ?? 0));
          vectorResults = rows;
        }
      } else {
        this.log.warn("Vector search timed out, returning FTS results only");
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
      if (!seenIds.has(r.id)) { seenIds.add(r.id); merged.push(r); }
    }

    const results = merged.length > 0 ? merged : ftsResults.slice(0, 20);

    this.store.recordViewerEvent("search");
    this.jsonResponse(res, {
      results,
      query: q,
      vectorCount: vectorResults.length,
      ftsCount: ftsResults.length,
      total: results.length,
    });
  }

  // ─── Skills API ───

  private serveSkills(res: http.ServerResponse, url: URL): void {
    const status = url.searchParams.get("status") ?? undefined;
    const visibility = url.searchParams.get("visibility") ?? undefined;
    const session = url.searchParams.get("session") ?? undefined;
    const owner = url.searchParams.get("owner") ?? undefined;
    let skills = this.store.listSkills({ status, session, owner });
    if (visibility) {
      skills = skills.filter(s => s.visibility === visibility);
    }
    const enriched = skills.map(s => {
      const hubSkill = this.getHubSkillForLocal(s.id);
      return { ...s, sharingVisibility: hubSkill?.visibility ?? null };
    });
    this.jsonResponse(res, { skills: enriched });
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

    const hubSkill = this.getHubSkillForLocal(skillId);

    this.jsonResponse(res, {
      skill: { ...skill, sharingVisibility: hubSkill?.visibility ?? null, sharingGroupId: hubSkill?.group_id ?? null },
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
    this.readBody(req, async (body) => {
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

        let hubSynced = false;
        const sharing = this.ctx?.config?.sharing;
        if (sharing?.enabled && this.ctx) {
          try {
            const hubClient = await this.resolveHubClientAware();
            if (visibility === "public") {
              const bundle = buildSkillBundleForHub(this.store, skillId);
              const response = await hubRequestJson(hubClient.hubUrl, hubClient.userToken, "/api/v1/hub/skills/publish", {
                method: "POST",
                body: JSON.stringify({ visibility: "public", groupId: null, metadata: bundle.metadata, bundle: bundle.bundle }),
              }) as any;
              if (this.sharingRole === "hub" && hubClient.userId) {
                const existing = this.store.getHubSkillBySource(hubClient.userId, skillId);
                this.store.upsertHubSkill({
                  id: response?.skillId ?? existing?.id ?? crypto.randomUUID(),
                  sourceSkillId: skillId, sourceUserId: hubClient.userId,
                  name: skill.name, description: skill.description, version: skill.version,
                  groupId: null, visibility: "public",
                  bundle: JSON.stringify(bundle.bundle), qualityScore: skill.qualityScore,
                  createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now(),
                });
              } else {
                const conn = this.store.getClientHubConnection();
                this.store.upsertTeamSharedSkill(skillId, {
                  hubSkillId: String(response?.skillId ?? ""),
                  visibility: "public",
                  groupId: null,
                  hubInstanceId: conn?.hubInstanceId ?? "",
                });
              }
              hubSynced = true;
              this.log.info(`Skill "${skill.name}" published to Hub`);
            } else {
              await hubRequestJson(hubClient.hubUrl, hubClient.userToken, "/api/v1/hub/skills/unpublish", {
                method: "POST",
                body: JSON.stringify({ sourceSkillId: skillId }),
              });
              if (this.sharingRole === "hub" && hubClient.userId) this.store.deleteHubSkillBySource(hubClient.userId, skillId);
              else this.store.deleteTeamSharedSkill(skillId);
              hubSynced = true;
              this.log.info(`Skill "${skill.name}" unpublished from Hub`);
            }
          } catch (hubErr) {
            this.log.warn(`Hub sync failed for skill visibility change: ${hubErr}`);
          }
        }

        this.jsonResponse(res, { ok: true, skillId, visibility, hubSynced });
      } catch (err) {
        const errMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        this.log.error(`handleSkillVisibility error: skillId=${skillId}, body=${body}, err=${errMsg}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: errMsg }));
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

  private embedTaskInBackground(taskId: string, text: string): void {
    if (!this.embedder || !text.trim()) return;
    this.embedder.embed([text]).then((vecs: number[][]) => {
      if (vecs.length > 0) this.store.upsertTaskEmbedding(taskId, vecs[0]);
    }).catch(() => {});
  }

  private backfillTaskEmbeddings(tasks: Array<{ id: string; summary: string; title: string }>): void {
    if (!this.embedder) return;
    const db = (this.store as any).db;
    for (const t of tasks) {
      try {
        const exists = db.prepare("SELECT 1 FROM task_embeddings WHERE task_id = ?").get(t.id);
        if (!exists) {
          const text = `${t.title ?? ""}: ${t.summary ?? ""}`.trim();
          if (text.length > 1) this.embedTaskInBackground(t.id, text);
        }
      } catch { /* best-effort */ }
    }
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
        const newTitle = data.title ?? task.title;
        const newSummary = data.summary ?? task.summary;
        this.store.updateTask(taskId, {
          title: newTitle,
          summary: newSummary,
          status: data.status ?? task.status,
          endedAt: task.endedAt ?? undefined,
        });
        this.embedTaskInBackground(taskId, `${newTitle ?? ""}: ${newSummary ?? ""}`);
        this.jsonResponse(res, { ok: true, taskId });
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  }

  private async handleSkillDelete(res: http.ServerResponse, urlPath: string): Promise<void> {
    const skillId = urlPath.replace("/api/skill/", "");
    const skill = this.store.getSkill(skillId);
    if (!skill) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Skill not found" })); return; }
    try {
      const hub = this.resolveHubConnection();
      if (hub) {
        await hubRequestJson(hub.hubUrl, hub.userToken, "/api/v1/hub/skills/unpublish", {
          method: "POST",
          body: JSON.stringify({ sourceSkillId: skillId }),
        }).catch(() => {});
      }
      const db = (this.store as any).db;
      db.prepare("DELETE FROM hub_skills WHERE source_skill_id = ?").run(skillId);
    } catch (_) {}
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

  private async handleSkillDisable(res: http.ServerResponse, urlPath: string): Promise<void> {
    const skillId = urlPath.split("/")[3];
    const skill = this.store.getSkill(skillId);
    if (!skill) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Skill not found" })); return; }
    if (skill.status === "archived") { this.jsonResponse(res, { ok: true, skillId, message: "already disabled" }); return; }

    try {
      if (skill.visibility === "public") {
        this.store.setSkillVisibility(skillId, "private");
      }
      const hub = this.resolveHubConnection();
      if (hub) {
        await hubRequestJson(hub.hubUrl, hub.userToken, "/api/v1/hub/skills/unpublish", {
          method: "POST",
          body: JSON.stringify({ sourceSkillId: skillId }),
        }).catch(() => {});
      }
    } catch (_) {}

    try {
      const workspaceSkillsDir = path.join(this.dataDir, "workspace", "skills");
      const installedDir = path.join(workspaceSkillsDir, skill.name);
      if (fs.existsSync(installedDir)) {
        fs.rmSync(installedDir, { recursive: true, force: true });
      }
    } catch (_) {}

    this.store.disableSkill(skillId);
    this.jsonResponse(res, { ok: true, skillId });
  }

  private handleSkillEnable(res: http.ServerResponse, urlPath: string): void {
    const skillId = urlPath.split("/")[3];
    const skill = this.store.getSkill(skillId);
    if (!skill) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Skill not found" })); return; }
    if (skill.status !== "archived") { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Only disabled (archived) skills can be enabled" })); return; }

    this.store.enableSkill(skillId);

    if (this.embedder) {
      const sv = this.store.getLatestSkillVersion(skillId);
      if (sv) {
        const text = `${skill.name}: ${skill.description}`;
        this.embedder.embed([text]).then((vecs: number[][]) => {
          if (vecs.length > 0) this.store.upsertSkillEmbedding(skillId, vecs[0]);
        }).catch(() => {});
      }
    }

    this.jsonResponse(res, { ok: true, skillId });
  }

  // ─── CRUD ───

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
    const localShared = this.store.getLocalSharedMemory(chunkId);
    this.jsonResponse(res, {
      memory: {
        ...cleaned,
        localSharing: cleaned.owner === "public",
        localSharingManaged: !!localShared,
        localOriginalOwner: localShared?.originalOwner ?? null,
      },
    });
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
        const ok = this.store.updateChunk(chunkId, { summary: data.summary, content: data.content, role: data.role, owner: data.owner });
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

  private handleMemoryLocalShare(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(req, (body) => {
      try {
        const parsed = JSON.parse(body || "{}");
        const chunkId = String(parsed.chunkId || "");
        if (!chunkId) return this.jsonResponse(res, { ok: false, error: "missing_chunk_id" }, 400);
        const result = this.store.markMemorySharedLocally(chunkId);
        if (!result.ok) {
          return this.jsonResponse(res, { ok: false, error: result.reason ?? "share_failed" }, result.reason === "not_found" ? 404 : 400);
        }
        this.jsonResponse(res, {
          ok: true,
          chunkId,
          owner: result.owner,
          localSharing: true,
          localSharingManaged: true,
          localOriginalOwner: result.originalOwner ?? null,
        });
      } catch (err) {
        this.jsonResponse(res, { ok: false, error: String(err) }, 400);
      }
    });
  }

  private handleMemoryLocalUnshare(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(req, (body) => {
      try {
        const parsed = JSON.parse(body || "{}");
        const chunkId = String(parsed.chunkId || "");
        const privateOwner = typeof parsed.privateOwner === "string" ? parsed.privateOwner : undefined;
        if (!chunkId) return this.jsonResponse(res, { ok: false, error: "missing_chunk_id" }, 400);
        const result = this.store.unmarkMemorySharedLocally(chunkId, privateOwner);
        if (!result.ok) {
          return this.jsonResponse(res, { ok: false, error: result.reason ?? "unshare_failed" }, result.reason === "not_found" ? 404 : 400);
        }
        this.jsonResponse(res, {
          ok: true,
          chunkId,
          owner: result.owner,
          localSharing: false,
          localOriginalOwner: result.originalOwner ?? null,
        });
      } catch (err) {
        this.jsonResponse(res, { ok: false, error: String(err) }, 400);
      }
    });
  }

  // ─── Unified scope API ───

  private handleMemoryScope(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string): void {
    const chunkId = urlPath.split("/")[3];
    this.readBody(req, async (body) => {
      try {
        const parsed = JSON.parse(body || "{}");
        const scope = parsed.scope as string;
        if (!["private", "local", "team"].includes(scope)) {
          return this.jsonResponse(res, { ok: false, error: "scope must be 'private', 'local', or 'team'" }, 400);
        }
        const db = (this.store as any).db;
        const chunk = db.prepare("SELECT * FROM chunks WHERE id = ?").get(chunkId) as any;
        if (!chunk) return this.jsonResponse(res, { ok: false, error: "not_found" }, 404);

        if (chunk.dedup_status && chunk.dedup_status !== "active") {
          return this.jsonResponse(res, { ok: false, error: "inactive_memory", message: "Merged/duplicate memories cannot be shared" }, 400);
        }

        const isLocalShared = chunk.owner === "public";
        const hubMemory = this.getHubMemoryForChunk(chunkId);
        const isTeamShared = !!hubMemory;
        const currentScope = isTeamShared ? "team" : isLocalShared ? "local" : "private";

        if (scope === currentScope) {
          return this.jsonResponse(res, { ok: true, scope, changed: false });
        }

        let hubSynced = false;

        if (scope === "team") {
          if (!isTeamShared) {
            const hubClient = await this.resolveHubClientAware();
            const refreshedChunk = db.prepare("SELECT * FROM chunks WHERE id = ?").get(chunkId) as any;
            const response = await hubRequestJson(hubClient.hubUrl, hubClient.userToken, "/api/v1/hub/memories/share", {
              method: "POST",
              body: JSON.stringify({ memory: { sourceChunkId: refreshedChunk.id, sourceAgent: refreshedChunk.owner || "", role: refreshedChunk.role, content: refreshedChunk.content, summary: refreshedChunk.summary, kind: refreshedChunk.kind, groupId: null, visibility: "public" } }),
            });
            if (!isLocalShared) this.store.markMemorySharedLocally(chunkId);
            const memoryId = String((response as any)?.memoryId ?? "");
            const isHubRole = this.ctx?.config?.sharing?.role === "hub";
            if (hubClient.userId && isHubRole) {
              const existing = this.store.getHubMemoryBySource(hubClient.userId, chunkId);
              this.store.upsertHubMemory({
                id: memoryId || existing?.id || crypto.randomUUID(),
                sourceChunkId: chunkId, sourceUserId: hubClient.userId,
                sourceAgent: refreshedChunk.owner || "",
                role: refreshedChunk.role, content: refreshedChunk.content, summary: refreshedChunk.summary ?? "",
                kind: refreshedChunk.kind, groupId: null, visibility: "public",
                createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now(),
              });
            } else if (hubClient.userId) {
              const conn = this.store.getClientHubConnection();
              this.store.upsertTeamSharedChunk(chunkId, { hubMemoryId: memoryId, visibility: "public", groupId: null, hubInstanceId: conn?.hubInstanceId ?? "" });
            }
            hubSynced = true;
          } else {
            if (!isLocalShared) this.store.markMemorySharedLocally(chunkId);
          }
        } else if (scope === "local") {
          if (isTeamShared) {
            try {
              const hubClient = await this.resolveHubClientAware();
              await hubRequestJson(hubClient.hubUrl, hubClient.userToken, "/api/v1/hub/memories/unshare", {
                method: "POST", body: JSON.stringify({ sourceChunkId: chunkId }),
              });
              if (this.sharingRole === "hub" && hubClient.userId) this.store.deleteHubMemoryBySource(hubClient.userId, chunkId);
              this.store.deleteTeamSharedChunk(chunkId);
              hubSynced = true;
            } catch (err) { this.log.warn(`Failed to unshare memory from team: ${err}`); }
          }
          if (!isLocalShared) this.store.markMemorySharedLocally(chunkId);
        } else {
          if (isTeamShared) {
            try {
              const hubClient = await this.resolveHubClientAware();
              await hubRequestJson(hubClient.hubUrl, hubClient.userToken, "/api/v1/hub/memories/unshare", {
                method: "POST", body: JSON.stringify({ sourceChunkId: chunkId }),
              });
              if (this.sharingRole === "hub" && hubClient.userId) this.store.deleteHubMemoryBySource(hubClient.userId, chunkId);
              this.store.deleteTeamSharedChunk(chunkId);
              hubSynced = true;
            } catch (err) { this.log.warn(`Failed to unshare memory from team: ${err}`); }
          }
          if (isLocalShared) this.store.unmarkMemorySharedLocally(chunkId);
        }

        this.jsonResponse(res, { ok: true, scope, changed: true, hubSynced });
      } catch (err) {
        this.jsonResponse(res, { ok: false, error: String(err) }, 500);
      }
    });
  }

  private handleTaskScope(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string): void {
    const taskId = urlPath.split("/")[3];
    this.readBody(req, async (body) => {
      try {
        const parsed = JSON.parse(body || "{}");
        const scope = parsed.scope as string;
        if (!["private", "local", "team"].includes(scope)) {
          return this.jsonResponse(res, { ok: false, error: "scope must be 'private', 'local', or 'team'" }, 400);
        }
        const task = this.store.getTask(taskId);
        if (!task) return this.jsonResponse(res, { ok: false, error: "task_not_found" }, 404);

        if (scope !== "private" && task.status !== "completed") {
          return this.jsonResponse(res, { ok: false, error: "only_completed_tasks_can_be_shared" }, 400);
        }

        const isLocalShared = task.owner === "public";
        const hubTask = this.getHubTaskForLocal(taskId);
        const taskShareUi = this.resolveTaskTeamShareForApi(taskId, hubTask);
        const isTeamShared = taskShareUi.hasHubLink;
        const currentScope = isTeamShared ? "team" : isLocalShared ? "local" : "private";

        if (scope === currentScope) {
          return this.jsonResponse(res, { ok: true, scope, changed: false });
        }

        let hubSynced = false;

        if (scope === "team") {
          if (!isTeamShared) {
            const chunks = this.store.getChunksByTask(taskId);
            const hubClient = await this.resolveHubClientAware();
            const refreshedTask = this.store.getTask(taskId)!;
            const response = await hubRequestJson(hubClient.hubUrl, hubClient.userToken, "/api/v1/hub/tasks/share", {
              method: "POST",
              body: JSON.stringify({
                task: { id: refreshedTask.id, sourceTaskId: refreshedTask.id, title: refreshedTask.title, summary: refreshedTask.summary, groupId: null, visibility: "public", createdAt: refreshedTask.startedAt ?? Date.now(), updatedAt: refreshedTask.updatedAt ?? Date.now() },
                chunks: chunks.map((c) => ({ id: c.id, hubTaskId: refreshedTask.id, sourceTaskId: refreshedTask.id, sourceChunkId: c.id, role: c.role, content: c.content, summary: c.summary, kind: c.kind, groupId: null, visibility: "public", createdAt: c.createdAt ?? Date.now() })),
              }),
            });
            const hubTaskId = String((response as any)?.taskId ?? "");
            if (this.sharingRole === "hub" && hubClient.userId) {
              const existing = this.store.getHubTaskBySource(hubClient.userId, taskId);
              this.store.upsertHubTask({
                id: hubTaskId || existing?.id || crypto.randomUUID(),
                sourceTaskId: taskId, sourceUserId: hubClient.userId, title: refreshedTask.title ?? "",
                summary: refreshedTask.summary ?? "", groupId: null, visibility: "public",
                createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now(),
              });
            }
            const conn = this.store.getClientHubConnection();
            this.store.markTaskShared(taskId, hubTaskId, chunks.length, "public", null, conn?.hubInstanceId ?? "");
            hubSynced = true;
          }
          if (!isLocalShared) {
            const originalOwner = task.owner;
            const db = (this.store as any).db;
            db.prepare("INSERT INTO local_shared_tasks (task_id, hub_task_id, original_owner, hub_instance_id, shared_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET original_owner = excluded.original_owner, hub_instance_id = excluded.hub_instance_id, shared_at = excluded.shared_at").run(taskId, "", originalOwner, "", Date.now());
            db.prepare("UPDATE tasks SET owner = 'public' WHERE id = ?").run(taskId);
          }
        }

        if (scope === "local") {
          if (!isLocalShared) {
            const originalOwner = task.owner;
            const db = (this.store as any).db;
            db.prepare("INSERT INTO local_shared_tasks (task_id, hub_task_id, original_owner, shared_at) VALUES (?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET original_owner = excluded.original_owner, shared_at = excluded.shared_at").run(taskId, "", originalOwner, Date.now());
            db.prepare("UPDATE tasks SET owner = 'public' WHERE id = ?").run(taskId);
          }
        }

        if (scope === "local" && isTeamShared) {
          try {
            const hubClient = await this.resolveHubClientAware();
            await hubRequestJson(hubClient.hubUrl, hubClient.userToken, "/api/v1/hub/tasks/unshare", {
              method: "POST", body: JSON.stringify({ sourceTaskId: taskId }),
            });
            if (this.sharingRole === "hub" && hubClient.userId) this.store.deleteHubTaskBySource(hubClient.userId, taskId);
            else this.store.downgradeTeamSharedTaskToLocal(taskId);
            this.store.clearTeamSharedChunksForTask(taskId);
            hubSynced = true;
          } catch (err) { this.log.warn(`Failed to unshare task from team: ${err}`); }
        }

        if (scope === "private") {
          if (isTeamShared) {
            try {
              const hubClient = await this.resolveHubClientAware();
              await hubRequestJson(hubClient.hubUrl, hubClient.userToken, "/api/v1/hub/tasks/unshare", {
                method: "POST", body: JSON.stringify({ sourceTaskId: taskId }),
              });
              if (this.sharingRole === "hub" && hubClient.userId) this.store.deleteHubTaskBySource(hubClient.userId, taskId);
              else if (!isLocalShared) this.store.unmarkTaskShared(taskId);
              else this.store.downgradeTeamSharedTaskToLocal(taskId);
              this.store.clearTeamSharedChunksForTask(taskId);
              hubSynced = true;
            } catch (err) { this.log.warn(`Failed to unshare task from team: ${err}`); }
          }
          if (isLocalShared) {
            const db = (this.store as any).db;
            const shared = db.prepare("SELECT original_owner FROM local_shared_tasks WHERE task_id = ?").get(taskId) as any;
            const restoreOwner = shared?.original_owner ?? task.owner;
            if (restoreOwner && restoreOwner !== "public") {
              db.prepare("UPDATE tasks SET owner = ? WHERE id = ?").run(restoreOwner, taskId);
            }
            db.prepare("DELETE FROM local_shared_tasks WHERE task_id = ?").run(taskId);
          }
        }

        this.jsonResponse(res, { ok: true, scope, changed: true, hubSynced });
      } catch (err) {
        this.jsonResponse(res, { ok: false, error: String(err) }, 500);
      }
    });
  }

  private handleSkillScope(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string): void {
    const skillId = urlPath.split("/")[3];
    this.readBody(req, async (body) => {
      try {
        const parsed = JSON.parse(body || "{}");
        const scope = parsed.scope as string;
        if (!["private", "local", "team"].includes(scope)) {
          return this.jsonResponse(res, { ok: false, error: "scope must be 'private', 'local', or 'team'" }, 400);
        }
        const skill = this.store.getSkill(skillId);
        if (!skill) return this.jsonResponse(res, { ok: false, error: "skill_not_found" }, 404);

        if (scope !== "private" && skill.status !== "active") {
          return this.jsonResponse(res, { ok: false, error: "only_active_skills_can_be_shared" }, 400);
        }

        const isLocalShared = skill.visibility === "public";
        const hubSkill = this.getHubSkillForLocal(skillId);
        const isTeamShared = !!hubSkill;
        const currentScope = isTeamShared ? "team" : isLocalShared ? "local" : "private";

        if (scope === currentScope) {
          return this.jsonResponse(res, { ok: true, scope, changed: false });
        }

        let hubSynced = false;

        if (scope === "team") {
          if (!isTeamShared) {
            const bundle = buildSkillBundleForHub(this.store, skillId);
            const hubClient = await this.resolveHubClientAware();
            const response = await hubRequestJson(hubClient.hubUrl, hubClient.userToken, "/api/v1/hub/skills/publish", {
              method: "POST",
              body: JSON.stringify({ visibility: "public", groupId: null, metadata: bundle.metadata, bundle: bundle.bundle }),
            });
            const hubSkillId = String((response as any)?.skillId ?? "");
            if (this.sharingRole === "hub" && hubClient.userId) {
              const existing = this.store.getHubSkillBySource(hubClient.userId, skillId);
              this.store.upsertHubSkill({
                id: hubSkillId || existing?.id || crypto.randomUUID(),
                sourceSkillId: skillId, sourceUserId: hubClient.userId,
                name: skill.name, description: skill.description, version: skill.version,
                groupId: null, visibility: "public",
                bundle: JSON.stringify(bundle.bundle), qualityScore: skill.qualityScore,
                createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now(),
              });
            } else {
              const conn = this.store.getClientHubConnection();
              this.store.upsertTeamSharedSkill(skillId, { hubSkillId, visibility: "public", groupId: null, hubInstanceId: conn?.hubInstanceId ?? "" });
            }
            hubSynced = true;
          }
          if (!isLocalShared) this.store.setSkillVisibility(skillId, "public");
        }

        if (scope === "local") {
          if (!isLocalShared) this.store.setSkillVisibility(skillId, "public");
        }

        if (scope === "local" && isTeamShared) {
          try {
            const hubClient = await this.resolveHubClientAware();
            await hubRequestJson(hubClient.hubUrl, hubClient.userToken, "/api/v1/hub/skills/unpublish", {
              method: "POST", body: JSON.stringify({ sourceSkillId: skillId }),
            });
            if (this.sharingRole === "hub" && hubClient.userId) this.store.deleteHubSkillBySource(hubClient.userId, skillId);
            else this.store.deleteTeamSharedSkill(skillId);
            hubSynced = true;
          } catch (err) { this.log.warn(`Failed to unpublish skill from team: ${err}`); }
        }

        if (scope === "private") {
          if (isTeamShared) {
            try {
              const hubClient = await this.resolveHubClientAware();
              await hubRequestJson(hubClient.hubUrl, hubClient.userToken, "/api/v1/hub/skills/unpublish", {
                method: "POST", body: JSON.stringify({ sourceSkillId: skillId }),
              });
              if (this.sharingRole === "hub" && hubClient.userId) this.store.deleteHubSkillBySource(hubClient.userId, skillId);
              else this.store.deleteTeamSharedSkill(skillId);
              hubSynced = true;
            } catch (err) { this.log.warn(`Failed to unpublish skill from team: ${err}`); }
          }
          if (isLocalShared) this.store.setSkillVisibility(skillId, "private");
        }

        this.jsonResponse(res, { ok: true, scope, changed: true, hubSynced });
      } catch (err) {
        this.jsonResponse(res, { ok: false, error: String(err) }, 500);
      }
    });
  }

  private get sharingRole(): string | undefined {
    return this.ctx?.config?.sharing?.role;
  }

  private isCurrentClientHubInstance(hubInstanceId?: string): boolean {
    if (this.sharingRole !== "client") return true;
    const scopedHubInstanceId = String(hubInstanceId ?? "");
    if (!scopedHubInstanceId) return true;
    const currentHubInstanceId = this.store.getClientHubConnection()?.hubInstanceId ?? "";
    if (!currentHubInstanceId) return true;
    return scopedHubInstanceId === currentHubInstanceId;
  }

  /**
   * Task list/detail/search: derive team-share badge when getHubTaskForLocal misses (e.g. client
   * hub_instance_id drift, or empty hub_task_id from hub while synced_chunks was recorded).
   */
  private resolveTaskTeamShareForApi(taskId: string, hubTask: any): { visibility: string | null; hasHubLink: boolean; groupId: string | null } {
    if (hubTask) {
      return {
        visibility: hubTask.visibility ?? null,
        hasHubLink: true,
        groupId: hubTask.group_id ?? null,
      };
    }
    const lst = this.store.getLocalSharedTask(taskId);
    if (lst) {
      const hid = String(lst.hubTaskId ?? "").trim();
      const teamLinked = hid.length > 0 || (lst.syncedChunks ?? 0) > 0;
      if (teamLinked) return { visibility: lst.visibility || null, hasHubLink: true, groupId: lst.groupId ?? null };
    }
    try {
      const db = (this.store as any).db;
      const chunkTeam = db.prepare(`
        SELECT t.visibility AS v, t.group_id AS g FROM team_shared_chunks t
        INNER JOIN chunks c ON c.id = t.chunk_id
        WHERE c.task_id = ?
        LIMIT 1
      `).get(taskId) as { v: string; g: string | null } | undefined;
      if (chunkTeam) {
        return { visibility: chunkTeam.v || null, hasHubLink: true, groupId: chunkTeam.g ?? null };
      }
    } catch { /* schema / db edge */ }
    return { visibility: null, hasHubLink: false, groupId: null };
  }

  private getHubMemoryForChunk(chunkId: string): any {
    if (this.sharingRole === "hub") {
      const db = (this.store as any).db;
      return db.prepare("SELECT * FROM hub_memories WHERE source_chunk_id = ? LIMIT 1").get(chunkId);
    }
    const ts = this.store.getTeamSharedChunk(chunkId);
    if (ts && this.isCurrentClientHubInstance(ts.hubInstanceId)) {
      return { source_chunk_id: chunkId, visibility: ts.visibility, group_id: ts.groupId };
    }
    return undefined;
  }

  private getHubTaskForLocal(taskId: string): any {
    if (this.sharingRole === "hub") {
      const db = (this.store as any).db;
      return db.prepare("SELECT * FROM hub_tasks WHERE source_task_id = ? LIMIT 1").get(taskId);
    }
    const shared = this.store.getLocalSharedTask(taskId);
    if (shared && shared.hubTaskId && this.isCurrentClientHubInstance(shared.hubInstanceId)) {
      return { source_task_id: taskId, visibility: shared.visibility, group_id: shared.groupId };
    }
    return undefined;
  }

  private getHubSkillForLocal(skillId: string): any {
    if (this.sharingRole === "hub") {
      const db = (this.store as any).db;
      return db.prepare("SELECT * FROM hub_skills WHERE source_skill_id = ? LIMIT 1").get(skillId);
    }
    const ts = this.store.getTeamSharedSkill(skillId);
    if (ts && this.isCurrentClientHubInstance(ts.hubInstanceId)) {
      return { source_skill_id: skillId, visibility: ts.visibility, group_id: ts.groupId };
    }
    return undefined;
  }

  private handleDeleteSession(res: http.ServerResponse, url: URL): void {
    const key = url.searchParams.get("key");
    if (!key) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Missing key" })); return; }
    const count = this.store.deleteSession(key);
    this.jsonResponse(res, { ok: true, deleted: count });
  }

  private handleDeleteAll(res: http.ServerResponse): void {
    try {
      const result = this.store.deleteAll();
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`handleDeleteAll error: ${msg}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: msg }));
    }
  }

  // ─── Helpers ───

  // ─── Config API ───

  private getOpenClawConfigPath(): string {
    if (process.env.OPENCLAW_CONFIG_PATH) return process.env.OPENCLAW_CONFIG_PATH;
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const ocHome = process.env.OPENCLAW_STATE_DIR || path.join(home, ".openclaw");
    return path.join(ocHome, "openclaw.json");
  }

  private getPluginEntryConfig(raw: any): Record<string, unknown> {
    const entries = raw?.plugins?.entries ?? {};
    return entries["memos-local-openclaw-plugin"]?.config
      ?? entries["memos-lite-openclaw-plugin"]?.config
      ?? entries["memos-lite"]?.config
      ?? {};
  }

  private getResolvedViewerConfig(raw?: any): MemosLocalConfig {
    const pluginCfg = this.getPluginEntryConfig(raw);
    const stateDir = this.ctx?.stateDir ?? this.getOpenClawHome();
    return resolveConfig(pluginCfg as Partial<MemosLocalConfig>, stateDir);
  }

  private hasUsableEmbeddingProvider(cfg: MemosLocalConfig): boolean {
    const embedding = cfg.embedding;
    if (!embedding?.provider) return false;
    if (embedding.provider === "openclaw") {
      return !!(this.ctx?.openclawAPI) && embedding.capabilities?.hostEmbedding === true;
    }
    return true;
  }

  private hasUsableSummarizerProvider(cfg: MemosLocalConfig): boolean {
    const summarizer = cfg.summarizer;
    if (!summarizer?.provider) return false;
    if (summarizer.provider === "openclaw") {
      return !!(this.ctx?.openclawAPI) && summarizer.capabilities?.hostCompletion === true;
    }
    return true;
  }

  private async serveSharingStatus(res: http.ServerResponse): Promise<void> {
    const sharing = this.ctx?.config?.sharing;
    const persisted = this.store.getClientHubConnection();
    const resolvedHubUrl = sharing?.client?.hubAddress ? normalizeHubUrl(sharing.client.hubAddress) : persisted?.hubUrl ?? null;
    const hasClientConfig = Boolean(
      (sharing?.client?.hubAddress && sharing?.client?.userToken) ||
      (persisted?.hubUrl && persisted?.userToken),
    );
    const base = {
      enabled: Boolean(sharing?.enabled),
      role: sharing?.role ?? null,
      clientConfigured: hasClientConfig,
      hubUrl: resolvedHubUrl,
      connection: { connected: false, user: null as any, hubUrl: undefined as string | undefined, teamName: null as string | null, apiVersion: null as string | null },
      admin: { canManageUsers: false, rejectSupported: false },
    };

    if (!this.ctx || !sharing?.enabled) {
      this.jsonResponse(res, base);
      return;
    }

    // Hub 模式下，本机就是管理者，直接赋予 admin 权限
    if (sharing.role === "hub") {
      base.admin.canManageUsers = true;
      base.admin.rejectSupported = true;
      base.connection.connected = true;
      base.connection.hubUrl = resolvedHubUrl ?? undefined;

      let adminUser: any = { username: "hub-admin", role: "admin" };
      try {
        const hub = this.resolveHubConnection();
        if (hub) {
          const me = await hubRequestJson(hub.hubUrl, hub.userToken, "/api/v1/hub/me", { method: "GET" }) as any;
          if (me) {
            adminUser = {
              id: me.id,
              username: me.username ?? "hub-admin",
              role: me.role ?? "admin",
            };
          }
        }
      } catch { /* fallback to default */ }
      base.connection.user = adminUser;

      // Fetch team info from own hub
      try {
        const selfUrl = resolvedHubUrl || `http://localhost:${sharing.hub?.port ?? 21816}`;
        const info = await fetch(`${selfUrl}/api/v1/hub/info`).then(r => r.ok ? r.json() : null).catch(() => null) as any;
        base.connection.teamName = info?.teamName ?? sharing.hub?.teamName ?? null;
        base.connection.apiVersion = info?.apiVersion ?? null;
      } catch { /* ignore */ }

      const hubStats: any = { totalMembers: 0, onlineMembers: 0, pendingMembers: 0 };
      try {
        const activeUsers = this.store.listHubUsers("active");
        const pendingUsers = this.store.listHubUsers("pending");
        const now = Date.now();
        const OFFLINE_THRESHOLD = 120_000;
        hubStats.totalMembers = activeUsers.length;
        hubStats.onlineMembers = activeUsers.filter(u =>
          u.lastActiveAt && (now - u.lastActiveAt < OFFLINE_THRESHOLD),
        ).length;
        hubStats.pendingMembers = pendingUsers.length;
      } catch { /* best-effort */ }
      this.jsonResponse(res, { ...base, hubStats });
      return;
    }

    const hasPendingConnection = Boolean(persisted?.hubUrl && persisted?.userId && !persisted?.userToken);
    if (!hasClientConfig && !hasPendingConnection) {
      this.jsonResponse(res, base);
      return;
    }

    try {
      const status = await getHubStatus(this.store, this.ctx.config);
      const output = { ...base, connection: { ...base.connection, ...status } } as any;
      if (status.user?.status === "pending") {
        output.connection.pendingApproval = true;
      }
      if (status.user?.status === "rejected") {
        output.connection.rejected = true;
      }
      if (status.user?.status === "removed") {
        output.connection.removed = true;
      }
      if (status.connected && status.hubUrl) {
        try {
          const info = await fetch(`${status.hubUrl}/api/v1/hub/info`).then((r) => (r.ok ? r.json() : null)).catch(() => null) as any;
          output.connection.teamName = info?.teamName ?? null;
          output.connection.apiVersion = info?.apiVersion ?? null;
        } catch {}
      } else if (status.hubUrl) {
        try {
          const info = await fetch(`${status.hubUrl}/api/v1/hub/info`).then((r) => (r.ok ? r.json() : null)).catch(() => null) as any;
          output.connection.teamName = info?.teamName ?? null;
        } catch {}
      }
      output.admin.canManageUsers = status.connected && status.user?.role === "admin";
      output.admin.rejectSupported = output.admin.canManageUsers;
      this.jsonResponse(res, output);
    } catch (err) {
      this.jsonResponse(res, { ...base, error: String(err) });
    }
  }

  private async serveSharingPendingUsers(res: http.ServerResponse): Promise<void> {
    if (!this.ctx) return this.jsonResponse(res, { users: [], error: "sharing_unavailable" });
    try {
      const hub = this.resolveHubConnection();
      if (!hub) return this.jsonResponse(res, { users: [], error: "not_configured" });
      const data = await hubRequestJson(hub.hubUrl, hub.userToken, "/api/v1/hub/admin/pending-users", { method: "GET" }) as any;
      this.jsonResponse(res, { users: Array.isArray(data?.users) ? data.users : [] });
    } catch (err) {
      this.jsonResponse(res, { users: [], error: String(err) });
    }
  }

  private handleSharingApproveUser(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(req, async (body) => {
      if (!this.ctx) return this.jsonResponse(res, { ok: false, error: "sharing_unavailable" });
      try {
        const parsed = JSON.parse(body || "{}");
        const hub = this.resolveHubConnection();
        if (!hub) return this.jsonResponse(res, { ok: false, error: "not_configured" });
        const result = await hubRequestJson(hub.hubUrl, hub.userToken, "/api/v1/hub/admin/approve-user", {
          method: "POST",
          body: JSON.stringify({ userId: parsed.userId, username: parsed.username }),
        });
        this.jsonResponse(res, { ok: true, result });
      } catch (err) {
        this.jsonResponse(res, { ok: false, error: String(err) });
      }
    });
  }

  private handleSharingRejectUser(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(req, async (body) => {
      if (!this.ctx) return this.jsonResponse(res, { ok: false, error: "sharing_unavailable" });
      try {
        const parsed = JSON.parse(body || "{}");
        const hub = this.resolveHubConnection();
        if (!hub) return this.jsonResponse(res, { ok: false, error: "not_configured" });
        const result = await hubRequestJson(hub.hubUrl, hub.userToken, "/api/v1/hub/admin/reject-user", {
          method: "POST",
          body: JSON.stringify({ userId: parsed.userId }),
        });
        this.jsonResponse(res, { ok: true, result });
      } catch (err) {
        this.jsonResponse(res, { ok: false, error: String(err) });
      }
    });
  }

  private handleSharingChangeRole(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(req, async (body) => {
      if (!this.ctx) return this.jsonResponse(res, { ok: false, error: "sharing_unavailable" });
      try {
        const parsed = JSON.parse(body || "{}");
        const hub = this.resolveHubConnection();
        if (!hub) return this.jsonResponse(res, { ok: false, error: "not_configured" });
        const result = await hubRequestJson(hub.hubUrl, hub.userToken, "/api/v1/hub/admin/change-role", {
          method: "POST",
          body: JSON.stringify({ userId: parsed.userId, role: parsed.role }),
        });
        this.jsonResponse(res, { ok: true, result });
      } catch (err) {
        this.jsonResponse(res, { ok: false, error: String(err) });
      }
    });
  }

  private handleSharingRemoveUser(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(req, async (body) => {
      if (!this.ctx) return this.jsonResponse(res, { ok: false, error: "sharing_unavailable" });
      try {
        const parsed = JSON.parse(body || "{}");
        const hub = this.resolveHubConnection();
        if (!hub) return this.jsonResponse(res, { ok: false, error: "not_configured" });
        const result = await hubRequestJson(hub.hubUrl, hub.userToken, "/api/v1/hub/admin/remove-user", {
          method: "POST",
          body: JSON.stringify({ userId: parsed.userId, cleanResources: parsed.cleanResources === true }),
        });
        this.jsonResponse(res, { ok: true, result });
      } catch (err) {
        this.jsonResponse(res, { ok: false, error: String(err) });
      }
    });
  }

  private handleAdminRenameUser(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(req, async (body) => {
      if (!this.ctx) return this.jsonResponse(res, { ok: false, error: "sharing_unavailable" });
      try {
        const parsed = JSON.parse(body || "{}");
        const hub = this.resolveHubConnection();
        if (!hub) return this.jsonResponse(res, { ok: false, error: "not_configured" });
        const result = await hubRequestJson(hub.hubUrl, hub.userToken, "/api/v1/hub/admin/rename-user", {
          method: "POST",
          body: JSON.stringify({ userId: parsed.userId, username: parsed.username }),
        });
        this.jsonResponse(res, { ok: true, result });
      } catch (err) {
        const errStr = String(err);
        if (errStr.includes("username_taken")) {
          this.jsonResponse(res, { ok: false, error: "username_taken" });
        } else if (errStr.includes("invalid_params")) {
          this.jsonResponse(res, { ok: false, error: "invalid_params" });
        } else {
          this.jsonResponse(res, { ok: false, error: errStr });
        }
      }
    });
  }

  private handleRetryJoin(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(req, async (_body) => {
      if (!this.ctx) return this.jsonResponse(res, { ok: false, error: "sharing_unavailable", errorCode: "sharing_unavailable" });
      const sharing = this.ctx.config.sharing;
      if (!sharing?.enabled || sharing.role !== "client") {
        return this.jsonResponse(res, { ok: false, error: "not_in_client_mode", errorCode: "not_in_client_mode" });
      }
      const hubAddress = sharing.client?.hubAddress ?? "";
      const teamToken = sharing.client?.teamToken ?? "";
      if (!hubAddress || !teamToken) {
        return this.jsonResponse(res, { ok: false, error: "missing_hub_address_or_team_token", errorCode: "missing_config" });
      }
      const hubUrl = normalizeHubUrl(hubAddress);

      try {
        await hubRequestJson(hubUrl, "", "/api/v1/hub/info", { method: "GET" });
      } catch {
        return this.jsonResponse(res, { ok: false, error: "hub_unreachable", errorCode: "hub_unreachable" });
      }

      try {
        const os = await import("os");
        const nickname = sharing.client?.nickname;
        const username = nickname || os.userInfo().username || "user";
        const hostname = os.hostname() || "unknown";
        const persisted = this.store.getClientHubConnection();
        const existingIdentityKey = persisted?.identityKey || "";
        const result = await hubRequestJson(hubUrl, "", "/api/v1/hub/join", {
          method: "POST",
          body: JSON.stringify({ teamToken, username, deviceName: hostname, reapply: true, identityKey: existingIdentityKey }),
        }) as any;
        const returnedIdentityKey = String(result.identityKey || existingIdentityKey || "");
        let hubInstanceId = persisted?.hubInstanceId || "";
        try {
          const info = await hubRequestJson(hubUrl, "", "/api/v1/hub/info", { method: "GET" }) as any;
          hubInstanceId = String(info?.hubInstanceId ?? hubInstanceId);
        } catch { /* best-effort */ }
        this.store.setClientHubConnection({
          hubUrl,
          userId: String(result.userId || ""),
          username,
          userToken: result.userToken || "",
          role: "member",
          connectedAt: Date.now(),
          identityKey: returnedIdentityKey,
          lastKnownStatus: result.status || "",
          hubInstanceId,
        });
        if (result.status === "blocked") {
          return this.jsonResponse(res, { ok: false, error: "blocked", errorCode: "blocked" });
        }
        this.jsonResponse(res, { ok: true, status: result.status || "pending" });
      } catch (err) {
        const errStr = String(err);
        if (errStr.includes("(409)") || errStr.includes("username_taken")) {
          return this.jsonResponse(res, { ok: false, error: "username_taken", errorCode: "username_taken" });
        }
        if (errStr.includes("(403)") || errStr.includes("invalid_team_token")) {
          return this.jsonResponse(res, { ok: false, error: "invalid_team_token", errorCode: "invalid_team_token" });
        }
        this.jsonResponse(res, { ok: false, error: errStr, errorCode: "unknown" });
      }
    });
  }

  private async serveSharingMemoryList(res: http.ServerResponse, url: URL): Promise<void> {
    if (!this.ctx) return this.jsonResponse(res, { memories: [], error: "sharing_unavailable" });
    try {
      const limit = Number(url.searchParams.get("limit") || 40);
      const hub = this.resolveHubConnection();
      let data: any;
      if (hub) {
        data = await hubRequestJson(hub.hubUrl, hub.userToken, `/api/v1/hub/memories?limit=${limit}`);
      } else {
        data = await hubListMemories(this.store, this.ctx, { limit });
      }
      this.jsonResponse(res, { memories: Array.isArray(data?.memories) ? data.memories : [] });
    } catch (err) {
      this.jsonResponse(res, { memories: [], error: String(err) });
    }
  }

  private async serveSharingTaskList(res: http.ServerResponse, url: URL): Promise<void> {
    if (!this.ctx) return this.jsonResponse(res, { tasks: [], error: "sharing_unavailable" });
    try {
      const limit = Number(url.searchParams.get("limit") || 40);
      const hub = this.resolveHubConnection();
      let data: any;
      if (hub) {
        data = await hubRequestJson(hub.hubUrl, hub.userToken, `/api/v1/hub/tasks?limit=${limit}`);
      } else {
        data = await hubListTasks(this.store, this.ctx, { limit });
      }
      this.jsonResponse(res, { tasks: Array.isArray(data?.tasks) ? data.tasks : [] });
    } catch (err) {
      this.jsonResponse(res, { tasks: [], error: String(err) });
    }
  }

  private async serveSharingSkillList(res: http.ServerResponse, url: URL): Promise<void> {
    if (!this.ctx) return this.jsonResponse(res, { skills: [], error: "sharing_unavailable" });
    try {
      const limit = Number(url.searchParams.get("limit") || 40);
      const hub = this.resolveHubConnection();
      let data: any;
      if (hub) {
        data = await hubRequestJson(hub.hubUrl, hub.userToken, `/api/v1/hub/skills/list?limit=${limit}`);
      } else {
        data = await hubListSkills(this.store, this.ctx, { limit });
      }
      this.jsonResponse(res, { skills: Array.isArray(data?.skills) ? data.skills : [] });
    } catch (err) {
      this.jsonResponse(res, { skills: [], error: String(err) });
    }
  }

  private handleSharingMemorySearch(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(req, async (body) => {
      if (!this.ctx) return this.jsonResponse(res, { local: { hits: [], meta: {} }, hub: { hits: [], meta: { totalCandidates: 0, searchedGroups: [], includedPublic: false } }, error: "sharing_unavailable" });
      const emptyHub = { hits: [], meta: { totalCandidates: 0, searchedGroups: [], includedPublic: false } };
      try {
        const parsed = JSON.parse(body || "{}");
        const query = String(parsed.query || "");
        const role = typeof parsed.role === "string" ? parsed.role : undefined;
        const maxResults = typeof parsed.maxResults === "number" ? parsed.maxResults : 10;
        const scope = parsed.scope === "group" || parsed.scope === "all" || parsed.scope === "hub" ? (parsed.scope === "hub" ? "all" : parsed.scope) : "local";
        const local = this.searchLocalViewerMemories(query, { role, maxResults });
        if (scope === "local") {
          return this.jsonResponse(res, { local: { hits: local.hits, meta: local.meta }, hub: emptyHub });
        }
        try {
          const conn = this.resolveHubConnection();
          let hub: any;
          if (conn) {
            hub = await hubRequestJson(conn.hubUrl, conn.userToken, "/api/v1/hub/search", {
              method: "POST", body: JSON.stringify({ query, maxResults, scope }),
            });
          } else {
            hub = await hubSearchMemories(this.store, this.ctx!, { query, maxResults, scope });
          }
          this.jsonResponse(res, { local: { hits: local.hits, meta: local.meta }, hub });
        } catch (err) {
          this.jsonResponse(res, { local: { hits: local.hits, meta: local.meta }, hub: emptyHub, error: String(err) });
        }
      } catch (err) {
        this.jsonResponse(res, { local: { hits: [], meta: {} }, hub: emptyHub, error: String(err) });
      }
    });
  }

  private handleSharingMemoryDetail(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(req, async (body) => {
      if (!this.ctx) return this.jsonResponse(res, { error: "sharing_unavailable" });
      try {
        const parsed = JSON.parse(body || "{}");
        const detail = await hubGetMemoryDetail(this.store, this.ctx, { remoteHitId: String(parsed.remoteHitId || "") });
        this.jsonResponse(res, detail);
      } catch (err) {
        this.jsonResponse(res, { error: String(err) });
      }
    });
  }

  private async serveSharingSkillSearch(res: http.ServerResponse, url: URL): Promise<void> {
    if (!this.ctx) return this.jsonResponse(res, { local: { hits: [] }, hub: { hits: [] }, error: "sharing_unavailable" });
    try {
      const query = String(url.searchParams.get("query") || "");
      const scope = url.searchParams.get("scope") === "group" || url.searchParams.get("scope") === "all" ? url.searchParams.get("scope")! : "local";
      const recall = new RecallEngine(this.store, this.embedder, this.ctx);
      const localHits = await recall.searchSkills(query, "mix" as any, "agent:main");
      if (scope === "local") {
        return this.jsonResponse(res, { local: { hits: localHits }, hub: { hits: [] } });
      }
      try {
        const hub = await hubSearchSkills(this.store, this.ctx, { query, maxResults: Number(url.searchParams.get("maxResults") || 20) });
        this.jsonResponse(res, { local: { hits: localHits }, hub });
      } catch (err) {
        this.jsonResponse(res, { local: { hits: localHits }, hub: { hits: [] }, error: String(err) });
      }
    } catch (err) {
      this.jsonResponse(res, { local: { hits: [] }, hub: { hits: [] }, error: String(err) });
    }
  }

  private searchLocalViewerMemories(query: string, options?: { role?: string; maxResults?: number }): { hits: any[]; meta: Record<string, unknown> } {
    const db = (this.store as any).db;
    const role = options?.role;
    const maxResults = options?.maxResults ?? 10;
    const params: any[] = [];
    let rows: any[] = [];
    try {
      let sql = "SELECT c.* FROM chunks_fts f JOIN chunks c ON f.rowid = c.rowid WHERE chunks_fts MATCH ?";
      params.push(query);
      if (role) {
        sql += " AND c.role = ?";
        params.push(role);
      }
      sql += " ORDER BY rank LIMIT ?";
      params.push(maxResults);
      rows = db.prepare(sql).all(...params);
    } catch {
      const likeParams: any[] = [`%${query}%`, `%${query}%`];
      let sql = "SELECT * FROM chunks WHERE (content LIKE ? OR summary LIKE ?)";
      if (role) {
        sql += " AND role = ?";
        likeParams.push(role);
      }
      sql += " ORDER BY created_at DESC LIMIT ?";
      likeParams.push(maxResults);
      rows = db.prepare(sql).all(...likeParams);
    }
    const hits = rows.map((row: any, idx: number) => ({
      id: row.id,
      summary: row.summary || row.content?.slice(0, 120) || "",
      excerpt: row.content || "",
      score: Math.max(0.3, 1 - idx * 0.1),
      role: row.role,
      ref: { sessionKey: row.session_key, chunkId: row.id, turnId: row.turn_id, seq: row.seq },
      taskId: row.task_id ?? null,
      skillId: row.skill_id ?? null,
      owner: row.owner || "",
    }));
    return { hits, meta: { total: hits.length, usedMaxResults: maxResults } };
  }

  private handleSharingTaskShare(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(req, async (body) => {
      if (!this.ctx) return this.jsonResponse(res, { ok: false, error: "sharing_unavailable" });
      try {
        const parsed = JSON.parse(body || "{}");
        const taskId = String(parsed.taskId || "");
        const visibility = "public";
        const groupId: string | undefined = undefined;
        const task = this.store.getTask(taskId);
        if (!task) return this.jsonResponse(res, { ok: false, error: "task_not_found" });
        const chunks = this.store.getChunksByTask(taskId);
        if (chunks.length === 0) return this.jsonResponse(res, { ok: false, error: "no_chunks" });
        const hubClient = await this.resolveHubClientAware();
        const response = await hubRequestJson(hubClient.hubUrl, hubClient.userToken, "/api/v1/hub/tasks/share", {
          method: "POST",
          body: JSON.stringify({
            task: {
              id: task.id,
              sourceTaskId: task.id,
              title: task.title,
              summary: task.summary,
              groupId: null,
              visibility,
              createdAt: task.startedAt ?? Date.now(),
              updatedAt: task.updatedAt ?? Date.now(),
            },
            chunks: chunks.map((chunk) => ({
              id: chunk.id,
              hubTaskId: task.id,
              sourceTaskId: task.id,
              sourceChunkId: chunk.id,
              role: chunk.role,
              content: chunk.content,
              summary: chunk.summary,
              kind: chunk.kind,
              createdAt: chunk.createdAt,
            })),
          }),
        });
        const hubUserId = hubClient.userId;
        const hubTaskId = String((response as any)?.taskId ?? task.id);
        if (this.sharingRole === "hub" && hubUserId) {
          this.store.upsertHubTask({
            id: hubTaskId,
            sourceTaskId: task.id,
            sourceUserId: hubUserId,
            title: task.title,
            summary: task.summary,
            groupId: null,
            visibility,
            createdAt: task.startedAt ?? Date.now(),
            updatedAt: task.updatedAt ?? Date.now(),
          });
        } else {
          const conn = this.store.getClientHubConnection();
          this.store.markTaskShared(task.id, hubTaskId, chunks.length, visibility, groupId, conn?.hubInstanceId ?? "");
        }
        this.jsonResponse(res, { ok: true, taskId, visibility, response });
      } catch (err) {
        this.jsonResponse(res, { ok: false, error: String(err) });
      }
    });
  }

  private handleSharingTaskUnshare(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(req, async (body) => {
      if (!this.ctx) return this.jsonResponse(res, { ok: false, error: "sharing_unavailable" });
      try {
        const parsed = JSON.parse(body || "{}");
        const taskId = String(parsed.taskId || "");
        const task = this.store.getTask(taskId);
        if (!task) return this.jsonResponse(res, { ok: false, error: "task_not_found" });
        const hubClient = await this.resolveHubClientAware();
        await hubRequestJson(hubClient.hubUrl, hubClient.userToken, "/api/v1/hub/tasks/unshare", {
          method: "POST",
          body: JSON.stringify({ sourceTaskId: task.id }),
        });
        const hubUserId = hubClient.userId;
        if (this.sharingRole === "hub" && hubUserId) this.store.deleteHubTaskBySource(hubUserId, task.id);
        else if (task.owner === "public") this.store.downgradeTeamSharedTaskToLocal(task.id);
        else this.store.unmarkTaskShared(task.id);
        this.jsonResponse(res, { ok: true, taskId });
      } catch (err) {
        this.jsonResponse(res, { ok: false, error: String(err) });
      }
    });
  }

  private handleSharingMemoryShare(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(req, async (body) => {
      if (!this.ctx) return this.jsonResponse(res, { ok: false, error: "sharing_unavailable" });
      try {
        const parsed = JSON.parse(body || "{}");
        const chunkId = String(parsed.chunkId || "");
        const visibility = "public";
        const groupId: string | undefined = undefined;
        const db = (this.store as any).db;
        const chunk = db.prepare("SELECT * FROM chunks WHERE id = ?").get(chunkId) as any;
        if (!chunk) return this.jsonResponse(res, { ok: false, error: "memory_not_found" });
        const hubClient = await this.resolveHubClientAware();
        const response = await hubRequestJson(hubClient.hubUrl, hubClient.userToken, "/api/v1/hub/memories/share", {
          method: "POST",
          body: JSON.stringify({
            memory: {
              sourceChunkId: chunk.id,
              sourceAgent: chunk.owner || "",
              role: chunk.role,
              content: chunk.content,
              summary: chunk.summary,
              kind: chunk.kind,
              groupId: null,
              visibility,
            },
          }),
        });
        const mid = String((response as any)?.memoryId ?? "");
        if (hubClient.userId && this.ctx?.config?.sharing?.role === "hub") {
          const now = Date.now();
          const existing = this.store.getHubMemoryBySource(hubClient.userId, chunk.id);
          this.store.upsertHubMemory({
            id: mid || existing?.id || crypto.randomUUID(),
            sourceChunkId: chunk.id,
            sourceUserId: hubClient.userId,
            sourceAgent: chunk.owner || "",
            role: chunk.role,
            content: chunk.content,
            summary: chunk.summary ?? "",
            kind: chunk.kind,
            groupId: null,
            visibility,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          });
        } else if (hubClient.userId) {
          const conn = this.store.getClientHubConnection();
          this.store.upsertTeamSharedChunk(chunk.id, { hubMemoryId: mid, visibility, groupId, hubInstanceId: conn?.hubInstanceId ?? "" });
        }
        this.jsonResponse(res, { ok: true, chunkId, visibility, response });
      } catch (err) {
        this.jsonResponse(res, { ok: false, error: String(err) });
      }
    });
  }

  private handleSharingMemoryUnshare(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(req, async (body) => {
      if (!this.ctx) return this.jsonResponse(res, { ok: false, error: "sharing_unavailable" });
      try {
        const parsed = JSON.parse(body || "{}");
        const chunkId = String(parsed.chunkId || "");
        const hubClient = await this.resolveHubClientAware();
        await hubRequestJson(hubClient.hubUrl, hubClient.userToken, "/api/v1/hub/memories/unshare", {
          method: "POST",
          body: JSON.stringify({ sourceChunkId: chunkId }),
        });
        const hubUserId = hubClient.userId;
        if (this.sharingRole === "hub" && hubUserId) this.store.deleteHubMemoryBySource(hubUserId, chunkId);
        else this.store.deleteTeamSharedChunk(chunkId);
        this.jsonResponse(res, { ok: true, chunkId });
      } catch (err) {
        this.jsonResponse(res, { ok: false, error: String(err) });
      }
    });
  }

  private handleSharingSkillPull(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(req, async (body) => {
      if (!this.ctx) return this.jsonResponse(res, { ok: false, error: "sharing_unavailable" });
      try {
        const parsed = JSON.parse(body || "{}");
        const skillId = String(parsed.skillId || "");
        const payload = await fetchHubSkillBundle(this.store, this.ctx, { skillId });
        const restored = restoreSkillBundleFromHub(this.store, this.ctx, payload);
        this.jsonResponse(res, { ok: true, pulled: true, hubSkillId: skillId, ...restored });
      } catch (err) {
        this.jsonResponse(res, { ok: false, error: String(err) });
      }
    });
  }

  private handleSharingSkillShare(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(req, async (body) => {
      if (!this.ctx) return this.jsonResponse(res, { ok: false, error: "sharing_unavailable" });
      try {
        const parsed = JSON.parse(body || "{}");
        const skillId = String(parsed.skillId || "");
        const visibility = "public";
        const groupId: string | null = null;
        const skill = this.store.getSkill(skillId);
        if (!skill) return this.jsonResponse(res, { ok: false, error: "skill_not_found" });
        const bundle = buildSkillBundleForHub(this.store, skillId);
        const hubClient = await this.resolveHubClientAware();
        const response = await hubRequestJson(hubClient.hubUrl, hubClient.userToken, "/api/v1/hub/skills/publish", {
          method: "POST",
          body: JSON.stringify({
            visibility,
            groupId: null,
            metadata: bundle.metadata,
            bundle: bundle.bundle,
          }),
        });
        const hubUserId = hubClient.userId;
        if (this.sharingRole === "hub" && hubUserId) {
          const existing = this.store.getHubSkillBySource(hubUserId, skillId);
          this.store.upsertHubSkill({
            id: (response as any)?.skillId ?? existing?.id ?? crypto.randomUUID(),
            sourceSkillId: skillId,
            sourceUserId: hubUserId,
            name: skill.name,
            description: skill.description,
            version: skill.version,
            groupId: null,
            visibility,
            bundle: JSON.stringify(bundle.bundle),
            qualityScore: skill.qualityScore,
            createdAt: existing?.createdAt ?? Date.now(),
            updatedAt: Date.now(),
          });
        } else {
          const conn = this.store.getClientHubConnection();
          this.store.upsertTeamSharedSkill(skillId, {
            hubSkillId: String((response as any)?.skillId ?? ""),
            visibility,
            groupId,
            hubInstanceId: conn?.hubInstanceId ?? "",
          });
        }
        this.jsonResponse(res, { ok: true, skillId, visibility, response });
      } catch (err) {
        this.jsonResponse(res, { ok: false, error: String(err) });
      }
    });
  }

  private handleSharingSkillUnshare(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(req, async (body) => {
      if (!this.ctx) return this.jsonResponse(res, { ok: false, error: "sharing_unavailable" });
      try {
        const parsed = JSON.parse(body || "{}");
        const skillId = String(parsed.skillId || "");
        const skill = this.store.getSkill(skillId);
        if (!skill) return this.jsonResponse(res, { ok: false, error: "skill_not_found" });
        const hubClient = await this.resolveHubClientAware();
        await hubRequestJson(hubClient.hubUrl, hubClient.userToken, "/api/v1/hub/skills/unpublish", {
          method: "POST",
          body: JSON.stringify({ sourceSkillId: skill.id }),
        });
        const hubUserId = hubClient.userId;
        if (this.sharingRole === "hub" && hubUserId) this.store.deleteHubSkillBySource(hubUserId, skill.id);
        else this.store.deleteTeamSharedSkill(skill.id);
        this.jsonResponse(res, { ok: true, skillId });
      } catch (err) {
        this.jsonResponse(res, { ok: false, error: String(err) });
      }
    });
  }

  private resolveHubConnection(): { hubUrl: string; userToken: string } | null {
    if (!this.ctx) return null;

    // Hub 模式：连接自己，用 bootstrap admin token
    const sharing = this.ctx.config.sharing;
    if (sharing?.role === "hub") {
      const hubPort = this.getHubPort();
      const hubUrl = `http://127.0.0.1:${hubPort}`;
      try {
        const authPath = path.join(this.dataDir, "hub-auth.json");
        const authData = JSON.parse(fs.readFileSync(authPath, "utf8"));
        const adminToken = authData?.bootstrapAdminToken;
        if (adminToken) return { hubUrl, userToken: adminToken };
      } catch {
        // hub-auth.json 不存在或读取失败，fall through
      }
    }

    // Client 模式：用配置的 hubAddress + userToken
    const conn = this.store.getClientHubConnection();
    const hubUrl = conn?.hubUrl || this.ctx.config.sharing?.client?.hubAddress || "";
    const userToken = conn?.userToken || this.ctx.config.sharing?.client?.userToken || "";
    if (!hubUrl || !userToken) return null;
    return { hubUrl: normalizeHubUrl(hubUrl), userToken };
  }

  /** resolveHubClient 的 viewer 版本：hub 模式下使用 bootstrap admin 身份 */
  private async resolveHubClientAware(): Promise<ResolvedHubClient> {
    if (!this.ctx) throw new Error("sharing_unavailable");
    const sharing = this.ctx.config.sharing;
    if (sharing?.role === "hub") {
      const hub = this.resolveHubConnection();
      if (hub) {
        const me = await hubRequestJson(hub.hubUrl, hub.userToken, "/api/v1/hub/me", { method: "GET" }) as any;
        return {
          hubUrl: hub.hubUrl,
          userToken: hub.userToken,
          userId: String(me.id),
          username: String(me.username ?? "hub-admin"),
          role: String(me.role ?? "admin"),
        };
      }
    }
    return resolveHubClient(this.store, this.ctx);
  }

  private async serveSharingUsers(res: http.ServerResponse): Promise<void> {
    const hub = this.resolveHubConnection();
    if (!hub) return this.jsonResponse(res, { users: [], error: "not_configured" });
    try {
      const data = await hubRequestJson(hub.hubUrl, hub.userToken, "/api/v1/hub/admin/users", { method: "GET" }) as any;
      this.jsonResponse(res, { users: Array.isArray(data?.users) ? data.users : [] });
    } catch (err) {
      this.jsonResponse(res, { users: [], error: String(err) });
    }
  }

  // ─── Admin management endpoints (Hub-side data) ───

  private async serveAdminSharedTasks(res: http.ServerResponse): Promise<void> {
    const hub = this.resolveHubConnection();
    if (!hub) return this.jsonResponse(res, { tasks: [], error: "not_configured" });
    try {
      const data = await hubRequestJson(hub.hubUrl, hub.userToken, "/api/v1/hub/admin/shared-tasks", { method: "GET" }) as any;
      const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
      for (const tk of tasks) {
        if (!tk.summary && tk.sourceTaskId) {
          const local = this.store.getTask(tk.sourceTaskId);
          if (local) { tk.summary = local.summary; tk.title = tk.title || local.title; }
        }
      }
      this.jsonResponse(res, { tasks });
    } catch (err) {
      this.jsonResponse(res, { tasks: [], error: String(err) });
    }
  }

  private async handleAdminDeleteTask(res: http.ServerResponse, p: string): Promise<void> {
    const hub = this.resolveHubConnection();
    if (!hub) return this.jsonResponse(res, { ok: false, error: "not_configured" });
    const taskId = decodeURIComponent(p.replace("/api/admin/shared-tasks/", ""));
    try {
      await hubRequestJson(hub.hubUrl, hub.userToken, `/api/v1/hub/admin/shared-tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
      this.jsonResponse(res, { ok: true });
    } catch (err) {
      this.jsonResponse(res, { ok: false, error: String(err) });
    }
  }

  private async serveHubTaskDetail(res: http.ServerResponse, p: string): Promise<void> {
    const hub = this.resolveHubConnection();
    if (!hub) return this.jsonResponse(res, { error: "not_configured" }, 500);
    const m = p.match(/^\/api\/admin\/shared-tasks\/([^/]+)\/detail$/);
    if (!m) return this.jsonResponse(res, { error: "bad_request" }, 400);
    const taskId = decodeURIComponent(m[1]);
    try {
      const data = await hubRequestJson(hub.hubUrl, hub.userToken, `/api/v1/hub/shared-tasks/${encodeURIComponent(taskId)}/detail`, { method: "GET" }) as any;
      this.jsonResponse(res, data);
    } catch (err) {
      this.jsonResponse(res, { error: String(err) }, 500);
    }
  }

  private async serveHubSkillDetail(res: http.ServerResponse, p: string): Promise<void> {
    const hub = this.resolveHubConnection();
    if (!hub) return this.jsonResponse(res, { error: "not_configured" }, 500);
    const m = p.match(/^\/api\/admin\/shared-skills\/([^/]+)\/detail$/);
    if (!m) return this.jsonResponse(res, { error: "bad_request" }, 400);
    const skillId = decodeURIComponent(m[1]);
    try {
      const data = await hubRequestJson(hub.hubUrl, hub.userToken, `/api/v1/hub/shared-skills/${encodeURIComponent(skillId)}/detail`, { method: "GET" }) as any;
      this.jsonResponse(res, data);
    } catch (err) {
      this.jsonResponse(res, { error: String(err) }, 500);
    }
  }

  private async serveAdminSharedSkills(res: http.ServerResponse): Promise<void> {
    const hub = this.resolveHubConnection();
    if (!hub) return this.jsonResponse(res, { skills: [], error: "not_configured" });
    try {
      const data = await hubRequestJson(hub.hubUrl, hub.userToken, "/api/v1/hub/admin/shared-skills", { method: "GET" }) as any;
      const skills = Array.isArray(data?.skills) ? data.skills : [];
      for (const sk of skills) {
        if (!sk.description && sk.sourceSkillId) {
          const local = this.store.getSkill(sk.sourceSkillId);
          if (local) { sk.description = sk.description || local.description; sk.name = sk.name || local.name; }
        }
      }
      this.jsonResponse(res, { skills });
    } catch (err) {
      this.jsonResponse(res, { skills: [], error: String(err) });
    }
  }

  private async handleAdminDeleteSkill(res: http.ServerResponse, p: string): Promise<void> {
    const hub = this.resolveHubConnection();
    if (!hub) return this.jsonResponse(res, { ok: false, error: "not_configured" });
    const skillId = decodeURIComponent(p.replace("/api/admin/shared-skills/", ""));
    try {
      await hubRequestJson(hub.hubUrl, hub.userToken, `/api/v1/hub/admin/shared-skills/${encodeURIComponent(skillId)}`, { method: "DELETE" });
      this.jsonResponse(res, { ok: true });
    } catch (err) {
      this.jsonResponse(res, { ok: false, error: String(err) });
    }
  }

  private async serveAdminSharedMemories(res: http.ServerResponse): Promise<void> {
    const hub = this.resolveHubConnection();
    if (!hub) return this.jsonResponse(res, { memories: [], error: "not_configured" });
    try {
      const data = await hubRequestJson(hub.hubUrl, hub.userToken, "/api/v1/hub/admin/shared-memories", { method: "GET" }) as any;
      const memories = Array.isArray(data?.memories) ? data.memories : [];
      for (const m of memories) {
        if (!m.content && m.sourceChunkId) {
          const local = this.store.getChunk(m.sourceChunkId);
          if (local) { m.content = local.content; if (!m.summary && local.summary) m.summary = local.summary; }
        }
      }
      this.jsonResponse(res, { memories });
    } catch (err) {
      this.jsonResponse(res, { memories: [], error: String(err) });
    }
  }

  private async handleAdminDeleteMemory(res: http.ServerResponse, p: string): Promise<void> {
    const hub = this.resolveHubConnection();
    if (!hub) return this.jsonResponse(res, { ok: false, error: "not_configured" });
    const memoryId = decodeURIComponent(p.replace("/api/admin/shared-memories/", ""));
    try {
      await hubRequestJson(hub.hubUrl, hub.userToken, `/api/v1/hub/admin/shared-memories/${encodeURIComponent(memoryId)}`, { method: "DELETE" });
      this.jsonResponse(res, { ok: true });
    } catch (err) {
      this.jsonResponse(res, { ok: false, error: String(err) });
    }
  }

  private async serveSharingNotifications(res: http.ServerResponse, url: URL): Promise<void> {
    const hub = this.resolveHubConnection();
    if (!hub) return this.jsonResponse(res, { notifications: [], unreadCount: 0 });
    try {
      const unread = url.searchParams.get("unread") === "1" ? "?unread=1" : "";
      const data = await hubRequestJson(hub.hubUrl, hub.userToken, `/api/v1/hub/notifications${unread}`) as any;
      this.jsonResponse(res, data);
    } catch {
      this.jsonResponse(res, { notifications: [], unreadCount: 0 });
    }
  }

  private handleSharingNotificationsRead(req: http.IncomingMessage, res: http.ServerResponse): void {
    const hub = this.resolveHubConnection();
    if (!hub) return this.jsonResponse(res, { ok: false, error: "not_configured" });
    this.readBody(req, async (raw) => {
      try {
        const body = JSON.parse(raw || "{}");
        await hubRequestJson(hub.hubUrl, hub.userToken, "/api/v1/hub/notifications/read", { method: "POST", body: JSON.stringify(body) });
        this.jsonResponse(res, { ok: true });
        try {
          const data = (await hubRequestJson(hub.hubUrl, hub.userToken, "/api/v1/hub/notifications?unread=1")) as any;
          const count = data?.unreadCount ?? 0;
          this.lastKnownNotifCount = count;
          this.broadcastNotifSSE({ type: "update", unreadCount: count });
        } catch { /* best effort */ }
      } catch (err) {
        this.jsonResponse(res, { ok: false, error: String(err) });
      }
    });
  }

  private handleSharingNotificationsClear(req: http.IncomingMessage, res: http.ServerResponse): void {
    const hub = this.resolveHubConnection();
    if (!hub) return this.jsonResponse(res, { ok: false, error: "not_configured" });
    this.readBody(req, async () => {
      try {
        await hubRequestJson(hub.hubUrl, hub.userToken, "/api/v1/hub/notifications/clear", { method: "POST", body: "{}" });
        this.jsonResponse(res, { ok: true });
        this.broadcastNotifSSE({ type: "cleared", unreadCount: 0 });
      } catch (err) {
        this.jsonResponse(res, { ok: false, error: String(err) });
      }
    });
  }

  /** Badge-only: clear Client team-share UI metadata when Hub admin removes that memory. Does NOT touch chunks, embeddings, or hub_memories (recall paths). */
  private handleSyncHubRemoval(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(req, (body) => {
      try {
        const parsed = JSON.parse(body || "{}");
        const sourceChunkId = String(parsed.sourceChunkId || "");
        const memoryIdFromNotif = parsed.memoryId != null && parsed.memoryId !== "" ? String(parsed.memoryId) : "";
        if (!sourceChunkId) return this.jsonResponse(res, { ok: false, error: "missing_source_chunk_id" }, 400);
        // Admin removal notifications stay in the feed; if the user re-shared, team_shared_chunks has a new hub_memory_id.
        // Only clear the badge when this notification refers to the same Hub row we still track (or no id — legacy).
        if (memoryIdFromNotif) {
          const current = this.store.getTeamSharedChunk(sourceChunkId);
          const curId = current?.hubMemoryId ? String(current.hubMemoryId) : "";
          if (curId && curId !== memoryIdFromNotif) {
            return this.jsonResponse(res, { ok: true, sourceChunkId, skipped: true, reason: "stale_notification_re_shared" });
          }
        }
        this.store.deleteTeamSharedChunk(sourceChunkId);
        this.jsonResponse(res, { ok: true, sourceChunkId });
      } catch (e) {
        this.jsonResponse(res, { ok: false, error: String(e) }, 500);
      }
    });
  }

  private handleNotifSSE(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write("data: {\"type\":\"connected\"}\n\n");
    this.notifSSEClients.push(res);
    if (!this.notifPollTimer) this.startNotifPoll();
    else this.notifPollImmediate();
    req.on("close", () => {
      this.notifSSEClients = this.notifSSEClients.filter((c) => c !== res);
      if (this.notifSSEClients.length === 0) this.stopNotifPoll();
    });
  }

  private broadcastNotifSSE(data: Record<string, unknown>): void {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    this.notifSSEClients = this.notifSSEClients.filter((c) => {
      try { c.write(msg); return true; } catch { return false; }
    });
  }

  private startNotifPoll(): void {
    this.stopNotifPoll();
    const tick = async () => {
      const hub = this.resolveHubConnection();
      if (!hub) return;
      try {
        const data = (await hubRequestJson(hub.hubUrl, hub.userToken, "/api/v1/hub/notifications?unread=1")) as any;
        const count = data?.unreadCount ?? 0;
        if (count !== this.lastKnownNotifCount) {
          this.lastKnownNotifCount = count;
          this.broadcastNotifSSE({ type: "update", unreadCount: count });
        }
      } catch { /* ignore */ }
    };
    tick();
    this.notifPollTimer = setInterval(tick, 3000);
  }

  private stopNotifPoll(): void {
    if (this.notifPollTimer) { clearInterval(this.notifPollTimer); this.notifPollTimer = undefined; }
  }

  private notifPollImmediate(): void {
    const hub = this.resolveHubConnection();
    if (!hub) return;
    hubRequestJson(hub.hubUrl, hub.userToken, "/api/v1/hub/notifications?unread=1")
      .then((data: any) => {
        const count = data?.unreadCount ?? 0;
        if (count !== this.lastKnownNotifCount) {
          this.lastKnownNotifCount = count;
          this.broadcastNotifSSE({ type: "update", unreadCount: count });
        }
      })
      .catch(() => {});
  }

  private startHubHeartbeat(): void {
    this.stopHubHeartbeat();
    const sendHeartbeat = async () => {
      try {
        const hub = this.resolveHubConnection();
        if (!hub) {
          const persisted = this.store.getClientHubConnection();
          if (persisted?.hubUrl && persisted?.userToken) {
            await hubRequestJson(persisted.hubUrl, persisted.userToken, "/api/v1/hub/heartbeat", { method: "POST" });
          }
          return;
        }
        await hubRequestJson(hub.hubUrl, hub.userToken, "/api/v1/hub/heartbeat", { method: "POST" });
      } catch { /* best-effort */ }
    };
    sendHeartbeat();
    this.hubHeartbeatTimer = setInterval(sendHeartbeat, ViewerServer.HUB_HEARTBEAT_INTERVAL_MS);
  }

  private stopHubHeartbeat(): void {
    if (this.hubHeartbeatTimer) { clearInterval(this.hubHeartbeatTimer); this.hubHeartbeatTimer = undefined; }
  }

  private getLocalIPs(): string[] {
    const nets = os.networkInterfaces();
    const ips: string[] = [];
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] ?? []) {
        if (net.family === "IPv4" && !net.internal) {
          ips.push(net.address);
        }
      }
    }
    return ips;
  }

  private serveLocalIPs(res: http.ServerResponse): void {
    const ips = this.getLocalIPs();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ips }));
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
        ?? entries["memos-local"]?.config
        ?? entries["memos-lite-openclaw-plugin"]?.config
        ?? entries["memos-lite"]?.config
        ?? {};
      const result: Record<string, unknown> = { ...pluginEntry };
      const topEntry = entries["memos-local-openclaw-plugin"]
        ?? entries["memos-local"]
        ?? entries["memos-lite-openclaw-plugin"]
        ?? entries["memos-lite"]
        ?? {};
      if ((pluginEntry as any).viewerPort != null) {
        result.viewerPort = (pluginEntry as any).viewerPort;
      } else if (topEntry.viewerPort) {
        result.viewerPort = topEntry.viewerPort;
      }
      this.jsonResponse(res, result);
    } catch (e) {
      this.log.warn(`serveConfig error: ${e}`);
      this.jsonResponse(res, {});
    }
  }

  private handleSaveConfig(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(req, async (body) => {
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
          : entries["memos-local"] ? "memos-local"
          : entries["memos-lite-openclaw-plugin"] ? "memos-lite-openclaw-plugin"
          : entries["memos-lite"] ? "memos-lite"
          : "memos-local-openclaw-plugin";
        if (!entries[entryKey]) entries[entryKey] = { enabled: true };
        const entry = entries[entryKey] as Record<string, unknown>;
        if (!entry.config) entry.config = {};
        const config = entry.config as Record<string, unknown>;

        const oldSharing = config.sharing as Record<string, unknown> | undefined;
        const oldSharingRole = oldSharing?.role as string | undefined;
        const oldSharingEnabled = Boolean(oldSharing?.enabled);
        const oldClientHubAddress = String((oldSharing?.client as Record<string, unknown>)?.hubAddress || "");

        if (newCfg.embedding) config.embedding = newCfg.embedding;
        if (newCfg.summarizer) config.summarizer = newCfg.summarizer;
        if (newCfg.skillEvolution) config.skillEvolution = newCfg.skillEvolution;
        if (newCfg.viewerPort) config.viewerPort = newCfg.viewerPort;
        if (newCfg.taskAutoFinalizeHours !== undefined) config.taskAutoFinalizeHours = newCfg.taskAutoFinalizeHours;
        if (newCfg.telemetry !== undefined) config.telemetry = newCfg.telemetry;
        if (newCfg.sharing !== undefined) {
          const existing = (config.sharing as Record<string, unknown>) || {};
          const merged = { ...existing, ...newCfg.sharing };
          if (newCfg.sharing.capabilities && existing.capabilities) {
            merged.capabilities = { ...(existing.capabilities as Record<string, unknown>), ...newCfg.sharing.capabilities };
          }
          if (merged.role === "client" && merged.client) {
            const clientCfg = merged.client as Record<string, unknown>;
            const addr = String(clientCfg.hubAddress || "");
            if (addr && oldSharingRole === "hub" && oldSharingEnabled) {
              const selfHubPort = (oldSharing?.hub as Record<string, unknown>)?.port ?? 18800;
              const localIPs = this.getLocalIPs();
              localIPs.push("127.0.0.1", "localhost", "0.0.0.0");
              try {
                const u = new URL(addr.startsWith("http") ? addr : `http://${addr}`);
                const targetPort = u.port || (u.protocol === "https:" ? "443" : "80");
                if (localIPs.includes(u.hostname) && targetPort === String(selfHubPort)) {
                  res.writeHead(400, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ error: "cannot_join_self" }));
                  return;
                }
              } catch {}
            }
          }

          const newRole = merged.role as string | undefined;
          const newEnabled = Boolean(merged.enabled);

          // Detect disabling sharing or switching away from hub mode
          const wasHub = oldSharingEnabled && oldSharingRole === "hub";
          const isHub = newEnabled && newRole === "hub";
          if (wasHub && !isHub) {
            await this.notifyHubShutdown();
            this.stopHubHeartbeat();
            this.log.info("Hub shutting down: notified connected clients");
          }

          // Detect disabling sharing or switching away from client mode
          const wasClient = oldSharingEnabled && oldSharingRole === "client";
          const isClient = newEnabled && newRole === "client";
          if (wasClient && !isClient) {
            await this.withdrawOrLeaveHub();
            this.store.clearAllTeamSharingState();
            this.store.clearClientHubConnection();
            this.log.info("Client hub connection and team sharing state cleared (sharing disabled or role changed)");
          }

          if (wasClient && isClient) {
            const newClientAddr = String((merged.client as Record<string, unknown>)?.hubAddress || "");
            if (newClientAddr && oldClientHubAddress && normalizeHubUrl(newClientAddr) !== normalizeHubUrl(oldClientHubAddress)) {
              this.notifyHubLeave();
              this.store.clearAllTeamSharingState();
              const oldConn = this.store.getClientHubConnection();
              if (oldConn) {
                this.store.setClientHubConnection({ ...oldConn, hubUrl: normalizeHubUrl(newClientAddr), userToken: "", hubInstanceId: "", lastKnownStatus: "hub_changed" });
              }
              this.log.info("Client hub connection and team sharing state cleared (switched to different Hub)");
            }
          }

          if (merged.role === "hub") {
            merged.client = { hubAddress: "", userToken: "", teamToken: "" };
          } else if (merged.role === "client") {
            merged.hub = { teamName: "", teamToken: "" };
          }
          config.sharing = merged;
        }

        fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
        fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2), "utf-8");
        this.log.info("Plugin config updated via Viewer");
        this.stopHubHeartbeat();

        // When switching to client mode or re-enabling sharing as client, send join request
        const finalSharing = config.sharing as Record<string, unknown> | undefined;
        const nowClient = Boolean(finalSharing?.enabled) && finalSharing?.role === "client";
        const previouslyClient = oldSharingEnabled && oldSharingRole === "client";
        let joinStatus: string | undefined;
        let joinError: string | undefined;
        if (nowClient && !previouslyClient) {
          try {
            joinStatus = await this.autoJoinOnSave(finalSharing);
          } catch (e) {
            const msg = String(e instanceof Error ? e.message : e);
            this.log.warn(`Auto-join on save failed: ${msg}`);
            if (msg === "hub_unreachable" || msg === "username_taken" || msg === "invalid_team_token") {
              joinError = msg;
            }
          }
        }

        if (joinError) {
          this.jsonResponse(res, { ok: true, joinError, restart: false });
          return;
        }

        this.jsonResponseAndRestart(res, { ok: true, joinStatus, restart: true }, "config-save");
      } catch (e) {
        this.log.warn(`handleSaveConfig error: ${e}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
  }

  private async autoJoinOnSave(sharing: Record<string, unknown>): Promise<string | undefined> {
    const clientCfg = sharing.client as Record<string, unknown> | undefined;
    const hubAddress = String(clientCfg?.hubAddress || "");
    const teamToken = String(clientCfg?.teamToken || "");
    if (!hubAddress || !teamToken) return undefined;
    const hubUrl = normalizeHubUrl(hubAddress);

    try {
      await hubRequestJson(hubUrl, "", "/api/v1/hub/info", { method: "GET" });
    } catch {
      throw new Error("hub_unreachable");
    }

    const os = await import("os");
    const nickname = String(clientCfg?.nickname || "");
    const username = nickname || os.userInfo().username || "user";
    const hostname = os.hostname() || "unknown";
    const persisted = this.store.getClientHubConnection();
    const existingIdentityKey = persisted?.identityKey || "";

    let result: any;
    try {
      result = await hubRequestJson(hubUrl, "", "/api/v1/hub/join", {
        method: "POST",
        body: JSON.stringify({ teamToken, username, deviceName: hostname, identityKey: existingIdentityKey }),
      });
    } catch (err) {
      const errStr = String(err);
      if (errStr.includes("(409)") || errStr.includes("username_taken")) {
        throw new Error("username_taken");
      }
      if (errStr.includes("(403)") || errStr.includes("invalid_team_token")) {
        throw new Error("invalid_team_token");
      }
      throw err;
    }

    const returnedIdentityKey = String(result.identityKey || existingIdentityKey || "");
    let hubInstanceId = persisted?.hubInstanceId || "";
    try {
      const info = await hubRequestJson(hubUrl, "", "/api/v1/hub/info", { method: "GET" }) as any;
      hubInstanceId = String(info?.hubInstanceId ?? hubInstanceId);
    } catch { /* best-effort */ }
    this.store.setClientHubConnection({
      hubUrl,
      userId: String(result.userId || ""),
      username,
      userToken: result.userToken || "",
      role: "member",
      connectedAt: Date.now(),
      identityKey: returnedIdentityKey,
      lastKnownStatus: result.status || "",
      hubInstanceId,
    });
    this.log.info(`Auto-join on save: status=${result.status}, userId=${result.userId}`);
    if (result.userToken) {
      this.startHubHeartbeat();
    }
    return result.status;
  }

  private handleLeaveTeam(_req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(_req, async () => {
      try {
        await this.withdrawOrLeaveHub();
        this.store.clearAllTeamSharingState();
        this.store.clearClientHubConnection();

        const configPath = this.getOpenClawConfigPath();
        if (configPath && fs.existsSync(configPath)) {
          const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
          const pluginKey = Object.keys(raw.plugins?.entries ?? {}).find(k => k.includes("memos-local"));
          if (pluginKey) {
            const cfg = raw.plugins.entries[pluginKey].config ?? {};
            if (cfg.sharing) {
              cfg.sharing.enabled = false;
              cfg.sharing.client = { hubAddress: "", userToken: "", teamToken: "" };
            }
            raw.plugins.entries[pluginKey].config = cfg;
            fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n");
            this.log.info("handleLeaveTeam: config updated, sharing disabled");
          }
        }

        this.jsonResponseAndRestart(res, { ok: true, restart: true }, "handleLeaveTeam");
      } catch (e) {
        this.log.warn(`handleLeaveTeam error: ${e}`);
        this.jsonResponse(res, { ok: false, error: String(e) });
      }
    });
  }

  private async notifyHubLeave(): Promise<void> {
    try {
      const hub = this.resolveHubConnection();
      if (hub) {
        await hubRequestJson(hub.hubUrl, hub.userToken, "/api/v1/hub/leave", { method: "POST" });
        this.log.info("Notified Hub of voluntary leave");
        return;
      }
      const persisted = this.store.getClientHubConnection();
      if (persisted?.hubUrl && persisted?.userToken) {
        await hubRequestJson(persisted.hubUrl, persisted.userToken, "/api/v1/hub/leave", { method: "POST" });
        this.log.info("Notified Hub of voluntary leave (persisted connection)");
      }
    } catch (e) {
      this.log.warn(`Failed to notify Hub of leave: ${e}`);
    }
  }

  private async withdrawOrLeaveHub(): Promise<void> {
    try {
      const persisted = this.store.getClientHubConnection();
      const sharing = this.ctx?.config?.sharing;

      if (persisted?.userToken && persisted?.hubUrl) {
        await hubRequestJson(persisted.hubUrl, persisted.userToken, "/api/v1/hub/leave", { method: "POST" });
        this.log.info("Notified Hub of voluntary leave (had token)");
        return;
      }

      const hub = this.resolveHubConnection();
      if (hub?.userToken) {
        await hubRequestJson(hub.hubUrl, hub.userToken, "/api/v1/hub/leave", { method: "POST" });
        this.log.info("Notified Hub of voluntary leave (resolved connection)");
        return;
      }

      const hubUrl = persisted?.hubUrl || (sharing?.client?.hubAddress ? normalizeHubUrl(sharing.client.hubAddress) : null);
      const userId = persisted?.userId;
      const teamToken = sharing?.client?.teamToken;
      if (hubUrl && userId && teamToken) {
        const withdrawUrl = `${normalizeHubUrl(hubUrl)}/api/v1/hub/withdraw-pending`;
        await fetch(withdrawUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ teamToken, userId }),
        });
        this.log.info("Withdrew pending application from Hub");
        return;
      }

      this.log.info("No hub connection to clean up (no token, no pending)");
    } catch (e) {
      this.log.warn(`Failed to withdraw/leave Hub: ${e}`);
    }
  }

  private async notifyHubShutdown(): Promise<void> {
    try {
      const sharing = this.ctx?.config.sharing;
      if (!sharing || sharing.role !== "hub") return;
      const hubPort = this.getHubPort();
      const authPath = path.join(this.dataDir, "hub-auth.json");
      let adminToken: string | undefined;
      try {
        const authData = JSON.parse(fs.readFileSync(authPath, "utf8"));
        adminToken = authData?.bootstrapAdminToken;
      } catch { return; }
      if (!adminToken) return;

      const users = this.store.listHubUsers("active");
      const { v4: uuidv4 } = require("uuid");
      for (const u of users) {
        try {
          this.store.insertHubNotification({
            id: uuidv4(),
            userId: u.id,
            type: "hub_shutdown",
            resource: "hub",
            title: "Hub is shutting down",
            message: "The Hub server is shutting down. You may be disconnected.",
          });
        } catch (e) {
          this.log.warn(`Failed to insert shutdown notification for user ${u.id}: ${e}`);
        }
      }
      this.log.info(`Hub shutdown: notified ${users.length} approved user(s)`);
    } catch (e) {
      this.log.warn(`notifyHubShutdown error: ${e}`);
    }
  }

  private handleUpdateUsername(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(req, async (body) => {
      if (!this.ctx) return this.jsonResponse(res, { error: "sharing_unavailable" });
      try {
        const { username } = JSON.parse(body || "{}");
        if (!username || typeof username !== "string" || username.trim().length < 2 || username.trim().length > 32) {
          return this.jsonResponse(res, { error: "invalid_username" }, 400);
        }
        const trimmed = username.trim();
        const hubClient = await this.resolveHubClientAware();
        const result = await hubRequestJson(hubClient.hubUrl, hubClient.userToken, "/api/v1/hub/me/update-profile", {
          method: "POST",
          body: JSON.stringify({ username: trimmed }),
        }) as any;
        if (result.ok && result.userToken) {
          const sharing = this.ctx.config.sharing;
          if (sharing?.role === "hub") {
            try {
              const authPath = path.join(this.dataDir, "hub-auth.json");
              const authData = JSON.parse(fs.readFileSync(authPath, "utf8"));
              authData.bootstrapAdminToken = result.userToken;
              fs.writeFileSync(authPath, JSON.stringify(authData, null, 2), "utf-8");
              this.log.info("hub-auth.json updated with new admin token after username change");
            } catch (e) {
              this.log.warn(`Failed to update hub-auth.json: ${e}`);
            }
          } else {
            const persistedConn = this.store.getClientHubConnection();
            if (persistedConn) {
              this.store.setClientHubConnection({
                ...persistedConn,
                username: result.username,
                userToken: result.userToken,
              });
            }
          }
        }
        this.jsonResponse(res, result);
      } catch (err: any) {
        const msg = String(err?.message || err);
        if (msg.includes("409") || msg.includes("username_taken")) {
          return this.jsonResponse(res, { error: "username_taken" }, 409);
        }
        this.jsonResponse(res, { error: msg }, 500);
      }
    });
  }

  private handleTestHubConnection(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(req, async (body) => {
      try {
        const { hubUrl } = JSON.parse(body);
        if (!hubUrl) { this.jsonResponse(res, { ok: false, error: "hubUrl is required" }); return; }
        try {
          const sharing = this.ctx?.config?.sharing;
          if (sharing?.enabled && sharing.role === "hub") {
            const selfHubPort = this.getHubPort();
            const localIPs = this.getLocalIPs();
            localIPs.push("127.0.0.1", "localhost", "0.0.0.0");
            const parsed = new URL(hubUrl.startsWith("http") ? hubUrl : `http://${hubUrl}`);
            const targetPort = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
            if (localIPs.includes(parsed.hostname) && targetPort === String(selfHubPort)) {
              this.jsonResponse(res, { ok: false, error: "cannot_join_self" });
              return;
            }
          }
        } catch {}
        const baseUrl = hubUrl.replace(/\/+$/, "");
        const infoUrl = baseUrl + "/api/v1/hub/info";
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 8000);
        try {
          const r = await fetch(infoUrl, { signal: ctrl.signal });
          clearTimeout(timeout);
          if (!r.ok) { this.jsonResponse(res, { ok: false, error: `HTTP ${r.status}` }); return; }
          const info = await r.json() as Record<string, unknown>;

          const { teamToken, nickname } = JSON.parse(body);
          if (teamToken) {
            const username = (typeof nickname === "string" && nickname.trim()) || os.userInfo().username || "user";
            const persisted = this.store.getClientHubConnection();
            const identityKey = persisted?.identityKey || "";
            try {
              const joinR = await fetch(baseUrl + "/api/v1/hub/join", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ teamToken, username, identityKey, deviceName: os.hostname(), dryRun: true }),
              });
              const joinData = await joinR.json() as Record<string, unknown>;
              if (!joinR.ok && joinData.error === "username_taken") {
                this.jsonResponse(res, { ok: false, error: "username_taken", teamName: info.teamName || "" });
                return;
              }
              if (!joinR.ok && joinData.error === "invalid_team_token") {
                this.jsonResponse(res, { ok: false, error: "invalid_team_token", teamName: info.teamName || "" });
                return;
              }
              if (joinR.ok && joinData.status === "blocked") {
                this.jsonResponse(res, { ok: false, error: "blocked", teamName: info.teamName || "" });
                return;
              }
            } catch { /* join check is best-effort; connection itself is OK */ }
          }

          this.jsonResponse(res, { ok: true, teamName: info.teamName || "", apiVersion: info.apiVersion || "" });
        } catch (e: unknown) {
          clearTimeout(timeout);
          const msg = e instanceof Error ? e.message : String(e);
          this.jsonResponse(res, { ok: false, error: msg.includes("abort") ? "Connection timeout (8s)" : msg });
        }
      } catch (e) {
        this.jsonResponse(res, { ok: false, error: String(e) });
      }
    });
  }

  private handleTestModel(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readBody(req, async (body) => {
      try {
        const { type, provider, model, endpoint, apiKey } = JSON.parse(body);
        if (!provider) {
          this.jsonResponse(res, { ok: false, error: "provider is required" });
          return;
        }
        if (type === "embedding") {
          const dims = await this.testEmbeddingModel(provider, model, endpoint, apiKey);
          this.jsonResponse(res, { ok: true, detail: `${provider}/${model}`, dimensions: dims });
        } else {
          await this.testChatModel(provider, model, endpoint, apiKey);
          this.jsonResponse(res, { ok: true, detail: `${provider}/${model}` });
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        this.log.warn(`test-model failed: ${msg}`);
        this.jsonResponse(res, { ok: false, error: msg });
      }
    });
  }

  private serveModelHealth(res: http.ServerResponse): void {
    this.jsonResponse(res, { models: modelHealth.getAll() });
  }

  private serveFallbackModel(res: http.ServerResponse): void {
    try {
      const cfgPath = this.getOpenClawConfigPath();
      if (!fs.existsSync(cfgPath)) {
        this.jsonResponse(res, { available: false });
        return;
      }
      const raw = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
      const agentModel: string | undefined = raw?.agents?.defaults?.model?.primary;
      if (!agentModel) {
        this.jsonResponse(res, { available: false });
        return;
      }
      const [providerKey, modelId] = agentModel.includes("/")
        ? agentModel.split("/", 2)
        : [undefined, agentModel];
      const providerCfg = providerKey
        ? raw?.models?.providers?.[providerKey]
        : Object.values(raw?.models?.providers ?? {})[0] as Record<string, unknown> | undefined;
      const resolvedKey = ViewerServer.resolveApiKeyValue(providerCfg?.apiKey);
      if (!providerCfg || !providerCfg.baseUrl || !resolvedKey) {
        this.jsonResponse(res, { available: false });
        return;
      }
      this.jsonResponse(res, { available: true, model: modelId || agentModel, baseUrl: providerCfg.baseUrl });
    } catch {
      this.jsonResponse(res, { available: false });
    }
  }

  private static resolveApiKeyValue(
    input: unknown,
  ): string | undefined {
    if (!input) return undefined;
    if (typeof input === "string") return input;
    if (typeof input === "object" && input !== null && (input as any).source === "env") {
      return process.env[(input as any).id];
    }
    return undefined;
  }

  private findPluginPackageJson(): string | null {
    let dir = __dirname;
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, "package.json");
      if (fs.existsSync(candidate)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(candidate, "utf-8"));
          if (pkg.name && pkg.name.includes("memos-local")) return candidate;
        } catch { /* skip */ }
      }
      dir = path.dirname(dir);
    }
    return null;
  }

  private async handleUpdateCheck(res: http.ServerResponse): Promise<void> {
    const sendNoStore = (data: unknown, statusCode = 200) => {
      res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache",
        "Expires": "0",
      });
      res.end(JSON.stringify(data));
    };
    try {
      const pkgPath = this.findPluginPackageJson();
      if (!pkgPath) {
        sendNoStore({ updateAvailable: false, error: "package.json not found" });
        return;
      }
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const current = pkg.version as string;
      const name = pkg.name as string;
      if (!current || !name) {
        sendNoStore({ updateAvailable: false, current });
        return;
      }
      const { computeUpdateCheck } = await import("../update-check");
      const result = await computeUpdateCheck(name, current, fetch, 6_000);
      if (!result) {
        sendNoStore({ updateAvailable: false, current, packageName: name });
        return;
      }
      sendNoStore({
        updateAvailable: result.updateAvailable,
        current: result.current,
        latest: result.latest,
        packageName: result.packageName,
        channel: result.channel,
        installCommand: result.installCommand,
        stableChannel: result.stableChannel,
      });
    } catch (e) {
      this.log.warn(`handleUpdateCheck error: ${e}`);
      sendNoStore({ updateAvailable: false, error: String(e) });
    }
  }

  private handleUpdateInstall(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      try {
        const { packageSpec: rawSpec, targetVersion: rawTargetVersion } = JSON.parse(body);
        if (!rawSpec || typeof rawSpec !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Missing packageSpec" }));
          return;
        }
        const packageSpec = rawSpec.trim().replace(/^(?:npx\s+)?openclaw\s+plugins\s+install\s+/i, "");
        const targetVersion = typeof rawTargetVersion === "string" ? rawTargetVersion.trim() : "";
        const allowed = /^@[\w-]+\/[\w.-]+(@[\w.-]+)?$/;
        this.log.info(`update-install: received packageSpec="${packageSpec}" (len=${packageSpec.length})`);
        if (!allowed.test(packageSpec)) {
          this.log.warn(`update-install: rejected packageSpec="${packageSpec}" — does not match ${allowed}`);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: `Invalid package spec: "${packageSpec}"` }));
          return;
        }

        const pkgPath = this.findPluginPackageJson();
        const pluginName = pkgPath
          ? (() => { try { return JSON.parse(fs.readFileSync(pkgPath, "utf-8")).name; } catch { return null; } })()
          : null;
        const shortName = pluginName?.replace(/^@[\w-]+\//, "") ?? "memos-local-openclaw-plugin";
        const extDir = path.join(os.homedir(), ".openclaw", "extensions", shortName);
        const tmpDir = path.join(os.tmpdir(), `openclaw-update-${Date.now()}`);
        const backupDir = path.join(path.dirname(extDir), `${shortName}.backup-${Date.now()}`);
        let backupReady = false;

        const cleanupTmpDir = () => {
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        };
        const rollbackInstall = () => {
          try { fs.rmSync(extDir, { recursive: true, force: true }); } catch {}
          if (!backupReady) return;
          try {
            fs.renameSync(backupDir, extDir);
            backupReady = false;
            this.log.info(`update-install: restored previous version from ${backupDir}`);
          } catch (restoreErr: any) {
            this.log.warn(`update-install: failed to restore previous version: ${restoreErr?.message ?? restoreErr}`);
          }
        };
        const discardBackup = () => {
          if (!backupReady) return;
          try {
            fs.rmSync(backupDir, { recursive: true, force: true });
            backupReady = false;
          } catch (cleanupErr: any) {
            this.log.warn(`update-install: failed to remove backup dir ${backupDir}: ${cleanupErr?.message ?? cleanupErr}`);
          }
        };

        // Download via npm pack, extract, and replace extension dir.
        // Does NOT touch openclaw.json → no config watcher SIGUSR1.
        this.log.info(`update-install: downloading ${packageSpec} via npm pack...`);
        fs.mkdirSync(tmpDir, { recursive: true });
        exec(`npm pack ${packageSpec} --pack-destination ${tmpDir} --prefer-online`, { timeout: 60_000 }, (packErr, packOut) => {
          if (packErr) {
            this.log.warn(`update-install: npm pack failed: ${packErr.message}`);
            this.jsonResponse(res, { ok: false, error: `Download failed: ${packErr.message}` });
            cleanupTmpDir();
            return;
          }
          const tgzFile = packOut.trim().split("\n").pop()!;
          const tgzPath = path.join(tmpDir, tgzFile);
          this.log.info(`update-install: downloaded ${tgzFile}, extracting...`);

          const extractDir = path.join(tmpDir, "extract");
          fs.mkdirSync(extractDir, { recursive: true });
          exec(`tar -xzf ${tgzPath} -C ${extractDir}`, { timeout: 30_000 }, (tarErr) => {
            if (tarErr) {
              this.log.warn(`update-install: tar extract failed: ${tarErr.message}`);
              this.jsonResponse(res, { ok: false, error: `Extract failed: ${tarErr.message}` });
              cleanupTmpDir();
              return;
            }

            // npm pack extracts to a "package" subdirectory
            const srcDir = path.join(extractDir, "package");
            if (!fs.existsSync(srcDir)) {
              this.jsonResponse(res, { ok: false, error: "Extracted package has no 'package' dir" });
              cleanupTmpDir();
              return;
            }

            // Replace extension directory
            this.log.info(`update-install: replacing ${extDir}...`);
            try {
              fs.mkdirSync(path.dirname(extDir), { recursive: true });
              try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch {}
              if (fs.existsSync(extDir)) {
                fs.renameSync(extDir, backupDir);
                backupReady = true;
              }
              fs.renameSync(srcDir, extDir);
            } catch (replaceErr: any) {
              this.log.warn(`update-install: replace failed: ${replaceErr?.message ?? replaceErr}`);
              cleanupTmpDir();
              rollbackInstall();
              this.jsonResponse(res, { ok: false, error: `Replace failed: ${replaceErr?.message ?? replaceErr}` });
              return;
            }

            // Install dependencies
            this.log.info(`update-install: installing dependencies...`);
            const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
            execFile(npmCmd, ["install", "--omit=dev", "--ignore-scripts"], { cwd: extDir, timeout: 120_000 }, (npmErr, npmOut, npmStderr) => {
              if (npmErr) {
                this.log.warn(`update-install: npm install failed: ${npmErr.message}`);
                cleanupTmpDir();
                rollbackInstall();
                this.jsonResponse(res, { ok: false, error: `Dependency install failed: ${npmStderr || npmErr.message}` });
                return;
              }

              execFile(npmCmd, ["rebuild", "better-sqlite3"], { cwd: extDir, timeout: 60_000 }, (rebuildErr, rebuildOut, rebuildStderr) => {
                if (rebuildErr) {
                  this.log.warn(`update-install: better-sqlite3 rebuild failed: ${rebuildErr.message}`);
                  const stderr = String(rebuildStderr || "").trim();
                  if (stderr) this.log.warn(`update-install: rebuild stderr: ${stderr.slice(0, 500)}`);
                }

                this.log.info(`update-install: running postinstall...`);
                execFile(process.execPath, ["scripts/postinstall.cjs"], { cwd: extDir, timeout: 180_000 }, (postErr, postOut, postStderr) => {
                  cleanupTmpDir();

                  if (postErr) {
                    this.log.warn(`update-install: postinstall failed: ${postErr.message}`);
                    const postStderrStr = String(postStderr || "").trim();
                    if (postStderrStr) this.log.warn(`update-install: postinstall stderr: ${postStderrStr.slice(0, 500)}`);
                    rollbackInstall();
                    this.jsonResponse(res, { ok: false, error: `Postinstall failed: ${postStderrStr || postErr.message}` });
                    return;
                  }

                  let newVersion = "unknown";
                  try {
                    const newPkg = JSON.parse(fs.readFileSync(path.join(extDir, "package.json"), "utf-8"));
                    newVersion = newPkg.version ?? newVersion;
                  } catch {}

                  if (targetVersion && newVersion !== targetVersion) {
                    this.log.warn(`update-install: version mismatch! expected=${targetVersion}, got=${newVersion} — rolling back`);
                    rollbackInstall();
                    this.jsonResponse(res, {
                      ok: false,
                      error: `Version mismatch: expected ${targetVersion} but downloaded ${newVersion}. npm cache may be stale — please try again.`,
                    });
                    return;
                  }

                  discardBackup();
                  this.log.info(`update-install: success! Updated to ${newVersion}`);
                  this.jsonResponseAndRestart(res, { ok: true, version: newVersion }, "update-install");
                });
              });
            });
          });
        });
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
  }

  private async testEmbeddingModel(provider: string, model: string, endpoint: string, apiKey: string): Promise<number | undefined> {
    if (provider === "local") {
      return 384;
    }
    const baseUrl = (endpoint || "https://api.openai.com/v1").replace(/\/+$/, "");
    const embUrl = baseUrl.endsWith("/embeddings") ? baseUrl : `${baseUrl}/embeddings`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    };
    if (provider === "cohere") {
      headers["Authorization"] = `Bearer ${apiKey}`;
      const resp = await fetch(baseUrl.replace(/\/v\d+.*/, "/v2/embed"), {
        method: "POST",
        headers,
        body: JSON.stringify({ texts: ["test embedding vector"], model: model || "embed-english-v3.0", input_type: "search_query", embedding_types: ["float"] }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`Cohere embed ${resp.status}: ${txt}`);
      }
      const json = await resp.json() as any;
      const vecs = json?.embeddings?.float;
      if (!Array.isArray(vecs) || vecs.length === 0 || !Array.isArray(vecs[0]) || vecs[0].length === 0) {
        throw new Error("Cohere returned empty embedding vector");
      }
      return vecs[0].length;
    }
    if (provider === "gemini") {
      const url = `https://generativelanguage.googleapis.com/v1/models/${model || "text-embedding-004"}:embedContent?key=${apiKey}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: { parts: [{ text: "test embedding vector" }] } }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`Gemini embed ${resp.status}: ${txt}`);
      }
      const json = await resp.json() as any;
      const vec = json?.embedding?.values;
      if (!Array.isArray(vec) || vec.length === 0) {
        throw new Error("Gemini returned empty embedding vector");
      }
      return vec.length;
    }
    const resp = await fetch(embUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ input: ["test embedding vector"], model: model || "text-embedding-3-small" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`${resp.status}: ${txt}`);
    }
    const json = await resp.json() as any;
    const data = json?.data;
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error("API returned no embedding data");
    }
    const vec = data[0]?.embedding;
    if (!Array.isArray(vec) || vec.length === 0) {
      throw new Error(`API returned empty embedding vector (got ${JSON.stringify(vec)?.slice(0, 100)})`);
    }
    return vec.length;
  }

  private async testChatModel(provider: string, model: string, endpoint: string, apiKey: string): Promise<void> {
    const baseUrl = (endpoint || "https://api.openai.com/v1").replace(/\/+$/, "");
    if (provider === "anthropic") {
      const url = endpoint || "https://api.anthropic.com/v1/messages";
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model: model || "claude-3-haiku-20240307", max_tokens: 5, messages: [{ role: "user", content: "hi" }] }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`Anthropic ${resp.status}: ${txt}`);
      }
      return;
    }
    if (provider === "gemini") {
      const url = `https://generativelanguage.googleapis.com/v1/models/${model || "gemini-1.5-flash"}:generateContent?key=${apiKey}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 5 } }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`Gemini ${resp.status}: ${txt}`);
      }
      return;
    }
    const chatUrl = baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`;
    const resp = await fetch(chatUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: model || "gpt-4o-mini", max_tokens: 5, messages: [{ role: "user", content: "hi" }] }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`${resp.status}: ${txt}`);
    }
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
    return process.env.OPENCLAW_STATE_DIR || path.join(home, ".openclaw");
  }

  private handleCleanupPolluted(res: http.ServerResponse): void {
    try {
      const polluted = this.store.findPollutedUserChunks();
      let deleted = 0;
      for (const { id, reason } of polluted) {
        if (this.store.deleteChunk(id)) {
          deleted++;
          this.log.info(`Cleaned polluted chunk ${id}: ${reason}`);
        }
      }
      const fixed = this.store.fixMixedUserChunks();
      this.log.info(`Cleanup: removed ${deleted} polluted, fixed ${fixed} mixed chunks`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ deleted, fixed, total: polluted.length }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`handleCleanupPolluted error: ${msg}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: msg }));
    }
  }

  private handleMigrateScan(res: http.ServerResponse): void {
    try {
      const ocHome = this.getOpenClawHome();
      const memoryDir = path.join(ocHome, "memory");
      const agentsDir = path.join(ocHome, "agents");

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
      if (fs.existsSync(agentsDir)) {
        for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const sessDir = path.join(agentsDir, entry.name, "sessions");
          if (!fs.existsSync(sessDir)) continue;
          const jsonlFiles = fs.readdirSync(sessDir).filter(f => f.includes(".jsonl"));
          sessionCount += jsonlFiles.length;
          for (const f of jsonlFiles) {
            try {
              const content = fs.readFileSync(path.join(sessDir, f), "utf-8");
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
      }

      const cfgPath = this.getOpenClawConfigPath();
      let hasEmbedding = false;
      let hasSummarizer = false;
      if (fs.existsSync(cfgPath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
          const pluginCfg = raw?.plugins?.entries?.["memos-local-openclaw-plugin"]?.config ??
                            raw?.plugins?.entries?.["memos-local"]?.config ??
                            raw?.plugins?.entries?.["memos-lite-openclaw-plugin"]?.config ??
                            raw?.plugins?.entries?.["memos-lite"]?.config ?? {};
          const emb = pluginCfg.embedding;
          hasEmbedding = !!(emb && emb.provider);
          const sum = pluginCfg.summarizer;
          hasSummarizer = !!(sum && sum.provider);
        } catch { /* ignore */ }
      }

      let importedSessions: string[] = [];
      let importedChunkCount = 0;
      try {
        if (this.store) {
          importedSessions = this.store.getDistinctSessionKeys()
            .filter((sk: string) => sk.startsWith("openclaw-import-") || sk.startsWith("openclaw-session-") || /^agent:[^:]+:(import|session:)/.test(sk));
          if (importedSessions.length > 0) {
            const placeholders = importedSessions.map(() => "?").join(",");
            const row = (this.store as any).db.prepare(
              `SELECT COUNT(*) as cnt FROM chunks WHERE session_key IN (${placeholders})`
            ).get(...importedSessions) as { cnt: number };
            importedChunkCount = row?.cnt ?? 0;
          }
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
        importedChunkCount,
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
      res.write(`event: ${evtName}\ndata: ${JSON.stringify({ ok: this.migrationState.success, ...this.migrationState })}\n\n`);
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

      this.migrationState = createInitialMigrationState();

      const send = (event: string, data: unknown) => {
        if (event === "item") {
          const d = data as any;
          applyMigrationItemToState(this.migrationState, d);
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
        this.migrationState.success = computeMigrationSuccess(this.migrationState);
        const donePayload = { ok: this.migrationState.success, ...this.migrationState };
        if (this.migrationAbort) {
          this.migrationState.stopped = true;
          this.broadcastSSE("stopped", donePayload);
        } else {
          this.broadcastSSE("done", donePayload);
        }
        this.migrationAbort = false;
        const clientsToClose = [...this.migrationSSEClients];
        this.migrationSSEClients = [];
        setTimeout(() => {
          for (const c of clientsToClose) {
            try { c.end(); } catch { /* ignore */ }
          }
        }, 500);
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
    try {
      const raw = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
      const pluginCfg = raw?.plugins?.entries?.["memos-local-openclaw-plugin"]?.config ??
                        raw?.plugins?.entries?.["memos-local"]?.config ??
                        raw?.plugins?.entries?.["memos-lite-openclaw-plugin"]?.config ??
                        raw?.plugins?.entries?.["memos-lite"]?.config ?? {};
      summarizerCfg = pluginCfg.summarizer;
    } catch { /* no config */ }

    const summarizer = new Summarizer(summarizerCfg, this.log);

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
              if (this.store.chunkExistsByContent(`agent:${agentId}:import`, "assistant", row.text) || this.store.chunkExistsByContent(`openclaw-import-${agentId}`, "assistant", row.text)) {
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
                const stepFailures: Array<"summarization" | "dedup" | "embedding"> = [];
                let summary = "";
                try {
                  summary = await summarizer.summarize(row.text);
                } catch (err) {
                  stepFailures.push("summarization");
                  this.log.warn(`Migration summarization failed: ${err}`);
                }
                if (!summary) {
                  stepFailures.push("summarization");
                  summary = row.text.slice(0, 200);
                }

                let embedding: number[] | null = null;
                try {
                  [embedding] = await this.embedder.embed([summary]);
                } catch (err) {
                  stepFailures.push("embedding");
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
                      try {
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
                      } catch (err) {
                        stepFailures.push("dedup");
                        this.log.warn(`Migration dedup judgment failed: ${err}`);
                      }
                    }
                  }
                }

                const chunkId = uuid();
                const chunk: Chunk = {
                  id: chunkId,
                  sessionKey: `agent:${agentId}:import`,
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
                  createdAt: Number(row.updated_at) < 1e12 ? Number(row.updated_at) * 1000 : Number(row.updated_at),
                  updatedAt: Number(row.updated_at) < 1e12 ? Number(row.updated_at) * 1000 : Number(row.updated_at),
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
                  stepFailures,
                });
                if (stepFailures.length > 0) {
                  this.log.warn(`[MIGRATION] sqlite item imported with step failures: ${stepFailures.join(",")}`);
                } else {
                  this.log.info("[MIGRATION] sqlite item imported successfully (all steps)");
                }
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

              const sessionKey = `agent:${agentId}:session:${sessionId}`;
              if (this.store.chunkExistsByContent(sessionKey, msgRole, content) || this.store.chunkExistsByContent(`openclaw-session-${sessionId}`, msgRole, content)) {
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
                const stepFailures: Array<"summarization" | "dedup" | "embedding"> = [];
                let summary = "";
                try {
                  summary = await summarizer.summarize(content);
                } catch (err) {
                  stepFailures.push("summarization");
                  this.log.warn(`Migration summarization failed: ${err}`);
                }
                if (!summary) {
                  stepFailures.push("summarization");
                  summary = content.slice(0, 200);
                }

                let embedding: number[] | null = null;
                try {
                  [embedding] = await this.embedder.embed([summary]);
                } catch (err) {
                  stepFailures.push("embedding");
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
                      try {
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
                      } catch (err) {
                        stepFailures.push("dedup");
                        this.log.warn(`Migration dedup judgment failed: ${err}`);
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
                send("item", { index: idx, total: totalMsgs, status: dedupStatus === "active" ? "stored" : dedupStatus, preview: content.slice(0, 120), summary: summary.slice(0, 80), source: file, agent: agentId, role: msgRole, stepFailures });
                if (stepFailures.length > 0) {
                  this.log.warn(`[MIGRATION] session item imported with step failures: ${stepFailures.join(",")}`);
                } else {
                  this.log.info("[MIGRATION] session item imported successfully (all steps)");
                }
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
    send("summary", {
      totalProcessed,
      totalStored,
      totalSkipped,
      totalErrors,
      success: computeMigrationSuccess(this.migrationState),
      stepFailures: this.migrationState.stepFailures,
    });
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
      this.ppState = { running: true, done: false, stopped: false, processed: 0, total: 0, tasksCreated: 0, skillsCreated: 0, errors: 0, skippedSessions: 0, totalSessions: 0 };

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
        this.ppAbort = false;
        const ppClientsToClose = [...this.ppSSEClients];
        this.ppSSEClients = [];
        setTimeout(() => {
          for (const c of ppClientsToClose) { try { c.end(); } catch { /* */ } }
        }, 500);
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
    let existingTasks = 0;
    let existingSkills = 0;
    try {
      existingTasks = (this.store as any).db.prepare("SELECT COUNT(*) as c FROM tasks").get()?.c ?? 0;
      existingSkills = this.store.countSkills("active");
    } catch { /* */ }
    this.jsonResponse(res, { ...this.ppState, existingTasks, existingSkills });
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
      .filter((sk: string) => sk.startsWith("openclaw-import-") || sk.startsWith("openclaw-session-") || /^agent:[^:]+:(import|session:)/.test(sk));

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
    this.ppState.skippedSessions = skippedCount;
    this.ppState.totalSessions = importSessions.length;
    const existingTaskCount = (this.store as any).db.prepare("SELECT COUNT(*) as c FROM tasks WHERE session_key IN (" + importSessions.map(() => "?").join(",") + ")").get(...importSessions)?.c ?? 0;
    const existingSkillCount = this.store.countSkills("active");
    send("info", {
      totalSessions: importSessions.length,
      alreadyProcessed: skippedCount,
      pending: pendingItems.length,
      agents: Array.from(agentGroups.keys()),
      concurrency,
      existingTasks: existingTaskCount,
      existingSkills: existingSkillCount,
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

  private jsonResponseAndRestart(
    res: http.ServerResponse,
    data: unknown,
    source: string,
    delayMs = 1500,
    statusCode = 200,
  ): void {
    res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data), () => {
      setTimeout(() => {
        this.log.info(`${source}: triggering gateway restart via SIGUSR1...`);
        try { process.kill(process.pid, "SIGUSR1"); } catch (sig) { this.log.warn(`SIGUSR1 failed: ${sig}`); }
      }, delayMs);
    });
  }

  private jsonResponse(res: http.ServerResponse, data: unknown, statusCode = 200): void {
    res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
  }
}
