import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Configuration } from '../../src/config/config.ts';
import { Store } from '../../src/storage/store.ts';

function setup(t: TestContext) {
    const directory = mkdtempSync(join(tmpdir(), 'pm-overview-store-'));
    const config = new Configuration(directory);
    config.update({ baseUrl: 'http://localhost:9801/product', apiMode: 'algorithm', cloudProjectId: 'fixture' });
    const path = join(directory, 'memory.sqlite');
    let store = new Store(path, config);
    t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
    const project = store.bindProject('Project', '/fixture/project', 'A', config.value.baseUrl, 'qwen-code');
    const save = (spaceId: string, data: Record<string, unknown>) => store.saveProjectOverview(project.scopeId, store.connectionId(), spaceId,
        String(store.row('SELECT boundAt FROM bindings WHERE objectId=? AND spaceId=?', project.scopeId, spaceId)!.boundAt), data);
    return { config, project, save, get store() { return store; }, restart() { store.close(); store = new Store(path, config); return store; } };
}

test('binding creates an unknown per-Space overview and successful empty data survives restart', t => {
    const f = setup(t);
    assert.deepEqual(f.store.projectOverview(f.project.scopeId, 'A'), { data: null, fetchedAt: null });
    assert.equal(f.save('A', { topic_detail_list: [] }), true);
    const saved = f.store.projectOverview(f.project.scopeId, 'A')!;
    assert.deepEqual(saved.data, { topic_detail_list: [] });
    assert.ok(Number.isFinite(Date.parse(saved.fetchedAt!)));
    f.store.bind(f.project.scopeId, 'A', f.config.value.baseUrl);
    assert.deepEqual(f.store.projectOverview(f.project.scopeId, 'A'), saved);
    assert.deepEqual(f.restart().projectOverview(f.project.scopeId, 'A'), saved);
});

test('project overview merges only current bound Spaces, deduplicates IDs and does not cross scopes', t => {
    const f = setup(t);
    f.store.bind(f.project.scopeId, 'B', f.config.value.baseUrl);
    f.save('A', { topic_detail_list: [{ id: 'shared', topic_name: 'A' }, { topic_name: 'without ID' }] });
    f.save('B', { topic_detail_list: [{ id: 'shared', topic_name: 'B' }, { id: 'second', topic_name: 'Second' }] });
    assert.deepEqual(f.store.projectOverviewData(f.project.scopeId).topic_detail_list.map(topic => topic.topic_name), ['B', 'without ID', 'Second']);
    const other = f.store.bindProject('Other', '/fixture/other', 'A', f.config.value.baseUrl, 'qwen-code');
    assert.deepEqual(f.store.projectOverview(other.scopeId, 'A'), { data: null, fetchedAt: null });
    assert.deepEqual(f.store.projectOverviewData(other.scopeId), { topic_detail_list: [] });
    const otherAgent = f.store.bindProject('Project', '/fixture/project', 'A', f.config.value.baseUrl, 'claude-code');
    assert.deepEqual(f.store.projectOverview(otherAgent.scopeId, 'A'), { data: null, fetchedAt: null });
    f.store.unbind(f.project.scopeId, 'A');
    assert.equal(f.store.projectOverview(f.project.scopeId, 'A'), undefined);
    assert.deepEqual(f.store.projectOverviewData(f.project.scopeId).topic_detail_list.map(topic => topic.topic_name), ['B', 'Second']);
    assert.equal(f.store.rows('SELECT * FROM project_overviews WHERE scopeId=? AND spaceId=?', f.project.scopeId, 'A').length, 0);
});

test('a late response cannot restore an unbound cache or overwrite a same-millisecond rebind', t => {
    const f = setup(t), identity = f.store.connectionId();
    const old = String(f.store.row('SELECT boundAt FROM bindings WHERE objectId=? AND spaceId=?', f.project.scopeId, 'A')!.boundAt);
    f.store.unbind(f.project.scopeId, 'A');
    assert.equal(f.store.saveProjectOverview(f.project.scopeId, identity, 'A', old, { topic_detail_list: [{ id: 'stale' }] }), false);
    const dateNow = Date.now;
    Date.now = () => Date.parse(old);
    try { f.store.bind(f.project.scopeId, 'A', f.config.value.baseUrl); } finally { Date.now = dateNow; }
    const rebound = String(f.store.row('SELECT boundAt FROM bindings WHERE objectId=? AND spaceId=?', f.project.scopeId, 'A')!.boundAt);
    assert.notEqual(rebound, old);
    assert.equal(f.store.saveProjectOverview(f.project.scopeId, identity, 'A', old, { topic_detail_list: [{ id: 'stale' }] }), false);
    assert.deepEqual(f.store.projectOverview(f.project.scopeId, 'A'), { data: null, fetchedAt: null });
});

