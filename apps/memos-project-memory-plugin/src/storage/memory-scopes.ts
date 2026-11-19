import { randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import type { Store, Session } from './store.ts';

export interface MemoryScope {
    id: string;
    projectId: string;
    agentType: string;
    name: string;
    root: string;
    baseUrl: string;
    spaceIds: string[];
    enabledAt: string | null;
}

/** A project is discoverable independently; only its Agent binding admits memory work. */
export class MemoryScopes {
    private store: Store;
    constructor(store: Store, path: string) {
        this.store = store;
        const migrated = store.rows('PRAGMA table_info(project_agents)').some(column => column.name === 'id');
        if (!migrated && path !== ':memory:' && (store.row('SELECT id FROM sessions LIMIT 1') || store.row('SELECT objectId FROM bindings LIMIT 1'))) {
            const backup = `${path}.before-agent-bindings-${Date.now()}.sqlite`;
            store.db.prepare('VACUUM INTO ?').run(backup); chmodSync(backup, 0o600);
        }
        store.db.exec('BEGIN');
        try {
            if (!migrated) store.db.exec('ALTER TABLE project_agents ADD COLUMN id TEXT');
            if (!store.rows('PRAGMA table_info(bindings)').some(column => column.name === 'boundAt'))
                store.db.exec('ALTER TABLE bindings ADD COLUMN boundAt TEXT');
            store.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS project_agent_scope ON project_agents(id);
CREATE TABLE IF NOT EXISTS capture_windows(id INTEGER PRIMARY KEY AUTOINCREMENT,scopeId TEXT NOT NULL,startedAt TEXT NOT NULL,endedAt TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS capture_window_open ON capture_windows(scopeId) WHERE endedAt IS NULL;`);
            if (!migrated) {
                const time = new Date().toISOString();
                for (const association of store.rows('SELECT projectId,agentType FROM project_agents')) {
                    const projectId = String(association.projectId), agentType = String(association.agentType), id = this.ensure(projectId, agentType);
                    // Only known Agent associations inherit a legacy project binding.
                    store.db.prepare(`INSERT INTO bindings(objectId,spaceId,baseUrl,name,status,boundAt)
SELECT ?,spaceId,baseUrl,name,status,CASE WHEN spaceId IS NULL THEN NULL ELSE ? END FROM bindings WHERE objectId=?`).run(id, time, projectId);
                    if (store.binding(id)?.spaceIds.length) this.activate(id, time);
                    for (const session of store.rows('SELECT s.id,s.taskId FROM sessions s JOIN tasks t ON t.id=s.taskId WHERE t.projectId=? AND s.agentType=?', projectId, agentType)) {
                        store.db.prepare('UPDATE sessions SET objectId=?,overview=NULL,overviewDelivered=0 WHERE id=?').run(id, String(session.id));
                        store.db.prepare('UPDATE tasks SET objectId=? WHERE id=?').run(id, String(session.taskId));
                        store.db.prepare('UPDATE batches SET objectId=? WHERE sessionId=?').run(id, String(session.id));
                    }
                }
                // Keep unknown legacy bindings for audit; they do not grant admission.
            }
            store.db.exec('COMMIT');
        } catch (error) { store.db.exec('ROLLBACK'); throw error; }
    }

    ensure(projectId: string, agentType: string): string {
        if (!agentType.trim()) throw new Error('请选择 Agent');
        const known = this.store.row('SELECT id FROM project_agents WHERE projectId=? AND agentType=?', projectId, agentType);
        if (known?.id) return String(known.id);
        const id = randomUUID();
        this.store.db.prepare(`INSERT INTO project_agents(projectId,agentType,id) VALUES(?,?,?)
ON CONFLICT(projectId,agentType) DO UPDATE SET id=excluded.id`).run(projectId, agentType, id);
        return id;
    }

    get(id: string): MemoryScope | undefined {
        const scope = this.store.row('SELECT a.id,a.projectId,a.agentType,p.name,p.root FROM project_agents a JOIN projects p ON p.id=a.projectId WHERE a.id=?', id);
        if (!scope) return undefined;
        const binding = this.store.binding(id);
        const open = this.store.row('SELECT startedAt FROM capture_windows WHERE scopeId=? AND endedAt IS NULL', id);
        return { ...scope, baseUrl: binding?.baseUrl ?? '', spaceIds: binding?.spaceIds ?? [], enabledAt: open ? String(open.startedAt) : null } as MemoryScope;
    }

    all(): MemoryScope[] {
        return this.store.rows('SELECT id FROM project_agents WHERE id IS NOT NULL AND EXISTS(SELECT 1 FROM bindings WHERE objectId=project_agents.id) ORDER BY projectId,agentType')
            .map(row => this.get(String(row.id))!);
    }

    resolve(agentType: string, cwd: string): MemoryScope | undefined {
        const project = this.store.projectForDirectory(cwd);
        if (!project) return undefined;
        const row = this.store.row('SELECT id FROM project_agents WHERE projectId=? AND agentType=?', project.id, agentType);
        const scope = row?.id ? this.get(String(row.id)) : undefined;
        return scope?.spaceIds.length ? scope : undefined;
    }

    forSession(session: Pick<Session, 'objectId' | 'agentType'>): MemoryScope | undefined {
        const scope = this.get(session.objectId);
        return scope?.agentType === session.agentType && scope.spaceIds.length ? scope : undefined;
    }

    allows(scopeId: string, occurredAt: string | undefined): boolean {
        if (!occurredAt || !this.get(scopeId)?.spaceIds.length) return false;
        const milliseconds = Date.parse(occurredAt);
        if (!Number.isFinite(milliseconds)) return false;
        const time = new Date(milliseconds).toISOString();
        return !!this.store.row('SELECT id FROM capture_windows WHERE scopeId=? AND startedAt<=? AND endedAt IS NULL LIMIT 1', scopeId, time);
    }

    activate(scopeId: string, time: string) {
        if (!this.store.row('SELECT id FROM project_agents WHERE id=?', scopeId)) return;
        if (!this.store.row('SELECT id FROM capture_windows WHERE scopeId=? AND endedAt IS NULL', scopeId))
            this.store.db.prepare('INSERT INTO capture_windows(scopeId,startedAt) VALUES(?,?)').run(scopeId, time);
    }

    deactivate(scopeId: string, time: string) {
        this.store.db.prepare('UPDATE capture_windows SET endedAt=? WHERE scopeId=? AND endedAt IS NULL').run(time, scopeId);
    }

    recordTime(raw: unknown): string | undefined {
        if (!raw || typeof raw !== 'object') return undefined;
        const value = raw as Record<string, any>;
        for (const candidate of [value.occurredAt, value.timestamp, value.createdAt, value.time, value.payload?.timestamp, value.message?.timestamp, value.message?.createdAt, value.data?.timestamp, value.info?.time?.created]) {
            if (typeof candidate !== 'string' && typeof candidate !== 'number') continue;
            const date = new Date(typeof candidate === 'number' && candidate < 1e12 ? candidate * 1000 : candidate);
            if (Number.isFinite(date.getTime())) return date.toISOString();
        }
        return undefined;
    }
}
