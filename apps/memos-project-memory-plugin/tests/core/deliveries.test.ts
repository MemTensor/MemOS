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
    for (const spaceId of ['A', 'B', 'C']) service.store.setSpaceDomains(service.config.value.baseUrl, spaceId, ['编程']);
    const project = service.store.bindProject('Project', '/project', 'A', service.config.value.baseUrl, 'claude-code');
    service.store.db.prepare('UPDATE capture_windows SET startedAt=? WHERE scopeId=?').run('2026-01-01T00:00:00.000Z', project.scopeId);
    service.store.db.prepare('UPDATE bindings SET boundAt=? WHERE objectId=?').run('2026-01-01T00:00:00.000Z', project.scopeId);
    const uploads: { space_ids: string[]; messages: { content: string }[] }[] = [];
    service.cloud.call = async (path: string, input: any) => {
        if (path === 'get/memory') return { topic_detail_list: [] } as any;
        if (path === 'get/status') return { status: 'completed', memory_views: { project: { open_episode_messages: 0, memory_ids: [] } } } as any;
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

test('live claims recheck the whole turn when late evidence overlaps a pause, even across multiple pauses', async t => {
    const { service, project, uploads, record } = setup(t);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 100 });
    const item = await record('queued', new Date().toISOString());
    service.deliveries.queueLive();
    const [queued] = service.deliveries.pending();
    assert.ok(queued);
    t.mock.timers.tick(100);
    service.configure({ paused: true });
    const lateTime = new Date().toISOString();
    t.mock.timers.tick(100);
    service.configure({ paused: false });
    t.mock.timers.tick(100);
    service.configure({ paused: true });
    t.mock.timers.tick(100);
    service.configure({ paused: false });
    service.store.capture(item.context.sessionId, [{ sourceId: 'late', nativeTurnId: 'queued',
        raw: { timestamp: lateTime, role: 'assistant', content: 'late answer' } }]);
    assert.equal(service.deliveries.ready(queued), undefined);
    await service.sync();
    assert.equal(uploads.length, 0);
    assert.equal(service.deliveries.historyPending(project.scopeId, [item, { ...item, sourceId: 'late' }]), 2);
});
