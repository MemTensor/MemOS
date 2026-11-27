import { sanitizeCodexReceipt } from '../storage/sanitize-content.ts';
import { createHash } from 'node:crypto';
import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AgentEvent } from '../adapters/types.ts';
import { object, textField } from '../adapters/_shared/transcript.ts';
import { parseCodexRollout, readCodexRollout } from '../adapters/codex-cli/rollout.ts';
import type { CodexReaderState, CodexSnapshot } from '../adapters/codex-cli/types.ts';
import type { Store } from '../storage/store.ts';

export interface CodexCaptureOptions { codexRoots?: string[] }
type Header = { path: string; id: string; cwd: string; parent?: string; agentPath?: string; sourceKind: CodexSnapshot['sourceKind'] };
type Source = { path: string; state: string | null; nativeSessionId: string | null; error: string | null; updatedAt: string };
type Receipt = { id: string; event: string };
type ReceiptEvent = { receipt: Receipt; event: AgentEvent };
type SourceWrite = { path: string; state: CodexReaderState | null; error: string | null };
type SourceRecovery = {
    state?: CodexReaderState;
    captured?: CodexSnapshot;
    reuseUnchanged: boolean;
    writeCheckpoint: boolean;
};
type SourceResult =
    | { kind: 'ignored' }
    | { kind: 'empty'; previouslySaved: boolean }
    | { kind: 'readable' | 'quarantined' | 'emptied'; snapshot: CodexSnapshot; update?: SourceWrite }
    | { kind: 'unavailable'; snapshot?: CodexSnapshot; update?: SourceWrite; retirementCandidate?: CodexSnapshot };

function withGap(snapshot: CodexSnapshot, gap: string): CodexSnapshot {
    const copy = structuredClone(snapshot);
    copy.gaps.push(gap);
    return copy;
}

function sourceError(path: string, state: CodexReaderState | undefined, saved: Source | undefined, error: string): SourceWrite | undefined {
    return saved?.error === error ? undefined : { path, state: state ?? null, error };
}
function quarantinedSource(path: string, state: CodexReaderState, saved: Source | undefined): SourceResult {
    return {
        kind: 'quarantined', snapshot: withGap(state.parser.snapshot, 'source_identity_changed'),
        update: sourceError(path, state, saved, `Codex 源身份发生变化，已隔离: ${path}`),
    };
}

const now = () => new Date().toISOString();

/** A matching session ID alone does not prove that an archive retained its history. */
function coversSource(replacement: CodexSnapshot, prior: CodexSnapshot): boolean {
    if (replacement.sourcePath === prior.sourcePath || replacement.gaps.length || replacement.turns.some(turn => turn.gaps.length)) return false;
    // Persisted reader states omit undefined optional properties; compare the
    // fresh reader through the same representation on the first recovery pass.
    replacement = JSON.parse(JSON.stringify(replacement)) as CodexSnapshot;
    const { sourcePath: _oldPath, gaps: _oldGaps, turns: oldTurns, ...oldIdentity } = prior;
    const { sourcePath: _newPath, gaps: _newGaps, turns: newTurns, ...newIdentity } = replacement;
    if (!isDeepStrictEqual(oldIdentity, newIdentity)) return false;
    let turnIndex = 0;
    return oldTurns.every(oldTurn => {
        while (turnIndex < newTurns.length && newTurns[turnIndex]!.nativeTurnId !== oldTurn.nativeTurnId) turnIndex++;
        const next = newTurns[turnIndex++];
        if (!next) return false;
        const { records, expectedChildren, gaps: _gaps, status, completedAt, ...identity } = oldTurn;
        const { records: nextRecords, expectedChildren: nextChildren, gaps: _nextGaps, status: nextStatus, completedAt: nextCompletedAt, ...nextIdentity } = next;
        if (!isDeepStrictEqual(identity, nextIdentity) || (status !== 'running' && status !== nextStatus) || (completedAt !== undefined && completedAt !== nextCompletedAt)) return false;
        let recordIndex = 0;
        if (!records.every(record => {
            while (recordIndex < nextRecords.length && nextRecords[recordIndex]!.sourceId !== record.sourceId) recordIndex++;
            return isDeepStrictEqual(record, nextRecords[recordIndex++]);
        })) return false;
        return expectedChildren.every(child => nextChildren.some(candidate => {
            const { status: oldStatus, ...evidence } = child;
            const { status: newStatus, ...nextEvidence } = candidate;
            // A pending dispatch can acquire an agent ID when its result arrives.
            return (oldStatus === 'pending' || oldStatus === newStatus) && Object.entries(evidence).every(([key, value]) => isDeepStrictEqual(value, nextEvidence[key as keyof typeof nextEvidence]));
        }));
    });
}

