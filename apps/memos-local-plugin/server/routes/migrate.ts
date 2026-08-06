/**
 * Legacy-DB migration endpoints (one-shot).
 *
 *   GET  /api/v1/migrate/legacy/scan   → open the **current agent's**
 *                                        legacy sqlite file in
 *                                        read-only mode and count how
 *                                        many rows we could import.
 *                                        Safe to call repeatedly.
 *   POST /api/v1/migrate/legacy/run    → actually copy the rows over.
 *                                        Returns per-type counts.
 *
 * The agent is taken from `options.agent` (the same flag that
 * controls the multi-agent path prefix in `server/http.ts`). If it's
 * absent we default to `openclaw` so existing call-sites keep working.
 *
 * Each agent's legacy plugin shipped with its own on-disk layout:
 *
 *   openclaw → ~/.openclaw/memos-local/memos.db
 *   hermes   → ~/.hermes/memos-state/memos-local/memos.db
 *
 * The schema (chunks/skills/tasks) is the same across both, so the
 * import logic itself is agent-agnostic — only the source path differs.
 *
 * Backwards-compat aliases:
 *   /api/v1/migrate/openclaw/{scan,run} → always openclaw path
 *   /api/v1/migrate/hermes/{scan,run}   → always hermes path
 *
 * Schema map (legacy → new):
 *
 *   chunks(id, session_key, turn_id, seq, role, content, summary, created_at)
 *     ↓
 *   traces(id, session_id, episode_id, user_text, agent_text, summary, ts)
 *     + upsert synthetic session + closed episode per `session_key` so
 *       the `traces.episode_id REFERENCES episodes(id)` FK is satisfied.
 *       (The previous implementation skipped this step and every row
 *       failed → "Imported 0" bug.)
 *
 *   skills(id, name, description, status, created_at, updated_at)
 *     ↓
 *   skills(id, name, status, invocationGuide=description, eta=0, ...)
 *
 *   tasks(id, session_key, title, summary, status, started_at, ended_at)
 *     ↓
 *   NOT imported as new "tasks" (we don't have a tasks table); tracked
 *   in the response under `skipped.tasks` so the viewer can tell the
 *   user why the scan count doesn't match.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { rootLogger } from "../../core/logger/index.js";
import type { ServerDeps, ServerOptions } from "../types.js";
import { writeError, type Routes, type RouteContext } from "./registry.js";
import type { TraceDTO, SkillDTO } from "../../agent-contract/dto.js";

type LegacyAgent = "openclaw" | "hermes";

const log = rootLogger.child({ channel: "server.migrate" });

/**
 * Per-agent on-disk layout of the legacy plugin's SQLite file.
 *
 * Note the `hermes` extra `memos-state` segment: the legacy hermes
 * plugin nested its data under `~/.hermes/memos-state/...` while
 * openclaw kept it directly under `~/.openclaw/memos-local/...`.
 */
function legacyDbPath(agent: LegacyAgent): string {
  switch (agent) {
    case "hermes":
      return join(homedir(), ".hermes", "memos-state", "memos-local", "memos.db");
    case "openclaw":
    default:
      return join(homedir(), ".openclaw", "memos-local", "memos.db");
  }
}

function resolveAgent(options: ServerOptions | undefined): LegacyAgent {
  const a = options?.agent;
  if (a === "hermes") return "hermes";
  return "openclaw";
}

export function registerMigrateRoutes(
  routes: Routes,
  deps: ServerDeps,
  options: ServerOptions = {},
): void {
  const currentAgent = resolveAgent(options);

  // ── Generic, agent-aware endpoints (preferred). Pick the source
  //    DB based on the running agent; the viewer uses these. ──────────
  routes.set("GET /api/v1/migrate/legacy/scan", async () => scanFor(currentAgent));
  routes.set("POST /api/v1/migrate/legacy/run", async (ctx) =>
    runFor(ctx, deps, currentAgent),
  );

  // ── Explicit per-agent aliases (back-compat + tests). ─────────────
  routes.set("GET /api/v1/migrate/openclaw/scan", async () => scanFor("openclaw"));
  routes.set("POST /api/v1/migrate/openclaw/run", async (ctx) =>
    runFor(ctx, deps, "openclaw"),
  );
  routes.set("GET /api/v1/migrate/hermes/scan", async () => scanFor("hermes"));
  routes.set("POST /api/v1/migrate/hermes/run", async (ctx) =>
    runFor(ctx, deps, "hermes"),
  );
}

