import Database from "better-sqlite3";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { Chunk, ChunkRef, DedupStatus, Task, TaskStatus, Skill, SkillStatus, SkillVisibility, SkillVersion, TaskSkillLink, TaskSkillRelation, Logger } from "../types";

export class SqliteStore {
  private db: Database.Database;

  constructor(dbPath: string, private log: Logger) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  // ─── Schema ───

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id          TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        turn_id     TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        role        TEXT NOT NULL,
        content     TEXT NOT NULL,
        kind        TEXT NOT NULL DEFAULT 'paragraph',
        summary     TEXT NOT NULL DEFAULT '',
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_session
        ON chunks(session_key);
      CREATE INDEX IF NOT EXISTS idx_chunks_turn
        ON chunks(session_key, turn_id, seq);
      CREATE INDEX IF NOT EXISTS idx_chunks_created
        ON chunks(created_at);
      CREATE INDEX IF NOT EXISTS idx_chunks_session_created
        ON chunks(session_key, created_at, seq);

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        summary,
        content,
        content='chunks',
        content_rowid='rowid',
        tokenize='porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, summary, content)
        VALUES (new.rowid, new.summary, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, summary, content)
        VALUES ('delete', old.rowid, old.summary, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, summary, content)
        VALUES ('delete', old.rowid, old.summary, old.content);
        INSERT INTO chunks_fts(rowid, summary, content)
        VALUES (new.rowid, new.summary, new.content);
      END;

      CREATE TABLE IF NOT EXISTS embeddings (
        chunk_id   TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
        vector     BLOB NOT NULL,
        dimensions INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS viewer_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_viewer_events_created ON viewer_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_viewer_events_type ON viewer_events(event_type);

      CREATE TABLE IF NOT EXISTS tasks (
        id          TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        title       TEXT NOT NULL DEFAULT '',
        summary     TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'active',
        started_at  INTEGER NOT NULL,
        ended_at    INTEGER,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_key);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    `);

    this.migrateTaskId();
    this.migrateContentHash();
    this.migrateSkillTables();
    this.migrateSkillId();
    this.migrateSkillQualityScore();
    this.migrateTaskSkillMeta();
    this.migrateToolCalls();
    this.migrateMergeFields();
    this.migrateApiLogs();
    this.migrateDedupStatus();
    this.migrateChunksIndexesForRecall();
    this.migrateOwnerFields();
    this.migrateSkillVisibility();
    this.migrateSkillEmbeddingsAndFts();
    this.log.debug("Database schema initialized");
  }

  private migrateChunksIndexesForRecall(): void {
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_chunks_dedup_created ON chunks(dedup_status, created_at DESC)");
  }

  private migrateOwnerFields(): void {
    const chunkCols = this.db.prepare("PRAGMA table_info(chunks)").all() as Array<{ name: string }>;
    if (!chunkCols.some((c) => c.name === "owner")) {
      this.db.exec("ALTER TABLE chunks ADD COLUMN owner TEXT NOT NULL DEFAULT 'agent:main'");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_chunks_owner ON chunks(owner)");
      this.log.info("Migrated: added owner column to chunks");
    }
    const taskCols = this.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (!taskCols.some((c) => c.name === "owner")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN owner TEXT NOT NULL DEFAULT 'agent:main'");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner)");
      this.log.info("Migrated: added owner column to tasks");
    }
  }

  private migrateSkillVisibility(): void {
    const cols = this.db.prepare("PRAGMA table_info(skills)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "owner")) {
      this.db.exec("ALTER TABLE skills ADD COLUMN owner TEXT NOT NULL DEFAULT 'agent:main'");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_skills_owner ON skills(owner)");
      this.log.info("Migrated: added owner column to skills");
    }
    if (!cols.some((c) => c.name === "visibility")) {
      this.db.exec("ALTER TABLE skills ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_skills_visibility ON skills(visibility)");
      this.log.info("Migrated: added visibility column to skills");
    }
  }

  private migrateSkillEmbeddingsAndFts(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skill_embeddings (
        skill_id   TEXT PRIMARY KEY REFERENCES skills(id) ON DELETE CASCADE,
        vector     BLOB NOT NULL,
        dimensions INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
        name,
        description,
        content='skills',
        content_rowid='rowid',
        tokenize='porter unicode61'
      );
    `);

