import { filterBindRecords, isBindControl } from '../adapters/_shared/bind-records.ts';
import { hasTaskContent } from '../adapters/_shared/message-content.ts';
import { normalizeTaskTrace } from '../adapters/_shared/task-trace.ts';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import type { CodexSnapshot, CodexTurn, CodexExpectedChild, CodexSourceKind } from '../adapters/codex-cli/types.ts';
import type { Message } from '../adapters/types.ts';
import type { Store, Session } from './store.ts';
import { hasCodexActivity } from '../adapters/codex-cli/rollout.ts';
import { orderTraceRecords } from './trace-order.ts';
import { filterUploadTraces } from './upload-filter.ts';
import { uploadValidationError } from '../adapters/_shared/message-content.ts';
import { filterCodexSkills } from '../adapters/codex-cli/skill-filter.ts';
import { hasIncompleteSkill } from '../adapters/_shared/skill-records.ts';

type Row = Record<string, unknown>;
interface Source { sourcePath: string; nativeSessionId: string; cwd: string; parentNativeSessionId?: string; agentPath?: string; sourceKind: CodexSourceKind; startedAt?: string; gaps: string[] }
interface Execution extends Omit<CodexTurn, 'records'> { nativeSessionId: string; agentPath?: string; ownerSessionId?: string; conversationId?: string }
const now = () => new Date().toISOString();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const minimum = (values: (string | undefined | null)[]) => values.filter((value): value is string => !!value).sort()[0];
const maximum = (values: (string | undefined | null)[]) => values.filter((value): value is string => !!value).sort().at(-1);
const executionKey = (session: string, turn: string) => JSON.stringify([session, turn]);
const terminal = (status: string) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);