interface ScanResult {
  found: boolean;
  path: string;
  agent: LegacyAgent;
  candidates?: { traces: number; skills: number; tasks: number };
  error?: string;
}

async function scanFor(agent: LegacyAgent): Promise<ScanResult> {
  const path = legacyDbPath(agent);
  log.debug("scan", { agent, path });
  if (!existsSync(path)) {
    return { found: false, agent, path };
  }
  try {
    const { default: Sqlite } = await import("better-sqlite3");
    const db = new Sqlite(path, { readonly: true });
    try {
      const counts = countLegacyRows(db);
      return { found: true, agent, path, candidates: counts };
    } finally {
      db.close();
    }
  } catch (err) {
    return {
      found: true,
      agent,
      path,
      candidates: { traces: 0, skills: 0, tasks: 0 },
      error: (err as Error).message,
    };
  }
}

async function runFor(
  ctx: RouteContext,
  deps: ServerDeps,
  agent: LegacyAgent,
): Promise<unknown> {
  const path = legacyDbPath(agent);
  log.info("run.start", { agent, path });
  if (!existsSync(path)) {
    writeError(ctx, 404, "not_found", `legacy db not found at ${path}`);
    return;
  }
  try {
    const { default: Sqlite } = await import("better-sqlite3");
    const db = new Sqlite(path, { readonly: true });
    try {
      const legacyChunks = readLegacyChunks(db);
      const legacySkills = readLegacySkills(db);
      const legacyTasks = readLegacyTasks(db);

      // Group chunks by (session_key, turn_id) into turns so a
      // user↔assistant pair becomes a single trace (matches the new
      // model). Tools/system/other rows get their own trace with
      // role-based text placement.
      const traces: TraceDTO[] = buildTracesFromChunks(legacyChunks);
      const skills: SkillDTO[] = legacySkills.map((s) => ({
        id: s.id,
        name: s.name || s.id,
        status: legacySkillStatus(s.status),
        invocationGuide: s.description ?? "",
        // Imported skills don't carry decision guidance / evidence
        // anchors — those live on the rows produced by the live
        // crystallizer, not in legacy SQLite dumps.
        decisionGuidance: { preference: [], antiPattern: [] },
        evidenceAnchors: [],
        eta: 0 as never,
        support: 0,
        gain: 0,
        sourcePolicyIds: [],
        sourceWorldModelIds: [],
        createdAt: (Number(s.created_at) || Date.now()) as never,
        updatedAt: (Number(s.updated_at) || Date.now()) as never,
        version: 1,
      }));

      const bundle = {
        version: 1 as const,
        traces,
        policies: [],
        worldModels: [],
        skills,
      };
      const res = await deps.core.importBundle(bundle);
      log.audit("run.done", {
        agent,
        path,
        candidates: { traces: traces.length, skills: skills.length, tasks: legacyTasks.length },
        imported: res.imported,
        skipped: res.skipped,
      });

      return {
        agent,
        path,
        imported: {
          traces: Math.max(0, res.imported - skills.length),
          // We can't tell which of `res.imported` came from which
          // array with the current importBundle signature, so we
          // surface totals separately:
          totalImported: res.imported,
          skills: skills.length,
          tasks: 0,
        },
        skipped: {
          total: res.skipped,
          tasks: legacyTasks.length,
          reason_tasks:
            "tasks are now represented as episodes — legacy tasks rows were not imported (tracked as skipped)",
        },
        candidates: {
          traces: traces.length,
          skills: skills.length,
          tasks: legacyTasks.length,
        },
      };
    } finally {
      db.close();
    }
  } catch (err) {
    log.error("run.failed", { agent, path, err });
    writeError(ctx, 500, "internal", (err as Error).message);
    return;
  }
}

