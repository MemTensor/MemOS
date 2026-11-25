import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isAbsolute, resolve } from 'node:path';
import type { Store } from './store.ts';
import { profiles } from '../adapters/registry.ts';

export interface CreationIdentity {
    agentType: string;
    nativeSessionId: string;
    cwd: string;
    event: string;
    nativeTurnId?: string;
    turnKey?: string;
    parentNativeSessionId?: string;
    occurredAt?: string;
}
export interface CreationContext {
    token: string;
    agentType: string;
    nativeSessionId: string;
    cwd: string;
    nativeTurnId: string;
    startedAt: string;
    endedAt: string | null;
    current: number;
    state: string;
    request: string | null;
    result: string | null;
}

/** Identity-only records are independent of the consent-gated task/session tables. */
export class CreateContexts {
    private store: Store;
    private directory: string | undefined;
    constructor(store: Store, path: string) {
        this.store = store;
        this.directory = path === ':memory:' ? undefined : dirname(path);
        if (!store.row("SELECT 1 FROM sqlite_master WHERE name='create_contexts'") && path !== ':memory:'
            && (store.row('SELECT 1 FROM sessions LIMIT 1') || store.row('SELECT 1 FROM bindings LIMIT 1'))) {
            const backup = `${path}.before-create-contexts-${Date.now()}.sqlite`;
            store.db.prepare('VACUUM INTO ?').run(backup); chmodSync(backup, 0o600);
        }
        store.db.exec(`CREATE TABLE IF NOT EXISTS create_hosts(agentType TEXT NOT NULL,nativeSessionId TEXT NOT NULL,cwd TEXT NOT NULL,parentNativeSessionId TEXT,PRIMARY KEY(agentType,nativeSessionId));
CREATE TABLE IF NOT EXISTS create_contexts(token TEXT PRIMARY KEY,agentType TEXT NOT NULL,nativeSessionId TEXT NOT NULL,cwd TEXT NOT NULL,nativeTurnId TEXT NOT NULL,startedAt TEXT NOT NULL,endedAt TEXT,current INTEGER NOT NULL DEFAULT 1,state TEXT NOT NULL DEFAULT 'ready',request TEXT,result TEXT,UNIQUE(agentType,nativeSessionId,nativeTurnId));
CREATE UNIQUE INDEX IF NOT EXISTS create_current ON create_contexts(agentType,nativeSessionId) WHERE current=1;
CREATE TABLE IF NOT EXISTS create_space_boundaries(scopeId TEXT NOT NULL,spaceId TEXT NOT NULL,baseUrl TEXT NOT NULL,startedAfter TEXT NOT NULL,PRIMARY KEY(scopeId,spaceId,baseUrl));
CREATE TABLE IF NOT EXISTS create_turn_exclusions(agentType TEXT NOT NULL,nativeSessionId TEXT NOT NULL,nativeTurnId TEXT NOT NULL,token TEXT NOT NULL,PRIMARY KEY(agentType,nativeSessionId,nativeTurnId));`);
        if (!store.rows('PRAGMA table_info(create_hosts)').some(column => column.name === 'overviewDelivered'))
            store.db.exec('ALTER TABLE create_hosts ADD COLUMN overviewDelivered INTEGER NOT NULL DEFAULT 0');
    }
    observe(input: CreationIdentity): { createContext: string; createIdentifiers: string } {
        if (!input || typeof input.agentType !== 'string' || !profiles.some(profile => profile.agentId === input.agentType)
            || typeof input.nativeSessionId !== 'string' || !input.nativeSessionId.trim()
            || typeof input.cwd !== 'string' || !isAbsolute(input.cwd)
            || !['session-start', 'turn-start', 'trace-available', 'turn-end', 'session-end'].includes(input.event))
            throw new Error('创建上下文缺少可靠宿主身份或项目目录');
        const known = this.store.row('SELECT cwd FROM sessions WHERE agentType=? AND nativeSessionId=?', input.agentType, input.nativeSessionId);
        const parent = typeof input.parentNativeSessionId === 'string' ? this.store.row('SELECT cwd FROM create_hosts WHERE agentType=? AND nativeSessionId=?', input.agentType, input.parentNativeSessionId) : undefined;
        this.store.db.prepare('INSERT OR IGNORE INTO create_hosts(agentType,nativeSessionId,cwd,parentNativeSessionId) VALUES(?,?,?,?)')
            .run(input.agentType, input.nativeSessionId, String(known?.cwd ?? parent?.cwd ?? resolve(input.cwd)), input.parentNativeSessionId ?? null);
        const host = this.store.row('SELECT cwd FROM create_hosts WHERE agentType=? AND nativeSessionId=?', input.agentType, input.nativeSessionId)!;
        const previousContext = this.store.row('SELECT token FROM create_contexts WHERE agentType=? AND nativeSessionId=? AND current=1', input.agentType, input.nativeSessionId);
        const key = input.nativeTurnId ?? input.turnKey;
        if (input.event === 'turn-start') {
            if (typeof key !== 'string' || !key.trim()) throw new Error('创建上下文缺少当前用户轮标识');
            const prior = this.store.row('SELECT * FROM create_contexts WHERE agentType=? AND nativeSessionId=? AND nativeTurnId=?', input.agentType, input.nativeSessionId, key);
            if (prior && !prior.current) return { createContext: '', createIdentifiers: '' };
            if (!prior) {
                const time = input.occurredAt && Number.isFinite(Date.parse(input.occurredAt)) ? new Date(input.occurredAt).toISOString() : new Date().toISOString();
                const latest = this.store.row('SELECT startedAt FROM create_contexts WHERE agentType=? AND nativeSessionId=? ORDER BY startedAt DESC LIMIT 1', input.agentType, input.nativeSessionId);
                if (latest && time < String(latest.startedAt)) return { createContext: '', createIdentifiers: '' };
                this.store.db.prepare('UPDATE create_contexts SET current=0,endedAt=COALESCE(endedAt,?) WHERE agentType=? AND nativeSessionId=? AND endedAt IS NULL').run(time, input.agentType, input.nativeSessionId);
                this.store.db.prepare('INSERT INTO create_contexts(token,agentType,nativeSessionId,cwd,nativeTurnId,startedAt) VALUES(?,?,?,?,?,?)')
                    .run(randomUUID(), input.agentType, input.nativeSessionId, String(host.cwd), key, time);
            }
        }
        if (input.event === 'session-end' || input.event === 'turn-end') {
            const time = input.occurredAt && Number.isFinite(Date.parse(input.occurredAt)) ? new Date(input.occurredAt).toISOString() : new Date().toISOString();
            this.store.db.prepare('UPDATE create_contexts SET current=0 WHERE agentType=? AND nativeSessionId=? AND current=1 AND startedAt<=? AND (? IS NULL OR nativeTurnId=?)')
                .run(input.agentType, input.nativeSessionId, time, key ?? null, key ?? null);
        }
        const current = this.store.row('SELECT token FROM create_contexts WHERE agentType=? AND nativeSessionId=? AND current=1', input.agentType, input.nativeSessionId);
        const token = current ? String(current.token) : '';
        const binding = this.bindingLauncher(token, previousContext ? String(previousContext.token) : '');
        return { createContext: token, createIdentifiers: token ? `MemOS 项目空间创建调用上下文（仅在用户明确要求创建时使用）：\ncreate-context: ${token}\n调用 memos-pm create 时将此值传给 --context；name 和 domain 均须由用户明确。${binding}` : '' };
    }
    private bindingLauncher(token: string, previous: string): string {
        if (!this.directory) return '';
        const directory = join(this.directory, 'bind');
        // Retire the previous entry without scanning session history on every Hook.
        if (previous && previous !== token) rmSync(join(directory, previous + '.mjs'), { force: true });
        if (!token) return '';
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const path = join(directory, token + '.mjs');
        const entry = new URL('../cli/run.ts', import.meta.url).href;
        const text = `import { run } from ${JSON.stringify(entry)};\nprocess.env.MEMOS_PM_DATA_DIR = ${JSON.stringify(this.directory)};\nconst args = process.argv.slice(2);\nconst result = await run(['spaces', 'unbind'].includes(args[0]) ? args : ['bind', ...args], undefined, { MEMOS_PM_BIND_CONTEXT: ${JSON.stringify(token)} });\nprocess.stdout.write(JSON.stringify(result) + '\\n');\nprocess.exitCode = result.ok ? 0 : 1;\n`;
        // Refresh legacy entry points in-place when the same active round is observed after an update.
        if (!existsSync(path) || readFileSync(path, 'utf8') !== text) {
            const temporary = `${path}.${process.pid}.tmp`;
            try {
                writeFileSync(temporary, text, { mode: 0o600 });
                renameSync(temporary, path);
            } finally { rmSync(temporary, { force: true }); }
        }
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        return `\n\nMemOS 当前轮绑定入口（仅在用户明确要求绑定已有 Space 时使用；只替换 Space ID，不传身份参数）：\n${quote(process.execPath)} ${quote(path)} --space-id '<用户提供的 Space ID>'\n入口已固定当前 Agent、项目和轮次；不要复用历史入口。\n\nMemOS 当前轮空间查询入口（查看本地绑定名称和 ID；无需参数）：\n${quote(process.execPath)} ${quote(path)} spaces\n\nMemOS 当前轮解绑入口（仅在用户明确要求解除指定空间关联时使用；只替换 Space ID）：\n${quote(process.execPath)} ${quote(path)} unbind --space-id '<用户提供的 Space ID>'`;

    }
    get(token: string): CreationContext | undefined {
        return this.store.row('SELECT * FROM create_contexts WHERE token=? AND current=1', token) as unknown as CreationContext | undefined;
    }
    private hasExclusions(agentType: string, nativeSessionId: string): boolean {
        const seen = new Set<string>();
        while (nativeSessionId && !seen.has(nativeSessionId)) {
            seen.add(nativeSessionId);
            if (this.store.row("SELECT 1 FROM create_contexts WHERE agentType=? AND nativeSessionId=? AND state<>'ready' LIMIT 1", agentType, nativeSessionId)) return true;
            const host = this.store.row('SELECT parentNativeSessionId FROM create_hosts WHERE agentType=? AND nativeSessionId=?', agentType, nativeSessionId);
            const session = host?.parentNativeSessionId ? undefined : this.store.row('SELECT parentNativeSessionId FROM sessions WHERE agentType=? AND nativeSessionId=?', agentType, nativeSessionId);
            nativeSessionId = String(host?.parentNativeSessionId ?? session?.parentNativeSessionId ?? '');
        }
        return false;
    }
    excluded(agentType: string, nativeSessionId: string, nativeTurnId?: string, occurredAt?: string): boolean {
        const origin = nativeSessionId;
        if (nativeTurnId && this.store.row('SELECT 1 FROM create_turn_exclusions WHERE agentType=? AND nativeSessionId=? AND nativeTurnId=?', agentType, origin, nativeTurnId)) return true;
        const seen = new Set<string>();
        while (nativeSessionId && !seen.has(nativeSessionId)) {
            seen.add(nativeSessionId);
            const rows = this.store.rows("SELECT token,nativeTurnId,startedAt,endedAt FROM create_contexts WHERE agentType=? AND nativeSessionId=? AND state<>'ready'", agentType, nativeSessionId);
            const match = rows.find(row => nativeTurnId === row.nativeTurnId || occurredAt && Date.parse(occurredAt) >= Date.parse(String(row.startedAt))
                && (!row.endedAt || Date.parse(occurredAt) < Date.parse(String(row.endedAt))));
            if (match) {
                if (nativeTurnId) this.store.db.prepare('INSERT OR IGNORE INTO create_turn_exclusions VALUES(?,?,?,?)').run(agentType, origin, nativeTurnId, String(match.token));
                return true;
            }
            const host = this.store.row('SELECT parentNativeSessionId FROM create_hosts WHERE agentType=? AND nativeSessionId=?', agentType, nativeSessionId);
            const session = host?.parentNativeSessionId ? undefined : this.store.row('SELECT parentNativeSessionId FROM sessions WHERE agentType=? AND nativeSessionId=?', agentType, nativeSessionId);
            nativeSessionId = String(host?.parentNativeSessionId ?? session?.parentNativeSessionId ?? '');
        }
        return false;
    }
    private turnIdentity(sessionId: string, conversationId: string) {
        const session = this.store.session(sessionId);
        const turn = this.store.row('SELECT nativeKey,createdAt,completedAt FROM turns WHERE id=? AND sessionId=?', conversationId, sessionId);
        if (!session || !turn) return undefined;
        const round = this.store.row('SELECT rootTurnId,startedAt,completedAt FROM codex_rounds WHERE conversationId=?', conversationId);
        const context = this.store.row('SELECT startedAt,state FROM create_contexts WHERE agentType=? AND nativeSessionId=? AND nativeTurnId=?', session.agentType, session.nativeSessionId, String(round?.rootTurnId ?? turn.nativeKey));
        const raw = this.store.row("SELECT raw FROM traces WHERE sessionId=? AND conversationId=? AND json_extract(message,'$.role')='user' ORDER BY id LIMIT 1", sessionId, conversationId)?.raw;
        const time = context?.startedAt ?? round?.startedAt ?? (raw ? this.store.memory.recordTime(JSON.parse(String(raw))) : undefined);
        return { session, nativeTurnId: String(round?.rootTurnId ?? turn.nativeKey), time: time ? String(time) : undefined,
            completedAt: round?.completedAt ?? turn.completedAt, registered: !!context };
    }
    recordExcluded(sessionId: string, nativeTurnId: string | undefined, occurredAt: string | undefined): boolean {
        const session = this.store.session(sessionId);
        if (!session) return false;
        if (!this.hasExclusions(session.agentType, session.nativeSessionId)) return false;
        const turn = nativeTurnId ? this.store.row('SELECT id FROM turns WHERE sessionId=? AND nativeKey=?', sessionId, nativeTurnId)
            : session.currentTurnId ? { id: session.currentTurnId } : undefined;
        if (turn && this.turnIdentity(sessionId, String(turn.id))?.time) return this.turnExcluded(sessionId, String(turn.id));
        return this.excluded(session.agentType, session.nativeSessionId, nativeTurnId, occurredAt);
    }
    turnExcluded(sessionId: string, conversationId: string): boolean {
        const session = this.store.session(sessionId);
        if (!session || !this.hasExclusions(session.agentType, session.nativeSessionId)) return false;
        const turn = this.turnIdentity(sessionId, conversationId);
        if (!turn) return false;
        if (this.excluded(turn.session.agentType, turn.session.nativeSessionId, turn.nativeTurnId, turn.time)) return true;
        if (turn.registered) return false;
        // A prompt Hook can run after the source-native round has already begun.
        // Reconcile that execution interval once, then retain its exact identity
        // so late records cannot be reassigned when the next prompt arrives.
        if (!turn.time) return false;
        const start = Date.parse(turn.time), end = turn.completedAt ? Date.parse(String(turn.completedAt)) : Infinity;
        const nextUser = this.store.rows("SELECT raw FROM traces WHERE sessionId=? AND conversationId<>? AND json_extract(message,'$.role')='user'", sessionId, conversationId)
            .reduce((next, row) => { const time = this.store.memory.recordTime(JSON.parse(String(row.raw))); const value = time ? Date.parse(time) : NaN; return value > start ? Math.min(next, value) : next; }, Infinity);
        const context = this.store.rows('SELECT token,startedAt,state FROM create_contexts WHERE agentType=? AND nativeSessionId=? ORDER BY startedAt', turn.session.agentType, turn.session.nativeSessionId)
            .find(context => Date.parse(String(context.startedAt)) >= start && Date.parse(String(context.startedAt)) < nextUser
                && (end < start || Date.parse(String(context.startedAt)) <= end));
        if (!context || context.state === 'ready') return false;
        this.store.db.prepare('INSERT OR IGNORE INTO create_turn_exclusions VALUES(?,?,?,?)').run(turn.session.agentType, turn.session.nativeSessionId, turn.nativeTurnId, String(context.token));
        return true;
    }
    markBinding(scopeId: string, spaceId: string, baseUrl: string) {
        const binding = this.store.row('SELECT boundAt,connectionId FROM bindings WHERE objectId=? AND spaceId=? AND baseUrl=?', scopeId, spaceId, baseUrl);
        if (!binding?.boundAt) throw new Error('创建后的绑定边界缺失');
        this.store.db.prepare('INSERT OR REPLACE INTO create_space_boundaries(scopeId,spaceId,baseUrl,connectionId,startedAfter) VALUES(?,?,?,?,?)').run(scopeId, spaceId, baseUrl, String(binding.connectionId), String(binding.boundAt));
    }
    liveRowsAllowed(sessionId: string, spaceId: string, baseUrl: string, rows: { conversationId?: unknown }[]): boolean {
        const session = this.store.session(sessionId);
        if (!session) return false;
        const boundary = this.store.row('SELECT startedAfter FROM create_space_boundaries WHERE scopeId=? AND spaceId=? AND connectionId=?', session.objectId, spaceId, this.store.connectionId(baseUrl));
        const ids = new Set(rows.map(row => row.conversationId));
        for (const id of ids) {
            if (typeof id === 'string' && this.turnExcluded(sessionId, id)) return false;
            const turn = boundary && typeof id === 'string' ? this.turnIdentity(sessionId, id) : undefined;
            if (boundary && (!turn?.time || Date.parse(turn.time) <= Date.parse(String(boundary.startedAfter)))) return false;
        }
        return !boundary || !!rows.length;
    }
}
