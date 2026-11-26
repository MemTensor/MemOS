import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../../src/storage/store.ts';
import { PluginService } from '../../src/server/service.ts';
import { writeDoubaoProjects } from '../helpers/doubao-project-cache.ts';
import { installAdapter } from '../../src/adapters/installer.ts';

test('a Doubao-first binding keeps its host name local, including after a legacy schema upgrade', async t => {
    const home = await mkdtemp(join(tmpdir(), 'doubao-project-name-'));
    const path = join(home, 'memory.sqlite');
    let store = new Store(path);
    t.after(async () => { store.close(); await rm(home, { recursive: true, force: true }); });
    const legacy = store.bindProject('Shared name', '/legacy', 'a', 'http://local', 'claude-code');
    if (store.rows('PRAGMA table_info(project_agents)').some(column => column.name === 'localName'))
        store.db.exec('ALTER TABLE project_agents DROP COLUMN localName');
    store.close();
    store = new Store(path);
    assert.equal(store.memory.get(legacy.scopeId)?.name, 'Shared name');
    const doubao = store.bindProject('Host label', '/fixture/work', 'a', 'http://local', 'doubao-work');
    assert.equal(doubao.name, 'Host label');
    assert.equal(store.row('SELECT name FROM projects WHERE id=?', doubao.id)?.name, 'work');
    const other = store.bindProject('work', '/fixture/work', 'b', 'http://local', 'claude-code');
    assert.equal(other.id, doubao.id);
    assert.equal(store.memory.get(other.scopeId)?.name, 'work');
    assert.equal(store.memory.get(doubao.scopeId)?.name, 'Host label');
});

test('refresh persists only Doubao names and drops archived candidates without touching bindings', async t => {
    const home = await mkdtemp(join(tmpdir(), 'doubao-project-refresh-'));
    const dir = join(home, 'memos');
    let service = new PluginService(dir, { home, codexRoots: [] });
    t.after(async () => { service.close(); await rm(home, { recursive: true, force: true }); });
    await installAdapter('doubao-work', { home });
    const baseUrl = service.config.value.baseUrl;
    const root = join(home, '读论文'), archivedRoot = join(home, 'archived');
    const other = service.store.bindProject('Shared name', root, 'other', baseUrl, 'claude-code');
    const doubao = service.store.bindProject('读论文', root, 'one', baseUrl, 'doubao-work');
    const archived = service.store.bindProject('Archived', archivedRoot, 'two', baseUrl, 'doubao-work');
    service.store.registerSession({ agentType: 'doubao-work', cwd: archivedRoot, nativeSessionId: '1234' });
    await writeDoubaoProjects(home, [{ root, name: '读论文' }, { root: archivedRoot, name: 'Archived' }]);
    assert.equal((await service.projects('doubao-work', true)).length, 2);
    await writeDoubaoProjects(home, [{ root, name: '项目记忆测试' }]);
    const renamed = await service.projects('doubao-work', true);
    assert.deepEqual(renamed.map(p => [p.id, p.root, p.name, p.spaceIds]), [[doubao.id, root, '项目记忆测试', ['one']]]);
    await writeDoubaoProjects(home, [], true);
    await assert.rejects(service.projects('doubao-work', true));
    assert.deepEqual(await service.projects('doubao-work'), renamed);
    await writeDoubaoProjects(home, []);
    assert.deepEqual(await service.projects('doubao-work', true), []);
    service.close();
    service = new PluginService(dir, { home, codexRoots: [] });
    assert.equal(service.store.memory.get(doubao.scopeId)?.name, '项目记忆测试');
    assert.equal(service.store.memory.get(other.scopeId)?.name, 'Shared name');
    assert.equal(service.store.row('SELECT name FROM projects WHERE id=?', doubao.id)?.name, 'Shared name');
    assert.deepEqual(service.store.memory.get(archived.scopeId)?.spaceIds, ['two']);
});
