import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { PluginService } from '../../../src/server/service.ts';
import { createMockServer, getMockState } from '../../../dev/memos-mock/server.ts';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const home = await mkdtemp(join(tmpdir(), 'pm-prime-capture-'));
  const mock = createMockServer(); mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const address = mock.address(); assert.ok(address && typeof address !== 'string');
  let service = new PluginService(join(home, 'data'), { home, codexRoots: [] });
  t.after(async () => { service.close(); await new Promise<void>(resolve => mock.close(() => resolve())); await rm(home, { recursive: true, force: true }); });
  service.configure({ baseUrl: `http://127.0.0.1:${address.port}/api/openmem/v1`, apiKey: 'mock-key' });
  const space = await service.cloud.call<{ space_id: string }>('create/space', { space_name: 'Prime', domains: [{ domain: '编程' }] });
  const cwd = join(home, 'project'), root = join(home, '.prime/agent/sessions'), path = join(root, 'native.jsonl');
  await mkdir(root, { recursive: true });
  await mkdir(join(home, '.memos-project-memory/adapters'), { recursive: true });
  await writeFile(join(home, '.memos-project-memory/adapters/prime-agent.json'), JSON.stringify({ installed: true }));
  service.store.bindProject('project', cwd, space.space_id, service.config.value.baseUrl, 'prime-agent');
  let time = Date.now() + 10, seq = 0;
  const rows: Record<string, unknown>[] = [{ type: 'session', id: 'native', cwd, rlmDepth: 0 }];
  const status = { sessionId: 'native', sessionFile: path, cwd, activity: 'idle', isStreaming: false, isCompacting: false, isSessionActive: false, unfinishedActionCount: 0, sessionActions: { queuedCount: 0, steering: [], followUps: [] } };
  const connect = () => { service.prime.readStatus = async () => [status]; }; connect();
  const add = (message: Record<string, unknown>) => {
    const row = { type: 'message', id: `entry-${++seq}`, parentId: rows.length === 1 ? null : rows.at(-1)!.id,
      timestamp: new Date(++time).toISOString(), message }; rows.push(row); return row;
  };
  const save = () => writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  return { rows, status, add, save, get service() { return service; },
    restart() { service.close(); service = new PluginService(join(home, 'data'), { home, codexRoots: [] }); connect(); },
    uploads: () => getMockState(mock).uploads.get(space.space_id) ?? [] };
}

test('Prime native terminal conversation uploads full tool trace once after idle; replay/restart deduplicate', async t => {
  const f = await fixture(t);
  f.add({ role: 'user', content: [{ type: 'text', text: 'check project' }] });
  f.add({ role: 'assistant', content: [{ type: 'thinking', thinking: 'inspect it' }, { type: 'toolCall', id: 'call', name: 'python_repl', arguments: { code: 'print(1)' } }], stopReason: 'toolUse' });
  await f.save(); await f.service.sync(); assert.equal(f.uploads().length, 0);
  f.add({ role: 'toolResult', toolCallId: 'call', toolName: 'python_repl', content: [{ type: 'text', text: '1' }] });
  f.add({ role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' });
  f.status.isStreaming = true;
  await f.save(); await f.service.sync(); assert.equal(f.uploads().length, 0);
  f.status.isStreaming = false;
  await f.service.sync(); assert.equal(f.uploads().length, 1);
  const messages = f.uploads()[0]!.body.messages;
  assert.deepEqual(messages.map((m: { role: string }) => m.role), ['user', 'assistant', 'assistant', 'tool', 'assistant']);
  assert.equal(messages[1].content, 'inspect it');
  assert.deepEqual(messages[2].tool_calls, [{ id: 'call', type: 'function', function: { name: 'python_repl', arguments: '{"code":"print(1)"}' } }]);
  assert.equal(messages[3].tool_call_id, 'call');
  assert.deepEqual(JSON.parse(messages[3].content), [{ type: 'text', text: '1' }]);
  assert.equal(messages[4].content, 'done');
  assert.deepEqual(messages.map((m: { id: string }) => m.id), ['entry-1', 'entry-2:part:0', 'entry-2:part:1', 'entry-3', 'entry-4']);
  const sourceTimes = f.rows.filter(row => row.type === 'message').map(row => row.timestamp);
  assert.deepEqual(messages.map((m: { chat_time: string }) => m.chat_time), [sourceTimes[0], sourceTimes[1], sourceTimes[1], sourceTimes[2], sourceTimes[3]]);
  assert.equal(f.service.store.rows('SELECT * FROM projects').length, 1);
  await f.service.sync(); f.restart(); await f.service.sync(); assert.equal(f.uploads().length, 1);
});