test('switching connection hides cached content and prevents a prior request from writing it', t => {
    const f = setup(t), identity = f.store.connectionId();
    const boundAt = String(f.store.row('SELECT boundAt FROM bindings WHERE objectId=? AND spaceId=?', f.project.scopeId, 'A')!.boundAt);
    f.save('A', { topic_detail_list: [{ id: 'current' }] });
    const original = f.store.projectOverview(f.project.scopeId, 'A');
    f.config.update({ cloudProjectId: 'other' });
    assert.equal(f.store.projectOverview(f.project.scopeId, 'A'), undefined);
    assert.deepEqual(f.store.projectOverviewData(f.project.scopeId), { topic_detail_list: [] });
    assert.equal(f.store.saveProjectOverview(f.project.scopeId, identity, 'A', boundAt, { topic_detail_list: [] }), false);
    f.config.update({ cloudProjectId: 'fixture' });
    assert.deepEqual(f.store.projectOverview(f.project.scopeId, 'A'), original);
});

test('an old aggregate session overview is not interpreted as per-Space cache data', t => {
    const f = setup(t);
    const session = f.store.registerSession({ agentType: 'qwen-code', nativeSessionId: 'legacy', cwd: '/fixture/project' });
    f.store.setOverview(session.id, 'old merged session prose');
    f.store.db.exec('DROP TABLE project_overviews');
    f.restart();
    assert.ok(readdirSync(dirname(f.config.path)).some(name => name.includes('.before-project-overviews-')));
    assert.equal(f.store.session(session.id)!.overview, 'old merged session prose');
    assert.equal(f.store.projectOverview(f.project.scopeId, 'A'), undefined);
    assert.deepEqual(f.store.projectOverviewData(f.project.scopeId), { topic_detail_list: [] });
    f.store.ensureProjectOverview(f.project.scopeId, 'A');
    assert.deepEqual(f.store.projectOverview(f.project.scopeId, 'A'), { data: null, fetchedAt: null });
});

test('identity-only overview delivery persists and is inherited without creating a task before user input', t => {
    const f = setup(t), identity = { agentType: 'qwen-code', nativeSessionId: 'pure-start', cwd: '/fixture/project', event: 'session-start' };
    assert.equal(f.store.hostContextDelivered(identity.agentType, identity.nativeSessionId), false);
    f.store.markHostContextDelivered(identity.agentType, identity.nativeSessionId);
    assert.equal(f.store.rows('SELECT * FROM create_hosts').length, 0);
    f.store.creation.observe(identity);
    f.store.markHostContextDelivered(identity.agentType, identity.nativeSessionId);
    assert.equal(f.store.hostContextDelivered(identity.agentType, identity.nativeSessionId), true);
    assert.equal(f.store.rows('SELECT * FROM tasks').length, 0);
    assert.equal(f.store.rows('SELECT * FROM sessions').length, 0);
    f.restart();
    assert.equal(f.store.hostContextDelivered(identity.agentType, identity.nativeSessionId), true);
    const session = f.store.registerSession(identity);
    assert.equal(session.overviewDelivered, 1);
});

test('host and local-session acknowledgments synchronize their existing delivery flags', t => {
    const f = setup(t), identity = { agentType: 'qwen-code', nativeSessionId: 'ack', cwd: '/fixture/project', event: 'session-start' };
    f.store.creation.observe(identity);
    const session = f.store.registerSession(identity);
    assert.equal(session.overviewDelivered, 0);
    f.store.markHostContextDelivered(identity.agentType, identity.nativeSessionId);
    assert.equal(f.store.session(session.id)!.overviewDelivered, 1);
    f.store.db.prepare('UPDATE create_hosts SET overviewDelivered=0').run();
    f.store.markContextDelivered(session.id);
    assert.equal(f.store.hostContextDelivered(identity.agentType, identity.nativeSessionId), true);
    const noHost = f.store.registerSession({ ...identity, nativeSessionId: 'without-host' });
    f.store.markContextDelivered(noHost.id);
    assert.equal(f.store.rows('SELECT * FROM create_hosts WHERE nativeSessionId=?', 'without-host').length, 0);
});