/** Codex source identities and completeness are isolated from other adapters' capture rules. */
export class CodexStorage {
    store: Store;
    constructor(store: Store, path: string) {
        this.store = store;
        const exists = store.row("SELECT name FROM sqlite_master WHERE type='table' AND name='codex_rounds'");
        if (!exists && path !== ':memory:' && store.row("SELECT id FROM sessions WHERE agentType='codex-cli' LIMIT 1")) {
            const backup = `${path}.before-codex-rounds-${Date.now()}.sqlite`;
            store.db.prepare('VACUUM INTO ?').run(backup); chmodSync(backup, 0o600);
        }
        store.db.exec(`
CREATE TABLE IF NOT EXISTS codex_source_meta(sourcePath TEXT PRIMARY KEY,nativeSessionId TEXT NOT NULL,cwd TEXT NOT NULL,parentNativeSessionId TEXT,agentPath TEXT,sourceKind TEXT NOT NULL,startedAt TEXT,gaps TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS codex_execution_sources(sourcePath TEXT NOT NULL,nativeSessionId TEXT NOT NULL,nativeTurnId TEXT NOT NULL,rootTurnId TEXT NOT NULL,parentTurnId TEXT,startedAt TEXT,completedAt TEXT,status TEXT NOT NULL,expectedChildren TEXT NOT NULL,gaps TEXT NOT NULL,PRIMARY KEY(sourcePath,nativeSessionId,nativeTurnId));
CREATE TABLE IF NOT EXISTS codex_event_meta(sourceId TEXT PRIMARY KEY,traceId INTEGER NOT NULL UNIQUE REFERENCES traces(id),originSessionId TEXT NOT NULL,nativeTurnId TEXT NOT NULL,rootTurnId TEXT NOT NULL,occurredAt TEXT,sourceOrdinal INTEGER NOT NULL,agentPath TEXT);
CREATE TABLE IF NOT EXISTS codex_event_sources(sourcePath TEXT NOT NULL,sourceId TEXT NOT NULL,messageHash TEXT,PRIMARY KEY(sourcePath,sourceId));
CREATE TABLE IF NOT EXISTS codex_rounds(conversationId TEXT PRIMARY KEY REFERENCES turns(id),ownerSessionId TEXT NOT NULL REFERENCES sessions(id),rootTurnId TEXT NOT NULL,startedAt TEXT,completedAt TEXT,executionStatus TEXT NOT NULL,captureStatus TEXT NOT NULL,eventSetHash TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,snapshotHash TEXT,gaps TEXT NOT NULL,UNIQUE(ownerSessionId,rootTurnId));
CREATE TABLE IF NOT EXISTS codex_execution_map(nativeSessionId TEXT NOT NULL,nativeTurnId TEXT NOT NULL,conversationId TEXT NOT NULL REFERENCES turns(id),ownerSessionId TEXT NOT NULL REFERENCES sessions(id),status TEXT NOT NULL,startedAt TEXT,PRIMARY KEY(nativeSessionId,nativeTurnId));
CREATE TABLE IF NOT EXISTS codex_context_reservations(nativeSessionId TEXT NOT NULL,nativeTurnId TEXT NOT NULL,rootTurnId TEXT NOT NULL,conversationId TEXT NOT NULL REFERENCES turns(id),createdAt TEXT NOT NULL,PRIMARY KEY(nativeSessionId,nativeTurnId));
CREATE INDEX IF NOT EXISTS codex_event_round ON traces(conversationId);
CREATE INDEX IF NOT EXISTS codex_sources_session ON codex_source_meta(nativeSessionId);
`);
        if (!store.rows('PRAGMA table_info(codex_event_sources)').some(row => row.name === 'messageHash')) store.db.exec('ALTER TABLE codex_event_sources ADD COLUMN messageHash TEXT');
        // Reconciliation probes these identities once per event. The sourcePath-first
        // primary key cannot serve sourceId lookups and caused quadratic full scans.
        store.db.exec(`CREATE INDEX IF NOT EXISTS codex_event_source_lookup ON codex_event_sources(sourceId,messageHash);
CREATE INDEX IF NOT EXISTS codex_event_execution_lookup ON codex_event_meta(originSessionId,nativeTurnId);`);
        // Legacy requests are not safe to resume until their raw sources have been reconciled.
        store.db.prepare(`UPDATE batches SET status='blocked',error='旧版 Codex 轨迹需原始记录回放修复'
WHERE uploaded=0 AND status='pending' AND sessionId IN (SELECT id FROM sessions WHERE agentType='codex-cli')
AND NOT EXISTS (SELECT 1 FROM codex_rounds r WHERE r.conversationId=batches.conversationId)`).run();
        this.pruneEmptySessions();
    }
    private transaction<T>(work: () => T): T {
        const own = !this.store.db.isTransaction;
        if (own) this.store.db.exec('BEGIN IMMEDIATE');
        try { const result = work(); if (own) this.store.db.exec('COMMIT'); return result; }
        catch (error) { if (own) this.store.db.exec('ROLLBACK'); throw error; }
    }
    private sources(): Source[] {
        return this.store.rows('SELECT * FROM codex_source_meta').map(row => ({ ...row, gaps: JSON.parse(String(row.gaps)), parentNativeSessionId: row.parentNativeSessionId ?? undefined, agentPath: row.agentPath ?? undefined, startedAt: row.startedAt ?? undefined })) as unknown as Source[];
    }
    private metadata(): Map<string, Source> {
        const merged = new Map<string, Source>();
        for (const source of this.sources()) {
            const prior = merged.get(source.nativeSessionId);
            if (!prior) { merged.set(source.nativeSessionId, source); continue; }
            const conflicts = prior.sourceKind !== source.sourceKind ? ['source_kind_conflict'] : [];
            merged.set(source.nativeSessionId, { ...prior, sourceKind: conflicts.length ? 'unknown' : prior.sourceKind, startedAt: minimum([prior.startedAt, source.startedAt]), gaps: [...new Set([...prior.gaps, ...source.gaps, ...conflicts, ...(resolve(prior.cwd) !== resolve(source.cwd) ? ['source_directory_conflict'] : [])])], parentNativeSessionId: prior.parentNativeSessionId ?? source.parentNativeSessionId, agentPath: prior.agentPath ?? source.agentPath });
        }
        return merged;
    }
    private executions(): Execution[] {
        const merged = new Map<string, Execution>();
        for (const row of this.store.rows('SELECT * FROM codex_execution_sources ORDER BY sourcePath')) {
            const next = { ...row, parentTurnId: row.parentTurnId ?? undefined, startedAt: row.startedAt ?? undefined, completedAt: row.completedAt ?? undefined, expectedChildren: JSON.parse(String(row.expectedChildren)), gaps: JSON.parse(String(row.gaps)) } as unknown as Execution;
            const key = executionKey(next.nativeSessionId, next.nativeTurnId), prior = merged.get(key);
            if (!prior) { merged.set(key, next); continue; }
            const expected = new Map([...prior.expectedChildren, ...next.expectedChildren].map(child => [child.callId, child]));
            const status = next.completedAt && (!prior.completedAt || next.completedAt >= prior.completedAt) ? next.status : prior.status;
            merged.set(key, { ...prior, status, startedAt: minimum([prior.startedAt, next.startedAt]), completedAt: maximum([prior.completedAt, next.completedAt]), expectedChildren: [...expected.values()], gaps: [...new Set([...prior.gaps, ...next.gaps, ...(prior.rootTurnId !== next.rootTurnId ? ['root_identity_conflict'] : [])])] });
        }
        return [...merged.values()];
    }
    apply(snapshots: CodexSnapshot[], options: { prepareUploads?: boolean; requireBinding?: boolean } = {}) {
        return this.transaction(() => {
            for (const snapshot of snapshots) {
                if (!snapshot.sourcePath || !snapshot.nativeSessionId) continue;
                if (!hasCodexActivity(snapshot)) {
                    const prior = this.store.row('SELECT gaps FROM codex_source_meta WHERE sourcePath=?', snapshot.sourcePath);
                    if (prior && (this.store.row('SELECT 1 FROM codex_execution_sources WHERE sourcePath=? LIMIT 1', snapshot.sourcePath)
                        || this.store.row('SELECT 1 FROM codex_event_sources WHERE sourcePath=? LIMIT 1', snapshot.sourcePath))) {
                        this.store.db.prepare('UPDATE codex_source_meta SET gaps=? WHERE sourcePath=?').run(JSON.stringify([...new Set([...JSON.parse(String(prior.gaps)), 'source_became_empty'])]), snapshot.sourcePath);
                    }
                    continue;
                }
                this.store.db.prepare(`INSERT INTO codex_source_meta VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(sourcePath) DO UPDATE SET nativeSessionId=excluded.nativeSessionId,cwd=excluded.cwd,parentNativeSessionId=excluded.parentNativeSessionId,agentPath=excluded.agentPath,sourceKind=excluded.sourceKind,startedAt=excluded.startedAt,gaps=excluded.gaps`).run(snapshot.sourcePath, snapshot.nativeSessionId, snapshot.cwd, snapshot.parentNativeSessionId ?? null, snapshot.agentPath ?? null, snapshot.sourceKind, snapshot.startedAt ?? null, JSON.stringify(snapshot.gaps));
                this.store.db.prepare('DELETE FROM codex_execution_sources WHERE sourcePath=?').run(snapshot.sourcePath);
                this.store.db.prepare('DELETE FROM codex_event_sources WHERE sourcePath=?').run(snapshot.sourcePath);
                if (!['user', 'subagent'].includes(snapshot.sourceKind)) continue;
                for (const turn of snapshot.turns) {
                    if (turn.sourceKind === 'background' || turn.sourceKind === 'unknown') continue;
                    this.store.db.prepare('INSERT INTO codex_execution_sources VALUES(?,?,?,?,?,?,?,?,?,?)').run(snapshot.sourcePath, snapshot.nativeSessionId, turn.nativeTurnId, turn.rootTurnId, turn.parentTurnId ?? null, turn.startedAt ?? null, turn.completedAt ?? null, turn.status, JSON.stringify(turn.expectedChildren), JSON.stringify(turn.gaps));
                    for (const record of filterBindRecords(filterCodexSkills(turn.records))) {
                        const sourceId = JSON.stringify([record.originSessionId || snapshot.nativeSessionId, record.sourceId]);
                        if (!sourceId || !record.message) continue;
                        const normalized = isBindControl(record) ? record : normalizeTaskTrace('codex-cli', record);
                        if (!normalized?.message || !isBindControl(normalized) && !hasTaskContent(normalized.message)) continue;
                        if (Array.isArray((record.raw as Record<string, unknown>).bindCallIds)) normalized.raw = { ...(normalized.raw as Record<string, unknown>), bindCallIds: (record.raw as Record<string, unknown>).bindCallIds };
                        let meta = this.store.row('SELECT traceId FROM codex_event_meta WHERE sourceId=?', sourceId);
                        if (!meta) {
                            const inserted = this.store.db.prepare('INSERT INTO traces(sessionId,conversationId,sourceId,raw,message,createdAt) VALUES(NULL,NULL,?,?,?,?)').run(`codex:v2:${sourceId}`, JSON.stringify(normalized.raw), JSON.stringify(normalized.message), now());
                            meta = { traceId: Number(inserted.lastInsertRowid) };
                        } else if ((isBindControl(record) || hasTaskContent(record.message))
                            && (!(isBindControl(record) || Array.isArray((record.raw as Record<string, unknown>).bindCallIds)) || !this.bindingAuditFrozen(Number(meta.traceId)))) {
                            this.store.db.prepare('UPDATE traces SET raw=?,message=? WHERE id=?').run(JSON.stringify(normalized.raw), JSON.stringify(normalized.message), Number(meta.traceId));
                        }
                        this.store.db.prepare(`INSERT INTO codex_event_meta VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(sourceId) DO UPDATE SET originSessionId=excluded.originSessionId,nativeTurnId=excluded.nativeTurnId,rootTurnId=excluded.rootTurnId,occurredAt=excluded.occurredAt,sourceOrdinal=excluded.sourceOrdinal,agentPath=excluded.agentPath`).run(sourceId, Number(meta.traceId), record.originSessionId || snapshot.nativeSessionId, record.nativeTurnId ?? turn.nativeTurnId, turn.rootTurnId, record.occurredAt ?? null, record.sourceOrdinal, record.agentPath ?? snapshot.agentPath ?? null);
                        this.store.db.prepare('INSERT OR REPLACE INTO codex_event_sources(sourcePath,sourceId,messageHash) VALUES(?,?,?)').run(snapshot.sourcePath, sourceId, hash(record.message));
                    }
                }
            }
            this.reconcile(options.requireBinding);
            this.pruneEmptySessions();
            if (options.prepareUploads) this.prepareUploads(options.requireBinding);
            return { rounds: Number(this.store.row('SELECT count(*) AS n FROM codex_rounds')?.n ?? 0) };
        });
    }
    private bindingAuditFrozen(traceId: number): boolean {
        if (this.store.row('SELECT 1 FROM traces t JOIN batches b ON b.id=t.batchId WHERE t.id=? AND (b.attempts>0 OR b.uploaded=1)', traceId)) return true;
        return !!this.store.row("SELECT 1 FROM sqlite_master WHERE name='batch_traces'")
            && !!this.store.row('SELECT 1 FROM batch_traces bt JOIN batches b ON b.id=bt.batchId WHERE bt.traceId=? AND (b.attempts>0 OR b.uploaded=1)', traceId);
    }
    /** Remove only proven initialization-only sources, never unresolved or audit-bearing work. */
    pruneEmptySessions() {
        return this.transaction(() => {
            const tables = new Set(this.store.rows("SELECT name FROM sqlite_master WHERE type='table'").map(row => String(row.name)));
            let removed = 0;
            for (const source of this.metadata().values()) {
                if (source.sourceKind !== 'user' || source.gaps.length || source.parentNativeSessionId) continue;
                const nativeId = source.nativeSessionId;
                if (this.store.row('SELECT 1 FROM codex_execution_sources WHERE nativeSessionId=? LIMIT 1', nativeId)
                    || this.store.row('SELECT 1 FROM codex_event_meta WHERE originSessionId=? LIMIT 1', nativeId)
                    || this.store.row('SELECT 1 FROM codex_context_reservations WHERE nativeSessionId=? LIMIT 1', nativeId)
                    || this.store.row('SELECT 1 FROM codex_execution_map WHERE nativeSessionId=? LIMIT 1', nativeId)
                    || this.store.row('SELECT 1 FROM codex_source_meta WHERE parentNativeSessionId=? LIMIT 1', nativeId)
                    || this.store.row("SELECT 1 FROM sessions WHERE agentType='codex-cli' AND parentNativeSessionId=? LIMIT 1", nativeId)
                    || this.store.row('SELECT 1 FROM codex_event_sources e JOIN codex_source_meta s ON s.sourcePath=e.sourcePath WHERE s.nativeSessionId=? LIMIT 1', nativeId)) continue;
                if (tables.has('codex_receipts') && this.store.row("SELECT 1 FROM codex_receipts WHERE json_valid(event) AND json_extract(event,'$.nativeSessionId')=? AND COALESCE(json_extract(event,'$.nativeTurnId'),'')<>'' AND json_extract(event,'$.event')<>'session-start' LIMIT 1", nativeId)) continue;
                if (tables.has('codex_sources')) {
                    let unsafe = false;
                    for (const reader of this.store.rows('SELECT state,error FROM codex_sources WHERE nativeSessionId=? OR path IN(SELECT sourcePath FROM codex_source_meta WHERE nativeSessionId=?)', nativeId, nativeId)) {
                        if (reader.error) { unsafe = true; break; }
                        if (reader.state == null) continue;
                        try {
                            const state = JSON.parse(String(reader.state));
                            if (!state?.parser?.snapshot || state.parser.pending?.length || hasCodexActivity(state.parser.snapshot)) unsafe = true;
                        } catch { unsafe = true; }
                    }
                    if (unsafe) continue;
                }
                const session = this.store.row("SELECT * FROM sessions WHERE agentType='codex-cli' AND nativeSessionId=?", nativeId);
                if (session) {
                    const id = String(session.id), taskId = String(session.taskId);
                    if (session.currentTurnId || session.parentNativeSessionId || session.overview
                        || this.store.row('SELECT 1 FROM turns WHERE sessionId=? LIMIT 1', id)
                        || this.store.row('SELECT 1 FROM traces WHERE sessionId=? LIMIT 1', id)
                        || this.store.row('SELECT 1 FROM batches WHERE sessionId=? LIMIT 1', id)
                        || this.store.row('SELECT 1 FROM codex_rounds WHERE ownerSessionId=? LIMIT 1', id)
                        || this.store.row('SELECT 1 FROM codex_execution_map WHERE ownerSessionId=? LIMIT 1', id)
                        || this.store.row("SELECT 1 FROM recalls WHERE sessionId=? AND (kind<>'initial' OR conversationId IS NOT NULL OR query IS NOT NULL OR data IS NOT NULL AND data<>'null' OR COALESCE(content,'')<>'') LIMIT 1", id)
                        || this.store.row('SELECT 1 FROM bindings WHERE objectId IN(?,?) OR (objectId=? AND NOT EXISTS(SELECT 1 FROM projects WHERE id=?)) LIMIT 1', id, taskId, String(session.objectId), String(session.objectId))) continue;
                    this.store.db.prepare('DELETE FROM recalls WHERE sessionId=?').run(id);
                    this.store.db.prepare('DELETE FROM sessions WHERE id=?').run(id);
                    this.store.db.prepare('DELETE FROM tasks WHERE id=? AND NOT EXISTS(SELECT 1 FROM sessions WHERE taskId=?) AND NOT EXISTS(SELECT 1 FROM bindings WHERE objectId=?) AND NOT EXISTS(SELECT 1 FROM batches WHERE objectId=?)').run(taskId, taskId, taskId, taskId);
                    removed++;
                }
                if (tables.has('codex_sources')) this.store.db.prepare('DELETE FROM codex_sources WHERE nativeSessionId=? OR path IN(SELECT sourcePath FROM codex_source_meta WHERE nativeSessionId=?)').run(nativeId, nativeId);
                if (tables.has('codex_receipts')) this.store.db.prepare("DELETE FROM codex_receipts WHERE json_valid(event) AND json_extract(event,'$.nativeSessionId')=?").run(nativeId);
                this.store.db.prepare('DELETE FROM codex_source_meta WHERE nativeSessionId=?').run(nativeId);
            }
            return removed;
        });
    }
    private reconcile(requireBinding = false) {
        const metadata = this.metadata(), executions = this.executions();
        const local = new Map<string, Session>();
        const frozen = new Set(this.store.rows("SELECT * FROM sessions WHERE agentType='codex-cli'").filter(row => {
            const scope = this.store.memory.get(String(row.objectId)); return scope ? !scope.spaceIds.length : requireBinding;
        }).map(row => String(row.id)));
        const frozenIds = [...frozen], placeholders = frozenIds.map(() => '?').join(',') || "''";
        // Establish main identities first. Child execution directories never change root project routing.
        for (const source of metadata.values()) if (source.sourceKind === 'user' && isAbsolute(source.cwd)) {
            const cwd = resolve(source.cwd);
            let session = this.store.row("SELECT * FROM sessions WHERE agentType='codex-cli' AND nativeSessionId=?", source.nativeSessionId) as unknown as Session | undefined;
            if (requireBinding && !session && !this.store.memory.resolve('codex-cli', cwd)) continue;
            if (!session && !source.gaps.length && !executions.some(execution => execution.nativeSessionId === source.nativeSessionId)
                && !this.store.row('SELECT 1 FROM codex_event_meta WHERE originSessionId=? LIMIT 1', source.nativeSessionId)
                && !this.store.row('SELECT 1 FROM codex_context_reservations WHERE nativeSessionId=? LIMIT 1', source.nativeSessionId)) continue;
            if (session && frozen.has(session.id)) { local.set(source.nativeSessionId, session); continue; }
            const task = session && this.store.row('SELECT t.projectId,p.root FROM tasks t LEFT JOIN projects p ON p.id=t.projectId WHERE t.id=?', session.taskId);
            const conflict = source.gaps.includes('source_directory_conflict') ? '多个原始轨迹的目录不一致'
                : task?.projectId && !(cwd + sep).startsWith(join(resolve(String(task.root)), sep)) ? '原始目录与已登记项目不一致' : undefined;
            if (conflict) {
                const message = `Codex 会话目录冲突，保留原归属: ${source.nativeSessionId} (${conflict})`;
                if (!this.store.row('SELECT id FROM diagnostics WHERE message=?', message)) this.store.diagnostic(message);
                if (!source.gaps.includes('source_directory_conflict')) source.gaps.push('project_directory_conflict');
            } else {
                session ??= this.store.registerSession({ agentType: 'codex-cli', nativeSessionId: source.nativeSessionId, cwd });
                if (!source.gaps.length && session.cwd !== cwd) {
                    // Correct local identity only; tasks, spaces and upload scopes retain their IDs.
                    this.store.db.prepare('UPDATE sessions SET cwd=? WHERE id=?').run(cwd, session.id);
                    this.store.db.prepare('UPDATE tasks SET name=? WHERE id=? AND projectId IS NULL').run(basename(cwd) || '独立任务', session.taskId);
                    session = this.store.session(session.id)!;
                }
            }
            if (session) local.set(source.nativeSessionId, session);
        }
        const owner = (nativeSessionId: string, rootTurnId: string): Session | undefined => {
            let current: string | undefined = nativeSessionId;
            const visited = new Set<string>();
            while (current && !visited.has(current)) {
                visited.add(current);
                const source = metadata.get(current);
                if (source?.sourceKind === 'user') return local.get(current);
                if (!source) break;
                if (source.sourceKind !== 'subagent') return undefined;
                current = source.parentNativeSessionId;
            }
            // Some child metadata only has an explicit root turn; resolve it only when unique.
            const candidates = executions.filter(execution => execution.nativeTurnId === rootTurnId && metadata.get(execution.nativeSessionId)?.sourceKind === 'user');
            return candidates.length === 1 ? local.get(candidates[0]!.nativeSessionId) : undefined;
        };
        const userRoots = new Set(executions.filter(execution => metadata.get(execution.nativeSessionId)?.sourceKind === 'user' && (execution.gaps.includes('binding_boundary') || this.store.row(`SELECT m.sourceId FROM codex_event_meta m JOIN traces t ON t.id=m.traceId WHERE m.originSessionId=? AND m.nativeTurnId=? AND json_extract(t.message,'$.role')='user' AND EXISTS(SELECT 1 FROM codex_event_sources es WHERE es.sourceId=m.sourceId) LIMIT 1`, execution.nativeSessionId, execution.nativeTurnId))).map(execution => executionKey(execution.nativeSessionId, execution.rootTurnId)));
        const groups = new Map<string, Execution[]>();
        this.store.db.prepare(`DELETE FROM codex_execution_map WHERE ownerSessionId NOT IN (${placeholders})`).run(...frozenIds);
        for (const execution of executions) {
            const rootOwner = owner(execution.nativeSessionId, execution.rootTurnId);
            if (!rootOwner || frozen.has(rootOwner.id) || !userRoots.has(executionKey(rootOwner.nativeSessionId, execution.rootTurnId))) continue;
            const source = metadata.get(execution.nativeSessionId)!;
            if (source.sourceKind === 'subagent' && !local.has(execution.nativeSessionId)) {
                const child = this.store.registerSession({ agentType: 'codex-cli', nativeSessionId: source.nativeSessionId, cwd: rootOwner.cwd, parentNativeSessionId: source.parentNativeSessionId });
                const parentTask = this.store.row('SELECT projectId FROM tasks WHERE id=?', rootOwner.taskId);
                this.store.db.prepare('UPDATE tasks SET projectId=?,objectId=? WHERE id=?').run(parentTask?.projectId == null ? null : String(parentTask.projectId), rootOwner.objectId, child.taskId);
                this.store.db.prepare('UPDATE sessions SET objectId=?,parentNativeSessionId=? WHERE id=?').run(rootOwner.objectId, source.parentNativeSessionId ?? null, child.id);
                local.set(execution.nativeSessionId, this.store.session(child.id)!);
            }
            const turn = this.store.startTurn(rootOwner.id, execution.rootTurnId, false);
            execution.ownerSessionId = rootOwner.id; execution.conversationId = turn.id; execution.agentPath = source.agentPath;
            this.store.db.prepare('INSERT INTO codex_execution_map VALUES(?,?,?,?,?,?)').run(execution.nativeSessionId, execution.nativeTurnId, turn.id, rootOwner.id, execution.status, execution.startedAt ?? null);
            const group = groups.get(turn.id) ?? []; group.push(execution); groups.set(turn.id, group);
        }
        this.store.db.prepare(`UPDATE codex_rounds SET captureStatus='incomplete',gaps='["source_replaced_or_unresolved"]' WHERE ownerSessionId NOT IN (${placeholders}) AND conversationId NOT IN(SELECT conversationId FROM codex_execution_map)`).run(...frozenIds);
        this.store.db.prepare(`UPDATE traces SET sessionId=NULL,conversationId=NULL WHERE (sessionId IS NULL OR sessionId NOT IN (${placeholders})) AND id IN (SELECT traceId FROM codex_event_meta)`).run(...frozenIds);
        for (const [conversationId, group] of groups) {
            const ownerSessionId = group[0]!.ownerSessionId!;
            for (const execution of group) this.store.db.prepare(`UPDATE traces SET sessionId=?,conversationId=? WHERE id IN (SELECT m.traceId FROM codex_event_meta m WHERE m.originSessionId=? AND m.nativeTurnId=? AND EXISTS(SELECT 1 FROM codex_event_sources s WHERE s.sourceId=m.sourceId))`).run(ownerSessionId, conversationId, execution.nativeSessionId, execution.nativeTurnId);
            const rootSession = this.store.session(ownerSessionId)!;
            const rootExecutions = group.filter(execution => execution.nativeSessionId === rootSession.nativeSessionId);
            // Never synthesize a parent user task from a child-only transcript.
            const records = this.roundRecords(conversationId), hasUser = records.some(row => row.originSessionId === rootSession.nativeSessionId && (row.message as { role?: string }).role === 'user');
            const root = rootExecutions.find(execution => execution.nativeTurnId === execution.rootTurnId) ?? rootExecutions[0];
            const startedAt = minimum([root?.startedAt, ...records.filter(row => row.originSessionId === rootSession.nativeSessionId && (row.message as { role?: string }).role === 'user').map(row => row.occurredAt as string)]);
            const completedAt = maximum(group.map(execution => execution.completedAt));
            const gaps = new Set<string>();
            for (const execution of group) {
                for (const gap of execution.gaps) if (gap !== 'binding_boundary') gaps.add(gap);
                for (const gap of metadata.get(execution.nativeSessionId)?.gaps ?? []) gaps.add(gap);
            }
            if (!root || (!hasUser && !root.gaps.includes('binding_boundary'))) gaps.add('root_user_input_missing');
            for (const row of records) if (Number(this.store.row('SELECT count(DISTINCT messageHash) AS n FROM codex_event_sources WHERE sourceId=?', String(row.sourceId))?.n ?? 0) > 1) gaps.add('source_content_conflict');
            const missing: string[] = [];
            for (const execution of group) for (const expected of execution.expectedChildren) {
                if (expected.status === 'failed') continue;
                const candidates = group.filter(child => child.nativeSessionId !== execution.nativeSessionId && ((expected.agentId && child.nativeSessionId === expected.agentId) || (expected.agentPath && child.agentPath === expected.agentPath)));
                const call = this.callRecord(records, execution, expected.callId);
                const dispatchedAt = (expected as CodexExpectedChild & { occurredAt?: string }).occurredAt ?? call?.occurredAt as string | undefined;
                const covered = candidates.filter(child => expected.kind !== 'followup' || !dispatchedAt || !child.completedAt || child.completedAt >= dispatchedAt);
                if (!covered.length) missing.push(expected.callId);

            }
            const ordered = orderTraceRecords(records, this.dependencyEdges(records, group));
            if (ordered.cyclic) gaps.add('source_order_conflict');
            const rootRunning = rootExecutions.some(execution => !terminal(execution.status));
            const childrenRunning = group.some(execution => execution.nativeSessionId !== rootSession.nativeSessionId && !terminal(execution.status));
            const captureStatus = gaps.size ? 'incomplete' : missing.length || childrenRunning ? 'awaiting_children' : rootRunning ? 'collecting' : 'complete';
            const executionStatus = rootRunning ? 'running' : rootExecutions.some(execution => execution.status === 'failed') ? 'failed' : rootExecutions.some(execution => execution.status === 'interrupted') ? 'interrupted' : rootExecutions.some(execution => execution.status === 'cancelled') ? 'cancelled' : 'completed';
            const fingerprint = hash(ordered.records.map(row => [row.sourceId, row.message, row.occurredAt, row.originSessionId, row.nativeTurnId]));
            const prior = this.store.row('SELECT * FROM codex_rounds WHERE conversationId=?', conversationId);
            this.store.db.prepare(`INSERT INTO codex_rounds(conversationId,ownerSessionId,rootTurnId,startedAt,completedAt,executionStatus,captureStatus,eventSetHash,version,gaps) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(conversationId) DO UPDATE SET startedAt=excluded.startedAt,completedAt=excluded.completedAt,executionStatus=excluded.executionStatus,captureStatus=excluded.captureStatus,eventSetHash=excluded.eventSetHash,version=excluded.version,gaps=excluded.gaps`).run(conversationId, ownerSessionId, group[0]!.rootTurnId, startedAt ?? null, completedAt ?? null, executionStatus, captureStatus, fingerprint, prior ? Number(prior.version) + Number(prior.eventSetHash !== fingerprint) : 1, JSON.stringify([...gaps, ...missing.map(id => `missing_child:${id}`)]));
            this.store.db.prepare('UPDATE turns SET createdAt=COALESCE(?,createdAt),completedAt=? WHERE id=?').run(startedAt ?? null, captureStatus === 'complete' ? completedAt ?? now() : null, conversationId);
        }
        this.store.db.prepare(`DELETE FROM codex_context_reservations WHERE EXISTS(SELECT 1 FROM codex_execution_map m WHERE m.nativeSessionId=codex_context_reservations.nativeSessionId AND m.nativeTurnId=codex_context_reservations.nativeTurnId AND m.ownerSessionId NOT IN (${placeholders}))`).run(...frozenIds);
        // The source parser, not a historical hook arrival, selects the most recent active context.
        for (const [nativeId, session] of local) {
            if (frozen.has(session.id)) continue;
            const latest = executions.filter(execution => execution.nativeSessionId === nativeId && execution.conversationId).sort((a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? ''))).at(-1);
            const reservation = this.store.row('SELECT conversationId FROM codex_context_reservations WHERE nativeSessionId=? ORDER BY createdAt DESC,rowid DESC LIMIT 1', nativeId);
            if (reservation || latest) this.store.db.prepare('UPDATE sessions SET currentTurnId=? WHERE id=?').run(reservation ? String(reservation.conversationId) : latest!.conversationId!, session.id);
        }
        this.store.db.prepare(`UPDATE batches SET status='blocked',error='旧版 Codex 轨迹需原始记录回放修复' WHERE uploaded=0 AND status='pending' AND sessionId IN(SELECT id FROM sessions WHERE agentType='codex-cli') AND sessionId NOT IN (${placeholders}) AND NOT EXISTS(SELECT 1 FROM codex_rounds r WHERE r.conversationId=batches.conversationId)`).run(...frozenIds);
    }
    private callRecord(records: Row[], execution: Execution, callId: string) {
        return records.find(row => row.originSessionId === execution.nativeSessionId && row.nativeTurnId === execution.nativeTurnId && ((row.message as { tool_calls?: { id?: string }[] }).tool_calls ?? []).some(call => call.id === callId));
    }
    roundRecords(conversationId: string): Row[] {
        return this.store.rows(`SELECT t.*,m.sourceId AS canonicalSourceId,m.originSessionId,m.nativeTurnId,m.rootTurnId,m.occurredAt,m.sourceOrdinal,m.agentPath FROM traces t JOIN codex_event_meta m ON m.traceId=t.id WHERE t.conversationId=? AND EXISTS(SELECT 1 FROM codex_event_sources s WHERE s.sourceId=m.sourceId)`, conversationId).map(row => ({ ...row, sourceId: row.canonicalSourceId, raw: JSON.parse(String(row.raw)), message: JSON.parse(String(row.message)) }));
    }
    private dependencyEdges(records: Row[], executions: Execution[]): [string, string][] {
        const edges: [string, string][] = [];
        for (const execution of executions) for (const expected of execution.expectedChildren) {
            if (expected.status === 'failed') continue;
            const call = this.callRecord(records, execution, expected.callId);
            if (!call) continue;
            const dispatchedAt = (expected as CodexExpectedChild & { occurredAt?: string }).occurredAt ?? call.occurredAt as string | undefined;
            const candidates = records.filter(row => (expected.agentId ? row.originSessionId === expected.agentId : expected.agentPath && row.agentPath === expected.agentPath)
                && (expected.kind !== 'followup' || (dispatchedAt && typeof row.occurredAt === 'string' && row.occurredAt >= dispatchedAt)));
            const first = orderTraceRecords(candidates).records[0];
            if (first) edges.push([String(call.sourceId), String(first.sourceId)]);
        }
        return edges;
    }
    orderedRoundRecords(conversationId: string): Row[] {
        const records = this.roundRecords(conversationId);
        return orderTraceRecords(records, this.dependencyEdges(records, this.executions())).records;
    }
    prepareUploads(requireBinding = false) {
        this.transaction(() => {
            const batches = new Map(this.store.batches().map(batch => [batch.conversationId, batch]));
            for (const round of this.store.rows('SELECT * FROM codex_rounds ORDER BY startedAt,ownerSessionId,conversationId')) {
                const owner = this.store.session(String(round.ownerSessionId));
                const scope = owner && this.store.memory.get(owner.objectId);
                if (scope ? !scope.spaceIds.length : requireBinding) continue;
                const id = String(round.conversationId), existing = batches.get(id);
                if (this.store.creation?.turnExcluded(String(round.ownerSessionId), id)) continue;
                if (existing?.attempts || existing?.uploaded) {
                    if (!round.snapshotHash) {
                        const messages = filterUploadTraces(this.orderedRoundRecords(id)).map(row => row.message);
                        const originalHash = JSON.stringify(existing.messages) === JSON.stringify(messages) ? String(round.eventSetHash) : `legacy:${hash(existing.messages)}`;
                        this.store.db.prepare('UPDATE codex_rounds SET snapshotHash=? WHERE conversationId=?').run(originalHash, id);
                    }
                    continue;
                }
                if (round.captureStatus !== 'complete') {
                    if (existing) this.store.updateBatch(existing.id, { status: 'blocked', error: 'Codex 整轮轨迹尚未收齐' });
                    continue;
                }
                if (existing && round.snapshotHash === round.eventSetHash && (['pending', 'manual', 'cancelled'].includes(existing.status) || existing.error === '整轮轨迹超出保守上传容量；完整内容已保留')) continue;
                const messages = filterUploadTraces(this.orderedRoundRecords(id)).map(row => row.message), payload = JSON.stringify(messages);
                if (!messages.length) continue;
                const oversized = Buffer.byteLength(payload, 'utf8') > this.store.uploadMaxBytes;
                const error = uploadValidationError(messages as import('../adapters/types.ts').Message[]) ?? (messages.some(message => hasIncompleteSkill(message as import('../adapters/types.ts').Message)) ? 'Skill 与业务输出无法可靠拆分；正文未采集，轨迹不完整' : oversized ? '整轮轨迹超出保守上传容量；完整内容已保留' : null);
                const status = error ? 'blocked' : 'pending';
                const batchId = existing?.id ?? randomUUID(), session = this.store.session(String(round.ownerSessionId))!;
                if (existing) this.store.db.prepare('UPDATE batches SET messages=?,status=?,error=? WHERE id=? AND attempts=0 AND uploaded=0').run(payload, status, error, batchId);
                else this.store.db.prepare('INSERT INTO batches(id,sessionId,objectId,conversationId,messages,status,error,createdAt) VALUES(?,?,?,?,?,?,?,?)').run(batchId, session.id, session.objectId, id, payload, status, error, typeof round.startedAt === 'string' ? round.startedAt : now());
                this.store.db.prepare('UPDATE traces SET batchId=? WHERE conversationId=? AND id IN (SELECT traceId FROM codex_event_meta)').run(batchId, id);
                this.store.db.prepare('UPDATE codex_rounds SET snapshotHash=? WHERE conversationId=?').run(String(round.eventSetHash), id);
            }
        });
    }
    reserveContext(nativeSessionId: string, nativeTurnId: string, rootTurnId = nativeTurnId, source?: CodexSnapshot) {
        if (!nativeTurnId || !rootTurnId) return undefined;
        const metadata = this.metadata().get(nativeSessionId) ?? (source?.nativeSessionId === nativeSessionId ? source : undefined);
        if (metadata?.sourceKind !== 'user' || !isAbsolute(metadata.cwd)) return undefined;
        return this.transaction(() => {
            const known = this.context(nativeSessionId, nativeTurnId);
            if (known) return known;
            // A real prompt may arrive before its rollout turn. Reserve that task
            // explicitly; initialization-only source discovery never registers it.
            const session = this.store.registerSession({ agentType: 'codex-cli', nativeSessionId, cwd: metadata.cwd });
            const turn = this.store.startTurn(session.id, rootTurnId, false);
            this.store.db.prepare('DELETE FROM codex_context_reservations WHERE nativeSessionId=?').run(nativeSessionId);
            this.store.db.prepare('INSERT INTO codex_context_reservations VALUES(?,?,?,?,?)').run(nativeSessionId, nativeTurnId, rootTurnId, turn.id, now());
            this.store.db.prepare('UPDATE sessions SET currentTurnId=? WHERE id=?').run(turn.id, session.id);
            return { sessionId: session.id, conversationId: turn.id };
        });
    }
    context(nativeSessionId: string, nativeTurnId?: string) {
        const session = this.store.row("SELECT id,currentTurnId FROM sessions WHERE agentType='codex-cli' AND nativeSessionId=?", nativeSessionId);
        if (!session) return undefined;
        const mapped = nativeTurnId ? this.store.row('SELECT conversationId FROM codex_execution_map WHERE nativeSessionId=? AND nativeTurnId=? UNION ALL SELECT conversationId FROM codex_context_reservations WHERE nativeSessionId=? AND nativeTurnId=? LIMIT 1', nativeSessionId, nativeTurnId, nativeSessionId, nativeTurnId) : undefined;
        const conversationId = mapped?.conversationId ?? (!nativeTurnId ? session.currentTurnId : undefined);
        return conversationId ? { sessionId: String(session.id), conversationId: String(conversationId) } : undefined;
    }
    validContext(session: Session, conversationId: string): boolean {
        if (session.currentTurnId === conversationId) return true;
        if (this.store.row('SELECT conversationId FROM codex_context_reservations WHERE nativeSessionId=? AND conversationId=?', session.nativeSessionId, conversationId)) return true;
        return !!this.store.row("SELECT conversationId FROM codex_execution_map WHERE nativeSessionId=? AND conversationId=? AND status='running'", session.nativeSessionId, conversationId);
    }
    hasSession(id: string) { return !!this.store.row("SELECT m.nativeSessionId FROM codex_source_meta m JOIN sessions s ON s.nativeSessionId=m.nativeSessionId AND s.agentType='codex-cli' WHERE s.id=? LIMIT 1", id); }
    decorateSessions(sessions: Row[]): Row[] {
        const meta = this.metadata();
        return sessions.filter(session => session.agentType !== 'codex-cli' || meta.get(String(session.nativeSessionId))?.sourceKind === 'user').map(session => {
            const projectId = this.store.row('SELECT projectId FROM tasks WHERE id=?', String(session.taskId))?.projectId ?? null;
            const source = meta.get(String(session.nativeSessionId));
            if (session.agentType !== 'codex-cli' || !source) return { ...session, projectId };
            const rounds = this.rounds(String(session.id));
            return { ...session, projectId, sourceKind: source.sourceKind, sourceStartedAt: minimum([source.startedAt, ...rounds.map(round => round.startedAt as string)]), lastOccurredAt: maximum(rounds.flatMap(round => [round.completedAt as string, round.startedAt as string])), turnCount: rounds.length };
        });
    }
    rounds(sessionId: string): Row[] {
        return this.store.rows(`SELECT r.* FROM codex_rounds r WHERE ownerSessionId=? AND EXISTS(SELECT 1 FROM traces t JOIN codex_event_meta m ON m.traceId=t.id JOIN codex_event_sources es ON es.sourceId=m.sourceId WHERE t.conversationId=r.conversationId) ORDER BY r.startedAt,(SELECT MIN(m.sourceOrdinal) FROM traces t JOIN codex_event_meta m ON m.traceId=t.id JOIN sessions s ON s.id=r.ownerSessionId WHERE t.conversationId=r.conversationId AND m.originSessionId=s.nativeSessionId AND json_extract(t.message,'$.role')='user'),r.rootTurnId`, sessionId);
    }
    detail(id: string, page: number, size: number, unit: 'trace' | 'turn') {
        const all = this.rounds(id), selected = unit === 'turn' ? all.slice((page - 1) * size, page * size) : all;
        const groups = selected.map(round => ({ ...round, captureStatus: String(round.captureStatus), executionStatus: String(round.executionStatus), id: String(round.conversationId), roundNumber: all.findIndex(item => item.conversationId === round.conversationId) + 1, gaps: JSON.parse(String(round.gaps)), uploadOutOfDate: !!round.snapshotHash && round.snapshotHash !== round.eventSetHash, traces: this.orderedRoundRecords(String(round.conversationId)).filter(row => !isBindControl({ sourceId: String(row.sourceId), raw: row.raw, message: row.message as Message })) }));
        const completeTraces = groups.flatMap(group => group.traces);
        const traces = unit === 'turn' ? completeTraces : completeTraces.slice((page - 1) * size, page * size);
        const session = this.decorateSessions([this.store.session(id)! as unknown as Row])[0] ?? this.store.session(id);
        return { session, turns: all, traces, groups: unit === 'turn' ? groups : undefined, recalls: this.store.rows('SELECT * FROM recalls WHERE sessionId=? ORDER BY createdAt', id).map(row => ({ ...row, data: JSON.parse(String(row.data)) })), batches: this.store.batches().filter(batch => batch.sessionId === id), total: unit === 'turn' ? all.length : completeTraces.length, page, size };
    }
}
