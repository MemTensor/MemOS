import { filterBindRecords, isBindControl } from '../adapters/_shared/bind-records.ts';
import { hasTaskContent } from '../adapters/_shared/message-content.ts';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createZstdDecompress, zstdDecompressSync } from 'node:zlib';
import { object, readTranscript, textField } from '../adapters/_shared/transcript.ts';
import { normalizeTaskTrace } from '../adapters/_shared/task-trace.ts';
import { filterAdapterSkills } from '../adapters/skill-filters.ts';
import { stripImages } from '../adapters/_shared/image-content.ts';
import { readCodexRollout } from '../adapters/codex-cli/rollout.ts';
import type { CodexSnapshot } from '../adapters/codex-cli/types.ts';
import type { TraceInput } from '../adapters/types.ts';
import type { Store } from '../storage/store.ts';
import type { MemoryScope } from '../storage/memory-scopes.ts';
import { sourceFiles, sourceHeader, type CodexCaptureOptions } from './codex-capture.ts';
import { workbuddyConfigDir } from '../adapters/workbuddy/paths.ts';
import { primeSources, readPrimeSession } from '../adapters/prime-agent/sessions.ts';
import { primeIdle, primeStatus } from '../adapters/prime-agent/capture.ts';

type Candidate = { nativeSessionId: string; sourceId: string };
type Source = { path: string; nativeSessionId: string; cwd: string; startedAt?: string; parentNativeSessionId?: string };
type Scan = { status: 'pending' | 'scanning' | 'ready' | 'failed'; recordCount: number; error?: string; warning?: string; cutoff?: string; signature?: string; sources: Source[]; records: Candidate[] };
type HistoricalTurn = { key: string; records: TraceInput[]; completedAt: string };

