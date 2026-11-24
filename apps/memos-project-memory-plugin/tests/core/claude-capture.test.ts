import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginService } from '../../src/server/service.ts';
import { processHook } from '../../src/adapters/_shared/hooks.ts';
import { captureUploads } from '../helpers/capture-uploads.ts';

const line = (row: unknown) => JSON.stringify({ timestamp: new Date(Date.now() + 2).toISOString(), ...row as object }) + '\n';
const user = (id: string, prompt: string, content = 'same question') => ({ uuid: id, promptId: prompt, type: 'user', message: { role: 'user', content } });
const assistant = (id: string, content: unknown[]) => ({ uuid: id, type: 'assistant', message: { role: 'assistant', content } });
const end = () => ({ type: 'system', subtype: 'stop_hook_summary', timestamp: new Date(Date.now() + 100).toISOString() });

async function setup(t: import('node:test').TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'pm-claude-'));
  const { uploads, call } = captureUploads();
  let service = new PluginService(dir, { home: dir, codexRoots: [] });
  t.after(async () => { service.close(); await rm(dir, { recursive: true, force: true }); });
  service.cloud.call = call;
  service.configure({ authMode: 'none' });
  service.store.bindProject('Claude', dir, 'space', service.config.value.baseUrl, 'claude-code');
  const path = join(dir, 'main.jsonl');
  const hook = async (name: string, extra: Record<string, unknown> = {}) => processHook('claude-code', {
    session_id: 'main', cwd: dir, prompt_id: 'p1', hook_event_name: name, transcript_path: path, ...extra,
  }, { request: event => service.event(event) });
  return { path, uploads, hook, get service() { return service; }, restart() { service.close(); service = new PluginService(dir, { home: dir, codexRoots: [] }); service.cloud.call = call; } };
}

test('Claude captures each native message once, waits for Stop flush and retains task Skill and search operations in the upload', async t => {
  const s = await setup(t);
  await s.hook('UserPromptSubmit', { prompt: 'same question' });
  await writeFile(s.path, line(user('u1', 'p1')));
  await s.hook('PostToolUse', { tool_use_id: 'skill', tool_name: 'Skill', tool_response: 'SKILL_BODY' });
  const records = [
    assistant('a1', [{ type: 'thinking', thinking: 'visible task reasoning' }, { type: 'tool_use', id: 'skill', name: 'Skill', input: { skill: 'memos-project-memory' } }]),
    { uuid: 'r1', type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'skill', content: 'SKILL_BODY' }] } },
    assistant('a2', [{ type: 'tool_use', id: 'memory', name: 'Bash', input: { command: 'memos-pm search --query question' } }]),
    { uuid: 'r2', type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'memory', content: 'MEMORY_RESULT' }] } },
    assistant('a3', [{ type: 'tool_use', id: 'business', name: 'Bash', input: { command: 'npm test' } }]),
    { uuid: 'r3', type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'business', content: 'BUSINESS_RESULT' }] } },
  ];
  await appendFile(s.path, records.map(line).join(''));
  await s.hook('PostToolUse', { tool_use_id: 'business', tool_name: 'Bash', tool_response: 'BUSINESS_RESULT' });
  await s.hook('PostToolUse', { tool_use_id: 'business', tool_name: 'Bash', tool_response: 'BUSINESS_RESULT' });
  await s.hook('Stop', { last_assistant_message: 'finished' });
  assert.equal(s.service.store.batches().length, 0, 'Stop cannot freeze a transcript before the final message is flushed');
  s.restart();
  await appendFile(s.path, line(assistant('final', [{ type: 'text', text: 'finished' }])) + line(end()));
  await s.service.sync();
  const batch = s.service.store.batches()[0]!;
  assert.equal(batch.status, 'completed'); assert.equal(batch.attempts, 1);
  assert.deepEqual(s.uploads[0]?.space_ids, ['space']);
  assert.deepEqual(s.uploads[0]?.messages, batch.messages);
  const raw = s.service.store.rows('SELECT id,sourceId,raw,message FROM traces ORDER BY id');
  assert.equal(raw.length, 8); assert.equal(new Set(raw.map(r => r.sourceId)).size, 8);
  assert.equal(batch.messages.filter(m => m.role === 'user').length, 1);
  assert.deepEqual(batch.messages.map(m => m.role), ['user','assistant','assistant','tool','assistant','tool','assistant','tool','assistant']);
  for (const expected of ['visible task reasoning','BUSINESS_RESULT','finished','memos-project-memory','MEMORY_RESULT','memos-pm search']) assert.ok(JSON.stringify(batch.messages).includes(expected));
  assert.doesNotMatch(JSON.stringify({ raw, messages: batch.messages }), /SKILL_BODY/);
  await s.hook('Stop', { last_assistant_message: 'finished' }); await s.service.sync();
  assert.equal(s.service.store.rows('SELECT * FROM claude_receipts').length, 0);
  assert.equal(s.service.store.batches().length, 1); assert.equal(s.uploads.length, 1);
  assert.deepEqual(s.service.store.rows('SELECT id,sourceId,raw,message FROM traces ORDER BY id'), raw);
  await s.hook('UserPromptSubmit', { prompt_id: 'p2', prompt: 'same question' });
  await appendFile(s.path, line(user('u2', 'p2')) + line(assistant('final2', [{ type: 'text', text: 'second reply' }])));
  await s.hook('Stop', { prompt_id: 'p2', last_assistant_message: 'second reply' });
  assert.equal(s.service.store.batches().length, 1, 'the previous turn summary cannot complete this turn');
  await appendFile(s.path, line(end())); await s.service.sync();
  assert.equal(s.service.store.batches().length, 2);
  assert.equal(s.service.store.batches()[1]!.messages.filter(m => m.role === 'user').length, 1);
});
