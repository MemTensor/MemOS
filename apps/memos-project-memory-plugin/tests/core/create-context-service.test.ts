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
  const directory = mkdtempSync(join(tmpdir(), 'pm-create-context-'));
  const mock = createMockServer(); mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const cloud = mock.address(); assert.ok(cloud && typeof cloud !== 'string');
  const cloudPort = cloud.port;
  const services: PluginService[] = [], servers: ReturnType<typeof createLocalServer>[] = [];
  t.after(async () => {
    for (const server of servers) if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    for (const service of services) if (service.store.db.isOpen) service.close();
    await new Promise<void>(resolve => mock.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  async function start() {
    const service = new PluginService(directory, { home: directory, codexRoots: [] }); services.push(service);
    service.configure({ baseUrl: `http://127.0.0.1:${cloudPort}/api/openmem/v1`, apiKey: 'mock-key' });
    const server = createLocalServer(service); servers.push(server);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() as any };
    };
    return { service, server, post };
  }
  return { ...await start(), mock, start, directory };
}

const identity = { agentType: 'qwen-code', nativeSessionId: 'native-main', cwd: '/work/dialog-project', event: 'turn-start', turnKey: 'input-1' };

test('create resolves the dialog project, skips its entire round, and uploads only the next user round', async t => {
  const { service, post, mock } = await fixture(t);
  const started = new Date(Date.now() - 1000).toISOString();
  const context = (await post('create-context', { ...identity, occurredAt: started })).body.createContext;
  const result = await post('create', { context, name: '开发记忆', domain: '编程' });
  assert.equal(result.status, 200); assert.equal(result.body.status, 'CREATED');
  assert.equal(result.body.data.root, identity.cwd);
  assert.equal(result.body.data.agentType, identity.agentType);
  const spaceId = result.body.data.spaceId;
  assert.ok(spaceId); assert.deepEqual(service.store.binding(result.body.data.scopeId)?.spaceIds, [spaceId]);
  const record = (id: string, content: string, timestamp: string, role = 'assistant') => ({
    sourceId: id, nativeTurnId: identity.turnKey, raw: { role, content, timestamp }, message: { role, content },
  });
  await service.event({ ...identity, event: 'trace-available', records: [
    record('create-input', '创建空间', started, 'user'),
    record('create-reply', '空间已创建', new Date().toISOString()),
  ] });
  await service.event({ ...identity, event: 'turn-end' });
  await service.sync();
  assert.equal(getMockState(mock).requests.filter(request => request.path.endsWith('/add/message')).length, 0);
  const nextTime = new Date(Date.now() + 1000).toISOString();
  const next = { ...identity, turnKey: 'input-2' };
  await post('create-context', { ...next, occurredAt: nextTime });
  await service.event({ ...next, event: 'turn-start', records: [
    { ...record('next-user', '开始开发', nextTime, 'user'), nativeTurnId: next.turnKey },
  ] });
  await service.event({ ...next, event: 'turn-end', records: [
    { ...record('next-answer', '开发完成', nextTime), nativeTurnId: next.turnKey },
  ] });
  await service.sync();
  const uploads = getMockState(mock).requests.filter(request => request.path.endsWith('/add/message'));
  assert.equal(uploads.length, 1);
  assert.deepEqual((uploads[0]!.body as any).messages.map((message: any) => message.content), ['开始开发', '开发完成']);
});

test('concurrent and restarted retries return the original creation result without making another Space', async t => {
  const { service, server, post, start, mock } = await fixture(t);
  const context = (await post('create-context', identity)).body.createContext;
  const input = { context, name: '唯一空间', domain: '编程' };
  const [first, second] = await Promise.all([post('create', input), post('create', input)]);
  assert.equal(first.body.status, 'CREATED'); assert.deepEqual(second.body, first.body);
  await new Promise<void>(resolve => server.close(() => resolve())); service.close();
  const restarted = await start();
  assert.deepEqual((await restarted.post('create', input)).body, first.body);
  assert.equal(getMockState(mock).requests.filter(request => request.path.endsWith('/create/space')).length, 1);
});

test('an uncertain creation result is durable and cannot trigger an automatic second cloud request', async t => {
  const { service, server, post, start, mock } = await fixture(t);
  const context = (await post('create-context', identity)).body.createContext;
  let attempts = 0;
  service.cloud.call = async () => { attempts++; throw new Error('response lost after send'); };
  const input = { context, name: '结果待核对', domain: '编程' };
  assert.equal((await post('create', input)).body.status, 'CREATE_UNCERTAIN');
  assert.equal((await post('create', input)).body.status, 'CREATE_UNCERTAIN');
  assert.equal(attempts, 1);
  await new Promise<void>(resolve => server.close(() => resolve())); service.close();
  const restarted = await start();
  assert.equal((await restarted.post('create', input)).body.status, 'CREATE_UNCERTAIN');
  assert.equal(getMockState(mock).requests.length, 0);
});