    try {
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS skills_ai AFTER INSERT ON skills BEGIN
          INSERT INTO skills_fts(rowid, name, description)
          VALUES (new.rowid, new.name, new.description);
        END;
        CREATE TRIGGER IF NOT EXISTS skills_ad AFTER DELETE ON skills BEGIN
          INSERT INTO skills_fts(skills_fts, rowid, name, description)
          VALUES ('delete', old.rowid, old.name, old.description);
        END;
        CREATE TRIGGER IF NOT EXISTS skills_au AFTER UPDATE ON skills BEGIN
          INSERT INTO skills_fts(skills_fts, rowid, name, description)
          VALUES ('delete', old.rowid, old.name, old.description);
          INSERT INTO skills_fts(rowid, name, description)
          VALUES (new.rowid, new.name, new.description);
        END;
      `);
    } catch {
      // triggers may already exist
    }

    // Backfill FTS for existing skills
    try {
      const count = (this.db.prepare("SELECT COUNT(*) as c FROM skills_fts").get() as { c: number }).c;
      const skillCount = (this.db.prepare("SELECT COUNT(*) as c FROM skills").get() as { c: number }).c;
      if (count === 0 && skillCount > 0) {
        this.db.exec("INSERT INTO skills_fts(rowid, name, description) SELECT rowid, name, description FROM skills");
        this.log.info(`Migrated: backfilled skills_fts for ${skillCount} skills`);
      }
    } catch { /* best-effort */ }
  }

  private migrateTaskId(): void {
    const cols = this.db.prepare("PRAGMA table_info(chunks)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "task_id")) {
      this.db.exec("ALTER TABLE chunks ADD COLUMN task_id TEXT REFERENCES tasks(id)");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_chunks_task ON chunks(task_id)");
      this.log.info("Migrated: added task_id column to chunks");
    }
  }

  private migrateContentHash(): void {
    const cols = this.db.prepare("PRAGMA table_info(chunks)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "content_hash")) {
      this.db.exec("ALTER TABLE chunks ADD COLUMN content_hash TEXT");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_chunks_dedup ON chunks(session_key, role, content_hash)");

      // Backfill existing rows
      const rows = this.db.prepare("SELECT id, content FROM chunks WHERE content_hash IS NULL").all() as Array<{ id: string; content: string }>;
      const updateStmt = this.db.prepare("UPDATE chunks SET content_hash = ? WHERE id = ?");
      for (const r of rows) {
        updateStmt.run(contentHash(r.content), r.id);
      }
      if (rows.length > 0) {
        this.log.info(`Migrated: backfilled content_hash for ${rows.length} chunks`);
      }
    }
  }

  private migrateSkillTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        version     INTEGER NOT NULL DEFAULT 1,
        status      TEXT NOT NULL DEFAULT 'active',
        tags        TEXT NOT NULL DEFAULT '[]',
        source_type TEXT NOT NULL DEFAULT 'task',
        dir_path    TEXT NOT NULL DEFAULT '',
        installed   INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_skills_status ON skills(status);
      CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name);

      CREATE TABLE IF NOT EXISTS skill_versions (
        id              TEXT PRIMARY KEY,
        skill_id        TEXT NOT NULL REFERENCES skills(id),
        version         INTEGER NOT NULL,
        content         TEXT NOT NULL,
        changelog       TEXT NOT NULL DEFAULT '',
        upgrade_type    TEXT NOT NULL DEFAULT 'create',
        source_task_id  TEXT,
        metrics         TEXT NOT NULL DEFAULT '{}',
        created_at      INTEGER NOT NULL,
        UNIQUE(skill_id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_skill_versions_skill ON skill_versions(skill_id);

      CREATE TABLE IF NOT EXISTS task_skills (
        task_id    TEXT NOT NULL REFERENCES tasks(id),
        skill_id   TEXT NOT NULL REFERENCES skills(id),
        relation   TEXT NOT NULL DEFAULT 'generated_from',
        version_at INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (task_id, skill_id)
      );
    `);
  }

  private migrateSkillId(): void {
    const cols = this.db.prepare("PRAGMA table_info(chunks)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "skill_id")) {
      this.db.exec("ALTER TABLE chunks ADD COLUMN skill_id TEXT");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_chunks_skill ON chunks(skill_id)");
      this.log.info("Migrated: added skill_id column to chunks");
    }
  }

  private migrateSkillQualityScore(): void {
    const skillCols = this.db.prepare("PRAGMA table_info(skills)").all() as Array<{ name: string }>;
    if (!skillCols.some((c) => c.name === "quality_score")) {
      this.db.exec("ALTER TABLE skills ADD COLUMN quality_score REAL");
      this.log.info("Migrated: added quality_score column to skills");
    }

    const versionCols = this.db.prepare("PRAGMA table_info(skill_versions)").all() as Array<{ name: string }>;
    if (!versionCols.some((c) => c.name === "quality_score")) {
      this.db.exec("ALTER TABLE skill_versions ADD COLUMN quality_score REAL");
      this.log.info("Migrated: added quality_score column to skill_versions");
    }
    if (!versionCols.some((c) => c.name === "change_summary")) {
      this.db.exec("ALTER TABLE skill_versions ADD COLUMN change_summary TEXT NOT NULL DEFAULT ''");
      this.log.info("Migrated: added change_summary column to skill_versions");
    }
  }

  private migrateTaskSkillMeta(): void {
    const cols = this.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "skill_status")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN skill_status TEXT DEFAULT NULL");
      this.db.exec("ALTER TABLE tasks ADD COLUMN skill_reason TEXT DEFAULT NULL");
      this.log.info("Migrated: added skill_status/skill_reason columns to tasks");
    }
  }

  setTaskSkillMeta(taskId: string, meta: { skillStatus: string; skillReason: string }): void {
    this.db.prepare("UPDATE tasks SET skill_status = ?, skill_reason = ?, updated_at = ? WHERE id = ?")
      .run(meta.skillStatus, meta.skillReason, Date.now(), taskId);
  }

  getTasksBySkillStatus(statuses: string[]): Task[] {
    const placeholders = statuses.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT * FROM tasks WHERE skill_status IN (${placeholders}) AND status = 'completed' ORDER BY updated_at ASC`,
    ).all(...statuses) as TaskRow[];
    return rows.map(rowToTask);
  }

  private migrateMergeFields(): void {
    const cols = this.db.prepare("PRAGMA table_info(chunks)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "merge_count")) {
      this.db.exec("ALTER TABLE chunks ADD COLUMN merge_count INTEGER NOT NULL DEFAULT 0");
      this.db.exec("ALTER TABLE chunks ADD COLUMN last_hit_at INTEGER");
      this.db.exec("ALTER TABLE chunks ADD COLUMN merge_history TEXT NOT NULL DEFAULT '[]'");
      this.log.info("Migrated: added merge_count/last_hit_at/merge_history columns to chunks");
    }
  }

  private migrateApiLogs(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_logs (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_name    TEXT NOT NULL,
        input_data   TEXT NOT NULL DEFAULT '{}',
        output_data  TEXT NOT NULL DEFAULT '',
        duration_ms  INTEGER NOT NULL DEFAULT 0,
        success      INTEGER NOT NULL DEFAULT 1,
        called_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_api_logs_at ON api_logs(called_at);
      CREATE INDEX IF NOT EXISTS idx_api_logs_name ON api_logs(tool_name);
    `);
  }

  private migrateDedupStatus(): void {
    const cols = this.db.prepare("PRAGMA table_info(chunks)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "dedup_status")) {
      this.db.exec("ALTER TABLE chunks ADD COLUMN dedup_status TEXT NOT NULL DEFAULT 'active'");
      this.db.exec("ALTER TABLE chunks ADD COLUMN dedup_target TEXT DEFAULT NULL");
      this.db.exec("ALTER TABLE chunks ADD COLUMN dedup_reason TEXT DEFAULT NULL");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_chunks_dedup_status ON chunks(dedup_status)");
      this.log.info("Migrated: added dedup_status/dedup_target/dedup_reason columns to chunks");
    }
  }

  recordApiLog(toolName: string, input: unknown, output: string, durationMs: number, success: boolean): void {
    const inputStr = typeof input === "string" ? input : JSON.stringify(input ?? {});
    this.db.prepare(
      "INSERT INTO api_logs (tool_name, input_data, output_data, duration_ms, success, called_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(toolName, inputStr, output, Math.round(durationMs), success ? 1 : 0, Date.now());
  }

  getApiLogs(limit: number = 50, offset: number = 0, toolFilter?: string): {
    logs: Array<{ id: number; toolName: string; input: string; output: string; durationMs: number; success: boolean; calledAt: number }>;
    total: number;
  } {
    const whereClause = toolFilter ? " WHERE tool_name = ?" : "";
    const filterParams: unknown[] = toolFilter ? [toolFilter] : [];

    const countRow = this.db.prepare("SELECT COUNT(*) as c FROM api_logs" + whereClause).get(...filterParams) as { c: number };

    const rows = this.db.prepare(
      "SELECT id, tool_name, input_data, output_data, duration_ms, success, called_at FROM api_logs" +
      whereClause + " ORDER BY called_at DESC LIMIT ? OFFSET ?",
    ).all(...filterParams, limit, offset) as Array<{
      id: number; tool_name: string; input_data: string; output_data: string;
      duration_ms: number; success: number; called_at: number;
    }>;

    return {
      logs: rows.map((r) => ({
        id: r.id,
        toolName: r.tool_name,
        input: r.input_data,
        output: r.output_data,
        durationMs: r.duration_ms,
        success: r.success === 1,
        calledAt: r.called_at,
      })),
      total: countRow.c,
    };
  }

  getApiLogToolNames(): string[] {
    const rows = this.db.prepare("SELECT DISTINCT tool_name FROM api_logs ORDER BY tool_name").all() as Array<{ tool_name: string }>;
    return rows.map((r) => r.tool_name);
  }

  recordMergeHit(chunkId: string, action: "DUPLICATE" | "UPDATE", reason: string, oldSummary?: string, newSummary?: string): void {
    const chunk = this.getChunk(chunkId);
    if (!chunk) return;

    const history = JSON.parse(chunk.mergeHistory || "[]") as any[];
    const entry: Record<string, unknown> = { at: Date.now(), action, reason };
    if (action === "UPDATE" && oldSummary && newSummary) {
      entry.from = oldSummary;
      entry.to = newSummary;
    }
    history.push(entry);

    this.db.prepare(`
      UPDATE chunks SET merge_count = merge_count + 1, last_hit_at = ?, merge_history = ?, updated_at = ?
      WHERE id = ?
    `).run(Date.now(), JSON.stringify(history), Date.now(), chunkId);
  }

  updateChunkSummaryAndContent(chunkId: string, newSummary: string, appendContent: string): void {
    this.db.prepare(`
      UPDATE chunks SET summary = ?, content = content || ? || ?, updated_at = ? WHERE id = ?
    `).run(newSummary, "\n\n---\n\n", appendContent, Date.now(), chunkId);
  }

  private migrateToolCalls(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_calls (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_name    TEXT NOT NULL,
        duration_ms  INTEGER NOT NULL,
        success      INTEGER NOT NULL DEFAULT 1,
        called_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tool_calls_at ON tool_calls(called_at);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_name ON tool_calls(tool_name);
    `);
  }

  recordToolCall(toolName: string, durationMs: number, success: boolean): void {
    this.db.prepare(
      "INSERT INTO tool_calls (tool_name, duration_ms, success, called_at) VALUES (?, ?, ?, ?)",
    ).run(toolName, Math.round(durationMs), success ? 1 : 0, Date.now());
  }

  getToolMetrics(minutes: number): {
    tools: string[];
    series: Array<{ minute: string; [tool: string]: number | string }>;
    aggregated: Array<{ tool: string; totalCalls: number; avgMs: number; p95Ms: number; errorCount: number }>;
  } {
    const since = Date.now() - minutes * 60 * 1000;

    const rows = this.db.prepare(
      `SELECT tool_name,
              duration_ms,
              success,
              strftime('%Y-%m-%d %H:%M', called_at/1000, 'unixepoch', 'localtime') as minute_key
       FROM tool_calls
       WHERE called_at >= ?
       ORDER BY called_at`,
    ).all(since) as Array<{ tool_name: string; duration_ms: number; success: number; minute_key: string }>;

    const toolSet = new Set<string>();
    const minuteMap = new Map<string, Map<string, { total: number; count: number }>>();
    const aggMap = new Map<string, { durations: number[]; errors: number }>();

    for (const r of rows) {
      toolSet.add(r.tool_name);

      if (!aggMap.has(r.tool_name)) aggMap.set(r.tool_name, { durations: [], errors: 0 });
      const agg = aggMap.get(r.tool_name)!;
      agg.durations.push(r.duration_ms);
      if (!r.success) agg.errors++;

      if (!minuteMap.has(r.minute_key)) minuteMap.set(r.minute_key, new Map());
      const toolMap = minuteMap.get(r.minute_key)!;
      if (!toolMap.has(r.tool_name)) toolMap.set(r.tool_name, { total: 0, count: 0 });
      const entry = toolMap.get(r.tool_name)!;
      entry.total += r.duration_ms;
      entry.count++;
    }

    const tools = Array.from(toolSet).sort();

    const allMinutes: string[] = [];
    if (minutes > 0) {
      const startMinute = new Date(since);
      startMinute.setSeconds(0, 0);
      const now = new Date();
      for (let t = startMinute.getTime(); t <= now.getTime(); t += 60000) {
        const d = new Date(t);
        const pad = (n: number) => String(n).padStart(2, "0");
        allMinutes.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`);
      }
    }

    const series = allMinutes.map((m) => {
      const entry: { minute: string; [tool: string]: number | string } = { minute: m };
      const toolMap = minuteMap.get(m);
      for (const t of tools) {
        const data = toolMap?.get(t);
        entry[t] = data ? Math.round(data.total / data.count) : 0;
      }
      return entry;
    });

    const p95 = (arr: number[]) => {
      if (arr.length === 0) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1];
    };

    const aggregated = tools.map((t) => {
      const agg = aggMap.get(t)!;
      return {
        tool: t,
        totalCalls: agg.durations.length,
        avgMs: Math.round(agg.durations.reduce((s, v) => s + v, 0) / agg.durations.length),
        p95Ms: p95(agg.durations),
        errorCount: agg.errors,
      };
    });

    return { tools, series, aggregated };
  }

  /** Record a viewer API call for analytics (list, search, etc.). */
  recordViewerEvent(eventType: string): void {
    this.db.prepare("INSERT INTO viewer_events (event_type, created_at) VALUES (?, ?)").run(eventType, Date.now());
  }

  /**
   * Return metrics for the last N days: writes per day (from chunks), viewer calls per day.
   */
  getMetrics(days: number): {
    writesPerDay: Array<{ date: string; count: number }>;
    viewerCallsPerDay: Array<{ date: string; list: number; search: number; total: number }>;
    roleBreakdown: Record<string, number>;
    kindBreakdown: Record<string, number>;
    totals: { memories: number; sessions: number; embeddings: number; todayWrites: number; todayViewerCalls: number };
  } {
    const since = Date.now() - days * 86400 * 1000;
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

    const writesRows = this.db
      .prepare(
        `SELECT date(created_at/1000, 'unixepoch', 'localtime') as d, COUNT(*) as c
       FROM chunks WHERE created_at >= ? GROUP BY d ORDER BY d`,
      )
      .all(since) as Array<{ d: string; c: number }>;
    const writesPerDay = writesRows.map((r) => ({ date: r.d, count: r.c }));

    const eventsRows = this.db
      .prepare(
        `SELECT date(created_at/1000, 'unixepoch', 'localtime') as d, event_type, COUNT(*) as c
       FROM viewer_events WHERE created_at >= ? GROUP BY d, event_type ORDER BY d`,
      )
      .all(since) as Array<{ d: string; event_type: string; c: number }>;
    const byDate = new Map<string, { list: number; search: number }>();
    for (const r of eventsRows) {
      let row = byDate.get(r.d);
      if (!row) {
        row = { list: 0, search: 0 };
        byDate.set(r.d, row);
      }
      if (r.event_type === "list") row.list += r.c;
      else if (r.event_type === "search") row.search += r.c;
    }
    const viewerCallsPerDay = Array.from(byDate.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, v]) => ({ date, list: v.list, search: v.search, total: v.list + v.search }));

    const roles = this.db.prepare("SELECT role, COUNT(*) as count FROM chunks GROUP BY role").all() as Array<{ role: string; count: number }>;
    const kinds = this.db.prepare("SELECT kind, COUNT(*) as count FROM chunks GROUP BY kind").all() as Array<{ kind: string; count: number }>;
    const roleBreakdown = Object.fromEntries(roles.map((r) => [r.role, r.count]));
    const kindBreakdown = Object.fromEntries(kinds.map((k) => [k.kind, k.count]));

    const totalChunks = (this.db.prepare("SELECT COUNT(*) as c FROM chunks").get() as { c: number }).c;
    const totalSessions = (this.db.prepare("SELECT COUNT(DISTINCT session_key) as c FROM chunks").get() as { c: number }).c;
    const totalEmbeddings = (this.db.prepare("SELECT COUNT(*) as c FROM embeddings").get() as { c: number }).c;
    const todayWrites = (this.db.prepare("SELECT COUNT(*) as c FROM chunks WHERE created_at >= ?").get(todayStart) as { c: number }).c;
    const todayViewerCalls = (this.db.prepare("SELECT COUNT(*) as c FROM viewer_events WHERE created_at >= ?").get(todayStart) as { c: number }).c;

    return {
      writesPerDay,
      viewerCallsPerDay,
      roleBreakdown,
      kindBreakdown,
      totals: {
        memories: totalChunks,
        sessions: totalSessions,
        embeddings: totalEmbeddings,
        todayWrites,
        todayViewerCalls,
      },
    };
  }

  // ─── Write ───

  insertChunk(chunk: Chunk): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO chunks (id, session_key, turn_id, seq, role, content, kind, summary, task_id, content_hash, owner, dedup_status, dedup_target, dedup_reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      chunk.id,
      chunk.sessionKey,
      chunk.turnId,
      chunk.seq,
      chunk.role,
      chunk.content,
      chunk.kind,
      chunk.summary,
      chunk.taskId,
      contentHash(chunk.content),
      chunk.owner ?? "agent:main",
      chunk.dedupStatus ?? "active",
      chunk.dedupTarget ?? null,
      chunk.dedupReason ?? null,
      chunk.createdAt,
      chunk.updatedAt,
    );
  }

  markDedupStatus(chunkId: string, status: "duplicate" | "merged", targetChunkId: string | null, reason: string): void {
    this.db.prepare(
      "UPDATE chunks SET dedup_status = ?, dedup_target = ?, dedup_reason = ?, updated_at = ? WHERE id = ?",
    ).run(status, targetChunkId, reason, Date.now(), chunkId);
  }

  updateSummary(chunkId: string, summary: string): void {
    this.db.prepare("UPDATE chunks SET summary = ?, updated_at = ? WHERE id = ?").run(
      summary,
      Date.now(),
      chunkId,
    );
  }

  upsertEmbedding(chunkId: string, vector: number[]): void {
    const buf = Buffer.from(new Float32Array(vector).buffer);
    this.db.prepare(`
      INSERT OR REPLACE INTO embeddings (chunk_id, vector, dimensions, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(chunkId, buf, vector.length, Date.now());
  }

  deleteEmbedding(chunkId: string): void {
    this.db.prepare("DELETE FROM embeddings WHERE chunk_id = ?").run(chunkId);
  }

  // ─── Read ───

  getChunk(chunkId: string): Chunk | null {
    const row = this.db.prepare("SELECT * FROM chunks WHERE id = ?").get(chunkId) as ChunkRow | undefined;
    return row ? rowToChunk(row) : null;
  }

  getChunkForOwners(chunkId: string, ownerFilter?: string[]): Chunk | null {
    if (!ownerFilter || ownerFilter.length === 0) return this.getChunk(chunkId);

    const placeholders = ownerFilter.map(() => "?").join(",");
    const row = this.db.prepare(
      `SELECT * FROM chunks WHERE id = ? AND owner IN (${placeholders}) LIMIT 1`,
    ).get(chunkId, ...ownerFilter) as ChunkRow | undefined;
    return row ? rowToChunk(row) : null;
  }

  getChunksByRef(ref: ChunkRef, ownerFilter?: string[]): Chunk | null {
    return this.getChunkForOwners(ref.chunkId, ownerFilter);
  }

  getNeighborChunks(sessionKey: string, turnId: string, seq: number, window: number, ownerFilter?: string[]): Chunk[] {
    let sql = `
      SELECT * FROM chunks
      WHERE session_key = ?`;
    const params: any[] = [sessionKey];

    if (ownerFilter && ownerFilter.length > 0) {
      const placeholders = ownerFilter.map(() => "?").join(",");
      sql += ` AND owner IN (${placeholders})`;
      params.push(...ownerFilter);
    }

    sql += `
      ORDER BY created_at, seq
    `;

    const allRows = this.db.prepare(sql).all(...params) as ChunkRow[];

    const targetIdx = allRows.findIndex(
      (r) => r.turn_id === turnId && r.seq === seq,
    );
    if (targetIdx === -1) return [];

    const radius = window * 3;
    const start = Math.max(0, targetIdx - radius);
    const end = Math.min(allRows.length, targetIdx + radius + 1);
    return allRows.slice(start, end).map(rowToChunk);
  }

  // ─── FTS Search ───

  ftsSearch(query: string, limit: number, ownerFilter?: string[]): Array<{ chunkId: string; score: number }> {
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return [];

    try {
      let sql = `
        SELECT c.id as chunk_id, rank
        FROM chunks_fts f
        JOIN chunks c ON c.rowid = f.rowid
        WHERE chunks_fts MATCH ? AND c.dedup_status = 'active'`;
      const params: any[] = [sanitized];

      if (ownerFilter && ownerFilter.length > 0) {
        const placeholders = ownerFilter.map(() => "?").join(",");
        sql += ` AND c.owner IN (${placeholders})`;
        params.push(...ownerFilter);
      }

      sql += ` ORDER BY rank LIMIT ?`;
      params.push(limit);

      const rows = this.db.prepare(sql).all(...params) as Array<{ chunk_id: string; rank: number }>;

      if (rows.length === 0) return [];
      const maxAbsRank = Math.max(...rows.map((r) => Math.abs(r.rank)));
      return rows.map((r) => ({
        chunkId: r.chunk_id,
        score: maxAbsRank > 0 ? Math.abs(r.rank) / maxAbsRank : 0,
      }));
    } catch {
      this.log.warn(`FTS query failed for: "${sanitized}", returning empty`);
      return [];
    }
  }

  // ─── Pattern Search (LIKE-based, for CJK text where FTS tokenization is weak) ───

  patternSearch(patterns: string[], opts: { role?: string; limit?: number } = {}): Array<{ chunkId: string; content: string; role: string; createdAt: number }> {
    if (patterns.length === 0) return [];
    const limit = opts.limit ?? 10;

    const conditions = patterns.map(() => "c.content LIKE ?");
    const whereClause = conditions.join(" OR ");
    const roleClause = opts.role ? " AND c.role = ?" : "";
    const params: (string | number)[] = patterns.map(p => `%${p}%`);
    if (opts.role) params.push(opts.role);
    params.push(limit);

    try {
      const rows = this.db.prepare(`
        SELECT c.id as chunk_id, c.content, c.role, c.created_at
        FROM chunks c
        WHERE (${whereClause})${roleClause} AND c.dedup_status = 'active'
        ORDER BY c.created_at DESC
        LIMIT ?
      `).all(...params) as Array<{ chunk_id: string; content: string; role: string; created_at: number }>;

      return rows.map(r => ({
        chunkId: r.chunk_id,
        content: r.content,
        role: r.role,
        createdAt: r.created_at,
      }));
    } catch {
      return [];
    }
  }

  // ─── Vector Search ───

  getAllEmbeddings(ownerFilter?: string[]): Array<{ chunkId: string; vector: number[] }> {
    let sql = `SELECT e.chunk_id, e.vector, e.dimensions FROM embeddings e
       JOIN chunks c ON c.id = e.chunk_id
       WHERE c.dedup_status = 'active'`;
    const params: any[] = [];

    if (ownerFilter && ownerFilter.length > 0) {
      const placeholders = ownerFilter.map(() => "?").join(",");
      sql += ` AND c.owner IN (${placeholders})`;
      params.push(...ownerFilter);
    }

    const rows = this.db.prepare(sql).all(...params) as Array<{ chunk_id: string; vector: Buffer; dimensions: number }>;

    return rows.map((r) => ({
      chunkId: r.chunk_id,
      vector: Array.from(new Float32Array(r.vector.buffer, r.vector.byteOffset, r.dimensions)),
    }));
  }

  getRecentEmbeddings(limit: number, ownerFilter?: string[]): Array<{ chunkId: string; vector: number[] }> {
    if (limit <= 0) return this.getAllEmbeddings(ownerFilter);

    let sql = `SELECT e.chunk_id, e.vector, e.dimensions
       FROM chunks c
       JOIN embeddings e ON e.chunk_id = c.id
       WHERE c.dedup_status = 'active'`;
    const params: any[] = [];

    if (ownerFilter && ownerFilter.length > 0) {
      const placeholders = ownerFilter.map(() => "?").join(",");
      sql += ` AND c.owner IN (${placeholders})`;
      params.push(...ownerFilter);
    }

    sql += ` ORDER BY c.created_at DESC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Array<{ chunk_id: string; vector: Buffer; dimensions: number }>;

    return rows.map((r) => ({
      chunkId: r.chunk_id,
      vector: Array.from(new Float32Array(r.vector.buffer, r.vector.byteOffset, r.dimensions)),
    }));
  }

  getEmbedding(chunkId: string): number[] | null {
    const row = this.db.prepare(
      "SELECT vector, dimensions FROM embeddings WHERE chunk_id = ?",
    ).get(chunkId) as { vector: Buffer; dimensions: number } | undefined;
    if (!row) return null;
    return Array.from(new Float32Array(row.vector.buffer, row.vector.byteOffset, row.dimensions));
  }

  // ─── Update ───

  updateChunk(chunkId: string, fields: { summary?: string; content?: string; role?: string; kind?: string; owner?: string }): boolean {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (fields.summary !== undefined) {
      sets.push("summary = ?");
      params.push(fields.summary);
    }
    if (fields.content !== undefined) {
      sets.push("content = ?");
      params.push(fields.content);
    }
    if (fields.role !== undefined) {
      sets.push("role = ?");
      params.push(fields.role);
    }
    if (fields.kind !== undefined) {
      sets.push("kind = ?");
      params.push(fields.kind);
    }
    if (fields.owner !== undefined) {
      sets.push("owner = ?");
      params.push(fields.owner);
    }
    if (sets.length === 0) return false;

    sets.push("updated_at = ?");
    params.push(Date.now());
    params.push(chunkId);

    const result = this.db.prepare(
      `UPDATE chunks SET ${sets.join(", ")} WHERE id = ?`,
    ).run(...params);
    return result.changes > 0;
  }

  // ─── Delete ───

  deleteChunk(chunkId: string): boolean {
    const result = this.db.prepare("DELETE FROM chunks WHERE id = ?").run(chunkId);
    return result.changes > 0;
  }

  deleteSession(sessionKey: string): number {
    const result = this.db.prepare("DELETE FROM chunks WHERE session_key = ?").run(sessionKey);
    return result.changes;
  }

  deleteAll(): number {
    this.db.exec("PRAGMA foreign_keys = OFF");
    this.db.prepare("DELETE FROM task_skills").run();
    this.db.prepare("DELETE FROM skill_versions").run();
    this.db.prepare("DELETE FROM skills").run();
    this.db.prepare("DELETE FROM embeddings").run();
    this.db.prepare("DELETE FROM chunks").run();
    this.db.prepare("DELETE FROM tasks").run();
    this.db.prepare("DELETE FROM viewer_events").run();
    this.db.prepare("DELETE FROM api_logs").run();
    this.db.prepare("DELETE FROM tool_calls").run();
    this.db.exec("PRAGMA foreign_keys = ON");
    const remaining = this.countChunks();
    return remaining === 0 ? 1 : 0;
  }

  deleteTask(taskId: string): boolean {
    this.db.prepare("DELETE FROM task_skills WHERE task_id = ?").run(taskId);
    this.db.prepare("UPDATE chunks SET task_id = NULL WHERE task_id = ?").run(taskId);
    const result = this.db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
    return result.changes > 0;
  }

  deleteSkill(skillId: string): boolean {
    this.db.prepare("DELETE FROM task_skills WHERE skill_id = ?").run(skillId);
    this.db.prepare("DELETE FROM skill_versions WHERE skill_id = ?").run(skillId);
    this.db.prepare("DELETE FROM skill_embeddings WHERE skill_id = ?").run(skillId);
    this.db.prepare("UPDATE chunks SET skill_id = NULL WHERE skill_id = ?").run(skillId);
    const result = this.db.prepare("DELETE FROM skills WHERE id = ?").run(skillId);
    return result.changes > 0;
  }

  // ─── Task CRUD ───

  insertTask(task: Task): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO tasks (id, session_key, title, summary, status, owner, started_at, ended_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(task.id, task.sessionKey, task.title, task.summary, task.status, task.owner ?? "agent:main", task.startedAt, task.endedAt, task.updatedAt);
  }

  getTask(taskId: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  getActiveTask(sessionKey: string, owner?: string): Task | null {
    if (owner) {
      const row = this.db.prepare(
        "SELECT * FROM tasks WHERE session_key = ? AND status = 'active' AND owner = ? ORDER BY started_at DESC LIMIT 1",
      ).get(sessionKey, owner) as TaskRow | undefined;
      return row ? rowToTask(row) : null;
    }
    const row = this.db.prepare(
      "SELECT * FROM tasks WHERE session_key = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1",
    ).get(sessionKey) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  hasTaskForSession(sessionKey: string): boolean {
    const row = this.db.prepare(
      "SELECT 1 FROM tasks WHERE session_key = ? LIMIT 1",
    ).get(sessionKey);
    return !!row;
  }

  hasSkillForSessionTask(sessionKey: string): boolean {
    const row = this.db.prepare(
      "SELECT 1 FROM task_skills ts JOIN tasks t ON ts.task_id = t.id WHERE t.session_key = ? LIMIT 1",
    ).get(sessionKey);
    return !!row;
  }

  getCompletedTasksForSession(sessionKey: string): Task[] {
    const rows = this.db.prepare(
      "SELECT * FROM tasks WHERE session_key = ? AND status = 'completed'",
    ).all(sessionKey) as TaskRow[];
    return rows.map(rowToTask);
  }

  getAllActiveTasks(owner?: string): Task[] {
    if (owner) {
      const rows = this.db.prepare(
        "SELECT * FROM tasks WHERE status = 'active' AND owner = ? ORDER BY started_at DESC",
      ).all(owner) as TaskRow[];
      return rows.map(rowToTask);
    }
    const rows = this.db.prepare(
      "SELECT * FROM tasks WHERE status = 'active' ORDER BY started_at DESC",
    ).all() as TaskRow[];
    return rows.map(rowToTask);
  }

  updateTask(taskId: string, fields: { title?: string; summary?: string; status?: TaskStatus; endedAt?: number }): boolean {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (fields.title !== undefined) { sets.push("title = ?"); params.push(fields.title); }
    if (fields.summary !== undefined) { sets.push("summary = ?"); params.push(fields.summary); }
    if (fields.status !== undefined) { sets.push("status = ?"); params.push(fields.status); }
    if (fields.endedAt !== undefined) { sets.push("ended_at = ?"); params.push(fields.endedAt); }
    if (sets.length === 0) return false;
    sets.push("updated_at = ?");
    params.push(Date.now());
    params.push(taskId);
    const result = this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return result.changes > 0;
  }

  getChunksByTask(taskId: string): Chunk[] {
    const rows = this.db.prepare("SELECT * FROM chunks WHERE task_id = ? ORDER BY created_at, seq").all(taskId) as ChunkRow[];
    return rows.map(rowToChunk);
  }

  listTasks(opts: { status?: string; limit?: number; offset?: number; owner?: string } = {}): { tasks: Task[]; total: number } {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.status) { conditions.push("status = ?"); params.push(opts.status); }
    if (opts.owner) { conditions.push("owner = ?"); params.push(opts.owner); }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countRow = this.db.prepare(`SELECT COUNT(*) as c FROM tasks ${whereClause}`).get(...params) as { c: number };
    const total = countRow.c;

    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    const rows = this.db.prepare(
      `SELECT * FROM tasks ${whereClause} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as TaskRow[];

    return { tasks: rows.map(rowToTask), total };
  }

  countChunksByTask(taskId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) as c FROM chunks WHERE task_id = ?").get(taskId) as { c: number };
    return row.c;
  }

  setChunkTaskId(chunkId: string, taskId: string): void {
    this.db.prepare("UPDATE chunks SET task_id = ?, updated_at = ? WHERE id = ?").run(taskId, Date.now(), chunkId);
  }

  getUnassignedChunks(sessionKey: string, owner?: string): Chunk[] {
    if (owner) {
      const rows = this.db.prepare(
        "SELECT * FROM chunks WHERE session_key = ? AND task_id IS NULL AND owner = ? ORDER BY created_at, seq",
      ).all(sessionKey, owner) as ChunkRow[];
      return rows.map(rowToChunk);
    }
    const rows = this.db.prepare(
      "SELECT * FROM chunks WHERE session_key = ? AND task_id IS NULL ORDER BY created_at, seq",
    ).all(sessionKey) as ChunkRow[];
    return rows.map(rowToChunk);
  }

  /**
   * Check if a chunk with the same (session_key, role, content_hash) already exists.
   * Uses indexed content_hash for O(1) lookup to prevent duplicate ingestion
   * when agent_end sends the full conversation history every turn.
   */
  chunkExistsByContent(sessionKey: string, role: string, content: string): boolean {
    const hash = contentHash(content);
    const row = this.db.prepare(
      "SELECT 1 FROM chunks WHERE session_key = ? AND role = ? AND content_hash = ? LIMIT 1",
    ).get(sessionKey, role, hash);
    return !!row;
  }

  /**
   * Find an active chunk with the same content_hash within the same owner (agent dimension).
   * Returns the existing chunk ID if found, null otherwise.
   */
  findActiveChunkByHash(content: string, owner?: string): string | null {
    const hash = contentHash(content);
    if (owner) {
      const row = this.db.prepare(
        "SELECT id FROM chunks WHERE content_hash = ? AND dedup_status = 'active' AND owner = ? LIMIT 1",
      ).get(hash, owner) as { id: string } | undefined;
      return row?.id ?? null;
    }
    const row = this.db.prepare(
      "SELECT id FROM chunks WHERE content_hash = ? AND dedup_status = 'active' LIMIT 1",
    ).get(hash) as { id: string } | undefined;
    return row?.id ?? null;
  }

  // ─── Util ───

  getRecentChunkIds(limit: number): string[] {
    const rows = this.db.prepare(
      "SELECT id FROM chunks ORDER BY created_at DESC LIMIT ?",
    ).all(limit) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  countChunks(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS cnt FROM chunks").get() as { cnt: number };
    return row.cnt;
  }

  // ─── Skill CRUD ───

  insertSkill(skill: Skill): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO skills (id, name, description, version, status, tags, source_type, dir_path, installed, owner, visibility, quality_score, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(skill.id, skill.name, skill.description, skill.version, skill.status, skill.tags, skill.sourceType, skill.dirPath, skill.installed, skill.owner ?? "agent:main", skill.visibility ?? "private", skill.qualityScore, skill.createdAt, skill.updatedAt);
  }

  getSkill(skillId: string): Skill | null {
    const row = this.db.prepare("SELECT * FROM skills WHERE id = ?").get(skillId) as SkillRow | undefined;
    return row ? rowToSkill(row) : null;
  }

  getSkillByName(name: string): Skill | null {
    const row = this.db.prepare("SELECT * FROM skills WHERE name = ?").get(name) as SkillRow | undefined;
    return row ? rowToSkill(row) : null;
  }

  updateSkill(skillId: string, fields: { description?: string; version?: number; status?: SkillStatus; installed?: number; qualityScore?: number | null; updatedAt?: number }): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (fields.description !== undefined) { sets.push("description = ?"); params.push(fields.description); }
    if (fields.version !== undefined) { sets.push("version = ?"); params.push(fields.version); }
    if (fields.status !== undefined) { sets.push("status = ?"); params.push(fields.status); }
    if (fields.installed !== undefined) { sets.push("installed = ?"); params.push(fields.installed); }
    if (fields.qualityScore !== undefined) { sets.push("quality_score = ?"); params.push(fields.qualityScore); }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    params.push(fields.updatedAt ?? Date.now());
    params.push(skillId);
    this.db.prepare(`UPDATE skills SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }

  listSkills(opts: { status?: string } = {}): Skill[] {
    const cond = opts.status ? "WHERE status = ?" : "";
    const params = opts.status ? [opts.status] : [];
    const rows = this.db.prepare(`SELECT * FROM skills ${cond} ORDER BY updated_at DESC`).all(...params) as SkillRow[];
    return rows.map(rowToSkill);
  }

  // ─── Skill Visibility & Embeddings ───

  setSkillVisibility(skillId: string, visibility: SkillVisibility): void {
    this.db.prepare("UPDATE skills SET visibility = ?, updated_at = ? WHERE id = ?")
      .run(visibility, Date.now(), skillId);
  }

  upsertSkillEmbedding(skillId: string, vector: number[]): void {
    const buf = Buffer.from(new Float32Array(vector).buffer);
    this.db.prepare(`
      INSERT OR REPLACE INTO skill_embeddings (skill_id, vector, dimensions, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(skillId, buf, vector.length, Date.now());
  }

  getSkillEmbedding(skillId: string): number[] | null {
    const row = this.db.prepare(
      "SELECT vector, dimensions FROM skill_embeddings WHERE skill_id = ?",
    ).get(skillId) as { vector: Buffer; dimensions: number } | undefined;
    if (!row) return null;
    return Array.from(new Float32Array(row.vector.buffer, row.vector.byteOffset, row.dimensions));
  }

  getSkillEmbeddings(scope: "self" | "public" | "mix", currentOwner: string): Array<{ skillId: string; vector: number[] }> {
    let sql = `SELECT se.skill_id, se.vector, se.dimensions
       FROM skill_embeddings se
       JOIN skills s ON s.id = se.skill_id
       WHERE s.status = 'active'`;
    const params: any[] = [];

    if (scope === "self") {
      sql += ` AND s.owner = ?`;
      params.push(currentOwner);
    } else if (scope === "public") {
      sql += ` AND s.visibility = 'public'`;
    } else {
      sql += ` AND (s.owner = ? OR s.visibility = 'public')`;
      params.push(currentOwner);
    }

    const rows = this.db.prepare(sql).all(...params) as Array<{ skill_id: string; vector: Buffer; dimensions: number }>;
    return rows.map((r) => ({
      skillId: r.skill_id,
      vector: Array.from(new Float32Array(r.vector.buffer, r.vector.byteOffset, r.dimensions)),
    }));
  }

  skillFtsSearch(query: string, limit: number, scope: "self" | "public" | "mix", currentOwner: string): Array<{ skillId: string; score: number }> {
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return [];

    try {
      let sql = `
        SELECT s.id as skill_id, rank
        FROM skills_fts f
        JOIN skills s ON s.rowid = f.rowid
        WHERE skills_fts MATCH ? AND s.status = 'active'`;
      const params: any[] = [sanitized];

      if (scope === "self") {
        sql += ` AND s.owner = ?`;
        params.push(currentOwner);
      } else if (scope === "public") {
        sql += ` AND s.visibility = 'public'`;
      } else {
        sql += ` AND (s.owner = ? OR s.visibility = 'public')`;
        params.push(currentOwner);
      }

      sql += ` ORDER BY rank LIMIT ?`;
      params.push(limit);

      const rows = this.db.prepare(sql).all(...params) as Array<{ skill_id: string; rank: number }>;
      if (rows.length === 0) return [];
      const maxAbsRank = Math.max(...rows.map((r) => Math.abs(r.rank)));
      return rows.map((r) => ({
        skillId: r.skill_id,
        score: maxAbsRank > 0 ? Math.abs(r.rank) / maxAbsRank : 0,
      }));
    } catch {
      this.log.warn(`Skill FTS query failed for: "${sanitized}", returning empty`);
      return [];
    }
  }

  listPublicSkills(): Skill[] {
    const rows = this.db.prepare("SELECT * FROM skills WHERE visibility = 'public' AND status = 'active' ORDER BY updated_at DESC").all() as SkillRow[];
    return rows.map(rowToSkill);
  }

  // ─── Skill Versions ───

  insertSkillVersion(sv: SkillVersion): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO skill_versions (id, skill_id, version, content, changelog, change_summary, upgrade_type, source_task_id, metrics, quality_score, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sv.id, sv.skillId, sv.version, sv.content, sv.changelog, sv.changeSummary, sv.upgradeType, sv.sourceTaskId, sv.metrics, sv.qualityScore, sv.createdAt);
  }

  getLatestSkillVersion(skillId: string): SkillVersion | null {
    const row = this.db.prepare("SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY version DESC LIMIT 1").get(skillId) as SkillVersionRow | undefined;
    return row ? rowToSkillVersion(row) : null;
  }

  getSkillVersions(skillId: string): SkillVersion[] {
    const rows = this.db.prepare("SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY version DESC").all(skillId) as SkillVersionRow[];
    return rows.map(rowToSkillVersion);
  }

  getSkillVersion(skillId: string, version: number): SkillVersion | null {
    const row = this.db.prepare("SELECT * FROM skill_versions WHERE skill_id = ? AND version = ?").get(skillId, version) as SkillVersionRow | undefined;
    return row ? rowToSkillVersion(row) : null;
  }

  // ─── Task-Skill Links ───

  linkTaskSkill(taskId: string, skillId: string, relation: TaskSkillRelation, versionAt: number): void {
    const skillExists = this.db.prepare("SELECT 1 FROM skills WHERE id = ?").get(skillId);
    if (!skillExists) return;
    const taskExists = this.db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(taskId);
    if (!taskExists) return;
    this.db.prepare(`
      INSERT OR REPLACE INTO task_skills (task_id, skill_id, relation, version_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(taskId, skillId, relation, versionAt, Date.now());
  }

  getSkillsByTask(taskId: string): Array<{ skill: Skill; relation: TaskSkillRelation; versionAt: number }> {
    const rows = this.db.prepare(`
      SELECT s.*, ts.relation, ts.version_at
      FROM task_skills ts JOIN skills s ON s.id = ts.skill_id
      WHERE ts.task_id = ?
    `).all(taskId) as Array<SkillRow & { relation: string; version_at: number }>;
    return rows.map(r => ({
      skill: rowToSkill(r),
      relation: r.relation as TaskSkillRelation,
      versionAt: r.version_at,
    }));
  }

  getTasksBySkill(skillId: string): Array<{ task: Task; relation: TaskSkillRelation }> {
    const rows = this.db.prepare(`
      SELECT t.*, ts.relation
      FROM task_skills ts JOIN tasks t ON t.id = ts.task_id
      WHERE ts.skill_id = ?
      ORDER BY t.started_at DESC
    `).all(skillId) as Array<TaskRow & { relation: string }>;
    return rows.map(r => ({
      task: rowToTask(r),
      relation: r.relation as TaskSkillRelation,
    }));
  }

  countSkills(status?: string): number {
    const cond = status ? "WHERE status = ?" : "";
    const params = status ? [status] : [];
    const row = this.db.prepare(`SELECT COUNT(*) as c FROM skills ${cond}`).get(...params) as { c: number };
    return row.c;
  }

  // ─── Chunk-Skill ───

  setChunkSkillId(chunkId: string, skillId: string): void {
    this.db.prepare("UPDATE chunks SET skill_id = ?, updated_at = ? WHERE id = ?").run(skillId, Date.now(), chunkId);
  }

  getDistinctSessionKeys(): string[] {
    return (this.db.prepare("SELECT DISTINCT session_key FROM chunks ORDER BY session_key").all() as Array<{ session_key: string }>)
      .map(r => r.session_key);
  }

  getSessionOwnerMap(sessionKeys: string[]): Map<string, string> {
    const result = new Map<string, string>();
    if (sessionKeys.length === 0) return result;
    const placeholders = sessionKeys.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT session_key, owner FROM chunks WHERE session_key IN (${placeholders}) AND owner IS NOT NULL GROUP BY session_key`,
    ).all(...sessionKeys) as Array<{ session_key: string; owner: string }>;
    for (const r of rows) result.set(r.session_key, r.owner);
    return result;
  }

  close(): void {
    this.db.close();
  }
}

// ─── FTS helpers ───

/**
 * Sanitize user input for FTS5 MATCH queries.
 * Strip FTS operators and special characters, then join tokens
 * with implicit AND (space-separated) for safe querying.
 */
function sanitizeFtsQuery(raw: string): string {
  const tokens = raw
    .replace(/[."""(){}[\]*:^~!@#$%&\\/<>,;'`]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim().replace(/^-+|-+$/g, ""))
    .filter((t) => t.length > 1)
    .filter((t) => !FTS_RESERVED.has(t.toUpperCase()));

  return tokens.join(" ");
}

const FTS_RESERVED = new Set(["AND", "OR", "NOT", "NEAR"]);

// ─── Internal helpers ───

interface ChunkRow {
  id: string;
  session_key: string;
  turn_id: string;
  seq: number;
  role: string;
  content: string;
  kind: string;
  summary: string;
  task_id: string | null;
  skill_id: string | null;
  owner: string;
  dedup_status: string;
  dedup_target: string | null;
  dedup_reason: string | null;
  merge_count: number;
  last_hit_at: number | null;
  merge_history: string;
  created_at: number;
  updated_at: number;
}

function rowToChunk(row: ChunkRow): Chunk {
  return {
    id: row.id,
    sessionKey: row.session_key,
    turnId: row.turn_id,
    seq: row.seq,
    role: row.role as Chunk["role"],
    content: row.content,
    kind: row.kind as Chunk["kind"],
    summary: row.summary,
    embedding: null,
    taskId: row.task_id,
    skillId: row.skill_id ?? null,
    owner: row.owner ?? "agent:main",
    dedupStatus: (row.dedup_status ?? "active") as DedupStatus,
    dedupTarget: row.dedup_target ?? null,
    dedupReason: row.dedup_reason ?? null,
    mergeCount: row.merge_count ?? 0,
    lastHitAt: row.last_hit_at ?? null,
    mergeHistory: row.merge_history ?? "[]",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface TaskRow {
  id: string;
  session_key: string;
  title: string;
  summary: string;
  status: string;
  owner: string;
  started_at: number;
  ended_at: number | null;
  updated_at: number;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    sessionKey: row.session_key,
    title: row.title,
    summary: row.summary,
    status: row.status as Task["status"],
    owner: row.owner ?? "agent:main",
    startedAt: row.started_at,
    endedAt: row.ended_at,
    updatedAt: row.updated_at,
  };
}

interface SkillRow {
  id: string;
  name: string;
  description: string;
  version: number;
  status: string;
  tags: string;
  source_type: string;
  dir_path: string;
  installed: number;
  owner: string;
  visibility: string;
  quality_score: number | null;
  created_at: number;
  updated_at: number;
}

function rowToSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    status: row.status as Skill["status"],
    tags: row.tags,
    sourceType: row.source_type as Skill["sourceType"],
    dirPath: row.dir_path,
    installed: row.installed,
    owner: row.owner ?? "agent:main",
    visibility: (row.visibility ?? "private") as Skill["visibility"],
    qualityScore: row.quality_score ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface SkillVersionRow {
  id: string;
  skill_id: string;
  version: number;
  content: string;
  changelog: string;
  change_summary: string;
  upgrade_type: string;
  source_task_id: string | null;
  metrics: string;
  quality_score: number | null;
  created_at: number;
}

function rowToSkillVersion(row: SkillVersionRow): SkillVersion {
  return {
    id: row.id,
    skillId: row.skill_id,
    version: row.version,
    content: row.content,
    changelog: row.changelog,
    changeSummary: row.change_summary ?? "",
    upgradeType: row.upgrade_type as SkillVersion["upgradeType"],
    sourceTaskId: row.source_task_id,
    metrics: row.metrics,
    qualityScore: row.quality_score ?? null,
    createdAt: row.created_at,
  };
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
