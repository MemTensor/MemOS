import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PluginService } from '../../src/server/service.ts';
import { processHook } from '../../src/adapters/_shared/hooks.ts';
import { createMockServer, getMockState } from '../../dev/memos-mock/server.ts';

const line = (row: unknown) => JSON.stringify(row) + '\n';
const native = (role: string, text: string) => ({ role, message: { content: [{ type: 'text', text }] } });

async function fixture(t: import('node:test').TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'pm-cursor-completion-'));
  const mock = createMockServer(); mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const address = mock.address(); assert.ok(address && typeof address !== 'string');
  let service = new PluginService(join(home, 'data'), { home, codexRoots: [] });
  t.after(async () => { service.close(); await new Promise<void>(resolve => mock.close(() => resolve())); await rm(home, { recursive: true, force: true }); });
  service.configure({ baseUrl: `http://127.0.0.1:${address.port}/api/openmem/v1`, apiKey: 'mock-key' });
  const space = await service.cloud.call<{ space_id: string }>('create/space', { space_name: 'Cursor completion', domains: [{ domain: '编程' }] });
  const project = service.store.bindProject('Cursor', home, space.space_id, service.config.value.baseUrl, 'cursor-cli');
  const path = join(home, 'transcript.jsonl');
  await writeFile(path, line(native('user', 'old task')) + line(native('assistant', 'old answer')) + line({ type: 'turn_ended', status: 'success' }));
  const hook = (name: string, extra: Record<string, unknown> = {}, generation = 'turn-1') => processHook('cursor-cli', {
    conversation_id: 'cursor-session', generation_id: generation, workspace_roots: [home], hook_event_name: name, transcript_path: path, ...extra,
  }, { env: { HOME: home }, request: event => service.event(event) });
  return { home, path, hook, mock, project, space, get service() { return service; }, restart() { service.close(); service = new PluginService(join(home, 'data'), { home, codexRoots: [] }); } };
}

test('Cursor stop before answer flush never uploads a partial turn; long native answer completes without a timed wait', async t => {
  const f = await fixture(t);
  await f.hook('beforeSubmitPrompt', { prompt: 'new task' });
  await appendFile(f.path, line(native('user', 'new task')));
  await f.hook('stop', { status: 'completed' });
  await f.service.sync();
  assert.equal(getMockState(f.mock).uploads.get(f.space.space_id)?.length ?? 0, 0);
  assert.equal(f.service.store.batches().length, 0);
  const answer = '完整回答'.repeat(1000), encoded = line(native('assistant', answer));
  await appendFile(f.path, encoded.slice(0, encoded.length - 15));
  await f.service.sync(); assert.equal(f.service.store.batches().length, 0);
  await appendFile(f.path, encoded.slice(encoded.length - 15) + line({ type: 'turn_ended', status: 'success' }));
  await f.service.sync();
  const batch = f.service.store.batches()[0]!;
  assert.equal(batch.status, 'completed');
  assert.equal(batch.messages.at(-1)?.content, answer);
  assert.doesNotMatch(JSON.stringify(batch.messages), /old task|old answer/);
  await f.hook('afterAgentResponse', { text: answer });
  await f.hook('stop', { status: 'completed' }); await f.service.sync();
  assert.equal(f.service.store.batches().length, 1);
  assert.equal(getMockState(f.mock).uploads.get(f.space.space_id)?.length, 1);
  assert.equal(f.service.store.rows("SELECT * FROM traces WHERE json_extract(message,'$.role')='assistant'").length, 1);
});