function reconcileSources(results: SourceResult[], startup: boolean) {
    const readable = results.flatMap(result => result.kind === 'readable' ? [result.snapshot] : []);
    const retired = new Set<string>();
    for (const result of results) {
        if (result.kind !== 'unavailable' || !result.retirementCandidate) continue;
        const prior = result.retirementCandidate;
        if (readable.some(next => coversSource(next, prior))) retired.add(prior.sourcePath);
    }
    const retained = results.flatMap(result =>
        'snapshot' in result && result.snapshot && !retired.has(result.snapshot.sourcePath) ? [result.snapshot] : []);
    const updates = results.flatMap(result => 'update' in result && result.update ? [result.update] : []);
    const changedPaths = new Set(updates.map(update => update.path));
    const changed = startup || updates.length > 0 || retired.size > 0 || results.some(result => result.kind === 'empty' && result.previouslySaved);
    return { retired, retained, updates, changed, changedSnapshots: retained.filter(snapshot => changedPaths.has(snapshot.sourcePath)) };
}

/** Metadata discovery never follows directory symlinks or reads task bodies. */
export async function sourceFiles(directory: string, depth = 4): Promise<string[]> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (object(error).code === 'ENOENT') return []; throw error; }
    const paths: string[] = [];
    for (const entry of entries) {
        if (entry.isFile() && /^rollout.*\.jsonl$/.test(entry.name)) paths.push(join(directory, entry.name));
        else if (entry.isDirectory() && depth > 0) paths.push(...await sourceFiles(join(directory, entry.name), depth - 1));
    }
    return paths.sort();
}

export async function sourceHeader(path: string): Promise<Header | undefined> {
    const file = await open(path, 'r');
    try {
        const chunks: Buffer[] = [];
        let size = 0;
        // A session header can contain base instructions considerably larger than 64 KiB.
        while (size < 4 * 1024 * 1024) {
            const bytes = Buffer.alloc(65536);
            const { bytesRead } = await file.read(bytes, 0, bytes.length, size);
            if (!bytesRead) return undefined;
            const part = bytes.subarray(0, bytesRead), end = part.indexOf(10);
            chunks.push(end < 0 ? part : part.subarray(0, end));
            size += bytesRead;
            if (end < 0) continue;
            const line = Buffer.concat(chunks).toString('utf8');
            const row = object(JSON.parse(line));
            if (row.type !== 'session_meta') return undefined;
            const payload = object(row.payload), spawn = object(object(object(payload.source).subagent).thread_spawn);
            const id = textField(payload, 'id', 'session_id'), cwd = textField(payload, 'cwd');
            if (!id || !cwd || !isAbsolute(cwd)) return undefined;
            return { path, id, cwd, parent: textField(payload, 'parent_thread_id') ?? textField(spawn, 'parent_thread_id'), agentPath: textField(payload, 'agent_path') ?? textField(spawn, 'agent_path'), sourceKind: parseCodexRollout(line + '\n', path).sourceKind };
        }
        return undefined;
    } finally { await file.close(); }
}

