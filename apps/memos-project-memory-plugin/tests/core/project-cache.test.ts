import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { PluginService } from '../../src/server/service.ts';
import { createLocalServer } from '../../src/server/http.ts';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const home = await mkdtemp(join(tmpdir(), 'pm-project-cache-'));
  const service = new PluginService(join(home, 'data'), { codexRoots: [], home });
  t.after(async () => { service.close(); await rm(home, { recursive: true, force: true }); });
  const save = async (path: string, data: unknown) => {
    const target = join(home, path); await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, JSON.stringify(data));
  };
  const projects = (roots: string[]) => save('.codex/.codex-global-state.json', {
    'local-projects': Object.fromEntries(roots.map(root => [root, { rootPaths: [root] }])),
  });
  const install = (agent: string) => save(`.memos-project-memory/adapters/${agent}.json`, { installedAt: 'fixture' });
  return { home, service, save, projects, install };
}

test('only configured Agents discover projects; cached lists change only on explicit refresh', async t => {
  const f = await fixture(t);
  await f.projects(['/work/first']);
  assert.deepEqual(await f.service.projects('codex-cli'), []);
  await f.install('codex-cli');
  assert.deepEqual((await f.service.projects('codex-cli')).map(p => p.root), ['/work/first']);
  await f.projects(['/work/second']);
  assert.deepEqual((await f.service.projects('codex-cli')).map(p => p.root), ['/work/first']);
  assert.deepEqual((await f.service.projects('codex-cli', true)).map(p => p.root), ['/work/first', '/work/second']);
  assert.equal(f.service.store.rows('SELECT * FROM sessions').length, 0);
  assert.equal(f.service.store.rows('SELECT * FROM traces').length, 0);
});

test('cached project metadata keeps fresh Agent-specific bindings without a discovery scan', async t => {
  const f = await fixture(t); await f.install('codex-cli'); await f.projects(['/work/first']);
  await f.service.projects('codex-cli');
  f.service.store.bindProject('Bound name', '/work/first', 'A', 'http://cloud', 'codex-cli');
  await f.projects(['/work/second']);
  const current = await f.service.projects('codex-cli');
  assert.equal(current.length, 1); assert.equal(current[0]!.name, 'Bound name');
  assert.deepEqual(current[0]!.spaceIds, ['A']);
  assert.deepEqual(await f.service.projects('claude-code'), []);
});

test('projects HTTP serves configured Agents without version probes and supports explicit refresh', async t => {
  const f = await fixture(t); await f.install('codex-cli'); await f.projects(['/work/first']);
  const server = createLocalServer(f.service); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const get = async (path: string) => (await (await fetch(`http://127.0.0.1:${address.port}${path}`)).json()) as any[];
  t.mock.method(f.service, 'refreshSessionTitles', async () => { throw new Error('project list must not load sessions'); });
  t.mock.method(f.service.store, 'state', () => { throw new Error('project list must not load full state'); });
  assert.deepEqual(await get('/api/bind'), []);
  assert.deepEqual((await get('/api/adapters/installed')).map(a => a.id), ['codex-cli']);
  await get('/api/projects?agentType=codex-cli'); await f.projects(['/work/second']);
  assert.equal((await get('/api/projects?agentType=codex-cli')).length, 1);
  assert.equal((await get('/api/projects?agentType=codex-cli&refresh=1')).length, 2);
});

test('newly bound projects scan history once; added Spaces and state refresh reuse it', async t => {
  const { service } = await fixture(t);
  service.cloud.call = async () => ({ space_name: 'Fixture' }) as any;
  let scans = 0;
  t.mock.method(service.history, 'scan', async () => { scans++; });
  const input = { name: 'First', root: '/work/first', agentType: 'codex-cli', spaceId: 'A' };
  const project = await service.bindProject(input); assert.equal(scans, 1);
  await service.bindProject(input); await service.bindProject({ ...input, spaceId: 'B' });
  await service.bind(project.scopeId, 'C');
  service.state(); service.state(); assert.equal(scans, 1);
  await service.history.scan(project.scopeId); assert.equal(scans, 2);
});

test('known projects update their history catalog from SQLite without rereading native history', async t => {
  const { service } = await fixture(t);
  const project = service.store.bindProject('Existing', '/existing', 'A', 'http://cloud', 'claude-code');
  const scan = t.mock.method(service.history, 'scan', async () => { throw new Error('native scan is unnecessary'); });
  await service.history.refresh(project.scopeId);
  assert.equal(service.history.status(project.scopeId).status, 'ready');
  const session = service.store.registerSession({ agentType: 'claude-code', nativeSessionId: 'one', cwd: '/existing' });
  service.store.startTurn(session.id, 'turn');
  service.store.capture(session.id, [{ sourceId: 'user', raw: { role: 'user', content: 'new task', timestamp: new Date().toISOString() } }]);
  service.store.finalizeTurn(session.id);
  await service.history.refresh(project.scopeId);
  assert.equal(service.history.catalog(project.scopeId).length, 1);
  assert.equal(scan.mock.callCount(), 0);
});
