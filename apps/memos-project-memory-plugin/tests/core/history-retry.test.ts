import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PluginService } from '../../src/server/service.ts';

async function setup(t: TestContext, huge = false) {
    const dir = await mkdtemp(join(tmpdir(), 'pm-history-retry-')), sources = join(dir, 'sources');
    await mkdir(sources);
    const row = (type: string, payload: object, second: number) => JSON.stringify({ type, payload, timestamp: `2020-01-01T00:00:0${second}Z` });
    await writeFile(join(sources, 'rollout-history.jsonl'), [
        row('session_meta', { id: 'history', cwd: '/project', source: 'cli' }, 0),
        row('event_msg', { type: 'task_started', turn_id: 'turn' }, 1),
        ...['user', 'assistant', 'assistant'].map((role, index) => row('response_item', {
            type: 'message', id: `message-${index}`, role, content: `${index}:` + '甲'.repeat(100),
            ...index === 2 ? { phase: 'final_answer' } : {},
        }, index + 2)),
        ...huge ? [row('response_item', { type: 'message', id: 'huge', role: 'assistant', content: '大'.repeat(2000) }, 5)] : [],
        row('event_msg', { type: 'task_complete', turn_id: 'turn' }, 6),
    ].join('\n') + '\n');
    const data = join(dir, 'data');
    let service = new PluginService(data, { home: dir, codexRoots: [sources] });
    t.after(async () => { service.close(); await rm(dir, { recursive: true, force: true }); });
    service.configure({ apiKey: 'fixture-key', uploadMaxBytes: 39000 });
    for (const id of ['A', 'B']) service.store.setSpaceDomains(service.config.value.baseUrl, id, ['编程']);
    const project = service.store.bindProject('Project', '/project', 'A', service.config.value.baseUrl, 'codex-cli');
    await service.history.scan(project.scopeId);
    const catalog = await service.history.materialize(project.scopeId);
    const uploads: any[] = [];
    const send = async (path: string, body: any): Promise<any> => {
        if (path === 'get/status') return { status: 'completed', memory_views: { project: { open_episode_messages: 0, memory_ids: [] } } };
        assert.equal(path, 'add/message'); uploads.push(body);
        return { success: true, task_id: `task-${uploads.length}`, status: 'running' };
    };
    service.cloud.call = send;
    return { service, project, catalog, uploads, send, async restart() {
        service.close(); service = new PluginService(data, { home: dir, codexRoots: [sources] });
        service.cloud.call = send;
        await service.history.scan(project.scopeId);
        return service;
    } };
}

test('legacy unsent capacity failure can be explicitly retried and oversized messages stay local', async t => {
    const { service, project, catalog, uploads } = await setup(t, true);
    service.deliveries.queueHistory(project.scopeId, ['A'], catalog);
    const old = service.store.row('SELECT * FROM batches')!;
    const error = '整轮轨迹超出保守上传容量；完整内容已保留';
    service.store.db.prepare("UPDATE batches SET status='blocked',error=? WHERE id=?").run(error, String(old.id));
    service.store.db.prepare("UPDATE batch_deliveries SET status='blocked',error=? WHERE batchId=?").run(error, String(old.id));
    service.configure({ uploadMaxBytes: 800 });
    assert.equal(service.bindingState()[0]!.history.canUpload, true);
    await service.uploadHistory(project.scopeId);
    assert.equal(uploads.length, 3);
    assert.ok(uploads.every(body => Buffer.byteLength(JSON.stringify(body)) <= 800));
    assert.equal(service.store.row('SELECT status,messages FROM batches WHERE id=?', String(old.id))?.status, 'cancelled');
    assert.equal(service.store.row('SELECT messages FROM batches WHERE id=?', String(old.id))?.messages, old.messages);
    assert.equal(service.store.row("SELECT COUNT(*) AS count FROM batch_deliveries WHERE status='skipped'")?.count, 1);
    assert.equal(service.deliveries.historyError(project.scopeId), undefined);
    assert.equal(service.bindingState()[0]!.history.pending, 0);
});

test('manual retry spans multiple batches despite old failures and preserves successful destinations and receipts', async t => {
    const fixture = await setup(t), { service, project, catalog, uploads, send } = fixture;
    service.deliveries.queueHistory(project.scopeId, ['A'], catalog); await service.sync();
    service.store.bind(project.scopeId, 'B', service.config.value.baseUrl);
    let failures = 0;
    service.cloud.call = async () => { failures++; throw new Error('offline'); };
    service.deliveries.queueHistory(project.scopeId, ['B'], catalog); await service.sync();
    assert.equal(failures, 2);
    const old = service.store.row("SELECT * FROM batch_deliveries WHERE status='failed'")!;
    service.configure({ uploadMaxBytes: 800 });
    let running = true;
    service.cloud.call = async (path, body) => path === 'get/status' && running ? { status: 'running' } as any : send(path, body);
    await service.uploadHistory(project.scopeId);
    const progress = service.bindingState()[0]!.history;
    assert.equal(progress.uploading, true); assert.equal(progress.canUpload, false);
    assert.equal(progress.uploadError, undefined);
    assert.equal(uploads.length, 2);
    await service.uploadHistory(project.scopeId); assert.equal(uploads.length, 2);
    running = false; await service.sync();
    assert.equal(uploads.length, 4);
    assert.deepEqual(uploads.map(body => body.space_ids), [['A'], ['B'], ['B'], ['B']]);
    assert.equal(service.deliveries.historyError(project.scopeId), undefined);
    assert.equal(service.bindingState()[0]!.history.pending, 0);
    assert.deepEqual(service.store.row('SELECT * FROM batch_deliveries WHERE batchId=?', String(old.batchId)), old);
    const restarted = await fixture.restart(); await restarted.uploadHistory(project.scopeId);
    assert.equal(uploads.length, 4);
});
