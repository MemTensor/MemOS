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
  const directory = mkdtempSync(join(tmpdir(), 'pm-dialog-bind-'));
  const mock = createMockServer({ spaces: [
    { space_id: 'existing', space_name: 'Existing', domains: [{ domain: '编程' }] },
    { space_id: 'extra', space_name: 'Extra', domains: [{ domain: '办公' }] },
    { space_id: 'empty', space_name: 'Empty', domains: [] },
  ] });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const cloud = mock.address(); assert.ok(cloud && typeof cloud !== 'string');
  const service = new PluginService(directory, { home: directory, codexRoots: [] });
  service.configure({ baseUrl: `http://127.0.0.1:${cloud.port}/api/openmem/v1`, apiKey: 'mock-key' });
  const server = createLocalServer(service); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve())); service.close();
    await new Promise<void>(resolve => mock.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { httpStatus: response.status, ...await response.json() as any };
  };
  const identity = { agentType: 'qwen-code', nativeSessionId: 'dialog', cwd: '/work/dialog', event: 'turn-start', turnKey: 'first' };
  const context = (await post('create-context', identity)).createContext;
  return { service, post, mock, identity, context };
}

test('dialog binding rejects inaccessible and empty-domain spaces and does not create a project', async t => {
  const { service, post, context } = await fixture(t);
  const empty = await post('bind-project', { context, spaceId: 'empty' });
  assert.equal(empty.status, 'UNAVAILABLE');
  assert.match(empty.error.message, /尚未配置领域/);
  assert.equal((await post('bind-project', { context, spaceId: 'missing' })).status, 'UNAVAILABLE');
  assert.equal(service.store.state().projects.length, 0);
});

test('dialog binding enforces the twenty-space limit before another cloud request', async t => {
  const { service, post, mock, context } = await fixture(t);
  const first = await post('bind-project', { context, spaceId: 'existing' });
  for (let index = 1; index < 20; index++) service.store.bind(first.data.scopeId, `local-${index}`, service.config.value.baseUrl);
  const calls = getMockState(mock).requests.length;
  const result = await post('bind-project', { context, spaceId: 'extra' });
  assert.equal(result.status, 'UNAVAILABLE');
  assert.match(result.error.message, /不能超过20个/);
  assert.equal(getMockState(mock).requests.length, calls);
  assert.equal((await post('bind-project', { context, spaceId: 'existing' })).status, 'ALREADY_BOUND');
});

test('a newly bound space receives the next complete round while the original target keeps current business', async t => {
  const { service, post, mock, identity } = await fixture(t);
  const original = await service.bindProject({ root: identity.cwd, agentType: identity.agentType, spaceId: 'existing' });
  const time = new Date().toISOString();
  const current = { ...identity, turnKey: 'business' };
  const context = (await post('create-context', { ...current, occurredAt: time })).createContext;
  const record = (id: string, content: string, role: string, turnKey: string, timestamp: string) => ({
    sourceId: id, nativeTurnId: turnKey, raw: { role, content, timestamp }, message: { role, content },
  });
  await service.event({ ...current, event: 'turn-start', records: [record('business-user', '业务任务', 'user', current.turnKey, time)] });
  assert.equal((await post('bind-project', { context, spaceId: 'extra' })).status, 'BOUND');
  await service.event({ ...current, event: 'turn-end', records: [record('business-answer', '业务结果', 'assistant', current.turnKey, time)] });
  await service.sync();
  let uploads = getMockState(mock).requests.filter(request => request.path.endsWith('/add/message')).map(request => request.body as any);
  assert.deepEqual(uploads.map(upload => upload.space_ids), [[original.spaceId]]);
  assert.deepEqual(uploads[0].messages.map((message: any) => message.content), ['业务任务', '业务结果']);
  const next = { ...identity, turnKey: 'next' }, nextTime = new Date(Date.now() + 2000).toISOString();
  await post('create-context', { ...next, occurredAt: nextTime });
  await service.event({ ...next, event: 'turn-start', records: [record('next-user', '下轮任务', 'user', next.turnKey, nextTime)] });
  await service.event({ ...next, event: 'turn-end', records: [record('next-answer', '下轮结果', 'assistant', next.turnKey, nextTime)] });
  await service.sync();
  uploads = getMockState(mock).requests.filter(request => request.path.endsWith('/add/message')).map(request => request.body as any);
  assert.equal(uploads.length, 3);
  assert.deepEqual(uploads.filter(upload => upload.space_ids.includes('extra')).map(upload => upload.messages.map((message: any) => message.content)), [['下轮任务', '下轮结果']]);
});
