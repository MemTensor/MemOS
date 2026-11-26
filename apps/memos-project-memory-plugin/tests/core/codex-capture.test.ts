import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { PluginService } from '../../src/server/service.ts';
import { Store } from '../../src/storage/store.ts';
import { normalizeHook } from '../../src/adapters/_shared/hooks.ts';

const row = (type: string, payload: object, ordinal: number, day = 1) => ({ type, payload, ordinal, timestamp: `2026-01-${String(day).padStart(2,'0')}T00:00:${String(ordinal).padStart(2,'0')}.000Z` });
const meta = (id: string, cwd: string, day = 1, extra = {}) => row('session_meta', { id, cwd, source: 'cli', ...extra }, 0, day);
const start = (id: string, n = 1, day = 1, extra = {}) => row('event_msg', { type: 'task_started', turn_id: id, root_turn_id: id, ...extra }, n, day);
const message = (id: string, role: string, content: string, n: number, day = 1) => row('response_item', { type: 'message', id, role, content, phase: role === 'assistant' ? 'final_answer' : undefined }, n, day);
const end = (id: string, n: number, day = 1) => row('event_msg', { type: 'task_complete', turn_id: id }, n, day);
const jsonl = (rows: unknown[]) => rows.map(x => JSON.stringify(x)).join('\n') + '\n';

async function fixture(t: any) {
    const dir = await mkdtemp(join(tmpdir(), 'pm-codex-capture-'));
    const sources = join(dir, 'sessions'), project = join(dir, 'project');
    await mkdir(sources); await mkdir(project);
    const service = new PluginService(join(dir, 'data'), { codexRoots: [sources] });
    service.store.bindProject('Fixture', project, 'space', service.config.value.baseUrl, 'codex-cli');
    service.store.db.exec("UPDATE capture_windows SET startedAt='2025-01-01T00:00:00.000Z'");
    t.after(async () => { if (service.store.db.isOpen) service.close(); await rm(dir, { recursive: true, force: true }); });
    return { dir, sources, project, service };
}

test('late child source completes its parent round and cannot create another visible session', async t => {
    const { sources, project, service } = await fixture(t);
    const parent = join(sources,'rollout-parent.jsonl');
    await writeFile(parent,jsonl([meta('parent',project),start('root'),message('u','user','delegate',2),
        row('response_item',{type:'function_call',id:'spawn',call_id:'spawn',name:'collaboration.spawn_agent',arguments:'{"task_name":"worker"}'},3),
        row('response_item',{type:'function_call_output',id:'spawn-result',call_id:'spawn',output:'{"agent_id":"child","task_name":"/root/worker"}'},4),
        message('a','assistant','parent answer',8),end('root',9)]));
    await service.event(await normalizeHook('codex-cli',{session_id:'parent',turn_id:'root',cwd:project,transcript_path:parent,hook_event_name:'Stop'}));
    assert.equal(service.store.batches().length,0);
    const child=join(sources,'rollout-child.jsonl');
    await writeFile(child,jsonl([meta('child','/temporary-worktree',1,{parent_thread_id:'parent',agent_path:'/root/worker',source:{subagent:{thread_spawn:{parent_thread_id:'parent'}}},subagent_history_start_ordinal:1}),
        start('child-turn',1,1,{root_turn_id:'root',turn_attribution:{parent_turn_id:'root',root_turn_id:'root'}}),message('cu','user','delegation',5),message('ca','assistant','child result',6),end('child-turn',7)]));
    await service.captureCodex(true);
    const sessions=service.store.state().sessions;
    assert.equal(sessions.length,1);
    assert.equal(sessions[0]!.nativeSessionId,'parent');
    const detail=service.store.sessionDetail(String(sessions[0]!.id),1,10,'turn');
    assert.equal(detail.total,1);
    assert.equal(detail.groups![0]!.traces.length,6);
    assert.equal(service.store.batches().length,1);
    assert.equal(service.store.batches()[0]!.messages.length,6);
    const archive = join(sources, 'archived_sessions');
    await mkdir(archive);
    await rename(parent, join(archive, 'rollout-parent.jsonl'));
    await rename(child, join(archive, 'rollout-child.jsonl'));
    await service.captureCodex(true);
    assert.equal(service.store.rows('SELECT captureStatus FROM codex_rounds')[0]!.captureStatus, 'complete');
    assert.equal(service.store.sessionDetail(String(sessions[0]!.id),1,10,'turn').groups![0]!.traces.length,6);
    assert.equal(service.store.rows('SELECT * FROM codex_sources WHERE path IN (?,?)',parent,child).length,0);
});

