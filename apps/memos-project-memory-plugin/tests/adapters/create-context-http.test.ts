import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginService } from '../../src/server/service.ts';
import { createLocalServer } from '../../src/server/http.ts';
import { createMockServer, getMockState } from '../../dev/memos-mock/server.ts';

test('real Hook subprocess creates context while unbound and only the following user turn reaches add/message', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'memos-hook-create-'));
  const mock = createMockServer(); mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const cloud = mock.address(); assert.ok(cloud && typeof cloud !== 'string');
  const service = new PluginService(directory, { home: directory, codexRoots: [] });
  service.configure({ baseUrl: `http://127.0.0.1:${cloud.port}/api/openmem/v1`, apiKey: 'mock-key' });
  const server = createLocalServer(service); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve())); service.close();
    await new Promise<void>(resolve => mock.close(() => resolve())); await rm(directory, { recursive: true, force: true });
  });
  async function hook(name: string, promptId: string, extra: Record<string, unknown>) {
    const child = spawn(process.execPath, ['src/adapters/qwen-code/index.ts', name], {
      env: { ...process.env, MEMOS_PM_URL: url, MEMOS_PM_DATA_DIR: directory }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '', errors = '';
    child.stdout.on('data', value => output += value); child.stderr.on('data', value => errors += value);
    child.stdin.end(JSON.stringify({ session_id: 'dialog', cwd: '/session-project', hook_event_name: name, prompt_id: promptId, ...extra }));
    const [code] = await once(child, 'close'); assert.equal(code, 0, errors);
    return output ? JSON.parse(output) : undefined;
  }
  const first = await hook('UserPromptSubmit', 'create-round', { prompt: '创建项目空间', timestamp: new Date().toISOString() });
  const token = first.hookSpecificOutput.additionalContext.match(/create-context: ([^\s]+)/)?.[1];
  assert.ok(token); assert.equal(service.state().sessions.length, 0);
  assert.equal(getMockState(mock).requests.length, 0);
  const created = await fetch(url + '/api/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ context: token, name: '开发记忆', domain: '编程' }) });
  assert.equal((await created.json() as any).status, 'CREATED');
  await hook('Stop', 'create-round', { last_assistant_message: '空间创建成功', timestamp: new Date().toISOString() });
  await service.sync();
  assert.equal(getMockState(mock).requests.filter(request => request.path.endsWith('/add/message')).length, 0);
  const nextTime = new Date(Date.now() + 1000).toISOString();
  await hook('UserPromptSubmit', 'next-round', { submitted_prompt: '开始开发', timestamp: nextTime });
  await hook('Stop', 'next-round', { last_assistant_message: '开发完成', timestamp: nextTime });
  await service.sync();
  const uploads = getMockState(mock).requests.filter(request => request.path.endsWith('/add/message'));
  assert.equal(uploads.length, 1);
  assert.deepEqual((uploads[0].body as any).messages.map((message: any) => message.content), ['开始开发', '开发完成']);
});
