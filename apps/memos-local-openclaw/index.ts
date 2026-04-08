/**
 * OpenClaw Plugin Entry — memos-local
 *
 * Full-write local memory with hybrid retrieval (RRF + MMR + recency).
 * Provides: memory_search, memory_get, memory_timeline, task_summary, skill_get, skill_install, memory_viewer
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import * as fs from "fs";
import * as path from "path";
import { createRequire } from "node:module";
import { fileURLToPath } from "url";
import { buildContext } from "./src/config";
import type { HostModelsConfig } from "./src/openclaw-api";
import { ensureSqliteBinding } from "./src/storage/ensure-binding";
import { SqliteStore } from "./src/storage/sqlite";
import { Embedder } from "./src/embedding";
import { IngestWorker } from "./src/ingest/worker";
import { RecallEngine } from "./src/recall/engine";
import { captureMessages, stripInboundMetadata } from "./src/capture";
import { DEFAULTS } from "./src/types";
import type { SearchHit } from "./src/types";
import { ViewerServer } from "./src/viewer/server";
import { HubServer } from "./src/hub/server";
import { hubGetMemoryDetail, hubRequestJson, hubSearchMemories, hubSearchSkills, resolveHubClient } from "./src/client/hub";
import { getHubStatus, connectToHub } from "./src/client/connector";
import { fetchHubSkillBundle, publishSkillBundleToHub, restoreSkillBundleFromHub, unpublishSkillBundleFromHub } from "./src/client/skill-sync";
import { SkillEvolver } from "./src/skill/evolver";
import { SkillInstaller } from "./src/skill/installer";
import { Summarizer } from "./src/ingest/providers";
import { MEMORY_GUIDE_SKILL_MD } from "./src/skill/bundled-memory-guide";
import { Telemetry } from "./src/telemetry";


/** Remove near-duplicate hits based on summary word overlap (>70%). Keeps first (highest-scored) hit. */
function deduplicateHits<T extends { summary: string }>(hits: T[]): T[] {
  const kept: T[] = [];
  for (const hit of hits) {
    const dominated = kept.some((k) => {
      const a = k.summary.toLowerCase();
      const b = hit.summary.toLowerCase();
      if (a === b) return true;
      const wordsA = new Set(a.split(/\s+/).filter(w => w.length > 1));
      const wordsB = new Set(b.split(/\s+/).filter(w => w.length > 1));
      if (wordsA.size === 0 || wordsB.size === 0) return false;
      let overlap = 0;
      for (const w of wordsB) { if (wordsA.has(w)) overlap++; }
      return overlap / Math.min(wordsA.size, wordsB.size) > 0.7;
    });
    if (!dominated) kept.push(hit);
  }
  return kept;
}

const NEW_SESSION_PROMPT_RE = /A new session was started via \/new or \/reset\./i;
const INTERNAL_CONTEXT_RE = /OpenClaw runtime context \(internal\):[\s\S]*/i;
const CONTINUE_PROMPT_RE = /^Continue where you left off\.[\s\S]*/i;

const buildMemoryPromptSection = ({ availableTools, citationsMode }: {
  availableTools: Set<string>;
  citationsMode?: string;
}) => {
  const lines: string[] = [];
  const hasMemorySearch = availableTools.has("memory_search");
  const hasMemoryGet = availableTools.has("memory_get");

  if (!hasMemorySearch && !hasMemoryGet) {
    return lines;
  }

  lines.push("## Memory Recall");
  lines.push(
    "This workspace uses MemOS Local as the active memory slot. Prefer recalled memories and the memory tools before claiming prior context is unavailable.",
  );

  if (hasMemorySearch && hasMemoryGet) {
    lines.push(
      "Use `memory_search` to locate relevant memories, then `memory_get` or `memory_timeline` when you need the full source text or surrounding context.",
    );
  } else if (hasMemorySearch) {
    lines.push("Use `memory_search` before answering questions about prior conversations, preferences, plans, or decisions.");
  } else {
    lines.push("Use `memory_get` or `memory_timeline` to inspect the referenced memory before answering.");
  }

  if (citationsMode === "off") {
    lines.push("Citations are disabled, so avoid mentioning internal memory ids unless the user asks.");
  } else {
    lines.push("When it helps the user verify a memory-backed claim, mention the relevant memory identifier or tool result.");
  }

  lines.push("");
  return lines;
};

function normalizeAutoRecallQuery(rawPrompt: string): string {
  let query = rawPrompt.trim();

  const senderTag = "Sender (untrusted metadata):";
  const senderPos = query.indexOf(senderTag);
  if (senderPos !== -1) {
    const afterSender = query.slice(senderPos);
    const fenceStart = afterSender.indexOf("```json");
    const fenceEnd = fenceStart >= 0 ? afterSender.indexOf("```\n", fenceStart + 7) : -1;
    if (fenceEnd > 0) {
      query = afterSender.slice(fenceEnd + 4).replace(/^\s*\n/, "").trim();
    } else {
      const firstDblNl = afterSender.indexOf("\n\n");
      if (firstDblNl > 0) {
        query = afterSender.slice(firstDblNl + 2).trim();
      }
    }
  }

  query = stripInboundMetadata(query);
  query = query.replace(/<[^>]+>/g, "").trim();

  if (NEW_SESSION_PROMPT_RE.test(query)) {
    query = query.replace(NEW_SESSION_PROMPT_RE, "").trim();
    query = query.replace(/^(Execute|Run) your Session Startup sequence[^\n]*\n?/im, "").trim();
    query = query.replace(/^Current time:[^\n]*(\n|$)/im, "").trim();
  }

  query = query.replace(INTERNAL_CONTEXT_RE, "").trim();
  query = query.replace(CONTINUE_PROMPT_RE, "").trim();

  return query;
}


const pluginConfigSchema = {
  type: "object" as const,
  additionalProperties: true,
  properties: {
    viewerPort: {
      type: "number" as const,
      description: "Memory Viewer HTTP port (default 18799)",
    },
    telemetry: {
      type: "object" as const,
      description: "Anonymous usage analytics (opt-out). No memory content or personal data is ever sent.",
      properties: {
        enabled: {
          type: "boolean" as const,
          description: "Enable anonymous telemetry (default: true). Set to false to opt-out.",
        },
      },
    },
  },
};

