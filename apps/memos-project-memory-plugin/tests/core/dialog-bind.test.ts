import { captureUploads } from '../helpers/capture-uploads.ts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginService } from '../../src/server/service.ts';
import { createLocalServer } from '../../src/server/http.ts';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'pm-dialog-bind-'));
  const service = new PluginService(directory, { home: directory, codexRoots: [] });
  service.configure({ apiKey: 'fixture-key' });
  const calls: string[] = [];
  service.cloud.call = async <T>(endpoint: string, input: unknown) => {
    calls.push(endpoint);
    const { space_id } = input as { space_id: string };
    if (endpoint === 'get/memory') return { topic_detail_list: [] } as T;
    if (endpoint === 'list/domains') return { domains: [] } as T;
    assert.equal(endpoint, 'get/space');
    if (space_id === 'missing') throw new Error('Space not found');
    return { space_id, space_name: space_id } as T;
  };
  for (const id of ['existing', 'extra']) service.store.setSpaceDomains(service.config.value.baseUrl, id, ['编程']);
  const server = createLocalServer(service); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve())); service.close();
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
  return { service, post, calls, identity, context };
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
  const { service, post, calls, context } = await fixture(t);
  const first = await post('bind-project', { context, spaceId: 'existing' });
  for (let index = 1; index < 20; index++) service.store.bind(first.data.scopeId, `local-${index}`, service.config.value.baseUrl);
  const before = calls.length;
  const result = await post('bind-project', { context, spaceId: 'extra' });
  assert.equal(result.status, 'UNAVAILABLE');
  assert.match(result.error.message, /不能超过20个/);
  assert.equal(calls.length, before);
  assert.equal((await post('bind-project', { context, spaceId: 'existing' })).status, 'ALREADY_BOUND');
});

test('a newly bound space receives the next complete round while the original target keeps current business', async t => {
  const { service, post, identity } = await fixture(t);
  const original = await service.bindProject({ root: identity.cwd, agentType: identity.agentType, spaceId: 'existing' });
  const time = new Date().toISOString();
  const current = { ...identity, turnKey: 'business' };
  const context = (await post('create-context', { ...current, occurredAt: time })).createContext;
  const record = (id: string, content: string, role: string, turnKey: string, timestamp: string) => ({
    sourceId: id, nativeTurnId: turnKey, raw: { role, content, timestamp }, message: { role, content },
  });
  await service.event({ ...current, event: 'turn-start', records: [record('business-user', '业务任务', 'user', current.turnKey, time)] });
  assert.equal((await post('bind-project', { context, spaceId: 'extra' })).status, 'BOUND');
  const { uploads, call } = captureUploads();
  service.cloud.call = call;
  await service.event({ ...current, event: 'turn-end', records: [record('business-answer', '业务结果', 'assistant', current.turnKey, time)] });
  await service.sync();
  assert.deepEqual(uploads.map(upload => upload.space_ids), [[original.spaceId]]);
  assert.deepEqual(uploads[0]!.messages.map(message => message.content), ['业务任务', '业务结果']);
  const next = { ...identity, turnKey: 'next' }, nextTime = new Date(Date.now() + 2000).toISOString();
  await post('create-context', { ...next, occurredAt: nextTime });
  await service.event({ ...next, event: 'turn-start', records: [record('next-user', '下轮任务', 'user', next.turnKey, nextTime)] });
  await service.event({ ...next, event: 'turn-end', records: [record('next-answer', '下轮结果', 'assistant', next.turnKey, nextTime)] });
  await service.sync();
  assert.equal(uploads.length, 3);
  assert.deepEqual(uploads.filter(upload => upload.space_ids.includes('extra')).map(upload => upload.messages.map(message => message.content)), [['下轮任务', '下轮结果']]);
});
