import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginService } from '../../src/server/service.ts';
import { profiles } from '../../src/adapters/registry.ts';

function setup(t: { after: (fn: () => void) => void }) {
    const home = mkdtempSync(join(tmpdir(), 'pm-overview-service-'));
    const service = new PluginService(home, { home, codexRoots: [] });
    t.after(() => { service.close(); rmSync(home, { recursive: true, force: true }); });
    service.configure({ apiKey: 'fixture-key' });
    return service;
}
test('ordinary task events only consume SQLite and never fetch an overview', async t => {
    const service = setup(t), requests: string[] = [];
    const project = service.store.bindProject('Project', '/fixture/project', 'space', service.config.value.baseUrl, 'qwen-code');
    service.cloud.call = async endpoint => { requests.push(endpoint); return { topic_detail_list: [] } as any; };
    await service.event({ agentType: 'qwen-code', nativeSessionId: 'session', cwd: '/fixture/project', event: 'turn-start', turnKey: 'first' });
    assert.deepEqual(requests, []);
    assert.equal(service.store.projectOverview(project.scopeId, 'space')?.data, null);
});
test('a failed initial overview does not turn a successful create and bind into failure', async t => {
    const service = setup(t);
    service.cloud.call = async endpoint => {
        if (endpoint === 'create/space') return { space_id: 'space', space_name: 'Space' } as any;
        throw new Error('overview offline');
    };
    const identity = { agentType: 'qwen-code', nativeSessionId: 'session', cwd: '/fixture/project', event: 'turn-start', turnKey: 'first' };
    const context = await service.createContext(identity);
    const result = await service.create({ context: context.createContext, name: 'Space', domain: '编程' });
    assert.equal(result.status, 'CREATED');
    assert.equal(result.data?.overview, null);
    assert.equal(service.store.binding(result.data!.scopeId)?.spaceIds[0], 'space');
    assert.equal(service.store.projectOverview(result.data!.scopeId, 'space')?.fetchedAt, null);
    assert.ok(service.store.rows('SELECT * FROM diagnostics').some(row => String(row.message).includes('overview offline')));
});
test('late overview result is ignored after a connection changes away and back', async t => {
    const service = setup(t);
    let release!: (value: any) => void;
    let called!: () => void;
    const calledPromise = new Promise<void>(resolve => { called = resolve; });
    service.cloud.call = async endpoint => {
        if (endpoint === 'get/space') return { space_id: 'space' } as any;
        if (endpoint === 'list/domains') return { domains: [{ domain: '编程' }] } as any;
        called(); return new Promise(resolve => { release = resolve; });
    };
    const binding = service.bindProject({ root: '/fixture/project', agentType: 'qwen-code', spaceId: 'space' });
    await Promise.race([calledPromise, binding.then(() => { throw new Error('binding returned without requesting an overview'); })]);
    const baseUrl = service.config.value.baseUrl;
    service.configure({ baseUrl: 'http://localhost:9888/other' });
    service.configure({ baseUrl });
    release({ topic_detail_list: [{ id: 'late', topic_name: 'Must not return' }] });
    const project = await binding;
    assert.equal(service.store.projectOverview(project.scopeId, 'space')?.data, null);
});
test('exactly six hours reuses cache and only a later session opening requests a refresh', async t => {
    const service = setup(t);
    let reads = 0;
    service.cloud.call = async endpoint => {
        if (endpoint === 'get/space') return { space_id: 'space' } as any;
        if (endpoint === 'list/domains') return { domains: [{ domain: '编程' }] } as any;
        reads++; return { topic_detail_list: [] } as any;
    };
    const project = await service.bindProject({ root: '/fixture/project', agentType: 'qwen-code', spaceId: 'space' });
    const instant = Date.now(), originalNow = Date.now;
    t.after(() => { Date.now = originalNow; });
    Date.now = () => instant;
    service.store.db.prepare('UPDATE project_overviews SET fetchedAt=? WHERE scopeId=?').run(new Date(instant - 6 * 60 * 60 * 1000).toISOString(), project.scopeId);
    const event = { agentType: 'qwen-code', cwd: '/fixture/project', event: 'session-start' as const };
    await service.event({ ...event, nativeSessionId: 'six-hours' }); assert.equal(reads, 1);
    Date.now = () => instant + 1;
    await service.event({ ...event, nativeSessionId: 'over-six-hours' }); assert.equal(reads, 2);
});
test('replaying a creation result after unbinding does not return the removed overview', async t => {
    const service = setup(t);
    service.cloud.call = async endpoint => (endpoint === 'create/space' ? { space_id: 'space', space_name: 'Space' }
        : { topic_detail_list: [{ id: 'topic', topic_name: 'Sensitive old overview' }] }) as any;
    const context = await service.createContext({ agentType: 'qwen-code', nativeSessionId: 'session', cwd: '/fixture/project', event: 'turn-start', turnKey: 'first' });
    const input = { context: context.createContext, name: 'Space', domain: '编程' };
    const created = await service.create(input);
    assert.match(created.data!.overview!, /Sensitive old overview/);
    service.store.unbind(created.data!.scopeId, 'space');
    const replay = await service.create(input);
    assert.equal(replay.status, 'CREATED');
    assert.equal(replay.data!.overview, null);
});
test('a new opening signal for a resumed native session can deliver a newly refreshed overview', async t => {
    const service = setup(t), profile = profiles.find(item => item.agentId === 'qwen-code')!;
    const blocking = profile.sessionStartBlocking; profile.sessionStartBlocking = true;
    t.after(() => { if (blocking === undefined) delete profile.sessionStartBlocking; else profile.sessionStartBlocking = blocking; });
    let text = 'original overview';
    service.cloud.call = async endpoint => (endpoint === 'get/space' ? { space_id: 'space' }
        : endpoint === 'list/domains' ? { domains: [{ domain: '编程' }] }
            : { topic_detail_list: [{ id: 'topic', topic_name: text }] }) as any;
    await service.bindProject({ root: '/fixture/project', agentType: 'qwen-code', spaceId: 'space' });
    const event = { agentType: 'qwen-code', nativeSessionId: 'resumed', cwd: '/fixture/project', event: 'session-start' as const };
    await service.event(event); service.store.markHostContextDelivered('qwen-code', 'resumed');
    service.store.db.prepare('UPDATE project_overviews SET fetchedAt=?').run('2020-01-01T00:00:00Z');
    text = 'latest overview';
    const resumed = await service.event(event);
    assert.match(resumed.context, /latest overview/);
    assert.equal(resumed.overviewDelivered, false);
    assert.equal(service.store.hostContextDelivered('qwen-code', 'resumed'), false);
});
