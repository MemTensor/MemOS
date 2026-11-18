import { sanitizeCodexReceipt } from '../storage/sanitize-content.ts';
import { createHash } from 'node:crypto';
import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AgentEvent } from '../adapters/types.ts';
import { object, textField } from '../adapters/_shared/transcript.ts';
import { hasCodexActivity, parseCodexRollout, readCodexRollout } from '../adapters/codex-cli/rollout.ts';
import type { CodexReaderState, CodexSnapshot } from '../adapters/codex-cli/types.ts';
import type { Store } from '../storage/store.ts';

export interface CodexCaptureOptions { codexRoots?: string[] }
type Header = { path: string; id: string; cwd: string; parent?: string; agentPath?: string; sourceKind: CodexSnapshot['sourceKind'] };
type Source = { path: string; state: string | null; error: string | null };
type Receipt = { id: string; event: string };
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

/** Metadata discovery never follows directory symlinks or reads task bodies. */
async function sourceFiles(directory: string, depth = 4): Promise<string[]> {
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

async function sourceHeader(path: string): Promise<Header | undefined> {
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
        const previous = new Map((this.store.rows('SELECT path,state,error FROM codex_sources') as unknown as Source[]).map(source => [source.path, source]));
        const projectIds = new Set(this.store.rows("SELECT projectId FROM project_agents WHERE agentType='codex-cli'").map(row => String(row.projectId)));
        const knownSessions = new Set(this.store.rows("SELECT nativeSessionId FROM sessions WHERE agentType='codex-cli'").map(row => String(row.nativeSessionId)));
        for (const { event } of events) knownSessions.add(event.nativeSessionId);
        if (!events.length && !previous.size && !projectIds.size && !knownSessions.size && !this.pendingSources.size) return;
        const explicit = new Map<string, { session: string; parent?: string }>();
        for (const { event } of events) {
            const raw = object(event.raw);
            const main = textField(raw, 'transcript_path', 'transcriptPath');
            if (main && isAbsolute(main)) explicit.set(resolve(main), { session: event.nativeSessionId });
            const child = textField(raw, 'agent_transcript_path');
            if (child && isAbsolute(child)) explicit.set(resolve(child), { session: textField(raw, 'agent_id', 'agentId') ?? '', parent: event.nativeSessionId });
        }
        const discover = forceDiscovery || receipts.length > 0 || Date.now() - this.lastDiscovery >= 10_000;
        const paths = new Set([...previous.keys(), ...explicit.keys(), ...this.pendingSources.keys()]);
        if (discover) {
            for (const root of this.roots) for (const path of await sourceFiles(root)) paths.add(path);
            this.lastDiscovery = Date.now();
        }
        for (const path of paths) {
            if (this.closed) return;
            try {
                const header = await sourceHeader(path);
                if (header) this.headers.set(path, header);
            } catch (error) {
                // Missing/partial newly discovered files remain retryable; known files
                // are handled below as explicit capture gaps, not silently forgotten.
                if (object(error).code !== 'ENOENT' && explicit.has(path)) this.store.diagnostic(`Codex 源头信息暂不可读: ${path}`);
            }
        }
        // A child may run inside a different project/worktree. Only a verified
        // main source can expand a receipt into project-wide historical capture.
        for (const { event } of events) {
            for (const header of this.headers.values()) if (header.id === event.nativeSessionId && header.sourceKind === 'user') {
                const project = this.store.projectForDirectory(header.cwd);
                if (project) projectIds.add(project.id);
            }
        }
        const selected = new Set([...previous.keys(), ...this.pendingSources.keys()]);
        for (const header of this.headers.values()) {
            const hint = explicit.get(header.path), project = this.store.projectForDirectory(header.cwd);
            const matchesHint = hint && (header.id === hint.session || header.agentPath === hint.session || (hint.parent && header.parent === hint.parent));
            if (matchesHint || (!header.parent && (knownSessions.has(header.id) || (project && projectIds.has(project.id))))) selected.add(header.path);
        }
        // Exact parent IDs discover children in worktrees and grandchildren outside the root cwd.
        let expanded = true;
        while (expanded) {
            expanded = false;
            const parents = new Set([...selected].map(path => this.headers.get(path)?.id).filter(Boolean));
            for (const header of this.headers.values()) if (header.parent && parents.has(header.parent) && !selected.has(header.path)) {
                selected.add(header.path); expanded = true;
            }
        }
        const snapshots: CodexSnapshot[] = [], readable: CodexSnapshot[] = [], missing: CodexSnapshot[] = [];
        const updates: { path: string; state: CodexReaderState | null; error: string | null }[] = [];
        // Reconcile persisted identities once after startup, even without new bytes.
        let changed = receipts.length > 0 || this.lastRead === 0;
        for (const path of [...selected].sort()) {
            if (this.closed) return;
            const saved = previous.get(path), state = saved?.state ? JSON.parse(saved.state) as CodexReaderState : this.pendingSources.get(path);
            try {
                const read = await readCodexRollout(path, state);
                const prior = state?.parser.snapshot;
                if (prior && (read.snapshot.nativeSessionId !== prior.nativeSessionId || read.snapshot.cwd !== prior.cwd && !read.directoryUpgrade || read.snapshot.parentNativeSessionId !== prior.parentNativeSessionId)) {
                    const quarantined = structuredClone(prior);
                    quarantined.gaps.push('source_identity_changed'); snapshots.push(quarantined);
                    const error = `Codex 源身份发生变化，已隔离: ${path}`;
                    if (saved?.error !== error) { updates.push({ path, state: state!, error }); changed = true; }
                    continue;
                }
                if (!hasCodexActivity(read.snapshot)) {
                    if (prior && hasCodexActivity(prior)) {
                        const snapshot = structuredClone(prior);
                        snapshot.gaps.push(`source_empty_after_capture:${path}`); snapshots.push(snapshot);
                        const error = `Codex 原有轨迹已变为空源，保留已有记录: ${path}`;
                        if (saved?.error !== error) { updates.push({ path, state: state!, error }); changed = true; }
                    } else {
                        // Keep only the reader in memory: a later user submission
                        // can populate this file without creating an empty SQLite session.
                        this.pendingSources.set(path, read.state);
                        if (saved) changed = true;
                    }
                    continue;
                }
                snapshots.push(read.snapshot);
                readable.push(read.snapshot);
                if (read.changed || !saved || saved.error) { updates.push({ path, state: read.state, error: null }); changed = true; }
            } catch (error) {
                if (!saved && state && !hasCodexActivity(state.parser.snapshot) && object(error).code === 'ENOENT') {
                    this.pendingSources.delete(path); this.headers.delete(path); continue;
                }
                const message = `Codex 源暂不可读: ${path} (${String(object(error).code ?? 'read_error')})`;
                if (state) {
                    const snapshot = structuredClone(state.parser.snapshot);
                    snapshot.gaps.push(`source_unavailable:${path}`); snapshots.push(snapshot);
                    // Unparsed bytes or unattributed pending records are evidence
                    // that snapshot comparison alone cannot establish coverage.
                    if (object(error).code === 'ENOENT' && state.byteOffset === state.observedSize && !state.parser.pending.length) missing.push(state.parser.snapshot);
                }
                if (!saved || saved.error !== message) { updates.push({ path, state: state ?? null, error: message }); changed = true; }
            }
        }
        if (this.closed) return;
        const retired = new Set(missing.filter(prior => readable.some(next => coversSource(next, prior))).map(prior => prior.sourcePath));
        if (retired.size) changed = true;
        if (!changed) { this.store.prepareCodexUploads(); return; }
        this.store.db.exec('BEGIN');
        try {
            // Remove only source associations. Canonical traces and sent payloads
            // remain intact, and reconciliation observes the replacement atomically.
            for (const path of retired) {
                for (const table of ['codex_execution_sources', 'codex_event_sources', 'codex_source_meta']) this.store.db.prepare(`DELETE FROM ${table} WHERE sourcePath=?`).run(path);
                this.store.db.prepare('DELETE FROM codex_sources WHERE path=?').run(path);
            }
            const retainedSnapshots = snapshots.filter(snapshot => !retired.has(snapshot.sourcePath));
            const changedPaths = new Set(updates.map(update => update.path));
            // Unchanged sources already exist in canonical storage. Reconcile all
            // identities, but do not rewrite every historical event on each append.
            this.store.applyCodexSnapshots(retainedSnapshots.filter(snapshot => changedPaths.has(snapshot.sourcePath)), { prepareUploads: false });
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
                const sources = retainedSnapshots.filter(snapshot => snapshot.nativeSessionId === event.nativeSessionId);
                const found = sources.find(snapshot => snapshot.sourceKind !== 'unknown');
                const resolved = found?.sourceKind === 'background' || !!found && (!event.nativeTurnId || sources.some(snapshot => snapshot.turns.some(turn => turn.nativeTurnId === event.nativeTurnId)));
                this.store.db.prepare('UPDATE codex_receipts SET status=?,error=? WHERE id=?').run(resolved ? found!.sourceKind === 'background' ? 'filtered' : 'processed' : 'pending', resolved ? null : '等待原始会话和对应执行轮落盘', receipt.id);
            }
            this.store.prepareCodexUploads();
            this.store.db.exec('COMMIT');
            for (const path of retired) this.headers.delete(path);
            for (const update of updates) this.pendingSources.delete(update.path);
        } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    }
    async context(event: AgentEvent) {
        this.enqueue(event);
        await this.flush(true);
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
