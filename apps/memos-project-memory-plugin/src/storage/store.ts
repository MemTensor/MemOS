import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { basename, isAbsolute, resolve, sep } from 'node:path';
import { chmodSync } from 'node:fs';
import type { AgentEvent, TraceInput, Message } from '../adapters/types.ts';
import { normalizeTaskTrace } from '../adapters/_shared/task-trace.ts';
import { sanitizeStoredContent } from './sanitize-content.ts';
import { stripImages } from '../adapters/_shared/image-content.ts';
import { CodexStorage } from './codex-store.ts';
import { MemoryScopes } from './memory-scopes.ts';
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
    objectId: string;
    spaceIds: string[];
    baseUrl: string;
    status: string;
}
export interface Batch {
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
    constructor(path: string) {
        this.db = new DatabaseSync(path);
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,root TEXT NOT NULL,createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,name TEXT NOT NULL,projectId TEXT REFERENCES projects(id),objectId TEXT NOT NULL,createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bindings(objectId TEXT PRIMARY KEY,spaceId TEXT,baseUrl TEXT NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,agentType TEXT NOT NULL,nativeSessionId TEXT NOT NULL,cwd TEXT NOT NULL,taskId TEXT REFERENCES tasks(id),objectId TEXT NOT NULL,currentTurnId TEXT,overview TEXT,parentNativeSessionId TEXT,createdAt TEXT NOT NULL,UNIQUE(agentType,nativeSessionId));
CREATE TABLE IF NOT EXISTS turns(id TEXT PRIMARY KEY,sessionId TEXT REFERENCES sessions(id),nativeKey TEXT NOT NULL,createdAt TEXT NOT NULL,UNIQUE(sessionId,nativeKey));
CREATE TABLE IF NOT EXISTS traces(id INTEGER PRIMARY KEY AUTOINCREMENT,sessionId TEXT REFERENCES sessions(id),conversationId TEXT,sourceId TEXT NOT NULL,raw TEXT NOT NULL,message TEXT NOT NULL,batchId TEXT,createdAt TEXT NOT NULL,UNIQUE(sessionId,sourceId));
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
    bindProject(name: string, root: string, spaceId: string, baseUrl: string, agentType?: string, spaceName = ''): Project & { scopeId: string } {
        if (!name.trim() || !isAbsolute(root) || !spaceId.trim() || !agentType?.trim())
            throw new Error('请选择 Agent，并提供项目名称、绝对目录与 Space ID');
        root = resolve(root);
        spaceId = spaceId.trim();
        this.db.exec('BEGIN');
        try {
            const project = this.row('SELECT * FROM projects WHERE root=? ORDER BY createdAt,rowid LIMIT 1', root) as unknown as Project | undefined ?? this.createProject(name, root);
            const scopeId = this.memory.ensure(project.id, agentType);
            const sessions = this.rows('SELECT s.* FROM sessions s JOIN tasks t ON t.id=s.taskId WHERE s.agentType=? AND (t.projectId IS NULL OR t.projectId=?)', agentType, project.id).filter(session => this.projectForDirectory(String(session.cwd))?.id === project.id);
            this.bind(scopeId, spaceId, baseUrl, spaceName);
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
            this.db.prepare('INSERT INTO sessions(id,agentType,nativeSessionId,cwd,taskId,objectId,currentTurnId,overview,parentNativeSessionId,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, event.agentType, event.nativeSessionId, cwd, taskId, objectId, null, null, event.parentNativeSessionId ?? null, createdAt);
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
    binding(objectId: string): Binding | undefined {
        const rows = this.rows('SELECT * FROM bindings WHERE objectId=? ORDER BY rowid', objectId);
        if (!rows.length) return undefined;
        const spaceIds = rows.filter(row => row.spaceId !== null).map(row => String(row.spaceId));
        return { objectId, spaceIds, baseUrl: String(rows[0]!.baseUrl), status: spaceIds.length ? 'bound' : String(rows[0]!.status) };
    }
    spaces(objectId: string): { spaceId: string; name: string }[] {
        return this.rows('SELECT spaceId,name FROM bindings WHERE objectId=? AND spaceId IS NOT NULL ORDER BY rowid', objectId).map(row => ({ spaceId: String(row.spaceId), name: String(row.name) }));
    }
    setSpaceName(objectId: string, spaceId: string, name: string) {
        this.db.prepare('UPDATE bindings SET name=? WHERE objectId=? AND spaceId=?').run(name, objectId, spaceId);
    }
    objectName(objectId: string) { return this.memory.get(objectId)?.name ?? String(this.row('SELECT name FROM projects WHERE id=? UNION ALL SELECT name FROM tasks WHERE id=?', objectId, objectId)?.name ?? '项目记忆'); }
    bind(objectId: string, spaceId: string, baseUrl: string, name = '') {
        if (!spaceId.trim())
            throw new Error('Space ID不能为空');
        if (!this.memory.get(objectId) && !this.row('SELECT id FROM projects WHERE id=? UNION ALL SELECT id FROM tasks WHERE id=?', objectId, objectId))
            throw new Error('绑定对象不存在');
        spaceId = spaceId.trim();
        const old = this.binding(objectId);
        if (old && old.baseUrl !== baseUrl)
            throw new Error('绑定所属云连接不可更改');
        if (old?.status === 'uncertain') throw new Error('空间创建结果尚待确认');
        if (old?.spaceIds.includes(spaceId)) {
            if (name) this.setSpaceName(objectId, spaceId, name);
            return old;
        }
        const own = !this.db.isTransaction;
        if (own) this.db.exec('BEGIN');
        try {
            const boundAt = now();
            this.db.prepare('DELETE FROM bindings WHERE objectId=? AND spaceId IS NULL').run(objectId);
            this.db.prepare('INSERT INTO bindings(objectId,spaceId,baseUrl,name,status,boundAt) VALUES(?,?,?,?,?,?)').run(objectId, spaceId, baseUrl, name, 'bound', boundAt);
            this.memory.activate(objectId, boundAt);
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
            if (removed.changes && this.row("SELECT name FROM sqlite_master WHERE type='table' AND name='batch_deliveries'"))
                this.db.prepare("UPDATE batch_deliveries SET status='cancelled' WHERE spaceId=? AND baseUrl=? AND status IN ('pending','sending') AND batchId IN(SELECT id FROM batches WHERE objectId=?)")
                    .run(spaceId.trim(), binding.baseUrl, objectId);
            if (!this.binding(objectId)) {
                this.db.prepare('INSERT INTO bindings(objectId,spaceId,baseUrl,name,status) VALUES(?,NULL,?,?,?)').run(objectId, binding.baseUrl, '', 'unbound');
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
        if (binding && binding.baseUrl !== baseUrl) throw new Error('绑定所属云连接不可更改');
        if (binding) this.db.prepare('UPDATE bindings SET status=? WHERE objectId=? AND spaceId IS NULL').run(status, objectId);
        else this.db.prepare('INSERT INTO bindings(objectId,spaceId,baseUrl,name,status) VALUES(?,NULL,?,?,?)').run(objectId, baseUrl, '', status);
    }
    setOverview(sessionId: string, overview: string) { this.db.prepare('UPDATE sessions SET overview=? WHERE id=?').run(overview, sessionId); }
    markContextDelivered(sessionId: string) {
        if (!this.session(sessionId))
            throw new Error('会话不存在');
        this.db.prepare('UPDATE sessions SET overviewDelivered=1 WHERE id=?').run(sessionId);
        this.db.prepare("UPDATE recalls SET status='delivered-to-host' WHERE sessionId=? AND kind='initial' AND status='prepared'").run(sessionId);
    }
    capture(sessionId: string, records: TraceInput[]) {
        const session = this.session(sessionId);
        if (!session)
            throw new Error('会话不存在');
        const scope = this.memory.get(session.objectId);
        if (scope && !scope.spaceIds.length) return 0;
        let added = 0;
        this.db.exec('BEGIN');
        try {
            for (const input of records) {
                if (scope) {
                    // A replay-created turn is not evidence that its source records are new.
                    if (!this.memory.allows(scope.id, this.memory.recordTime(input.raw))) continue;
                }
                const record = stripImages(normalizeTaskTrace(session.agentType, input));
                if (!record?.message) continue;
                if (!record.sourceId)
                    throw new Error('原始记录缺少稳定来源标识');
                if (this.row('SELECT id FROM traces WHERE sessionId=? AND sourceId=?', sessionId, record.sourceId)) continue;
                const message = record.message;
                const turn = record.nativeTurnId ? this.startTurn(sessionId, record.nativeTurnId, false).id : session.currentTurnId;
                const result = this.db.prepare('INSERT OR IGNORE INTO traces(sessionId,conversationId,sourceId,raw,message,createdAt) VALUES(?,?,?,?,?,?)').run(sessionId, turn ? String(turn) : null, record.sourceId, JSON.stringify(record.raw), JSON.stringify(message), now());
                added += Number(result.changes);
            }
            this.db.exec('COMMIT');
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
        return added;
    }
    finalizeTurn(sessionId: string, nativeKey?: string) {
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
        this.db.exec('BEGIN');
        try {
            const traces = this.turnTraces(sessionId, String(turn.id));
            if (traces.length) {
                // Assemble once at completion; the upload worker reuses this exact snapshot.
                const messages = traces.map(trace => trace.message);
                const payload = JSON.stringify(messages), oversized = Buffer.byteLength(payload, 'utf8') > 39000;
                const id = randomUUID();
                this.db.prepare('INSERT INTO batches(id,sessionId,objectId,conversationId,messages,status,error,createdAt) VALUES(?,?,?,?,?,?,?,?)').run(id, sessionId, session.objectId, String(turn.id), payload, oversized ? 'blocked' : 'pending', oversized ? '整轮轨迹超出保守上传容量；完整内容已保留' : null, now());
                this.db.prepare('UPDATE traces SET batchId=? WHERE sessionId=? AND conversationId=?').run(id, sessionId, String(turn.id));
            }
            this.db.prepare('UPDATE turns SET completedAt=? WHERE id=?').run(now(), String(turn.id));
            this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    private turnTraces(sessionId: string, conversationId: string) {
        return this.rows('SELECT * FROM traces WHERE sessionId=? AND conversationId=? ORDER BY id', sessionId, conversationId).map(row => ({ ...row, message: JSON.parse(String(row.message)) }));
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
    recall(sessionId: string, conversationId: string | null, kind: string, query: string | null, data: unknown, content: string, status: string) { this.db.prepare('INSERT INTO recalls VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(), sessionId, conversationId, kind, query, JSON.stringify(data), content, status, now()); }
    diagnostic(message: string) { this.db.prepare('INSERT INTO diagnostics(message,createdAt) VALUES(?,?)').run(message, now()); }
    state() {
        const scope = (objectId: string) => {
            const binding = this.binding(objectId);
            return { spaceIds: binding?.spaceIds ?? [], bindingStatus: binding?.status ?? null };
        };
        const sessions = this.codex.decorateSessions(this.rows('SELECT * FROM sessions')).sort((left, right) => String(left.sourceStartedAt ?? left.createdAt).localeCompare(String(right.sourceStartedAt ?? right.createdAt)) || String(left.id).localeCompare(String(right.id)));
        const projects = this.rows('SELECT * FROM projects').map((project): Row => {
            const members = sessions.filter(session => session.projectId === project.id);
            const times = members.map(session => String(session.sourceStartedAt ?? session.createdAt)).sort();
            const recent = members.map(session => String(session.lastOccurredAt ?? session.sourceStartedAt ?? session.createdAt)).sort();
            return { ...project, ...scope(String(project.id)), agentTypes: this.rows('SELECT agentType FROM project_agents WHERE projectId=? ORDER BY agentType', String(project.id)).map(row => String(row.agentType)), sessionCount: members.length, turnCount: members.reduce((total, session) => total + Number(session.turnCount ?? this.row('SELECT count(*) AS n FROM turns WHERE sessionId=?', String(session.id))?.n ?? 0), 0), earliestOccurredAt: times[0] ?? null, lastOccurredAt: recent.at(-1) ?? null };
        });
        const quarantinedSessions = this.rows("SELECT s.id,s.nativeSessionId,s.createdAt FROM sessions s WHERE s.agentType='codex-cli' AND NOT EXISTS(SELECT 1 FROM codex_source_meta m WHERE m.nativeSessionId=s.nativeSessionId AND m.sourceKind IN ('user','subagent'))");
        return { projects, bindings: this.memory.all(), quarantinedSessions, tasks: this.rows('SELECT * FROM tasks').map((task): Row => ({ ...task, ...scope(String(task.objectId)) })), sessions, batches: this.batches(), recalls: this.rows('SELECT * FROM recalls ORDER BY createdAt DESC').map((r): Row => ({ ...r, data: JSON.parse(String(r.data)) })), diagnostics: this.rows('SELECT * FROM diagnostics ORDER BY id DESC LIMIT 100') };
    }
    sessionDetail(id: string, page = 1, size = 50, unit: 'trace' | 'turn' = 'trace') {
        if (this.codex.hasSession(id)) return this.codex.detail(id, page, size, unit);
        // Missing turn IDs stay separate rather than merging unrelated tasks.
        const groupKey = "COALESCE(conversationId, 'trace:' || id)";
        const byTurn = unit === 'turn';
        const selected = byTurn
            ? this.rows(`SELECT * FROM traces WHERE sessionId=? AND ${groupKey} IN (SELECT ${groupKey} FROM traces WHERE sessionId=? GROUP BY ${groupKey} ORDER BY MIN(id) LIMIT ? OFFSET ?) ORDER BY id`, id, id, size, (page - 1) * size)
            : this.rows('SELECT * FROM traces WHERE sessionId=? ORDER BY id LIMIT ? OFFSET ?', id, size, (page - 1) * size);
        const traces = selected.map((r): Row => ({ ...r, raw: JSON.parse(String(r.raw)), message: JSON.parse(String(r.message)) }));
        const grouped = new Map<string, { id: string; traces: Row[]; captureStatus?: string; uploadOutOfDate?: boolean }>();
        if (byTurn) for (const trace of traces) {
            const key = String(trace.conversationId ?? `trace:${trace.id}`);
            if (!grouped.has(key)) grouped.set(key, { id: key, traces: [] });
            grouped.get(key)!.traces.push(trace);
        }
        const total = Number(this.row(`SELECT count(${byTurn ? `DISTINCT ${groupKey}` : '*'}) AS total FROM traces WHERE sessionId=?`, id)?.total ?? 0);
        return { session: this.session(id), turns: this.rows('SELECT * FROM turns WHERE sessionId=? ORDER BY createdAt', id), traces, groups: byTurn ? [...grouped.values()] : undefined, recalls: this.state().recalls.filter(r => r.sessionId === id), batches: this.batches().filter(r => r.sessionId === id), total, page, size };
    }
}
