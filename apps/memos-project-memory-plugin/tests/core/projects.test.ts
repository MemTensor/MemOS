import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/storage/store.ts';
import { PluginService } from '../../src/server/service.ts';
import { createLocalServer } from '../../src/server/http.ts';
import { createMockServer, getMockState } from '../../dev/memos-mock/server.ts';

test('binding an existing directory reuses its project and moves unbound standalone sessions and batches together', () => {
  const store = new Store(':memory:');
  try {
    const first = store.registerSession({ agentType: 'claude-code', nativeSessionId: 'first', cwd: '/work/app' });
    store.startTurn(first.id, 'user');
    store.capture(first.id, [{ sourceId: 'user', raw: { role: 'user', content: 'keep original' } }]);
    store.finalizeTurn(first.id);
    const child = store.registerSession({ agentType: 'codex', nativeSessionId: 'child', cwd: '/work/app/src' });
    const other = store.registerSession({ agentType: 'codex', nativeSessionId: 'other', cwd: '/work/app-other' });
    const nested = store.createProject('Nested', '/work/app/nested');
    const nestedSession = store.registerSession({ agentType: 'codex', nativeSessionId: 'nested', cwd: nested.root });
    const project = store.bindProject('App', '/work/app/', 'space-shared', 'http://cloud');
    assert.equal(store.session(first.id)?.objectId, project.id);
    assert.equal(store.session(child.id)?.objectId, project.id);
    assert.equal(store.row('SELECT projectId FROM tasks WHERE id=?', first.taskId)?.projectId, project.id);
    assert.equal(store.batches()[0]?.objectId, project.id);
    assert.equal(store.batches()[0]?.attempts, 0);
    assert.equal(store.batches()[0]?.uploaded, false);
    assert.equal(store.sessionDetail(first.id).traces[0]?.sourceId, 'user');
    assert.equal(store.session(other.id)?.objectId, other.objectId);
    assert.equal(store.session(nestedSession.id)?.objectId, nested.id);
    assert.equal(store.bindProject('Other display name', '/work/app', 'space-shared', 'http://cloud').id, project.id);
    assert.equal(store.rows('SELECT id FROM projects WHERE root=?', '/work/app').length, 1);
    const future = store.registerSession({ agentType: 'deepseek-harness', nativeSessionId: 'future', cwd: '/work/app' });
    assert.equal(future.objectId, project.id);
    assert.deepEqual(store.binding(future.objectId)?.spaceIds, ['space-shared']);
  } finally { store.close(); }
});

test('directory binding merges prior spaces, rejects another cloud and preserves uncertain creation', () => {
  const store = new Store(':memory:');
  try {
    const session = store.registerSession({ agentType: 'codex', nativeSessionId: 'fixed', cwd: '/work/fixed' });
    store.bind(session.objectId, 'original', 'http://cloud');
    assert.throws(() => store.bindProject('Fixed', '/work/fixed', 'original', 'http://other'), /绑定不可更改|云连接/);
    assert.equal(store.rows('SELECT * FROM projects').length, 0);
    assert.equal(store.session(session.id)?.objectId, session.objectId);
    assert.deepEqual(store.binding(session.objectId)?.spaceIds, ['original']);
    const project = store.bindProject('Fixed', '/work/fixed', 'different', 'http://cloud');
    assert.deepEqual(store.binding(project.id)?.spaceIds, ['original', 'different']);
    assert.equal(store.binding(session.objectId), undefined);
    const uncertain = store.registerSession({ agentType: 'codex', nativeSessionId: 'uncertain', cwd: '/work/uncertain' });
    store.setCreating(uncertain.objectId, 'http://cloud', 'uncertain');
    assert.throws(() => store.bindProject('Uncertain', '/work/uncertain', 'candidate', 'http://cloud'), /尚待确认/);
    assert.equal(store.row('SELECT id FROM projects WHERE root=?', '/work/uncertain'), undefined);
  } finally { store.close(); }
});

test('project selection uses agent sessions and persists verified bindings through the existing projects API', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pm-project-binding-'));
  const mock = createMockServer(); mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  let service = new PluginService(directory);
  const server = createLocalServer(service); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    service.close();
    await new Promise<void>(resolve => mock.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  const address = server.address(), cloud = mock.address();
  assert.ok(address && typeof address !== 'string' && cloud && typeof cloud !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  service.configure({ baseUrl: `http://127.0.0.1:${cloud.port}/api/openmem/v1`, apiKey: 'mock-key' });
  const identity = await service.event({ agentType: 'codex', nativeSessionId: 'existing', cwd: '/work/codex-app', event: 'turn-start', turnKey: 'u1' });
  await service.event({ agentType: 'claude-code', nativeSessionId: 'other', cwd: '/work/claude-app', event: 'session-start' });
  const options = await (await fetch(base + '/api/projects?agentType=codex')).json() as any[];
  assert.ok(options.some(project => project.root === '/work/codex-app' && project.name === 'codex-app'));
  assert.ok(!options.some(project => project.root === '/work/claude-app'));
  assert.equal(service.store.rows('SELECT * FROM projects').length, 0);
  assert.equal(getMockState(mock).requests.length, 0);
  const created = await service.cloud.call<{ space_id: string }>('create/space', { space_name: 'Existing Space' });
  const post = (body: unknown) => fetch(base + '/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const input = { name: 'codex-app', root: '/work/codex-app', spaceId: created.space_id };
  const boundResponse = await post(input); assert.equal(boundResponse.status, 200);
  const project = await boundResponse.json() as any;
  assert.deepEqual(service.store.binding(project.id)?.spaceIds, [created.space_id]);
  assert.equal(service.store.session(identity.sessionId)?.objectId, project.id);
  assert.equal((await service.search({ sessionId: identity.sessionId, conversationId: identity.conversationId!, query: '接口' })).status, 'FOUND');
  assert.equal((await (await post(input)).json() as any).id, project.id);
  const repeated = await Promise.all([post(input), post(input)]);
  for (const response of repeated) assert.equal((await response.json() as any).id, project.id);
  assert.equal((await post({ ...input, spaceId: 'inaccessible' })).status, 400);
  assert.equal((await post({ name: 'No orphan', root: '/work/new', spaceId: 'inaccessible' })).status, 400);
  assert.equal((await post({ ...input, spaceId: ' ' })).status, 400);
  assert.equal(service.store.rows('SELECT * FROM projects').length, 1);
  assert.equal(getMockState(mock).requests.filter(request => request.path.endsWith('create/space')).length, 1);
  service.close(); service = new PluginService(directory);
  assert.deepEqual(service.store.binding(project.id)?.spaceIds, [created.space_id]);
  assert.equal(service.store.session(identity.sessionId)?.objectId, project.id);
  assert.equal(service.store.registerSession({ agentType: 'claude-code', nativeSessionId: 'new-agent', cwd: input.root }).objectId, project.id);
});