// ─── Legacy row shape helpers ─────────────────────────────────────────────

function countLegacyRows(db: import("better-sqlite3").Database): {
  traces: number;
  skills: number;
  tasks: number;
} {
  return {
    traces: countTable(db, "chunks"),
    skills: countTable(db, "skills"),
    tasks: countTable(db, "tasks"),
  };
}

function countTable(db: import("better-sqlite3").Database, table: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: number };
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

interface LegacyChunk {
  id: string;
  session_key: string;
  turn_id?: string | null;
  seq?: number | null;
  role?: string | null;
  summary?: string | null;
  content?: string | null;
  created_at?: number | null;
}

interface LegacySkill {
  id: string;
  name: string;
  description?: string | null;
  status?: string | null;
  created_at?: number | null;
  updated_at?: number | null;
}

interface LegacyTask {
  id: string;
  session_key: string;
  title?: string | null;
  summary?: string | null;
  status?: string | null;
  started_at?: number | null;
  ended_at?: number | null;
}

function readLegacyChunks(db: import("better-sqlite3").Database): LegacyChunk[] {
  try {
    return db
      .prepare(
        `SELECT id, session_key, turn_id, seq, role, summary, content, created_at
         FROM chunks
         ORDER BY session_key ASC, created_at ASC, seq ASC
         LIMIT 50000`,
      )
      .all() as LegacyChunk[];
  } catch {
    return [];
  }
}

function readLegacySkills(db: import("better-sqlite3").Database): LegacySkill[] {
  try {
    return db
      .prepare(
        `SELECT id, name, description, status, created_at, updated_at
         FROM skills
         LIMIT 5000`,
      )
      .all() as LegacySkill[];
  } catch {
    return [];
  }
}

function readLegacyTasks(db: import("better-sqlite3").Database): LegacyTask[] {
  try {
    return db
      .prepare(
        `SELECT id, session_key, title, summary, status, started_at, ended_at
         FROM tasks
         LIMIT 5000`,
      )
      .all() as LegacyTask[];
  } catch {
    return [];
  }
}

/**
 * Convert legacy `chunks` rows into TraceDTOs.
 *
 * Strategy: every chunk becomes its own trace (session_key → sessionId,
 * `${session_key}:${turn_id}` → episodeId). user/assistant content
 * lands in the matching text field. We don't try to stitch pairs into
 * a single trace because the legacy `chunks` model explicitly stored
 * each role separately — merging would lose information.
 *
 * `importBundle` auto-upserts a synthetic session + closed episode
 * for every `(sessionId, episodeId)` pair we emit here, so the FK
 * constraint is satisfied even without pre-created session rows.
 */
function buildTracesFromChunks(chunks: LegacyChunk[]): TraceDTO[] {
  const out: TraceDTO[] = [];
  for (const c of chunks) {
    if (!c.id || !c.session_key) continue;
    const role = (c.role ?? "assistant").toLowerCase();
    const text = String(c.content ?? "");
    const summary = c.summary ? String(c.summary) : null;
    const ts = Number(c.created_at) || Date.now();
    const episodeId = c.turn_id
      ? `${c.session_key}::${c.turn_id}`
      : `${c.session_key}::legacy`;
    out.push({
      id: c.id,
      episodeId: episodeId as never,
      sessionId: c.session_key as never,
      ts: ts as never,
      userText: role === "user" ? text : "",
      agentText: role === "user" ? "" : text,
      summary,
      toolCalls: [],
      reflection: undefined,
      value: 0 as never,
      alpha: 0 as never,
      priority: 0,
      // Legacy chunks predate the turn-id concept — anchor each row
      // on its own `ts` so the viewer's group-by-(episodeId, turnId)
      // surface still treats every imported chunk as its own card.
      turnId: ts as never,
    });
  }
  return out;
}

function legacySkillStatus(s: string | null | undefined): SkillDTO["status"] {
  const v = (s ?? "").toLowerCase();
  if (v === "retired" || v === "archived" || v === "deprecated") return "archived";
  if (v === "probationary" || v === "candidate" || v === "trial") return "candidate";
  return "active";
}
