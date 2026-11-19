import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginService } from '../../src/server/service.ts';
import { createLocalServer } from '../../src/server/http.ts';
import { createMockServer, getMockState } from '../../dev/memos-mock/server.ts';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'pm-create-space-'));
  const mock = createMockServer({ seedTopics: false });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const services: PluginService[] = [], servers: ReturnType<typeof createLocalServer>[] = [];
  t.after(async () => {
    for (const server of servers) if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    for (const service of services) if (service.store.db.isOpen) service.close();
    await new Promise<void>(resolve => mock.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  async function start() {
    const service = new PluginService(directory, { home: directory, codexRoots: [] }); services.push(service);
    const server = createLocalServer(service); servers.push(server);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}`;
    return { service, server, url, post: (body: unknown) => fetch(url + '/api/projects', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }) };
  }
  const running = await start(), cloud = mock.address(); assert.ok(cloud && typeof cloud !== 'string');
  running.service.configure({ baseUrl: `http://127.0.0.1:${cloud.port}/api/openmem/v1`, apiKey: 'mock-key' });
  return { ...running, mock, start };
}

const input = { name: 'App', root: '/work/app', agentType: 'codex-cli', spaceName: '  开发记忆  ' };

test('HTTP creates and appends named Spaces, isolates Agents and retains IDs and names after restart', async t => {
  const { service, server, post, mock, start } = await fixture(t);
  const other = service.store.bindProject('App', input.root, 'other-agent-space', service.config.value.baseUrl, 'claude-code');
  const response = await post(input); assert.equal(response.status, 200);
  const project = await response.json() as any, state = getMockState(mock);
  const first = [...state.spaces.values()][0]!;
  assert.equal(first.space_name, '开发记忆');
  assert.deepEqual(state.requests.map(request => [request.path.split('/').slice(-2).join('/'), request.body]), [
    ['create/space', { space_name: '开发记忆' }],
  ]);
  assert.deepEqual(service.store.spaces(project.scopeId), [{ spaceId: first.space_id, name: '开发记忆' }]);
  assert.equal((await post({ ...input, spaceName: '第二个空间' })).status, 200);
  const ids = [...state.spaces.keys()];
  assert.deepEqual(service.store.binding(project.scopeId)?.spaceIds, ids);
  assert.deepEqual(service.store.binding(other.scopeId)?.spaceIds, ['other-agent-space']);
  const { spaceName: _name, ...existing } = input;
  assert.equal((await post({ ...existing, spaceId: first.space_id })).status, 200);
  assert.equal(state.requests.filter(request => request.path.endsWith('/create/space')).length, 2);
  assert.equal(service.store.batches().length, 0);
  await new Promise<void>(resolve => server.close(() => resolve())); service.close();
  const restarted = await start();
  assert.deepEqual(restarted.service.store.binding(project.scopeId)?.spaceIds, ids);
  const spaces = await (await fetch(`${restarted.url}/api/projects/${project.scopeId}/spaces`)).json();
  assert.deepEqual(spaces, [{ spaceId: ids[0], name: '开发记忆' }, { spaceId: ids[1], name: '第二个空间' }]);
  const bindings = await (await fetch(restarted.url + '/api/bind')).json() as any[];
  assert.deepEqual(bindings.find(scope => scope.id === project.scopeId)?.spaceIds, ids);
});

test('invalid create inputs fail before any cloud request while project registration stays compatible', async t => {
  const { service, post, mock } = await fixture(t);
  for (const body of [
    { ...input, spaceName: '' }, { ...input, spaceName: '  ' }, { ...input, spaceName: null },
    { ...input, spaceName: 1 }, { ...input, spaceName: {} }, { ...input, spaceId: 'existing' },
    { ...input, spaceId: '' }, { ...input, root: '' }, { ...input, root: 'relative' },
    { ...input, root: null }, { ...input, agentType: '' }, { ...input, agentType: 1 },
  ]) assert.equal((await post(body)).status, 400, JSON.stringify(body));
  assert.equal(getMockState(mock).requests.length, 0);
  assert.equal(service.store.rows('SELECT id FROM projects').length, 0);
  assert.equal((await post({ name: 'Registration only', root: '/work/registered' })).status, 200);
  assert.equal(getMockState(mock).requests.length, 0);
});

test('known cloud and uncertain binding conflicts reject creation before a remote Space is made', async t => {
  const { service, post, mock } = await fixture(t);
  service.store.bindProject('App', input.root, 'original', 'http://other-cloud', input.agentType);
  assert.equal((await post(input)).status, 400);
  const pending = service.store.createProject('Pending', '/work/pending'), scope = service.store.memory.ensure(pending.id, input.agentType);
  service.store.setCreating(scope, service.config.value.baseUrl, 'uncertain');
  assert.equal((await post({ ...input, root: pending.root })).status, 400);
  assert.equal(getMockState(mock).requests.length, 0);
  assert.deepEqual(service.store.binding(scope)?.spaceIds, []);
});

test('failed creation and invalid create responses do not create local projects or fake bindings', async t => {
  const { service, post } = await fixture(t);
  for (const result of [null, {}, { space_id: '' }, { space_id: '  ' }, { space_id: 42 }]) {
    let calls = 0;
    service.cloud.call = async () => { calls++; return result as any; };
    const response = await post(input); assert.equal(response.status, 400);
    assert.equal(calls, 1);
    assert.equal((await response.json() as any).spaceId, undefined);
  }
  let calls = 0;
  service.cloud.call = async () => { calls++; throw new Error('Mock unavailable'); };
  const response = await post(input); assert.equal(response.status, 400);
  assert.equal(calls, 1);
  assert.equal(service.store.rows('SELECT id FROM projects').length, 0);
  assert.equal(service.store.rows('SELECT objectId FROM bindings').length, 0);
});

test('creation success followed by binding failure returns the known Space ID for ordinary binding recovery', async t => {
  const { service, post, mock } = await fixture(t);
  const bind = service.store.bindProject.bind(service.store);
  service.store.bindProject = () => { throw new Error('SQLite unavailable'); };
  const response = await post(input); assert.equal(response.status, 400);
  const result = await response.json() as any, state = getMockState(mock);
  assert.equal(result.spaceId, [...state.spaces.keys()][0]);
  assert.match(result.error, /SQLite unavailable/);
  assert.equal(service.store.rows('SELECT id FROM projects').length, 0);
  service.store.bindProject = bind;
  const { spaceName: _name, ...existing } = input;
  assert.equal((await post({ ...existing, spaceId: result.spaceId })).status, 200);
  assert.equal(state.requests.filter(request => request.path.endsWith('/create/space')).length, 1);
});

test('a cloud connection changed during creation prevents binding and preserves its returned ID', async t => {
  const { service, post, mock } = await fixture(t);
  const call = service.cloud.call.bind(service.cloud);
  service.cloud.call = async (endpoint, body) => {
    const result = await call(endpoint, body);
    if (endpoint === 'create/space') service.configure({ baseUrl: 'http://changed-cloud' });
    return result as any;
  };
  const response = await post(input); assert.equal(response.status, 400);
  const result = await response.json() as any;
  assert.equal(result.spaceId, [...getMockState(mock).spaces.keys()][0]);
  assert.match(result.error, /云连接/);
  assert.equal(service.store.rows('SELECT id FROM projects').length, 0);
  assert.equal(getMockState(mock).requests.length, 1);
});
