import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginService } from '../../src/server/service.ts';
import { createLocalServer } from '../../src/server/http.ts';
import { createMockServer, getMockState } from '../../dev/memos-mock/server.ts';
const execute = promisify(execFile);

test('dialog CLI and current launcher manage one project across bind, local list, unbind and expiry', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pm-project-http-'));
  const mock = createMockServer({ spaces: [{ space_id: 'target', space_name: 'Existing', domains: [{ domain: '编程' }] }] });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const cloud = mock.address(); assert.ok(cloud && typeof cloud !== 'string');
  const service = new PluginService(directory, { home: directory, codexRoots: [] });
  const callCloud = service.cloud.call.bind(service.cloud);
  let cloudCalls = 0;
  service.cloud.call = async <T>(...args: Parameters<typeof service.cloud.call>) => { cloudCalls++; return callCloud<T>(...args); };
  service.configure({ baseUrl: `http://127.0.0.1:${cloud.port}/api/openmem/v1` });
  const server = createLocalServer(service); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve())); service.close();
    await new Promise<void>(resolve => mock.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const identity = { agentType: 'qwen-code', nativeSessionId: 'dialog', cwd: '/current-project', event: 'turn-start', turnKey: 'one' };
  const context = await service.createContext(identity);
  const launcher = join(directory, 'bind', context.createContext + '.mjs');
  const script = await readFile(launcher, 'utf8');
  const legacy = script.replace("['spaces', 'unbind'].includes(args[0]) ? args : ['bind', ...args]", "['bind', ...args]");
  assert.notEqual(legacy, script);
  await writeFile(launcher, legacy);
  assert.equal((await service.createContext({ ...identity, event: 'trace-available' })).createContext, context.createContext);
  assert.equal(await readFile(launcher, 'utf8'), script);
  const env = { ...process.env, MEMOS_PM_URL: `http://127.0.0.1:${address.port}` };
  const sessionEnv = { ...env, CODEX_THREAD_ID: '', DSH_SESSION_ID: '', COPILOT_AGENT_SESSION_ID: '', RLM_SESSION_ID: '', MEMOS_PM_BIND_CONTEXT: '',
    MEMOS_PM_BIND_SESSION: JSON.stringify({ agentType: identity.agentType, nativeSessionId: identity.nativeSessionId }) };
  const invoke = async (args: string[], native = false) => JSON.parse((await execute(process.execPath,
    native ? ['src/cli/index.ts', ...args] : [launcher, ...args], { env: native ? sessionEnv : env, cwd: native ? undefined : tmpdir() })).stdout);
  assert.equal((await invoke(['spaces'])).status, 'EMPTY');
  assert.equal(getMockState(mock).requests.length, 0); assert.equal(cloudCalls, 0);
  service.configure({ apiKey: 'mock-key' });
  const bound = await invoke(['--space-id', 'target']);
  assert.equal(bound.status, 'BOUND'); assert.equal(bound.data.root, identity.cwd);
  assert.equal(service.state().sessions.length, 0);
  assert.equal(getMockState(mock).requests.some(row => row.path.endsWith('/create/space')), false);
  assert.equal((await invoke(['bind', '--space-id', 'target'], true)).status, 'ALREADY_BOUND');
  service.store.bind(bound.data.scopeId, 'remaining', service.config.value.baseUrl, '');
  const other = service.store.bindProject('Other', '/other-project', 'target', service.config.value.baseUrl, identity.agentType, 'Other');
  service.configure({ apiKey: '' });
  const requestCount = getMockState(mock).requests.length, callsBeforeLocal = cloudCalls;
  const before = service.store.row('SELECT total_changes() AS count')!.count;
  const listed = await invoke(['spaces'], true);
  assert.equal(listed.status, 'FOUND');
  assert.deepEqual(listed.data, { agentType: identity.agentType, root: identity.cwd, spaces: [{ spaceId: 'target', name: 'Existing' }, { spaceId: 'remaining', name: '' }] });
  assert.equal(service.store.row('SELECT total_changes() AS count')!.count, before);
  const removed = await invoke(['unbind', '--space-id', 'target']);
  assert.equal(removed.status, 'UNBOUND'); assert.equal(removed.data.name, 'Existing');
  assert.deepEqual(removed.data.spaces, [{ spaceId: 'remaining', name: '' }]);
  assert.deepEqual(service.store.binding(other.scopeId)?.spaceIds, ['target']);
  assert.equal((await invoke(['unbind', '--space-id', 'target'])).status, 'NOT_BOUND');
  assert.equal((await invoke(['unbind', '--space-id', 'remaining'], true)).status, 'UNBOUND');
  assert.equal((await invoke(['spaces'])).status, 'EMPTY');
  assert.equal(await service.activation(identity), false);
  assert.equal(getMockState(mock).requests.length, requestCount); assert.equal(cloudCalls, callsBeforeLocal);
  assert.equal(service.store.rows('SELECT id FROM traces').length, 0);
  const stale = join(directory, 'stale.mjs'); await writeFile(stale, script);
  await service.createContext({ ...identity, event: 'turn-end' });
  for (const args of [['--space-id', 'target'], ['spaces'], ['unbind', '--space-id', 'target']])
    await assert.rejects(execute(process.execPath, [stale, ...args], { env }), error => {
      assert.equal(JSON.parse((error as Error & { stdout: string }).stdout).status, 'CONTEXT_MISSING'); return true;
    });
});
