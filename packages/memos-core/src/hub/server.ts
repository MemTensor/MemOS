import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { createHash, randomBytes, randomUUID } from "crypto";
import type { SqliteStore } from "../storage/sqlite";
import type { Embedder } from "../embedding";
import type { Logger, MemosLocalConfig } from "../types";
import { issueUserToken, verifyUserToken } from "./auth";
import { HubUserManager } from "./user-manager";

type HubServerOptions = {
  store: SqliteStore;
  log: Logger;
  config: MemosLocalConfig;
  dataDir: string;
  embedder?: Embedder;
  defaultHubPort?: number;
};

type HubAuthState = {
  authSecret: string;
  bootstrapAdminUserId?: string;
  bootstrapAdminToken?: string;
  hubInstanceId?: string;
};

export class HubServer {
  private server?: http.Server;
  private remoteHitMap = new Map<string, { chunkId: string; type: "chunk" | "memory"; expiresAt: number; requesterUserId: string }>();
  private readonly userManager: HubUserManager;
  private readonly authStatePath: string;
  private authState: HubAuthState;

  private static readonly RATE_WINDOW_MS = 60_000;
  private static readonly RATE_LIMIT_DEFAULT = 60;
  private static readonly RATE_LIMIT_SEARCH = 30;
  private rateBuckets = new Map<string, { count: number; windowStart: number }>();

  private static readonly OFFLINE_THRESHOLD_MS = 2 * 60 * 1000;
  private static readonly OFFLINE_CHECK_INTERVAL_MS = 30 * 1000;
  private offlineCheckTimer?: ReturnType<typeof setInterval>;
  private knownOnlineUsers = new Set<string>();

  constructor(private opts: HubServerOptions) {
    this.userManager = new HubUserManager(opts.store, opts.log);
    this.authStatePath = path.join(opts.dataDir, "hub-auth.json");
    this.authState = this.loadAuthState();
  }

  private checkRateLimit(userId: string, endpoint: string): boolean {
    const key = `${userId}:${endpoint}`;
    const now = Date.now();
    const limit = endpoint === "search" ? HubServer.RATE_LIMIT_SEARCH : HubServer.RATE_LIMIT_DEFAULT;
    const bucket = this.rateBuckets.get(key);
    if (!bucket || now - bucket.windowStart > HubServer.RATE_WINDOW_MS) {
      this.rateBuckets.set(key, { count: 1, windowStart: now });
      return true;
    }
    bucket.count++;
    return bucket.count <= limit;
  }

