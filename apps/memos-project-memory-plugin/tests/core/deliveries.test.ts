import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginService } from '../../src/server/service.ts';

function setup(t: TestContext) {
    const dir = mkdtempSync(join(tmpdir(), 'pm-deliveries-'));
    const service = new PluginService(dir, { codexRoots: [] });
    t.after(() => { service.close(); rmSync(dir, { recursive: true, force: true }); });
    service.configure({ apiKey: 'fixture-key', paused: false });
    const project = service.store.bindProject('Project', '/project', 'A', service.config.value.baseUrl, 'claude-code');
    service.store.db.prepare('UPDATE capture_windows SET startedAt=? WHERE scopeId=?').run('2026-01-01T00:00:00.000Z', project.scopeId);
    service.store.db.prepare('UPDATE bindings SET boundAt=? WHERE objectId=?').run('2026-01-01T00:00:00.000Z', project.scopeId);
    const uploads: { space_ids: string[]; messages: { content: string }[] }[] = [];
    service.cloud.call = async (path: string, input: any) => {
        if (path === 'get/memory') return { topic_detail_list: [] } as any;
        if (path === 'get/status') return { status: 'completed' } as any;
        assert.equal(path, 'add/message'); uploads.push(input);
        return { success: true, task_id: `task-${uploads.length}`, status: 'running' } as any;
    };
    const record = async (id: string, timestamp: string) => {
        const event = { agentType: 'claude-code', nativeSessionId: 'session', cwd: '/project', turnKey: id };
        const context = await service.event({ ...event, event: 'turn-start', records: [{ sourceId: id, raw: { role: 'user', content: id, timestamp } }] });
        await service.event({ ...event, event: 'turn-end' });
        return { nativeSessionId: 'session', sourceId: id, context };
    };
    return { service, project, uploads, record };
}

test('new Space receives previous live content only through history, with independent durable receipts', async t => {
    const { service, project, uploads, record } = setup(t);
    const item = await record('first', '2026-02-01T00:00:00.000Z');
    await service.sync();
    assert.deepEqual(uploads.map(upload => upload.space_ids), [['A']]);
    service.store.bind(project.scopeId, 'B', service.config.value.baseUrl);
    await service.sync();
    assert.equal(uploads.length, 1);
    assert.equal(service.deliveries.historyPending(project.scopeId, [item]), 1);
    service.deliveries.queueHistory(project.scopeId, ['A', 'B'], [item]);
    service.deliveries.queueHistory(project.scopeId, ['A', 'B'], [item]);
    await service.sync();
    assert.deepEqual(uploads.map(upload => upload.space_ids), [['A'], ['B']]);
    assert.equal(service.deliveries.historyPending(project.scopeId, [item]), 0);
    service.store.unbind(project.scopeId, 'B');
    service.store.bind(project.scopeId, 'B', service.config.value.baseUrl);
    assert.equal(service.deliveries.historyPending(project.scopeId, [item]), 0);
});

test('failed history target retries without resending successful Space or silently expanding to a new Space', async t => {
    const { service, project, uploads, record } = setup(t);
    const item = await record('history', '2026-02-01T00:00:00.000Z');
    await service.sync();
    service.store.bind(project.scopeId, 'B', service.config.value.baseUrl);
    const call = service.cloud.call;
    let failed = 0;
    service.cloud.call = async (path, input: any) => {
        if (path === 'add/message' && input.space_ids[0] === 'B') { failed++; throw new Error('offline'); }
        return call(path, input);
    };
    service.deliveries.queueHistory(project.scopeId, ['A', 'B'], [item]);
    await service.sync(); assert.equal(failed, 2);
    assert.equal(service.deliveries.historyPending(project.scopeId, [item]), 1);
    assert.equal(service.deliveries.historyRunning(project.scopeId), false);
    assert.match(service.deliveries.historyError(project.scopeId)!, /offline/);
    service.cloud.call = call;
    service.deliveries.queueHistory(project.scopeId, ['A', 'B'], [item]);
    service.store.bind(project.scopeId, 'C', service.config.value.baseUrl);
    await service.sync();
    assert.deepEqual(uploads.map(upload => upload.space_ids), [['A'], ['B']]);
    assert.equal(service.deliveries.historyPending(project.scopeId, [item]), 1);
    assert.equal(service.deliveries.historyError(project.scopeId), undefined);
});

