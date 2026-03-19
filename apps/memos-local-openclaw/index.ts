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
import { ensureSqliteBinding } from "./src/storage/ensure-binding";
import { SqliteStore } from "./src/storage/sqlite";
import { Embedder } from "./src/embedding";
import { IngestWorker } from "./src/ingest/worker";
import { RecallEngine } from "./src/recall/engine";
import { captureMessages, stripInboundMetadata } from "./src/capture";
import { DEFAULTS } from "./src/types";
import { ViewerServer } from "./src/viewer/server";
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

    const pluginCfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
    const stateDir = api.resolvePath("~/.openclaw");
    const ctx = buildContext(stateDir, process.cwd(), pluginCfg as any, {
      debug: (msg: string) => api.logger.info(`[debug] ${msg}`),
      info: (msg: string) => api.logger.info(msg),
      warn: (msg: string) => api.logger.warn(msg),
      error: (msg: string) => api.logger.warn(`[error] ${msg}`),
    });

    ensureSqliteBinding(ctx.log);

    const store = new SqliteStore(ctx.config.storage!.dbPath!, ctx.log);
    const embedder = new Embedder(ctx.config.embedding, ctx.log);
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
    const telemetry = new Telemetry(ctx.config.telemetry ?? {}, stateDir, pluginVersion, ctx.log);

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
        if (Array.isArray(allow) && allow.length > 0 && !allow.includes("group:plugins")) {
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

    const summarizer = new Summarizer(ctx.config.summarizer, ctx.log);

    api.logger.info(`memos-local: initialized (db: ${ctx.config.storage!.dbPath})`);

    // Current agent ID — updated by hooks, read by tools for owner isolation.
    // Falls back to "main" when no hook has fired yet (single-agent setups).
    let currentAgentId = "main";

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
            if (det && Array.isArray(det.candidates)) {
              outputText = JSON.stringify({
                candidates: det.candidates,
                filtered: det.hits ?? det.filtered ?? [],
              });
            } else {
              outputText = result?.content?.[0]?.text ?? JSON.stringify(result ?? "");
            }
            store.recordApiLog(toolName, { ...inputParams, type: "tool_call" }, outputText, dur, ok);
          } catch (_) { /* best-effort */ }
        }
      };

    // ─── Tool: memory_search ───

    api.registerTool(
      {
        name: "memory_search",
        label: "Memory Search",
        description:
          "Search long-term conversation memory for past conversations, user preferences, decisions, and experiences. " +
          "Relevant memories are automatically injected at the start of each turn, but call this tool when you need " +
          "to search with a different query or the auto-recalled context is insufficient. " +
          "Pass only a short natural-language query (2-5 key words).",
        parameters: Type.Object({
          query: Type.String({ description: "Short natural language search query (2-5 key words)" }),
        }),
        execute: trackTool("memory_search", async (_toolCallId: any, params: any) => {
          const { query } = params as { query: string };
          const role = undefined;
          const minScore = undefined;

          const agentId = currentAgentId;
          const ownerFilter = [`agent:${agentId}`, "public"];
          const effectiveMaxResults = 10;
          ctx.log.debug(`memory_search query="${query}" maxResults=${effectiveMaxResults} minScore=${minScore ?? 0.45} role=${role ?? "all"} owner=agent:${agentId}`);
          const result = await engine.search({ query, maxResults: effectiveMaxResults, minScore, role, ownerFilter });
          ctx.log.debug(`memory_search raw candidates: ${result.hits.length}`);

          const rawCandidates = result.hits.map((h) => ({
            chunkId: h.ref.chunkId,
            role: h.source.role,
            score: h.score,
            summary: h.summary,
            original_excerpt: (h.original_excerpt ?? "").slice(0, 200),
          }));

          if (result.hits.length === 0) {
            return {
              content: [{ type: "text", text: result.meta.note ?? "No relevant memories found." }],
              details: { candidates: [], meta: result.meta },
            };
          }

          // LLM relevance + sufficiency filtering
          let filteredHits = result.hits;
          let sufficient = false;

          const candidates = result.hits.map((h, i) => ({
            index: i + 1,
            role: h.source.role,
            content: (h.original_excerpt ?? "").slice(0, 300),
            time: h.source.ts ? new Date(h.source.ts).toISOString().slice(0, 16) : "",
          }));

          const filterResult = await summarizer.filterRelevant(query, candidates);
          if (filterResult !== null) {
            sufficient = filterResult.sufficient;
            if (filterResult.relevant.length > 0) {
              const indexSet = new Set(filterResult.relevant);
              filteredHits = result.hits.filter((_, i) => indexSet.has(i + 1));
              ctx.log.debug(`memory_search LLM filter: ${result.hits.length} → ${filteredHits.length} hits, sufficient=${sufficient}`);
            } else {
              return {
                content: [{ type: "text", text: "No relevant memories found for this query." }],
                details: { candidates: rawCandidates, filtered: [], meta: result.meta },
              };
            }
          }

          if (filteredHits.length === 0) {
            return {
              content: [{ type: "text", text: "No relevant memories found for this query." }],
              details: { candidates: rawCandidates, filtered: [], meta: result.meta },
            };
          }

          const beforeDedup = filteredHits.length;
          filteredHits = deduplicateHits(filteredHits);
          ctx.log.debug(`memory_search dedup: ${beforeDedup} → ${filteredHits.length}`);

          const lines = filteredHits.map((h, i) => {
            const excerpt = h.original_excerpt;
            const parts = [`${i + 1}. [${h.source.role}]`];
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

          let tipsText = "";
          if (!sufficient) {
            const hasTask = filteredHits.some((h) => {
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

            if (tips.length > 0) {
              tipsText = "\n\nThese memories may not be enough. You can fetch more context:\n" + tips.join("\n");
            }
          }

          return {
            content: [
              {
                type: "text",
                text: `Found ${filteredHits.length} relevant memories:\n\n${lines.join("\n\n")}${tipsText}`,
              },
            ],
            details: {
              candidates: rawCandidates,
              hits: filteredHits.map((h) => {
                let effectiveTaskId = h.taskId;
                if (effectiveTaskId) {
                  const t = store.getTask(effectiveTaskId);
                  if (t && t.status === "skipped") effectiveTaskId = null;
                }
                return {
                  chunkId: h.ref.chunkId,
                  taskId: effectiveTaskId,
                  skillId: h.skillId,
                  role: h.source.role,
                  score: h.score,
                  summary: h.summary,
                  original_excerpt: (h.original_excerpt ?? "").slice(0, 200),
                };
              }),
              meta: result.meta,
            },
          };
        }),
      },
      { name: "memory_search" },
    );

    // ─── Tool: memory_timeline ───

    api.registerTool(
      {
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
          ctx.log.debug(`memory_timeline called (agent=${currentAgentId})`);
          const { chunkId, window: win } = params as {
            chunkId: string;
            window?: number;
          };

          const ownerFilter = [`agent:${currentAgentId}`, "public"];
          const anchorChunk = store.getChunkForOwners(chunkId, ownerFilter);
          if (!anchorChunk) {
            return {
              content: [{ type: "text", text: `Chunk not found: ${chunkId}` }],
              details: { error: "not_found" },
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
      },
      { name: "memory_timeline" },
    );

    // ─── Tool: memory_get ───

    api.registerTool(
      {
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

          const ownerFilter = [`agent:${currentAgentId}`, "public"];
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
      },
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

          return {
            content: [{
              type: "text",
              text: `## Skill: ${skill.name} (v${skill.version})\n\n${sv.content}\n\n---\nTo install this skill for persistent use: call skill_install(skillId="${resolvedSkillId}")`,
            }],
            details: {
              skillId: skill.id,
              name: skill.name,
              version: skill.version,
              status: skill.status,
              installed: skill.installed,
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

    // ─── Tool: memory_viewer ───

    const viewerPort = (pluginCfg as any).viewerPort ?? 18799;

    api.registerTool(
      {
        name: "memory_viewer",
        label: "Open Memory Viewer",
        description:
          "Show the MemOS Memory Viewer URL. Call this when the user asks how to view, browse, manage, " +
          "or access their stored memories, or asks where the memory dashboard is. " +
          "Returns the URL the user can open in their browser.",
        parameters: Type.Object({}),
        execute: trackTool("memory_viewer", async () => {
          ctx.log.debug(`memory_viewer called`);
          telemetry.trackViewerOpened();
          const url = `http://127.0.0.1:${viewerPort}`;
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
      },
      { name: "memory_viewer" },
    );

    // ─── Tool: memory_write_public ───

    api.registerTool(
      {
        name: "memory_write_public",
        label: "Write Public Memory",
        description:
          "Write a piece of information to public memory. Public memories are visible to all agents during memory_search. " +
          "Use this for shared knowledge, team decisions, or cross-agent coordination information.",
        parameters: Type.Object({
          content: Type.String({ description: "The content to write to public memory" }),
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
            content: [{ type: "text", text: `Public memory written successfully (id: ${chunkId}).` }],
            details: { chunkId, owner: "public" },
          };
        }),
      },
      { name: "memory_write_public" },
    );

    // ─── Tool: skill_search ───

    api.registerTool(
      {
        name: "skill_search",
        label: "Skill Search",
        description:
          "Search available skills by natural language. Searches your own skills, public skills, or both. " +
          "Use when you need a capability or guide and don't have a matching skill at hand.",
        parameters: Type.Object({
          query: Type.String({ description: "Natural language description of the needed skill" }),
          scope: Type.Optional(Type.String({ description: "Search scope: 'mix' (default, self + public), 'self' (own only), 'public' (public only)" })),
        }),
        execute: trackTool("skill_search", async (_toolCallId: any, params: any) => {
          const { query: skillQuery, scope: rawScope } = params as { query: string; scope?: string };
          const scope = (rawScope === "self" || rawScope === "public") ? rawScope : "mix";
          const currentOwner = `agent:${currentAgentId}`;

          const hits = await engine.searchSkills(skillQuery, scope as any, currentOwner);

          if (hits.length === 0) {
            return {
              content: [{ type: "text", text: `No relevant skills found for: "${skillQuery}" (scope: ${scope})` }],
              details: { query: skillQuery, scope, hits: [] },
            };
          }

          const text = hits.map((h, i) =>
            `${i + 1}. [${h.name}] ${h.description}${h.visibility === "public" ? " (public)" : ""}`,
          ).join("\n");

          return {
            content: [{ type: "text", text: `Found ${hits.length} skills:\n\n${text}` }],
            details: { query: skillQuery, scope, hits },
          };
        }),
      },
      { name: "skill_search" },
    );

    // ─── Tool: skill_publish ───

    api.registerTool(
      {
        name: "skill_publish",
        label: "Publish Skill",
        description: "Make a skill public so other agents can discover and install it via skill_search.",
        parameters: Type.Object({
          skillId: Type.String({ description: "The skill ID to publish" }),
        }),
        execute: trackTool("skill_publish", async (_toolCallId: any, params: any) => {
          const { skillId: pubSkillId } = params as { skillId: string };
          const skill = store.getSkill(pubSkillId);
          if (!skill) {
            return { content: [{ type: "text", text: `Skill not found: ${pubSkillId}` }] };
          }
          store.setSkillVisibility(pubSkillId, "public");
          return {
            content: [{ type: "text", text: `Skill "${skill.name}" is now public.` }],
            details: { skillId: pubSkillId, name: skill.name, visibility: "public" },
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
        description: "Make a skill private. Other agents will no longer be able to discover it.",
        parameters: Type.Object({
          skillId: Type.String({ description: "The skill ID to unpublish" }),
        }),
        execute: trackTool("skill_unpublish", async (_toolCallId: any, params: any) => {
          const { skillId: unpubSkillId } = params as { skillId: string };
          const skill = store.getSkill(unpubSkillId);
          if (!skill) {
            return { content: [{ type: "text", text: `Skill not found: ${unpubSkillId}` }] };
          }
          store.setSkillVisibility(unpubSkillId, "private");
          return {
            content: [{ type: "text", text: `Skill "${skill.name}" is now private.` }],
            details: { skillId: unpubSkillId, name: skill.name, visibility: "private" },
          };
        }),
      },
      { name: "skill_unpublish" },
    );

    // ─── Auto-recall: inject relevant memories before agent starts ───

    api.on("before_agent_start", async (event: { prompt?: string; messages?: unknown[] }, hookCtx?: { agentId?: string; sessionKey?: string }) => {
      if (!allowPromptInjection) return {};
      if (!event.prompt || event.prompt.length < 3) return;

      const recallAgentId = hookCtx?.agentId ?? "main";
      currentAgentId = recallAgentId;
      const recallOwnerFilter = [`agent:${recallAgentId}`, "public"];
      ctx.log.info(`auto-recall: agentId=${recallAgentId} (from hookCtx)`);

      const recallT0 = performance.now();
      let recallQuery = "";

      try {
        const rawPrompt = event.prompt;
        ctx.log.debug(`auto-recall: rawPrompt="${rawPrompt.slice(0, 300)}"`);

        let query = rawPrompt;
        const senderTag = "Sender (untrusted metadata):";
        const senderPos = rawPrompt.indexOf(senderTag);
        if (senderPos !== -1) {
          const afterSender = rawPrompt.slice(senderPos);
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
        recallQuery = query;

        if (query.length < 2) {
          ctx.log.debug("auto-recall: extracted query too short, skipping");
          return;
        }
        ctx.log.debug(`auto-recall: query="${query.slice(0, 80)}"`);

        const result = await engine.search({ query, maxResults: 10, minScore: 0.45, ownerFilter: recallOwnerFilter });
        if (result.hits.length === 0) {
          ctx.log.debug("auto-recall: no candidates found");
          const dur = performance.now() - recallT0;
          store.recordToolCall("memory_search", dur, true);
          store.recordApiLog("memory_search", { type: "auto_recall", query }, JSON.stringify({ candidates: [], filtered: [] }), dur, true);
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

        const candidates = result.hits.map((h, i) => ({
          index: i + 1,
          role: h.source.role,
          content: (h.original_excerpt ?? "").slice(0, 300),
          time: h.source.ts ? new Date(h.source.ts).toISOString().slice(0, 16) : "",
        }));

        let filteredHits = result.hits;
        let sufficient = false;

        const filterResult = await summarizer.filterRelevant(query, candidates);
        if (filterResult !== null) {
          sufficient = filterResult.sufficient;
          if (filterResult.relevant.length > 0) {
            const indexSet = new Set(filterResult.relevant);
            filteredHits = result.hits.filter((_, i) => indexSet.has(i + 1));
          } else {
            ctx.log.debug("auto-recall: LLM filter returned no relevant hits");
            const dur = performance.now() - recallT0;
            store.recordToolCall("memory_search", dur, true);
            store.recordApiLog("memory_search", { type: "auto_recall", query }, JSON.stringify({
              candidates: result.hits.map(h => ({ score: h.score, role: h.source.role, summary: h.summary, content: h.original_excerpt })),
              filtered: []
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
        ctx.log.debug(`auto-recall: ${result.hits.length} → ${beforeDedup} relevant → ${filteredHits.length} after dedup, sufficient=${sufficient}`);

        const lines = filteredHits.map((h, i) => {
          const excerpt = h.original_excerpt;
          const parts: string[] = [`${i + 1}. [${h.source.role}]`];
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
        const context = contextParts.join("\n");

        const recallDur = performance.now() - recallT0;
        store.recordToolCall("memory_search", recallDur, true);
        store.recordApiLog("memory_search", { type: "auto_recall", query }, JSON.stringify({
          candidates: result.hits.map(h => ({ score: h.score, role: h.source.role, summary: h.summary, content: h.original_excerpt })),
          filtered: filteredHits.map(h => ({ score: h.score, role: h.source.role, summary: h.summary, content: h.original_excerpt }))
        }), recallDur, true);
        telemetry.trackAutoRecall(filteredHits.length, recallDur);

        ctx.log.info(`auto-recall: returning prependContext (${context.length} chars), sufficient=${sufficient}`);

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
        const captureAgentId = hookCtx?.agentId ?? "main";
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
      } catch (err) {
        api.logger.warn(`memos-local: capture failed: ${String(err)}`);
      }
    });

    // ─── Memory Viewer (web UI) ───

    const viewer = new ViewerServer({
      store,
      embedder,
      port: viewerPort,
      log: ctx.log,
      dataDir: stateDir,
      ctx,
    });

    // ─── Service lifecycle ───

    api.registerService({
      id: "memos-local-openclaw-plugin",
      start: async () => {
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
      },
      stop: async () => {
        await telemetry.shutdown();
        viewer.stop();
        store.close();
        api.logger.info("memos-local: stopped");
      },
    });
  },
};

export default memosLocalPlugin;
