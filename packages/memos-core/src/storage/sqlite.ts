import Database from "better-sqlite3";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { Chunk, ChunkRef, DedupStatus, Task, TaskStatus, Skill, SkillStatus, SkillVisibility, SkillVersion, TaskSkillLink, TaskSkillRelation, Logger } from "../types";
import type { SharedVisibility, UserInfo, UserRole, UserStatus } from "../sharing/types";

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
        tokenize='trigram'
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
    this.migrateTaskTopicColumn();
    this.migrateTaskEmbeddingsAndFts();
    this.migrateFtsToTrigram();
    this.migrateHubTables();
    this.migrateHubFtsToTrigram();
    this.migrateHubMemorySourceAgent();
    this.migrateLocalSharedTasksOwner();
    this.migrateHubUserIdentityFields();
    this.migrateClientHubConnectionIdentityFields();
    this.migrateTeamSharingInstanceId();
    this.log.debug("Database schema initialized");
  }

  private migrateChunksIndexesForRecall(): void {
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_chunks_dedup_created ON chunks(dedup_status, created_at DESC)");
  }

  private migrateHubMemorySourceAgent(): void {
    try {
      const cols = this.db.prepare("PRAGMA table_info(hub_memories)").all() as Array<{ name: string }>;
      if (cols.length > 0 && !cols.some((c) => c.name === "source_agent")) {
        this.db.exec("ALTER TABLE hub_memories ADD COLUMN source_agent TEXT NOT NULL DEFAULT ''");
        this.log.info("Migrated: added source_agent column to hub_memories");
      }
    } catch { /* table may not exist yet */ }
  }

  private migrateLocalSharedTasksOwner(): void {
    try {
      const cols = this.db.prepare("PRAGMA table_info(local_shared_tasks)").all() as Array<{ name: string }>;
      if (cols.length > 0 && !cols.some((c) => c.name === "original_owner")) {
        this.db.exec("ALTER TABLE local_shared_tasks ADD COLUMN original_owner TEXT NOT NULL DEFAULT 'agent:main'");
        this.log.info("Migrated: added original_owner column to local_shared_tasks");
      }
    } catch { /* table may not exist yet */ }
  }

  private migrateHubUserIdentityFields(): void {
    try {
      const cols = this.db.prepare("PRAGMA table_info(hub_users)").all() as Array<{ name: string }>;
      if (cols.length === 0) return;
      if (!cols.some(c => c.name === "identity_key")) {
        this.db.exec("ALTER TABLE hub_users ADD COLUMN identity_key TEXT NOT NULL DEFAULT ''");
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_hub_users_identity_key ON hub_users(identity_key)");
        this.log.info("Migrated: added identity_key to hub_users");
      }
      if (!cols.some(c => c.name === "left_at")) {
        this.db.exec("ALTER TABLE hub_users ADD COLUMN left_at INTEGER");
        this.log.info("Migrated: added left_at to hub_users");
      }
      if (!cols.some(c => c.name === "removed_at")) {
        this.db.exec("ALTER TABLE hub_users ADD COLUMN removed_at INTEGER");
        this.log.info("Migrated: added removed_at to hub_users");
      }
      if (!cols.some(c => c.name === "rejected_at")) {
        this.db.exec("ALTER TABLE hub_users ADD COLUMN rejected_at INTEGER");
        this.log.info("Migrated: added rejected_at to hub_users");
      }
      if (!cols.some(c => c.name === "rejoin_requested_at")) {
        this.db.exec("ALTER TABLE hub_users ADD COLUMN rejoin_requested_at INTEGER");
        this.log.info("Migrated: added rejoin_requested_at to hub_users");
      }
    } catch { /* table may not exist yet */ }
  }

  private migrateClientHubConnectionIdentityFields(): void {
    try {
      const cols = this.db.prepare("PRAGMA table_info(client_hub_connection)").all() as Array<{ name: string }>;
      if (cols.length === 0) return;
      if (!cols.some(c => c.name === "identity_key")) {
        this.db.exec("ALTER TABLE client_hub_connection ADD COLUMN identity_key TEXT NOT NULL DEFAULT ''");
        this.log.info("Migrated: added identity_key to client_hub_connection");
      }
      if (!cols.some(c => c.name === "last_known_status")) {
        this.db.exec("ALTER TABLE client_hub_connection ADD COLUMN last_known_status TEXT NOT NULL DEFAULT ''");
        this.log.info("Migrated: added last_known_status to client_hub_connection");
      }
    } catch { /* table may not exist yet */ }
  }

  private migrateTeamSharingInstanceId(): void {
    try {
      const tscCols = this.db.prepare("PRAGMA table_info(team_shared_chunks)").all() as Array<{ name: string }>;
      if (tscCols.length > 0 && !tscCols.some(c => c.name === "hub_instance_id")) {
        this.db.exec("ALTER TABLE team_shared_chunks ADD COLUMN hub_instance_id TEXT NOT NULL DEFAULT ''");
        this.log.info("Migrated: added hub_instance_id to team_shared_chunks");
      }
    } catch { /* table may not exist yet */ }
    try {
      const lstCols = this.db.prepare("PRAGMA table_info(local_shared_tasks)").all() as Array<{ name: string }>;
      if (lstCols.length > 0 && !lstCols.some(c => c.name === "hub_instance_id")) {
        this.db.exec("ALTER TABLE local_shared_tasks ADD COLUMN hub_instance_id TEXT NOT NULL DEFAULT ''");
        this.log.info("Migrated: added hub_instance_id to local_shared_tasks");
      }
    } catch { /* table may not exist yet */ }
    try {
      const connCols = this.db.prepare("PRAGMA table_info(client_hub_connection)").all() as Array<{ name: string }>;
      if (connCols.length > 0 && !connCols.some(c => c.name === "hub_instance_id")) {
        this.db.exec("ALTER TABLE client_hub_connection ADD COLUMN hub_instance_id TEXT NOT NULL DEFAULT ''");
        this.log.info("Migrated: added hub_instance_id to client_hub_connection");
      }
    } catch { /* table may not exist yet */ }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS team_shared_skills (
        skill_id        TEXT PRIMARY KEY,
        hub_skill_id    TEXT NOT NULL DEFAULT '',
        visibility      TEXT NOT NULL DEFAULT 'public',
        group_id        TEXT,
        hub_instance_id TEXT NOT NULL DEFAULT '',
        shared_at       INTEGER NOT NULL
      )
    `);
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
        tokenize='trigram'
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

  private migrateTaskEmbeddingsAndFts(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_embeddings (
        task_id    TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        vector     BLOB NOT NULL,
        dimensions INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
        summary,
        topic,
        content='tasks',
        content_rowid='rowid',
        tokenize='trigram'
      );
    `);

    try {
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS tasks_fts_ai AFTER INSERT ON tasks BEGIN
          INSERT INTO tasks_fts(rowid, summary, topic)
          VALUES (new.rowid, new.summary, COALESCE(new.topic, ''));
        END;
        CREATE TRIGGER IF NOT EXISTS tasks_fts_ad AFTER DELETE ON tasks BEGIN
          INSERT INTO tasks_fts(tasks_fts, rowid, summary, topic)
          VALUES ('delete', old.rowid, old.summary, COALESCE(old.topic, ''));
        END;
        CREATE TRIGGER IF NOT EXISTS tasks_fts_au AFTER UPDATE ON tasks BEGIN
          INSERT INTO tasks_fts(tasks_fts, rowid, summary, topic)
          VALUES ('delete', old.rowid, old.summary, COALESCE(old.topic, ''));
          INSERT INTO tasks_fts(rowid, summary, topic)
          VALUES (new.rowid, new.summary, COALESCE(new.topic, ''));
        END;
      `);
    } catch {
      // triggers may already exist
    }

    try {
      const count = (this.db.prepare("SELECT COUNT(*) as c FROM tasks_fts").get() as { c: number }).c;
      const taskCount = (this.db.prepare("SELECT COUNT(*) as c FROM tasks").get() as { c: number }).c;
      if (count === 0 && taskCount > 0) {
        this.db.exec("INSERT INTO tasks_fts(rowid, summary, topic) SELECT rowid, summary, COALESCE(topic, '') FROM tasks");
        this.log.info(`Migrated: backfilled tasks_fts for ${taskCount} tasks`);
      }
    } catch { /* best-effort */ }
  }

  private migrateFtsToTrigram(): void {
    // Check if chunks_fts still uses the old tokenizer (porter unicode61)
    try {
      const row = this.db.prepare(
        "SELECT sql FROM sqlite_master WHERE name='chunks_fts'"
      ).get() as { sql: string } | undefined;
      if (row && row.sql && !row.sql.includes("trigram")) {
        this.log.info("Migrating chunks_fts from porter/unicode61 to trigram tokenizer...");
        this.db.exec("DROP TRIGGER IF EXISTS chunks_ai");
        this.db.exec("DROP TRIGGER IF EXISTS chunks_ad");
        this.db.exec("DROP TRIGGER IF EXISTS chunks_au");
        this.db.exec("DROP TABLE IF EXISTS chunks_fts");
        this.db.exec(`
          CREATE VIRTUAL TABLE chunks_fts USING fts5(
            summary, content, content='chunks', content_rowid='rowid',
            tokenize='trigram'
          )
        `);
        this.db.exec(`
          CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
            INSERT INTO chunks_fts(rowid, summary, content) VALUES (new.rowid, new.summary, new.content);
          END;
          CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
            INSERT INTO chunks_fts(chunks_fts, rowid, summary, content) VALUES ('delete', old.rowid, old.summary, old.content);
          END;
          CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
            INSERT INTO chunks_fts(chunks_fts, rowid, summary, content) VALUES ('delete', old.rowid, old.summary, old.content);
            INSERT INTO chunks_fts(rowid, summary, content) VALUES (new.rowid, new.summary, new.content);
          END
        `);
        this.db.exec("INSERT INTO chunks_fts(rowid, summary, content) SELECT rowid, summary, content FROM chunks");
        const count = (this.db.prepare("SELECT COUNT(*) as c FROM chunks_fts").get() as { c: number }).c;
        this.log.info(`Migrated chunks_fts to trigram: ${count} rows indexed`);
      }
    } catch (err) {
      this.log.warn(`Failed to migrate chunks_fts to trigram: ${err}`);
    }

    // Same for skills_fts
    try {
      const row = this.db.prepare(
        "SELECT sql FROM sqlite_master WHERE name='skills_fts'"
      ).get() as { sql: string } | undefined;
      if (row && row.sql && !row.sql.includes("trigram")) {
        this.log.info("Migrating skills_fts to trigram tokenizer...");
        this.db.exec("DROP TRIGGER IF EXISTS skills_ai");
        this.db.exec("DROP TRIGGER IF EXISTS skills_ad");
        this.db.exec("DROP TRIGGER IF EXISTS skills_au");
        this.db.exec("DROP TABLE IF EXISTS skills_fts");
        this.db.exec(`
          CREATE VIRTUAL TABLE skills_fts USING fts5(
            name, description, content='skills', content_rowid='rowid',
            tokenize='trigram'
          )
        `);
        this.db.exec(`
          CREATE TRIGGER skills_ai AFTER INSERT ON skills BEGIN
            INSERT INTO skills_fts(rowid, name, description) VALUES (new.rowid, new.name, new.description);
          END;
          CREATE TRIGGER skills_ad AFTER DELETE ON skills BEGIN
            INSERT INTO skills_fts(skills_fts, rowid, name, description) VALUES ('delete', old.rowid, old.name, old.description);
          END;
          CREATE TRIGGER skills_au AFTER UPDATE ON skills BEGIN
            INSERT INTO skills_fts(skills_fts, rowid, name, description) VALUES ('delete', old.rowid, old.name, old.description);
            INSERT INTO skills_fts(rowid, name, description) VALUES (new.rowid, new.name, new.description);
          END
        `);
        this.db.exec("INSERT INTO skills_fts(rowid, name, description) SELECT rowid, name, description FROM skills");
        this.log.info("Migrated skills_fts to trigram");
      }
    } catch (err) {
      this.log.warn(`Failed to migrate skills_fts to trigram: ${err}`);
    }
  }

  private migrateHubFtsToTrigram(): void {
    const tables: Array<{ fts: string; source: string; columns: string; triggers: string[] }> = [
      {
        fts: "hub_chunks_fts", source: "hub_chunks", columns: "summary, content",
        triggers: ["hub_chunks_ai", "hub_chunks_ad", "hub_chunks_au"],
      },
      {
        fts: "hub_skills_fts", source: "hub_skills", columns: "name, description",
        triggers: ["hub_skills_ai", "hub_skills_ad", "hub_skills_au"],
      },
      {
        fts: "hub_memories_fts", source: "hub_memories", columns: "summary, content",
        triggers: ["hub_memories_ai", "hub_memories_ad", "hub_memories_au"],
      },
    ];
    for (const t of tables) {
      try {
        const row = this.db.prepare(`SELECT sql FROM sqlite_master WHERE name='${t.fts}'`).get() as { sql: string } | undefined;
        if (!row || !row.sql) continue;
        if (row.sql.includes("trigram")) continue;
        this.log.info(`Migrating ${t.fts} to trigram tokenizer...`);
        for (const tr of t.triggers) this.db.exec(`DROP TRIGGER IF EXISTS ${tr}`);
        this.db.exec(`DROP TABLE IF EXISTS ${t.fts}`);
        this.db.exec(`CREATE VIRTUAL TABLE ${t.fts} USING fts5(${t.columns}, content='${t.source}', content_rowid='rowid', tokenize='trigram')`);
        this.db.exec(`
          CREATE TRIGGER ${t.triggers[0]} AFTER INSERT ON ${t.source} BEGIN
            INSERT INTO ${t.fts}(rowid, ${t.columns}) VALUES (new.rowid, ${t.columns.split(", ").map(c => "new." + c).join(", ")});
          END;
          CREATE TRIGGER ${t.triggers[1]} AFTER DELETE ON ${t.source} BEGIN
            INSERT INTO ${t.fts}(${t.fts}, rowid, ${t.columns}) VALUES ('delete', old.rowid, ${t.columns.split(", ").map(c => "old." + c).join(", ")});
          END;
          CREATE TRIGGER ${t.triggers[2]} AFTER UPDATE ON ${t.source} BEGIN
            INSERT INTO ${t.fts}(${t.fts}, rowid, ${t.columns}) VALUES ('delete', old.rowid, ${t.columns.split(", ").map(c => "old." + c).join(", ")});
            INSERT INTO ${t.fts}(rowid, ${t.columns}) VALUES (new.rowid, ${t.columns.split(", ").map(c => "new." + c).join(", ")});
          END
        `);
        this.db.exec(`INSERT INTO ${t.fts}(rowid, ${t.columns}) SELECT rowid, ${t.columns} FROM ${t.source}`);
        const cnt = (this.db.prepare(`SELECT COUNT(*) as c FROM ${t.fts}`).get() as { c: number }).c;
        this.log.info(`Migrated ${t.fts} to trigram: ${cnt} rows indexed`);
      } catch (err) {
        this.log.warn(`Failed to migrate ${t.fts} to trigram: ${err}`);
      }
    }
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

  private migrateTaskTopicColumn(): void {
    const cols = this.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "topic")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN topic TEXT DEFAULT NULL");
      this.log.info("Migrated: added topic column to tasks");
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

  getToolMetrics(minutes: number, fromMs?: number, toMs?: number): {
    tools: string[];
    series: Array<{ minute: string; [tool: string]: number | string }>;
    aggregated: Array<{ tool: string; totalCalls: number; avgMs: number; p95Ms: number; errorCount: number }>;
  } {
    const since = fromMs ?? (Date.now() - minutes * 60 * 1000);
    const until = toMs ?? Date.now();

    const rows = this.db.prepare(
      `SELECT tool_name,
              duration_ms,
              success,
              strftime('%Y-%m-%d %H:%M', called_at/1000, 'unixepoch', 'localtime') as minute_key
       FROM tool_calls
       WHERE called_at >= ? AND called_at <= ?
       ORDER BY called_at`,
    ).all(since, until) as Array<{ tool_name: string; duration_ms: number; success: number; minute_key: string }>;

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

    const totalChunks = (this.db.prepare("SELECT COUNT(*) as c FROM chunks").get() as { c: number }).c;
    const totalSessions = (this.db.prepare("SELECT COUNT(DISTINCT session_key) as c FROM chunks").get() as { c: number }).c;
    const totalEmbeddings = (this.db.prepare("SELECT COUNT(*) as c FROM embeddings").get() as { c: number }).c;
    const todayWrites = (this.db.prepare("SELECT COUNT(*) as c FROM chunks WHERE created_at >= ?").get(todayStart) as { c: number }).c;
    const todayViewerCalls = (this.db.prepare("SELECT COUNT(*) as c FROM viewer_events WHERE created_at >= ?").get(todayStart) as { c: number }).c;

    return {
      writesPerDay,
      viewerCallsPerDay,
      totals: {
        memories: totalChunks,
        sessions: totalSessions,
        embeddings: totalEmbeddings,
        todayWrites,
        todayViewerCalls,
      },
    };
  }


  private migrateHubTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS client_hub_connection (
        id           INTEGER PRIMARY KEY CHECK (id = 1),
        hub_url      TEXT NOT NULL,
        user_id      TEXT NOT NULL,
        username     TEXT NOT NULL,
        user_token   TEXT NOT NULL,
        role         TEXT NOT NULL,
        connected_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS local_shared_tasks (
        task_id         TEXT PRIMARY KEY,
        hub_task_id     TEXT NOT NULL,
        visibility      TEXT NOT NULL DEFAULT 'public',
        group_id        TEXT,
        synced_chunks   INTEGER NOT NULL DEFAULT 0,
        hub_instance_id TEXT NOT NULL DEFAULT '',
        shared_at       INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS local_shared_memories (
        chunk_id        TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
        original_owner  TEXT NOT NULL,
        shared_at       INTEGER NOT NULL
      );

      -- Client: team share UI metadata only (no hub_memories row — avoids local FTS/embed recall duplication)
      CREATE TABLE IF NOT EXISTS team_shared_chunks (
        chunk_id        TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
        hub_memory_id   TEXT NOT NULL DEFAULT '',
        visibility      TEXT NOT NULL DEFAULT 'public',
        group_id        TEXT,
        hub_instance_id TEXT NOT NULL DEFAULT '',
        shared_at       INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS team_shared_skills (
        skill_id        TEXT PRIMARY KEY,
        hub_skill_id    TEXT NOT NULL DEFAULT '',
        visibility      TEXT NOT NULL DEFAULT 'public',
        group_id        TEXT,
        hub_instance_id TEXT NOT NULL DEFAULT '',
        shared_at       INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS hub_users (
        id             TEXT PRIMARY KEY,
        username       TEXT NOT NULL UNIQUE,
        device_name    TEXT NOT NULL DEFAULT '',
        role           TEXT NOT NULL,
        status         TEXT NOT NULL,
        token_hash     TEXT NOT NULL DEFAULT '',
        created_at     INTEGER NOT NULL,
        approved_at    INTEGER,
        last_ip        TEXT NOT NULL DEFAULT '',
        last_active_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_hub_users_status ON hub_users(status);
      CREATE INDEX IF NOT EXISTS idx_hub_users_role ON hub_users(role);

      CREATE TABLE IF NOT EXISTS hub_groups (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_at  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS hub_group_members (
        group_id   TEXT NOT NULL REFERENCES hub_groups(id) ON DELETE CASCADE,
        user_id    TEXT NOT NULL REFERENCES hub_users(id) ON DELETE CASCADE,
        joined_at  INTEGER NOT NULL,
        PRIMARY KEY (group_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS hub_tasks (
        id             TEXT PRIMARY KEY,
        source_task_id TEXT NOT NULL,
        source_user_id TEXT NOT NULL,
        title          TEXT NOT NULL,
        summary        TEXT NOT NULL DEFAULT '',
        group_id       TEXT,
        visibility     TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        UNIQUE(source_user_id, source_task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_hub_tasks_visibility ON hub_tasks(visibility);
      CREATE INDEX IF NOT EXISTS idx_hub_tasks_group ON hub_tasks(group_id);

      CREATE TABLE IF NOT EXISTS hub_chunks (
        id              TEXT PRIMARY KEY,
        hub_task_id     TEXT NOT NULL REFERENCES hub_tasks(id) ON DELETE CASCADE,
        source_chunk_id TEXT NOT NULL,
        source_user_id  TEXT NOT NULL,
        role            TEXT NOT NULL,
        content         TEXT NOT NULL,
        summary         TEXT NOT NULL DEFAULT '',
        kind            TEXT NOT NULL DEFAULT 'paragraph',
        created_at      INTEGER NOT NULL,
        UNIQUE(source_user_id, source_chunk_id)
      );
      CREATE INDEX IF NOT EXISTS idx_hub_chunks_task ON hub_chunks(hub_task_id);

      CREATE TABLE IF NOT EXISTS hub_embeddings (
        chunk_id    TEXT PRIMARY KEY REFERENCES hub_chunks(id) ON DELETE CASCADE,
        vector      BLOB NOT NULL,
        dimensions  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS hub_chunks_fts USING fts5(
        summary,
        content,
        content='hub_chunks',
        content_rowid='rowid',
        tokenize='trigram'
      );

      CREATE TRIGGER IF NOT EXISTS hub_chunks_ai AFTER INSERT ON hub_chunks BEGIN
        INSERT INTO hub_chunks_fts(rowid, summary, content)
        VALUES (new.rowid, new.summary, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS hub_chunks_ad AFTER DELETE ON hub_chunks BEGIN
        INSERT INTO hub_chunks_fts(hub_chunks_fts, rowid, summary, content)
        VALUES ('delete', old.rowid, old.summary, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS hub_chunks_au AFTER UPDATE ON hub_chunks BEGIN
        INSERT INTO hub_chunks_fts(hub_chunks_fts, rowid, summary, content)
        VALUES ('delete', old.rowid, old.summary, old.content);
        INSERT INTO hub_chunks_fts(rowid, summary, content)
        VALUES (new.rowid, new.summary, new.content);
      END;

      CREATE TABLE IF NOT EXISTS hub_skills (
        id              TEXT PRIMARY KEY,
        source_skill_id TEXT NOT NULL,
        source_user_id  TEXT NOT NULL,
        name            TEXT NOT NULL,
        description     TEXT NOT NULL DEFAULT '',
        version         INTEGER NOT NULL,
        group_id        TEXT,
        visibility      TEXT NOT NULL,
        bundle          TEXT NOT NULL,
        quality_score   REAL,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        UNIQUE(source_user_id, source_skill_id)
      );
      CREATE INDEX IF NOT EXISTS idx_hub_skills_visibility ON hub_skills(visibility);
      CREATE INDEX IF NOT EXISTS idx_hub_skills_group ON hub_skills(group_id);

      CREATE TABLE IF NOT EXISTS hub_skill_embeddings (
        skill_id     TEXT PRIMARY KEY REFERENCES hub_skills(id) ON DELETE CASCADE,
        vector       BLOB NOT NULL,
        dimensions   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS hub_skills_fts USING fts5(
        name,
        description,
        content='hub_skills',
        content_rowid='rowid',
        tokenize='trigram'
      );

      CREATE TRIGGER IF NOT EXISTS hub_skills_ai AFTER INSERT ON hub_skills BEGIN
        INSERT INTO hub_skills_fts(rowid, name, description)
        VALUES (new.rowid, new.name, new.description);
      END;

      CREATE TRIGGER IF NOT EXISTS hub_skills_ad AFTER DELETE ON hub_skills BEGIN
        INSERT INTO hub_skills_fts(hub_skills_fts, rowid, name, description)
        VALUES ('delete', old.rowid, old.name, old.description);
      END;

      CREATE TRIGGER IF NOT EXISTS hub_skills_au AFTER UPDATE ON hub_skills BEGIN
        INSERT INTO hub_skills_fts(hub_skills_fts, rowid, name, description)
        VALUES ('delete', old.rowid, old.name, old.description);
        INSERT INTO hub_skills_fts(rowid, name, description)
        VALUES (new.rowid, new.name, new.description);
      END;

      -- Independent shared memories (not tied to a task)
      CREATE TABLE IF NOT EXISTS hub_memories (
        id              TEXT PRIMARY KEY,
        source_chunk_id TEXT NOT NULL,
        source_user_id  TEXT NOT NULL,
        source_agent    TEXT NOT NULL DEFAULT '',
        role            TEXT NOT NULL,
        content         TEXT NOT NULL,
        summary         TEXT NOT NULL DEFAULT '',
        kind            TEXT NOT NULL DEFAULT 'paragraph',
        group_id        TEXT,
        visibility      TEXT NOT NULL,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        UNIQUE(source_user_id, source_chunk_id)
      );
      CREATE INDEX IF NOT EXISTS idx_hub_memories_visibility ON hub_memories(visibility);
      CREATE INDEX IF NOT EXISTS idx_hub_memories_group ON hub_memories(group_id);

      CREATE TABLE IF NOT EXISTS hub_memory_embeddings (
        memory_id   TEXT PRIMARY KEY REFERENCES hub_memories(id) ON DELETE CASCADE,
        vector      BLOB NOT NULL,
        dimensions  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS hub_memories_fts USING fts5(
        summary,
        content,
        content='hub_memories',
        content_rowid='rowid',
        tokenize='trigram'
      );

      CREATE TRIGGER IF NOT EXISTS hub_memories_ai AFTER INSERT ON hub_memories BEGIN
        INSERT INTO hub_memories_fts(rowid, summary, content)
        VALUES (new.rowid, new.summary, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS hub_memories_ad AFTER DELETE ON hub_memories BEGIN
        INSERT INTO hub_memories_fts(hub_memories_fts, rowid, summary, content)
        VALUES ('delete', old.rowid, old.summary, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS hub_memories_au AFTER UPDATE ON hub_memories BEGIN
        INSERT INTO hub_memories_fts(hub_memories_fts, rowid, summary, content)
        VALUES ('delete', old.rowid, old.summary, old.content);
        INSERT INTO hub_memories_fts(rowid, summary, content)
        VALUES (new.rowid, new.summary, new.content);
      END;
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hub_notifications (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL,
        type        TEXT NOT NULL,
        resource    TEXT NOT NULL,
        title       TEXT NOT NULL,
        message     TEXT NOT NULL DEFAULT '',
        read        INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_hub_notif_user ON hub_notifications(user_id, read, created_at DESC);
    `);

    try {
      const cols = this.db.prepare("PRAGMA table_info(hub_users)").all() as Array<{ name: string }>;
      if (cols.length > 0 && !cols.some(c => c.name === "last_ip")) {
        this.db.exec("ALTER TABLE hub_users ADD COLUMN last_ip TEXT NOT NULL DEFAULT ''");
        this.log.info("Migrated: added last_ip column to hub_users");
      }
      if (cols.length > 0 && !cols.some(c => c.name === "last_active_at")) {
        this.db.exec("ALTER TABLE hub_users ADD COLUMN last_active_at INTEGER");
        this.log.info("Migrated: added last_active_at column to hub_users");
      }
    } catch { /* table may not exist yet */ }
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

  patternSearch(patterns: string[], opts: { role?: string; limit?: number; ownerFilter?: string[] } = {}): Array<{ chunkId: string; content: string; role: string; createdAt: number }> {
    if (patterns.length === 0) return [];
    const limit = opts.limit ?? 10;

    const conditions = patterns.map(() => "c.content LIKE ?");
    const whereClause = conditions.join(" OR ");
    const roleClause = opts.role ? " AND c.role = ?" : "";
    const params: (string | number)[] = patterns.map(p => `%${p}%`);
    if (opts.role) params.push(opts.role);

    let ownerClause = "";
    if (opts.ownerFilter && opts.ownerFilter.length > 0) {
      const placeholders = opts.ownerFilter.map(() => "?").join(",");
      ownerClause = ` AND c.owner IN (${placeholders})`;
      params.push(...opts.ownerFilter);
    }

    params.push(limit);

    try {
      const rows = this.db.prepare(`
        SELECT c.id as chunk_id, c.content, c.role, c.created_at
        FROM chunks c
        WHERE (${whereClause})${roleClause}${ownerClause} AND c.dedup_status = 'active'
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

  hubMemoryPatternSearch(patterns: string[], opts: { limit?: number } = {}): Array<{ memoryId: string; content: string; role: string; createdAt: number }> {
    if (patterns.length === 0) return [];
    const limit = opts.limit ?? 10;
    const conditions = patterns.map(() => "(hm.content LIKE ? OR hm.summary LIKE ?)");
    const params: (string | number)[] = [];
    for (const p of patterns) { params.push(`%${p}%`, `%${p}%`); }
    params.push(limit);
    try {
      const rows = this.db.prepare(`
        SELECT hm.id as memory_id, hm.content, hm.role, hm.created_at
        FROM hub_memories hm
        WHERE ${conditions.join(" OR ")}
        ORDER BY hm.created_at DESC
        LIMIT ?
      `).all(...params) as Array<{ memory_id: string; content: string; role: string; created_at: number }>;
      return rows.map(r => ({ memoryId: r.memory_id, content: r.content, role: r.role, createdAt: r.created_at }));
    } catch { return []; }
  }

  listHubMemories(opts: { limit?: number } = {}): Array<{ id: string; summary?: string; content?: string }> {
    const limit = opts.limit ?? 200;
    try {
      return this.db.prepare("SELECT id, summary, content FROM hub_memories ORDER BY created_at DESC LIMIT ?").all(limit) as Array<{ id: string; summary?: string; content?: string }>;
    } catch { return []; }
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

  /**
   * Find user-role chunks that contain system-injected content that should
   * have been stripped before storage. Returns chunk IDs and a preview.
   */
  findPollutedUserChunks(): Array<{ id: string; preview: string; reason: string }> {
    const results: Array<{ id: string; preview: string; reason: string }> = [];
    const patterns: Array<{ sql: string; reason: string }> = [
      { sql: "content LIKE '%<memory_context>%'", reason: "memory_context injection" },
      { sql: "content LIKE '%=== MemOS LONG-TERM MEMORY%'", reason: "MemOS legacy injection" },
      { sql: "content LIKE '%[MemOS Auto-Recall]%'", reason: "MemOS Auto-Recall injection" },
      { sql: "content LIKE '%## Memory system%No memories were automatically recalled%'", reason: "Memory system no-recall hint" },
      { sql: "content LIKE '%## Retrieved memories from past conversations%CRITICAL INSTRUCTION%'", reason: "prependContext recall injection" },
      { sql: "content LIKE '%VERIFIED facts the user previously shared%'", reason: "VERIFIED facts injection" },
      { sql: "content LIKE '%<memos_system_instruction>%'", reason: "memos_system_instruction injection" },
      { sql: "content LIKE '%📝 Related memories:%'", reason: "Related memories injection" },
    ];
    for (const { sql, reason } of patterns) {
      const rows = this.db.prepare(
        `SELECT id, substr(content, 1, 120) AS preview FROM chunks WHERE role = 'user' AND ${sql}`,
      ).all() as Array<{ id: string; preview: string }>;
      for (const row of rows) {
        results.push({ id: row.id, preview: row.preview, reason });
      }
    }
    return results;
  }

  /**
   * Find user chunks where user+assistant content was mixed together
   * (separated by \n\n---\n), and truncate to keep only the user's part.
   */
  fixMixedUserChunks(): number {
    const rows = this.db.prepare(
      `SELECT id, content FROM chunks WHERE role = 'user'
       AND content LIKE '%' || char(10) || char(10) || '---' || char(10) || '%'
       AND length(content) > 300`,
    ).all() as Array<{ id: string; content: string }>;

    let fixed = 0;
    for (const { id, content } of rows) {
      const dashIdx = content.indexOf("\n\n---\n");
      if (dashIdx > 5) {
        const userPart = content.slice(0, dashIdx).trim();
        if (userPart.length >= 5 && userPart.length < content.length) {
          this.db.prepare("UPDATE chunks SET content = ?, updated_at = ? WHERE id = ?")
            .run(userPart, Date.now(), id);
          fixed++;
        }
      }
    }
    return fixed;
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
    try {
      this.db.exec("DROP TRIGGER IF EXISTS tasks_fts_ai");
      this.db.exec("DROP TRIGGER IF EXISTS tasks_fts_ad");
      this.db.exec("DROP TRIGGER IF EXISTS tasks_fts_au");
      this.db.exec("DELETE FROM tasks_fts");
    } catch (_) {}
    const tables = [
      "task_skills",
      "task_embeddings",
      "skill_embeddings",
      "skill_versions",
      "skills",
      "local_shared_memories",
      "team_shared_chunks",
      "team_shared_skills",
      "local_shared_tasks",
      "embeddings",
      "chunks",
      "tasks",
      "viewer_events",
      "api_logs",
      "tool_calls",
    ];
    for (const table of tables) {
      try {
        this.db.prepare(`DELETE FROM ${table}`).run();
      } catch (err) {
        this.log.warn(`deleteAll: failed to clear ${table}: ${err}`);
      }
    }
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrateTaskEmbeddingsAndFts();
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

  disableSkill(skillId: string): boolean {
    const skill = this.getSkill(skillId);
    if (!skill || skill.status === "archived") return false;
    this.db.prepare("DELETE FROM skill_embeddings WHERE skill_id = ?").run(skillId);
    this.updateSkill(skillId, { status: "archived", installed: 0 });
    return true;
  }

  enableSkill(skillId: string): boolean {
    const skill = this.getSkill(skillId);
    if (!skill || skill.status !== "archived") return false;
    this.updateSkill(skillId, { status: "active" });
    return true;
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

  listTasks(opts: { status?: string; limit?: number; offset?: number; owner?: string; session?: string } = {}): { tasks: Task[]; total: number } {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.status) { conditions.push("status = ?"); params.push(opts.status); }
    if (opts.session) { conditions.push("session_key = ?"); params.push(opts.session); }
    if (opts.owner) {
      conditions.push("(owner = ? OR (owner = 'public' AND id IN (SELECT task_id FROM local_shared_tasks WHERE original_owner = ?)))");
      params.push(opts.owner, opts.owner);
    }
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
    // Check ANY existing chunk with the same hash (regardless of dedup_status)
    // to prevent re-creating duplicates when all prior copies have been marked duplicate/merged.
    if (owner) {
      const row = this.db.prepare(
        "SELECT id FROM chunks WHERE content_hash = ? AND owner = ? ORDER BY CASE dedup_status WHEN 'active' THEN 0 ELSE 1 END LIMIT 1",
      ).get(hash, owner) as { id: string } | undefined;
      return row?.id ?? null;
    }
    const row = this.db.prepare(
      "SELECT id FROM chunks WHERE content_hash = ? ORDER BY CASE dedup_status WHEN 'active' THEN 0 ELSE 1 END LIMIT 1",
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

  listSkills(opts: { status?: string; session?: string; owner?: string } = {}): Skill[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.status) { conditions.push("status = ?"); params.push(opts.status); }
    if (opts.owner) {
      conditions.push("(owner = ? OR owner = 'public')");
      params.push(opts.owner);
    }
    if (opts.session) {
      conditions.push(`EXISTS (
        SELECT 1
        FROM task_skills ts
        JOIN tasks t ON t.id = ts.task_id
        WHERE ts.skill_id = skills.id AND t.session_key = ?
      )`);
      params.push(opts.session);
    }
    const cond = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
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

  // ─── Task Embeddings & Search ───

  upsertTaskEmbedding(taskId: string, vector: number[]): void {
    const buf = Buffer.from(new Float32Array(vector).buffer);
    this.db.prepare(`
      INSERT OR REPLACE INTO task_embeddings (task_id, vector, dimensions, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(taskId, buf, vector.length, Date.now());
  }

  getTaskEmbeddings(owner?: string): Array<{ taskId: string; vector: number[] }> {
    let sql = `SELECT te.task_id, te.vector, te.dimensions
       FROM task_embeddings te
       JOIN tasks t ON t.id = te.task_id`;
    const params: any[] = [];
    if (owner) {
      sql += ` WHERE (t.owner = ? OR t.owner = 'public')`;
      params.push(owner);
    }
    const rows = this.db.prepare(sql).all(...params) as Array<{ task_id: string; vector: Buffer; dimensions: number }>;
    return rows.map((r) => ({
      taskId: r.task_id,
      vector: Array.from(new Float32Array(r.vector.buffer, r.vector.byteOffset, r.dimensions)),
    }));
  }

  taskFtsSearch(query: string, limit: number, owner?: string): Array<{ taskId: string; score: number }> {
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return [];
    try {
      let sql = `
        SELECT t.id as task_id, rank
        FROM tasks_fts f
        JOIN tasks t ON t.rowid = f.rowid
        WHERE tasks_fts MATCH ?`;
      const params: any[] = [sanitized];
      if (owner) {
        sql += ` AND (t.owner = ? OR t.owner = 'public')`;
        params.push(owner);
      }
      sql += ` ORDER BY rank LIMIT ?`;
      params.push(limit);
      const rows = this.db.prepare(sql).all(...params) as Array<{ task_id: string; rank: number }>;
      if (rows.length === 0) return [];
      const maxAbsRank = Math.max(...rows.map((r) => Math.abs(r.rank)));
      return rows.map((r) => ({
        taskId: r.task_id,
        score: maxAbsRank > 0 ? Math.abs(r.rank) / maxAbsRank : 0,
      }));
    } catch {
      this.log.warn(`Task FTS query failed for: "${sanitized}", returning empty`);
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

  // ─── Hub / Client connection ───

  setClientHubConnection(conn: ClientHubConnection): void {
    this.db.prepare(`
      INSERT INTO client_hub_connection (id, hub_url, user_id, username, user_token, role, connected_at, identity_key, last_known_status, hub_instance_id)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        hub_url = excluded.hub_url,
        user_id = excluded.user_id,
        username = excluded.username,
        user_token = excluded.user_token,
        role = excluded.role,
        connected_at = excluded.connected_at,
        identity_key = excluded.identity_key,
        last_known_status = excluded.last_known_status,
        hub_instance_id = excluded.hub_instance_id
    `).run(conn.hubUrl, conn.userId, conn.username, conn.userToken, conn.role, conn.connectedAt, conn.identityKey ?? "", conn.lastKnownStatus ?? "", conn.hubInstanceId ?? "");
  }

  getClientHubConnection(): ClientHubConnection | null {
    const row = this.db.prepare('SELECT * FROM client_hub_connection WHERE id = 1').get() as ClientHubConnectionRow | undefined;
    return row ? rowToClientHubConnection(row) : null;
  }

  clearClientHubConnection(): void {
    this.db.prepare('DELETE FROM client_hub_connection WHERE id = 1').run();
  }

  // ─── Local Shared Tasks (client-side tracking) ───

  markTaskShared(taskId: string, hubTaskId: string, syncedChunks: number, visibility: string, groupId?: string | null, hubInstanceId?: string): void {
    this.db.prepare(`
      INSERT INTO local_shared_tasks (task_id, hub_task_id, visibility, group_id, synced_chunks, hub_instance_id, shared_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        hub_task_id = excluded.hub_task_id,
        visibility = excluded.visibility,
        group_id = excluded.group_id,
        synced_chunks = excluded.synced_chunks,
        hub_instance_id = excluded.hub_instance_id,
        shared_at = excluded.shared_at
    `).run(taskId, hubTaskId, visibility, groupId ?? null, syncedChunks, hubInstanceId ?? "", Date.now());
  }

  unmarkTaskShared(taskId: string): void {
    this.db.prepare('DELETE FROM local_shared_tasks WHERE task_id = ?').run(taskId);
  }

  getLocalSharedTask(taskId: string): { taskId: string; hubTaskId: string; visibility: string; groupId: string | null; syncedChunks: number; sharedAt: number; hubInstanceId: string } | null {
    const row = this.db.prepare('SELECT * FROM local_shared_tasks WHERE task_id = ?').get(taskId) as any;
    if (!row) return null;
    return { taskId: row.task_id, hubTaskId: row.hub_task_id, visibility: row.visibility, groupId: row.group_id, syncedChunks: row.synced_chunks, sharedAt: row.shared_at, hubInstanceId: row.hub_instance_id || "" };
  }

  listLocalSharedTasks(): Array<{ taskId: string; hubTaskId: string; visibility: string; groupId: string | null; syncedChunks: number; hubInstanceId: string }> {
    const rows = this.db.prepare('SELECT task_id, hub_task_id, visibility, group_id, synced_chunks, hub_instance_id FROM local_shared_tasks').all() as any[];
    return rows.map(r => ({ taskId: r.task_id, hubTaskId: r.hub_task_id, visibility: r.visibility, groupId: r.group_id, syncedChunks: r.synced_chunks, hubInstanceId: r.hub_instance_id || "" }));
  }

  // ─── Local Shared Memories (client-side tracking) ───

  markMemorySharedLocally(chunkId: string): { ok: boolean; owner?: string; originalOwner?: string; sharedAt?: number; reason?: string } {
    const chunk = this.getChunk(chunkId);
    if (!chunk) return { ok: false, reason: "not_found" };
    if (chunk.owner === "public") {
      const existing = this.getLocalSharedMemory(chunkId);
      return {
        ok: true,
        owner: "public",
        originalOwner: existing?.originalOwner ?? undefined,
        sharedAt: existing?.sharedAt ?? undefined,
      };
    }

    const sharedAt = Date.now();
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO local_shared_memories (chunk_id, original_owner, shared_at)
        VALUES (?, ?, ?)
        ON CONFLICT(chunk_id) DO UPDATE SET
          original_owner = excluded.original_owner,
          shared_at = excluded.shared_at
      `).run(chunkId, chunk.owner, sharedAt);
      this.updateChunk(chunkId, { owner: "public" });
    })();

    return { ok: true, owner: "public", originalOwner: chunk.owner, sharedAt };
  }

  unmarkMemorySharedLocally(chunkId: string, fallbackOwner?: string): { ok: boolean; owner?: string; originalOwner?: string; reason?: string } {
    const chunk = this.getChunk(chunkId);
    if (!chunk) return { ok: false, reason: "not_found" };
    if (chunk.owner !== "public") {
      return { ok: true, owner: chunk.owner };
    }

    const existing = this.getLocalSharedMemory(chunkId);
    const restoreOwner = existing?.originalOwner ?? fallbackOwner;
    if (!restoreOwner || restoreOwner === "public") {
      return { ok: false, reason: "original_owner_missing" };
    }

    this.db.transaction(() => {
      this.updateChunk(chunkId, { owner: restoreOwner });
      this.db.prepare("DELETE FROM local_shared_memories WHERE chunk_id = ?").run(chunkId);
    })();

    return { ok: true, owner: restoreOwner, originalOwner: restoreOwner };
  }

  getLocalSharedMemory(chunkId: string): { chunkId: string; originalOwner: string; sharedAt: number } | null {
    const row = this.db.prepare("SELECT chunk_id, original_owner, shared_at FROM local_shared_memories WHERE chunk_id = ?").get(chunkId) as any;
    if (!row) return null;
    return {
      chunkId: row.chunk_id,
      originalOwner: row.original_owner,
      sharedAt: row.shared_at,
    };
  }

  // ─── Hub Users / Groups ───

  upsertHubUser(user: HubUserRecord): void {
    this.db.prepare(`
      INSERT INTO hub_users (id, username, device_name, role, status, token_hash, created_at, approved_at, identity_key, left_at, removed_at, rejected_at, rejoin_requested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        username = excluded.username,
        device_name = excluded.device_name,
        role = excluded.role,
        status = excluded.status,
        token_hash = excluded.token_hash,
        created_at = excluded.created_at,
        approved_at = excluded.approved_at,
        identity_key = excluded.identity_key,
        left_at = excluded.left_at,
        removed_at = excluded.removed_at,
        rejected_at = excluded.rejected_at,
        rejoin_requested_at = excluded.rejoin_requested_at
    `).run(user.id, user.username, user.deviceName ?? "", user.role, user.status, user.tokenHash, user.createdAt, user.approvedAt, user.identityKey ?? "", user.leftAt ?? null, user.removedAt ?? null, user.rejectedAt ?? null, user.rejoinRequestedAt ?? null);
  }

  getHubUser(userId: string): HubUserRecord | null {
    const row = this.db.prepare('SELECT * FROM hub_users WHERE id = ?').get(userId) as HubUserRow | undefined;
    if (!row) return null;
    const user = rowToHubUser(row);
    user.groups = this.getGroupsForHubUser(userId);
    return user;
  }

  listHubUsers(status?: UserStatus): HubUserRecord[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM hub_users WHERE status = ? ORDER BY created_at').all(status) as HubUserRow[]
      : this.db.prepare('SELECT * FROM hub_users ORDER BY created_at').all() as HubUserRow[];
    return rows.map(r => {
      const user = rowToHubUser(r);
      user.groups = this.getGroupsForHubUser(r.id);
      return user;
    });
  }

  deleteHubMemoriesByUser(userId: string): void {
    this.db.prepare('DELETE FROM hub_memories WHERE source_user_id = ?').run(userId);
  }

  deleteHubTasksByUser(userId: string): void {
    this.db.prepare('DELETE FROM hub_tasks WHERE source_user_id = ?').run(userId);
  }

  deleteHubSkillsByUser(userId: string): void {
    this.db.prepare('DELETE FROM hub_skills WHERE source_user_id = ?').run(userId);
  }

  deleteHubUser(userId: string, cleanResources = false): boolean {
    if (cleanResources) {
      this.deleteHubTasksByUser(userId);
      this.deleteHubSkillsByUser(userId);
      this.deleteHubMemoriesByUser(userId);
      const result = this.db.prepare('DELETE FROM hub_users WHERE id = ?').run(userId);
      return result.changes > 0;
    }
    const result = this.db.prepare("UPDATE hub_users SET status = 'removed', token_hash = '', removed_at = ? WHERE id = ?").run(Date.now(), userId);
    return result.changes > 0;
  }

  findHubUserByIdentityKey(identityKey: string): HubUserRecord | null {
    if (!identityKey) return null;
    const row = this.db.prepare('SELECT * FROM hub_users WHERE identity_key = ?').get(identityKey) as HubUserRow | undefined;
    return row ? rowToHubUser(row) : null;
  }

  markHubUserLeft(userId: string): boolean {
    const result = this.db.prepare("UPDATE hub_users SET status = 'left', token_hash = '', left_at = ? WHERE id = ?").run(Date.now(), userId);
    return result.changes > 0;
  }

  updateHubUserActivity(userId: string, ip: string, timestamp?: number): void {
    this.db.prepare('UPDATE hub_users SET last_ip = ?, last_active_at = ? WHERE id = ?').run(ip, timestamp ?? Date.now(), userId);
  }

  // ─── Hub Groups ───

  upsertHubGroup(group: { id: string; name: string; description?: string; createdAt: number }): void {
    this.db.prepare(`
      INSERT INTO hub_groups (id, name, description, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description
    `).run(group.id, group.name, group.description ?? "", group.createdAt);
  }

  addHubGroupMember(groupId: string, userId: string, joinedAt: number): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO hub_group_members (group_id, user_id, joined_at)
      VALUES (?, ?, ?)
    `).run(groupId, userId, joinedAt);
  }

  removeHubGroupMember(groupId: string, userId: string): void {
    this.db.prepare('DELETE FROM hub_group_members WHERE group_id = ? AND user_id = ?').run(groupId, userId);
  }

  getGroupsForHubUser(userId: string): Array<{ id: string; name: string; description: string }> {
    return this.db.prepare(`
      SELECT g.id, g.name, g.description FROM hub_groups g
      JOIN hub_group_members m ON m.group_id = g.id
      WHERE m.user_id = ?
    `).all(userId) as Array<{ id: string; name: string; description: string }>;
  }

  getHubUserContributions(): Record<string, { memoryCount: number; taskCount: number; skillCount: number }> {
    const result: Record<string, { memoryCount: number; taskCount: number; skillCount: number }> = {};
    const memRows = this.db.prepare('SELECT source_user_id, COUNT(*) as cnt FROM hub_memories GROUP BY source_user_id').all() as Array<{ source_user_id: string; cnt: number }>;
    const taskRows = this.db.prepare('SELECT source_user_id, COUNT(*) as cnt FROM hub_tasks GROUP BY source_user_id').all() as Array<{ source_user_id: string; cnt: number }>;
    const skillRows = this.db.prepare('SELECT source_user_id, COUNT(*) as cnt FROM hub_skills GROUP BY source_user_id').all() as Array<{ source_user_id: string; cnt: number }>;
    for (const r of memRows) { if (!result[r.source_user_id]) result[r.source_user_id] = { memoryCount: 0, taskCount: 0, skillCount: 0 }; result[r.source_user_id].memoryCount = r.cnt; }
    for (const r of taskRows) { if (!result[r.source_user_id]) result[r.source_user_id] = { memoryCount: 0, taskCount: 0, skillCount: 0 }; result[r.source_user_id].taskCount = r.cnt; }
    for (const r of skillRows) { if (!result[r.source_user_id]) result[r.source_user_id] = { memoryCount: 0, taskCount: 0, skillCount: 0 }; result[r.source_user_id].skillCount = r.cnt; }
    return result;
  }

  // ─── Hub Shared Data ───

  upsertHubTask(task: HubTaskRecord): void {
    this.db.prepare(`
      INSERT INTO hub_tasks (id, source_task_id, source_user_id, title, summary, group_id, visibility, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_user_id, source_task_id) DO UPDATE SET
        title = excluded.title,
        summary = excluded.summary,
        group_id = excluded.group_id,
        visibility = excluded.visibility,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `).run(task.id, task.sourceTaskId, task.sourceUserId, task.title, task.summary, task.groupId, task.visibility, task.createdAt, task.updatedAt);
  }

  getHubTaskBySource(sourceUserId: string, sourceTaskId: string): HubTaskRecord | null {
    const row = this.db.prepare('SELECT * FROM hub_tasks WHERE source_user_id = ? AND source_task_id = ?').get(sourceUserId, sourceTaskId) as HubTaskRow | undefined;
    return row ? rowToHubTask(row) : null;
  }

  getHubTaskById(taskId: string): HubTaskRecord | null {
    const row = this.db.prepare('SELECT * FROM hub_tasks WHERE id = ?').get(taskId) as HubTaskRow | undefined;
    return row ? rowToHubTask(row) : null;
  }

  upsertHubChunk(chunk: HubChunkUpsertInput): void {
    if (!chunk.sourceTaskId) throw new Error("sourceTaskId is required for hub chunk upserts");
    const taskId = this.resolveCanonicalHubTaskId(chunk.hubTaskId, chunk.sourceUserId, chunk.sourceTaskId);
    this.db.prepare(`
      INSERT INTO hub_chunks (id, hub_task_id, source_chunk_id, source_user_id, role, content, summary, kind, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_user_id, source_chunk_id) DO UPDATE SET
        hub_task_id = excluded.hub_task_id,
        role = excluded.role,
        content = excluded.content,
        summary = excluded.summary,
        kind = excluded.kind,
        created_at = excluded.created_at
    `).run(chunk.id, taskId, chunk.sourceChunkId, chunk.sourceUserId, chunk.role, chunk.content, chunk.summary, chunk.kind, chunk.createdAt);
  }

  getHubChunkBySource(sourceUserId: string, sourceChunkId: string): HubChunkRecord | null {
    const row = this.db.prepare('SELECT * FROM hub_chunks WHERE source_user_id = ? AND source_chunk_id = ?').get(sourceUserId, sourceChunkId) as HubChunkRow | undefined;
    return row ? rowToHubChunk(row) : null;
  }

  deleteHubTaskBySource(sourceUserId: string, sourceTaskId: string): void {
    this.db.prepare('DELETE FROM hub_tasks WHERE source_user_id = ? AND source_task_id = ?').run(sourceUserId, sourceTaskId);
  }

  upsertHubSkill(skill: HubSkillRecord): void {
    this.db.prepare(`
      INSERT INTO hub_skills (id, source_skill_id, source_user_id, name, description, version, group_id, visibility, bundle, quality_score, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_user_id, source_skill_id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        version = excluded.version,
        group_id = excluded.group_id,
        visibility = excluded.visibility,
        bundle = excluded.bundle,
        quality_score = excluded.quality_score,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `).run(skill.id, skill.sourceSkillId, skill.sourceUserId, skill.name, skill.description, skill.version, skill.groupId, skill.visibility, skill.bundle, skill.qualityScore, skill.createdAt, skill.updatedAt);
  }

  getHubSkillBySource(sourceUserId: string, sourceSkillId: string): HubSkillRecord | null {
    const row = this.db.prepare('SELECT * FROM hub_skills WHERE source_user_id = ? AND source_skill_id = ?').get(sourceUserId, sourceSkillId) as HubSkillRow | undefined;
    return row ? rowToHubSkill(row) : null;
  }

  getHubSkillById(skillId: string): HubSkillRecord | null {
    const row = this.db.prepare('SELECT * FROM hub_skills WHERE id = ?').get(skillId) as HubSkillRow | undefined;
    return row ? rowToHubSkill(row) : null;
  }

  upsertHubSkillEmbedding(skillId: string, vector: number[], sourceUserId: string, sourceSkillId: string): void {
    if (!sourceUserId || !sourceSkillId) throw new Error("sourceUserId and sourceSkillId are required for hub skill embedding upserts");
    const canonicalSkillId = this.resolveCanonicalHubSkillId(skillId, sourceUserId, sourceSkillId);
    const buf = Buffer.allocUnsafe(vector.length * 4);
    for (let i = 0; i < vector.length; i++) buf.writeFloatLE(vector[i], i * 4);
    this.db.prepare(`
      INSERT INTO hub_skill_embeddings (skill_id, vector, dimensions, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(skill_id) DO UPDATE SET
        vector = excluded.vector,
        dimensions = excluded.dimensions,
        updated_at = excluded.updated_at
    `).run(canonicalSkillId, buf, vector.length, Date.now());
  }

  getHubSkillEmbedding(skillId: string): number[] | null {
    const row = this.db.prepare('SELECT vector, dimensions FROM hub_skill_embeddings WHERE skill_id = ?').get(skillId) as { vector: Buffer; dimensions: number } | undefined;
    if (!row) return null;
    const out: number[] = [];
    for (let i = 0; i < row.dimensions; i++) out.push(row.vector.readFloatLE(i * 4));
    return out;
  }

  getVisibleHubSkillEmbeddings(): Array<{ skillId: string; vector: Float32Array }> {
    const rows = this.db.prepare(`
      SELECT hse.skill_id, hse.vector, hse.dimensions
      FROM hub_skill_embeddings hse
      JOIN hub_skills hs ON hs.id = hse.skill_id
    `).all() as Array<{ skill_id: string; vector: Buffer; dimensions: number }>;
    return rows.map(r => ({
      skillId: r.skill_id,
      vector: new Float32Array(r.vector.buffer, r.vector.byteOffset, r.dimensions),
    }));
  }

  upsertHubMemoryEmbedding(memoryId: string, vector: Float32Array): void {
    const buf = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    this.db.prepare(`
      INSERT INTO hub_memory_embeddings (memory_id, vector, dimensions, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(memory_id) DO UPDATE SET vector = excluded.vector, dimensions = excluded.dimensions, updated_at = excluded.updated_at
    `).run(memoryId, buf, vector.length, Date.now());
  }

  getHubMemoryEmbedding(memoryId: string): Float32Array | null {
    const row = this.db.prepare('SELECT vector, dimensions FROM hub_memory_embeddings WHERE memory_id = ?').get(memoryId) as { vector: Buffer; dimensions: number } | undefined;
    if (!row) return null;
    return new Float32Array(row.vector.buffer, row.vector.byteOffset, row.dimensions);
  }

  getVisibleHubMemoryEmbeddings(userId: string): Array<{ memoryId: string; vector: Float32Array }> {
    const rows = this.db.prepare(`
      SELECT hme.memory_id, hme.vector, hme.dimensions
      FROM hub_memory_embeddings hme
      JOIN hub_memories hm ON hm.id = hme.memory_id
      WHERE hm.visibility = 'public'
        OR hm.source_user_id = ?
        OR EXISTS (SELECT 1 FROM hub_group_members gm WHERE gm.group_id = hm.group_id AND gm.user_id = ?)
    `).all(userId, userId) as Array<{ memory_id: string; vector: Buffer; dimensions: number }>;
    return rows.map(r => ({
      memoryId: r.memory_id,
      vector: new Float32Array(r.vector.buffer, r.vector.byteOffset, r.dimensions),
    }));
  }

  searchHubChunks(query: string, options?: { userId?: string; maxResults?: number }): Array<{ hit: HubSearchRow; rank: number }> {
    const limit = options?.maxResults ?? 10;
    const userId = options?.userId ?? "";
    const rows = this.db.prepare(`
      SELECT hc.id, hc.content, hc.summary, hc.role, hc.created_at, ht.title as task_title, ht.visibility,
             COALESCE(hg.name, '') as group_name, hu.username as owner_name,
             bm25(hub_chunks_fts) as rank
      FROM hub_chunks_fts f
      JOIN hub_chunks hc ON hc.rowid = f.rowid
      JOIN hub_tasks ht ON ht.id = hc.hub_task_id
      LEFT JOIN hub_users hu ON hu.id = ht.source_user_id
      LEFT JOIN hub_groups hg ON hg.id = ht.group_id
      WHERE hub_chunks_fts MATCH ?
        AND (ht.visibility = 'public'
             OR ht.source_user_id = ?
             OR EXISTS (SELECT 1 FROM hub_group_members gm WHERE gm.group_id = ht.group_id AND gm.user_id = ?))
      ORDER BY rank
      LIMIT ?
    `).all(sanitizeFtsQuery(query), userId, userId, limit) as HubSearchRow[];
    return rows.map((row, idx) => ({ hit: row, rank: idx + 1 }));
  }

  upsertHubEmbedding(chunkId: string, vector: Float32Array): void {
    const buf = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    this.db.prepare(`
      INSERT INTO hub_embeddings (chunk_id, vector, dimensions, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(chunk_id) DO UPDATE SET vector = excluded.vector, dimensions = excluded.dimensions, updated_at = excluded.updated_at
    `).run(chunkId, buf, vector.length, Date.now());
  }

  getHubEmbedding(chunkId: string): Float32Array | null {
    const row = this.db.prepare('SELECT vector, dimensions FROM hub_embeddings WHERE chunk_id = ?').get(chunkId) as { vector: Buffer; dimensions: number } | undefined;
    if (!row) return null;
    return new Float32Array(row.vector.buffer, row.vector.byteOffset, row.dimensions);
  }

  getVisibleHubEmbeddings(userId: string): Array<{ chunkId: string; vector: Float32Array }> {
    const rows = this.db.prepare(`
      SELECT he.chunk_id, he.vector, he.dimensions
      FROM hub_embeddings he
      JOIN hub_chunks hc ON hc.id = he.chunk_id
      JOIN hub_tasks ht ON ht.id = hc.hub_task_id
      WHERE ht.visibility = 'public'
        OR ht.source_user_id = ?
        OR EXISTS (SELECT 1 FROM hub_group_members gm WHERE gm.group_id = ht.group_id AND gm.user_id = ?)
    `).all(userId, userId) as Array<{ chunk_id: string; vector: Buffer; dimensions: number }>;
    return rows.map(r => ({
      chunkId: r.chunk_id,
      vector: new Float32Array(r.vector.buffer, r.vector.byteOffset, r.dimensions),
    }));
  }

  getVisibleHubSearchHitByChunkId(chunkId: string, userId: string): HubSearchRow | null {
    const row = this.db.prepare(`
      SELECT hc.id, hc.content, hc.summary, hc.role, hc.created_at, ht.title as task_title, ht.visibility,
             COALESCE(hg.name, '') as group_name, hu.username as owner_name,
             0 as rank
      FROM hub_chunks hc
      JOIN hub_tasks ht ON ht.id = hc.hub_task_id
      LEFT JOIN hub_users hu ON hu.id = ht.source_user_id
      LEFT JOIN hub_groups hg ON hg.id = ht.group_id
      WHERE hc.id = ?
        AND (ht.visibility = 'public'
             OR ht.source_user_id = ?
             OR EXISTS (SELECT 1 FROM hub_group_members gm WHERE gm.group_id = ht.group_id AND gm.user_id = ?))
      LIMIT 1
    `).get(chunkId, userId, userId) as HubSearchRow | undefined;
    return row ?? null;
  }

  getHubChunkById(chunkId: string): HubChunkRecord | null {
    const row = this.db.prepare('SELECT * FROM hub_chunks WHERE id = ?').get(chunkId) as HubChunkRow | undefined;
    return row ? rowToHubChunk(row) : null;
  }

  searchHubSkills(query: string, options?: { userId?: string; maxResults?: number }): Array<{ hit: HubSkillSearchRow; rank: number }> {
    const limit = options?.maxResults ?? 10;
    const userId = options?.userId ?? "";
    const sanitized = sanitizeFtsQuery(query);
    let rows: HubSkillSearchRow[];
    if (sanitized) {
      rows = this.db.prepare(`
        SELECT hs.id, hs.name, hs.description, hs.version, hs.visibility, '' AS group_name, hu.username AS owner_name, hu.status AS owner_status, hs.quality_score,
               bm25(hub_skills_fts) as rank
        FROM hub_skills_fts f
        JOIN hub_skills hs ON hs.rowid = f.rowid
        LEFT JOIN hub_users hu ON hu.id = hs.source_user_id
        WHERE hub_skills_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(sanitized, limit) as HubSkillSearchRow[];
    } else {
      rows = this.db.prepare(`
        SELECT hs.id, hs.name, hs.description, hs.version, hs.visibility, '' AS group_name, hu.username AS owner_name, hu.status AS owner_status, hs.quality_score,
               0 as rank
        FROM hub_skills hs
        LEFT JOIN hub_users hu ON hu.id = hs.source_user_id
        ORDER BY hs.updated_at DESC
        LIMIT ?
      `).all(limit) as HubSkillSearchRow[];
    }
    return rows.map((row, idx) => ({ hit: row, rank: idx + 1 }));
  }

  deleteHubSkillBySource(sourceUserId: string, sourceSkillId: string): void {
    this.db.prepare('DELETE FROM hub_skills WHERE source_user_id = ? AND source_skill_id = ?').run(sourceUserId, sourceSkillId);
  }

  listVisibleHubTasks(userId: string, limit = 40): Array<{ id: string; sourceTaskId: string; sourceUserId: string; title: string; summary: string; groupId: string | null; groupName: string | null; visibility: string; ownerName: string; ownerStatus: string; chunkCount: number; createdAt: number; updatedAt: number }> {
    const rows = this.db.prepare(`
      SELECT t.*, u.username AS owner_name, u.status AS owner_status, NULL AS group_name,
        (SELECT COUNT(*) FROM hub_chunks c WHERE c.hub_task_id = t.id) AS chunk_count
      FROM hub_tasks t
      LEFT JOIN hub_users u ON u.id = t.source_user_id
      ORDER BY t.updated_at DESC
      LIMIT ?
    `).all(limit) as any[];
    return rows.map(r => ({
      id: r.id, sourceTaskId: r.source_task_id, sourceUserId: r.source_user_id,
      title: r.title, summary: r.summary, groupId: r.group_id, groupName: r.group_name ?? null,
      visibility: r.visibility, ownerName: r.owner_name ?? "unknown", ownerStatus: r.owner_status ?? "", chunkCount: r.chunk_count ?? 0,
      createdAt: r.created_at, updatedAt: r.updated_at,
    }));
  }

  listAllHubTasks(): Array<{ id: string; sourceTaskId: string; sourceUserId: string; title: string; summary: string; groupId: string | null; groupName: string | null; visibility: string; ownerName: string; ownerStatus: string; chunkCount: number; createdAt: number; updatedAt: number }> {
    const rows = this.db.prepare(`
      SELECT t.*, u.username AS owner_name, u.status AS owner_status,
        (SELECT COUNT(*) FROM hub_chunks c WHERE c.hub_task_id = t.id) AS chunk_count
      FROM hub_tasks t
      LEFT JOIN hub_users u ON u.id = t.source_user_id
      ORDER BY t.updated_at DESC
    `).all() as any[];
    return rows.map(r => ({
      id: r.id, sourceTaskId: r.source_task_id, sourceUserId: r.source_user_id,
      title: r.title, summary: r.summary, groupId: r.group_id, groupName: null as string | null,
      visibility: r.visibility, ownerName: r.owner_name ?? "unknown", ownerStatus: r.owner_status ?? "", chunkCount: r.chunk_count ?? 0,
      createdAt: r.created_at, updatedAt: r.updated_at,
    }));
  }

  listHubChunksByTaskId(hubTaskId: string): HubChunkRecord[] {
    const rows = this.db.prepare('SELECT * FROM hub_chunks WHERE hub_task_id = ? ORDER BY created_at ASC').all(hubTaskId) as HubChunkRow[];
    return rows.map(rowToHubChunk);
  }

  deleteHubTaskById(taskId: string): boolean {
    const info = this.db.prepare('DELETE FROM hub_tasks WHERE id = ?').run(taskId);
    return info.changes > 0;
  }

  listVisibleHubSkills(userId: string, limit = 40): Array<{ id: string; sourceSkillId: string; sourceUserId: string; name: string; description: string; version: number; groupId: string | null; groupName: string | null; visibility: string; ownerName: string; ownerStatus: string; qualityScore: number | null; createdAt: number; updatedAt: number }> {
    const rows = this.db.prepare(`
      SELECT s.*, u.username AS owner_name, u.status AS owner_status, NULL AS group_name
      FROM hub_skills s
      LEFT JOIN hub_users u ON u.id = s.source_user_id
      ORDER BY s.updated_at DESC
      LIMIT ?
    `).all(limit) as any[];
    return rows.map(r => ({
      id: r.id, sourceSkillId: r.source_skill_id, sourceUserId: r.source_user_id,
      name: r.name, description: r.description, version: r.version,
      groupId: r.group_id, groupName: r.group_name ?? null, visibility: r.visibility,
      ownerName: r.owner_name ?? "unknown", ownerStatus: r.owner_status ?? "", qualityScore: r.quality_score,
      createdAt: r.created_at, updatedAt: r.updated_at,
    }));
  }

  listAllHubSkills(): Array<{ id: string; sourceSkillId: string; sourceUserId: string; name: string; description: string; version: number; groupId: string | null; groupName: string | null; visibility: string; ownerName: string; ownerStatus: string; qualityScore: number | null; createdAt: number; updatedAt: number }> {
    const rows = this.db.prepare(`
      SELECT s.*, u.username AS owner_name, u.status AS owner_status
      FROM hub_skills s
      LEFT JOIN hub_users u ON u.id = s.source_user_id
      ORDER BY s.updated_at DESC
    `).all() as any[];
    return rows.map(r => ({
      id: r.id, sourceSkillId: r.source_skill_id, sourceUserId: r.source_user_id,
      name: r.name, description: r.description, version: r.version,
      groupId: r.group_id, groupName: null as string | null, visibility: r.visibility,
      ownerName: r.owner_name ?? "unknown", ownerStatus: r.owner_status ?? "", qualityScore: r.quality_score,
      createdAt: r.created_at, updatedAt: r.updated_at,
    }));
  }

  deleteHubSkillById(skillId: string): boolean {
    const info = this.db.prepare('DELETE FROM hub_skills WHERE id = ?').run(skillId);
    return info.changes > 0;
  }

  // ─── Hub Shared Memories (independent) ───

  upsertHubMemory(memory: HubMemoryRecord): void {
    this.db.prepare(`
      INSERT INTO hub_memories (id, source_chunk_id, source_user_id, source_agent, role, content, summary, kind, group_id, visibility, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_user_id, source_chunk_id) DO UPDATE SET
        source_agent = excluded.source_agent,
        role = excluded.role,
        content = excluded.content,
        summary = excluded.summary,
        kind = excluded.kind,
        group_id = excluded.group_id,
        visibility = excluded.visibility,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `).run(memory.id, memory.sourceChunkId, memory.sourceUserId, memory.sourceAgent, memory.role, memory.content, memory.summary, memory.kind, memory.groupId, memory.visibility, memory.createdAt, memory.updatedAt);
  }

  getHubMemoryBySource(sourceUserId: string, sourceChunkId: string): HubMemoryRecord | null {
    const row = this.db.prepare('SELECT * FROM hub_memories WHERE source_user_id = ? AND source_chunk_id = ?').get(sourceUserId, sourceChunkId) as HubMemoryRow | undefined;
    return row ? rowToHubMemory(row) : null;
  }

  getHubMemoryById(memoryId: string): HubMemoryRecord | null {
    const row = this.db.prepare('SELECT * FROM hub_memories WHERE id = ?').get(memoryId) as HubMemoryRow | undefined;
    return row ? rowToHubMemory(row) : null;
  }

  deleteHubMemoryBySource(sourceUserId: string, sourceChunkId: string): void {
    this.db.prepare('DELETE FROM hub_memories WHERE source_user_id = ? AND source_chunk_id = ?').run(sourceUserId, sourceChunkId);
  }

  deleteHubMemoryById(memoryId: string): boolean {
    const info = this.db.prepare('DELETE FROM hub_memories WHERE id = ?').run(memoryId);
    return info.changes > 0;
  }

  // ─── Team share metadata (Client role — UI only, not used for local recall / FTS) ───

  upsertTeamSharedChunk(
    chunkId: string,
    row: { hubMemoryId?: string; visibility?: string; groupId?: string | null; hubInstanceId?: string },
  ): void {
    const now = Date.now();
    const vis = row.visibility === "group" ? "group" : "public";
    const gid = vis === "group" ? (row.groupId ?? null) : null;
    this.db.prepare(`
      INSERT INTO team_shared_chunks (chunk_id, hub_memory_id, visibility, group_id, hub_instance_id, shared_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(chunk_id) DO UPDATE SET
        hub_memory_id = excluded.hub_memory_id,
        visibility = excluded.visibility,
        group_id = excluded.group_id,
        hub_instance_id = excluded.hub_instance_id,
        shared_at = excluded.shared_at
    `).run(chunkId, row.hubMemoryId ?? "", vis, gid, row.hubInstanceId ?? "", now);
  }

  getTeamSharedChunk(chunkId: string): { chunkId: string; hubMemoryId: string; visibility: string; groupId: string | null; hubInstanceId: string; sharedAt: number } | null {
    const r = this.db.prepare("SELECT chunk_id, hub_memory_id, visibility, group_id, hub_instance_id, shared_at FROM team_shared_chunks WHERE chunk_id = ?").get(chunkId) as {
      chunk_id: string; hub_memory_id: string; visibility: string; group_id: string | null; hub_instance_id: string; shared_at: number;
    } | undefined;
    if (!r) return null;
    return {
      chunkId: r.chunk_id,
      hubMemoryId: r.hub_memory_id,
      visibility: r.visibility,
      groupId: r.group_id,
      hubInstanceId: r.hub_instance_id || "",
      sharedAt: r.shared_at,
    };
  }

  deleteTeamSharedChunk(chunkId: string): boolean {
    const info = this.db.prepare("DELETE FROM team_shared_chunks WHERE chunk_id = ?").run(chunkId);
    return info.changes > 0;
  }

  // ─── Team Shared Skills (Client role — UI metadata only) ───

  upsertTeamSharedSkill(skillId: string, row: { hubSkillId?: string; visibility?: string; groupId?: string | null; hubInstanceId?: string }): void {
    const now = Date.now();
    const vis = row.visibility === "group" ? "group" : "public";
    const gid = vis === "group" ? (row.groupId ?? null) : null;
    this.db.prepare(`
      INSERT INTO team_shared_skills (skill_id, hub_skill_id, visibility, group_id, hub_instance_id, shared_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(skill_id) DO UPDATE SET
        hub_skill_id = excluded.hub_skill_id,
        visibility = excluded.visibility,
        group_id = excluded.group_id,
        hub_instance_id = excluded.hub_instance_id,
        shared_at = excluded.shared_at
    `).run(skillId, row.hubSkillId ?? "", vis, gid, row.hubInstanceId ?? "", now);
  }

  getTeamSharedSkill(skillId: string): { skillId: string; hubSkillId: string; visibility: string; groupId: string | null; hubInstanceId: string; sharedAt: number } | null {
    const r = this.db.prepare("SELECT * FROM team_shared_skills WHERE skill_id = ?").get(skillId) as any;
    if (!r) return null;
    return { skillId: r.skill_id, hubSkillId: r.hub_skill_id, visibility: r.visibility, groupId: r.group_id, hubInstanceId: r.hub_instance_id || "", sharedAt: r.shared_at };
  }

  deleteTeamSharedSkill(skillId: string): boolean {
    return this.db.prepare("DELETE FROM team_shared_skills WHERE skill_id = ?").run(skillId).changes > 0;
  }

  // ─── Team sharing cleanup (role switch / leave) ───

  clearTeamSharedChunks(): void {
    this.db.prepare("DELETE FROM team_shared_chunks").run();
  }

  clearTeamSharedSkills(): void {
    this.db.prepare("DELETE FROM team_shared_skills").run();
  }

  downgradeTeamSharedTasksToLocal(): void {
    this.db.prepare("UPDATE local_shared_tasks SET hub_task_id = '', hub_instance_id = '', visibility = 'public', group_id = NULL, synced_chunks = 0").run();
  }

  downgradeTeamSharedTaskToLocal(taskId: string): void {
    this.db.prepare("UPDATE local_shared_tasks SET hub_task_id = '', hub_instance_id = '', visibility = 'public', group_id = NULL, synced_chunks = 0 WHERE task_id = ?").run(taskId);
  }

  /** Client UI: remove team_shared_chunks rows for all chunks linked to this task (list badge chunk fallback). */
  clearTeamSharedChunksForTask(taskId: string): void {
    this.db.prepare("DELETE FROM team_shared_chunks WHERE chunk_id IN (SELECT id FROM chunks WHERE task_id = ?)").run(taskId);
  }

  clearAllTeamSharingState(): void {
    this.clearTeamSharedChunks();
    this.clearTeamSharedSkills();
    this.downgradeTeamSharedTasksToLocal();
  }

  // ─── Hub Notifications ───

  insertHubNotification(n: { id: string; userId: string; type: string; resource: string; title: string; message?: string }): void {
    this.db.prepare(
      'INSERT INTO hub_notifications (id, user_id, type, resource, title, message, read, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)'
    ).run(n.id, n.userId, n.type, n.resource, n.title, n.message ?? '', Date.now());
  }

  hasRecentHubNotification(userId: string, type: string, resource: string, windowMs: number = 300_000): boolean {
    const since = Date.now() - windowMs;
    const row = this.db.prepare(
      'SELECT COUNT(*) AS cnt FROM hub_notifications WHERE user_id = ? AND type = ? AND resource = ? AND created_at > ?'
    ).get(userId, type, resource, since) as { cnt: number };
    return row.cnt > 0;
  }

  listHubNotifications(userId: string, opts?: { unreadOnly?: boolean; limit?: number }): Array<{ id: string; userId: string; type: string; resource: string; title: string; message: string; read: boolean; createdAt: number }> {
    const where = opts?.unreadOnly ? 'WHERE user_id = ? AND read = 0' : 'WHERE user_id = ?';
    const limit = opts?.limit ?? 50;
    const rows = this.db.prepare(`SELECT * FROM hub_notifications ${where} ORDER BY created_at DESC LIMIT ?`).all(userId, limit) as any[];
    return rows.map(r => ({ id: r.id, userId: r.user_id, type: r.type, resource: r.resource, title: r.title, message: r.message, read: !!r.read, createdAt: r.created_at }));
  }

  countUnreadHubNotifications(userId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS cnt FROM hub_notifications WHERE user_id = ? AND read = 0').get(userId) as { cnt: number };
    return row.cnt;
  }

  markHubNotificationsRead(userId: string, ids?: string[]): void {
    if (ids && ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      this.db.prepare(`UPDATE hub_notifications SET read = 1 WHERE user_id = ? AND id IN (${placeholders})`).run(userId, ...ids);
    } else {
      this.db.prepare('UPDATE hub_notifications SET read = 1 WHERE user_id = ?').run(userId);
    }
  }

  clearHubNotifications(userId: string): void {
    this.db.prepare('DELETE FROM hub_notifications WHERE user_id = ?').run(userId);
  }

  // upsertHubMemoryEmbedding / getHubMemoryEmbedding removed:
  // hub memory vectors are now computed on-the-fly at search time.

  searchHubMemories(query: string, options?: { userId?: string; maxResults?: number }): Array<{ hit: HubMemorySearchRow; rank: number }> {
    const limit = options?.maxResults ?? 10;
    const userId = options?.userId ?? "";
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return [];
    const rows = this.db.prepare(`
      SELECT hm.id, hm.content, hm.summary, hm.role, hm.created_at, hm.visibility, '' as group_name, hu.username as owner_name,
             COALESCE(hm.source_agent, '') as source_agent, bm25(hub_memories_fts) as rank
      FROM hub_memories_fts f
      JOIN hub_memories hm ON hm.rowid = f.rowid
      LEFT JOIN hub_users hu ON hu.id = hm.source_user_id
      WHERE hub_memories_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(sanitized, limit) as HubMemorySearchRow[];
    return rows.map((row, idx) => ({ hit: row, rank: idx + 1 }));
  }

  // getVisibleHubMemoryEmbeddings removed: vectors computed on-the-fly at search time.

  getVisibleHubSearchHitByMemoryId(memoryId: string, userId: string): HubMemorySearchRow | null {
    const row = this.db.prepare(`
      SELECT hm.id, hm.content, hm.summary, hm.role, hm.created_at, hm.visibility, '' as group_name, hu.username as owner_name,
             COALESCE(hm.source_agent, '') as source_agent, 0 as rank
      FROM hub_memories hm
      LEFT JOIN hub_users hu ON hu.id = hm.source_user_id
      WHERE hm.id = ?
      LIMIT 1
    `).get(memoryId) as HubMemorySearchRow | undefined;
    return row ?? null;
  }

  listVisibleHubMemories(userId: string, limit = 40): Array<{ id: string; sourceChunkId: string; sourceUserId: string; role: string; content: string; summary: string; kind: string; groupId: string | null; groupName: string | null; visibility: string; ownerName: string; ownerStatus: string; createdAt: number; updatedAt: number }> {
    const rows = this.db.prepare(`
      SELECT m.*, u.username AS owner_name, u.status AS owner_status, NULL AS group_name
      FROM hub_memories m
      LEFT JOIN hub_users u ON u.id = m.source_user_id
      ORDER BY m.updated_at DESC
      LIMIT ?
    `).all(limit) as any[];
    return rows.map(r => ({
      id: r.id, sourceChunkId: r.source_chunk_id, sourceUserId: r.source_user_id,
      role: r.role, content: r.content ?? "", summary: r.summary, kind: r.kind,
      groupId: r.group_id, groupName: r.group_name ?? null, visibility: r.visibility,
      ownerName: r.owner_name ?? "unknown", ownerStatus: r.owner_status ?? "", createdAt: r.created_at, updatedAt: r.updated_at,
    }));
  }

  listAllHubMemories(): Array<{ id: string; sourceChunkId: string; sourceUserId: string; role: string; content: string; summary: string; kind: string; groupId: string | null; groupName: string | null; visibility: string; ownerName: string; ownerStatus: string; createdAt: number; updatedAt: number }> {
    const rows = this.db.prepare(`
      SELECT m.*, u.username AS owner_name, u.status AS owner_status
      FROM hub_memories m
      LEFT JOIN hub_users u ON u.id = m.source_user_id
      ORDER BY m.updated_at DESC
    `).all() as any[];
    return rows.map(r => ({
      id: r.id, sourceChunkId: r.source_chunk_id, sourceUserId: r.source_user_id,
      role: r.role, content: r.content ?? "", summary: r.summary, kind: r.kind,
      groupId: r.group_id, groupName: null as string | null, visibility: r.visibility,
      ownerName: r.owner_name ?? "unknown", ownerStatus: r.owner_status ?? "", createdAt: r.created_at, updatedAt: r.updated_at,
    }));
  }

  private resolveCanonicalHubTaskId(taskId: string, sourceUserId: string, sourceTaskId?: string): string {
    if (sourceTaskId) {
      const bySource = this.db.prepare('SELECT id FROM hub_tasks WHERE source_user_id = ? AND source_task_id = ?').get(sourceUserId, sourceTaskId) as { id: string } | undefined;
      if (!bySource) throw new Error(`source task not found for user=${sourceUserId} sourceTaskId=${sourceTaskId}`);
      if (bySource.id != taskId) throw new Error(`mismatch between source task and hubTaskId: expected ${bySource.id}, got ${taskId}`);
      return bySource.id;
    }
    throw new Error(`source task not found for user=${sourceUserId} taskId=${taskId}`);
  }

  private resolveCanonicalHubSkillId(skillId: string, sourceUserId?: string, sourceSkillId?: string): string {
    if (sourceUserId && sourceSkillId) {
      const bySource = this.db.prepare('SELECT id FROM hub_skills WHERE source_user_id = ? AND source_skill_id = ?').get(sourceUserId, sourceSkillId) as { id: string } | undefined;
      if (!bySource) throw new Error(`source skill not found for user=${sourceUserId} sourceSkillId=${sourceSkillId}`);
      if (bySource.id != skillId) throw new Error(`mismatch between source skill and skillId: expected ${bySource.id}, got ${skillId}`);
      return bySource.id;
    }
    throw new Error(`source skill not found for skillId=${skillId}`);
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
    .replace(/[."""(){}[\]*:^~!@#$%&\\/<>,;'`-]/g, " ")
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


interface ClientHubConnection {
  hubUrl: string;
  userId: string;
  username: string;
  userToken: string;
  role: UserRole;
  connectedAt: number;
  identityKey?: string;
  lastKnownStatus?: string;
  hubInstanceId?: string;
}

interface ClientHubConnectionRow {
  hub_url: string;
  user_id: string;
  username: string;
  user_token: string;
  role: string;
  connected_at: number;
  identity_key?: string;
  last_known_status?: string;
  hub_instance_id?: string;
}

function rowToClientHubConnection(row: ClientHubConnectionRow): ClientHubConnection {
  return {
    hubUrl: row.hub_url,
    userId: row.user_id,
    username: row.username,
    userToken: row.user_token,
    role: row.role as UserRole,
    connectedAt: row.connected_at,
    identityKey: row.identity_key || "",
    lastKnownStatus: row.last_known_status || "",
    hubInstanceId: row.hub_instance_id || "",
  };
}

interface HubUserRecord extends UserInfo {
  tokenHash: string;
  createdAt: number;
  approvedAt: number | null;
  lastIp: string;
  lastActiveAt: number | null;
  identityKey?: string;
  leftAt?: number | null;
  removedAt?: number | null;
  rejectedAt?: number | null;
  rejoinRequestedAt?: number | null;
}

interface HubUserRow {
  id: string;
  username: string;
  device_name: string;
  role: string;
  status: string;
  token_hash: string;
  created_at: number;
  approved_at: number | null;
  last_ip: string;
  last_active_at: number | null;
  identity_key?: string;
  left_at?: number | null;
  removed_at?: number | null;
  rejected_at?: number | null;
  rejoin_requested_at?: number | null;
}

function rowToHubUser(row: HubUserRow): HubUserRecord {
  return {
    id: row.id,
    username: row.username,
    deviceName: row.device_name || undefined,
    role: row.role as UserRole,
    status: row.status as UserStatus,
    groups: [],
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    lastIp: row.last_ip || "",
    lastActiveAt: row.last_active_at ?? null,
    identityKey: row.identity_key || "",
    leftAt: row.left_at ?? null,
    removedAt: row.removed_at ?? null,
    rejectedAt: row.rejected_at ?? null,
    rejoinRequestedAt: row.rejoin_requested_at ?? null,
  };
}

interface HubTaskRecord {
  id: string;
  sourceTaskId: string;
  sourceUserId: string;
  title: string;
  summary: string;
  groupId: string | null;
  visibility: SharedVisibility;
  createdAt: number;
  updatedAt: number;
}

interface HubTaskRow {
  id: string;
  source_task_id: string;
  source_user_id: string;
  title: string;
  summary: string;
  group_id: string | null;
  visibility: string;
  created_at: number;
  updated_at: number;
}

function rowToHubTask(row: HubTaskRow): HubTaskRecord {
  return {
    id: row.id,
    sourceTaskId: row.source_task_id,
    sourceUserId: row.source_user_id,
    title: row.title,
    summary: row.summary,
    groupId: row.group_id,
    visibility: row.visibility as SharedVisibility,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface HubChunkUpsertInput {
  id: string;
  hubTaskId: string;
  sourceTaskId: string;
  sourceChunkId: string;
  sourceUserId: string;
  role: Chunk["role"];
  content: string;
  summary: string;
  kind: Chunk["kind"];
  createdAt: number;
}

interface HubChunkRecord {
  id: string;
  hubTaskId: string;
  sourceChunkId: string;
  sourceUserId: string;
  role: Chunk["role"];
  content: string;
  summary: string;
  kind: Chunk["kind"];
  createdAt: number;
}

interface HubChunkRow {
  id: string;
  hub_task_id: string;
  source_chunk_id: string;
  source_user_id: string;
  role: string;
  content: string;
  summary: string;
  kind: string;
  created_at: number;
}

function rowToHubChunk(row: HubChunkRow): HubChunkRecord {
  return {
    id: row.id,
    hubTaskId: row.hub_task_id,
    sourceChunkId: row.source_chunk_id,
    sourceUserId: row.source_user_id,
    role: row.role as Chunk["role"],
    content: row.content,
    summary: row.summary,
    kind: row.kind as Chunk["kind"],
    createdAt: row.created_at,
  };
}

interface HubSkillRecord {
  id: string;
  sourceSkillId: string;
  sourceUserId: string;
  name: string;
  description: string;
  version: number;
  groupId: string | null;
  visibility: SharedVisibility;
  bundle: string;
  qualityScore: number | null;
  createdAt: number;
  updatedAt: number;
}

interface HubSkillRow {
  id: string;
  source_skill_id: string;
  source_user_id: string;
  name: string;
  description: string;
  version: number;
  group_id: string | null;
  visibility: string;
  bundle: string;
  quality_score: number | null;
  created_at: number;
  updated_at: number;
}

function rowToHubSkill(row: HubSkillRow): HubSkillRecord {
  return {
    id: row.id,
    sourceSkillId: row.source_skill_id,
    sourceUserId: row.source_user_id,
    name: row.name,
    description: row.description,
    version: row.version,
    groupId: row.group_id,
    visibility: row.visibility as SharedVisibility,
    bundle: row.bundle,
    qualityScore: row.quality_score,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}


interface HubSkillSearchRow {
  id: string;
  name: string;
  description: string;
  version: number;
  visibility: string;
  group_name: string | null;
  owner_name: string | null;
  owner_status: string | null;
  quality_score: number | null;
}

interface HubSearchRow {
  id: string;
  content: string;
  summary: string;
  role: string;
  created_at: number;
  task_title: string | null;
  visibility: string;
  group_name: string | null;
  owner_name: string | null;
  rank: number;
}

export interface HubMemoryRecord {
  id: string;
  sourceChunkId: string;
  sourceUserId: string;
  sourceAgent: string;
  role: string;
  content: string;
  summary: string;
  kind: string;
  groupId: string | null;
  visibility: SharedVisibility;
  createdAt: number;
  updatedAt: number;
}

interface HubMemoryRow {
  id: string;
  source_chunk_id: string;
  source_user_id: string;
  source_agent: string;
  role: string;
  content: string;
  summary: string;
  kind: string;
  group_id: string | null;
  visibility: string;
  created_at: number;
  updated_at: number;
}

function rowToHubMemory(row: HubMemoryRow): HubMemoryRecord {
  return {
    id: row.id,
    sourceChunkId: row.source_chunk_id,
    sourceUserId: row.source_user_id,
    sourceAgent: row.source_agent || "",
    role: row.role,
    content: row.content,
    summary: row.summary,
    kind: row.kind,
    groupId: row.group_id,
    visibility: row.visibility as SharedVisibility,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface HubMemorySearchRow {
  id: string;
  content: string;
  summary: string;
  role: string;
  created_at: number;
  visibility: string;
  group_name: string | null;
  owner_name: string | null;
  source_agent: string;
  rank: number;
}


function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