const turnRows = (project: string) => [
    meta('session', project), start('turn'), message('user', 'user', 'question', 2),
    message('answer', 'assistant', 'answer', 3), end('turn', 4),
];

test('a readable replacement with missing history cannot retire its original source', async t => {
    const { service, sources, project } = await fixture(t);
    const original = join(sources, 'rollout-live.jsonl'), archive = join(sources, 'rollout-archive.jsonl');
    const rows = turnRows(project);
    await writeFile(original, jsonl(rows));
    await service.codex.flush(true);
    await rm(original);
    await writeFile(archive, jsonl([rows[0], rows[1], rows[2], rows[4]]));
    await service.codex.flush(true);
    assert.ok(service.store.row('SELECT error FROM codex_sources WHERE path=?', original)?.error);
    assert.ok(service.store.row('SELECT 1 FROM codex_sources WHERE path=?', archive));
    assert.equal(service.store.rows('SELECT * FROM codex_event_sources WHERE sourcePath=?', original).length, 2);
});

test('unparsed trailing bytes prevent retirement even when a replacement has all parsed records', async t => {
    const { service, sources, project } = await fixture(t);
    const original = join(sources, 'rollout-live.jsonl'), archive = join(sources, 'rollout-archive.jsonl');
    const content = jsonl(turnRows(project));
    await writeFile(original, content + '{"type":');
    await service.codex.flush(true);
    await rm(original);
    await writeFile(archive, content);
    await service.codex.flush(true);
    assert.ok(service.store.row('SELECT error FROM codex_sources WHERE path=?', original)?.error);
    assert.ok(service.store.row('SELECT 1 FROM codex_sources WHERE path=?', archive));
    assert.equal(service.store.rows('SELECT * FROM codex_event_sources WHERE sourcePath=?', original).length, 2);
});

test('a receipt can resolve against an unchanged source without writing its checkpoint', async t => {
    const { service, sources, project } = await fixture(t);
    const path = join(sources, 'rollout-live.jsonl');
    await writeFile(path, jsonl(turnRows(project)));
    await service.codex.flush(true);
    const event = await normalizeHook('codex-cli', { session_id: 'session', turn_id: 'turn', cwd: project, transcript_path: path, hook_event_name: 'Stop' });
    const id = service.codex.enqueue(event);
    const getStatus = () => service.store.row('SELECT status FROM codex_receipts WHERE id=?', id)?.status;
    assert.equal(getStatus(), 'pending');
    service.store.db.exec("CREATE TEMP TRIGGER reject_checkpoint_rewrite BEFORE UPDATE ON codex_sources BEGIN SELECT RAISE(ABORT, 'unexpected checkpoint update'); END");
    await service.codex.flush(true);
    assert.equal(getStatus(), 'processed');
});

test('closing after the last rollout is read preserves its traces even if the file disappears before restart', async t => {
    const { service, sources, project, dir } = await fixture(t);
    const path = join(sources, 'rollout-final.jsonl');
    await writeFile(path, jsonl(turnRows(project)));

    // The filter runs after the file read. Close at the next microtask, the
    // earliest an independent caller can interrupt the rest of this flush.
    const allows = service.store.memory.allows.bind(service.store.memory);
    t.mock.method(service.store.memory, 'allows', (...args: Parameters<typeof allows>) => {
        queueMicrotask(() => service.close());
        return allows(...args);
    }, { times: 1 });
    await service.codex.flush(true);
    assert.equal(service.store.db.isOpen, false);

    const checkpoint = new DatabaseSync(join(dir, 'data', 'memory.sqlite'), { readOnly: true });
    try {
        const row = checkpoint.prepare('SELECT state FROM codex_sources WHERE path=?').get(path);
        assert.ok(row?.state, 'close must preserve the completed checkpoint');
    } finally { checkpoint.close(); }

    await rm(path);
    const reopened = new PluginService(join(dir, 'data'), { codexRoots: [sources] });
    try {
        await reopened.codex.flush(true);
        const messages = reopened.store.rows('SELECT message FROM traces ORDER BY id')
            .map(trace => JSON.parse(String(trace.message)).content);
        assert.deepEqual(messages, ['question', 'answer']);
    } finally { reopened.close(); }
});

