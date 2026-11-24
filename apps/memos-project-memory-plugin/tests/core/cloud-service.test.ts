import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginService } from '../../src/server/service.ts';

function setup(t: { after: (fn: () => void) => void }) {
    const home = mkdtempSync(join(tmpdir(), 'pm-cloud-service-'));
    const service = new PluginService(home, { home, codexRoots: [] });
    t.after(() => { service.close(); rmSync(home, { recursive: true, force: true }); });
    service.configure({ apiMode: 'algorithm', authMode: 'none', baseUrl: 'http://localhost:9801/product', cloudProjectId: 'fixture-project' });
    return service;
}
test('open episodes continue following the same task through completed, running and final completion without resending', async t => {
    const service = setup(t), calls: string[] = [];
    let progress: Record<string, unknown> = { status: 'completed', memory_views: { project: { open_episode_messages: 2, memory_ids: [] } } };
    service.cloud.call = async (endpoint, body) => {
        calls.push(endpoint);
        if (endpoint === 'get/memory') return { topic_detail_list: [] } as any;
        if (endpoint === 'get/status') { assert.equal((body as any).user_id, service.config.value.userId); return progress as any; }
        return { success: true, task_id: 'task', status: 'running' } as any;
    };
    const project = service.store.bindProject('Project', '/fixture/project', 'space', service.config.value.baseUrl, 'qwen-code');
    const event = { agentType: 'qwen-code', nativeSessionId: 'session', cwd: '/fixture/project', turnKey: 'turn' };
    await service.event({ ...event, event: 'turn-start', records: [{ sourceId: 'user', raw: { role: 'user', content: 'fixture task', timestamp: new Date().toISOString() } }] });
    await service.event({ ...event, event: 'turn-end' });
    await service.sync();
    let delivery = service.store.row('SELECT * FROM batch_deliveries')!;
    assert.equal(delivery.status, 'accepted');
    assert.equal(delivery.processingStatus, 'accumulating');
    assert.equal(delivery.openEpisodeMessages, 2);
    assert.equal(service.deliveries.historyPending(project.scopeId, [{ nativeSessionId: 'session', sourceId: 'user' }]), 0);
    progress = { status: 'running' }; await service.sync();
    assert.equal(service.store.row('SELECT processingStatus FROM batch_deliveries')!.processingStatus, 'running');
    progress = { status: 'completed', memory_views: { project: { open_episode_messages: 0, memory_ids: ['topic'] } } };
    await service.sync();
    delivery = service.store.row('SELECT * FROM batch_deliveries')!;
    assert.equal(delivery.status, 'completed');
    assert.deepEqual(JSON.parse(String(delivery.memoryIds)), ['topic']);
    await service.sync(); assert.equal(calls.filter(endpoint => endpoint === 'add/message').length, 1);
});
test('switching away closes capture and switching back starts a new window without admitting the gap', async t => {
    const service = setup(t);
    const project = service.store.bindProject('Project', '/fixture/project', 'space', service.config.value.baseUrl, 'qwen-code');
    service.configure({ cloudProjectId: 'other-project' });
    const gap = new Date(Date.now() + 1).toISOString();
    await new Promise(resolve => setTimeout(resolve, 5));
    service.configure({ cloudProjectId: 'fixture-project' });
    assert.equal(service.store.memory.allows(project.scopeId, gap), false);
    assert.equal(service.store.rows('SELECT * FROM capture_windows WHERE scopeId=?', project.scopeId).length, 2);
    assert.equal(service.store.memory.resolve('qwen-code', '/fixture/project')?.id, project.scopeId);
});
