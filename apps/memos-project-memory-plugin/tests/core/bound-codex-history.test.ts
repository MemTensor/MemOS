import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/storage/store.ts';
import { CodexCapture } from '../../src/server/codex-capture.ts';
import { HistoryService } from '../../src/server/history.ts';
const timestamp = (n: number) => `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`;
const row = (type: string, payload: object, n: number) => JSON.stringify({ type, payload, timestamp: timestamp(n) }) + '\n';
const meta = (cwd: string) => row('session_meta', { id: 'main', cwd, source: 'cli' }, 0);
const start = (id: string, n: number) => row('event_msg', { type: 'task_started', turn_id: id }, n);
const message = (id: string, role: string, content: string, n: number) => row('response_item', { type: 'message', id, role, content }, n);
const end = (id: string, n: number) => row('event_msg', { type: 'task_complete', turn_id: id }, n);
async function fixture(t: TestContext) {
    const directory = await mkdtemp(join(tmpdir(), 'pm-binding-')), sources = join(directory, 'sessions'), project = join(directory, 'project');
    await mkdir(sources); await mkdir(project);
    const store = new Store(':memory:'), capture = new CodexCapture(store, { codexRoots: [sources] }), history = new HistoryService(store, { codexRoots: [sources], home: directory });
    t.after(async () => { capture.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
    const bind = () => {
        store.bindProject('project', project, 'space', 'http://cloud', 'codex-cli');
        const scope = store.memory.resolve('codex-cli', project)!;
        store.db.prepare('UPDATE capture_windows SET startedAt=? WHERE scopeId=? AND endedAt IS NULL').run(timestamp(10), scope.id);
        return scope;
    };
    return { directory, project, sources, path: join(sources, 'rollout-main.jsonl'), store, capture, history, bind };
}
test('unbound Codex reads only identities; binding admits the latter half of a live turn without retaining old text', async t => {
    const f = await fixture(t);
    await writeFile(f.path, meta(f.project) + start('turn', 1) + message('u', 'user', 'private old text', 2));
    assert.equal(await f.capture.activation({ agentType: 'codex-cli', nativeSessionId: 'main', cwd: '/wrong-tool-directory' }), false);
    f.capture.enqueue({ agentType: 'codex-cli', nativeSessionId: 'main', cwd: f.project, event: 'turn-end' });
    await f.capture.flush(true);
    for (const table of ['sessions', 'traces', 'codex_receipts', 'codex_sources']) assert.equal(f.store.rows(`SELECT * FROM ${table}`).length, 0);
    f.bind();
    assert.equal(await f.capture.activation({ agentType: 'codex-cli', nativeSessionId: 'main', cwd: '/wrong-tool-directory' }), true);
    await f.capture.flush(true);
    assert.equal(f.store.rows('SELECT * FROM sessions').length, 0);
    await appendFile(f.path, message('a', 'assistant', 'new answer', 11) + end('turn', 12));
    await f.capture.flush(true);
    assert.equal(f.store.rows('SELECT * FROM traces').length, 1);
    assert.equal(f.store.rows('SELECT captureStatus FROM codex_rounds')[0]?.captureStatus, 'complete');
    assert.ok(!JSON.stringify(f.store.rows('SELECT state FROM codex_sources')).includes('private old text'));
});
test('unbind freezes sources; rebind excludes the disabled interval; history fills old records without changing sent payload', async t => {
    const f = await fixture(t), scope = f.bind();
    await writeFile(f.path, meta(f.project) + start('turn', 1) + message('u', 'user', 'old task', 2) + message('a', 'assistant', 'new answer', 11) + end('turn', 12));
    await f.capture.flush(true);
    const batch = f.store.batches()[0]!;
    assert.ok(batch);
    f.store.db.prepare("UPDATE batches SET attempts=1,uploaded=1,status='accepted' WHERE id=?").run(batch.id);
    const before = f.store.rows('SELECT * FROM codex_sources');
    f.store.unbind(scope.id, 'space');
    f.store.db.prepare('UPDATE capture_windows SET endedAt=? WHERE scopeId=?').run(timestamp(15), scope.id);
    await appendFile(f.path, start('disabled', 16) + message('skip', 'user', 'disabled task', 17) + end('disabled', 18));
    await f.capture.flush(true);
    assert.deepEqual(f.store.rows('SELECT * FROM codex_sources'), before);
    f.store.bind(scope.id, 'space', 'http://cloud');
    f.store.db.prepare('UPDATE capture_windows SET startedAt=? WHERE scopeId=? AND endedAt IS NULL').run(timestamp(20), scope.id);
    await appendFile(f.path, start('later', 21) + message('new', 'user', 'new task', 22) + end('later', 23));
    await f.capture.flush(true);
    assert.equal(f.store.rows('SELECT * FROM traces').length, 2);
    assert.equal(f.store.rows('SELECT * FROM traces WHERE sessionId IS NOT NULL AND conversationId IS NOT NULL').length, 2);
    assert.equal(f.store.rows("SELECT * FROM codex_rounds WHERE captureStatus='complete'").length, 2);
    const visible = f.store.state().sessions[0]!;
    assert.equal(f.store.sessionDetail(String(visible.id),1,10,'turn').total, 2);
    await f.history.scan(scope.id);
    assert.equal(f.history.status(scope.id).status, 'ready');
    assert.equal(f.store.rows('SELECT * FROM traces').length, 2);
    assert.equal(f.history.catalog(scope.id).length, 4);
    await f.history.materialize(scope.id);
    assert.equal(f.store.rows('SELECT * FROM traces').length, 4);
    assert.deepEqual(f.store.batches().find(item => item.id === batch.id)?.messages, batch.messages);
    await f.history.materialize(scope.id);
    await f.capture.flush(true);
    assert.equal(f.store.rows('SELECT * FROM traces WHERE conversationId IS NOT NULL').length, 4);
});
test('DSH compressed history is indexed without content storage and imported idempotently', async t => {
    const f = await fixture(t);
    const { zstdCompressSync } = await import('node:zlib');
    const directory = join(f.directory, '.dsh', 'sessions', 'project', 'session'); await mkdir(directory, { recursive: true });
    const rows = [
        { type: 'session', id: 'dsh', cwd: f.project },
        { type: 'user/message', seq: 1, timestamp: timestamp(1), data: { id: 'user', role: 'user', source: { kind: 'user' }, content: 'old task' } },
        { type: 'assistant/message', seq: 2, timestamp: timestamp(2), data: { message: { id: 'answer', role: 'assistant', content: 'old answer' } } },
        { type: 'turn/end', seq: 3, timestamp: timestamp(3) },
    ];
    await writeFile(join(directory, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n')));
    f.store.bindProject('project', f.project, 'space', 'http://cloud', 'deepseek-harness');
    const scope = f.store.memory.resolve('deepseek-harness', f.project)!;
    await f.history.scan(scope.id);
    assert.deepEqual(f.history.catalog(scope.id).map(row => row.sourceId), ['message:user', 'message:answer']);
    assert.equal(f.store.rows('SELECT * FROM traces').length, 0);
    await f.history.materialize(scope.id); await f.history.materialize(scope.id);
    assert.equal(f.store.rows('SELECT * FROM traces').length, 2);
    assert.equal(f.store.batches().length, 0);
});
for (const agent of ['opencode-v1', 'opencode-v2']) test(`${agent} scans native SQLite metadata and imports completed message parts`, async t => {
    const f = await fixture(t), { DatabaseSync } = await import('node:sqlite');
    const directory = join(f.directory, '.local', 'share', 'opencode'); await mkdir(directory, { recursive: true });
    const db = new DatabaseSync(join(directory, 'opencode.db')), suffix = agent === 'opencode-v2' ? '_v2' : '';
    db.exec(`CREATE TABLE session${suffix}(id TEXT,directory TEXT); CREATE TABLE message${suffix}(id TEXT,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part${suffix}(id TEXT,message_id TEXT,time_created INTEGER,data TEXT);`);
    db.prepare(`INSERT INTO session${suffix} VALUES(?,?)`).run('native-open', f.project);
    for (const [id, role, at] of [['u', 'user', 1], ['a', 'assistant', 2]] as const) {
        db.prepare(`INSERT INTO message${suffix} VALUES(?,?,?,?)`).run(id, 'native-open', Date.parse(timestamp(at)), JSON.stringify({ role, time: { created: Date.parse(timestamp(at)), ...(role === 'assistant' ? { completed: Date.parse(timestamp(3)) } : {}) }, finish: 'stop' }));
        db.prepare(`INSERT INTO part${suffix} VALUES(?,?,?,?)`).run(`part-${id}`, id, Date.parse(timestamp(at)), JSON.stringify({ type: 'text', text: id }));
    }
    db.close();
    f.store.bindProject('project', f.project, 'space', 'http://cloud', agent);
    const scope = f.store.memory.resolve(agent, f.project)!;
    await f.history.scan(scope.id); assert.equal(f.history.status(scope.id).status, 'ready');
    assert.equal(f.history.status(scope.id).recordCount, 2);
    assert.equal(f.store.rows('SELECT * FROM traces').length, 0);
    await f.history.materialize(scope.id); await f.history.materialize(scope.id);
    assert.equal(f.store.rows('SELECT * FROM traces').length, 2);
    assert.equal(f.store.batches().length, 0);
});
for (const agent of ['kimi-code', 'workbuddy']) test(`${agent} resolves host history paths and completed turns`, async t => {
    const f = await fixture(t), root = join(f.directory, agent === 'kimi-code' ? '.kimi-code' : '.workbuddy');
    let path: string;
    if (agent === 'kimi-code') {
        const sessionDir = join(root, 'sessions', 'project', 'native');
        path = join(sessionDir, 'agents', 'main', 'wire.jsonl'); await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true });
        await writeFile(join(root, 'session_index.jsonl'), JSON.stringify({ sessionId: 'native', sessionDir, workDir: f.project }) + '\n');
    } else {
        await mkdir(join(root, 'projects', 'project'), { recursive: true });
        path = join(root, 'projects', 'project', 'native.jsonl');
        await writeFile(path.replace('.jsonl', '.meta.json'), JSON.stringify({ sessionId: 'native', cwd: f.project }));
    }
    await writeFile(path, [
        { id: 'u', role: 'user', content: 'task', timestamp: timestamp(1), sessionId: 'native', cwd: f.project },
        { id: 'a', role: 'assistant', content: 'answer', status: 'completed', timestamp: timestamp(2) },
        { type: 'turn.end', timestamp: timestamp(3) },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    f.store.bindProject('project', f.project, 'space', 'http://cloud', agent);
    const scope = f.store.memory.resolve(agent, f.project)!;
    await f.history.scan(scope.id);
    assert.equal(f.history.status(scope.id).status, 'ready'); assert.equal(f.history.catalog(scope.id).length, 2);
    await f.history.materialize(scope.id); assert.equal(f.store.rows('SELECT * FROM traces').length, 2);
});
test('unsupported hosts disclose SQLite-only history; refresh tracks newly completed turns without rescanning unchanged data', async t => {
    const f = await fixture(t), agent = 'prime-agent';
    f.store.bindProject('project', f.project, 'space', 'http://cloud', agent);
    const scope = f.store.memory.resolve(agent, f.project)!, session = f.store.registerSession({ agentType: agent, nativeSessionId: 'native', cwd: f.project });
    await f.history.refresh(scope.id);
    assert.equal(f.history.status(scope.id).status, 'ready');
    assert.match(f.history.status(scope.id).warning!, /仅包含插件已采集会话/);
    f.store.startTurn(session.id, 'first');
    f.store.capture(session.id, [{ sourceId: 'one', raw: { role: 'user', content: 'live', timestamp: new Date(Date.now() + 5).toISOString() } }]);
    f.store.finalizeTurn(session.id, 'first');
    await f.history.refresh(scope.id);
    assert.equal(f.history.catalog(scope.id).length, 1);
    const original = f.history.status(scope.id).cutoff;
    await f.history.refresh(scope.id); assert.equal(f.history.status(scope.id).cutoff, original);
    await f.history.materialize(scope.id); assert.equal(f.store.rows('SELECT * FROM traces').length, 1);
});
test('completed roots update from SQLite; an explicit history scan includes the pre-binding prefix', async t => {
    const f = await fixture(t), scope = f.bind();
    await writeFile(f.path, meta(f.project) + start('unfinished', 1) + message('u', 'user', 'old prefix', 2));
    await f.history.scan(scope.id); assert.equal(f.history.catalog(scope.id).length, 0);
    await appendFile(f.path, message('a', 'assistant', 'new suffix', 11) + end('unfinished', 12));
    await f.capture.flush(true);
    await f.history.refresh(scope.id);
    assert.equal(f.history.catalog(scope.id).length, 1);
    await f.history.scan(scope.id);
    assert.equal(f.history.catalog(scope.id).length, 2);
    assert.equal(f.store.rows('SELECT * FROM traces').length, 1);
});
test('failed scans keep their signature so polling does not retry the same broken source', async t => {
    const f = await fixture(t), scope = f.bind();
    const scanner = f.history as any;
    let reads = 0;
    scanner.sources = async () => { reads++; throw new Error('unavailable source'); };
    await f.history.scan(scope.id);
    await f.history.refresh(scope.id); await f.history.refresh(scope.id);
    assert.equal(f.history.status(scope.id).status, 'failed'); assert.equal(reads, 1);
    await f.history.scan(scope.id); assert.equal(reads, 2);
});
for (const operation of ['scan', 'materialize'] as const) test(`${operation} is cancelled if the Agent project is unbound and rebound while source I/O is pending`, async t => {
    const f = await fixture(t), scope = f.bind();
    await writeFile(f.path, meta(f.project) + start('old', 1) + message('u', 'user', 'old task', 2) + end('old', 3));
    if (operation === 'materialize') await f.history.scan(scope.id);
    const scanner = f.history as any, original = scanner.codex.bind(scanner);
    let release!: () => void, reached!: () => void;
    const ready = new Promise<void>(resolve => { reached = resolve; });
    scanner.codex = async (...args: unknown[]) => {
        const result = await original(...args); reached();
        await new Promise<void>(resolve => { release = resolve; }); return result;
    };
    const pending = f.history[operation](scope.id);
    await ready;
    f.store.unbind(scope.id, 'space'); f.store.bind(scope.id, 'space', 'http://cloud');
    f.store.db.prepare('UPDATE capture_windows SET startedAt=? WHERE scopeId=? AND endedAt IS NULL').run(timestamp(20), scope.id);
    release();
    if (operation === 'materialize') await assert.rejects(pending, /绑定已变化/);
    else { await pending; assert.equal(f.history.status(scope.id).status, 'failed'); }
    assert.equal(f.store.rows('SELECT * FROM traces').length, 0);
});
test('a catalog cannot import into its former project after a nested project gains its own binding', async t => {
    const f = await fixture(t), scope = f.bind(), nested = join(f.project, 'nested');
    await mkdir(nested);
    await writeFile(f.path, meta(nested) + start('old', 1) + message('u', 'user', 'old task', 2) + end('old', 3));
    await f.history.scan(scope.id); assert.equal(f.history.catalog(scope.id).length, 1);
    f.store.bindProject('nested', nested, 'other-space', 'http://cloud', 'codex-cli');
    await assert.rejects(f.history.materialize(scope.id), /归属或源身份已变化/);
    assert.equal(f.store.rows('SELECT * FROM traces').length, 0);
});
test('canonical source associations restore a filtered reader and keep prior rounds visible after rebind without history import', async t => {
    const f = await fixture(t), scope = f.bind();
    await writeFile(f.path, meta(f.project) + start('first', 10) + message('first-user', 'user', 'first accepted task', 11) + end('first', 12));
    await f.capture.flush(true);
    const sessionId = String(f.store.state().sessions[0]!.id), firstTrace = f.store.rows('SELECT * FROM traces')[0]!;
    f.store.unbind(scope.id, 'space'); f.store.bind(scope.id, 'space', 'http://cloud');
    f.store.db.prepare('UPDATE capture_windows SET startedAt=? WHERE scopeId=? AND endedAt IS NULL').run(timestamp(20), scope.id);
    const state = JSON.parse(String(f.store.row('SELECT state FROM codex_sources WHERE path=?', f.path)!.state));
    state.parser.snapshot.turns = [];
    f.store.db.prepare('UPDATE codex_sources SET state=? WHERE path=?').run(JSON.stringify(state), f.path);
    await appendFile(f.path, start('second', 21) + message('second-user', 'user', 'second accepted task', 22) + end('second', 23));
    await f.capture.flush(true);
    assert.equal(f.store.sessionDetail(sessionId, 1, 10, 'turn').total, 2);
    assert.deepEqual(f.store.row('SELECT * FROM traces WHERE id=?', Number(firstTrace.id)), firstTrace);
    assert.equal(f.store.rows('SELECT * FROM traces WHERE sessionId=? AND conversationId IS NOT NULL', sessionId).length, 2);
    assert.equal(f.store.rows("SELECT * FROM codex_rounds WHERE ownerSessionId=? AND captureStatus='complete'", sessionId).length, 2);
    assert.equal(f.history.status(scope.id).status, 'pending');
});
test('reconciling another bound project leaves an unbound project session, rounds, traces, contexts and batches frozen', async t => {
    const f = await fixture(t), scope = f.bind();
    await writeFile(f.path, meta(f.project) + start('first', 10) + message('first-user', 'user', 'accepted task', 11) + end('first', 12));
    await f.capture.flush(true);
    const sessionId = String(f.store.state().sessions[0]!.id);
    f.store.unbind(scope.id, 'space');
    const frozen = () => ({
        session: f.store.session(sessionId), rounds: f.store.rows('SELECT * FROM codex_rounds WHERE ownerSessionId=?', sessionId),
        traces: f.store.rows('SELECT * FROM traces WHERE sessionId=?', sessionId), batches: f.store.rows('SELECT * FROM batches WHERE sessionId=?', sessionId),
        turns: f.store.rows('SELECT * FROM turns WHERE sessionId=?', sessionId), maps: f.store.rows('SELECT * FROM codex_execution_map WHERE ownerSessionId=?', sessionId),
        source: f.store.rows('SELECT * FROM codex_sources WHERE path=?', f.path),
    });
    const expected = frozen(), other = join(f.directory, 'other'); await mkdir(other);
    f.store.bindProject('other', other, 'other-space', 'http://cloud', 'codex-cli');
    f.store.db.exec("UPDATE capture_windows SET startedAt='2025-01-01T00:00:00.000Z' WHERE endedAt IS NULL");
    await writeFile(join(f.sources, 'rollout-other.jsonl'), meta(other).replace('"id":"main"', '"id":"other"') + start('other-turn', 10) + message('other-user', 'user', 'other task', 11) + end('other-turn', 12));
    await f.capture.flush(true);
    assert.deepEqual(frozen(), expected);
    assert.equal(f.store.state().sessions.length, 2);
});
test('ordinary capture freezes legacy sessions that have never had an Agent binding', async t => {
    const f = await fixture(t); f.bind();
    const { parseCodexRollout } = await import('../../src/adapters/codex-cli/rollout.ts');
    const snapshot = parseCodexRollout(meta('/legacy-unbound').replace('"id":"main"', '"id":"legacy"') + start('legacy-turn', 1) + message('legacy-user', 'user', 'retained legacy task', 2) + end('legacy-turn', 3), '/legacy-rollout.jsonl');
    f.store.applyCodexSnapshots([snapshot], { prepareUploads: true });
    const legacy = f.store.rows("SELECT * FROM sessions WHERE nativeSessionId='legacy'")[0]!;
    // Old source metadata may disagree with its last displayed state; an unrelated
    // capture must not silently run a repair on this unbound session.
    f.store.db.prepare("UPDATE codex_source_meta SET gaps='[\"source_unavailable\"]' WHERE nativeSessionId='legacy'").run();
    const retained = () => ({ session: f.store.session(String(legacy.id)), traces: f.store.rows('SELECT * FROM traces WHERE sessionId=?', String(legacy.id)),
        rounds: f.store.rows('SELECT * FROM codex_rounds WHERE ownerSessionId=?', String(legacy.id)), batches: f.store.rows('SELECT * FROM batches WHERE sessionId=?', String(legacy.id)) });
    const before = retained();
    await writeFile(f.path, meta(f.project) + start('bound-turn', 10) + message('bound-user', 'user', 'new bound task', 11) + end('bound-turn', 12));
    await f.capture.flush(true);
    assert.deepEqual(retained(), before);
});