  async start(): Promise<string> {
    if (!this.teamToken) {
      throw new Error("team token is required to start hub mode");
    }
    if (this.server?.listening) {
      return `http://127.0.0.1:${this.port}`;
    }

    this.server = http.createServer(async (req, res) => {
      try {
        await this.handle(req, res);
      } catch (err: any) {
        const code = err?.statusCode ?? 500;
        const message = code === 413 ? "request_body_too_large" : "internal_error";
        this.opts.log.warn(`hub server error: ${String(err)}`);
        res.statusCode = code;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: message }));
      }
    });

    const MAX_PORT_RETRIES = 3;
    let hubPort = this.port;
    await new Promise<void>((resolve, reject) => {
      let retries = 0;
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && retries < MAX_PORT_RETRIES) {
          retries++;
          hubPort = this.port + retries;
          this.opts.log.warn(`Hub port ${hubPort - 1} in use, trying ${hubPort}`);
          this.server!.listen(hubPort, "0.0.0.0");
        } else {
          this.server?.off("listening", onListening);
          reject(err);
        }
      };
      const onListening = () => {
        this.server?.off("error", onError);
        if (hubPort !== this.port) {
          this.opts.log.info(`Hub started on fallback port ${hubPort} (configured: ${this.port})`);
        }
        resolve();
      };
      this.server!.on("error", onError);
      this.server!.once("listening", onListening);
      this.server!.listen(hubPort, "0.0.0.0");
    });

    const bootstrap = this.userManager.ensureBootstrapAdmin(
      this.authSecret,
      "admin",
      this.authState.bootstrapAdminUserId,
      this.authState.bootstrapAdminToken,
    );
    if (bootstrap.token) {
      this.authState.bootstrapAdminUserId = bootstrap.user.id;
      this.authState.bootstrapAdminToken = bootstrap.token;
      this.saveAuthState();
      this.opts.log.info(`memos-local: bootstrap admin token persisted to ${this.authStatePath}`);
    }

    this.initOnlineTracking();
    this.offlineCheckTimer = setInterval(() => this.checkOfflineUsers(), HubServer.OFFLINE_CHECK_INTERVAL_MS);

    this.backfillMemoryEmbeddings();

    return `http://127.0.0.1:${hubPort}`;
  }

  async stop(): Promise<void> {
    if (this.offlineCheckTimer) { clearInterval(this.offlineCheckTimer); this.offlineCheckTimer = undefined; }
    if (!this.server) return;

    try {
      const activeUsers = this.opts.store.listHubUsers("active");
      const ownerId = this.authState.bootstrapAdminUserId || "";
      for (const u of activeUsers) {
        if (u.id === ownerId) continue;
        try {
          this.opts.store.insertHubNotification({
            id: randomUUID(), userId: u.id, type: "hub_shutdown",
            resource: "system", title: `Team server "${this.teamName}" has been shut down by the admin.`,
          });
        } catch { /* best-effort */ }
      }
    } catch { /* best-effort */ }

    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private get port(): number {
    const configured = this.opts.config.sharing?.hub?.port;
    const derived = this.opts.defaultHubPort;
    if (derived && (!configured || configured === 18800)) return derived;
    return configured ?? 18800;
  }

  private get teamName(): string {
    return this.opts.config.sharing?.hub?.teamName ?? "";
  }

  private get teamToken(): string {
    return this.opts.config.sharing?.hub?.teamToken ?? "";
  }

  private get authSecret(): string {
    return this.authState.authSecret;
  }

  get hubInstanceId(): string {
    return this.authState.hubInstanceId ?? "";
  }

  private loadAuthState(): HubAuthState {
    try {
      const raw = fs.readFileSync(this.authStatePath, "utf8");
      const parsed = JSON.parse(raw) as HubAuthState;
      if (parsed.authSecret) {
        if (!parsed.hubInstanceId) {
          parsed.hubInstanceId = randomUUID();
          fs.writeFileSync(this.authStatePath, JSON.stringify(parsed, null, 2), "utf8");
        }
        return parsed;
      }
    } catch {}
    const initial: HubAuthState = { authSecret: randomBytes(32).toString("hex"), hubInstanceId: randomUUID() };
    fs.mkdirSync(path.dirname(this.authStatePath), { recursive: true });
    fs.writeFileSync(this.authStatePath, JSON.stringify(initial, null, 2), "utf8");
    return initial;
  }

  private saveAuthState(): void {
    fs.mkdirSync(path.dirname(this.authStatePath), { recursive: true });
    fs.writeFileSync(this.authStatePath, JSON.stringify(this.authState, null, 2), "utf8");
  }

  private embedChunksAsync(chunkIds: string[], chunks: Array<{ id: string; summary?: string; content?: string }>): void {
    const embedder = this.opts.embedder;
    if (!embedder) return;
    const texts = chunks.map(c => c.summary || (c.content ? c.content.slice(0, 500) : ""));
    embedder.embed(texts).then((vectors) => {
      for (let i = 0; i < vectors.length; i++) {
        if (vectors[i]) {
          this.opts.store.upsertHubEmbedding(chunkIds[i], new Float32Array(vectors[i]));
        }
      }
      this.opts.log.info(`hub: embedded ${vectors.filter(Boolean).length}/${chunkIds.length} shared chunks`);
    }).catch((err) => {
      this.opts.log.warn(`hub: embedding shared chunks failed: ${err}`);
    });
  }

  private embedSkillAsync(skillId: string, name: string, description: string, sourceUserId: string, sourceSkillId: string): void {
    const embedder = this.opts.embedder;
    if (!embedder) return;
    const text = `${name}: ${description}`;
    embedder.embed([text]).then((vectors) => {
      if (vectors[0]) {
        this.opts.store.upsertHubSkillEmbedding(skillId, Array.from(vectors[0]), sourceUserId, sourceSkillId);
        this.opts.log.info(`hub: embedded shared skill ${skillId}`);
      }
    }).catch((err) => {
      this.opts.log.warn(`hub: embedding shared skill failed: ${err}`);
    });
  }

  private backfillMemoryEmbeddings(): void {
    if (!this.opts.embedder) return;
    try {
      const all = this.opts.store.listHubMemories({ limit: 500 });
      const missing = all.filter(m => {
        try { return !this.opts.store.getHubMemoryEmbedding(m.id); } catch { return true; }
      });
      if (missing.length === 0) return;
      this.opts.log.info(`hub: backfilling embeddings for ${missing.length} hub memories`);
      const texts = missing.map(m => (m.summary || m.content || "").slice(0, 500));
      this.opts.embedder.embed(texts).then((vectors) => {
        let count = 0;
        for (let i = 0; i < vectors.length; i++) {
          if (vectors[i]) {
            this.opts.store.upsertHubMemoryEmbedding(missing[i].id, new Float32Array(vectors[i]));
            count++;
          }
        }
        this.opts.log.info(`hub: backfilled ${count}/${missing.length} memory embeddings`);
      }).catch((err) => {
        this.opts.log.warn(`hub: backfill memory embeddings failed: ${err}`);
      });
    } catch (err) {
      this.opts.log.warn(`hub: backfill memory embeddings error: ${err}`);
    }
  }

  private embedMemoryAsync(memoryId: string, summary: string, content: string): void {
    const embedder = this.opts.embedder;
    if (!embedder) return;
    const text = (summary || content || "").slice(0, 500);
    if (!text) return;
    embedder.embed([text]).then((vectors) => {
      if (vectors[0]) {
        this.opts.store.upsertHubMemoryEmbedding(memoryId, new Float32Array(vectors[0]));
        this.opts.log.info(`hub: embedded shared memory ${memoryId}`);
      }
    }).catch((err) => {
      this.opts.log.warn(`hub: embedding shared memory failed: ${err}`);
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://127.0.0.1:${this.port}`);
    const routePath = url.pathname;

    if (req.method === "GET" && routePath === "/api/v1/hub/info") {
      return this.json(res, 200, {
        teamName: this.teamName,
        version: "0.0.0",
        apiVersion: "v1",
        hubInstanceId: this.hubInstanceId,
      });
    }

    if (req.method === "POST" && routePath === "/api/v1/hub/join") {
      const body = await this.readJson(req);
      if (!body || body.teamToken !== this.teamToken) {
        return this.json(res, 403, { error: "invalid_team_token" });
      }
      const username = String(body.username || `user-${randomUUID().slice(0, 8)}`);
      const joinIp = (typeof body.clientIp === "string" && body.clientIp)
        || (req.headers["x-client-ip"] as string)?.trim()
        || (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
        || req.socket.remoteAddress || "";
      const identityKey = typeof body.identityKey === "string" ? body.identityKey.trim() : "";
      const dryRun = body.dryRun === true;

      const identityMatch = identityKey
        ? this.userManager.findByIdentityKey(identityKey)
        : null;

      if (identityMatch) {
        if (!dryRun) {
          try { this.opts.store.updateHubUserActivity(identityMatch.id, joinIp); } catch { /* best-effort */ }
        }

        if (identityMatch.status === "active") {
          if (dryRun) return this.json(res, 200, { status: "active", dryRun: true });
          const token = issueUserToken(
            { userId: identityMatch.id, username: identityMatch.username, role: identityMatch.role, status: "active" },
            this.authSecret,
          );
          this.userManager.approveUser(identityMatch.id, token);
          return this.json(res, 200, { status: "active", userId: identityMatch.id, userToken: token, identityKey: identityMatch.identityKey || identityKey });
        }
        if (identityMatch.status === "pending") {
          if (dryRun) return this.json(res, 200, { status: "pending", dryRun: true });
          this.notifyAdmins("user_join_request", "user", identityMatch.username, "", { dedup: true });
          return this.json(res, 200, { status: "pending", userId: identityMatch.id, identityKey: identityMatch.identityKey || identityKey });
        }
        if (identityMatch.status === "rejected") {
          if (dryRun) return this.json(res, 200, { status: "rejected", dryRun: true });
          if (body.reapply === true) {
            this.userManager.resetToPending(identityMatch.id);
            this.notifyAdmins("user_join_request", "user", identityMatch.username, "");
            this.opts.log.info(`Hub: rejected user "${identityMatch.username}" (${identityMatch.id}) re-applied, reset to pending`);
            return this.json(res, 200, { status: "pending", userId: identityMatch.id, identityKey: identityMatch.identityKey || identityKey });
          }
          return this.json(res, 200, { status: "rejected", userId: identityMatch.id });
        }
        if (identityMatch.status === "removed" || identityMatch.status === "left") {
          if (dryRun) return this.json(res, 200, { status: "can_rejoin", dryRun: true });
          this.userManager.rejoinUser(identityMatch.id);
          this.notifyAdmins("user_join_request", "user", identityMatch.username, "", { dedup: true });
          this.opts.log.info(`Hub: ${identityMatch.status} user "${identityMatch.username}" (${identityMatch.id}) re-applied via rejoin, reset to pending`);
          return this.json(res, 200, { status: "pending", userId: identityMatch.id, identityKey: identityMatch.identityKey || identityKey });
        }
        if (identityMatch.status === "blocked") {
          return this.json(res, 200, { status: "blocked", userId: identityMatch.id });
        }
      }

      const existingUsers = this.opts.store.listHubUsers();
      const nameConflict = existingUsers.find(u => u.username === username);
      if (nameConflict) {
        this.opts.log.info(`Hub: join rejected — username "${username}" already taken by user ${nameConflict.id} (status=${nameConflict.status})`);
        return this.json(res, 409, { error: "username_taken", message: `Username "${username}" is already in use. Please choose a different nickname.` });
      }

      if (dryRun) {
        return this.json(res, 200, { status: "ok", dryRun: true });
      }

      const generatedIdentityKey = identityKey || randomUUID();
      const user = this.userManager.createPendingUser({
        username,
        deviceName: typeof body.deviceName === "string" ? body.deviceName : undefined,
        identityKey: generatedIdentityKey,
      });
      try { this.opts.store.updateHubUserActivity(user.id, joinIp); } catch { /* best-effort */ }
      this.opts.log.info(`Hub: user "${username}" (${user.id}) registered as pending, awaiting admin approval`);
      this.notifyAdmins("user_join_request", "user", username, "");
      return this.json(res, 200, { status: "pending", userId: user.id, identityKey: generatedIdentityKey });
    }

    if (req.method === "POST" && routePath === "/api/v1/hub/registration-status") {
      const body = await this.readJson(req);
      if (!body || body.teamToken !== this.teamToken) {
        return this.json(res, 403, { error: "invalid_team_token" });
      }
      const userId = String(body.userId || "");
      if (!userId) return this.json(res, 400, { error: "missing_user_id" });
      const user = this.opts.store.getHubUser(userId);
      if (!user) return this.json(res, 404, { error: "not_found" });
      if (user.status === "pending") {
        return this.json(res, 200, { status: "pending" });
      }
      if (user.status === "rejected") {
        return this.json(res, 200, { status: "rejected" });
      }
      if (user.status === "blocked") {
        return this.json(res, 200, { status: "blocked" });
      }
      if (user.status === "left") {
        return this.json(res, 200, { status: "left" });
      }
      if (user.status === "removed") {
        return this.json(res, 200, { status: "removed" });
      }
      if (user.status === "active") {
        const token = issueUserToken(
          { userId: user.id, username: user.username, role: user.role, status: user.status },
          this.authSecret,
        );
        this.userManager.approveUser(user.id, token);
        return this.json(res, 200, { status: "active", userToken: token });
      }
      return this.json(res, 200, { status: user.status });
    }

    if (req.method === "POST" && routePath === "/api/v1/hub/withdraw-pending") {
      const body = await this.readJson(req);
      if (!body || body.teamToken !== this.teamToken) {
        return this.json(res, 403, { error: "invalid_team_token" });
      }
      const userId = String(body.userId || "");
      if (!userId) return this.json(res, 400, { error: "missing_user_id" });
      const user = this.opts.store.getHubUser(userId);
      if (!user) return this.json(res, 200, { ok: true });
      if (user.status === "pending") {
        this.userManager.markUserLeft(userId);
        this.opts.log.info(`Hub: user "${user.username}" (${userId}) withdrew pending application`);
      }
      return this.json(res, 200, { ok: true });
    }

    // All endpoints below require authentication + rate limiting
    const auth = this.authenticate(req);
    if (!auth) return this.json(res, 401, { error: "unauthorized" });

    const endpointKey = routePath.replace(/^\/api\/v1\/hub\//, "").replace(/\/[^/]+\/bundle$/, "/bundle");
    if (!this.checkRateLimit(auth.userId, endpointKey)) {
      return this.json(res, 429, { error: "rate_limit_exceeded", retryAfterMs: HubServer.RATE_WINDOW_MS });
    }

    if (req.method === "POST" && routePath === "/api/v1/hub/heartbeat") {
      return this.json(res, 200, { ok: true });
    }

    if (req.method === "POST" && routePath === "/api/v1/hub/leave") {
      this.opts.store.deleteHubMemoriesByUser(auth.userId);
      this.opts.store.deleteHubTasksByUser(auth.userId);
      this.opts.store.deleteHubSkillsByUser(auth.userId);
      this.userManager.markUserLeft(auth.userId);
      this.knownOnlineUsers.delete(auth.userId);
      this.notifyAdmins("user_left", "user", auth.username, auth.userId);
      this.opts.log.info(`Hub: user "${auth.username}" (${auth.userId}) left voluntarily, resources cleaned, status set to "left"`);
      return this.json(res, 200, { ok: true });
    }

    if (req.method === "GET" && routePath === "/api/v1/hub/me") {
      const user = this.opts.store.getHubUser(auth.userId);
      if (!user) return this.json(res, 401, { error: "unauthorized" });
      return this.json(res, 200, user);
    }

    if (req.method === "POST" && routePath === "/api/v1/hub/me/update-profile") {
      const body = await this.readJson(req);
      if (!body) return this.json(res, 400, { error: "invalid_body" });
      const newUsername = String(body.username || "").trim();
      if (!newUsername || newUsername.length < 2 || newUsername.length > 32) {
        return this.json(res, 400, { error: "invalid_username", message: "Username must be 2-32 characters" });
      }
      if (this.userManager.isUsernameTaken(newUsername, auth.userId)) {
        return this.json(res, 409, { error: "username_taken", message: "Username already in use" });
      }
      const updated = this.userManager.updateUsername(auth.userId, newUsername);
      if (!updated) return this.json(res, 404, { error: "not_found" });
      const ttlMs = updated.role === "admin" ? 3650 * 24 * 60 * 60 * 1000 : undefined;
      const newToken = issueUserToken(
        { userId: updated.id, username: newUsername, role: updated.role, status: updated.status },
        this.authSecret,
        ttlMs,
      );
      this.userManager.approveUser(updated.id, newToken);
      if (updated.id === this.authState.bootstrapAdminUserId) {
        this.authState.bootstrapAdminToken = newToken;
        this.saveAuthState();
      }
      this.opts.log.info(`Hub: user "${auth.userId}" renamed to "${newUsername}"`);
      return this.json(res, 200, { ok: true, username: newUsername, userToken: newToken });
    }

    if (req.method === "GET" && routePath === "/api/v1/hub/admin/pending-users") {
      if (auth.role !== "admin") return this.json(res, 403, { error: "forbidden" });
      return this.json(res, 200, { users: this.userManager.listPendingUsers() });
    }

    if (req.method === "POST" && routePath === "/api/v1/hub/admin/approve-user") {
      if (auth.role !== "admin") return this.json(res, 403, { error: "forbidden" });
      const body = await this.readJson(req);
      const userId = String(body.userId);
      const username = String(body.username || "");
      const token = issueUserToken({ userId, username, role: "member", status: "active" }, this.authSecret);
      const approved = this.userManager.approveUser(userId, token);
      if (!approved) return this.json(res, 404, { error: "not_found" });
      try { this.opts.store.updateHubUserActivity(userId, ""); } catch { /* best-effort */ }
      try {
        this.opts.store.insertHubNotification({
          id: randomUUID(), userId, type: "membership_approved",
          resource: "user", title: `Your request to join team "${this.teamName}" has been approved. Welcome!`,
        });
      } catch { /* best-effort */ }
      return this.json(res, 200, { status: "active", token });
    }

    if (req.method === "POST" && routePath === "/api/v1/hub/admin/reject-user") {
      if (auth.role !== "admin") return this.json(res, 403, { error: "forbidden" });
      const body = await this.readJson(req);
      const userId = String(body.userId);
      const rejected = this.userManager.rejectUser(userId);
      if (!rejected) return this.json(res, 404, { error: "not_found" });
      try {
        this.opts.store.insertHubNotification({
          id: randomUUID(), userId, type: "membership_rejected",
          resource: "user", title: `Your request to join team "${this.teamName}" has been declined.`,
        });
      } catch { /* best-effort */ }
      return this.json(res, 200, { status: "rejected" });
    }

    if (req.method === "GET" && routePath === "/api/v1/hub/admin/users") {
      if (auth.role !== "admin") return this.json(res, 403, { error: "forbidden" });
      const users = this.opts.store.listHubUsers().filter(u => u.status === "active");
      const contribs = this.opts.store.getHubUserContributions();
      const ownerId = this.authState.bootstrapAdminUserId || "";
      const now = Date.now();
      return this.json(res, 200, { users: users.map(u => {
        const c = contribs[u.id] || { memoryCount: 0, taskCount: 0, skillCount: 0 };
        const isOnline = u.id === ownerId || (!!u.lastActiveAt && now - u.lastActiveAt < HubServer.OFFLINE_THRESHOLD_MS);
        return {
          id: u.id, username: u.username, role: u.role, status: u.status,
          deviceName: u.deviceName, createdAt: u.createdAt, approvedAt: u.approvedAt,
          lastIp: u.lastIp || "", lastActiveAt: u.lastActiveAt,
          isOwner: u.id === ownerId, isOnline,
          memoryCount: c.memoryCount, taskCount: c.taskCount, skillCount: c.skillCount,
        };
      }) });
    }

    if (req.method === "POST" && routePath === "/api/v1/hub/admin/change-role") {
      if (auth.role !== "admin") return this.json(res, 403, { error: "forbidden" });
      const body = await this.readJson(req);
      const userId = String(body?.userId || "");
      const newRole = String(body?.role || "");
      if (!userId || (newRole !== "admin" && newRole !== "member")) return this.json(res, 400, { error: "invalid_params" });
      if (newRole === "member" && userId === this.authState.bootstrapAdminUserId) {
        return this.json(res, 403, { error: "cannot_demote_owner", message: "The hub owner cannot be demoted" });
      }
      const user = this.opts.store.getHubUser(userId);
      if (!user || user.status !== "active") return this.json(res, 404, { error: "not_found" });
      const updatedUser = { ...user, role: newRole as "admin" | "member" };
      this.opts.store.upsertHubUser(updatedUser);
      this.opts.log.info(`Hub: admin "${auth.userId}" changed role of "${userId}" to "${newRole}"`);
      try {
        const notifType = newRole === "admin" ? "role_promoted" : "role_demoted";
        this.opts.store.insertHubNotification({
          id: randomUUID(), userId, type: notifType,
          resource: "user", title: `Your role in team "${this.teamName}" has been changed to ${newRole}.`,
        });
      } catch { /* best-effort */ }
      return this.json(res, 200, { ok: true, role: newRole });
    }

    if (req.method === "POST" && routePath === "/api/v1/hub/admin/rename-user") {
      if (auth.role !== "admin") return this.json(res, 403, { error: "forbidden" });
      const body = await this.readJson(req);
      const userId = String(body?.userId || "");
      const newUsername = String(body?.username || "").trim();
      if (!userId || !newUsername || newUsername.length < 2 || newUsername.length > 32) {
        return this.json(res, 400, { error: "invalid_params", message: "userId and username (2-32 chars) required" });
      }
      if (this.userManager.isUsernameTaken(newUsername, userId)) {
        return this.json(res, 409, { error: "username_taken", message: "Username already in use" });
      }
      const user = this.opts.store.getHubUser(userId);
      if (!user || user.status !== "active") return this.json(res, 404, { error: "not_found" });
      const ttlMs = user.role === "admin" ? 3650 * 24 * 60 * 60 * 1000 : undefined;
      const newToken = issueUserToken(
        { userId: user.id, username: newUsername, role: user.role, status: user.status },
        this.authSecret,
        ttlMs,
      );
      this.userManager.approveUser(user.id, newToken);
      const updated = this.opts.store.getHubUser(userId)!;
      const finalUser = { ...updated, username: newUsername };
      this.opts.store.upsertHubUser(finalUser);
      if (userId === this.authState.bootstrapAdminUserId) {
        this.authState.bootstrapAdminToken = newToken;
        this.saveAuthState();
      }
      try {
        this.opts.store.insertHubNotification({
          id: randomUUID(), userId, type: "username_renamed",
          resource: "user", title: `Your nickname has been changed from "${user.username}" to "${newUsername}" by the admin.`,
        });
      } catch { /* best-effort */ }
      this.opts.log.info(`Hub: admin "${auth.userId}" renamed user "${userId}" to "${newUsername}"`);
      return this.json(res, 200, { ok: true, username: newUsername });
    }

    if (req.method === "POST" && routePath === "/api/v1/hub/admin/remove-user") {
      if (auth.role !== "admin") return this.json(res, 403, { error: "forbidden" });
      const body = await this.readJson(req);
      const userId = String(body?.userId || "");
      if (!userId) return this.json(res, 400, { error: "missing_user_id" });
      if (userId === auth.userId) return this.json(res, 400, { error: "cannot_remove_self" });
      if (userId === this.authState.bootstrapAdminUserId) return this.json(res, 403, { error: "cannot_remove_owner", message: "The hub owner cannot be removed" });
      try {
        this.opts.store.insertHubNotification({
          id: randomUUID(), userId, type: "membership_removed",
          resource: "user", title: `You have been removed from team "${this.teamName}" by the admin.`,
        });
      } catch { /* best-effort */ }
      const cleanResources = body?.cleanResources === true;
      const deleted = this.opts.store.deleteHubUser(userId, cleanResources);
      if (!deleted) return this.json(res, 404, { error: "not_found" });
      this.knownOnlineUsers.delete(userId);
      this.opts.log.info(`Hub: admin "${auth.userId}" removed user "${userId}" (cleanResources=${cleanResources})`);
      return this.json(res, 200, { ok: true });
    }

    if (req.method === "POST" && routePath === "/api/v1/hub/tasks/share") {
      const body = await this.readJson(req);
      if (!body?.task) return this.json(res, 400, { error: "invalid_payload" });
      const task = { ...body.task, sourceUserId: auth.userId };
      const existingTask = task.sourceTaskId ? this.opts.store.getHubTaskBySource(auth.userId, task.sourceTaskId) : null;
      this.opts.store.upsertHubTask(task);
      const chunks = Array.isArray(body.chunks) ? body.chunks : [];
      const chunkIds: string[] = [];
      for (const chunk of chunks) {
        this.opts.store.upsertHubChunk({ ...chunk, sourceUserId: auth.userId });
        chunkIds.push(chunk.id);
      }
      if (this.opts.embedder && chunkIds.length > 0) {
        this.embedChunksAsync(chunkIds, chunks);
      }
      if (!existingTask) {
        this.notifyAdmins("resource_shared", "task", String(task.title || task.sourceTaskId || ""), auth.userId);
      }
      return this.json(res, 200, { ok: true, chunks: chunkIds.length });
    }

    if (req.method === "POST" && routePath === "/api/v1/hub/tasks/unshare") {
      const body = await this.readJson(req);
      const srcTaskId = String(body.sourceTaskId);
      const existing = this.opts.store.getHubTaskBySource(auth.userId, srcTaskId);
      this.opts.store.deleteHubTaskBySource(auth.userId, srcTaskId);
      if (existing) {
        this.notifyAdmins("resource_unshared", "task", existing.title || srcTaskId, auth.userId);
      }
      return this.json(res, 200, { ok: true });
    }

    if (req.method === "POST" && routePath === "/api/v1/hub/memories/share") {
      const body = await this.readJson(req);
      if (!body?.memory) return this.json(res, 400, { error: "invalid_payload" });
      const m = body.memory;
      const sourceChunkId = String(m.sourceChunkId || "");
      if (!sourceChunkId) return this.json(res, 400, { error: "missing_source_chunk_id" });
      const existing = this.opts.store.getHubMemoryBySource(auth.userId, sourceChunkId);
      const memoryId = existing?.id ?? randomUUID();
      const visibility = "public";
      const resolvedGroupId: string | null = null;
      const now = Date.now();
      this.opts.store.upsertHubMemory({
        id: memoryId,
        sourceChunkId,
        sourceUserId: auth.userId,
        sourceAgent: String(m.sourceAgent || ""),
        role: String(m.role || "assistant"),
        content: String(m.content || ""),
        summary: String(m.summary || ""),
        kind: String(m.kind || "paragraph"),
        groupId: resolvedGroupId,
        visibility,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      this.embedMemoryAsync(memoryId, String(m.summary || ""), String(m.content || ""));
      if (!existing) {
        this.notifyAdmins("resource_shared", "memory", String(m.summary || m.content?.slice(0, 60) || memoryId), auth.userId);
      }
      return this.json(res, 200, { ok: true, memoryId, visibility });
    }

    if (req.method === "POST" && routePath === "/api/v1/hub/memories/unshare") {
      const body = await this.readJson(req);
      const sourceChunkId = String(body?.sourceChunkId || "");
      if (!sourceChunkId) return this.json(res, 400, { error: "missing_source_chunk_id" });
      const existing = this.opts.store.getHubMemoryBySource(auth.userId, sourceChunkId);
      this.opts.store.deleteHubMemoryBySource(auth.userId, sourceChunkId);
      if (existing) {
        this.notifyAdmins("resource_unshared", "memory", existing.summary || existing.content?.slice(0, 60) || sourceChunkId, auth.userId);
      }
      return this.json(res, 200, { ok: true });
    }

    if (req.method === "GET" && routePath === "/api/v1/hub/memories") {
      const limit = Number(url.searchParams.get("limit") || 40);
      const memories = this.opts.store.listVisibleHubMemories(auth.userId, limit);
      return this.json(res, 200, { memories });
    }

    if (req.method === "GET" && routePath === "/api/v1/hub/tasks") {
      const limit = Number(url.searchParams.get("limit") || 40);
      const tasks = this.opts.store.listVisibleHubTasks(auth.userId, limit);
      return this.json(res, 200, { tasks });
    }

    if (req.method === "GET" && routePath === "/api/v1/hub/skills/list") {
      const limit = Number(url.searchParams.get("limit") || 40);
      const skills = this.opts.store.listVisibleHubSkills(auth.userId, limit);
      return this.json(res, 200, { skills });
    }

    if (req.method === "POST" && routePath === "/api/v1/hub/search") {
      const body = await this.readJson(req);
      const query = String(body.query || "");
      const maxResults = Number(body.maxResults || 10);
      const ftsHits = this.opts.store.searchHubChunks(query, { userId: auth.userId, maxResults: maxResults * 2 });
      const memFtsHits = this.opts.store.searchHubMemories(query, { userId: auth.userId, maxResults: maxResults * 2 });

      // Track which IDs are memories vs chunks
      const memoryIdSet = new Set(memFtsHits.map(({ hit }) => hit.id));
      const ftsHitIdSet = new Set<string>();
      for (const { hit } of ftsHits) ftsHitIdSet.add(hit.id);
      for (const { hit } of memFtsHits) ftsHitIdSet.add(hit.id);

      // Two-stage retrieval: FTS candidates first, then embed + cosine rerank
      let mergedIds: string[];
      /** Vector RRF channel: require min cosine similarity unless id is already an FTS hit. */
      const MIN_VECTOR_SIM = 0.45;
      if (this.opts.embedder) {
        try {
          const [queryVec] = await this.opts.embedder.embed([query]);
          if (queryVec) {
            const allEmb = this.opts.store.getVisibleHubEmbeddings(auth.userId);
            const scored: Array<{ id: string; score: number }> = [];
            const cosineSim = (a: Float32Array | number[], b: number[]) => {
              let dot = 0, nA = 0, nB = 0;
              const len = Math.min(a.length, b.length);
              for (let i = 0; i < len; i++) {
                dot += a[i] * b[i]; nA += a[i] * a[i]; nB += b[i] * b[i];
              }
              return nA > 0 && nB > 0 ? dot / (Math.sqrt(nA) * Math.sqrt(nB)) : 0;
            };
            for (const e of allEmb) scored.push({ id: e.chunkId, score: cosineSim(e.vector, queryVec) });

            const memEmb = this.opts.store.getVisibleHubMemoryEmbeddings(auth.userId);
            for (const e of memEmb) {
              scored.push({ id: e.memoryId, score: cosineSim(e.vector, queryVec) });
              memoryIdSet.add(e.memoryId);
            }

            const vecCandidates = scored.filter((s) => s.score >= MIN_VECTOR_SIM || ftsHitIdSet.has(s.id));
            vecCandidates.sort((a, b) => b.score - a.score);
            const topScored = vecCandidates.slice(0, maxResults * 2);

            const K = 60;
            const rrfScores = new Map<string, number>();
            ftsHits.forEach(({ hit }, idx) => {
              rrfScores.set(hit.id, (rrfScores.get(hit.id) ?? 0) + 1 / (K + idx + 1));
            });
            memFtsHits.forEach(({ hit }, idx) => {
              rrfScores.set(hit.id, (rrfScores.get(hit.id) ?? 0) + 1 / (K + idx + 1));
            });
            topScored.forEach(({ id }, idx) => {
              rrfScores.set(id, (rrfScores.get(id) ?? 0) + 1 / (K + idx + 1));
            });
            mergedIds = [...rrfScores.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxResults).map(([id]) => id);
          } else {
            mergedIds = [...ftsHits.map(({ hit }) => hit.id), ...memFtsHits.map(({ hit }) => hit.id)].slice(0, maxResults);
          }
        } catch {
          mergedIds = [...ftsHits.map(({ hit }) => hit.id), ...memFtsHits.map(({ hit }) => hit.id)].slice(0, maxResults);
        }
      } else {
        mergedIds = [...ftsHits.map(({ hit }) => hit.id), ...memFtsHits.map(({ hit }) => hit.id)].slice(0, maxResults);
      }

      const ftsMap = new Map(ftsHits.map(({ hit }) => [hit.id, hit]));
      const memFtsMap = new Map(memFtsHits.map(({ hit }) => [hit.id, hit]));
      const hits = mergedIds.map((id, rank) => {
        const isMemory = memoryIdSet.has(id);
        if (isMemory) {
          let mhit = memFtsMap.get(id);
          if (!mhit) {
            const visibleHit = this.opts.store.getVisibleHubSearchHitByMemoryId(id, auth.userId);
            if (!visibleHit) return null;
            mhit = visibleHit;
          }
          const remoteHitId = randomUUID();
          this.remoteHitMap.set(remoteHitId, { chunkId: id, type: "memory", expiresAt: Date.now() + 10 * 60 * 1000, requesterUserId: auth.userId });
          return {
            remoteHitId, summary: mhit.summary, excerpt: mhit.content.slice(0, 240), hubRank: rank + 1,
            taskTitle: null, ownerName: mhit.owner_name || "unknown", sourceAgent: (mhit as any).source_agent || "",
            groupName: mhit.group_name, visibility: mhit.visibility, source: { ts: mhit.created_at, role: mhit.role },
          };
        }
        let hit = ftsMap.get(id);
        if (!hit) {
          const visibleHit = this.opts.store.getVisibleHubSearchHitByChunkId(id, auth.userId);
          if (!visibleHit) return null;
          hit = visibleHit as any;
        }
        const remoteHitId = randomUUID();
        this.remoteHitMap.set(remoteHitId, { chunkId: id, type: "chunk", expiresAt: Date.now() + 10 * 60 * 1000, requesterUserId: auth.userId });
        return {
          remoteHitId, summary: hit!.summary, excerpt: hit!.content.slice(0, 240), hubRank: rank + 1,
          taskTitle: hit!.task_title, ownerName: hit!.owner_name || "unknown", sourceAgent: "",
          groupName: hit!.group_name, visibility: hit!.visibility, source: { ts: hit!.created_at, role: hit!.role },
        };
      }).filter(Boolean);
      return this.json(res, 200, { hits, meta: { totalCandidates: hits.length, searchedGroups: [], includedPublic: true } });
    }

    if (req.method === "GET" && routePath === "/api/v1/hub/skills") {
      const skillQuery = String(url.searchParams.get("query") || "");
      const skillMaxResults = Number(url.searchParams.get("maxResults") || 10);
      const ftsSkillHits = this.opts.store.searchHubSkills(skillQuery, {
        userId: auth.userId,
        maxResults: skillMaxResults * 2,
      });

      let mergedSkillIds: string[];
      if (this.opts.embedder && skillQuery) {
        try {
          const [queryVec] = await this.opts.embedder.embed([skillQuery]);
          if (queryVec) {
            const skillEmbs = this.opts.store.getVisibleHubSkillEmbeddings();
            const cosineSim = (vec: Float32Array) => {
              let dot = 0, nA = 0, nB = 0;
              for (let i = 0; i < queryVec.length && i < vec.length; i++) {
                dot += queryVec[i] * vec[i]; nA += queryVec[i] * queryVec[i]; nB += vec[i] * vec[i];
              }
              return nA > 0 && nB > 0 ? dot / (Math.sqrt(nA) * Math.sqrt(nB)) : 0;
            };
            const vecScored = skillEmbs
              .map(e => ({ id: e.skillId, score: cosineSim(e.vector) }))
              .filter(e => e.score > 0.3)
              .sort((a, b) => b.score - a.score)
              .slice(0, skillMaxResults * 2);

            const K = 60;
            const rrfScores = new Map<string, number>();
            ftsSkillHits.forEach(({ hit }, idx) => {
              rrfScores.set(hit.id, (rrfScores.get(hit.id) ?? 0) + 1 / (K + idx + 1));
            });
            vecScored.forEach(({ id }, idx) => {
              rrfScores.set(id, (rrfScores.get(id) ?? 0) + 1 / (K + idx + 1));
            });
            mergedSkillIds = [...rrfScores.entries()].sort((a, b) => b[1] - a[1]).slice(0, skillMaxResults).map(([id]) => id);
          } else {
            mergedSkillIds = ftsSkillHits.slice(0, skillMaxResults).map(({ hit }) => hit.id);
          }
        } catch {
          mergedSkillIds = ftsSkillHits.slice(0, skillMaxResults).map(({ hit }) => hit.id);
        }
      } else {
        mergedSkillIds = ftsSkillHits.slice(0, skillMaxResults).map(({ hit }) => hit.id);
      }

      const ftsSkillMap = new Map(ftsSkillHits.map(({ hit }) => [hit.id, hit]));
      const hits = mergedSkillIds.map(id => {
        const hit = ftsSkillMap.get(id);
        if (hit) {
          return {
            skillId: hit.id, name: hit.name, description: hit.description,
            version: hit.version, visibility: hit.visibility, groupName: hit.group_name,
            ownerName: hit.owner_name || "unknown", ownerStatus: hit.owner_status || "",
            qualityScore: hit.quality_score,
          };
        }
        const skill = this.opts.store.getHubSkillById(id);
        if (!skill) return null;
        return {
          skillId: skill.id, name: skill.name, description: skill.description,
          version: skill.version, visibility: skill.visibility, groupName: "",
          ownerName: "unknown", ownerStatus: "", qualityScore: skill.qualityScore,
        };
      }).filter(Boolean);
      return this.json(res, 200, { hits });
    }

    if (req.method === "POST" && routePath === "/api/v1/hub/skills/publish") {
      const body = await this.readJson(req);
      const metadata = body?.metadata ?? {};
      const sourceSkillId = String(metadata.id || "");
      if (!sourceSkillId) return this.json(res, 400, { error: "missing_skill_id" });
      const existing = this.opts.store.getHubSkillBySource(auth.userId, sourceSkillId);
      const skillId = existing?.id ?? randomUUID();
      const visibility = "public";
      this.opts.store.upsertHubSkill({
        id: skillId,
        sourceSkillId,
        sourceUserId: auth.userId,
        name: String(metadata.name || sourceSkillId),
        description: String(metadata.description || ""),
        version: Number(metadata.version || 1),
        groupId: null,
        visibility,
        bundle: JSON.stringify(body?.bundle ?? {}),
        qualityScore: metadata.qualityScore == null ? null : Number(metadata.qualityScore),
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      });
      this.embedSkillAsync(skillId, String(metadata.name || sourceSkillId), String(metadata.description || ""), auth.userId, sourceSkillId);
      if (!existing) {
        this.notifyAdmins("resource_shared", "skill", String(metadata.name || sourceSkillId), auth.userId);
      }
      return this.json(res, 200, { ok: true, skillId, visibility });
    }

    const skillBundleMatch = req.method === "GET" ? routePath.match(/^\/api\/v1\/hub\/skills\/([^/]+)\/bundle$/) : null;
    if (skillBundleMatch) {
      const skill = this.opts.store.getHubSkillById(decodeURIComponent(skillBundleMatch[1]));
      if (!skill) return this.json(res, 404, { error: "not_found" });
      return this.json(res, 200, {
        skillId: skill.id,
        metadata: {
          id: skill.sourceSkillId,
          name: skill.name,
          description: skill.description,
          version: skill.version,
          qualityScore: skill.qualityScore,
        },
        bundle: JSON.parse(skill.bundle),
      });
    }

    if (req.method === "POST" && routePath === "/api/v1/hub/skills/unpublish") {
      const body = await this.readJson(req);
      const srcSkillId = String(body?.sourceSkillId || "");
      const existing = this.opts.store.getHubSkillBySource(auth.userId, srcSkillId);
      this.opts.store.deleteHubSkillBySource(auth.userId, srcSkillId);
      if (existing) {
        this.notifyAdmins("resource_unshared", "skill", existing.name || srcSkillId, auth.userId);
      }
      return this.json(res, 200, { ok: true });
    }

    // ── Admin: shared tasks & skills management ──

    if (req.method === "GET" && routePath === "/api/v1/hub/admin/shared-tasks") {
      if (auth.role !== "admin") return this.json(res, 403, { error: "forbidden" });
      const tasks = this.opts.store.listAllHubTasks();
      return this.json(res, 200, { tasks });
    }

    const hubTaskDetailMatch = req.method === "GET" ? routePath.match(/^\/api\/v1\/hub\/shared-tasks\/([^/]+)\/detail$/) : null;
    if (hubTaskDetailMatch) {
      const taskId = decodeURIComponent(hubTaskDetailMatch[1]);
      const task = this.opts.store.getHubTaskById(taskId);
      if (!task) return this.json(res, 404, { error: "not_found" });
      const chunks = this.opts.store.listHubChunksByTaskId(taskId);
      return this.json(res, 200, {
        id: task.id, title: task.title, summary: task.summary,
        startedAt: task.createdAt, endedAt: task.updatedAt,
        chunks: chunks.map(c => ({ role: c.role, content: c.content, summary: c.summary, kind: c.kind, createdAt: c.createdAt })),
      });
    }

    const hubSkillDetailMatch = req.method === "GET" ? routePath.match(/^\/api\/v1\/hub\/shared-skills\/([^/]+)\/detail$/) : null;
    if (hubSkillDetailMatch) {
      const skillId = decodeURIComponent(hubSkillDetailMatch[1]);
      const skill = this.opts.store.getHubSkillById(skillId);
      if (!skill) return this.json(res, 404, { error: "not_found" });
      let files: Array<{ path: string; type: string; size: number }> = [];
      try {
        const bundle = JSON.parse(skill.bundle || "{}");
        if (Array.isArray(bundle.files)) {
          files = bundle.files.map((f: any) => ({ path: f.path ?? f.name ?? "unknown", type: f.type ?? "file", size: f.size ?? (f.content ? f.content.length : 0) }));
        }
      } catch { /* ignore parse error */ }
      return this.json(res, 200, {
        skill: { id: skill.id, name: skill.name, description: skill.description, version: skill.version, qualityScore: skill.qualityScore, status: "published" },
        files,
        versions: [],
      });
    }

    const adminTaskDeleteMatch = req.method === "DELETE" ? routePath.match(/^\/api\/v1\/hub\/admin\/shared-tasks\/([^/]+)$/) : null;
    if (adminTaskDeleteMatch) {
      if (auth.role !== "admin") return this.json(res, 403, { error: "forbidden" });
      const taskId = decodeURIComponent(adminTaskDeleteMatch[1]);
      const taskInfo = this.opts.store.getHubTaskById(taskId);
      const deleted = this.opts.store.deleteHubTaskById(taskId);
      if (!deleted) return this.json(res, 404, { error: "not_found" });
      if (taskInfo) {
        this.opts.store.insertHubNotification({ id: randomUUID(), userId: taskInfo.sourceUserId, type: "resource_removed", resource: "task", title: taskInfo.title });
      }
      return this.json(res, 200, { ok: true });
    }

    if (req.method === "GET" && routePath === "/api/v1/hub/admin/shared-skills") {
      if (auth.role !== "admin") return this.json(res, 403, { error: "forbidden" });
      const skills = this.opts.store.listAllHubSkills();
      return this.json(res, 200, { skills });
    }

    const adminSkillDeleteMatch = req.method === "DELETE" ? routePath.match(/^\/api\/v1\/hub\/admin\/shared-skills\/([^/]+)$/) : null;
    if (adminSkillDeleteMatch) {
      if (auth.role !== "admin") return this.json(res, 403, { error: "forbidden" });
      const skillId = decodeURIComponent(adminSkillDeleteMatch[1]);
      const skillInfo = this.opts.store.getHubSkillById(skillId);
      const deleted = this.opts.store.deleteHubSkillById(skillId);
      if (!deleted) return this.json(res, 404, { error: "not_found" });
      if (skillInfo) {
        this.opts.store.insertHubNotification({ id: randomUUID(), userId: skillInfo.sourceUserId, type: "resource_removed", resource: "skill", title: skillInfo.name });
      }
      return this.json(res, 200, { ok: true });
    }

    if (req.method === "GET" && routePath === "/api/v1/hub/admin/shared-memories") {
      if (auth.role !== "admin") return this.json(res, 403, { error: "forbidden" });
      const memories = this.opts.store.listAllHubMemories();
      return this.json(res, 200, { memories });
    }

    const adminMemoryDeleteMatch = req.method === "DELETE" ? routePath.match(/^\/api\/v1\/hub\/admin\/shared-memories\/([^/]+)$/) : null;
    if (adminMemoryDeleteMatch) {
      if (auth.role !== "admin") return this.json(res, 403, { error: "forbidden" });
      const memoryId = decodeURIComponent(adminMemoryDeleteMatch[1]);
      const memInfo = this.opts.store.getHubMemoryById(memoryId);
      const deleted = this.opts.store.deleteHubMemoryById(memoryId);
      if (!deleted) return this.json(res, 404, { error: "not_found" });
      if (memInfo) {
        const payload = JSON.stringify({
          memoryId,
          sourceChunkId: memInfo.sourceChunkId,
        });
        this.opts.store.insertHubNotification({
          id: randomUUID(),
          userId: memInfo.sourceUserId,
          type: "resource_removed",
          resource: "memory",
          title: memInfo.summary || memInfo.id,
          message: payload,
        });
      }
      return this.json(res, 200, { ok: true });
    }

    if (req.method === "POST" && routePath === "/api/v1/hub/memory-detail") {
      const body = await this.readJson(req);
      const hit = this.remoteHitMap.get(String(body.remoteHitId));
      if (!hit || hit.expiresAt < Date.now()) return this.json(res, 404, { error: "not_found" });
      if (hit.requesterUserId !== auth.userId) return this.json(res, 403, { error: "forbidden" });
      if (hit.type === "memory") {
        const mem = this.opts.store.getHubMemoryById(hit.chunkId);
        if (!mem) return this.json(res, 404, { error: "not_found" });
        return this.json(res, 200, { content: mem.content, summary: mem.summary, source: { ts: mem.createdAt, role: mem.role } });
      }
      const chunk = this.opts.store.getHubChunkById(hit.chunkId);
      if (!chunk) return this.json(res, 404, { error: "not_found" });
      return this.json(res, 200, {
        content: chunk.content,
        summary: chunk.summary,
        source: { ts: chunk.createdAt, role: chunk.role },
      });
    }

    if (req.method === "GET" && routePath === "/api/v1/hub/notifications") {
      const unread = (new URL(req.url!, `http://${req.headers.host}`)).searchParams.get("unread") === "1";
      const list = this.opts.store.listHubNotifications(auth.userId, { unreadOnly: unread, limit: 50 });
      const unreadCount = this.opts.store.countUnreadHubNotifications(auth.userId);
      return this.json(res, 200, { notifications: list, unreadCount });
    }

    if (req.method === "POST" && routePath === "/api/v1/hub/notifications/read") {
      const body = await this.readJson(req);
      const ids = Array.isArray(body.ids) ? body.ids as string[] : undefined;
      this.opts.store.markHubNotificationsRead(auth.userId, ids);
      return this.json(res, 200, { ok: true });
    }

    if (req.method === "POST" && routePath === "/api/v1/hub/notifications/clear") {
      this.opts.store.clearHubNotifications(auth.userId);
      return this.json(res, 200, { ok: true });
    }

    return this.json(res, 404, { error: "not_found" });
  }

  private notifyAdmins(type: string, resource: string, title: string, fromUserId: string, opts?: { dedup?: boolean; deduoWindowMs?: number }): void {
    try {
      const admins = this.opts.store.listHubUsers("active").filter(u => u.role === "admin" && u.id !== fromUserId);
      for (const admin of admins) {
        if (opts?.dedup && this.opts.store.hasRecentHubNotification(admin.id, type, resource, opts.deduoWindowMs ?? 300_000)) {
          continue;
        }
        this.opts.store.insertHubNotification({ id: randomUUID(), userId: admin.id, type, resource, title });
      }
    } catch { /* best-effort */ }
  }

  private initOnlineTracking(): void {
    try {
      const ownerId = this.authState.bootstrapAdminUserId || "";
      const users = this.opts.store.listHubUsers("active");
      const now = Date.now();
      for (const u of users) {
        if (u.id === ownerId) continue;
        if (u.lastActiveAt && now - u.lastActiveAt < HubServer.OFFLINE_THRESHOLD_MS) {
          this.knownOnlineUsers.add(u.id);
        }
      }
    } catch { /* best-effort */ }
  }

  private checkOfflineUsers(): void {
    try {
      const ownerId = this.authState.bootstrapAdminUserId || "";
      const users = this.opts.store.listHubUsers("active");
      const now = Date.now();
      const currentlyOnline = new Set<string>();
      for (const u of users) {
        if (u.id === ownerId) continue;
        if (u.lastActiveAt && now - u.lastActiveAt < HubServer.OFFLINE_THRESHOLD_MS) {
          currentlyOnline.add(u.id);
        }
      }
      for (const uid of this.knownOnlineUsers) {
        if (!currentlyOnline.has(uid)) {
          const user = users.find(u => u.id === uid);
          if (user) {
            this.notifyAdmins("user_offline", "user", user.username, uid);
            this.opts.log.info(`Hub: user "${user.username}" (${uid}) went offline`);
          }
        }
      }
      for (const uid of currentlyOnline) {
        if (!this.knownOnlineUsers.has(uid)) {
          const user = users.find(u => u.id === uid);
          if (user) {
            this.notifyAdmins("user_online", "user", user.username, uid);
          }
        }
      }
      this.knownOnlineUsers = currentlyOnline;
    } catch { /* best-effort */ }
  }

  private authenticate(req: http.IncomingMessage) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) return null;
    const token = header.slice("Bearer ".length);
    const payload = verifyUserToken(token, this.authSecret);
    if (!payload) return null;
    const user = this.opts.store.getHubUser(payload.userId);
    if (!user || user.status !== "active") return null;
    const hash = createHash("sha256").update(token).digest("hex");
    if (user.tokenHash !== hash) return null;
    const clientIp = (req.headers["x-client-ip"] as string)?.trim()
      || (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
      || req.socket.remoteAddress || "";
    try { this.opts.store.updateHubUserActivity(user.id, clientIp); } catch { /* best-effort */ }
    return {
      userId: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
    };
  }

  private static readonly MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

  private async readJson(req: http.IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > HubServer.MAX_BODY_BYTES) {
        req.destroy();
        throw Object.assign(new Error("request body too large"), { statusCode: 413 });
      }
      chunks.push(buf);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? JSON.parse(raw) : {};
  }

  private json(res: http.ServerResponse, statusCode: number, body: unknown): void {
    res.statusCode = statusCode;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  }
}
