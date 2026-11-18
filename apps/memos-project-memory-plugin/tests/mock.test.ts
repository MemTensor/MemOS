import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createMockServer, getMockState } from '../dev/memos-mock/server.ts';

test('six HTTP endpoints preserve complete uploaded data and scope memories to a space', async (t) => {
  const server = createMockServer({ apiKey: 'test-secret' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/openmem/v1/${path}`, {
      method: 'POST', headers: { Authorization: 'Token test-secret', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 200); return await response.json() as any;
  };
  const created = await post('create/space', { space_name: '项目甲' });
  assert.equal(created.code, 0); const spaceId = created.data.space_id;
  assert.equal((await post('get/space', { space_id: spaceId })).data.space_name, '项目甲');
  const messages = [{ role: 'assistant', content: '<script>raw</script>', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"test"}' } }] }, { role: 'tool', tool_call_id: 'c1', content: '完整结果\n'.repeat(10000) }];
  const upload = { user_id: 'u1', agent_id: 'codex', space_ids: [spaceId], messages, allow_memory_view: ['project'], async_mode: true };
  const accepted = await post('add/message', upload);
  assert.equal(accepted.data.success, true);
  assert.equal((await post('get/status', { task_id: accepted.data.task_id })).data.status, 'completed');
  const memory = await post('get/memory', { space_id: spaceId });
  assert.equal(memory.data.topic_detail_list[0].space_id, spaceId);
  assert.match(memory.data.topic_detail_list[0].topic_summary, /mock/i);
  const result = await post('search/memory', { user_id: 'u1', query: '接口', space_ids: [spaceId], include_memory_view: ['project'] });
  assert.equal(result.data.topic_detail_list.length, 1);
  assert.equal(result.data.topic_detail_list[0].sources, undefined);
  assert.deepEqual(getMockState(server).uploads[0], upload);
  assert.equal(getMockState(server).requests.length, 6);
  assert.ok(!JSON.stringify(getMockState(server).requests).includes('test-secret'));
});

test('mock permits omitted domains, supports empty fixtures and rejects invalid auth', async (t) => {
  const server = createMockServer({ apiKey: 'test', seedTopics: false }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/openmem/v1/`;
  const denied = await fetch(base + 'create/space', { method: 'POST', body: '{}' }); assert.equal(denied.status, 401);
  const send = async (path: string, body: unknown) => (await fetch(base + path, { method: 'POST', headers: { Authorization: 'Token test' }, body: JSON.stringify(body) })).json() as Promise<any>;
  const created = await send('create/space', { space_name: '空空间' });
  const empty = await send('get/memory', { space_id: created.data.space_id }); assert.deepEqual(empty.data.topic_detail_list, []);
  const upload = await send('add/message', { user_id: 'u', space_ids: [created.data.space_id], messages: [{ role: 'user', content: 'hello' }], allow_memory_view: ['project'] }); assert.equal(upload.data.success, true);
});

test('preset project spaces have isolated memories and reload unchanged after restart', async () => {
  const expected = [
    ['mock_space_project_memory', ['空间绑定', '轨迹上传']],
    ['mock_space_order_service', ['订单幂等', '库存一致性']],
    ['mock_space_docs_site', ['文档路由', '发布检查']],
  ] as const;
  let initial: unknown;
  for (let run = 0; run < 2; run++) {
    const server = createMockServer({ presetProjects: true });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const address = server.address(); assert.ok(address && typeof address !== 'string');
      const post = async (path: string, body: unknown) => {
        const response = await fetch(`http://127.0.0.1:${address.port}/api/openmem/v1/${path}`, {
          method: 'POST', headers: { Authorization: 'Token mock-key', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        assert.equal(response.status, 200); return await response.json() as any;
      };
      const snapshot = [];
      for (const [spaceId, names] of expected) {
        const space = await post('get/space', { space_id: spaceId });
        assert.equal(space.data.space_id, spaceId);
        const result = await post('search/memory', { user_id: 'demo', query: '项目约定', space_ids: [spaceId], include_memory_view: ['project'] });
        assert.deepEqual(result.data.topic_detail_list.map((topic: any) => topic.topic_name), names);
        assert.ok(result.data.topic_detail_list.every((topic: any) => topic.space_id === spaceId && topic.decisions.length && topic.experiences.length));
        const memory = await post('get/memory', { space_id: spaceId, page: 1, size: 1 });
        assert.equal(memory.data.total, 2); assert.equal(memory.data.topic_detail_list.length, 1);
        snapshot.push({ space: space.data, search: result.data });
      }
      if (run === 0) initial = snapshot;
      else assert.deepEqual(snapshot, initial);
      const upload = await post('add/message', { user_id: 'demo', space_ids: [expected[0][0]], messages: [{ role: 'user', content: '测试上传' }] });
      assert.equal(upload.data.success, true);
      // Mutating one process's in-memory data cannot change the next startup fixtures.
      getMockState(server).topics.get(expected[0][0])![0]!.decisions[0].content = 'runtime edit';
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  }
});
