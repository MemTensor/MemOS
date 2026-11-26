import { connectionIdentity, defaultUploadMaxBytes, type Configuration } from '../config/config.ts';
import { hasTaskContent, compactUploadMessage, uploadValidationError } from '../adapters/_shared/message-content.ts';
import { topicContent } from '../recall/format.ts';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { basename, isAbsolute, resolve, sep } from 'node:path';
import { chmodSync } from 'node:fs';
import type { AgentEvent, TraceInput, Message } from '../adapters/types.ts';
import { normalizeTaskTrace } from '../adapters/_shared/task-trace.ts';
import { sanitizeStoredContent } from './sanitize-content.ts';
import { stripImages } from '../adapters/_shared/image-content.ts';
import { CodexStorage } from './codex-store.ts';
import { MemoryScopes } from './memory-scopes.ts';
import { CloudDiagnostics } from './diagnostics.ts';
import { CreateContexts } from './create-contexts.ts';
import { filterUploadTraces } from './upload-filter.ts';
import { orderCursorTraces } from '../adapters/cursor-cli/source.ts';
import { object } from '../adapters/_shared/transcript.ts';
import { hasSkillFilter } from '../adapters/skill-filters.ts';
import { filterBindRecords, isTraceControl } from '../adapters/_shared/bind-records.ts';
import { hasIncompleteSkill } from '../adapters/_shared/skill-records.ts';
import { installedSkills } from '../adapters/installer.ts';
import type { CodexSnapshot } from '../adapters/codex-cli/types.ts';
export interface Session {
    id: string;
    title: string | null;
    titleRevision: number | null;
    agentType: string;
    nativeSessionId: string;
    cwd: string;
    taskId: string;
    objectId: string;
    currentTurnId: string | null;
    overview: string | null;
    overviewDelivered: number;
    parentNativeSessionId: string | null;
    createdAt: string;
}
export interface Binding {
    connectionId: string;
    objectId: string;
    spaceIds: string[];
    baseUrl: string;
    status: string;
}
export interface Batch {
    connectionId: string;
    id: string;
    conversationId: string | null;
    sessionId: string;
    objectId: string;
    spaceIds: string[] | null;
    messages: Message[];
    status: string;
    uploaded: boolean;
    attempts: number;
    error: string | null;
    taskId: string | null;
    processingStatus: string | null;
    createdAt: string;
}
type Row = Record<string, unknown>;
interface Project { id: string; name: string; root: string; createdAt: string }
const now = () => new Date().toISOString();
export class Store {
    db: DatabaseSync;
    codex: CodexStorage;
    memory: MemoryScopes;
    cloudDiagnostics: CloudDiagnostics;
    creation: CreateContexts;
    config?: Configuration;
    readonly home?: string;
    private lastBoundAt = 0;
    get uploadMaxBytes() { return this.config?.value.uploadMaxBytes ?? defaultUploadMaxBytes; }
    constructor(path: string, config?: Configuration, home?: string) {
        this.config = config;
        this.home = home;
        this.db = new DatabaseSync(path);
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,root TEXT NOT NULL,createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,name TEXT NOT NULL,projectId TEXT REFERENCES projects(id),objectId TEXT NOT NULL,createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bindings(objectId TEXT PRIMARY KEY,spaceId TEXT,baseUrl TEXT NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS space_domains(baseUrl TEXT NOT NULL,spaceId TEXT NOT NULL,domains TEXT NOT NULL,PRIMARY KEY(baseUrl,spaceId));
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,agentType TEXT NOT NULL,nativeSessionId TEXT NOT NULL,cwd TEXT NOT NULL,taskId TEXT REFERENCES tasks(id),objectId TEXT NOT NULL,currentTurnId TEXT,overview TEXT,parentNativeSessionId TEXT,createdAt TEXT NOT NULL,UNIQUE(agentType,nativeSessionId));
CREATE TABLE IF NOT EXISTS turns(id TEXT PRIMARY KEY,sessionId TEXT REFERENCES sessions(id),nativeKey TEXT NOT NULL,createdAt TEXT NOT NULL,UNIQUE(sessionId,nativeKey));
CREATE TABLE IF NOT EXISTS traces(id INTEGER PRIMARY KEY AUTOINCREMENT,sessionId TEXT REFERENCES sessions(id),conversationId TEXT,sourceId TEXT NOT NULL,raw TEXT NOT NULL,message TEXT NOT NULL,batchId TEXT,createdAt TEXT NOT NULL,UNIQUE(sessionId,sourceId));
CREATE INDEX IF NOT EXISTS trace_source ON traces(sourceId);
CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY,sessionId TEXT REFERENCES sessions(id),objectId TEXT NOT NULL,spaceId TEXT,messages TEXT NOT NULL,status TEXT NOT NULL,uploaded INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,error TEXT,taskId TEXT,processingStatus TEXT,createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS recalls(id TEXT PRIMARY KEY,sessionId TEXT REFERENCES sessions(id),conversationId TEXT,kind TEXT NOT NULL,query TEXT,data TEXT,content TEXT,status TEXT NOT NULL,createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS diagnostics(id INTEGER PRIMARY KEY AUTOINCREMENT,message TEXT NOT NULL,createdAt TEXT NOT NULL);`);
        if (!this.rows('PRAGMA table_info(sessions)').some(row => row.name === 'overviewDelivered'))
            this.db.exec('ALTER TABLE sessions ADD COLUMN overviewDelivered INTEGER NOT NULL DEFAULT 0');
        if (!this.rows('PRAGMA table_info(sessions)').some(row => row.name === 'title'))
            this.db.exec('ALTER TABLE sessions ADD COLUMN title TEXT');
        if (!this.rows('PRAGMA table_info(sessions)').some(row => row.name === 'titleRevision'))
            this.db.exec('ALTER TABLE sessions ADD COLUMN titleRevision INTEGER');
        sanitizeStoredContent(this.db);
        this.migrateTaskTraces(path);
        this.migrateTurnBatches(path);
        this.migrateSpaceBindings(path);
        this.memory = new MemoryScopes(this, path);
        this.codex = new CodexStorage(this, path);
        this.cloudDiagnostics = new CloudDiagnostics(this.db, path);
        this.creation = new CreateContexts(this, path);
        this.migrateConnections(path);
        if (!this.row("SELECT 1 FROM sqlite_master WHERE name='project_overviews'")) {
            if (path !== ':memory:' && this.row('SELECT 1 FROM bindings LIMIT 1')) {
                const backup = `${path}.before-project-overviews-${Date.now()}.sqlite`;
                this.db.prepare('VACUUM INTO ?').run(backup); chmodSync(backup, 0o600);
            }
            this.db.exec('CREATE TABLE project_overviews(scopeId TEXT NOT NULL,connectionId TEXT NOT NULL,spaceId TEXT NOT NULL,content TEXT,fetchedAt TEXT,PRIMARY KEY(scopeId,connectionId,spaceId))');
        } else if (this.rows('PRAGMA table_info(project_overviews)').some(column => column.name === 'data')) {
            this.migrateOverviewContent(path);
        }
        this.lastBoundAt = Date.parse(String(this.row('SELECT max(boundAt) AS boundAt FROM bindings')?.boundAt)) || 0;
    }
    private migrateOverviewContent(path: string) {
        if (path !== ':memory:' && this.row('SELECT 1 FROM project_overviews LIMIT 1')) {
            const backup = `${path}.before-overview-content-${Date.now()}.sqlite`;
            this.db.prepare('VACUUM INTO ?').run(backup);
            chmodSync(backup, 0o600);
        }
        this.db.exec('BEGIN IMMEDIATE');
        try {
            this.db.exec('ALTER TABLE project_overviews RENAME COLUMN data TO content');
            const read = this.db.prepare('SELECT content FROM project_overviews WHERE rowid=?');
            const save = this.db.prepare('UPDATE project_overviews SET content=? WHERE rowid=?');
            // Hold only row IDs in memory; a legacy response can be large.
            for (const { rowid } of this.rows('SELECT rowid FROM project_overviews WHERE content IS NOT NULL')) {
                const id = Number(rowid);
                const data = JSON.parse(String(read.get(id)!.content));
                if (!Array.isArray(data?.topic_detail_list)) throw new Error('旧项目概览缺少主题列表');
                save.run(topicContent(data.topic_detail_list), id);
            }
            this.db.exec('COMMIT');
        } catch (error) {
            this.db.exec('ROLLBACK');
            this.db.close();
            throw error;
        }
    }
    connectionId(baseUrl = this.config?.value.baseUrl ?? ''): string {
        if (this.config && this.config.value.baseUrl === baseUrl) return connectionIdentity(this.config.value);
        return JSON.stringify(['engineering', baseUrl.replace(/\/+$/, ''), '']);
    }
    matchesConnection(connectionId: string): boolean {
        return !this.config || connectionId === this.connectionId();
    }
    private migrateConnections(path: string) {
        if (this.rows('PRAGMA table_info(bindings)').some(column => column.name === 'connectionId')) return;
        if (path !== ':memory:' && (this.row('SELECT 1 FROM bindings LIMIT 1') || this.row('SELECT 1 FROM space_domains LIMIT 1'))) {
            const backup = `${path}.before-cloud-connections-${Date.now()}.sqlite`;
            this.db.prepare('VACUUM INTO ?').run(backup); chmodSync(backup, 0o600);
        }
        this.db.exec('BEGIN');
        try {
            this.db.exec("ALTER TABLE bindings ADD COLUMN connectionId TEXT NOT NULL DEFAULT ''; ALTER TABLE batches ADD COLUMN connectionId TEXT NOT NULL DEFAULT ''; CREATE TABLE space_domains_connection(baseUrl TEXT NOT NULL,connectionId TEXT NOT NULL,spaceId TEXT NOT NULL,domains TEXT NOT NULL,PRIMARY KEY(connectionId,spaceId)); CREATE TABLE create_space_boundaries_connection(scopeId TEXT NOT NULL,spaceId TEXT NOT NULL,baseUrl TEXT NOT NULL,connectionId TEXT NOT NULL,startedAfter TEXT NOT NULL,PRIMARY KEY(scopeId,spaceId,connectionId))");
            const legacy = (baseUrl: unknown) => JSON.stringify(['engineering', String(baseUrl).replace(/\/+$/, ''), '']);
            for (const row of this.rows('SELECT DISTINCT baseUrl FROM bindings')) this.db.prepare('UPDATE bindings SET connectionId=? WHERE baseUrl=?').run(legacy(row.baseUrl), String(row.baseUrl));
            for (const row of this.rows('SELECT * FROM space_domains')) this.db.prepare('INSERT INTO space_domains_connection VALUES(?,?,?,?)').run(String(row.baseUrl), legacy(row.baseUrl), String(row.spaceId), String(row.domains));
            for (const row of this.rows('SELECT * FROM create_space_boundaries')) this.db.prepare('INSERT INTO create_space_boundaries_connection VALUES(?,?,?,?,?)').run(String(row.scopeId), String(row.spaceId), String(row.baseUrl), legacy(row.baseUrl), String(row.startedAfter));
            this.db.exec("UPDATE batches SET connectionId=COALESCE((SELECT connectionId FROM bindings WHERE bindings.objectId=batches.objectId LIMIT 1),''); CREATE TRIGGER batch_connection AFTER INSERT ON batches WHEN NEW.connectionId='' BEGIN UPDATE batches SET connectionId=COALESCE((SELECT connectionId FROM bindings WHERE bindings.objectId=NEW.objectId LIMIT 1),'') WHERE id=NEW.id; END");
            this.db.exec('DROP TABLE space_domains; ALTER TABLE space_domains_connection RENAME TO space_domains; DROP TABLE create_space_boundaries; ALTER TABLE create_space_boundaries_connection RENAME TO create_space_boundaries; COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    private migrateSpaceBindings(path: string) {
        const legacyBindings = !this.rows('PRAGMA table_info(bindings)').some(column => column.name === 'spaceId' && Number(column.pk) === 2);
        const legacyBatches = this.rows('PRAGMA table_info(batches)').some(column => column.name === 'spaceId');
        if ((legacyBindings || legacyBatches) && path !== ':memory:' && (this.row('SELECT objectId FROM bindings LIMIT 1') || this.row('SELECT id FROM batches LIMIT 1'))) {
            const backup = `${path}.before-multi-space-${Date.now()}.sqlite`;
            this.db.prepare('VACUUM INTO ?').run(backup);
            chmodSync(backup, 0o600);
        }
        this.db.exec('BEGIN');
        try {
            if (legacyBindings) {
                this.db.exec(`CREATE TABLE bindings_multi(objectId TEXT NOT NULL,spaceId TEXT,baseUrl TEXT NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(objectId,spaceId));
INSERT INTO bindings_multi SELECT objectId,spaceId,baseUrl,'',status FROM bindings;
DROP TABLE bindings;
ALTER TABLE bindings_multi RENAME TO bindings;`);
            }
            if (legacyBatches) {
                this.db.exec(`ALTER TABLE batches RENAME COLUMN spaceId TO spaceIds;
UPDATE batches SET spaceIds=CASE WHEN spaceIds IS NULL THEN NULL ELSE json_array(spaceIds) END;`);
            }
            this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS bindings_empty ON bindings(objectId) WHERE spaceId IS NULL;
CREATE TABLE IF NOT EXISTS project_agents(projectId TEXT NOT NULL REFERENCES projects(id),agentType TEXT NOT NULL,PRIMARY KEY(projectId,agentType));
INSERT OR IGNORE INTO project_agents(projectId,agentType) SELECT t.projectId,s.agentType FROM sessions s JOIN tasks t ON t.id=s.taskId WHERE t.projectId IS NOT NULL;`);
            if (Number(this.row('PRAGMA user_version')?.user_version) < 3) this.db.exec('PRAGMA user_version=3');
            this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    private migrateTaskTraces(path: string) {
        if (Number(this.row('PRAGMA user_version')?.user_version) >= 1) return;
        const rows = this.rows('SELECT t.*,s.agentType,COALESCE(b.uploaded,0) AS uploaded FROM traces t JOIN sessions s ON s.id=t.sessionId LEFT JOIN batches b ON b.id=t.batchId ORDER BY t.id');
        const kept = new Map<string, { row: Row; record: TraceInput }>();
        for (const row of rows) {
            const record = normalizeTaskTrace(String(row.agentType), { sourceId: String(row.sourceId), raw: JSON.parse(String(row.raw)), message: JSON.parse(String(row.message)) });
            if (!record) continue;
            const key = JSON.stringify([row.sessionId, record.sourceId]);
            const previous = kept.get(key);
            // Never requeue a duplicate whose payload was already accepted by the cloud.
            if (!previous || (!previous.row.uploaded && row.uploaded)) kept.set(key, { row, record });
        }
        const changed = kept.size !== rows.length || [...kept.values()].some(({ row, record }) => row.sourceId !== record.sourceId || row.message !== JSON.stringify(record.message) || row.raw !== JSON.stringify(record.raw));
        if (changed && path !== ':memory:') {
            const backup = `${path}.before-task-traces-${Date.now()}.sqlite`;
            this.db.prepare('VACUUM INTO ?').run(backup);
            chmodSync(backup, 0o600);
        }
        this.db.exec('BEGIN');
        try {
            if (changed) {
                const ids = new Set([...kept.values()].map(item => item.row.id));
                for (const row of rows) if (!ids.has(row.id)) this.db.prepare('DELETE FROM traces WHERE id=?').run(Number(row.id));
                for (const { row, record } of kept.values()) this.db.prepare('UPDATE traces SET sourceId=?,raw=?,message=? WHERE id=?').run(record.sourceId, JSON.stringify(record.raw), JSON.stringify(record.message), Number(row.id));
                for (const batch of this.batches().filter(item => !item.uploaded)) {
                    const messages = this.rows('SELECT message FROM traces WHERE batchId=? ORDER BY id', batch.id).map(row => JSON.parse(String(row.message)));
                    if (messages.length) this.db.prepare('UPDATE batches SET messages=? WHERE id=?').run(JSON.stringify(messages), batch.id);
                    else this.db.prepare('DELETE FROM batches WHERE id=?').run(batch.id);
                }
            }
            this.db.exec('PRAGMA user_version=1; COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    private migrateTurnBatches(path: string) {
        if (Number(this.row('PRAGMA user_version')?.user_version) >= 2) return;
        if (path !== ':memory:' && this.row('SELECT id FROM batches LIMIT 1')) {
            const backup = `${path}.before-turn-batches-${Date.now()}.sqlite`;
            this.db.prepare('VACUUM INTO ?').run(backup);
            chmodSync(backup, 0o600);
        }
        this.db.exec('BEGIN');
        try {
            if (!this.rows('PRAGMA table_info(turns)').some(row => row.name === 'completedAt'))
                this.db.exec('ALTER TABLE turns ADD COLUMN completedAt TEXT');
            if (!this.rows('PRAGMA table_info(batches)').some(row => row.name === 'conversationId'))
                this.db.exec('ALTER TABLE batches ADD COLUMN conversationId TEXT');
            // Preserve the whole legacy turn if any fragment may already have been sent.
            const removable = this.rows(`SELECT b.id FROM batches b WHERE b.uploaded=0 AND b.attempts=0 AND b.status IN ('pending','blocked')
AND NOT EXISTS (SELECT 1 FROM traces t JOIN traces sibling ON sibling.sessionId=t.sessionId AND sibling.conversationId IS t.conversationId
JOIN batches previous ON previous.id=sibling.batchId WHERE t.batchId=b.id AND (previous.uploaded=1 OR previous.attempts>0 OR previous.status NOT IN ('pending','blocked')))`);
            for (const batch of removable) {
                this.db.prepare('UPDATE traces SET batchId=NULL WHERE batchId=?').run(String(batch.id));
                this.db.prepare('DELETE FROM batches WHERE id=?').run(String(batch.id));
            }
            this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS batches_turn ON batches(conversationId) WHERE conversationId IS NOT NULL');
            // Preserve attempted/accepted legacy payloads and never queue their turns again.
            this.db.prepare('UPDATE turns SET completedAt=? WHERE id IN (SELECT conversationId FROM traces WHERE batchId IS NOT NULL)').run(now());
            this.db.exec('PRAGMA user_version=2; COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    close() { this.db.close(); }
    rows(sql: string, ...args: (string | number | null)[]): Row[] { return this.db.prepare(sql).all(...args) as Row[]; }
    row(sql: string, ...args: (string | number | null)[]): Row | undefined { return this.db.prepare(sql).get(...args) as Row | undefined; }
    createProject(name: string, root: string) {
        if (!name.trim() || !root.trim())
            throw new Error('项目名称与目录不能为空');
        const project = { id: randomUUID(), name: name.trim(), root: resolve(root), createdAt: now() };
        this.db.prepare('INSERT INTO projects VALUES(?,?,?,?)').run(project.id, project.name, project.root, project.createdAt);
        return project;
    }
    projectForDirectory(root: string): Project | undefined {
        const cwd = resolve(root);
        return this.rows('SELECT * FROM projects ORDER BY length(root) DESC,createdAt,rowid').find(project => cwd === project.root || cwd.startsWith(String(project.root).endsWith(sep) ? String(project.root) : String(project.root) + sep)) as unknown as Project | undefined;
    }
    bindProject(name: string, root: string, spaceId: string, baseUrl: string, agentType?: string, spaceName = '', nextTurnOnly = false): Project & { scopeId: string } {
        if (!name.trim() || !isAbsolute(root) || !spaceId.trim() || !agentType?.trim())
            throw new Error('请选择 Agent，并提供项目名称、绝对目录与 Space ID');
        root = resolve(root);
        spaceId = spaceId.trim();
        this.db.exec('BEGIN');
        try {
            const project = this.row('SELECT * FROM projects WHERE root=? ORDER BY createdAt,rowid LIMIT 1', root) as unknown as Project | undefined ?? this.createProject(agentType === 'doubao-work' ? basename(root) || root : name, root);
            const scopeId = this.memory.ensure(project.id, agentType);
            if (agentType === 'doubao-work') {
                const association = this.db.prepare('UPDATE project_agents SET localName=COALESCE(localName, ?) WHERE id=? RETURNING localName').get(name.trim(), scopeId);
                project.name = String(association!.localName);
            }
            const sessions = this.rows('SELECT s.* FROM sessions s JOIN tasks t ON t.id=s.taskId WHERE s.agentType=? AND (t.projectId IS NULL OR t.projectId=?)', agentType, project.id).filter(session => this.projectForDirectory(String(session.cwd))?.id === project.id);
            this.bind(scopeId, spaceId, baseUrl, spaceName, nextTurnOnly);
            for (const session of sessions) {
                // Preserve session/turn identities, raw traces, payloads and retry counters.
                this.db.prepare('UPDATE tasks SET projectId=?,objectId=? WHERE id=?').run(project.id, scopeId, String(session.taskId));
                this.db.prepare('UPDATE sessions SET objectId=?,overview=NULL,overviewDelivered=0 WHERE id=?').run(scopeId, String(session.id));
                this.db.prepare('UPDATE batches SET objectId=? WHERE sessionId=?').run(scopeId, String(session.id));
            }
            this.db.exec('COMMIT');
            return { ...project, scopeId };
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    private associateProject(projectId: string, agentType: string) {
        this.memory.ensure(projectId, agentType);
    }
    registerSession(event: Pick<AgentEvent, 'agentType' | 'nativeSessionId' | 'cwd' | 'parentNativeSessionId' | 'title' | 'titleRevision'>): Session {
        if (!event.agentType || !event.nativeSessionId || !event.cwd)
            throw new Error('缺少可靠会话身份或工作目录');
        const known = this.row('SELECT * FROM sessions WHERE agentType=? AND nativeSessionId=?', event.agentType, event.nativeSessionId);
        if (known) {
            const task = this.row('SELECT projectId FROM tasks WHERE id=?', String(known.taskId));
            if (task?.projectId) this.associateProject(String(task.projectId), event.agentType);
            this.setSessionTitle(String(known.id), event.title, event.titleRevision);
            return this.session(String(known.id))!;
        }
        const cwd = resolve(event.cwd);
        const parent = event.parentNativeSessionId ? this.row('SELECT * FROM sessions WHERE agentType=? AND nativeSessionId=?', event.agentType, event.parentNativeSessionId) as unknown as Session | undefined : undefined;
        const scope = (parent && this.memory.forSession(parent)) || this.memory.resolve(event.agentType, cwd);
        const project = scope ? this.row('SELECT * FROM projects WHERE id=?', scope.projectId) as unknown as Project : this.projectForDirectory(cwd);
        const taskId = randomUUID(), objectId = String(scope?.id ?? project?.id ?? taskId), id = randomUUID(), createdAt = now();
        const ownTransaction = !this.db.isTransaction;
        if (ownTransaction) this.db.exec('BEGIN');
        try {
            this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?)').run(taskId, project ? String(project.name) : basename(cwd) || '独立任务', project ? String(project.id) : null, objectId, createdAt);
            this.db.prepare('INSERT INTO sessions(id,agentType,nativeSessionId,cwd,taskId,objectId,currentTurnId,overview,parentNativeSessionId,createdAt,overviewDelivered) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, event.agentType, event.nativeSessionId, cwd, taskId, objectId, null, null, event.parentNativeSessionId ?? null, createdAt, this.hostContextDelivered(event.agentType, event.nativeSessionId) ? 1 : 0);
            if (project) this.associateProject(project.id, event.agentType);
            if (ownTransaction) this.db.exec('COMMIT');
        }
        catch (error) {
            if (ownTransaction) this.db.exec('ROLLBACK');
            throw error;
        }
        this.setSessionTitle(id, event.title, event.titleRevision);
        return this.session(id)!;
    }
    setSessionTitle(id: string, title: unknown, revision?: number) {
        if (typeof title !== 'string' || !title.trim()) return;
        if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) return;
        this.db.prepare(`UPDATE sessions SET title=?,titleRevision=COALESCE(?,titleRevision)
            WHERE id=? AND (titleRevision IS NULL OR ? >= titleRevision)
            AND (title IS NOT ? OR titleRevision IS NOT COALESCE(?,titleRevision))`)
            .run(title.trim(), revision ?? null, id, revision ?? null, title.trim(), revision ?? null);
    }
    session(id: string) { return this.row('SELECT * FROM sessions WHERE id=?', id) as unknown as Session | undefined; }
    startTurn(sessionId: string, key: string, activate = true) {
        if (!key || !this.session(sessionId))
            throw new Error('需要可靠的用户轮边界');
        const existing = this.row('SELECT * FROM turns WHERE sessionId=? AND nativeKey=?', sessionId, key);
        if (existing)
            return existing as {
                id: string;
                sessionId: string;
                nativeKey: string;
                createdAt: string;
            };
        const turn = { id: randomUUID(), sessionId, nativeKey: key, createdAt: now() };
        this.db.prepare('INSERT INTO turns(id,sessionId,nativeKey,createdAt) VALUES(?,?,?,?)').run(turn.id, sessionId, key, turn.createdAt);
        if (activate)
            this.db.prepare('UPDATE sessions SET currentTurnId=? WHERE id=?').run(turn.id, sessionId);
        return turn;
    }
    validContext(sessionId: string, conversationId: string) {
        const session = this.session(sessionId);
        return !!conversationId && !!session && (session.agentType === 'codex-cli' ? this.codex.validContext(session, conversationId) : session.currentTurnId === conversationId);
    }
    applyCodexSnapshots(snapshots: CodexSnapshot[], options: { prepareUploads?: boolean; requireBinding?: boolean } = {}) { return this.codex.apply(snapshots, options); }
    prepareCodexUploads(requireBinding = false) { this.codex.prepareUploads(requireBinding); }
    reserveCodexContext(nativeSessionId: string, nativeTurnId: string, rootTurnId?: string, source?: CodexSnapshot) { return this.codex.reserveContext(nativeSessionId, nativeTurnId, rootTurnId, source); }
    contextForCodex(nativeSessionId: string, nativeTurnId?: string) { return this.codex.context(nativeSessionId, nativeTurnId); }
    spaceDomains(baseUrl: string, spaceId: string, connectionId = this.connectionId(baseUrl)): string[] | undefined {
        const row = this.row('SELECT domains FROM space_domains WHERE connectionId=? AND spaceId=?', connectionId, spaceId);
        return row ? JSON.parse(String(row.domains)) as string[] : undefined;
    }
    setSpaceDomains(baseUrl: string, spaceId: string, domains: string[], connectionId = this.connectionId(baseUrl)): void {
        this.db.prepare('INSERT INTO space_domains(baseUrl,connectionId,spaceId,domains) VALUES(?,?,?,?) ON CONFLICT(connectionId,spaceId) DO UPDATE SET domains=excluded.domains')
            .run(baseUrl, connectionId, spaceId, JSON.stringify(domains));
    }
    ensureProjectOverview(scopeId: string, spaceId: string): void {
        const binding = this.binding(scopeId);
        if (!binding?.spaceIds.includes(spaceId) || !this.matchesConnection(binding.connectionId)) return;
        this.db.prepare('INSERT OR IGNORE INTO project_overviews(scopeId,connectionId,spaceId) VALUES(?,?,?)')
            .run(scopeId, binding.connectionId, spaceId);
    }
    projectOverview(scopeId: string, spaceId: string): { content: string | null; fetchedAt: string | null } | undefined {
        const binding = this.binding(scopeId);
        if (!binding?.spaceIds.includes(spaceId) || !this.matchesConnection(binding.connectionId)) return undefined;
        const row = this.row('SELECT content,fetchedAt FROM project_overviews WHERE scopeId=? AND connectionId=? AND spaceId=?', scopeId, binding.connectionId, spaceId);
        return row ? { content: row.content === null ? null : String(row.content), fetchedAt: row.fetchedAt === null ? null : String(row.fetchedAt) } : undefined;
    }
    saveProjectOverview(scopeId: string, connectionId: string, spaceId: string, boundAt: string, content: string): boolean {
        if (!this.matchesConnection(connectionId)) return false;
        const result = this.db.prepare(`UPDATE project_overviews SET content=?,fetchedAt=? WHERE scopeId=? AND connectionId=? AND spaceId=?
AND EXISTS(SELECT 1 FROM bindings WHERE objectId=? AND connectionId=? AND spaceId=? AND boundAt=?)`)
            .run(content, now(), scopeId, connectionId, spaceId, scopeId, connectionId, spaceId, boundAt);
        return !!result.changes;
    }
    projectOverviewContent(scopeId: string): string | null {
        const binding = this.binding(scopeId);
        if (!binding || !this.matchesConnection(binding.connectionId)) return null;
        const rows = this.rows(`SELECT o.content FROM bindings b JOIN project_overviews o
            ON o.scopeId=b.objectId AND o.connectionId=b.connectionId AND o.spaceId=b.spaceId
            WHERE b.objectId=? AND b.connectionId=? AND o.content IS NOT NULL ORDER BY b.rowid`, scopeId, binding.connectionId);
        return rows.length ? rows.map(row => String(row.content)).filter(Boolean).join('\n\n') : null;
    }
    binding(objectId: string): Binding | undefined {
        const rows = this.rows('SELECT * FROM bindings WHERE objectId=? ORDER BY rowid', objectId);
        if (!rows.length) return undefined;
        const spaceIds = rows.filter(row => row.spaceId !== null).map(row => String(row.spaceId));
        return { objectId, spaceIds, connectionId: String(rows[0]!.connectionId), baseUrl: String(rows[0]!.baseUrl), status: spaceIds.length ? 'bound' : String(rows[0]!.status) };
    }
    spaces(objectId: string): { spaceId: string; name: string }[] {
        return this.rows('SELECT spaceId,name FROM bindings WHERE objectId=? AND spaceId IS NOT NULL ORDER BY rowid', objectId).map(row => ({ spaceId: String(row.spaceId), name: String(row.name) }));
    }
    setSpaceName(objectId: string, spaceId: string, name: string) {
        this.db.prepare('UPDATE bindings SET name=? WHERE objectId=? AND spaceId=?').run(name, objectId, spaceId);
    }
    objectName(objectId: string) { return this.memory.get(objectId)?.name ?? String(this.row('SELECT name FROM projects WHERE id=? UNION ALL SELECT name FROM tasks WHERE id=?', objectId, objectId)?.name ?? '项目记忆'); }
    bind(objectId: string, spaceId: string, baseUrl: string, name = '', nextTurnOnly = false) {
        if (!spaceId.trim())
            throw new Error('Space ID不能为空');
        if (!this.memory.get(objectId) && !this.row('SELECT id FROM projects WHERE id=? UNION ALL SELECT id FROM tasks WHERE id=?', objectId, objectId))
            throw new Error('绑定对象不存在');
        spaceId = spaceId.trim();
        const old = this.binding(objectId);
        if (old && (old.spaceIds.length || old.status !== 'unbound') && old.connectionId !== this.connectionId(baseUrl))
            throw new Error('绑定所属云连接不可更改');
        if (old?.status === 'uncertain') throw new Error('空间创建结果尚待确认');
        if (old?.spaceIds.includes(spaceId)) {
            if (name) this.setSpaceName(objectId, spaceId, name);
            this.ensureProjectOverview(objectId, spaceId);
            return old;
        }
        const own = !this.db.isTransaction;
        if (own) this.db.exec('BEGIN');
        try {
            if ((this.binding(objectId)?.spaceIds.length ?? 0) >= 20)
                throw new Error('单个项目绑定空间不能超过20个');
            // A same-millisecond rebind must invalidate responses for the old binding.
            this.lastBoundAt = Math.max(Date.now(), this.lastBoundAt + 1);
            const boundAt = new Date(this.lastBoundAt).toISOString();
            this.db.prepare('DELETE FROM bindings WHERE objectId=? AND spaceId IS NULL').run(objectId);
            this.db.prepare('INSERT INTO bindings(objectId,spaceId,baseUrl,name,status,boundAt,connectionId) VALUES(?,?,?,?,?,?,?)').run(objectId, spaceId, baseUrl, name, 'bound', boundAt, this.connectionId(baseUrl));
            this.memory.activate(objectId, boundAt);
            this.ensureProjectOverview(objectId, spaceId);
            if (nextTurnOnly) this.creation.markBinding(objectId, spaceId, baseUrl);
            this.db.prepare('UPDATE sessions SET overview=NULL,overviewDelivered=0 WHERE objectId=?').run(objectId);
            if (own) this.db.exec('COMMIT');
            return this.binding(objectId)!;
        } catch (error) { if (own) this.db.exec('ROLLBACK'); throw error; }
    }
    unbind(objectId: string, spaceId: string): Binding {
        const binding = this.binding(objectId);
        if (!binding) throw new Error('空间关联不存在');
        if (binding.status === 'creating' || binding.status === 'uncertain') throw new Error('空间创建结果尚待确认');
        this.db.exec('BEGIN');
        try {
            const removed = this.db.prepare('DELETE FROM bindings WHERE objectId=? AND spaceId=?').run(objectId, spaceId.trim());
            if (removed.changes) this.db.prepare('DELETE FROM project_overviews WHERE scopeId=? AND connectionId=? AND spaceId=?').run(objectId, binding.connectionId, spaceId.trim());
            if (removed.changes && this.row("SELECT name FROM sqlite_master WHERE type='table' AND name='batch_deliveries'"))
                this.db.prepare("UPDATE batch_deliveries SET status='cancelled' WHERE spaceId=? AND baseUrl=? AND connectionId=? AND status IN ('pending','sending','blocked') AND batchId IN(SELECT id FROM batches WHERE objectId=?)")
                    .run(spaceId.trim(), binding.baseUrl, binding.connectionId, objectId);
            if (!this.binding(objectId)) {
                this.db.prepare('INSERT INTO bindings(objectId,spaceId,baseUrl,name,status,connectionId) VALUES(?,NULL,?,?,?,?)').run(objectId, binding.baseUrl, '', 'unbound', binding.connectionId);
                this.memory.deactivate(objectId, now());
            }
            if (removed.changes) this.db.prepare('UPDATE sessions SET overview=NULL WHERE objectId=?').run(objectId);
            this.db.exec('COMMIT');
            return this.binding(objectId)!;
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    setCreating(objectId: string, baseUrl: string, status = 'creating') {
        const binding = this.binding(objectId);
        if (binding?.spaceIds.length) throw new Error('已有空间关联');
        if (binding && binding.status !== 'unbound' && binding.connectionId !== this.connectionId(baseUrl)) throw new Error('绑定所属云连接不可更改');
        if (binding) this.db.prepare('UPDATE bindings SET status=?,baseUrl=?,connectionId=? WHERE objectId=? AND spaceId IS NULL').run(status, baseUrl, this.connectionId(baseUrl), objectId);
        else this.db.prepare('INSERT INTO bindings(objectId,spaceId,baseUrl,name,status,connectionId) VALUES(?,NULL,?,?,?,?)').run(objectId, baseUrl, '', status, this.connectionId(baseUrl));
    }
    hostContextDelivered(agentType: string, nativeSessionId: string): boolean {
        return this.row('SELECT * FROM create_hosts WHERE agentType=? AND nativeSessionId=?', agentType, nativeSessionId)?.overviewDelivered === 1;
    }
    markHostContextDelivered(agentType: string, nativeSessionId: string): void {
        if (!this.row('SELECT 1 FROM create_hosts WHERE agentType=? AND nativeSessionId=?', agentType, nativeSessionId)) return;
        this.db.prepare('UPDATE create_hosts SET overviewDelivered=1 WHERE agentType=? AND nativeSessionId=?').run(agentType, nativeSessionId);
        const session = this.row('SELECT id FROM sessions WHERE agentType=? AND nativeSessionId=?', agentType, nativeSessionId);
        if (session) this.markContextDelivered(String(session.id));
    }
    markContextDelivered(sessionId: string) {
        const session = this.session(sessionId);
        if (!session)
            throw new Error('会话不存在');
        this.db.prepare('UPDATE sessions SET overviewDelivered=1 WHERE id=?').run(sessionId);
        this.db.prepare('UPDATE create_hosts SET overviewDelivered=1 WHERE agentType=? AND nativeSessionId=?').run(session.agentType, session.nativeSessionId);
        this.db.prepare("UPDATE recalls SET status='delivered-to-host' WHERE sessionId=? AND kind='initial' AND status='prepared'").run(sessionId);
    }
    capture(sessionId: string, records: TraceInput[], replaceCursorHooks?: ReadonlySet<string>) {
        const session = this.session(sessionId);
        if (!session)
            throw new Error('会话不存在');
        const scope = this.memory.get(session.objectId);
        if (scope && !scope.spaceIds.length) return 0;
        let added = 0;
        const own = !this.db.isTransaction;
        if (own) this.db.exec('BEGIN');
        try {
            records = this.filterBindings(sessionId, scope ? records.filter(record => this.memory.allows(scope.id, this.memory.recordTime(record.raw))) : records);
            for (const input of records) {
                if (this.creation.recordExcluded(sessionId, input.nativeTurnId, this.memory.recordTime(input.raw))) continue;
                if (scope) {
                    // A replay-created turn is not evidence that its source records are new.
                    if (!this.memory.allows(scope.id, this.memory.recordTime(input.raw))) continue;
                }
                const record = isTraceControl(input) ? input : stripImages(normalizeTaskTrace(session.agentType, input));
                if (!record?.message || !isTraceControl(record) && !hasTaskContent(record.message)) continue;
                if (!record.sourceId)
                    throw new Error('原始记录缺少稳定来源标识');
                if (session.agentType === 'workbuddy' && this.mergeWorkBuddyTrace(session, record)) continue;
                if (Array.isArray(object(input.raw).bindCallIds)) record.raw = { ...object(record.raw), bindCallIds: object(input.raw).bindCallIds };
                const message = record.message;
                const existing = this.row('SELECT id FROM traces WHERE sessionId=? AND sourceId=?', sessionId, record.sourceId);
                if (existing) {
                    if (this.restoreSkillTrace(Number(existing.id), record)) continue;
                    if (session.agentType === 'cursor-cli' && replaceCursorHooks?.has(record.sourceId)) {
                        const changed = this.db.prepare(`UPDATE traces SET message=?,raw=? WHERE sessionId=? AND sourceId=? AND batchId IS NULL
                            AND conversationId=(SELECT id FROM turns WHERE sessionId=? AND nativeKey=? AND completedAt IS NULL)
                            AND NOT EXISTS(SELECT 1 FROM batch_traces WHERE traceId=traces.id)`)
                            .run(JSON.stringify(message), JSON.stringify(record.raw), sessionId, record.sourceId, sessionId, record.nativeTurnId!);
                        if (!changed.changes) throw new Error('Cursor 工具调用已关联投递，无法修改冻结记录');
                    }
                    continue;
                }
                const turn = record.nativeTurnId ? this.startTurn(sessionId, record.nativeTurnId, false).id : session.currentTurnId;
                const result = this.db.prepare('INSERT OR IGNORE INTO traces(sessionId,conversationId,sourceId,raw,message,createdAt) VALUES(?,?,?,?,?,?)').run(sessionId, turn ? String(turn) : null, record.sourceId, JSON.stringify(record.raw), JSON.stringify(message), now());
                added += Number(result.changes);
            }
            if (hasSkillFilter(session.agentType) || records.some(record => isTraceControl(record) || Array.isArray(object(record.raw).bindCallIds))) this.refreshUnsentBatches(session.id);
            if (own) this.db.exec('COMMIT');
        }
        catch (error) {
            if (own) this.db.exec('ROLLBACK');
            throw error;
        }
        return added;
    }
    /** Rehydrate only this session's matching turns, so a later result or restart
     * can use already-redacted call identities without a process-global cache. */
    private filterBindings(sessionId: string, records: TraceInput[]): TraceInput[] {
        const session = this.session(sessionId);
        if (!session) return records;
        const current = session.currentTurnId ? this.row('SELECT nativeKey FROM turns WHERE id=?', session.currentTurnId)?.nativeKey : undefined;
        const incoming = records.map(record => ({ ...(normalizeTaskTrace(session.agentType, record) ?? record), nativeTurnId: record.nativeTurnId ?? (typeof current === 'string' ? current : undefined) }));
        const prior: TraceInput[] = [];
        const stored: Row[] = [];
        for (const key of new Set(incoming.map(record => record.nativeTurnId))) {
            if (!key) continue;
            for (const row of this.rows('SELECT t.id,t.sourceId,t.raw,t.message,COALESCE(b.attempts,0) AS attempts,COALESCE(b.uploaded,0) AS uploaded FROM traces t JOIN turns u ON u.id=t.conversationId LEFT JOIN batches b ON b.id=t.batchId WHERE t.sessionId=? AND u.nativeKey=? ORDER BY t.id', sessionId, key)) {
                prior.push({ sourceId: String(row.sourceId), nativeTurnId: key, raw: JSON.parse(String(row.raw)), message: JSON.parse(String(row.message)) });
                stored.push(row);
            }
        }
        const filtered = filterBindRecords([...prior, ...incoming]);
        const indexedDeliveries = !!this.row("SELECT 1 FROM sqlite_master WHERE type='table' AND name='batch_traces'");
        // A delayed call can identify a formerly unknown result. Repair only
        // unsent rows in this active capture; never rewrite an accepted audit.
        for (let index = 0; index < prior.length; index++) {
            const row = stored[index]!, clean = isTraceControl(filtered[index]!) ? filtered[index]! : stripImages(normalizeTaskTrace(session.agentType, filtered[index]!));
            if (clean && Array.isArray(object(filtered[index]!.raw).bindCallIds)) clean.raw = { ...object(clean.raw), bindCallIds: object(filtered[index]!.raw).bindCallIds };
            // Keep old partial-exclusion evidence until native replay restores the body.
            if (clean && Array.isArray(object(filtered[index]!.raw).skillCallIds)) clean.raw = { ...object(clean.raw), skillCallIds: object(filtered[index]!.raw).skillCallIds };
            if (row.attempts || row.uploaded || !clean?.message || JSON.stringify(clean.message) === row.message && JSON.stringify(clean.raw) === row.raw) continue;
            if (indexedDeliveries && this.row('SELECT 1 FROM batch_traces bt JOIN batches b ON b.id=bt.batchId WHERE bt.traceId=? AND (b.attempts>0 OR b.uploaded=1) LIMIT 1', Number(row.id))) continue;
            this.db.prepare('UPDATE traces SET raw=?,message=? WHERE id=?').run(JSON.stringify(clean.raw), JSON.stringify(clean.message), Number(row.id));
        }
        return filtered.slice(prior.length);
    }
    /** Project a copy for upload; captured messages and Viewer details stay complete. */
    uploadTraces<T extends { message?: unknown }>(sessionId: string, records: T[]): T[] {
        const agent = this.session(sessionId)?.agentType ?? '';
        return filterUploadTraces(records, agent, installedSkills(agent, this.home));
    }
    /** Recover only legacy Skill projections from a verified native source.
     * Frozen upload requests and receipts remain separate and unchanged. */
    restoreSkillTrace(traceId: number, record: TraceInput): boolean {
        const stored = this.row('SELECT raw,message FROM traces WHERE id=?', traceId);
        if (!stored || !record.message) return false;
        const raw = object(JSON.parse(String(stored.raw))), message = object(JSON.parse(String(stored.message)));
        const projectedCall = (value: unknown) => {
            const call = object(value), fn = object(call.function);
            return (fn.name ?? call.name) === 'skill' && ['started', 'incomplete'].includes(String(call.status));
        };
        const projectedResult = (value: unknown) => {
            const result = object(value);
            if (result.name !== 'skill') return false;
            try {
                const summary = object(JSON.parse(String(result.content)));
                return typeof summary.skill_name === 'string' && 'call_id' in summary && 'status' in summary;
            } catch { return false; }
        };
        const legacy = raw.type === 'memos-skill-read' || Array.isArray(raw.skillCallIds) && raw.skillCallIds.length > 0
            || Array.isArray(message.tool_calls) && message.tool_calls.some(projectedCall)
            || Array.isArray(message.content) && message.content.some(value => projectedCall(value) || projectedResult(value))
            || projectedResult(message);
        if (!legacy || JSON.stringify(record.message) === stored.message && JSON.stringify(record.raw) === stored.raw) return false;
        this.db.prepare('UPDATE traces SET raw=?,message=? WHERE id=?').run(JSON.stringify(record.raw), JSON.stringify(record.message), traceId);
        return true;
    }
    /** Native WorkBuddy evidence may replace an unsent Hook fallback, never a sent body. */
    mergeWorkBuddyTrace(session: Session, record: TraceInput): boolean {
        const raw = object(record.raw), message = record.message!;
        const projected = JSON.stringify(compactUploadMessage(message));
        let existing = this.row('SELECT * FROM traces WHERE sessionId=? AND sourceId=?', session.id, record.sourceId);
        if (!existing && record.nativeTurnId && message.role === 'assistant') {
            if (raw.type === 'message' && raw.status === 'completed' && typeof raw.id === 'string') {
                existing = this.row('SELECT * FROM traces WHERE sessionId=? AND sourceId=?', session.id, `workbuddy:${session.nativeSessionId}:${record.nativeTurnId}:answer`);
            } else if (['stop', 'sessionend'].includes(String(raw.hook_event_name).toLowerCase())) {
                const native = this.rows(`SELECT t.message FROM traces t JOIN turns u ON u.id=t.conversationId WHERE t.sessionId=? AND u.nativeKey=?
AND json_extract(t.raw,'$.status')='completed' AND json_extract(t.message,'$.role')='assistant'`, session.id, record.nativeTurnId);
                if (native.some(row => JSON.stringify(compactUploadMessage(JSON.parse(String(row.message)))) === projected)) return true;
            }
        }
        if (!existing) return false;
        const oldRaw = object(JSON.parse(String(existing.raw)));
        if (raw.hook_event_name) return true;
        if (!oldRaw.hook_event_name && message.role === 'user' && raw.id !== oldRaw.id) {
            record.sourceId += `:message:${String(raw.id)}`;
            return false;
        }
        const same = JSON.stringify(compactUploadMessage(JSON.parse(String(existing.message)))) === projected;
        if (!oldRaw.hook_event_name && same) return true;
        const linked = !!this.row("SELECT 1 FROM sqlite_master WHERE type='table' AND name='batch_traces'");
        const batches = this.rows(`SELECT * FROM batches WHERE sessionId=? AND (id=? OR conversationId=?)`, session.id, existing.batchId as string ?? null, existing.conversationId as string ?? null);
        if (linked) for (const batch of this.rows('SELECT b.* FROM batches b JOIN batch_traces bt ON bt.batchId=b.id WHERE bt.traceId=?', Number(existing.id))) {
            if (!batches.some(row => row.id === batch.id)) batches.push(batch);
        }
        if (batches.some(batch => Number(batch.attempts) > 0 || batch.uploaded) || !oldRaw.hook_event_name) {
            if (same) return true;
            record.sourceId += ':revision:' + createHash('sha256').update(projected).digest('hex');
            if (!this.row('SELECT id FROM traces WHERE sessionId=? AND sourceId=?', session.id, record.sourceId))
                this.diagnostic(`WorkBuddy 同一来源出现不同正文，保留新增轨迹且不改写已有快照：${session.id} / ${record.sourceId}`);
            return false;
        }
        this.db.prepare('UPDATE traces SET sourceId=?,raw=?,message=? WHERE id=?').run(record.sourceId, JSON.stringify(record.raw), JSON.stringify(message), Number(existing.id));
        for (const batch of batches) if (['pending', 'blocked'].includes(String(batch.status))) this.refreshWorkBuddyBatch(batch);
        return true;
    }
    /** Late native records can complete a frozen-but-never-sent whole-turn snapshot. */
    refreshUnsentBatches(sessionId: string) {
        for (const batch of this.rows("SELECT id,sessionId,conversationId FROM batches WHERE sessionId=? AND conversationId IS NOT NULL AND attempts=0 AND uploaded=0 AND status IN ('pending','blocked')", sessionId)) this.refreshWorkBuddyBatch(batch);
    }
    private refreshWorkBuddyBatch(batch: Row) {
        const traces = batch.conversationId ? this.turnTraces(String(batch.sessionId), String(batch.conversationId))
            : this.rows('SELECT t.* FROM traces t JOIN batch_traces bt ON bt.traceId=t.id WHERE bt.batchId=? ORDER BY t.id', String(batch.id)).map(row => ({ ...row, message: JSON.parse(String(row.message)) }));
        const messages = this.uploadTraces(String(batch.sessionId), traces).map(row => row.message);
        const payload = JSON.stringify(messages);
        const oversized = Buffer.byteLength(payload, 'utf8') > this.uploadMaxBytes;
        const error = uploadValidationError(messages) ?? (hasSkillFilter(this.session(String(batch.sessionId))?.agentType ?? '') && messages.some(hasIncompleteSkill) ? 'Skill 调用身份或输出边界不完整；正文未采集' : oversized ? '整轮轨迹超出保守上传容量；完整内容已保留' : null);
        this.db.prepare('UPDATE batches SET messages=?,status=?,error=? WHERE id=? AND attempts=0 AND uploaded=0').run(payload, error ? 'blocked' : 'pending', error, String(batch.id));
        if (this.row("SELECT 1 FROM sqlite_master WHERE type='table' AND name='batch_deliveries'"))
            this.db.prepare("UPDATE batch_deliveries SET status=?,error=? WHERE batchId=? AND attempts=0 AND status IN ('pending','blocked')").run(error ? 'blocked' : 'pending', error, String(batch.id));
    }
    finalizeTurn(sessionId: string, nativeKey?: string, completedAt?: string) {
        const session = this.session(sessionId);
        if (!session) throw new Error('会话不存在');
        let turn = nativeKey
            ? this.row('SELECT * FROM turns WHERE sessionId=? AND nativeKey=?', sessionId, nativeKey)
            : session.currentTurnId ? this.row('SELECT * FROM turns WHERE id=?', session.currentTurnId) : undefined;
        // Completed child transcripts can arrive without a prompt hook or native turn ID.
        if (!turn) {
            const first = this.row('SELECT id FROM traces WHERE sessionId=? AND conversationId IS NULL ORDER BY id LIMIT 1', sessionId);
            if (!first) return;
            turn = this.startTurn(sessionId, nativeKey ?? `completed-transcript:${first.id}`, false);
            this.db.prepare('UPDATE traces SET conversationId=? WHERE sessionId=? AND conversationId IS NULL').run(String(turn.id), sessionId);
        }
        if (turn.completedAt) return;
        const own = !this.db.isTransaction;
        if (own) this.db.exec('BEGIN');
        try {
            const traces = this.uploadTraces(sessionId, this.turnTraces(sessionId, String(turn.id)));
            if (traces.length && !this.creation.turnExcluded(sessionId, String(turn.id))) {
                // Assemble once at completion; the upload worker reuses this exact snapshot.
                const messages = traces.map(trace => trace.message);
                const payload = JSON.stringify(messages), oversized = Buffer.byteLength(payload, 'utf8') > this.uploadMaxBytes;
                const error = uploadValidationError(messages) ?? (hasSkillFilter(session.agentType) && messages.some(hasIncompleteSkill) ? 'Skill 调用身份或输出边界不完整；正文未采集' : oversized ? '整轮轨迹超出保守上传容量；完整内容已保留' : null);
                const id = randomUUID();
                this.db.prepare('INSERT INTO batches(id,sessionId,objectId,conversationId,messages,status,error,createdAt) VALUES(?,?,?,?,?,?,?,?)').run(id, sessionId, session.objectId, String(turn.id), payload, error ? 'blocked' : 'pending', error, now());
                this.db.prepare('UPDATE traces SET batchId=? WHERE sessionId=? AND conversationId=?').run(id, sessionId, String(turn.id));
            }
            this.db.prepare('UPDATE turns SET completedAt=? WHERE id=?').run(completedAt ?? now(), String(turn.id));
            if (own) this.db.exec('COMMIT');
        } catch (error) { if (own) this.db.exec('ROLLBACK'); throw error; }
    }
    private turnTraces(sessionId: string, conversationId: string) {
        return orderCursorTraces(this.rows('SELECT * FROM traces WHERE sessionId=? AND conversationId=? ORDER BY id', sessionId, conversationId).map(row => ({ ...row, message: JSON.parse(String(row.message)) })));
    }
    batches(status?: string): Batch[] {
        // Legacy migrations run before the Codex schema is initialized.
        const order = this.codex ? "COALESCE((SELECT r.startedAt FROM codex_rounds r WHERE r.conversationId=batches.conversationId),createdAt),(SELECT MIN(m.sourceOrdinal) FROM traces t JOIN codex_event_meta m ON m.traceId=t.id JOIN sessions s ON s.id=batches.sessionId WHERE t.conversationId=batches.conversationId AND m.originSessionId=s.nativeSessionId AND json_extract(t.message,'$.role')='user'),rowid" : 'createdAt,rowid';
        return this.rows('SELECT * FROM batches' + (status ? ' WHERE status=?' : '') + ` ORDER BY ${order}`, ...(status ? [status] : [])).map(row => ({ ...row, spaceIds: 'spaceIds' in row ? row.spaceIds === null ? null : JSON.parse(String(row.spaceIds)) : row.spaceId ? [String(row.spaceId)] : null, messages: JSON.parse(String(row.messages)), uploaded: !!row.uploaded })) as unknown as Batch[];
    }
    updateBatch(id: string, values: Partial<Pick<Batch, 'status' | 'uploaded' | 'attempts' | 'error' | 'taskId' | 'processingStatus' | 'spaceIds'>>) {
        const entries = Object.entries(values);
        if (!entries.length)
            return;
        const allowed = ['status', 'uploaded', 'attempts', 'error', 'taskId', 'processingStatus', 'spaceIds'];
        if (entries.some(([key]) => !allowed.includes(key)))
            throw new Error('非法批次字段');
        this.db.prepare(`UPDATE batches SET ${entries.map(([key]) => `${key}=?`).join(',')} WHERE id=?`).run(...entries.map(([, value]) => Array.isArray(value) ? JSON.stringify(value) : typeof value === 'boolean' ? Number(value) : value ?? null), id);
    }
    recall(sessionId: string, conversationId: string | null, kind: string, query: string | null, content: string, status: string) {
        this.db.prepare('INSERT INTO recalls(id,sessionId,conversationId,kind,query,content,status,createdAt) VALUES(?,?,?,?,?,?,?,?)')
            .run(randomUUID(), sessionId, conversationId, kind, query, content, status, now());
    }
    diagnostic(message: string) { this.db.prepare('INSERT INTO diagnostics(message,createdAt) VALUES(?,?)').run(message, now()); }
    orderedSessions() {
        return this.codex.decorateSessions(this.rows(`SELECT s.*,
            max(s.createdAt,COALESCE((SELECT max(t.createdAt) FROM traces t WHERE t.sessionId=s.id),s.createdAt)) AS updatedAt
            FROM sessions s`)).sort((left, right) => String(left.sourceStartedAt ?? left.createdAt).localeCompare(String(right.sourceStartedAt ?? right.createdAt)) || String(left.id).localeCompare(String(right.id)));
    }
    state() {
        const scope = (objectId: string) => {
            const binding = this.binding(objectId);
            return { spaceIds: binding?.spaceIds ?? [], bindingStatus: binding?.status ?? null };
        };
        const sessions = this.orderedSessions();
        const projects = this.rows('SELECT * FROM projects').map((project): Row => {
            const members = sessions.filter(session => session.projectId === project.id);
            const times = members.map(session => String(session.sourceStartedAt ?? session.createdAt)).sort();
            const recent = members.map(session => String(session.lastOccurredAt ?? session.sourceStartedAt ?? session.createdAt)).sort();
            return { ...project, ...scope(String(project.id)), agentTypes: this.rows('SELECT agentType FROM project_agents WHERE projectId=? ORDER BY agentType', String(project.id)).map(row => String(row.agentType)), sessionCount: members.length, turnCount: members.reduce((total, session) => total + Number(session.turnCount ?? this.row('SELECT count(*) AS n FROM turns WHERE sessionId=?', String(session.id))?.n ?? 0), 0), earliestOccurredAt: times[0] ?? null, lastOccurredAt: recent.at(-1) ?? null };
        });
        const quarantinedSessions = this.rows("SELECT s.id,s.nativeSessionId,s.createdAt FROM sessions s WHERE s.agentType='codex-cli' AND NOT EXISTS(SELECT 1 FROM codex_source_meta m WHERE m.nativeSessionId=s.nativeSessionId AND m.sourceKind IN ('user','subagent'))");
        const batches = this.rows('SELECT id,conversationId,sessionId,objectId,spaceIds,status,uploaded,attempts,error,taskId,processingStatus,createdAt FROM batches ORDER BY createdAt,rowid')
            .map(row => ({ ...row, spaceIds: row.spaceIds === null ? null : JSON.parse(String(row.spaceIds)), uploaded: !!row.uploaded })) as unknown as Omit<Batch, 'messages'>[];
        return { projects, bindings: this.memory.all(), quarantinedSessions, tasks: this.rows('SELECT * FROM tasks').map((task): Row => ({ ...task, ...scope(String(task.objectId)) })), sessions, batches, recalls: this.rows('SELECT * FROM recalls ORDER BY createdAt DESC').map((r): Row => ({ ...r, data: JSON.parse(String(r.data)) })), cloudDiagnosticCount: Number(this.row('SELECT count(*) n FROM cloud_diagnostics')!.n), diagnostics: this.rows('SELECT * FROM diagnostics ORDER BY id DESC LIMIT 100') };
    }
    sessionDetail(id: string, page = 1, size = 50, unit: 'trace' | 'turn' = 'trace') {
        if (this.codex.hasSession(id)) return this.codex.detail(id, page, size, unit);
        // Missing turn IDs stay separate rather than merging unrelated tasks.
        const groupKey = "COALESCE(conversationId, 'trace:' || id)";
        const task = "COALESCE(json_extract(raw,'$.type'),'') NOT IN ('memos-bind-operation','memos-skill-read')";
        const byTurn = unit === 'turn';
        const selected = byTurn
            ? this.rows(`SELECT * FROM traces WHERE sessionId=? AND ${task} AND ${groupKey} IN (SELECT ${groupKey} FROM traces WHERE sessionId=? AND ${task} GROUP BY ${groupKey} ORDER BY MIN(id) LIMIT ? OFFSET ?) ORDER BY id`, id, id, size, (page - 1) * size)
            : this.rows(`SELECT * FROM traces WHERE sessionId=? AND ${task} ORDER BY id LIMIT ? OFFSET ?`, id, size, (page - 1) * size);
        const traces = orderCursorTraces(selected.map((r): Row => ({ ...r, raw: JSON.parse(String(r.raw)), message: JSON.parse(String(r.message)) })));
        const grouped = new Map<string, { id: string; traces: Row[]; captureStatus?: string; uploadOutOfDate?: boolean }>();
        if (byTurn) for (const trace of traces) {
            const key = String(trace.conversationId ?? `trace:${trace.id}`);
            if (!grouped.has(key)) grouped.set(key, { id: key, traces: [] });
            grouped.get(key)!.traces.push(trace);
        }
        const total = Number(this.row(`SELECT count(${byTurn ? `DISTINCT ${groupKey}` : '*'}) AS total FROM traces WHERE sessionId=? AND ${task}`, id)?.total ?? 0);
        return { session: this.session(id), turns: this.rows('SELECT * FROM turns WHERE sessionId=? ORDER BY createdAt', id), traces, groups: byTurn ? [...grouped.values()] : undefined, recalls: this.state().recalls.filter(r => r.sessionId === id), batches: this.batches().filter(r => r.sessionId === id), total, page, size };
    }
}
