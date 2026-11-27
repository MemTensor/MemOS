import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Message } from '../../src/adapters/types.ts';

test('historical materialization keeps Skill bodies locally and filters them only from upload', async t => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { PluginService } = await import('../../src/server/service.ts');
  const home = await mkdtemp(join(tmpdir(), 'pm-task-history-'));
  const service = new PluginService(join(home, 'data'), { home, codexRoots: [] });
  t.after(async () => { service.close(); await rm(home, { recursive: true, force: true }); });
  service.configure({ baseUrl: 'http://fixture', apiKey: 'fixture-key' });
  const project = service.store.bindProject('History', home, 'space', 'http://fixture', 'claude-code');
  service.store.setSpaceDomains('http://fixture', 'space', ['编程']);
  const source = join(home, '.claude/projects/project'); await mkdir(source, { recursive: true });
  const messages: Message[] = [
    { role: 'user', content: 'Read the skill' },
    { role: 'user', source: { kind: 'skill-catalog' }, content: 'HOST_CATALOG' },
    { role: 'assistant', content: [{ type: 'text', source: { kind: 'system-prompt' }, text: 'HOST_PROMPT' }, { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: '/skills/demo/SKILL.md' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read', content: 'Actual skill contents' }] },
    { role: 'assistant', content: 'done', stop_reason: 'end_turn' },
  ];
  await writeFile(join(source, 'session.jsonl'), messages.map((message, i) => JSON.stringify({ uuid: String(i), cwd: home, sessionId: 'history', timestamp: '2020-01-01T00:00:00Z', message })).join('\n') + '\n');
  const sent: any[] = [];
  service.cloud.call = async (endpoint: string, body: unknown) => {
    if (endpoint === 'add/message') { sent.push(body); return { success: true, task_id: 'task' } as any; }
    return (endpoint === 'get/status' ? { status: 'completed', memory_views: { project: { open_episode_messages: 0, memory_ids: [] } } } : { topic_detail_list: [] }) as any;
  };
  await service.history.scan(project.scopeId);
  assert.equal(service.store.rows('SELECT * FROM traces').length, 0, 'scanning must not import bodies');
  await service.uploadHistory(project.scopeId);
  const rows = service.store.rows('SELECT raw,message FROM traces ORDER BY id');
  assert.equal(rows.length, 4);
  assert.doesNotMatch(JSON.stringify(rows), /HOST_/);
  assert.doesNotMatch(JSON.stringify(sent), /Actual skill contents/);
  assert.match(JSON.stringify(sent), /skill_name/);
  assert.match(JSON.stringify(service.store.rows('SELECT raw,message FROM traces')), /Actual skill contents/);
  assert.equal(sent[0].messages[1].tool_calls[0].function.name, 'skill');
  assert.equal(sent[0].messages[1].tool_calls[0].id, 'read');
  assert.deepEqual(JSON.parse(sent[0].messages[1].tool_calls[0].function.arguments), { skill_name: 'demo' });
  assert.equal(sent[0].messages[2].tool_call_id, 'read');
  assert.ok(sent[0].messages.every((message: Message) => message.chat_time === '2020-01-01T00:00:00.000Z'));
  assert.equal(service.deliveries.historyPending(project.scopeId, service.history.catalog(project.scopeId)), 0);
});