/** Hooks, recovery and polling all feed the same persistent source readers. */
export class CodexCapture {
    private running: Promise<void> | undefined;
    private lastDiscovery = 0;
    private lastRead = 0;
    private headers = new Map<string, Header>();
    private pendingSources = new Map<string, CodexReaderState>();
    private closed = false;
    readonly roots: string[];
    constructor(privateStore: Store, options: CodexCaptureOptions = {}) {
        this.store = privateStore;
        const home = process.env.CODEX_HOME || join(homedir(), '.codex');
        this.roots = options.codexRoots ?? [join(home, 'sessions'), join(home, 'archived_sessions')];
        this.store.db.exec(`CREATE TABLE IF NOT EXISTS codex_receipts(
            id TEXT PRIMARY KEY,event TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',createdAt TEXT NOT NULL,error TEXT);
            CREATE TABLE IF NOT EXISTS codex_sources(
            path TEXT PRIMARY KEY,state TEXT,nativeSessionId TEXT,error TEXT,updatedAt TEXT NOT NULL);`);
    }
    private store: Store;
    close() { this.closed = true; this.pendingSources.clear(); }
    enqueue(event: AgentEvent): string {
        if (!this.scopeFor(event.nativeSessionId)) return '';
        const serialized = JSON.stringify(sanitizeCodexReceipt(event));
        const id = createHash('sha256').update(serialized).digest('hex');
        this.store.db.prepare('INSERT OR IGNORE INTO codex_receipts(id,event,createdAt) VALUES(?,?,?)').run(id, serialized, now());
        return id;
    }
    async flush(forceDiscovery = false): Promise<void> {
        if (this.closed) return;
        while (this.running) {
            await this.running;
            if (!forceDiscovery || this.closed) return;
        }
        if (!forceDiscovery && Date.now() - this.lastRead < 2_000) return;
        const work = this.collect(forceDiscovery);
        this.running = work;
        try { await work; this.lastRead = Date.now(); }
        finally { if (this.running === work) this.running = undefined; }
    }
    private async collect(forceDiscovery: boolean) {
        const receipts = this.store.rows("SELECT id,event FROM codex_receipts WHERE status='pending' ORDER BY createdAt,id") as unknown as Receipt[];
        const events = receipts.map(receipt => ({ receipt, event: JSON.parse(receipt.event) as AgentEvent }));
        const previous = new Map((this.store.rows('SELECT path,state,nativeSessionId,error,updatedAt FROM codex_sources') as unknown as Source[]).map(source => [source.path, source]));
        if (!this.store.memory.all().some(scope => scope.agentType === 'codex-cli' && scope.spaceIds.length)) { this.pendingSources.clear(); return; }
        const selected = await this.selectSources(previous, events, forceDiscovery);
        const results: SourceResult[] = [];
        for (const path of [...selected].sort()) {
            if (this.closed) return;
            const saved = previous.get(path);
            const recovery = this.recoverSource(path, saved);
            try {
                // A binding may have changed in another connection during recovery.
                if (!this.scopeFor(this.headers.get(path)?.id ?? '')) {
                    results.push(recovery.state ? quarantinedSource(path, recovery.state, saved) : { kind: 'ignored' });
                    continue;
                }
                const read = await readCodexRollout(path, recovery.state);
                if (this.closed) return;
                // Finish the last read and commit in this continuation so a queued
                // close cannot discard the batch after its records are admitted.
                results.push(this.acceptRead(path, saved, recovery, read));
            } catch (error) {
                if (this.closed) return;
                results.push(this.unavailableSource(path, saved, recovery.state, error));
            }
        }
        if (this.closed) return;
        const plan = reconcileSources(results, this.lastRead === 0);
        if (plan.changed || receipts.length) this.commitSources(plan, events);
    }
    private async selectSources(previous: Map<string, Source>, events: ReceiptEvent[], forceDiscovery: boolean) {
        const selected = new Set<string>();
        const explicit = new Set<string>();
        for (const { event } of events) {
            const raw = object(event.raw);
            const main = textField(raw, 'transcript_path', 'transcriptPath');
            if (main && isAbsolute(main)) explicit.add(resolve(main));
            const child = textField(raw, 'agent_transcript_path');
            if (child && isAbsolute(child)) explicit.add(resolve(child));
        }
        const discover = forceDiscovery || events.length > 0 || Date.now() - this.lastDiscovery >= 10_000;
        const paths = new Set([...previous.keys(), ...explicit, ...this.pendingSources.keys()]);
        if (discover) {
            for (const root of this.roots) {
                const discovered = await sourceFiles(root);
                if (this.closed) return selected;
                for (const path of discovered) paths.add(path);
            }
            this.lastDiscovery = Date.now();
        }
        for (const path of paths) {
            try {
                const header = await sourceHeader(path);
                if (this.closed) return selected;
                if (header) this.headers.set(path, header);
            } catch (error) {
                if (this.closed) return selected;
                // Missing/partial newly discovered files remain retryable; known files
                // are handled below as explicit capture gaps, not silently forgotten.
                if (object(error).code !== 'ENOENT' && explicit.has(path)) this.store.diagnostic(`Codex 源头信息暂不可读: ${path}`);
            }
        }
        for (const header of this.headers.values()) if (this.scopeFor(header.id)) selected.add(header.path);
        // A replaced path must be quarantined using its header alone. Never read
        // a replacement body just because this path used to belong to a bound project.
        for (const [path, source] of previous) {
            const nativeSessionId = source.nativeSessionId ?? (source.state ? (JSON.parse(source.state) as CodexReaderState).parser.snapshot.nativeSessionId : '');
            const session = this.store.row("SELECT objectId,agentType FROM sessions WHERE agentType='codex-cli' AND nativeSessionId=?", nativeSessionId);
            if (session && this.store.memory.forSession({ objectId: String(session.objectId), agentType: String(session.agentType) })) selected.add(path);
        }
        for (const path of this.pendingSources.keys()) if (!selected.has(path)) this.pendingSources.delete(path);
        return selected;
    }
    private recoverSource(path: string, saved: Source | undefined): SourceRecovery {
        const state = saved?.state ? JSON.parse(saved.state) as CodexReaderState : this.pendingSources.get(path);
        const scope = this.scopeFor(this.headers.get(path)?.id ?? '');
        const rebound = !!saved && !!scope && (!!scope.enabledAt && scope.enabledAt > saved.updatedAt
            || !!this.store.row('SELECT 1 FROM capture_windows WHERE scopeId=? AND endedAt>=? LIMIT 1', scope.id, saved.updatedAt));
        const recover = this.lastRead === 0 || !!saved?.error || state?.version !== 4 || rebound;
        const captured = recover ? this.capturedSnapshot(path) : undefined;
        let restored = false;
        if (state && captured) {
            const turns = new Map(state.parser.snapshot.turns.map(turn => [turn.nativeTurnId, turn]));
            for (const turn of captured.turns) {
                const prior = turns.get(turn.nativeTurnId), ids = new Set(prior?.records.map(record => record.sourceId) ?? []);
                if (turn.records.some(record => !ids.has(record.sourceId))) { turns.set(turn.nativeTurnId, turn); restored = true; }
            }
            if (restored) state.parser.snapshot.turns = [...turns.values()];
        }
        return { state, captured, reuseUnchanged: !!saved && !recover,
            writeCheckpoint: restored || !saved || !!saved.error || rebound };
    }
    private acceptRead(path: string, saved: Source | undefined, recovery: SourceRecovery,
        read: Awaited<ReturnType<typeof readCodexRollout>>): SourceResult {
        const { state, captured } = recovery;
        if (!read.changed && recovery.reuseUnchanged) {
            // The binding window has already admitted these records. Retain
            // the snapshot for archive and receipt checks without rewriting it.
            read.snapshot.turns = read.snapshot.turns.filter(turn => turn.records.length);
            return { kind: 'readable', snapshot: read.snapshot };
        }
        const readScope = this.scopeFor(read.snapshot.nativeSessionId);
        if (!readScope) return { kind: 'ignored' };
        this.filter(read.snapshot, readScope.id, false, captured ?? state?.parser.snapshot);
        this.filter(read.state.parser.snapshot, readScope.id, true, captured ?? state?.parser.snapshot);
        read.state.parser.pending = read.state.parser.pending.filter(item => this.store.memory.allows(readScope.id, this.store.memory.recordTime(item.raw)));
        const prior = state?.parser.snapshot;
        if (state && prior && (read.snapshot.nativeSessionId !== prior.nativeSessionId || read.snapshot.cwd !== prior.cwd && !read.directoryUpgrade || read.snapshot.parentNativeSessionId !== prior.parentNativeSessionId)) {
            return quarantinedSource(path, state, saved);
        }
        if (!read.snapshot.turns.some(turn => turn.records.length)) {
            if (prior?.turns.some(turn => turn.records.length)) {
                return { kind: 'emptied', snapshot: withGap(prior, `source_empty_after_capture:${path}`),
                    update: sourceError(path, state, saved, `Codex 原有轨迹已变为空源，保留已有记录: ${path}`) };
            }
            // Keep the reader in memory until a user submission populates the file.
            this.pendingSources.set(path, read.state);
            return { kind: 'empty', previouslySaved: !!saved };
        }
        const update = read.changed || recovery.writeCheckpoint
            ? { path, state: read.state, error: null } : undefined;
        return { kind: 'readable', snapshot: read.snapshot, update };
    }
    private unavailableSource(path: string, saved: Source | undefined, state: CodexReaderState | undefined, error: unknown): SourceResult {
        const code = object(error).code;
        if (!saved && state && !state.parser.snapshot.turns.some(turn => turn.records.length) && code === 'ENOENT') {
            this.pendingSources.delete(path);
            this.headers.delete(path);
            return { kind: 'ignored' };
        }
        const message = `Codex 源暂不可读: ${path} (${String(code ?? 'read_error')})`;
        // Unread bytes and unattributed events prevent proving archive coverage.
        const retirementCandidate = code === 'ENOENT' && state && state.byteOffset === state.observedSize && !state.parser.pending.length
            ? state.parser.snapshot : undefined;
        return { kind: 'unavailable', snapshot: state && withGap(state.parser.snapshot, `source_unavailable:${path}`),
            retirementCandidate, update: sourceError(path, state, saved, message) };
    }
    private commitSources(plan: ReturnType<typeof reconcileSources>, events: ReceiptEvent[]) {
        const { retired, updates, changed } = plan;
        this.store.db.exec('BEGIN');
        try {
            // Remove only source associations. Canonical traces and sent payloads
            // remain intact, and reconciliation observes the replacement atomically.
            for (const path of retired) {
                for (const table of ['codex_execution_sources', 'codex_event_sources', 'codex_source_meta']) this.store.db.prepare(`DELETE FROM ${table} WHERE sourcePath=?`).run(path);
                this.store.db.prepare('DELETE FROM codex_sources WHERE path=?').run(path);
            }
            // Unchanged sources already exist in canonical storage. Reconcile all
            // identities, but do not rewrite every historical event on each append.
            if (changed) this.store.applyCodexSnapshots(plan.changedSnapshots, { prepareUploads: false, requireBinding: true });
            for (const update of updates) {
                if (retired.has(update.path)) continue;
                this.store.db.prepare(`INSERT INTO codex_sources(path,state,nativeSessionId,error,updatedAt) VALUES(?,?,?,?,?)
                    ON CONFLICT(path) DO UPDATE SET state=excluded.state,nativeSessionId=excluded.nativeSessionId,error=excluded.error,updatedAt=excluded.updatedAt`)
                    .run(update.path, update.state ? JSON.stringify(update.state) : null, update.state?.parser.snapshot.nativeSessionId ?? null, update.error, now());
                if (update.error) this.store.diagnostic(update.error);
            }
            for (const { receipt, event } of events) {
                const empty = [...this.pendingSources.values()].some(state => state.parser.snapshot.nativeSessionId === event.nativeSessionId);
                if (empty && event.event !== 'turn-start') {
                    this.store.db.prepare('DELETE FROM codex_receipts WHERE id=?').run(receipt.id);
                    continue;
                }
                const sources = plan.retained.filter(snapshot => snapshot.nativeSessionId === event.nativeSessionId);
                const found = sources.find(snapshot => snapshot.sourceKind !== 'unknown');
                const resolved = found?.sourceKind === 'background' || !!found && (!event.nativeTurnId || sources.some(snapshot => snapshot.turns.some(turn => turn.nativeTurnId === event.nativeTurnId)));
                this.store.db.prepare('UPDATE codex_receipts SET status=?,error=? WHERE id=?').run(resolved ? found!.sourceKind === 'background' ? 'filtered' : 'processed' : 'pending', resolved ? null : '等待原始会话和对应执行轮落盘', receipt.id);
            }
            if (changed) this.store.prepareCodexUploads(true);
            this.store.db.exec('COMMIT');
            for (const path of retired) this.headers.delete(path);
            for (const update of updates) this.pendingSources.delete(update.path);
        } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    }
    private scopeFor(nativeSessionId: string) {
        const seen = new Set<string>();
        let id: string | undefined = nativeSessionId;
        while (id && !seen.has(id)) {
            seen.add(id);
            const header = [...this.headers.values()].find(candidate => candidate.id === id);
            if (!header) return undefined;
            if (header.sourceKind === 'user') return this.store.memory.resolve('codex-cli', header.cwd);
            if (header.sourceKind !== 'subagent') return undefined;
            id = header.parent;
        }
        return undefined;
    }
    /** The original session header, rather than a tool's cwd, controls activation. */
    async sessionDirectory(nativeSessionId: string): Promise<string | undefined> {
        const headers: Header[] = [];
        for (const root of this.roots) for (const path of await sourceFiles(root)) {
            try { const header = await sourceHeader(path); if (header) headers.push(header); } catch { /* An incomplete header grants no identity. */ }
        }
        const seen = new Set<string>();
        let id: string | undefined = nativeSessionId;
        while (id && !seen.has(id)) {
            seen.add(id);
            const candidates = headers.filter(header => header.id === id);
            const header = candidates[0];
            if (!header || candidates.some(candidate => candidate.cwd !== header.cwd || candidate.sourceKind !== header.sourceKind || candidate.parent !== header.parent)) return undefined;
            if (header.sourceKind === 'user') return header.cwd;
            if (header.sourceKind !== 'subagent') return undefined;
            id = header.parent;
        }
        return undefined;
    }
    async activation(input: { agentType: string; cwd: string; nativeSessionId?: string; parentNativeSessionId?: string }): Promise<boolean> {
        if (this.closed || !input.nativeSessionId) return false;
        for (const root of this.roots) {
            const paths = await sourceFiles(root);
            if (this.closed) return false;
            for (const path of paths) {
                let header;
                try { header = await sourceHeader(path); } catch { /* A partial header is retried on the next hook. */ }
                if (this.closed) return false;
                if (header) this.headers.set(path, header);
            }
        }
        return !!this.scopeFor(input.nativeSessionId);
    }
    /** Canonical source associations survive reader-cache upgrades and binding changes. */
    private capturedSnapshot(path: string): CodexSnapshot | undefined {
        const source = this.store.row('SELECT * FROM codex_source_meta WHERE sourcePath=?', path);
        if (!source) return undefined;
        const turns = this.store.rows('SELECT * FROM codex_execution_sources WHERE sourcePath=?', path).map(turn => ({
            nativeTurnId: String(turn.nativeTurnId), rootTurnId: String(turn.rootTurnId), parentTurnId: turn.parentTurnId == null ? undefined : String(turn.parentTurnId),
            startedAt: turn.startedAt == null ? undefined : String(turn.startedAt), completedAt: turn.completedAt == null ? undefined : String(turn.completedAt),
            status: turn.status as CodexSnapshot['turns'][number]['status'], expectedChildren: JSON.parse(String(turn.expectedChildren)), gaps: JSON.parse(String(turn.gaps)),
            records: [] as CodexSnapshot['turns'][number]['records'],
        }));
        const byTurn = new Map(turns.map(turn => [turn.nativeTurnId, turn]));
        for (const record of this.store.rows(`SELECT m.*,t.raw,t.message FROM codex_event_sources s JOIN codex_event_meta m ON m.sourceId=s.sourceId JOIN traces t ON t.id=m.traceId WHERE s.sourcePath=? ORDER BY m.sourceOrdinal`, path)) {
            const sourceId = JSON.parse(String(record.sourceId)) as [string, string];
            byTurn.get(String(record.nativeTurnId))?.records.push({ sourceId: sourceId[1], raw: JSON.parse(String(record.raw)), message: JSON.parse(String(record.message)),
                nativeTurnId: String(record.nativeTurnId), originSessionId: String(record.originSessionId), sourceOrdinal: Number(record.sourceOrdinal),
                occurredAt: record.occurredAt == null ? undefined : String(record.occurredAt), rootTurnId: String(record.rootTurnId), agentPath: record.agentPath == null ? undefined : String(record.agentPath) });
        }
        return { sourcePath: path, nativeSessionId: String(source.nativeSessionId), cwd: String(source.cwd), sourceKind: source.sourceKind as CodexSnapshot['sourceKind'],
            parentNativeSessionId: source.parentNativeSessionId == null ? undefined : String(source.parentNativeSessionId), agentPath: source.agentPath == null ? undefined : String(source.agentPath),
            startedAt: source.startedAt == null ? undefined : String(source.startedAt), gaps: JSON.parse(String(source.gaps)), turns };
    }
    private filter(snapshot: CodexSnapshot, scopeId: string, retainBoundaries = false, previous?: CodexSnapshot) {
        const prior = new Map(previous?.turns.map(turn => [turn.nativeTurnId, turn]) ?? []);
        snapshot.turns = snapshot.turns.flatMap(turn => {
            const saved = prior.get(turn.nativeTurnId), captured = new Map(saved?.records.map(record => [record.sourceId, record]) ?? []);
            // Old accepted records are frozen, not readmitted by the new binding.
            // Only IDs still present in the verified source can retain their association.
            const records = turn.records.flatMap(record => this.store.memory.allows(scopeId, record.occurredAt) ? [record] : captured.has(record.sourceId) ? [captured.get(record.sourceId)!] : []);
            if (!records.length && !retainBoundaries) return [];
            if (saved && records.length && !records.some(record => this.store.memory.allows(scopeId, record.occurredAt))) return [{ ...saved, records }];
            const boundary = records.length < turn.records.length || !this.store.memory.allows(scopeId, turn.startedAt);
            return [{ ...turn, records,
                expectedChildren: turn.expectedChildren.filter(child => this.store.memory.allows(scopeId, child.occurredAt) || saved?.expectedChildren.some(prior => prior.callId === child.callId)),
                gaps: boundary ? [...new Set([...turn.gaps, 'binding_boundary'])] : turn.gaps }];
        });
    }
    async context(event: AgentEvent) {
        if (!await this.activation(event) || this.closed) return undefined;
        this.enqueue(event);
        await this.flush(true);
        if (this.closed) return undefined;
        const known = this.store.contextForCodex(event.nativeSessionId, event.nativeTurnId);
        if (known) return known;
        if (event.event === 'turn-start' && event.nativeTurnId) {
            const raw = object(event.raw), attribution = object(raw.turn_attribution);
            const source = [...this.pendingSources.values()].find(state => state.parser.snapshot.nativeSessionId === event.nativeSessionId)?.parser.snapshot;
            return this.store.reserveCodexContext(event.nativeSessionId, event.nativeTurnId, textField(raw, 'root_turn_id') ?? textField(attribution, 'root_turn_id'), source);
        }
        return undefined;
    }
}
