import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { PluginService } from '../../src/server/service.ts';
import { createLocalServer } from '../../src/server/http.ts';
import { createMockServer, getMockState } from '../../dev/memos-mock/server.ts';

async function listen(server: Server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
const close = (server: Server) => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));

// All content, configuration, SQLite and rollout discovery stay inside one temporary directory.
// Both HTTP servers use ephemeral loopback ports; no installed service or default dataDir is used.
test('HTTP history upload is opt-in, idempotent per Space, pausable, and survives final unbinding locally', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pm-history-http-'));
  const sources = join(directory, 'sources'), project = join(directory, 'project');
  await mkdir(sources); await mkdir(project);
  const row = (type: string, payload: object, second: number) => JSON.stringify({ type, payload, timestamp: `2020-01-01T00:00:0${second}.000Z` }) + '\n';
  await writeFile(join(sources, 'rollout-history.jsonl'),
    row('session_meta', { id: 'history-main', cwd: project, source: 'cli' }, 0)
    + row('event_msg', { type: 'task_started', turn_id: 'old-turn' }, 1)
    + row('response_item', { type: 'message', id: 'old-user', role: 'user', content: '历史用户任务' }, 2)
    + row('response_item', { type: 'message', id: 'old-answer', role: 'assistant', content: '历史完整答复' }, 3)
    + row('event_msg', { type: 'task_complete', turn_id: 'old-turn' }, 4));
  const mock = createMockServer({ apiKey: 'isolated-history-key', seedTopics: false, spaces: [
    { space_id: 'space-a', space_name: 'Space A' }, { space_id: 'space-b', space_name: 'Space B' },
  ] });
  const cloudUrl = await listen(mock);
  const service = new PluginService(join(directory, 'data'), { codexRoots: [sources] });
  const server = createLocalServer(service), localUrl = await listen(server);
  t.after(async () => {
    await close(server); service.close(); await close(mock); await rm(directory, { recursive: true, force: true });
  });
  const request = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<any> => {
    const response = await fetch(localUrl + path, {
      method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const result = await response.json(); assert.equal(response.status, 200, `${method} ${path}: ${JSON.stringify(result)}`); return result;
  };
  const ready = async (scopeId: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await request('/api/state'), scope = state.bindings.find((item: any) => item.id === scopeId);
      assert.ok(scope, 'Agent project scope must be returned by state');
      assert.notEqual(scope.history.status, 'failed', scope.history.error);
      if (scope.history.status === 'ready') return { state, scope };
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('History scan did not complete');
  };
  const activation = '/api/activation?' + new URLSearchParams({ agentType: 'codex-cli', cwd: project, nativeSessionId: 'history-main' });
  await request('/api/config', { baseUrl: `${cloudUrl}/api/openmem/v1`, apiKey: 'isolated-history-key', userId: 'history-test-user' }, 'PUT');
  assert.equal((await request(activation)).active, false);
  assert.equal(service.store.rows('SELECT * FROM traces').length, 0);
  assert.equal((await request('/api/state')).sessions.length, 0);

  const bound = await request('/api/projects', { name: '历史验证项目', root: project, agentType: 'codex-cli', spaceId: 'space-a' });
  const scopeId = bound.scopeId; assert.ok(scopeId);
  const first = await ready(scopeId);
  assert.equal(first.scope.agentType, 'codex-cli'); assert.equal(first.scope.history.pending, 2);
  assert.deepEqual(first.scope.spaceIds, ['space-a']); assert.equal(first.state.sessions.length, 0);
  assert.equal(service.store.rows('SELECT * FROM traces').length, 0, 'scan must not materialize history');
  assert.equal(getMockState(mock).uploads.length, 0, 'binding must not upload old history');
  assert.equal((await request(activation)).active, true);

  const historyPath = `/api/projects/${encodeURIComponent(scopeId)}/history`;
  await request(historyPath, {});
  const uploaded = await ready(scopeId);
  assert.equal(uploaded.scope.history.pending, 0); assert.equal(uploaded.scope.history.uploading, false);
  assert.equal(service.store.rows('SELECT * FROM traces').length, 2);
  assert.equal(uploaded.state.sessions.length, 1);
  const sessionId = uploaded.state.sessions[0].id;
  const uploads = getMockState(mock).uploads;
  assert.equal(uploads.length, 1); assert.deepEqual(uploads[0]!.space_ids, ['space-a']);
  assert.deepEqual(uploads[0]!.messages.map((message: any) => message.content), ['历史用户任务', '历史完整答复']);
  const frozenFirstUpload = structuredClone(uploads[0]);
  await request(historyPath, {});
  assert.equal(uploads.length, 1, 'repeat upload must not send previously delivered records');
  assert.equal(service.store.rows('SELECT * FROM traces').length, 2);

  await request('/api/bind', { objectId: scopeId, spaceId: 'space-b' });
  const expanded = await ready(scopeId);
  assert.equal(expanded.scope.history.pending, 2, 'only the new destination needs these two historical messages');
  assert.equal(uploads.length, 1, 'adding a Space must not upload history automatically');
  await request('/api/config', { paused: true }, 'PUT');
  await request(historyPath, {});
  assert.equal(uploads.length, 1, 'paused history remains queued without making cloud upload calls');
  const queued = await ready(scopeId);
  assert.equal(queued.scope.history.pending, 2); assert.equal(queued.scope.history.uploading, false);
  assert.match(queued.scope.history.uploadError, /暂停/);
  const pending = service.store.rows("SELECT spaceId,status FROM batch_deliveries WHERE kind='history' AND status='pending'");
  assert.equal(pending.length, 1); assert.equal(pending[0]?.spaceId, 'space-b');
  await request(historyPath, {});
  assert.equal(service.store.rows("SELECT * FROM batch_deliveries WHERE kind='history' AND status='pending'").length, 1, 'repeated paused clicks must not duplicate queued delivery');
  await request('/api/config', { paused: false }, 'PUT');
  await request('/api/sync', {});
  const resumed = await ready(scopeId);
  assert.equal(resumed.scope.history.pending, 0); assert.equal(resumed.scope.history.uploading, false);
  assert.equal(resumed.scope.history.uploadError, undefined);
  assert.equal(uploads.length, 2); assert.deepEqual(uploads[1]!.space_ids, ['space-b']);
  assert.deepEqual(uploads[1]!.messages, uploads[0]!.messages); assert.deepEqual(uploads[0], frozenFirstUpload);
  await request(historyPath, {}); assert.equal(uploads.length, 2);

  const detailPath = `/api/sessions/${encodeURIComponent(sessionId)}?unit=turn`;
  const beforeUnbind = await request(detailPath);
  assert.equal(beforeUnbind.total, 1); assert.match(JSON.stringify(beforeUnbind), /历史用户任务/);
  await request('/api/bind', { objectId: scopeId, spaceId: 'space-a' }, 'DELETE');
  assert.equal((await request(activation)).active, true);
  await request('/api/bind', { objectId: scopeId, spaceId: 'space-b' }, 'DELETE');
  assert.equal((await request(activation)).active, false);
  assert.deepEqual(await request(detailPath), beforeUnbind, 'last unbinding must preserve the collected session detail');
  assert.equal((await request('/api/state')).sessions.length, 1);
  assert.equal(service.store.rows('SELECT * FROM traces').length, 2);
  await request('/api/sync', {}); assert.equal(uploads.length, 2);
});