test('history status reports local blockers without pretending to send or changing pause configuration', async t => {
    const { service, project, uploads, record } = setup(t);
    const item = await record('history-status', '2026-02-01T00:00:00.000Z');
    service.history.refresh = async () => {};
    service.history.status = () => ({ status: 'ready', recordCount: 1 });
    service.history.catalog = () => [item];
    const history = () => service.state().bindings.find(row => row.id === project.scopeId)!.history;
    service.configure({ paused: true });
    assert.match(history().uploadError!, /暂停/); assert.equal(history().uploading, false);
    service.configure({ paused: false, apiKey: '' });
    assert.match(history().uploadError!, /API Key/);
    service.configure({ apiKey: 'fixture-key', baseUrl: 'https://other.invalid' });
    assert.match(history().uploadError!, /连接/);
    assert.equal(uploads.length, 0);
    service.configure({ baseUrl: service.store.memory.get(project.scopeId)!.baseUrl });
    await service.sync();
    service.configure({ paused: true });
    assert.equal(history().pending, 0); assert.equal(history().uploadError, undefined, 'later pausing cannot turn successful history into failure');
    assert.equal(service.config.value.paused, true);
});

test('cloud processing failure remains visible even after upload was accepted', async t => {
    const { service, project, record } = setup(t);
    const item = await record('processing-error', '2026-02-01T00:00:00.000Z');
    const call = service.cloud.call;
    service.cloud.call = async (path, input) => path === 'get/status' ? { status: 'failed' } as any : call(path, input);
    service.deliveries.queueHistory(project.scopeId, ['A'], [item]);
    await service.sync();
    assert.equal(service.deliveries.historyPending(project.scopeId, [item]), 0);
    assert.match(service.deliveries.historyError(project.scopeId)!, /云端处理失败/);
    service.store.unbind(project.scopeId, 'A');
    assert.equal(service.deliveries.historyError(project.scopeId), undefined, 'removed destinations do not keep the current binding in error');
});

test('oversized history exposes a blocking reason without making a network request', async t => {
    const { service, project, uploads, record } = setup(t);
    const item = await record('x'.repeat(40000), '2026-02-01T00:00:00.000Z');
    service.deliveries.queueHistory(project.scopeId, ['A'], [item]);
    await service.sync();
    assert.equal(uploads.length, 0);
    assert.match(service.deliveries.historyError(project.scopeId)!, /容量/);
    assert.equal(service.deliveries.historyRunning(project.scopeId), false);
});

test('post-binding suffix and manually imported prefix are each sent once per Space', async t => {
    const { service, project, uploads, record } = setup(t);
    const suffix = await record('suffix', '2026-02-01T00:00:00.000Z');
    await service.sync();
    service.store.db.prepare('INSERT INTO traces(sessionId,conversationId,sourceId,raw,message,createdAt) VALUES(?,?,?,?,?,?)')
        .run(suffix.context.sessionId, suffix.context.conversationId, 'prefix', JSON.stringify({ role: 'user', content: 'prefix', timestamp: '2025-12-01T00:00:00.000Z' }), JSON.stringify({ role: 'user', content: 'prefix' }), '2025-12-01T00:00:00.000Z');
    const catalog = [{ nativeSessionId: 'session', sourceId: 'prefix' }, suffix];
    service.store.bind(project.scopeId, 'B', service.config.value.baseUrl);
    service.deliveries.queueHistory(project.scopeId, ['A', 'B'], catalog);
    await service.sync();
    assert.deepEqual(uploads.filter(upload => upload.space_ids[0] === 'A').flatMap(upload => upload.messages.map(message => message.content)), ['suffix', 'prefix']);
    assert.deepEqual(uploads.filter(upload => upload.space_ids[0] === 'B').flatMap(upload => upload.messages.map(message => message.content)), ['prefix', 'suffix']);
    assert.equal(service.deliveries.historyPending(project.scopeId, catalog), 0);
});

test('last unbind prevents queued live upload and keeps stored trajectories', async t => {
    const { service, project, uploads, record } = setup(t);
    await record('queued', '2026-02-01T00:00:00.000Z');
    service.deliveries.queueLive();
    const traces = service.store.rows('SELECT * FROM traces');
    service.store.unbind(project.scopeId, 'A');
    await service.sync();
    assert.equal(uploads.length, 0);
    assert.deepEqual(service.store.rows('SELECT * FROM traces'), traces);
});

test('failed in-flight request cannot revive a cancelled delivery after unbind and rebind', async t => {
    const { service, project, uploads, record } = setup(t);
    await record('cancel-during-send', '2026-02-01T00:00:00.000Z');
    let attempts = 0;
    service.cloud.call = async () => {
        attempts++;
        service.store.unbind(project.scopeId, 'A');
        service.store.bind(project.scopeId, 'A', service.config.value.baseUrl);
        throw new Error('connection lost');
    };
    await service.sync();
    assert.equal(attempts, 1); assert.equal(uploads.length, 0);
    assert.equal(service.store.row('SELECT status FROM batch_deliveries')?.status, 'cancelled');
    await service.sync(); assert.equal(attempts, 1);
});