test('closing while a rollout read is in flight leaves the incomplete batch uncommitted', async t => {
    const { service, sources, project, dir } = await fixture(t);
    const path = join(sources, 'rollout-in-flight.jsonl');
    await writeFile(path, jsonl(turnRows(project)));

    // Recovery looks up the last checkpoint immediately before starting the I/O.
    const row = service.store.row.bind(service.store);
    t.mock.method(service.store, 'row', (query: string, ...args: (string | number | null)[]) => {
        if (query === 'SELECT * FROM codex_source_meta WHERE sourcePath=?') queueMicrotask(() => service.close());
        return row(query, ...args);
    });
    await service.codex.flush(true);
    assert.equal(service.store.db.isOpen, false);

    const reopened = new PluginService(join(dir, 'data'), { codexRoots: [sources] });
    try {
        assert.equal(reopened.store.row('SELECT 1 FROM codex_sources WHERE path=?', path), undefined);
        assert.equal(reopened.store.rows('SELECT id FROM traces').length, 0);
        await reopened.codex.flush(true);
        assert.equal(reopened.store.rows('SELECT id FROM traces').length, 2);
    } finally { reopened.close(); }
});

test('a source unbound by another connection during recovery is quarantined before its next read', async t => {
    const { service, dir, sources, project } = await fixture(t);
    const path = join(sources, 'rollout-live.jsonl');
    await writeFile(path, jsonl(turnRows(project)));
    const scopeId = service.store.memory.resolve('codex-cli', project)!.id;
    const writer = new Store(join(dir, 'data', 'memory.sqlite'), service.config);
    try {
        await service.codex.flush(true);
        const row = service.store.row.bind(service.store);
        let unbound = false;
        t.mock.method(service.store, 'row', (sql: string, ...args: (string | number | null)[]) => {
            const result = row(sql, ...args);
            if (!unbound && sql.includes('FROM capture_windows WHERE scopeId=? AND endedAt>=?')) {
                unbound = true;
                writer.unbind(scopeId, 'space');
            }
            return result;
        });
        await service.codex.flush(true);
        assert.equal(unbound, true);
        assert.match(String(row('SELECT error FROM codex_sources WHERE path=?', path)?.error), /已隔离/);
    } finally { writer.close(); }
});

for (const validHeader of [true, false]) {
    test(`closing while the last ${validHeader ? 'valid' : 'malformed'} Codex header is read preserves the pending receipt`, async t => {
        const { service, sources, project, dir } = await fixture(t);
        const path = join(sources, 'rollout-close.jsonl'), data = join(dir, 'data');
        const transcript = jsonl(turnRows(project));
        await writeFile(path, transcript);
        const event = await normalizeHook('codex-cli', { session_id: 'session', turn_id: 'turn', cwd: project, transcript_path: path, hook_event_name: 'Stop' });
        assert.ok(await service.codex.activation(event));
        const receipt = service.codex.enqueue(event);
        assert.ok(receipt);
        service.close();

        if (!validHeader) await writeFile(path, 'malformed header\n');
        // With no discovery roots, the explicit receipt path is already being
        // opened when captureCodex returns its pending promise.
        const reader = new PluginService(data, { codexRoots: [] });
        const reading = reader.captureCodex(true);
        reader.close();
        await reading;

        await writeFile(path, transcript);
        const reopened = new PluginService(data, { codexRoots: [] });
        try {
            const status = () => reopened.store.row('SELECT status FROM codex_receipts WHERE id=?', receipt)?.status;
            assert.equal(status(), 'pending');
            assert.equal(reopened.store.row('SELECT 1 FROM codex_sources WHERE path=?', path), undefined);
            await reopened.captureCodex(true);
            assert.equal(status(), 'processed');
            assert.equal(reopened.store.rows('SELECT id FROM traces').length, 2);
        } finally { reopened.close(); }
    });
}

test('Codex activation stops if the service closes during header discovery', async t => {
    const { service, sources, project } = await fixture(t);
    await writeFile(join(sources, 'rollout-activation.jsonl'), jsonl(turnRows(project)));
    const active = service.activation({ agentType: 'codex-cli', cwd: project, nativeSessionId: 'session' });
    service.close();
    assert.equal(await active, false);
});