const memosLocalPlugin = {
  id: "memos-local-openclaw-plugin",
  name: "MemOS Local Memory",
  description:
    "Full-write local conversation memory with hybrid search (RRF + MMR + recency). " +
    "Provides memory_search, memory_get, task_summary, memory_timeline, memory_viewer for layered retrieval.",
  kind: "memory" as const,
  configSchema: pluginConfigSchema,

  register(api: OpenClawPluginApi) {
    api.registerMemoryCapability({
      promptBuilder: buildMemoryPromptSection,
    });

    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const localRequire = createRequire(import.meta.url);
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

    function detectPluginDir(startDir: string): string {
      let cur = startDir;
      for (let i = 0; i < 6; i++) {
        const pkg = path.join(cur, "package.json");
        if (fs.existsSync(pkg)) return cur;
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
      }
      return startDir;
    }

    const pluginDir = detectPluginDir(moduleDir);

    function normalizeFsPath(p: string): string {
      return path.resolve(p).replace(/^\\\\\?\\/, "").toLowerCase();
    }

    function isPathInside(baseDir: string, targetPath: string): boolean {
      const baseNorm = normalizeFsPath(baseDir);
      const targetNorm = normalizeFsPath(targetPath);
      const rel = path.relative(baseNorm, targetNorm);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    }

    function runNpm(args: string[]) {
      const { spawnSync } = localRequire("child_process") as typeof import("node:child_process");
      return spawnSync(npmCmd, args, {
        cwd: pluginDir,
        stdio: "pipe",
        shell: false,
        timeout: 120_000,
      });
    }

    let sqliteReady = false;

    function trySqliteLoad(): boolean {
      try {
        const resolved = localRequire.resolve("better-sqlite3", { paths: [pluginDir] });
        const resolvedReal = fs.existsSync(resolved) ? fs.realpathSync.native(resolved) : resolved;
        if (!isPathInside(pluginDir, resolvedReal)) {
          api.logger.warn(`memos-local: better-sqlite3 resolved outside plugin dir: ${resolved}`);
          return false;
        }
        localRequire(resolvedReal);
        return true;
      } catch {
        return false;
      }
    }

    sqliteReady = trySqliteLoad();

    if (!sqliteReady) {
      api.logger.warn(`memos-local: better-sqlite3 not found in ${pluginDir}, attempting auto-rebuild ...`);

      try {
        const rebuildResult = runNpm(["rebuild", "better-sqlite3"]);

        const stdout = rebuildResult.stdout?.toString() || "";
        const stderr = rebuildResult.stderr?.toString() || "";
        if (stdout) api.logger.info(`memos-local: rebuild stdout: ${stdout.slice(0, 500)}`);
        if (stderr) api.logger.warn(`memos-local: rebuild stderr: ${stderr.slice(0, 500)}`);

        if (rebuildResult.status === 0) {
          Object.keys(localRequire.cache)
            .filter(k => k.includes("better-sqlite3") || k.includes("better_sqlite3"))
            .forEach(k => delete localRequire.cache[k]);
          sqliteReady = trySqliteLoad();
          if (sqliteReady) {
            api.logger.info("memos-local: better-sqlite3 auto-rebuild succeeded!");
          } else {
            api.logger.warn("memos-local: rebuild exited 0 but module still not loadable from plugin dir");
          }
        } else {
          api.logger.warn(`memos-local: rebuild exited with code ${rebuildResult.status}`);
        }
      } catch (rebuildErr) {
        api.logger.warn(`memos-local: auto-rebuild error: ${rebuildErr}`);
      }

      if (!sqliteReady) {
        const nodeVer = process.version;
        const nodeMajor = parseInt(process.versions?.node?.split(".")[0] ?? "0", 10);
        const isNode25Plus = nodeMajor >= 25;
        const lines = [
          "",
          "╔══════════════════════════════════════════════════════════════╗",
          "║  MemOS Local Memory — better-sqlite3 native module missing  ║",
          "╠══════════════════════════════════════════════════════════════╣",
          "║                                                            ║",
          "║  Auto-rebuild failed (Node " + nodeVer + "). Run manually:              ║",
          "║                                                            ║",
          `║  cd ${pluginDir}`,
          "║  npm rebuild better-sqlite3                                ║",
          "║  openclaw gateway stop && openclaw gateway start           ║",
          "║                                                            ║",
          "║  If rebuild fails, install build tools first:              ║",
          "║  macOS:  xcode-select --install                            ║",
          "║  Linux:  sudo apt install build-essential python3          ║",
        ];
        if (isNode25Plus) {
          lines.push("║                                                            ║");
          lines.push("║  Node 25+ has no prebuild: build tools required, or use    ║");
          lines.push("║  Node LTS (20/22): nvm install 22 && nvm use 22            ║");
        }
        lines.push("║                                                            ║");
        lines.push("╚══════════════════════════════════════════════════════════════╝");
        lines.push("");
        api.logger.warn(lines.join("\n"));
        throw new Error(
          `better-sqlite3 native module not found (Node ${nodeVer}). Auto-rebuild failed. Fix: install build tools, then cd ${pluginDir} && npm rebuild better-sqlite3. Or use Node LTS (20/22).`
        );
      }
    }

    let pluginCfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
    const stateDir = process.env.OPENCLAW_STATE_DIR || api.resolvePath("~/.openclaw");

    // Fallback: read config from file if not provided by OpenClaw
    const configPath = path.join(stateDir, "state", "memos-local", "config.json");
    if (Object.keys(pluginCfg).length === 0 && fs.existsSync(configPath)) {
      try {
        const fileConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        pluginCfg = fileConfig;
        api.logger.info(`memos-local: loaded config from ${configPath}`);
      } catch (e) {
        api.logger.warn(`memos-local: failed to load config from ${configPath}: ${e}`);
      }
    }

    // Extract host model providers so OpenClawAPIClient can proxy completion/embedding
    const hostModels: HostModelsConfig | undefined = api.config?.models?.providers
      ? { providers: api.config.models.providers as Record<string, import("./src/openclaw-api").HostModelProvider> }
      : undefined;

    const ctx = buildContext(stateDir, process.cwd(), pluginCfg as any, {
      debug: (msg: string) => api.logger.info(`[debug] ${msg}`),
      info: (msg: string) => api.logger.info(msg),
      warn: (msg: string) => api.logger.warn(msg),
      error: (msg: string) => api.logger.warn(`[error] ${msg}`),
    }, hostModels);

    ensureSqliteBinding(ctx.log);

    const store = new SqliteStore(ctx.config.storage!.dbPath!, ctx.log);
    const embedder = new Embedder(ctx.config.embedding, ctx.log, ctx.openclawAPI);
    const worker = new IngestWorker(store, embedder, ctx);
    const engine = new RecallEngine(store, embedder, ctx);
    const evidenceTag = ctx.config.capture?.evidenceWrapperTag ?? DEFAULTS.evidenceWrapperTag;

    const workspaceDir = api.resolvePath("~/.openclaw/workspace");
    const skillCtx = { ...ctx, workspaceDir };
    const skillEvolver = new SkillEvolver(store, engine, skillCtx);
    skillEvolver.onSkillEvolved = (name, type) => telemetry.trackSkillEvolved(name, type);
    const skillInstaller = new SkillInstaller(store, skillCtx);

    let pluginVersion = "0.0.0";
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf-8"));
      pluginVersion = pkg.version ?? pluginVersion;
    } catch {}
    const telemetry = new Telemetry(ctx.config.telemetry ?? {}, stateDir, pluginVersion, ctx.log, pluginDir);

    // Install bundled memory-guide skill so OpenClaw loads it (write from embedded content so it works regardless of deploy layout)
    const workspaceSkillsDir = path.join(workspaceDir, "skills");
    const memosGuideDest = path.join(workspaceSkillsDir, "memos-memory-guide");
    fs.mkdirSync(memosGuideDest, { recursive: true });
    fs.writeFileSync(path.join(memosGuideDest, "SKILL.md"), MEMORY_GUIDE_SKILL_MD, "utf-8");
    ctx.log.info(`memos-local: installed bundled skill memos-memory-guide → ${memosGuideDest}`);

    // Also ensure managed skills dir has it so dashboard/other loaders can see it
    const managedSkillsDir = path.join(stateDir, "skills");
    const managedMemosGuide = path.join(managedSkillsDir, "memos-memory-guide");
    try {
      fs.mkdirSync(managedMemosGuide, { recursive: true });
      fs.writeFileSync(path.join(managedMemosGuide, "SKILL.md"), MEMORY_GUIDE_SKILL_MD, "utf-8");
      ctx.log.info(`memos-local: installed bundled skill memos-memory-guide → ${managedMemosGuide} (managed)`);
    } catch (e) {
      ctx.log.warn(`memos-local: could not write to managed skills dir: ${e}`);
    }

    // Ensure plugin tools are enabled in openclaw.json tools.allow
    try {
      const openclawJsonPath = path.join(stateDir, "openclaw.json");
      if (fs.existsSync(openclawJsonPath)) {
        const raw = fs.readFileSync(openclawJsonPath, "utf-8");
        const cfg = JSON.parse(raw);
        const allow: string[] | undefined = cfg?.tools?.allow;
        if (Array.isArray(allow) && allow.length > 0 && !allow.includes("group:plugins") && !allow.includes("*")) {
          const lastEntry = JSON.stringify(allow[allow.length - 1]);
          const patched = raw.replace(
            new RegExp(`(${lastEntry})(\\s*\\])`),
            `$1,\n      "group:plugins"$2`,
          );
          if (patched !== raw && patched.includes("group:plugins")) {
            fs.writeFileSync(openclawJsonPath, patched, "utf-8");
            ctx.log.info("memos-local: added 'group:plugins' to tools.allow in openclaw.json");
          }
        }
      }
    } catch (e) {
      ctx.log.warn(`memos-local: could not patch tools.allow: ${e}`);
    }

    worker.getTaskProcessor().onTaskCompleted((task) => {
      skillEvolver.onTaskCompleted(task).catch((err) => {
        ctx.log.warn(`SkillEvolver async error: ${err}`);
      });
    });

    const summarizer = new Summarizer(ctx.config.summarizer, ctx.log, ctx.openclawAPI);

    api.logger.info(`memos-local: initialized (db: ${ctx.config.storage!.dbPath})`);

    // Current agent ID — updated by hooks, read by tools for owner isolation.
    // Falls back to "main" when no hook has fired yet (single-agent setups).
    let currentAgentId = "main";
    const getCurrentOwner = () => `agent:${currentAgentId}`;

    // ─── Check allowPromptInjection policy ───
    // When allowPromptInjection=false, the prompt mutation fields (such as prependContext) in the hook return value
    // will be stripped by the framework. Skip auto-recall to avoid unnecessary LLM/embedding calls.
    const pluginEntry = (api.config as any)?.plugins?.entries?.[api.id];
    const allowPromptInjection = pluginEntry?.hooks?.allowPromptInjection !== false;
    if (!allowPromptInjection) {
      api.logger.info("memos-local: allowPromptInjection=false, auto-recall disabled");
    }
    else {
      api.logger.info("memos-local: allowPromptInjection=true, auto-recall enabled");
    }

    const trackTool = (toolName: string, fn: (...args: any[]) => Promise<any>) =>
      async (...args: any[]) => {
        const t0 = performance.now();
        let ok = true;
        let result: any;
        const inputParams = args.length > 1 ? args[1] : args[0];
        try {
          result = await fn(...args);
          return result;
        } catch (e) {
          ok = false;
          telemetry.trackError(toolName, (e as Error)?.name ?? "unknown");
          throw e;
        } finally {
          const dur = performance.now() - t0;
          store.recordToolCall(toolName, dur, ok);
          telemetry.trackToolCalled(toolName, dur, ok);
          try {
            let outputText: string;
            const det = result?.details;
            if (det && (Array.isArray(det.candidates) || Array.isArray(det.filtered))) {
              outputText = JSON.stringify({
                candidates: det.candidates ?? [],
                hubCandidates: det.hubCandidates ?? [],
                filtered: det.filtered ?? det.hits ?? [],
              });
            } else {
              outputText = result?.content?.[0]?.text ?? JSON.stringify(result ?? "");
            }
            store.recordApiLog(toolName, { ...inputParams, type: "tool_call" }, outputText, dur, ok);
          } catch (_) { /* best-effort */ }
        }
      };

    const resolveMemorySearchScope = (scope?: string): "local" | "group" | "all" =>
      scope === "group" || scope === "all" ? scope : "local";
    const resolveMemoryShareTarget = (target?: string): "agents" | "hub" | "both" =>
      target === "hub" || target === "both" ? target : "agents";
    const resolveMemoryUnshareTarget = (target?: string): "agents" | "hub" | "all" =>
      target === "agents" || target === "hub" ? target : "all";
    const resolveSkillPublishTarget = (target?: string, scope?: string): "agents" | "hub" => {
      if (target === "hub") return "hub";
      if (target === "agents") return "agents";
      return scope === "public" || scope === "group" ? "hub" : "agents";
    };
    const resolveSkillHubVisibility = (visibility?: string, scope?: string): "public" | "group" =>
      visibility === "group" || scope === "group" ? "group" : "public";
    const resolveSkillUnpublishTarget = (target?: string): "agents" | "hub" | "all" =>
      target === "hub" || target === "all" ? target : "agents";

    const shareMemoryToHub = async (
      chunkId: string,
      input?: { visibility?: "public" | "group"; groupId?: string; hubAddress?: string; userToken?: string },
    ): Promise<{ memoryId: string; visibility: "public" | "group"; groupId: string | null }> => {
      const chunk = store.getChunk(chunkId);
      if (!chunk) {
        throw new Error(`Memory not found: ${chunkId}`);
      }

      const visibility = input?.visibility === "group" ? "group" : "public";
      const groupId = visibility === "group" ? (input?.groupId ?? null) : null;
      const hubClient = await resolveHubClient(store, ctx, { hubAddress: input?.hubAddress, userToken: input?.userToken });
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
            groupId,
            visibility,
          },
        }),
      }) as { memoryId?: string; visibility?: "public" | "group" };

      const memoryId = response?.memoryId ?? `${chunk.id}-hub`;

      // Hub role: full hub_memories row for local recall/embeddings. Client: metadata only (team_shared_chunks) for UI.
      if (ctx.config.sharing?.role === "hub") {
        const now = Date.now();
        const existing = store.getHubMemoryBySource(hubClient.userId, chunk.id);
        store.upsertHubMemory({
          id: memoryId,
          sourceChunkId: chunk.id,
          sourceUserId: hubClient.userId,
          sourceAgent: chunk.owner || "",
          role: chunk.role,
          content: chunk.content,
          summary: chunk.summary ?? "",
          kind: chunk.kind,
          groupId,
          visibility,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        });
      } else if (ctx.config.sharing?.enabled && hubClient.userId) {
        const conn = store.getClientHubConnection();
        store.upsertTeamSharedChunk(chunk.id, { hubMemoryId: memoryId, visibility, groupId, hubInstanceId: conn?.hubInstanceId ?? "" });
      }

      return { memoryId, visibility, groupId };
    };

    const unshareMemoryFromHub = async (
      chunkId: string,
      input?: { hubAddress?: string; userToken?: string },
    ): Promise<void> => {
      const chunk = store.getChunk(chunkId);
      if (!chunk) {
        throw new Error(`Memory not found: ${chunkId}`);
      }
      const hubClient = await resolveHubClient(store, ctx, { hubAddress: input?.hubAddress, userToken: input?.userToken });
      await hubRequestJson(hubClient.hubUrl, hubClient.userToken, "/api/v1/hub/memories/unshare", {
        method: "POST",
        body: JSON.stringify({ sourceChunkId: chunk.id }),
      });
      store.deleteHubMemoryBySource(hubClient.userId, chunk.id);
      store.deleteTeamSharedChunk(chunk.id);
    };

    // ─── Tool: memory_search ───

    api.registerTool(
      (context) => ({
        name: "memory_search",
        label: "Memory Search",
        description:
          "Search long-term conversation memory for past conversations, user preferences, decisions, and experiences. " +
          "Use scope='local' for this agent plus local shared memories, or scope='group'/'all' to include Hub-shared memories. " +
          "Supports optional maxResults, minScore, and role filtering when you need tighter control.",
        parameters: Type.Object({
          query: Type.String({ description: "Short natural language search query (2-5 key words)" }),
          scope: Type.Optional(Type.String({ description: "Search scope: 'local' (default), 'group', or 'all'. Use group/all to include Hub-shared memories." })),
          maxResults: Type.Optional(Type.Number({ description: "Maximum results to return. Default 10, max 20." })),
          minScore: Type.Optional(Type.Number({ description: "Minimum score threshold for local recall. Default 0.45, floor 0.35." })),
          role: Type.Optional(Type.String({ description: "Optional local role filter: 'user', 'assistant', 'tool', or 'system'." })),
          hubAddress: Type.Optional(Type.String({ description: "Optional Hub address override for group/all search." })),
          userToken: Type.Optional(Type.String({ description: "Optional Hub bearer token override for group/all search." })),
        }),
        execute: trackTool("memory_search", async (_toolCallId: any, params: any) => {
          const {
            query,
            scope: rawScope,
            maxResults,
            minScore: rawMinScore,
            role: rawRole,
            hubAddress,
            userToken,
          } = params as {
            query: string;
            scope?: string;
            maxResults?: number;
            minScore?: number;
            role?: string;
            hubAddress?: string;
            userToken?: string;
          };
          const role = rawRole === "user" || rawRole === "assistant" || rawRole === "tool" || rawRole === "system" ? rawRole : undefined;
          const minScore = typeof rawMinScore === "number" ? Math.max(0.35, Math.min(1, rawMinScore)) : undefined;
          let searchScope = resolveMemorySearchScope(rawScope);
          const searchLimit = typeof maxResults === "number" ? Math.max(1, Math.min(20, Math.round(maxResults))) : 10;

          const agentId = context?.agentId ?? currentAgentId;
          const ownerFilter = [`agent:${agentId}`, "public"];
          const effectiveMaxResults = searchLimit;
          ctx.log.debug(`memory_search query="${query}" maxResults=${effectiveMaxResults} minScore=${minScore ?? 0.45} role=${role ?? "all"} owner=agent:${agentId}`);

          // ── Phase 1: Local search ∥ Hub search (parallel) ──
          const localSearchP = engine.search({ query, maxResults: effectiveMaxResults, minScore, role, ownerFilter });
          const hubSearchP = searchScope !== "local"
            ? hubSearchMemories(store, ctx, { query, maxResults: searchLimit, scope: searchScope as any, hubAddress, userToken })
                .catch(() => ({ hits: [] as any[], meta: { totalCandidates: 0, searchedGroups: [] as string[], includedPublic: searchScope === "all" } }))
            : Promise.resolve(null);

          const [result, hubResult] = await Promise.all([localSearchP, hubSearchP]);
          ctx.log.debug(`memory_search raw candidates: local=${result.hits.length}, hub=${hubResult?.hits?.length ?? 0}`);

          // Split local results: pure-local vs hub-memory (Hub role's hub_memories mixed in by RecallEngine)
          const localHits = result.hits.filter((h) => h.origin !== "hub-memory");
          const hubLocalHits = searchScope !== "local" ? result.hits.filter((h) => h.origin === "hub-memory") : [];

          const rawLocalCandidates = localHits.map((h) => ({
            chunkId: h.ref.chunkId,
            role: h.source.role,
            score: h.score,
            summary: h.summary,
            original_excerpt: (h.original_excerpt ?? "").slice(0, 200),
            origin: h.origin || "local",
            owner: h.owner || "",
          }));

          // Hub remote candidates (from HTTP call) + hub-memory candidates (from RecallEngine for Hub role)
          const hubRemoteHits = hubResult?.hits ?? [];
          const rawHubCandidates = [
            ...hubLocalHits.map((h) => ({
              score: h.score,
              role: h.source.role,
              summary: h.summary,
              original_excerpt: (h.original_excerpt ?? "").slice(0, 200),
              origin: "hub-memory" as const,
              ownerName: "",
              groupName: "",
            })),
            ...hubRemoteHits.map((h: any) => ({
              score: h.score ?? 0,
              role: h.source?.role ?? h.role ?? "assistant",
              summary: h.summary ?? "",
              original_excerpt: (h.excerpt ?? h.summary ?? "").slice(0, 200),
              origin: "hub-remote" as const,
              ownerName: h.ownerName ?? "",
              groupName: h.groupName ?? "",
            })),
          ];

          if (localHits.length === 0 && rawHubCandidates.length === 0) {
            return {
              content: [{ type: "text", text: result.meta.note ?? "No relevant memories found." }],
              details: { candidates: rawLocalCandidates, hubCandidates: [], filtered: [], meta: result.meta },
            };
          }

          // ── Phase 2: Merge all candidates → single LLM filter ──
          const allHitsForFilter = [...localHits, ...hubLocalHits];
          const hubRemoteForFilter = hubRemoteHits;
          const mergedCandidates = [
            ...allHitsForFilter.map((h, i) => ({
              index: i + 1,
              role: h.source.role,
              content: (h.original_excerpt ?? "").slice(0, 300),
              time: h.source.ts ? new Date(h.source.ts).toISOString().slice(0, 16) : "",
            })),
            ...hubRemoteForFilter.map((h: any, i: number) => ({
              index: allHitsForFilter.length + i + 1,
              role: (h.source?.role || "assistant") as string,
              content: (h.summary || h.excerpt || "").slice(0, 300),
              time: h.source?.ts ? new Date(h.source.ts).toISOString().slice(0, 16) : "",
            })),
          ];

          let filteredLocalHits = allHitsForFilter;
          let filteredHubRemoteHits = hubRemoteForFilter;
          let sufficient = false;

          if (mergedCandidates.length > 0) {
            const filterResult = await summarizer.filterRelevant(query, mergedCandidates);
            if (filterResult !== null) {
              sufficient = filterResult.sufficient;
              if (filterResult.relevant.length > 0) {
                const relevantSet = new Set(filterResult.relevant);
                const hubStartIdx = allHitsForFilter.length + 1;
                filteredLocalHits = allHitsForFilter.filter((_, i) => relevantSet.has(i + 1));
                filteredHubRemoteHits = hubRemoteForFilter.filter((_: any, i: number) => relevantSet.has(hubStartIdx + i));
                ctx.log.debug(`memory_search LLM filter: merged ${mergedCandidates.length} → local ${filteredLocalHits.length}, hub ${filteredHubRemoteHits.length}`);
              } else {
                filteredLocalHits = [];
                filteredHubRemoteHits = [];
              }
            }
          }

          const beforeDedup = filteredLocalHits.length;
          filteredLocalHits = deduplicateHits(filteredLocalHits);
          ctx.log.debug(`memory_search dedup: ${beforeDedup} → ${filteredLocalHits.length}`);

          if (filteredLocalHits.length === 0 && filteredHubRemoteHits.length === 0) {
            return {
              content: [{ type: "text", text: "No relevant memories found for this query." }],
              details: { candidates: rawLocalCandidates, hubCandidates: rawHubCandidates, filtered: [], meta: result.meta },
            };
          }

          // ── Phase 3: Build response text ──
          const originTag = (o?: string) => {
            if (o === "local-shared") return " [本机共享]";
            if (o === "hub-memory") return " [团队缓存]";
            if (o === "hub-remote") return " [团队]";
            return "";
          };

          const localLines = filteredLocalHits.map((h, i) => {
            const excerpt = h.original_excerpt.length > 220 ? h.original_excerpt.slice(0, 217) + "..." : h.original_excerpt;
            const parts = [`${i + 1}. [${h.source.role}]${originTag(h.origin)} ${excerpt}`];
            parts.push(`   chunkId="${h.ref.chunkId}"`);
            if (h.taskId) {
              const task = store.getTask(h.taskId);
              if (task && task.status !== "skipped") parts.push(`   task_id="${h.taskId}"`);
            }
            return parts.join("\n");
          });

          const hubLines = filteredHubRemoteHits.map((h: any, i: number) =>
            `${i + 1}. [${h.ownerName ?? "team"}] [团队] ${h.summary ?? ""}${h.groupName ? ` (${h.groupName})` : ""}`
          );

          let tipsText = "";
          if (!sufficient) {
            const hasTask = filteredLocalHits.some((h) => {
              if (!h.taskId) return false;
              const t = store.getTask(h.taskId);
              return t && t.status !== "skipped";
            });
            const tips: string[] = [];
            if (hasTask) {
              tips.push("→ call task_summary(taskId) for full task context");
              tips.push("→ call skill_get(taskId=...) if the task has a proven experience guide");
            }
            tips.push("→ call memory_timeline(chunkId) to expand surrounding conversation");
            if (tips.length > 0) tipsText = "\n\nThese memories may not be enough. You can fetch more context:\n" + tips.join("\n");
          }

          const localText = localLines.length > 0 ? localLines.join("\n\n") : "(none)";
          const hubText = hubLines.length > 0 ? hubLines.join("\n") : "(none)";
          const totalFiltered = filteredLocalHits.length + filteredHubRemoteHits.length;
          const responseText = filteredHubRemoteHits.length > 0
            ? `Found ${totalFiltered} relevant memories:\n\nLocal results:\n${localText}\n\nHub results:\n${hubText}${tipsText}`
            : `Found ${totalFiltered} relevant memories:\n\n${localText}${tipsText}`;

          const filteredDetails = [
            ...filteredLocalHits.map((h) => {
              let effectiveTaskId = h.taskId;
              if (effectiveTaskId) { const t = store.getTask(effectiveTaskId); if (t && t.status === "skipped") effectiveTaskId = null; }
              return {
                chunkId: h.ref.chunkId, taskId: effectiveTaskId, skillId: h.skillId,
                role: h.source.role, score: h.score, summary: h.summary,
                original_excerpt: (h.original_excerpt ?? "").slice(0, 200), origin: h.origin || "local",
                owner: h.owner || "",
              };
            }),
            ...filteredHubRemoteHits.map((h: any) => ({
              chunkId: "", taskId: null, skillId: null,
              role: h.source?.role ?? h.role ?? "assistant", score: h.score ?? 0,
              summary: h.summary ?? "", original_excerpt: (h.excerpt ?? h.summary ?? "").slice(0, 200),
              origin: "hub-remote", ownerName: h.ownerName ?? "", groupName: h.groupName ?? "",
              sourceAgent: h.sourceAgent ?? "",
            })),
          ];

          return {
            content: [{ type: "text", text: responseText }],
            details: {
              candidates: rawLocalCandidates,
              hubCandidates: rawHubCandidates,
              filtered: filteredDetails,
              meta: result.meta,
            },
          };
        }),
      }),
      { name: "memory_search" },
    );

    // ─── Tool: memory_timeline ───

    api.registerTool(
      (context) => ({
        name: "memory_timeline",
        label: "Memory Timeline",
        description:
          "Expand context around a memory search hit. Pass the chunkId from a search result " +
          "to read the surrounding conversation messages.",
        parameters: Type.Object({
          chunkId: Type.String({ description: "The chunkId from a memory_search hit" }),
          window: Type.Optional(Type.Number({ description: "Context window ±N (default 2)" })),
        }),
        execute: trackTool("memory_timeline", async (_toolCallId: any, params: any) => {
          const agentId = context?.agentId ?? currentAgentId;
          ctx.log.debug(`memory_timeline called (agent=${agentId})`);
          const { chunkId, window: win } = params as {
            chunkId: string;
            window?: number;
          };

          const ownerFilter = [`agent:${agentId}`, "public"];
          const anchorChunk = store.getChunkForOwners(chunkId, ownerFilter);
          if (!anchorChunk) {
            return {
              content: [{ type: "text", text: `Chunk not found: ${chunkId}` }],
              details: { error: "not_found", entries: [] },
            };
          }

          const w = win ?? DEFAULTS.timelineWindowDefault;
          const neighbors = store.getNeighborChunks(anchorChunk.sessionKey, anchorChunk.turnId, anchorChunk.seq, w, ownerFilter);
          const anchorTs = anchorChunk?.createdAt ?? 0;

          const entries = neighbors.map((chunk) => {
            let relation: "before" | "current" | "after" = "before";
            if (chunk.id === chunkId) relation = "current";
            else if (chunk.createdAt > anchorTs) relation = "after";

            return {
              relation,
              role: chunk.role,
              excerpt: chunk.content,
              ts: chunk.createdAt,
            };
          });

          const rl = (r: string) => r === "user" ? "USER" : r === "assistant" ? "ASSISTANT" : r.toUpperCase();
          const text = entries
            .map((e) => `[${e.relation}] ${rl(e.role)}: ${e.excerpt}`)
            .join("\n");

          return {
            content: [{ type: "text", text: `Timeline (${entries.length} entries):\n\n${text}` }],
            details: { entries, anchorRef: { sessionKey: anchorChunk.sessionKey, chunkId, turnId: anchorChunk.turnId, seq: anchorChunk.seq } },
          };
        }),
      }),
      { name: "memory_timeline" },
    );

    // ─── Tool: memory_get ───

    api.registerTool(
      (context) => ({
        name: "memory_get",
        label: "Memory Get",
        description:
          "Get the full original text of a memory chunk. Use to verify exact details from a search hit.",
        parameters: Type.Object({
          chunkId: Type.String({ description: "From search hit ref.chunkId" }),
          maxChars: Type.Optional(
            Type.Number({ description: `Max chars (default ${DEFAULTS.getMaxCharsDefault}, max ${DEFAULTS.getMaxCharsMax})` }),
          ),
        }),
        execute: trackTool("memory_get", async (_toolCallId: any, params: any) => {
          const { chunkId, maxChars } = params as { chunkId: string; maxChars?: number };
          const limit = Math.min(maxChars ?? DEFAULTS.getMaxCharsDefault, DEFAULTS.getMaxCharsMax);

          const agentId = context?.agentId ?? currentAgentId;
          const ownerFilter = [`agent:${agentId}`, "public"];
          const chunk = store.getChunkForOwners(chunkId, ownerFilter);
          if (!chunk) {
            return {
              content: [{ type: "text", text: `Chunk not found: ${chunkId}` }],
              details: { error: "not_found" },
            };
          }

          const content = chunk.content;

          const who = chunk.role === "user" ? "USER said" : chunk.role === "assistant" ? "ASSISTANT replied" : chunk.role === "tool" ? "TOOL returned" : chunk.role.toUpperCase();

          return {
            content: [{ type: "text", text: `[${who}] (session: ${chunk.sessionKey})\n\n${content}` }],
            details: {
              ref: { sessionKey: chunk.sessionKey, chunkId: chunk.id, turnId: chunk.turnId, seq: chunk.seq },
              source: { ts: chunk.createdAt, role: chunk.role, sessionKey: chunk.sessionKey },
            },
          };
        }),
      }),
      { name: "memory_get" },
    );

    // ─── Tool: task_summary ───

    api.registerTool(
      {
        name: "task_summary",
        label: "Task Summary",
        description:
          "Get the detailed summary of a complete task. Use this when memory_search returns a hit " +
          "with a task_id and you need the full context of that task. The summary preserves all " +
          "critical information: URLs, file paths, commands, error codes, step-by-step instructions.",
        parameters: Type.Object({
          taskId: Type.String({ description: "The task_id from a memory_search hit" }),
        }),
        execute: trackTool("task_summary", async (_toolCallId: any, params: any) => {
          const { taskId } = params as { taskId: string };
          ctx.log.debug(`task_summary called for task=${taskId}`);

          const task = store.getTask(taskId);
          if (!task) {
            return {
              content: [{ type: "text", text: `Task not found: ${taskId}` }],
              details: { error: "not_found" },
            };
          }

          if (task.status === "skipped") {
            return {
              content: [{ type: "text", text: `Task "${task.title}" was too brief to generate a summary. Reason: ${task.summary || "conversation too short"}. Use memory_get to read individual chunks instead.` }],
              details: { taskId, status: task.status },
            };
          }

          if (!task.summary) {
            const chunks = store.getChunksByTask(taskId);
            if (chunks.length === 0) {
              return {
                content: [{ type: "text", text: `Task ${taskId} has no content yet.` }],
                details: { taskId, status: task.status },
              };
            }
            return {
              content: [{
                type: "text",
                text: `Task "${task.title}" is still active (summary not yet generated). ` +
                  `It contains ${chunks.length} memory chunks. Use memory_get to read individual chunks.`,
              }],
              details: { taskId, status: task.status, chunkCount: chunks.length },
            };
          }

          const relatedSkills = store.getSkillsByTask(taskId);
          let skillSection = "";
          if (relatedSkills.length > 0) {
            const skillLines = relatedSkills.map(rs =>
              `- 🔧 ${rs.skill.name} (${rs.relation}, v${rs.versionAt}) — call skill_get(skillId="${rs.skill.id}") or skill_get(taskId="${taskId}") to get the full guide`
            );
            skillSection = `\n\n### Related Skills\n${skillLines.join("\n")}`;
          }

          return {
            content: [{
              type: "text",
              text: `## Task: ${task.title}\n\nStatus: ${task.status}\nChunks: ${store.getChunksByTask(taskId).length}\n\n${task.summary}${skillSection}`,
            }],
            details: {
              taskId: task.id,
              title: task.title,
              status: task.status,
              startedAt: task.startedAt,
              endedAt: task.endedAt,
              relatedSkills: relatedSkills.map(rs => ({ skillId: rs.skill.id, name: rs.skill.name, relation: rs.relation })),
            },
          };
        }),
      },
      { name: "task_summary" },
    );

    // ─── Tool: task_share ───

    api.registerTool(
      {
        name: "task_share",
        label: "Task Share",
        description:
          "Share one existing local task and its chunks to the configured hub. " +
          "Minimal MVP path for validating team task sharing.",
        parameters: Type.Object({
          taskId: Type.String({ description: "Local task ID to share" }),
          visibility: Type.Optional(Type.String({ description: "Share visibility: 'public' (default) or 'group'" })),
          groupId: Type.Optional(Type.String({ description: "Optional group ID when visibility='group'" })),
        }),
        execute: trackTool("task_share", async (_toolCallId: any, params: any) => {
          const { taskId, visibility: rawVisibility, groupId } = params as {
            taskId: string;
            visibility?: string;
            groupId?: string;
          };

          const task = store.getTask(taskId);
          if (!task) {
            return {
              content: [{ type: "text", text: `Task not found: ${taskId}` }],
              details: { error: "not_found", taskId },
            };
          }

          const chunks = store.getChunksByTask(taskId);
          if (chunks.length === 0) {
            return {
              content: [{ type: "text", text: `Task ${taskId} has no chunks to share.` }],
              details: { error: "no_chunks", taskId },
            };
          }

          const visibility = rawVisibility === "group" ? "group" : "public";
          const hubClient = await resolveHubClient(store, ctx);
          const { v4: uuidv4 } = require("uuid");
          const hubTaskId = uuidv4();

          const response = await hubRequestJson(hubClient.hubUrl, hubClient.userToken, "/api/v1/hub/tasks/share", {
            method: "POST",
            body: JSON.stringify({
              task: {
                id: hubTaskId,
                sourceTaskId: task.id,
                sourceUserId: hubClient.userId,
                title: task.title,
                summary: task.summary,
                groupId: visibility === "group" ? (groupId ?? null) : null,
                visibility,
                createdAt: task.startedAt,
                updatedAt: task.updatedAt,
              },
              chunks: chunks.map((chunk) => ({
                id: uuidv4(),
                hubTaskId,
                sourceTaskId: task.id,
                sourceChunkId: chunk.id,
                sourceUserId: hubClient.userId,
                role: chunk.role,
                content: chunk.content,
                summary: chunk.summary,
                kind: chunk.kind,
                createdAt: chunk.createdAt,
              })),
            }),
          }) as any;

          const conn = store.getClientHubConnection();
          store.markTaskShared(task.id, hubTaskId, chunks.length, visibility, groupId, conn?.hubInstanceId ?? "");

          return {
            content: [{ type: "text", text: `Shared task "${task.title}" with ${chunks.length} chunks to the hub.` }],
            details: {
              shared: true,
              taskId: task.id,
              visibility,
              chunkCount: chunks.length,
              hubUrl: hubClient.hubUrl,
              response,
            },
          };
        }),
      },
      { name: "task_share" },
    );

    // ─── Tool: task_unshare ───

    api.registerTool(
      {
        name: "task_unshare",
        label: "Task Unshare",
        description: "Remove one previously shared task from the configured hub.",
        parameters: Type.Object({
          taskId: Type.String({ description: "Local task ID to unshare" }),
        }),
        execute: trackTool("task_unshare", async (_toolCallId: any, params: any) => {
          const { taskId } = params as { taskId: string };

          const task = store.getTask(taskId);
          if (!task) {
            return {
              content: [{ type: "text", text: `Task not found: ${taskId}` }],
              details: { error: "not_found", taskId },
            };
          }

          const hubClient = await resolveHubClient(store, ctx);
          await hubRequestJson(hubClient.hubUrl, hubClient.userToken, "/api/v1/hub/tasks/unshare", {
            method: "POST",
            body: JSON.stringify({
              sourceUserId: hubClient.userId,
              sourceTaskId: task.id,
            }),
          });

          store.unmarkTaskShared(task.id);

          return {
            content: [{ type: "text", text: `Unshared task "${task.title}" from the hub.` }],
            details: {
              unshared: true,
              taskId: task.id,
              hubUrl: hubClient.hubUrl,
            },
          };
        }),
      },
      { name: "task_unshare" },
    );

    api.registerTool(
      {
        name: "network_memory_detail",
        label: "Network Memory Detail",
        description: "Fetch the full detail for a Hub search hit returned by memory_search(scope=group|all).",
        parameters: Type.Object({
          remoteHitId: Type.String({ description: "The remoteHitId returned by a Hub search hit" }),
          hubAddress: Type.Optional(Type.String({ description: "Optional Hub address override for tests or manual routing" })),
          userToken: Type.Optional(Type.String({ description: "Optional Hub bearer token override for tests" })),
        }),
        execute: trackTool("network_memory_detail", async (_toolCallId: any, params: any) => {
          const { remoteHitId, hubAddress, userToken } = params as {
            remoteHitId: string;
            hubAddress?: string;
            userToken?: string;
          };

          const detail = await hubGetMemoryDetail(store, ctx, { remoteHitId, hubAddress, userToken });
          return {
            content: [{
              type: "text",
              text: `## Shared Memory Detail

${detail.summary}

${detail.content}`,
            }],
            details: detail,
          };
        }),
      },
      { name: "network_memory_detail" },
    );

    api.registerTool(
      {
        name: "network_team_info",
        label: "Network Team Info",
        description:
          "Show current Hub connection status, signed-in user, role, and group memberships. " +
          "Use this as a preflight check before any Hub share/unshare or Hub pull operation.",
        parameters: Type.Object({}),
        execute: trackTool("network_team_info", async () => {
          const status = await getHubStatus(store, ctx.config);
          if (!status.connected || !status.user) {
            return {
              content: [{ type: "text", text: "Hub is not connected." }],
              details: status,
            };
          }

          const groupNames = status.user.groups.map((group) => group.name);
          return {
            content: [{
              type: "text",
              text: `## Team Connection

User: ${status.user.username}
Role: ${status.user.role}
Hub: ${status.hubUrl ?? "(unknown)"}
Groups: ${groupNames.length > 0 ? groupNames.join(", ") : "(none)"}`,
            }],
            details: status,
          };
        }),
      },
      { name: "network_team_info" },
    );

    // ─── Tool: skill_get ───

    api.registerTool(
      {
        name: "skill_get",
        label: "Get Skill",
        description:
          "Retrieve a proven skill (experience guide) by skillId or taskId. " +
          "Pass either one — if you have a task_id from memory_search, pass taskId and the system " +
          "will find the associated skill automatically.",
        parameters: Type.Object({
          skillId: Type.Optional(Type.String({ description: "Direct skill ID" })),
          taskId: Type.Optional(Type.String({ description: "Task ID — will look up the skill linked to this task" })),
        }),
        execute: trackTool("skill_get", async (_toolCallId: any, params: any) => {
          const { skillId: directSkillId, taskId } = params as { skillId?: string; taskId?: string };

          let resolvedSkillId = directSkillId;
          if (!resolvedSkillId && taskId) {
            const linked = store.getSkillsByTask(taskId);
            if (linked.length > 0) {
              resolvedSkillId = linked[0].skill.id;
            } else {
              return {
                content: [{ type: "text", text: `No skill associated with task ${taskId}.` }],
                details: { error: "no_skill_for_task", taskId },
              };
            }
          }

          if (!resolvedSkillId) {
            return {
              content: [{ type: "text", text: "Provide either skillId or taskId." }],
              details: { error: "missing_params" },
            };
          }

          ctx.log.debug(`skill_get resolved skill=${resolvedSkillId} (from ${directSkillId ? "skillId" : "taskId=" + taskId})`);

          const skill = store.getSkill(resolvedSkillId);
          if (!skill) {
            return {
              content: [{ type: "text", text: `Skill not found: ${resolvedSkillId}` }],
              details: { error: "not_found" },
            };
          }

          const sv = store.getLatestSkillVersion(resolvedSkillId);
          if (!sv) {
            return {
              content: [{ type: "text", text: `Skill "${skill.name}" has no content versions.` }],
              details: { skillId: resolvedSkillId, name: skill.name, error: "no_version" },
            };
          }

          const disabledWarning = skill.status === "archived"
            ? "\n\n> **Warning:** This skill is currently **disabled** (archived). Its content is shown for reference only — it will not be used in search or auto-recall.\n\n"
            : "";

          const manifest = skillInstaller.getCompanionManifest(resolvedSkillId);
          let footer = "\n\n---\n";

          if (manifest && manifest.hasCompanionFiles) {
            const fileSummary = manifest.files
              .filter(f => f.type !== "eval")
              .map(f => `\`${f.relativePath}\``)
              .join(", ");
            footer += `**Companion files available:** ${fileSummary}\n`;
            footer += `→ call \`skill_files(skillId="${resolvedSkillId}")\` to list all files\n`;
            footer += `→ call \`skill_file_get(skillId="${resolvedSkillId}", path="...")\` to read a specific file\n`;
            if (manifest.installMode === "install_recommended") {
              footer += `→ **Recommended:** call \`skill_install(skillId="${resolvedSkillId}")\` for persistent workspace access (many/large files)\n`;
            }
            if (manifest.installed && manifest.installedPath) {
              footer += `> Already installed at: ${manifest.installedPath}/\n`;
            }
          } else {
            footer += `To install this skill for persistent use: call skill_install(skillId="${resolvedSkillId}")`;
          }

          return {
            content: [{
              type: "text",
              text: `## Skill: ${skill.name} (v${skill.version})${disabledWarning}\n\n${sv.content}${footer}`,
            }],
            details: {
              skillId: skill.id,
              name: skill.name,
              version: skill.version,
              status: skill.status,
              installed: skill.installed,
              companionFiles: manifest?.hasCompanionFiles ?? false,
              installMode: manifest?.installMode ?? "inline",
            },
          };
        }),
      },
      { name: "skill_get" },
    );

    // ─── Tool: skill_install ───

    api.registerTool(
      {
        name: "skill_install",
        label: "Install Skill",
        description:
          "Install a learned skill into the agent workspace so it becomes permanently available. " +
          "After installation, the skill will be loaded automatically in future sessions.",
        parameters: Type.Object({
          skillId: Type.String({ description: "The skill_id to install" }),
        }),
        execute: trackTool("skill_install", async (_toolCallId: any, params: any) => {
          const { skillId } = params as { skillId: string };
          ctx.log.debug(`skill_install called for skill=${skillId}`);

          const result = skillInstaller.install(skillId);
          const skill = store.getSkill(skillId);
          if (skill) telemetry.trackSkillInstalled(skill.name);
          return {
            content: [{ type: "text", text: result.message }],
            details: result,
          };
        }),
      },
      { name: "skill_install" },
    );

    // ─── Tool: skill_files ───

    api.registerTool(
      {
        name: "skill_files",
        label: "List Skill Companion Files",
        description:
          "List companion files (scripts, references, evals) for a skill. " +
          "Use this after skill_get to see what additional files are available. " +
          "Returns file names, sizes, and whether the skill recommends installation.",
        parameters: Type.Object({
          skillId: Type.String({ description: "The skill_id to inspect" }),
        }),
        execute: trackTool("skill_files", async (_toolCallId: any, params: any) => {
          const { skillId } = params as { skillId: string };
          ctx.log.debug(`skill_files called for skill=${skillId}`);

          const manifest = skillInstaller.getCompanionManifest(skillId);
          if (!manifest) {
            return {
              content: [{ type: "text", text: `Skill not found: ${skillId}` }],
              details: { error: "not_found" },
            };
          }

          if (!manifest.hasCompanionFiles) {
            return {
              content: [{ type: "text", text: "This skill has no companion files (scripts, references). The SKILL.md from skill_get contains everything." }],
              details: manifest,
            };
          }

          const lines: string[] = [`## Companion Files (${manifest.files.length} files, ${Math.round(manifest.totalSize / 1024)}KB total)\n`];
          if (manifest.scriptsCount > 0) {
            lines.push(`### Scripts (${manifest.scriptsCount})`);
            for (const f of manifest.files.filter(f => f.type === "script")) {
              lines.push(`- \`${f.relativePath}\` (${f.size} bytes) → call \`skill_file_get(skillId="${skillId}", path="${f.relativePath}")\``);
            }
          }
          if (manifest.referencesCount > 0) {
            lines.push(`\n### References (${manifest.referencesCount})`);
            for (const f of manifest.files.filter(f => f.type === "reference")) {
              lines.push(`- \`${f.relativePath}\` (${f.size} bytes) → call \`skill_file_get(skillId="${skillId}", path="${f.relativePath}")\``);
            }
          }
          if (manifest.evalsCount > 0) {
            lines.push(`\n### Evals (${manifest.evalsCount})`);
            for (const f of manifest.files.filter(f => f.type === "eval")) {
              lines.push(`- \`${f.relativePath}\` (${f.size} bytes)`);
            }
          }

          if (manifest.installMode === "install_recommended") {
            lines.push(`\n> **Recommendation:** This skill has many/large companion files. Consider \`skill_install(skillId="${skillId}")\` for persistent workspace access.`);
          }
          if (manifest.installed && manifest.installedPath) {
            lines.push(`\n> **Installed at:** ${manifest.installedPath}/`);
          }

          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: manifest,
          };
        }),
      },
      { name: "skill_files" },
    );

    // ─── Tool: skill_file_get ───

    api.registerTool(
      {
        name: "skill_file_get",
        label: "Get Skill Companion File",
        description:
          "Read the content of a specific companion file (script, reference) from a skill. " +
          "Use after skill_files to retrieve a script or reference document. " +
          "Pass the relative path like 'scripts/deploy.sh' or 'references/api-notes.md'.",
        parameters: Type.Object({
          skillId: Type.String({ description: "The skill_id" }),
          path: Type.String({ description: "Relative path within the skill, e.g. 'scripts/deploy.sh'" }),
        }),
        execute: trackTool("skill_file_get", async (_toolCallId: any, params: any) => {
          const { skillId, path: filePath } = params as { skillId: string; path: string };
          ctx.log.debug(`skill_file_get called for skill=${skillId} path=${filePath}`);

          const result = skillInstaller.readCompanionFile(skillId, filePath);
          if ("error" in result) {
            return {
              content: [{ type: "text", text: `Error: ${result.error}` }],
              details: result,
            };
          }

          const ext = filePath.split(".").pop() || "";
          const lang = { sh: "bash", py: "python", ts: "typescript", js: "javascript", json: "json", md: "markdown", yml: "yaml", yaml: "yaml" }[ext] || "";

          return {
            content: [{ type: "text", text: `## ${filePath}\n\n\`\`\`${lang}\n${result.content}\n\`\`\`` }],
            details: { path: filePath, size: result.size },
          };
        }),
      },
      { name: "skill_file_get" },
    );

    // ─── Tool: memory_viewer ───

    const gatewayPort = (api.config as any)?.gateway?.port ?? 18789;
    const viewerPort = (pluginCfg as any).viewerPort ?? (gatewayPort + 10);

    api.registerTool(
      (context) => ({
        name: "memory_viewer",
        label: "Open Memory Viewer",
        description:
          "Show the MemOS Memory Viewer URL. Call this when the user asks how to view, browse, manage, " +
          "or access their stored memories, or asks where the memory dashboard is. " +
          "Returns the URL the user can open in their browser.",
        parameters: Type.Object({}),
        execute: trackTool("memory_viewer", async (_toolCallId: any, params: any) => {
          ctx.log.debug(`memory_viewer called`);
          telemetry.trackViewerOpened();
          const agentId = context?.agentId ?? context?.profileId ?? currentAgentId;
          const url = `http://127.0.0.1:${viewerPort}?agentId=${encodeURIComponent(agentId)}`;
          return {
            content: [
              {
                type: "text",
                text: [
                  `MemOS Memory Viewer: ${url}`,
                  "",
                  "Open this URL in your browser to:",
                  "- Browse all stored memories with a clean timeline view",
                  "- Semantic search (powered by your embedding model)",
                  "- Create, edit, and delete memories",
                  "- Filter by session, role, and time range",
                  "",
                  "First visit requires setting a password to protect your data.",
                ].join("\n"),
              },
            ],
            details: { viewerUrl: url },
          };
        }),
      }),
      { name: "memory_viewer" },
    );

    // ─── Tool: memory_write_public ───

    api.registerTool(
      {
        name: "memory_write_public",
        label: "Write Local Shared Memory",
        description:
          "Write a piece of information to local shared memory for all agents in this OpenClaw workspace. " +
          "Use this when you are creating a new shared note from scratch. This does not publish to Hub. " +
          "If you already have a memory chunk and want to expose it, use memory_share instead.",
        parameters: Type.Object({
          content: Type.String({ description: "The content to write to local shared memory" }),
          summary: Type.Optional(Type.String({ description: "Optional short summary of the content" })),
        }),
        execute: trackTool("memory_write_public", async (_toolCallId: any, params: any) => {
          const { content: writeContent, summary: writeSummary } = params as { content: string; summary?: string };
          if (!writeContent || !writeContent.trim()) {
            return { content: [{ type: "text", text: "Content cannot be empty." }] };
          }

          const { v4: uuidv4 } = require("uuid");
          const now = Date.now();
          const chunkId = uuidv4();
          const chunkSummary = writeSummary ?? writeContent;

          store.insertChunk({
            id: chunkId,
            sessionKey: "public",
            turnId: `public-${now}`,
            seq: 0,
            role: "assistant",
            content: writeContent.trim(),
            kind: "paragraph",
            summary: chunkSummary,
            embedding: null,
            taskId: null,
            skillId: null,
            owner: "public",
            dedupStatus: "active",
            dedupTarget: null,
            dedupReason: null,
            mergeCount: 0,
            lastHitAt: null,
            mergeHistory: "[]",
            createdAt: now,
            updatedAt: now,
          });

          try {
            const [emb] = await embedder.embed([chunkSummary]);
            if (emb) store.upsertEmbedding(chunkId, emb);
          } catch (err) {
            api.logger.warn(`memos-local: public memory embedding failed: ${err}`);
          }

          return {
            content: [{ type: "text", text: `Memory shared to local agents successfully (id: ${chunkId}).` }],
            details: { chunkId, owner: "public" },
          };
        }),
      },
      { name: "memory_write_public" },
    );

    api.registerTool(
      {
        name: "memory_share",
        label: "Share Memory",
        description:
          "Share an existing stored memory (requires a real chunkId from the database) to the Hub team, or to both targets. " +
          "If you want to share content from the conversation, please first retrieve the memories related to that content to obtain the correct chunkId(s), then proceed with the sharing. " +
          "target='agents' (default): when retrieved memories would clearly help other agents in the same OpenClaw workspace, you may share proactively without asking the user. " +
          "target='hub' or 'both': do not share to the team Hub without explicit user consent when the content would benefit collaborators—explain briefly, ask first, and only call hub/both after they agree (Hub must be configured). " +
          "To create a brand-new shared note with no existing chunk, use memory_write_public.",
        parameters: Type.Object({
          chunkId: Type.String({ description: "Existing local memory chunk ID to share" }),
          target: Type.Optional(Type.String({ description: "Share target: 'agents' (default), 'hub', or 'both'" })),
          visibility: Type.Optional(Type.String({ description: "Hub visibility when target includes hub: 'public' (default) or 'group'" })),
          groupId: Type.Optional(Type.String({ description: "Optional Hub group ID when visibility='group'" })),
          hubAddress: Type.Optional(Type.String({ description: "Optional Hub address override" })),
          userToken: Type.Optional(Type.String({ description: "Optional Hub bearer token override" })),
        }),
        execute: trackTool("memory_share", async (_toolCallId: any, params: any) => {
          const {
            chunkId,
            target: rawTarget,
            visibility: rawVisibility,
            groupId,
            hubAddress,
            userToken,
          } = params as {
            chunkId: string;
            target?: string;
            visibility?: string;
            groupId?: string;
            hubAddress?: string;
            userToken?: string;
          };

          const chunk = store.getChunk(chunkId);
          if (!chunk) {
            return { content: [{ type: "text", text: `Memory not found: ${chunkId}` }], details: { error: "not_found", chunkId } };
          }

          const target = resolveMemoryShareTarget(rawTarget);
          const visibility = rawVisibility === "group" ? "group" : "public";
          const details: Record<string, unknown> = { chunkId, target };
          const messages: string[] = [];

          if (target === "agents" || target === "both") {
            const local = store.markMemorySharedLocally(chunkId);
            if (!local.ok) {
              return { content: [{ type: "text", text: `Failed to share memory ${chunkId} to local agents.` }], details: { error: local.reason ?? "local_share_failed", chunkId, target } };
            }
            details.local = {
              shared: true,
              owner: local.owner,
              originalOwner: local.originalOwner ?? null,
            };
            messages.push("shared to local agents");
          }

          if (target === "hub" || target === "both") {
            const hub = await shareMemoryToHub(chunkId, { visibility, groupId, hubAddress, userToken });
            details.hub = {
              shared: true,
              memoryId: hub.memoryId,
              visibility: hub.visibility,
              groupId: hub.groupId,
            };
            messages.push(`shared to Hub (${hub.visibility})`);
          }

          return {
            content: [{ type: "text", text: `Memory "${chunk.summary || chunk.id}" ${messages.join(" and ")}.` }],
            details,
          };
        }),
      },
      { name: "memory_share" },
    );

    api.registerTool(
      {
        name: "memory_unshare",
        label: "Unshare Memory",
        description:
          "Remove sharing from an existing memory. Use target='agents' to stop local multi-agent sharing, target='hub' to remove it from Hub, or target='all' (default) to remove both. " +
          "privateOwner is only needed for older public memories that were never tracked with an original owner.",
        parameters: Type.Object({
          chunkId: Type.String({ description: "Existing local memory chunk ID to unshare" }),
          target: Type.Optional(Type.String({ description: "Unshare target: 'agents', 'hub', or 'all' (default)" })),
          privateOwner: Type.Optional(Type.String({ description: "Optional owner to restore when converting a public memory back to private and no original owner was tracked" })),
          hubAddress: Type.Optional(Type.String({ description: "Optional Hub address override" })),
          userToken: Type.Optional(Type.String({ description: "Optional Hub bearer token override" })),
        }),
        execute: trackTool("memory_unshare", async (_toolCallId: any, params: any) => {
          const {
            chunkId,
            target: rawTarget,
            privateOwner,
            hubAddress,
            userToken,
          } = params as {
            chunkId: string;
            target?: string;
            privateOwner?: string;
            hubAddress?: string;
            userToken?: string;
          };

          const chunk = store.getChunk(chunkId);
          if (!chunk) {
            return { content: [{ type: "text", text: `Memory not found: ${chunkId}` }], details: { error: "not_found", chunkId } };
          }

          const target = resolveMemoryUnshareTarget(rawTarget);
          const details: Record<string, unknown> = { chunkId, target };
          const messages: string[] = [];

          if (target === "agents" || target === "all") {
            const local = store.unmarkMemorySharedLocally(chunkId, privateOwner);
            if (!local.ok) {
              return {
                content: [{
                  type: "text",
                  text: local.reason === "original_owner_missing"
                    ? `Cannot restore memory "${chunk.summary || chunk.id}" to a private owner automatically. Pass privateOwner to unshare it locally.`
                    : `Failed to stop local sharing for memory ${chunkId}.`,
                }],
                details: { error: local.reason ?? "local_unshare_failed", chunkId, target },
              };
            }
            details.local = {
              shared: false,
              owner: local.owner,
            };
            messages.push("removed from local agent sharing");
          }

          if (target === "hub" || target === "all") {
            try {
              await unshareMemoryFromHub(chunkId, { hubAddress, userToken });
              details.hub = { shared: false };
              messages.push("removed from Hub");
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              if (target === "all" && msg.includes("hub client connection is not configured")) {
                details.hub = { shared: false, skipped: true, reason: "hub_not_configured" };
              } else {
                throw err;
              }
            }
          }

          return {
            content: [{ type: "text", text: `Memory "${chunk.summary || chunk.id}" ${messages.join(" and ")}.` }],
            details,
          };
        }),
      },
      { name: "memory_unshare" },
    );

    // ─── Tool: skill_search ───

    api.registerTool(
      (context) => ({
        name: "skill_search",
        label: "Skill Search",
        description:
          "Search available skills by natural language. Use scope='mix' (default) for this agent plus local shared skills, 'self' for this agent only, 'public' for local shared skills only, or 'group'/'all' to include Hub skills as well. " +
          "Use this when you need a capability or guide and don't have a matching skill at hand.",
        parameters: Type.Object({
          query: Type.String({ description: "Natural language description of the needed skill" }),
          scope: Type.Optional(Type.String({ description: "Search scope: 'mix' (default), 'self', 'public', 'group', or 'all'." })),
        }),
        execute: trackTool("skill_search", async (_toolCallId: any, params: any) => {
          const { query: skillQuery, scope: rawScope } = params as { query: string; scope?: string };
          const scope = (rawScope === "self" || rawScope === "public") ? rawScope : "mix";
          const agentId = context?.agentId ?? currentAgentId;
          const currentOwner = `agent:${agentId}`;

          if (rawScope === "group" || rawScope === "all") {
            const [localHits, hub] = await Promise.all([
              engine.searchSkills(skillQuery, "mix" as any, currentOwner),
              hubSearchSkills(store, ctx, { query: skillQuery, maxResults: 10 }).catch(() => ({ hits: [] })),
            ]);

            if (localHits.length === 0 && hub.hits.length === 0) {
              return {
                content: [{ type: "text", text: `No relevant skills found for: "${skillQuery}" (scope: ${rawScope})` }],
                details: { query: skillQuery, scope: rawScope, local: { hits: [] }, hub },
              };
            }

            let filteredLocal = localHits;
            let filteredHub = hub.hits;
            if (localHits.length > 0 && hub.hits.length > 0) {
              const allCandidates = [
                ...localHits.map((h, i) => ({ index: i + 1, role: "skill" as const, content: `[${h.name}] ${h.description.slice(0, 200)}` })),
                ...hub.hits.map((h, i) => ({ index: localHits.length + i + 1, role: "skill" as const, content: `[${h.name}] ${h.description.slice(0, 200)}` })),
              ];
              const mergedFilter = await summarizer.filterRelevant(skillQuery, allCandidates);
              if (mergedFilter !== null && mergedFilter.relevant.length > 0) {
                const relevantSet = new Set(mergedFilter.relevant);
                filteredLocal = localHits.filter((_, i) => relevantSet.has(i + 1));
                filteredHub = hub.hits.filter((_, i) => relevantSet.has(localHits.length + i + 1));
                ctx.log.debug(`skill_search LLM filter (merged): local ${localHits.length}→${filteredLocal.length}, hub ${hub.hits.length}→${filteredHub.length}`);
              }
            }

            const localText = filteredLocal.length > 0
              ? filteredLocal.map((h, i) => `${i + 1}. [${h.name}] ${h.description.slice(0, 150)}${h.visibility === "public" ? " (shared to local agents)" : ""}`).join("\n")
              : "(none)";
            const hubText = filteredHub.length > 0
              ? filteredHub.map((h, i) => `${i + 1}. [${h.name}] ${h.description.slice(0, 150)} (${h.visibility}${h.groupName ? `:${h.groupName}` : ""}, owner=${h.ownerName})`).join("\n")
              : "(none)";

            return {
              content: [{ type: "text", text: `Local skills:\n${localText}\n\nHub skills:\n${hubText}` }],
              details: { query: skillQuery, scope: rawScope, local: { hits: filteredLocal }, hub: { hits: filteredHub } },
            };
          }

          const hits = await engine.searchSkills(skillQuery, scope as any, currentOwner);

          if (hits.length === 0) {
            return {
              content: [{ type: "text", text: `No relevant skills found for: "${skillQuery}" (scope: ${scope})` }],
              details: { query: skillQuery, scope, hits: [] },
            };
          }

          const text = hits.map((h, i) =>
            `${i + 1}. [${h.name}] ${h.description}${h.visibility === "public" ? " (shared to local agents)" : ""}`,
          ).join("\n");

          return {
            content: [{ type: "text", text: `Found ${hits.length} skills:\n\n${text}` }],
            details: { query: skillQuery, scope, hits },
          };
        }),
      }),
      { name: "skill_search" },
    );

    // ─── Tool: skill_publish ───

    api.registerTool(
      {
        name: "skill_publish",
        label: "Publish Skill",
        description:
          "Share a skill with local agents or publish it to the Hub. " +
          "Use target='agents' for local sharing, or target='hub' with visibility='public'/'group' for Hub publishing. " +
          "The old scope parameter is still accepted for backward compatibility.",
        parameters: Type.Object({
          skillId: Type.String({ description: "The skill ID to publish" }),
          target: Type.Optional(Type.String({ description: "Publish target: 'agents' (default) or 'hub'." })),
          visibility: Type.Optional(Type.String({ description: "Hub visibility when target='hub': 'public' (default) or 'group'." })),
          scope: Type.Optional(Type.String({ description: "Deprecated alias: omit for local agents, or use 'public' / 'group' to publish to Hub." })),
          groupId: Type.Optional(Type.String({ description: "Optional group ID when scope='group'" })),
          hubAddress: Type.Optional(Type.String({ description: "Optional Hub address override for tests or manual routing" })),
          userToken: Type.Optional(Type.String({ description: "Optional Hub bearer token override for tests" })),
        }),
        execute: trackTool("skill_publish", async (_toolCallId: any, params: any) => {
          const {
            skillId: pubSkillId,
            target: rawTarget,
            visibility: rawVisibility,
            scope,
            groupId,
            hubAddress,
            userToken,
          } = params as {
            skillId: string;
            target?: string;
            visibility?: string;
            scope?: string;
            groupId?: string;
            hubAddress?: string;
            userToken?: string;
          };
          const skill = store.getSkill(pubSkillId);
          if (!skill) {
            return { content: [{ type: "text", text: `Skill not found: ${pubSkillId}` }] };
          }
          const target = resolveSkillPublishTarget(rawTarget, scope);
          const visibility = resolveSkillHubVisibility(rawVisibility, scope);
          if (target === "hub") {
            const published = await publishSkillBundleToHub(store, ctx, { skillId: pubSkillId, visibility, groupId, hubAddress, userToken });
            return {
              content: [{ type: "text", text: `Skill "${skill.name}" shared to Hub (${published.visibility}).` }],
              details: { skillId: pubSkillId, name: skill.name, target, publishedToHub: true, hubSkillId: published.skillId, visibility: published.visibility },
            };
          }
          store.setSkillVisibility(pubSkillId, "public");
          return {
            content: [{ type: "text", text: `Skill "${skill.name}" is now shared with local agents.` }],
            details: { skillId: pubSkillId, name: skill.name, target, visibility: "public", publishedToHub: false },
          };
        }),
      },
      { name: "skill_publish" },
    );

    // ─── Tool: skill_unpublish ───

    api.registerTool(
      {
        name: "skill_unpublish",
        label: "Unpublish Skill",
        description:
          "Stop sharing a skill with local agents, remove it from the Hub, or do both. " +
          "Use target='agents' (default), 'hub', or 'all'.",
        parameters: Type.Object({
          skillId: Type.String({ description: "The skill ID to unpublish" }),
          target: Type.Optional(Type.String({ description: "Unpublish target: 'agents' (default), 'hub', or 'all'." })),
          hubAddress: Type.Optional(Type.String({ description: "Optional Hub address override for tests or manual routing" })),
          userToken: Type.Optional(Type.String({ description: "Optional Hub bearer token override for tests" })),
        }),
        execute: trackTool("skill_unpublish", async (_toolCallId: any, params: any) => {
          const { skillId: unpubSkillId, target, hubAddress, userToken } = params as { skillId: string; target?: string; hubAddress?: string; userToken?: string };
          const skill = store.getSkill(unpubSkillId);
          if (!skill) {
            return { content: [{ type: "text", text: `Skill not found: ${unpubSkillId}` }] };
          }
          const resolvedTarget = resolveSkillUnpublishTarget(target);
          const messages: string[] = [];
          const details: Record<string, unknown> = { skillId: unpubSkillId, name: skill.name, target: resolvedTarget };
          if (resolvedTarget === "hub" || resolvedTarget === "all") {
            try {
              await unpublishSkillBundleFromHub(store, ctx, { skillId: unpubSkillId, hubAddress, userToken });
              details.hub = { unpublished: true };
              messages.push("removed from Hub sharing");
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              if (resolvedTarget === "all" && msg.includes("hub client connection is not configured")) {
                details.hub = { unpublished: false, skipped: true, reason: "hub_not_configured" };
              } else {
                throw err;
              }
            }
          }
          if (resolvedTarget === "agents" || resolvedTarget === "all") {
            store.setSkillVisibility(unpubSkillId, "private");
            details.local = { visibility: "private" };
            messages.push("limited to this agent");
          }
          return {
            content: [{ type: "text", text: `Skill "${skill.name}" ${messages.join(" and ")}.` }],
            details,
          };
        }),
      },
      { name: "skill_unpublish" },
    );

    api.registerTool(
      {
        name: "network_skill_pull",
        label: "Network Skill Pull",
        description: "Download a published Hub skill bundle and restore it into local managed skills.",
        parameters: Type.Object({
          skillId: Type.String({ description: "The Hub skill ID to pull" }),
          hubAddress: Type.Optional(Type.String({ description: "Optional Hub address override for tests or manual routing" })),
          userToken: Type.Optional(Type.String({ description: "Optional Hub bearer token override for tests" })),
        }),
        execute: trackTool("network_skill_pull", async (_toolCallId: any, params: any) => {
          const { skillId, hubAddress, userToken } = params as { skillId: string; hubAddress?: string; userToken?: string };
          const payload = await fetchHubSkillBundle(store, ctx, { skillId, hubAddress, userToken });
          const restored = restoreSkillBundleFromHub(store, ctx, payload);
          return {
            content: [{ type: "text", text: `Pulled Hub skill "${restored.localName}" into local storage.` }],
            details: { pulled: true, hubSkillId: skillId, localSkillId: restored.localSkillId, localName: restored.localName, dirPath: restored.dirPath },
          };
        }),
      },
      { name: "network_skill_pull" },
    );

    // ─── Auto-recall: inject relevant memories before agent starts ───

    api.on("before_prompt_build", async (event: { prompt?: string; messages?: unknown[] }, hookCtx?: { agentId?: string; sessionKey?: string }) => {
      if (!allowPromptInjection) return {};
      if (!event.prompt || event.prompt.length < 3) return;

      const recallAgentId = hookCtx?.agentId ?? (event as any)?.agentId ?? (event as any)?.profileId ?? "main";
      currentAgentId = recallAgentId;
      const recallOwnerFilter = [`agent:${recallAgentId}`, "public"];
      ctx.log.info(`auto-recall: agentId=${recallAgentId} (from hookCtx)`);

      const recallT0 = performance.now();
      let recallQuery = "";

      try {
        const rawPrompt = event.prompt;
        ctx.log.debug(`auto-recall: rawPrompt="${rawPrompt.slice(0, 300)}"`);

        const query = normalizeAutoRecallQuery(rawPrompt);
        recallQuery = query;

        if (query.length < 2) {
          ctx.log.debug("auto-recall: extracted query too short, skipping");
          return;
        }
        ctx.log.debug(`auto-recall: query="${query.slice(0, 80)}"`);

        // ── Phase 1: Local search ∥ Hub search (parallel) ──
        const arLocalP = engine.search({ query, maxResults: 10, minScore: 0.45, ownerFilter: recallOwnerFilter });
        const arHubP = ctx.config?.sharing?.enabled
          ? hubSearchMemories(store, ctx, { query, maxResults: 10, scope: "all" })
              .catch((err: any) => { ctx.log.debug(`auto-recall: hub search failed (${err})`); return { hits: [] as any[], meta: {} }; })
          : Promise.resolve({ hits: [] as any[], meta: {} });

        const [result, arHubResult] = await Promise.all([arLocalP, arHubP]);

        const localHits = result.hits.filter((h) => h.origin !== "hub-memory");
        const hubLocalHits = result.hits.filter((h) => h.origin === "hub-memory");
        const hubRemoteHits: SearchHit[] = (arHubResult.hits ?? []).map((h: any) => ({
          summary: h.summary,
          original_excerpt: h.excerpt || h.summary,
          ref: { sessionKey: "", chunkId: h.remoteHitId ?? "", turnId: "", seq: 0 },
          score: 0.9,
          taskId: null,
          skillId: null,
          origin: "hub-remote" as const,
          source: { ts: h.source?.ts, role: h.source?.role ?? "assistant", sessionKey: "" },
          ownerName: h.ownerName,
          groupName: h.groupName,
        }));
        const allHubHits = [...hubLocalHits, ...hubRemoteHits];

        ctx.log.debug(`auto-recall: local=${localHits.length}, hub-memory=${hubLocalHits.length}, hub-remote=${hubRemoteHits.length}`);

        const rawLocalCandidates = localHits.map((h) => ({
          score: h.score, role: h.source.role, summary: h.summary,
          content: (h.original_excerpt ?? "").slice(0, 200), origin: h.origin || "local",
          owner: h.owner || "",
        }));
        const rawHubCandidates = allHubHits.map((h) => ({
          score: h.score, role: h.source.role, summary: h.summary,
          content: (h.original_excerpt ?? "").slice(0, 200), origin: h.origin || "hub-remote",
          ownerName: (h as any).ownerName ?? "", groupName: (h as any).groupName ?? "",
        }));

        const allRawHits = [...localHits, ...allHubHits];

        if (allRawHits.length === 0) {
          ctx.log.debug("auto-recall: no memory candidates found");
          const dur = performance.now() - recallT0;
          store.recordToolCall("memory_search", dur, true);
          store.recordApiLog("memory_search", { type: "auto_recall", query }, JSON.stringify({
            candidates: rawLocalCandidates, hubCandidates: rawHubCandidates, filtered: [],
          }), dur, true);

          const skillAutoRecallEarly = ctx.config.skillEvolution?.autoRecallSkills ?? DEFAULTS.skillAutoRecall;
          if (skillAutoRecallEarly) {
            try {
              const skillLimit = ctx.config.skillEvolution?.autoRecallSkillLimit ?? DEFAULTS.skillAutoRecallLimit;
              const skillHits = await engine.searchSkills(query, "mix" as any, getCurrentOwner());
              const topSkills = skillHits.slice(0, skillLimit);
              if (topSkills.length > 0) {
                const skillLines = topSkills.map((sc, i) => {
                  const manifest = skillInstaller.getCompanionManifest(sc.skillId);
                  let badge = "";
                  if (manifest?.installed) badge = " [installed]";
                  else if (manifest?.installMode === "install_recommended") badge = " [has scripts, install recommended]";
                  else if (manifest?.hasCompanionFiles) badge = " [has companion files]";
                  return `${i + 1}. **${sc.name}**${badge} — ${sc.description.slice(0, 200)}\n   → call \`skill_get(skillId="${sc.skillId}")\` for the full guide`;
                });
                const skillContext = "## Relevant skills from past experience\n\n" +
                  "No direct memory matches were found, but these skills from past tasks may help:\n\n" +
                  skillLines.join("\n\n") +
                  "\n\nYou SHOULD call `skill_get` to retrieve the full guide before attempting the task.";
                ctx.log.info(`auto-recall-skill (no-memory path): injecting ${topSkills.length} skill(s)`);
                try { store.recordApiLog("skill_search", { type: "auto_recall_skill", query }, JSON.stringify(topSkills), dur, true); } catch { /* best-effort */ }
                return { prependContext: skillContext };
              }
            } catch (err) {
              ctx.log.debug(`auto-recall-skill (no-memory path): failed: ${err}`);
            }
          }

          if (query.length > 50) {
            const noRecallHint =
              "## Memory system — ACTION REQUIRED\n\n" +
              "Auto-recall found no results for a long query. " +
              "You MUST call `memory_search` now with a shortened query (2-5 key words) before answering. " +
              "Do NOT skip this step. Do NOT answer without searching first.";
            return { prependContext: noRecallHint };
          }
          return;
        }

        // ── Phase 2: Merge all → single LLM filter ──
        const mergedForFilter = allRawHits.map((h, i) => ({
          index: i + 1,
          role: h.source.role,
          content: (h.original_excerpt ?? "").slice(0, 300),
          time: h.source.ts ? new Date(h.source.ts).toISOString().slice(0, 16) : "",
        }));

        let filteredHits = allRawHits;
        let sufficient = false;

        const filterResult = await summarizer.filterRelevant(query, mergedForFilter);
        if (filterResult !== null) {
          sufficient = filterResult.sufficient;
          if (filterResult.relevant.length > 0) {
            const indexSet = new Set(filterResult.relevant);
            filteredHits = allRawHits.filter((_, i) => indexSet.has(i + 1));
          } else {
            const dur = performance.now() - recallT0;
            store.recordToolCall("memory_search", dur, true);
            store.recordApiLog("memory_search", { type: "auto_recall", query }, JSON.stringify({
              candidates: rawLocalCandidates, hubCandidates: rawHubCandidates, filtered: [],
            }), dur, true);
            if (query.length > 50) {
              const noRecallHint =
                "## Memory system — ACTION REQUIRED\n\n" +
                "Auto-recall found no relevant results for a long query. " +
                "You MUST call `memory_search` now with a shortened query (2-5 key words) before answering. " +
                "Do NOT skip this step. Do NOT answer without searching first.";
              return { prependContext: noRecallHint };
            }
            return;
          }
        }

        const beforeDedup = filteredHits.length;
        filteredHits = deduplicateHits(filteredHits);
        ctx.log.debug(`auto-recall: merged ${allRawHits.length} → ${beforeDedup} relevant → ${filteredHits.length} after dedup, sufficient=${sufficient}`);

        const lines = filteredHits.map((h, i) => {
          const excerpt = h.original_excerpt;
          const oTag = h.origin === "local-shared" ? " [本机共享]" : h.origin === "hub-memory" ? " [团队缓存]" : "";
          const parts: string[] = [`${i + 1}. [${h.source.role}]${oTag}`];
          if (excerpt) parts.push(`   ${excerpt}`);
          parts.push(`   chunkId="${h.ref.chunkId}"`);
          if (h.taskId) {
            const task = store.getTask(h.taskId);
            if (task && task.status !== "skipped") {
              parts.push(`   task_id="${h.taskId}"`);
            }
          }
          return parts.join("\n");
        });

        const hasTask = filteredHits.some((h) => {
          if (!h.taskId) return false;
          const t = store.getTask(h.taskId);
          return t && t.status !== "skipped";
        });
        const tips: string[] = [];
        if (hasTask) {
          tips.push("- A hit has `task_id` → call `task_summary(taskId=\"...\")` to get the full task context (steps, code, results)");
          tips.push("- A task may have a reusable guide → call `skill_get(taskId=\"...\")` to retrieve the experience/skill");
        }
        tips.push("- Need more surrounding dialogue → call `memory_timeline(chunkId=\"...\")` to expand context around a hit");
        const tipsText = "\n\nAvailable follow-up tools:\n" + tips.join("\n");

        const contextParts = [
          "## User's conversation history (from memory system)",
          "",
          "IMPORTANT: The following are facts from previous conversations with this user.",
          "You MUST treat these as established knowledge and use them directly when answering.",
          "Do NOT say you don't know or don't have information if the answer is in these memories.",
          "",
          lines.join("\n\n"),
        ];
        if (tipsText) contextParts.push(tipsText);

        // ─── Skill auto-recall ───
        const skillAutoRecall = ctx.config.skillEvolution?.autoRecallSkills ?? DEFAULTS.skillAutoRecall;
        const skillLimit = ctx.config.skillEvolution?.autoRecallSkillLimit ?? DEFAULTS.skillAutoRecallLimit;
        let skillSection = "";

        if (skillAutoRecall) {
          try {
            const skillCandidateMap = new Map<string, { name: string; description: string; skillId: string; source: string }>();

            try {
              const directSkillHits = await engine.searchSkills(query, "mix" as any, getCurrentOwner());
              for (const sh of directSkillHits.slice(0, skillLimit + 2)) {
                if (!skillCandidateMap.has(sh.skillId)) {
                  skillCandidateMap.set(sh.skillId, { name: sh.name, description: sh.description, skillId: sh.skillId, source: "query" });
                }
              }
            } catch (err) {
              ctx.log.debug(`auto-recall-skill: direct search failed: ${err}`);
            }

            const taskIds = new Set<string>();
            for (const h of filteredHits) {
              if (h.taskId) {
                const t = store.getTask(h.taskId);
                if (t && t.status !== "skipped") taskIds.add(h.taskId);
              }
            }
            for (const tid of taskIds) {
              const linked = store.getSkillsByTask(tid);
              for (const rs of linked) {
                if (!skillCandidateMap.has(rs.skill.id)) {
                  skillCandidateMap.set(rs.skill.id, { name: rs.skill.name, description: rs.skill.description, skillId: rs.skill.id, source: `task:${tid}` });
                }
              }
            }

            const skillCandidates = [...skillCandidateMap.values()].slice(0, skillLimit);

            if (skillCandidates.length > 0) {
              const skillLines = skillCandidates.map((sc, i) => {
                const manifest = skillInstaller.getCompanionManifest(sc.skillId);
                let badge = "";
                if (manifest?.installed) badge = " [installed]";
                else if (manifest?.installMode === "install_recommended") badge = " [has scripts, install recommended]";
                else if (manifest?.hasCompanionFiles) badge = " [has companion files]";
                const action = `call \`skill_get(skillId="${sc.skillId}")\``;
                return `${i + 1}. **${sc.name}**${badge} — ${sc.description.slice(0, 200)}\n   → ${action}`;
              });
              skillSection = "\n\n## Relevant skills from past experience\n\n" +
                "The following skills were distilled from similar previous tasks. " +
                "You SHOULD call `skill_get` to retrieve the full guide before attempting the task.\n\n" +
                skillLines.join("\n\n");

              ctx.log.info(`auto-recall-skill: injecting ${skillCandidates.length} skill(s): ${skillCandidates.map(s => s.name).join(", ")}`);
              try {
                store.recordApiLog("skill_search", { type: "auto_recall_skill", query }, JSON.stringify(skillCandidates), performance.now() - recallT0, true);
              } catch { /* best-effort */ }
            } else {
              ctx.log.debug("auto-recall-skill: no matching skills found");
            }
          } catch (err) {
            ctx.log.debug(`auto-recall-skill: failed: ${err}`);
          }
        }

        if (skillSection) contextParts.push(skillSection);
        const context = contextParts.join("\n");

        const recallDur = performance.now() - recallT0;
        store.recordToolCall("memory_search", recallDur, true);
        store.recordApiLog("memory_search", { type: "auto_recall", query }, JSON.stringify({
          candidates: rawLocalCandidates,
          hubCandidates: rawHubCandidates,
          filtered: filteredHits.map(h => ({ score: h.score, role: h.source.role, summary: h.summary, content: h.original_excerpt, origin: h.origin || "local", owner: h.owner || "" })),
        }), recallDur, true);
        telemetry.trackAutoRecall(filteredHits.length, recallDur);

        ctx.log.info(`auto-recall: returning prependContext (${context.length} chars), sufficient=${sufficient}, skills=${skillSection ? "yes" : "no"}`);

        if (!sufficient) {
          const searchHint =
            "\n\nIf these memories don't fully answer the question, " +
            "call `memory_search` with a shorter or rephrased query to find more.";
          return { prependContext: context + searchHint };
        }

        return {
          prependContext: context,
        };
      } catch (err) {
        const dur = performance.now() - recallT0;
        store.recordToolCall("memory_search", dur, false);
        try { store.recordApiLog("memory_search", { type: "auto_recall", query: recallQuery }, `error: ${String(err)}`, dur, false); } catch (_) { /* best-effort */ }
        ctx.log.warn(`auto-recall failed: ${String(err)}`);
      }
    });

    // ─── Auto-capture: write conversation to memory after each agent turn ───

    // Track how many messages we've already processed per session to avoid
    // re-processing the entire conversation history on every agent_end.
    // On first encounter after restart, skip all existing messages (they were
    // already processed before the restart) and only capture future increments.
    const sessionMsgCursor = new Map<string, number>();

    api.on("agent_end", async (event: any, hookCtx?: { agentId?: string; sessionKey?: string; sessionId?: string }) => {
      if (!event.success || !event.messages || event.messages.length === 0) return;

      try {
        const captureAgentId = hookCtx?.agentId ?? event?.agentId ?? event?.profileId ?? "main";
        currentAgentId = captureAgentId;
        const captureOwner = `agent:${captureAgentId}`;
        const sessionKey = hookCtx?.sessionKey ?? "default";
        ctx.log.info(`agent_end: agentId=${captureAgentId} sessionKey=${sessionKey} (from hookCtx)`);
        const cursorKey = `${sessionKey}::${captureAgentId}`;
        const allMessages = event.messages;

        if (!sessionMsgCursor.has(cursorKey)) {
          // First time seeing this session after (re)start — find the last
          // user message and capture from there (current turn only).
          let lastUserIdx = -1;
          for (let i = allMessages.length - 1; i >= 0; i--) {
            const m = allMessages[i] as Record<string, unknown>;
            if (m && m.role === "user") { lastUserIdx = i; break; }
          }
          const initCursor = lastUserIdx >= 0 ? lastUserIdx : allMessages.length;
          sessionMsgCursor.set(cursorKey, initCursor);
          ctx.log.debug(`agent_end: first encounter session=${sessionKey} agent=${captureAgentId}, initialized cursor=${initCursor} (total=${allMessages.length})`);
        }

        let cursor = sessionMsgCursor.get(cursorKey)!;

        // Session was reset — cursor exceeds current message count
        if (cursor > allMessages.length) cursor = 0;
        if (cursor >= allMessages.length) return;

        const newMessages = allMessages.slice(cursor);
        sessionMsgCursor.set(cursorKey, allMessages.length);

        ctx.log.debug(`agent_end: session=${sessionKey} total=${allMessages.length} cursor=${cursor} new=${newMessages.length}`);

        const raw: Array<{ role: string; content: string; toolName?: string }> = [];
        for (const msg of newMessages) {
          if (!msg || typeof msg !== "object") continue;
          const m = msg as Record<string, unknown>;
          const role = m.role as string;
          if (role !== "user" && role !== "assistant" && role !== "tool") continue;

          let text = "";
          if (typeof m.content === "string") {
            text = m.content;
          } else if (Array.isArray(m.content)) {
            for (const block of m.content) {
              if (!block || typeof block !== "object") continue;
              const b = block as Record<string, unknown>;
              if (b.type === "text" && typeof b.text === "string") {
                text += b.text + "\n";
              } else if (typeof b.content === "string") {
                text += b.content + "\n";
              } else if (typeof b.text === "string") {
                text += b.text + "\n";
              }
            }
          }

          text = text.trim();
          if (!text) continue;

          // Strip injected <memory_context> prefix and OpenClaw metadata wrapper
          // to store only the user's actual input
          if (role === "user") {
            const mcTag = "<memory_context>";
            const mcEnd = "</memory_context>";
            const mcIdx = text.indexOf(mcTag);
            if (mcIdx !== -1) {
              const endIdx = text.indexOf(mcEnd);
              if (endIdx !== -1) {
                text = text.slice(endIdx + mcEnd.length).trim();
              }
            }
            // Strip OpenClaw metadata envelope:
            // "Sender (untrusted metadata):\n```json\n{...}\n```\n\n[timestamp] actual message"
            const senderIdx = text.indexOf("Sender (untrusted metadata):");
            if (senderIdx !== -1) {
              const afterSender = text.slice(senderIdx);
              const fenceEnd = afterSender.indexOf("```\n", afterSender.indexOf("```json"));
              if (fenceEnd > 0) {
                const afterFence = afterSender.slice(fenceEnd + 4).replace(/^\s*\n/, "");
                if (afterFence.trim().length >= 2) text = afterFence.trim();
              } else {
                const firstDblNl = afterSender.indexOf("\n\n");
                if (firstDblNl > 0) {
                  const tail = afterSender.slice(firstDblNl + 2).trim();
                  if (tail.length >= 2) text = tail;
                }
              }
            }
            // Strip timestamp prefix like "[Thu 2026-03-05 15:23 GMT+8] "
            text = text.replace(/^\[.*?\]\s*/, "").trim();
            if (!text) continue;
          }

          const toolName = role === "tool"
            ? (m.name as string) ?? (m.toolName as string) ?? (m.tool_call_id ? "unknown" : undefined)
            : undefined;

          raw.push({ role, content: text, toolName });
        }

        // Merge consecutive assistant messages into one (OpenClaw may send reply in multiple chunks)
        const msgs: Array<{ role: string; content: string; toolName?: string }> = [];
        for (let i = 0; i < raw.length; i++) {
          const curr = raw[i];
          if (curr.role !== "assistant") {
            msgs.push(curr);
            continue;
          }
          let merged = curr.content;
          while (i + 1 < raw.length && raw[i + 1].role === "assistant") {
            i++;
            merged = merged + "\n\n" + raw[i].content;
          }
          msgs.push({ role: "assistant", content: merged.trim() });
        }

        if (msgs.length === 0) return;

        const turnId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const captured = captureMessages(msgs, sessionKey, turnId, evidenceTag, ctx.log, captureOwner);

        if (captured.length > 0) {
          worker.enqueue(captured);
          telemetry.trackMemoryIngested(captured.length);
        }

        // Incremental push: sync new chunks for already-shared tasks
        syncSharedTasksIncremental().catch((err) => {
          ctx.log.warn(`incremental sync failed: ${err}`);
        });
      } catch (err) {
        api.logger.warn(`memos-local: capture failed: ${String(err)}`);
      }
    });

    async function syncSharedTasksIncremental(): Promise<void> {
      if (!ctx.config.sharing?.enabled || ctx.config.sharing.role !== "client") return;
      const shared = store.listLocalSharedTasks();
      if (shared.length === 0) return;

      // Only sync tasks that have a hub_task_id (actively shared to remote)
      const conn = store.getClientHubConnection();
      const currentHubInstanceId = conn?.hubInstanceId || "";

      let hubClient: { hubUrl: string; userToken: string; userId: string } | undefined;
      try {
        hubClient = await resolveHubClient(store, ctx);
      } catch {
        return;
      }
      const { v4: uuidv4 } = require("uuid");

      for (const entry of shared) {
        if (!entry.hubTaskId) continue;
        if (currentHubInstanceId && entry.hubInstanceId && entry.hubInstanceId !== currentHubInstanceId) continue;
        const task = store.getTask(entry.taskId);
        if (!task) continue;
        const chunks = store.getChunksByTask(entry.taskId);
        if (chunks.length <= entry.syncedChunks) continue;

        const newChunks = chunks.slice(entry.syncedChunks);
        ctx.log.info(`incremental sync: task=${entry.taskId} pushing ${newChunks.length} new chunk(s)`);

        try {
          await hubRequestJson(hubClient.hubUrl, hubClient.userToken, "/api/v1/hub/tasks/share", {
            method: "POST",
            body: JSON.stringify({
              task: {
                id: entry.hubTaskId,
                sourceTaskId: entry.taskId,
                sourceUserId: hubClient.userId,
                title: task.title,
                summary: task.summary,
                groupId: entry.visibility === "group" ? entry.groupId ?? null : null,
                visibility: entry.visibility,
                createdAt: task.startedAt ?? task.updatedAt ?? Date.now(),
                updatedAt: task.updatedAt ?? Date.now(),
              },
              chunks: newChunks.map((chunk) => ({
                id: uuidv4(),
                hubTaskId: entry.hubTaskId,
                sourceTaskId: entry.taskId,
                sourceChunkId: chunk.id,
                sourceUserId: hubClient.userId,
                role: chunk.role,
                content: chunk.content,
                summary: chunk.summary,
                kind: chunk.kind,
                createdAt: chunk.createdAt,
              })),
            }),
          });
          store.markTaskShared(entry.taskId, entry.hubTaskId, chunks.length, entry.visibility, entry.groupId, currentHubInstanceId);
        } catch (err) {
          ctx.log.warn(`incremental sync failed for task=${entry.taskId}: ${err}`);
        }
      }
    }

    // ─── Memory Viewer (web UI) ───

    const derivedHubPort = gatewayPort + 11;

    const viewer = new ViewerServer({
      store,
      embedder,
      port: viewerPort,
      log: ctx.log,
      dataDir: stateDir,
      ctx,
      defaultHubPort: derivedHubPort,
    });
    const hubServer = ctx.config.sharing?.enabled && ctx.config.sharing.role === "hub"
      ? new HubServer({ store, log: ctx.log, config: ctx.config, dataDir: stateDir, embedder, defaultHubPort: derivedHubPort })
      : null;

    // ─── Service lifecycle ───

    let serviceStarted = false;

    const startServiceCore = async () => {
      if (serviceStarted) return;
      serviceStarted = true;

      if (hubServer) {
        const hubUrl = await hubServer.start();
        api.logger.info(`memos-local: hub started at ${hubUrl}`);
      }

      if (ctx.config.sharing?.enabled && ctx.config.sharing.role === "client") {
        try {
          const session = await connectToHub(store, ctx.config, ctx.log);
          api.logger.info(`memos-local: connected to Hub as "${session.username}" (${session.userId})`);
        } catch (err) {
          api.logger.warn(`memos-local: Hub connection failed: ${err}`);
        }
      }

      try {
        const viewerUrl = await viewer.start();
        api.logger.info(`memos-local: started (embedding: ${embedder.provider})`);
        api.logger.info(`╔══════════════════════════════════════════╗`);
        api.logger.info(`║  MemOS Memory Viewer                     ║`);
        api.logger.info(`║  → ${viewerUrl.padEnd(37)}║`);
        api.logger.info(`║  Open in browser to manage memories       ║`);
        api.logger.info(`╚══════════════════════════════════════════╝`);
        api.logger.info(`memos-local: password reset token: ${viewer.getResetToken()}`);
        api.logger.info(`memos-local: forgot password? Use the reset token on the login page.`);
        skillEvolver.recoverOrphanedTasks().then((count) => {
          if (count > 0) api.logger.info(`memos-local: recovered ${count} orphaned skill tasks`);
        }).catch((err) => {
          api.logger.warn(`memos-local: skill recovery failed: ${err}`);
        });
      } catch (err) {
        api.logger.warn(`memos-local: viewer failed to start: ${err}`);
        api.logger.info(`memos-local: started (embedding: ${embedder.provider})`);
      }
      telemetry.trackPluginStarted(
        ctx.config.embedding?.provider ?? "local",
        ctx.config.summarizer?.provider ?? "none",
      );
    };

    api.registerService({
      id: "memos-local-openclaw-plugin",
      start: async () => { await startServiceCore(); },
      stop: async () => {
        await worker.flush();
        await telemetry.shutdown();
        await hubServer?.stop();
        viewer.stop();
        store.close();
        api.logger.info("memos-local: stopped");
      },
    });

    // Fallback: OpenClaw may load this plugin via deferred reload after
    // startPluginServices has already run, so service.start() never fires.
    // Start on the next tick instead of waiting several seconds; the
    // serviceStarted guard still prevents duplicate startup if the host calls
    // service.start() immediately after registration.
    const SELF_START_DELAY_MS = 0;
    setTimeout(() => {
      if (!serviceStarted) {
        api.logger.info("memos-local: service.start() not called by host, self-starting viewer...");
        startServiceCore().catch((err) => {
          api.logger.warn(`memos-local: self-start failed: ${err}`);
        });
      }
    }, SELF_START_DELAY_MS);
  },
};

export default memosLocalPlugin;