/** Scanning retains only source identities and record IDs; content enters SQLite only on explicit import. */
export class HistoryService {
    private closed = false;
    close() { this.closed = true; }
    private scans = new Map<string, Scan>();
    private running = new Map<string, Promise<void>>();
    private store: Store;
    private options: CodexCaptureOptions & { home?: string };
    constructor(store: Store, options: CodexCaptureOptions & { home?: string } = {}) { this.store = store; this.options = options; }
    status(scopeId: string) {
        const { sources: _sources, records: _records, ...status } = this.scans.get(scopeId) ?? { status: 'pending' as const, recordCount: 0, sources: [], records: [] };
        return status;
    }
    catalog(scopeId: string): Candidate[] { return this.scans.get(scopeId)?.records ?? []; }
    refresh(scopeId: string): Promise<void> {
        if (this.closed) return Promise.resolve();
        const scope = this.store.memory.get(scopeId);
        if (!scope?.spaceIds.length) return Promise.resolve();
        const scan = this.scans.get(scopeId), signature = this.signature(scopeId);
        if (scan && (scan.status !== 'ready' || scan.signature === signature)) return Promise.resolve();
        const current: Scan = scan ?? { status: 'ready', recordCount: 0, sources: [], records: [],
            warning: '仅包含插件已采集会话，可手动扫描本地历史' };
        this.mergeLocalRecords(scopeId, current);
        current.signature = signature;
        this.scans.set(scopeId, current);
        return Promise.resolve();
    }
    private mergeLocalRecords(scopeId: string, scan: Scan) {
        const local = this.store.rows(`SELECT s.nativeSessionId,t.sourceId FROM traces t JOIN sessions s ON s.id=t.sessionId JOIN turns u ON u.id=t.conversationId
WHERE s.objectId=? AND COALESCE(json_extract(t.raw,'$.type'),'')<>'memos-bind-operation' AND u.completedAt IS NOT NULL AND NOT EXISTS(SELECT 1 FROM codex_rounds r WHERE r.conversationId=u.id AND r.captureStatus!='complete')`, scopeId)
            .map(row => ({ nativeSessionId: String(row.nativeSessionId), sourceId: String(row.sourceId) }));
        scan.records = [...new Map([...scan.records, ...local].map(record => [record.sourceId.startsWith('codex:v2:') ? record.sourceId : JSON.stringify(record), record])).values()];
        scan.recordCount = scan.records.length;
    }
    private signature(scopeId: string) {
        return JSON.stringify(this.store.row(`SELECT count(DISTINCT u.id) n,max(u.completedAt) completed,max(t.id) trace
FROM sessions s JOIN turns u ON u.sessionId=s.id LEFT JOIN traces t ON t.conversationId=u.id WHERE s.objectId=? AND u.completedAt IS NOT NULL`, scopeId));
    }
    scan(scopeId: string): Promise<void> {
        const running = this.running.get(scopeId);
        if (running) return running;
        const work = this.scanSources(scopeId).finally(() => this.running.delete(scopeId));
        this.running.set(scopeId, work);
        return work;
    }
    private active(scopeId: string, expected?: MemoryScope): MemoryScope {
        if (this.closed) throw new Error('历史扫描已停止');
        const scope = this.store.memory.get(scopeId);
        if (!scope?.spaceIds.length) throw new Error('项目尚未绑定 Space');
        if (expected && (scope.enabledAt !== expected.enabledAt || scope.root !== expected.root)) throw new Error('项目绑定已变化，请重新扫描历史');
        return scope;
    }
    private async scanSources(scopeId: string) {
        const scan: Scan = { status: 'scanning', recordCount: 0, cutoff: new Date().toISOString(), signature: this.signature(scopeId), sources: [], records: [] };
        this.scans.set(scopeId, scan);
        try {
            const scope = this.active(scopeId);
            const supported = ['codex-cli', 'claude-code', 'deepseek-harness', 'pi', 'prime-agent', 'opencode-v1', 'opencode-v2', 'kimi-code', 'workbuddy'].includes(scope.agentType);
            scan.sources = supported ? await this.sources(scope) : [];
            if (!supported) scan.warning = '仅包含插件已采集会话，该 Agent 未提供本地历史读取接口';
            else if (!scan.sources.length) scan.warning = '未发现可读取的本地历史文件，仅包含插件已采集会话';
            if (scope.agentType === 'codex-cli') {
                const snapshots = await this.codex(scan, scope);
                scan.records = snapshots.flatMap(snapshot => snapshot.turns.flatMap(turn => turn.records.filter(record => hasTaskContent(stripImages(record.message))).map(record => ({ nativeSessionId: record.originSessionId || snapshot.nativeSessionId, sourceId: `codex:v2:${JSON.stringify([record.originSessionId || snapshot.nativeSessionId, record.sourceId])}` }))));
            } else {
                for (const source of scan.sources) {
                    const turns = await this.turns(scope, source, scan.cutoff!);
                    source.startedAt = turns.flatMap(turn => turn.records.map(record => this.store.memory.recordTime(record.raw))).filter((time): time is string => !!time).sort()[0];
                    for (const turn of turns) scan.records.push(...turn.records.filter(record => record.message && hasTaskContent(stripImages(record.message))).map(record => ({ nativeSessionId: source.nativeSessionId, sourceId: record.sourceId })));
                }
            }
            await this.validateSources(scope, scan.sources);
            this.mergeLocalRecords(scopeId, scan);
            scan.signature = this.signature(scopeId);
            scan.status = 'ready';
        } catch (error) { scan.status = 'failed'; scan.error = error instanceof Error ? error.message : String(error); }
    }
    async materialize(scopeId: string, sessions?: Set<string>): Promise<Candidate[]> {
        const scope = this.active(scopeId), scan = this.scans.get(scopeId);
        if (scan?.status !== 'ready') throw new Error('历史会话尚未扫描完成');
        await this.validateSources(scope, scan.sources);
        const selected = sessions ? { ...scan, sources: scan.sources.filter(source => sessions.has(source.nativeSessionId)) } : scan;
        const allowed = new Set(scan.records.map(record => JSON.stringify(record)));
        if (scope.agentType === 'codex-cli') {
            const snapshots = await this.codex(selected, scope);
            for (const snapshot of snapshots) {
                snapshot.sourcePath = `history:${snapshot.sourcePath}`;
                for (const turn of snapshot.turns) turn.records = turn.records.filter(record => isBindControl(record) || allowed.has(JSON.stringify({ nativeSessionId: record.originSessionId || snapshot.nativeSessionId, sourceId: `codex:v2:${JSON.stringify([record.originSessionId || snapshot.nativeSessionId, record.sourceId])}` })));
                snapshot.turns = snapshot.turns.filter(turn => turn.records.some(record => !isBindControl(record)));
            }
            await this.validateSources(scope, scan.sources);
            this.store.applyCodexSnapshots(snapshots, { prepareUploads: false, requireBinding: true });
        } else {
            for (const source of selected.sources) {
                const turns = (await this.turns(scope, source, scan.cutoff!)).filter(turn => turn.records.some(record => allowed.has(JSON.stringify({ nativeSessionId: source.nativeSessionId, sourceId: record.sourceId }))));
                this.active(scopeId, scope);
                if (this.store.memory.resolve(scope.agentType, source.cwd)?.id !== scopeId) throw new Error('历史会话项目归属已变化，请重新扫描');
                if (!turns.length) continue;
                const session = this.store.registerSession({ agentType: scope.agentType, nativeSessionId: source.nativeSessionId, cwd: source.cwd });
                for (const item of turns) {
                    const existing = item.records.map(record => this.store.row('SELECT id,conversationId FROM traces WHERE sessionId=? AND sourceId=?', session.id, record.sourceId));
                    if (existing.every(Boolean) && scope.agentType !== 'workbuddy') continue;
                    const conversations = new Set(existing.flatMap(record => record?.conversationId ? [String(record.conversationId)] : []));
                    const knownTurn = conversations.size === 1 ? this.store.row('SELECT id FROM turns WHERE id=?', [...conversations][0]!) : undefined;
                    const turn = knownTurn ?? this.store.startTurn(session.id, item.key, false);
                    for (const input of item.records) {
                        if (!isBindControl(input) && !allowed.has(JSON.stringify({ nativeSessionId: source.nativeSessionId, sourceId: input.sourceId }))) continue;
                        const record = isBindControl(input) ? input : stripImages(normalizeTaskTrace(scope.agentType, input));
                        if (!record?.message || !isBindControl(record) && !hasTaskContent(record.message)) continue;
                        if (Array.isArray(object(input.raw).bindCallIds)) record.raw = { ...object(record.raw), bindCallIds: object(input.raw).bindCallIds };
                        if (scope.agentType === 'workbuddy' && this.store.mergeWorkBuddyTrace(session, record)) continue;
                        this.store.db.prepare('INSERT OR IGNORE INTO traces(sessionId,conversationId,sourceId,raw,message,createdAt) VALUES(?,?,?,?,?,?)')
                            .run(session.id, String(turn.id), record.sourceId, JSON.stringify(record.raw), JSON.stringify(record.message), this.store.memory.recordTime(record.raw) ?? item.completedAt);
                    }
                    this.store.db.prepare('UPDATE turns SET completedAt=COALESCE(completedAt,?) WHERE id=?').run(item.completedAt, String(turn.id));
                }
                if (scope.agentType === 'workbuddy') this.store.refreshUnsentBatches(session.id);
            }
        }
        return scan.records.filter(record => !sessions || sessions.has(record.nativeSessionId));
    }
    async *materializeSessions(scopeId: string) {
        const scan = this.scans.get(scopeId);
        if (scan?.status !== 'ready') throw new Error('历史会话尚未扫描完成');
        const sources = new Map(scan.sources.map(source => [source.nativeSessionId, source]));
        const groups = new Map<string, Set<string>>();
        for (const id of new Set([...scan.records.map(record => record.nativeSessionId), ...sources.keys()])) {
            let root = id;
            const seen = new Set<string>();
            while (sources.get(root)?.parentNativeSessionId && !seen.has(root)) { seen.add(root); root = sources.get(root)!.parentNativeSessionId!; }
            const group = groups.get(root) ?? new Set<string>(); group.add(id); groups.set(root, group);
        }
        const times = new Map<string, string>();
        for (const [root, ids] of groups) {
            const values = [...ids].flatMap(id => {
                const source = sources.get(id);
                const local = this.store.rows('SELECT t.raw FROM traces t JOIN sessions s ON s.id=t.sessionId WHERE s.nativeSessionId=? AND s.objectId=?', id, scopeId);
                return [source?.startedAt, ...local.map(row => this.store.memory.recordTime(JSON.parse(String(row.raw))))].filter((time): time is string => !!time);
            });
            times.set(root, values.sort()[0] ?? '');
        }
        for (const [root, ids] of [...groups].sort(([a], [b]) => times.get(a)!.localeCompare(times.get(b)!) || a.localeCompare(b))) {
            this.active(scopeId);
            yield await this.materialize(scopeId, ids);
        }
    }
    private async validateSources(scope: MemoryScope, sources: Source[]) {
        this.active(scope.id, scope);
        if (sources.length) {
            const current = await this.sources(scope);
            for (const source of sources) if (!current.some(candidate => candidate.path === source.path && candidate.cwd === source.cwd && candidate.nativeSessionId === source.nativeSessionId))
                throw new Error('历史会话项目归属或源身份已变化，请重新扫描');
        }
        this.active(scope.id, scope);
    }
    private async sources(scope: MemoryScope): Promise<Source[]> {
        if (scope.agentType === 'prime-agent') return (await primeSources(this.options.home)).filter(source => source.cwd === scope.root);
        const home = this.options.home ?? homedir();
        const base = (variable: string, fallback: string) => this.options.home ? join(home, fallback) : process.env[variable] || join(home, fallback);
        if (scope.agentType === 'codex-cli') {
            const roots = this.options.codexRoots ?? [join(base('CODEX_HOME', '.codex'), 'sessions'), join(base('CODEX_HOME', '.codex'), 'archived_sessions')];
            const headers = [];
            for (const root of roots) for (const path of await sourceFiles(root)) {
                const header = await sourceHeader(path); if (header) headers.push(header);
            }
            const selected = new Set(headers.filter(header => header.sourceKind === 'user' && this.store.memory.resolve(scope.agentType, header.cwd)?.id === scope.id).map(header => header.id));
            let prior = -1;
            while (prior !== selected.size) { prior = selected.size; for (const header of headers) if (header.sourceKind === 'subagent' && header.parent && selected.has(header.parent)) selected.add(header.id); }
            return headers.filter(header => selected.has(header.id)).map(header => ({ path: header.path, nativeSessionId: header.id, cwd: header.cwd, parentNativeSessionId: header.parent }));
        }
        if (scope.agentType.startsWith('opencode-')) {
            const data = this.options.home ? join(home, '.local/share') : process.env.XDG_DATA_HOME || join(home, '.local/share');
            const path = join(data, 'opencode', 'opencode.db');
            let db: DatabaseSync; try { db = new DatabaseSync(path, { readOnly: true }); } catch (error) { if (object(error).code === 'ERR_SQLITE_ERROR' && String(error).includes('unable to open')) return []; throw error; }
            try {
                const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_v2'").get() ? 'session_v2' : 'session';
                return db.prepare(`SELECT id,directory FROM ${table}`).all().filter(row => this.store.memory.resolve(scope.agentType, String(row.directory))?.id === scope.id).map(row => ({ path, nativeSessionId: String(row.id), cwd: String(row.directory) }));
            } finally { db.close(); }
        }
        if (scope.agentType === 'kimi-code') {
            const root = base('KIMI_CODE_HOME', '.kimi-code');
            let index: string; try { index = await readFile(join(root, 'session_index.jsonl'), 'utf8'); } catch (error) { if (object(error).code === 'ENOENT') return []; throw error; }
            const result = new Map<string, Source>();
            for (const line of index.split('\n')) {
                let item; try { item = object(JSON.parse(line)); } catch { continue; }
                const nativeSessionId = textField(item, 'sessionId'), cwd = textField(item, 'workDir'), directory = textField(item, 'sessionDir');
                if (!nativeSessionId || !cwd || !directory || this.store.memory.resolve(scope.agentType, cwd)?.id !== scope.id) continue;
                if (!resolve(directory).startsWith(resolve(root, 'sessions') + sep) || basename(directory) !== nativeSessionId) continue;
                result.set(nativeSessionId, { nativeSessionId, cwd, path: join(directory, 'agents', 'main', 'wire.jsonl') });
            }
            return [...result.values()];
        }
        const root = scope.agentType === 'deepseek-harness'  ? join(base('DSH_HOME', '.dsh'), 'sessions')
            : scope.agentType === 'pi' ? join(base('PI_CODING_AGENT_DIR', '.pi/agent'), 'sessions')
            : scope.agentType === 'claude-code' ? join(base('CLAUDE_CONFIG_DIR', '.claude'), 'projects')
            : scope.agentType === 'workbuddy' ? join(await workbuddyConfigDir(this.options.home), 'projects') : undefined;
        if (!root) throw new Error(`${scope.agentType} 暂无可验证的本地历史读取器，不能上传历史会话`);
        let paths = await this.files(root, scope.agentType === 'deepseek-harness' ? 2 : 1);
        if (scope.agentType === 'deepseek-harness') {
            paths = paths.filter(path => /\/session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(path));
            paths.sort((a, b) => Number(/\.v(\d+)/.exec(b)?.[1] ?? 0) - Number(/\.v(\d+)/.exec(a)?.[1] ?? 0) || Number(b.endsWith('.zstd')) - Number(a.endsWith('.zstd')));
            paths = [...new Map(paths.reverse().map(path => [dirname(path), path])).values()];
        }
        const result: Source[] = [];
        for (const path of paths) {
            if (path.endsWith('.meta.json')) {
                const metadata = object(JSON.parse(await readFile(path, 'utf8'))), cwd = textField(metadata, 'cwd');
                const nativeSessionId = textField(metadata, 'sessionId', 'session_id', 'id') ?? basename(path, '.meta.json');
                if (cwd && this.store.memory.resolve(scope.agentType, cwd)?.id === scope.id) result.push({ path: path.replace(/\.meta\.json$/, '.jsonl'), nativeSessionId, cwd: resolve(cwd) });
                continue;
            }
            const lines = (await this.header(path)).split('\n');
            for (const line of lines) {
                if (!line.trim()) continue;
                let row; try { row = object(JSON.parse(line)); } catch { continue; }
                const cwd = textField(row, 'cwd');
                if (!cwd) continue;
                const nativeSessionId = textField(row, 'sessionId', 'session_id', 'id');
                if (nativeSessionId && this.store.memory.resolve(scope.agentType, cwd)?.id === scope.id) result.push({ path, nativeSessionId, cwd: resolve(cwd) });
                break;
            }
        }
        return [...new Map(result.map(source => [source.path, source])).values()];
    }
    private async codex(scan: Scan, scope: MemoryScope): Promise<CodexSnapshot[]> {
        const snapshots: CodexSnapshot[] = [];
        for (const source of scan.sources) {
            this.active(scope.id, scope);
            const { snapshot } = await readCodexRollout(source.path);
            source.startedAt = snapshot.startedAt ?? snapshot.turns.map(turn => turn.startedAt).filter((time): time is string => !!time).sort()[0];
            source.parentNativeSessionId = snapshot.parentNativeSessionId;
            if (snapshot.nativeSessionId !== source.nativeSessionId || snapshot.cwd !== source.cwd) throw new Error('历史会话源身份已变化，请重新扫描');
            for (const turn of snapshot.turns) turn.records = filterBindRecords(turn.records);
            snapshots.push(snapshot);
        }
        const byId = new Map(snapshots.map(snapshot => [snapshot.nativeSessionId, snapshot]));
        const owner = (snapshot: CodexSnapshot) => {
            const seen = new Set<string>();
            let source: CodexSnapshot | undefined = snapshot;
            while (source && !seen.has(source.nativeSessionId)) {
                seen.add(source.nativeSessionId);
                if (source.sourceKind === 'user') return source.nativeSessionId;
                source = source.parentNativeSessionId ? byId.get(source.parentNativeSessionId) : undefined;
            }
            return undefined;
        };
        const groups = new Map<string, { snapshot: CodexSnapshot; turn: CodexSnapshot['turns'][number] }[]>();
        for (const snapshot of snapshots) for (const turn of snapshot.turns) {
            const root = owner(snapshot); if (!root) continue;
            const key = JSON.stringify([root, turn.rootTurnId]), group = groups.get(key) ?? [];
            group.push({ snapshot, turn }); groups.set(key, group);
        }
        const complete = new Set<CodexSnapshot['turns'][number]>();
        for (const group of groups.values()) {
            if (!group.some(item => item.snapshot.sourceKind === 'user' && item.turn.records.some(record => record.message.role === 'user'))) continue;
            if (group.some(item => item.turn.status === 'running' || !item.turn.completedAt || item.turn.completedAt > scan.cutoff! || item.turn.gaps.length || item.snapshot.gaps.length)) continue;
            if (group.some(item => item.turn.expectedChildren.some(child => child.status !== 'failed' && !group.some(candidate => candidate.snapshot.nativeSessionId !== item.snapshot.nativeSessionId && (candidate.snapshot.nativeSessionId === child.agentId || !!child.agentPath && candidate.snapshot.agentPath === child.agentPath))))) continue;
            for (const item of group) complete.add(item.turn);
        }
        return snapshots.map(snapshot => ({ ...snapshot, turns: snapshot.turns.filter(turn => complete.has(turn)) })).filter(snapshot => snapshot.turns.length);
    }
    private async turns(scope: MemoryScope, source: Source, cutoff: string): Promise<HistoricalTurn[]> {
        return (await this.sourceTurns(scope, source, cutoff)).map(turn => ({ ...turn, records: filterBindRecords(turn.records.map(record => ({ ...record, nativeTurnId: record.nativeTurnId ?? turn.key }))) }));
    }
    private async sourceTurns(scope: MemoryScope, source: Source, cutoff: string): Promise<HistoricalTurn[]> {
        this.active(scope.id, scope);
        if (scope.agentType === 'prime-agent') {
            const before = await stat(source.path);
            const snapshot = await readPrimeSession(source.path);
            if (snapshot.nativeSessionId !== source.nativeSessionId || snapshot.cwd !== source.cwd) throw new Error('Prime 历史会话身份发生变化');
            if (snapshot.partial || !primeIdle(snapshot, await primeStatus(this.options.home))) return [];
            const after = await stat(source.path);
            if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
                throw new Error('Prime 历史会话读取期间发生变化，请重新扫描');
            return snapshot.turns.filter((turn): turn is HistoricalTurn => !!turn.completedAt && turn.completedAt <= cutoff
                && turn.records.every(record => { const time = this.store.memory.recordTime(record.raw); return !!time && time <= cutoff; }));
        }
        if (scope.agentType.startsWith('opencode-')) return this.openCodeTurns(scope, source, cutoff);
        const rows = ['claude-code', 'kimi-code', 'workbuddy'].includes(scope.agentType) ? await readTranscript(source.path, `${scope.agentType}:${source.nativeSessionId}`)
            : (await this.content(source.path)).split('\n').filter(Boolean).flatMap((line, index) => {
                try { const raw = object(JSON.parse(line)); return [{ raw, sourceId: scope.agentType === 'pi' ? `entry:${raw.id}` : `event:${raw.seq ?? index}` }]; }
                catch { return []; }
            });
        const turns: HistoricalTurn[] = [];
        let records: TraceInput[] = [], key = '', completedAt: string | undefined;
        const finish = () => { if (records.length && completedAt) turns.push({ key, records, completedAt }); records = []; key = ''; completedAt = undefined; };
        for (const input of rows) {
            const raw = object(input.raw), time = this.store.memory.recordTime(raw);
            if (time && time > cutoff) continue;
            const record = normalizeTaskTrace(scope.agentType, input);
            if (record?.message?.role === 'user') { finish(); key = record.nativeTurnId ?? textField(object(raw.data), 'id') ?? textField(raw, 'uuid', 'id') ?? record.sourceId; }
            if (record && key) { records.push(record); completedAt = undefined; }
            if (['function_call', 'function_call_result', 'tool.call.started', 'tool.result'].includes(String(raw.type))) completedAt = undefined;
            const stop = object(raw.message).stop_reason ?? object(raw.message).stopReason;
            if (['turn/end', 'turn.end', 'turn.completed', 'turn.finished'].includes(String(raw.type)) || ['end_turn', 'stop', 'error', 'aborted'].includes(String(stop)) || scope.agentType === 'workbuddy' && record?.message?.role === 'assistant' && raw.status === 'completed') completedAt = time ?? cutoff;
        }
        finish();
        return turns.map(turn => ({ ...turn, records: filterAdapterSkills(scope.agentType,
            turn.records.map(record => ({ ...record, nativeTurnId: record.nativeTurnId ?? turn.key }))) }));
    }
    private openCodeTurns(scope: MemoryScope, source: Source, cutoff: string): HistoricalTurn[] {
        const db = new DatabaseSync(source.path, { readOnly: true });
        try {
            const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)));
            const table = tables.has('message') ? 'message' : tables.has('message_v2') ? 'message_v2' : tables.has('session_message') ? 'session_message' : undefined;
            if (!table) throw new Error('OpenCode 本地数据库尚无可读取的消息表');
            const turns: HistoricalTurn[] = [];
            let records: TraceInput[] = [], key = '', completedAt: string | undefined;
            const finish = () => { if (key && records.length && completedAt) turns.push({ key, records, completedAt }); records = []; completedAt = undefined; };
            for (const row of db.prepare(`SELECT * FROM ${table} WHERE session_id=? ORDER BY time_created,id`).all(source.nativeSessionId)) {
                const info: Record<string, unknown> = { ...object(JSON.parse(String(row.data))), id: String(row.id), sessionID: source.nativeSessionId };
                const role = textField(info, 'role') ?? String(row.type ?? '');
                if (!['user', 'assistant'].includes(role)) continue;
                const occurredAt = this.store.memory.recordTime({ timestamp: object(info.time).created ?? row.time_created });
                if (occurredAt && occurredAt > cutoff) continue;
                if (role === 'user') { finish(); key = String(row.id); }
                if (!key) continue;
                const partTable = tables.has('part') ? 'part' : tables.has('part_v2') ? 'part_v2' : undefined;
                const parts = partTable ? db.prepare(`SELECT * FROM ${partTable} WHERE message_id=? ORDER BY time_created,id`).all(row.id!).map(part => ({ ...object(JSON.parse(String(part.data))), id: String(part.id), messageID: String(row.id), sessionID: source.nativeSessionId })) : info.content ?? info.text ?? '';
                const native = this.store.row(`SELECT t.sourceId FROM traces t JOIN sessions s ON s.id=t.sessionId WHERE s.objectId=? AND s.nativeSessionId=? AND (json_extract(t.raw,'$.data.message.id')=? OR json_extract(t.raw,'$.info.id')=?) LIMIT 1`, scope.id, source.nativeSessionId, String(row.id), String(row.id));
                records.push({ sourceId: native ? String(native.sourceId) : `message:${row.id}`, nativeTurnId: key,
                    raw: { info, parts, timestamp: occurredAt }, message: { ...info, role, content: parts as string | unknown[] } });
                completedAt = undefined;
                const completion = this.store.memory.recordTime({ timestamp: object(info.time).completed });
                if (role === 'assistant' && completion && completion <= cutoff && info.finish !== 'tool-calls') completedAt = completion;
            }
            finish(); return turns;
        } finally { db.close(); }
    }
    private async header(path: string): Promise<string> {
        const file = createReadStream(path, { highWaterMark: 16384 });
        const stream = path.endsWith('.zstd') ? file.pipe(createZstdDecompress()) : file;
        file.on('error', error => stream.destroy(error));
        let buffer = '', header = '';
        try {
            for await (const bytes of stream) {
                buffer += Buffer.from(bytes).toString('utf8');
                let end: number;
                while ((end = buffer.indexOf('\n')) >= 0) {
                    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); header += line + '\n';
                    try { if (textField(object(JSON.parse(line)), 'cwd')) return header; } catch { /* Header may precede a concurrently appended row. */ }
                    if (header.length > 65536) return header;
                }
                if (buffer.length > 4 * 1024 * 1024) throw new Error('历史会话头部过大');
            }
            return header;
        } finally { file.destroy(); stream.destroy(); }
    }
    private async content(path: string) { const bytes = await readFile(path); return (path.endsWith('.zstd') ? zstdDecompressSync(bytes) : bytes).toString('utf8'); }
    private async files(root: string, depth: number): Promise<string[]> {
        let entries; try { entries = await readdir(root, { withFileTypes: true }); } catch (error) { if (object(error).code === 'ENOENT') return []; throw error; }
        const result: string[] = [];
        for (const entry of entries) {
            const path = join(root, entry.name);
            if (entry.isDirectory() && depth) result.push(...await this.files(path, depth - 1));
            else if (entry.isFile() && /(?:\.jsonl(?:\.zstd)?|\.meta\.json)$/.test(entry.name)) result.push(path);
        }
        return result;
    }
}
