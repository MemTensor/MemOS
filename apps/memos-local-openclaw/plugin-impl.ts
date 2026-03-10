/**
 * MemOS Local Plugin Implementation — loaded by index.ts after ensuring deps.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { buildContext } from "./src/config";
import { SqliteStore } from "./src/storage/sqlite";
import { Embedder } from "./src/embedding";
import { IngestWorker } from "./src/ingest/worker";
import { RecallEngine } from "./src/recall/engine";
import { captureMessages } from "./src/capture";
import { DEFAULTS } from "./src/types";
import { ViewerServer } from "./src/viewer/server";
import { SkillEvolver } from "./src/skill/evolver";

function ownerFilterFor(agentId: string | undefined): string[] {
  const resolvedAgentId = agentId && agentId.trim().length > 0 ? agentId : "main";
  return [`agent:${resolvedAgentId}`, "public"];
}

const pluginConfigSchema = {
  type: "object" as const,
  additionalProperties: true,
  properties: {
    embedding: {
      type: "object" as const,
      properties: {
        provider: { type: "string" as const },
        endpoint: { type: "string" as const },
        apiKey: { type: "string" as const },
        model: { type: "string" as const },
      },
    },
    summarizer: {
      type: "object" as const,
      properties: {
        provider: { type: "string" as const },
        endpoint: { type: "string" as const },
        apiKey: { type: "string" as const },
        model: { type: "string" as const },
        temperature: { type: "number" as const },
      },
    },
    viewerPort: { type: "number" as const },
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
    "Provides memory_search, memory_timeline, memory_get for progressive recall.",
  kind: "memory" as const,
  configSchema: pluginConfigSchema,

  register(api: OpenClawPluginApi) {
    const pluginCfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
    const stateDir = api.resolvePath("~/.openclaw");
    const ctx = buildContext(stateDir, process.cwd(), pluginCfg as any, {
      debug: (msg: string) => api.logger.info(`[debug] ${msg}`),
      info: (msg: string) => api.logger.info(msg),
      warn: (msg: string) => api.logger.warn(msg),
      error: (msg: string) => api.logger.warn(`[error] ${msg}`),
    });

    const store = new SqliteStore(ctx.config.storage!.dbPath!, ctx.log);
    const embedder = new Embedder(ctx.config.embedding, ctx.log);
    const worker = new IngestWorker(store, embedder, ctx);
    const engine = new RecallEngine(store, embedder, ctx);
    const evidenceTag = ctx.config.capture?.evidenceWrapperTag ?? DEFAULTS.evidenceWrapperTag;

    api.logger.info(`memos-local: initialized (db: ${ctx.config.storage!.dbPath})`);

    // ─── Tool: memory_search ───

    api.registerTool(
      {
        name: "memory_search",
        label: "Memory Search",
        description:
          "Search stored conversation memories. Returns summary, original_excerpt (evidence), score, and ref. " +
          "Default: top 6, minScore 0.45. Increase maxResults to 12/20 or lower minScore to 0.35 if needed.",
        parameters: Type.Object({
          query: Type.String({ description: "Natural language search query" }),
          maxResults: Type.Optional(Type.Number({ description: "Max results (default 6, max 20)" })),
          minScore: Type.Optional(Type.Number({ description: "Min score 0-1 (default 0.45, floor 0.35)" })),
        }),
        async execute(_toolCallId, params, context) {
          const { query, maxResults, minScore } = params as {
            query: string;
            maxResults?: number;
            minScore?: number;
          };

          const agentId = (context as any)?.agentId ?? "main";
          const ownerFilter = ownerFilterFor(agentId);
          const result = await engine.search({ query, maxResults, minScore, ownerFilter });

          if (result.hits.length === 0) {
            return {
              content: [{ type: "text", text: result.meta.note ?? "No relevant memories found." }],
              details: { meta: result.meta },
            };
          }

          const roleLabel = (r: string) => r === "user" ? "[USER said]" : r === "assistant" ? "[ASSISTANT replied]" : r === "tool" ? "[TOOL returned]" : `[${r.toUpperCase()}]`;

          const text = result.hits
            .map(
              (h, i) =>
                `${i + 1}. ${roleLabel(h.source.role)} [score=${h.score}] ${h.summary}\n   Evidence: ${h.original_excerpt.slice(0, 200)}`,
            )
            .join("\n\n");

          return {
            content: [
              {
                type: "text",
                text: `Found ${result.hits.length} memories (minScore=${result.meta.usedMinScore}):\n\n${text}`,
              },
            ],
            details: {
              hits: result.hits.map((h) => ({
                role: h.source.role,
                summary: h.summary,
                original_excerpt: h.original_excerpt,
                ref: h.ref,
                score: h.score,
                source: h.source,
              })),
              meta: result.meta,
            },
          };
        },
      },
      { name: "memory_search" },
    );

    // ─── Tool: memory_timeline ───

    api.registerTool(
      {
        name: "memory_timeline",
        label: "Memory Timeline",
        description:
          "Get neighboring context around a memory ref. Use after memory_search to expand context.",
        parameters: Type.Object({
          sessionKey: Type.String({ description: "From search hit ref.sessionKey" }),
          chunkId: Type.String({ description: "From search hit ref.chunkId" }),
          turnId: Type.String({ description: "From search hit ref.turnId" }),
          seq: Type.Number({ description: "From search hit ref.seq" }),
          window: Type.Optional(Type.Number({ description: "Context window ±N (default 2)" })),
        }),
        async execute(_toolCallId, params, context) {
          const { sessionKey, chunkId, turnId, seq, window: win } = params as {
            sessionKey: string;
            chunkId: string;
            turnId: string;
            seq: number;
            window?: number;
          };

          const agentId = (context as any)?.agentId ?? "main";
          const ownerFilter = ownerFilterFor(agentId);
          const w = win ?? DEFAULTS.timelineWindowDefault;
          const anchorChunk = store.getChunkForOwners(chunkId, ownerFilter);
          if (!anchorChunk) {
            return {
              content: [{ type: "text", text: "Timeline (0 entries):\n\n" }],
              details: { entries: [], anchorRef: { sessionKey, chunkId, turnId, seq } },
            };
          }
          const neighbors = store.getNeighborChunks(sessionKey, turnId, seq, w, ownerFilter);
          const anchorTs = anchorChunk?.createdAt ?? 0;

          const entries = neighbors.map((chunk) => {
            let relation: "before" | "current" | "after" = "before";
            if (chunk.id === chunkId) relation = "current";
            else if (chunk.createdAt > anchorTs) relation = "after";

            return {
              relation,
              role: chunk.role,
              excerpt: chunk.content.slice(0, DEFAULTS.excerptMaxChars),
              ts: chunk.createdAt,
            };
          });

          const rl = (r: string) => r === "user" ? "USER" : r === "assistant" ? "ASSISTANT" : r.toUpperCase();
          const text = entries
            .map((e) => `[${e.relation}] ${rl(e.role)}: ${e.excerpt.slice(0, 150)}`)
            .join("\n");

          return {
            content: [{ type: "text", text: `Timeline (${entries.length} entries):\n\n${text}` }],
            details: { entries, anchorRef: { sessionKey, chunkId, turnId, seq } },
          };
        },
      },
      { name: "memory_timeline" },
    );

    // ─── Tool: memory_get ───

    api.registerTool(
      {
        name: "memory_get",
        label: "Memory Get",
        description:
          "Get full original text of a memory chunk. Use to verify exact details from a search hit.",
        parameters: Type.Object({
          chunkId: Type.String({ description: "From search hit ref.chunkId" }),
          maxChars: Type.Optional(
            Type.Number({ description: `Max chars (default ${DEFAULTS.getMaxCharsDefault}, max ${DEFAULTS.getMaxCharsMax})` }),
          ),
        }),
        async execute(_toolCallId, params, context) {
          const { chunkId, maxChars } = params as { chunkId: string; maxChars?: number };
          const limit = Math.min(maxChars ?? DEFAULTS.getMaxCharsDefault, DEFAULTS.getMaxCharsMax);

          const agentId = (context as any)?.agentId ?? "main";
          const chunk = store.getChunkForOwners(chunkId, ownerFilterFor(agentId));
          if (!chunk) {
            return {
              content: [{ type: "text", text: `Chunk not found: ${chunkId}` }],
              details: { error: "not_found" },
            };
          }

          const content = chunk.content.length > limit
            ? chunk.content.slice(0, limit) + "…"
            : chunk.content;

          const who = chunk.role === "user" ? "USER said" : chunk.role === "assistant" ? "ASSISTANT replied" : chunk.role === "tool" ? "TOOL returned" : chunk.role.toUpperCase();

          return {
            content: [{ type: "text", text: `[${who}] (session: ${chunk.sessionKey})\n\n${content}` }],
            details: {
              ref: { sessionKey: chunk.sessionKey, chunkId: chunk.id, turnId: chunk.turnId, seq: chunk.seq },
              source: { ts: chunk.createdAt, role: chunk.role, sessionKey: chunk.sessionKey },
            },
          };
        },
      },
      { name: "memory_get" },
    );

    // ─── Tool: memory_viewer ───

    const viewerPort = (pluginCfg as any).viewerPort ?? 18799;

    api.registerTool(
      {
        name: "memory_viewer",
        label: "Open Memory Viewer",
        description:
          "Open the MemOS Memory Viewer web dashboard. Returns the URL the user can open in their browser to visually browse, search, and manage all stored memories.",
        parameters: Type.Object({}),
        async execute() {
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
        },
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
        async execute(_toolCallId, params) {
          const { content, summary } = params as { content: string; summary?: string };
          if (!content || !content.trim()) {
            return { content: [{ type: "text", text: "Content cannot be empty." }] };
          }

          const { v4: uuidv4 } = await import("uuid");
          const now = Date.now();
          const chunkId = uuidv4();
          const chunkSummary = summary ?? content.slice(0, 200);

          store.insertChunk({
            id: chunkId,
            sessionKey: "public",
            turnId: `public-${now}`,
            seq: 0,
            role: "assistant",
            content: content.trim(),
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
        },
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
        async execute(_toolCallId, params, context) {
          const { query, scope: rawScope } = params as { query: string; scope?: string };
          const scope = (rawScope === "self" || rawScope === "public") ? rawScope : "mix";
          const agentId = (context as any)?.agentId ?? "main";
          const currentOwner = `agent:${agentId}`;

          const hits = await engine.searchSkills(query, scope as any, currentOwner);

          if (hits.length === 0) {
            return {
              content: [{ type: "text", text: `No relevant skills found for: "${query}" (scope: ${scope})` }],
              details: { query, scope, hits: [] },
            };
          }

          const text = hits.map((h, i) =>
            `${i + 1}. [${h.name}] ${h.description.slice(0, 150)}${h.visibility === "public" ? " (public)" : ""}`,
          ).join("\n");

          return {
            content: [{ type: "text", text: `Found ${hits.length} skills:\n\n${text}` }],
            details: { query, scope, hits },
          };
        },
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
        async execute(_toolCallId, params) {
          const { skillId } = params as { skillId: string };
          const skill = store.getSkill(skillId);
          if (!skill) {
            return { content: [{ type: "text", text: `Skill not found: ${skillId}` }] };
          }
          store.setSkillVisibility(skillId, "public");
          return {
            content: [{ type: "text", text: `Skill "${skill.name}" is now public.` }],
            details: { skillId, name: skill.name, visibility: "public" },
          };
        },
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
        async execute(_toolCallId, params) {
          const { skillId } = params as { skillId: string };
          const skill = store.getSkill(skillId);
          if (!skill) {
            return { content: [{ type: "text", text: `Skill not found: ${skillId}` }] };
          }
          store.setSkillVisibility(skillId, "private");
          return {
            content: [{ type: "text", text: `Skill "${skill.name}" is now private.` }],
            details: { skillId, name: skill.name, visibility: "private" },
          };
        },
      },
      { name: "skill_unpublish" },
    );

    // ─── Auto-capture: write conversation to memory after each agent turn ───

    api.on("agent_end", async (event) => {
      if (!event.success || !event.messages || event.messages.length === 0) return;

      try {
        const agentId = (event as any).agentId ?? "main";
        const owner = `agent:${agentId}`;

        const msgs: Array<{ role: string; content: string; toolName?: string }> = [];
        for (const msg of event.messages) {
          if (!msg || typeof msg !== "object") continue;
          const m = msg as Record<string, unknown>;
          const role = m.role as string;
          if (role !== "user" && role !== "assistant" && role !== "tool") continue;

          let text = "";
          if (typeof m.content === "string") {
            text = m.content;
          } else if (Array.isArray(m.content)) {
            for (const block of m.content) {
              if (block && typeof block === "object" && (block as any).type === "text") {
                text += (block as any).text + "\n";
              }
            }
          }

          if (!text.trim()) continue;

          const toolName = role === "tool"
            ? (m.name as string) ?? (m.toolName as string) ?? (m.tool_call_id ? "unknown" : undefined)
            : undefined;

          msgs.push({ role, content: text.trim(), toolName });
        }

        if (msgs.length === 0) return;

        const sessionKey = (event as any).sessionKey ?? "default";
        const turnId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const captured = captureMessages(msgs, sessionKey, turnId, evidenceTag, ctx.log, owner);
        if (captured.length > 0) {
          worker.enqueue(captured);
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

          const skillEnabled = ctx.config.skillEvolution?.enabled ?? DEFAULTS.skillEvolutionEnabled;
          if (skillEnabled) {
            const recallEngine = new RecallEngine(store, embedder, ctx);
            const evolver = new SkillEvolver(store, recallEngine, ctx, embedder);
            evolver.recoverOrphanedTasks().then((count) => {
              if (count > 0) api.logger.info(`memos-local: recovered ${count} orphaned skill tasks`);
            }).catch((err) => {
              api.logger.warn(`memos-local: skill recovery failed: ${err}`);
            });
          }
        } catch (err) {
          api.logger.warn(`memos-local: viewer failed to start: ${err}`);
          api.logger.info(`memos-local: started (embedding: ${embedder.provider})`);
        }
      },
      stop: async () => {
        viewer.stop();
        await worker.flush();
        store.close();
        api.logger.info("memos-local: stopped");
      },
    });
  },
};

export default memosLocalPlugin;
