import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installAdapter } from '../../src/adapters/installer.ts';
import { normalizeHook } from '../../src/adapters/_shared/hooks.ts';
import { PluginService } from '../../src/server/service.ts';
import { captureUploads } from '../helpers/capture-uploads.ts';

interface RecordedCase {
  id: string;
  call_id: string;
  command: string;
  output_prefix: string;
  output_suffix: string;
  output_bytes: number;
  output_sha256: string;
}
const suite: { skill: { text: string; bytes: number; sha256: string }; cases: RecordedCase[] } = JSON.parse(
  await readFile(new URL('../fixtures/memos-skill-command-cases.json', import.meta.url), 'utf8'),
);

test('the five recorded Skill outputs retain their original byte lengths and hashes', () => {
  assert.equal(Buffer.byteLength(suite.skill.text), suite.skill.bytes);
  assert.equal(createHash('sha256').update(suite.skill.text).digest('hex'), suite.skill.sha256);
  for (const sample of suite.cases) {
    const output = sample.output_prefix + suite.skill.text + sample.output_suffix;
    assert.equal(Buffer.byteLength(output), sample.output_bytes, sample.id);
    assert.equal(createHash('sha256').update(output).digest('hex'), sample.output_sha256, sample.id);
  }
});

for (const sample of suite.cases) test(`${sample.id}: retain the complete Skill read locally and exclude it only from upload`, async t => {
  const home = await mkdtemp(join(tmpdir(), 'pm-owned-skill-case-'));
  const sources = join(home, '.codex', 'sessions'), project = join(home, 'project');
  await mkdir(sources, { recursive: true });
  await mkdir(project);
  const installed = await installAdapter('codex-cli', { home, cwd: project });
  const skillPath = installed.files.find(path => path.endsWith('/memos-project-memory/SKILL.md'))!;
  assert.ok(skillPath);
  const { uploads, call } = captureUploads();
  const service = new PluginService(join(home, 'data'), { home, codexRoots: [sources] });
  t.after(async () => { service.close(); await rm(home, { recursive: true, force: true }); });
  service.configure({ authMode: 'none' });
  service.cloud.call = call;
  service.store.bindProject('Fixture', project, 'space', service.config.value.baseUrl, 'codex-cli');
  service.store.db.exec("UPDATE capture_windows SET startedAt='2025-01-01T00:00:00.000Z'");
  service.store.db.exec("UPDATE bindings SET boundAt='2025-01-01T00:00:00.000Z'");

  // Keep the real shell syntax and original output. Only relocate the archived
  // machine's Skill paths to this fixture's installer-owned file.
  const command = sample.command.replace(/\/[^\s;|&"']*\/SKILL\.md/g, skillPath);
  const output = sample.output_prefix + suite.skill.text + sample.output_suffix;
  const searchId = `search-${sample.id}`;
  const searchCommand = 'memos-pm search --session-id fixture --conversation-id turn --query "backup strategy"';
  const searchResult = '{"status":"FOUND","data":{"content":"SEARCH_RESULT_SENTINEL"}}';
  const event = (type: string, payload: object, ordinal: number) => ({ type, payload, ordinal, timestamp: `2026-01-01T00:00:${String(ordinal).padStart(2, '0')}.000Z` });
  const rows = [
    event('session_meta', { id: sample.id, cwd: project, source: 'cli' }, 0),
    event('event_msg', { type: 'task_started', turn_id: 'turn', root_turn_id: 'turn' }, 1),
    event('response_item', { type: 'message', id: 'user', role: 'user', content: 'Implement the requested project change.' }, 2),
    event('response_item', { type: 'function_call', id: sample.call_id, call_id: sample.call_id, name: 'exec_command', arguments: JSON.stringify({ cmd: command }) }, 3),
    event('response_item', { type: 'function_call_output', id: `${sample.call_id}-result`, call_id: sample.call_id, output }, 4),
    event('response_item', { type: 'function_call', id: searchId, call_id: searchId, name: 'exec_command', arguments: JSON.stringify({ cmd: searchCommand }) }, 5),
    event('response_item', { type: 'function_call_output', id: `${searchId}-result`, call_id: searchId, output: searchResult }, 6),
    event('response_item', { type: 'message', id: 'answer', role: 'assistant', content: 'PROJECT_CHANGE_FINISHED', phase: 'final_answer' }, 7),
    event('event_msg', { type: 'task_complete', turn_id: 'turn' }, 8),
  ];
  const path = join(sources, 'rollout-real-case.jsonl');
  await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  await service.event(await normalizeHook('codex-cli', { session_id: sample.id, turn_id: 'turn', cwd: project, transcript_path: path, hook_event_name: 'Stop' }));
  await service.sync();

  const batches = service.store.batches();
  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.status, 'completed', batches[0]!.error ?? sample.id);
  assert.equal(uploads.length, 1);
  const uploaded = uploads[0]!.messages;
  assert.equal(uploaded.length, 4, 'keep the user, search call/result and final answer');
  assert.doesNotMatch(JSON.stringify(uploaded), new RegExp(sample.call_id));
  assert.doesNotMatch(JSON.stringify(uploaded), /# Search Project Memory|migration_tool\.py|cli-contract\.md/);
  assert.match(JSON.stringify(uploaded), /PROJECT_CHANGE_FINISHED/);
  assert.deepEqual(uploaded[1]!.tool_calls, [{ id: searchId, type: 'function', function: { name: 'exec_command', arguments: JSON.stringify({ cmd: searchCommand }) } }]);
  assert.equal(uploaded[2]!.tool_call_id, searchId);
  assert.equal(uploaded[2]!.content, searchResult);
  const storedRows = service.store.rows('SELECT raw,message FROM traces');
  const stored = storedRows.map(row => JSON.parse(String(row.message)));
  assert.equal(stored.length, 6);
  assert.deepEqual(stored[1].tool_calls, [{ id: sample.call_id, type: 'function', function: { name: 'exec_command', arguments: JSON.stringify({ cmd: command }) } }]);
  assert.equal(stored[2].tool_call_id, sample.call_id);
  assert.equal(stored[2].content, output);
  assert.ok(storedRows.every(row => JSON.parse(String(row.raw)).type !== 'memos-skill-read'));
  const session = service.store.rows('SELECT id FROM sessions')[0]!;
  const detail = service.store.sessionDetail(String(session.id), 1, 100);
  assert.deepEqual(detail.traces.map(row => row.message), stored);
  const cached = JSON.stringify(service.store.rows('SELECT state FROM codex_sources'));
  assert.match(cached, /SEARCH_RESULT_SENTINEL/);
  assert.match(cached, /# Search Project Memory/);
});

test('a complete installed Skill call survives restart and its delayed result is filtered only on upload', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pm-owned-skill-late-'));
  const sources = join(home, '.codex', 'sessions'), project = join(home, 'project'), data = join(home, 'data');
  await mkdir(sources, { recursive: true });
  await mkdir(project);
  const installed = await installAdapter('codex-cli', { home, cwd: project });
  const skillPath = installed.files.find(path => path.endsWith('/memos-project-memory/SKILL.md'))!;
  const { uploads, call } = captureUploads();
  let service = new PluginService(data, { home, codexRoots: [sources] });
  t.after(async () => { service.close(); await rm(home, { recursive: true, force: true }); });
  service.configure({ authMode: 'none' });
  service.cloud.call = call;
  service.store.bindProject('Fixture', project, 'space', service.config.value.baseUrl, 'codex-cli');
  service.store.db.exec("UPDATE capture_windows SET startedAt='2025-01-01T00:00:00.000Z'");
  service.store.db.exec("UPDATE bindings SET boundAt='2025-01-01T00:00:00.000Z'");
  const sample = suite.cases[0]!;
  const event = (type: string, payload: object, ordinal: number) => ({ type, payload, ordinal, timestamp: `2026-01-01T00:00:${String(ordinal).padStart(2, '0')}.000Z` });
  const first = [
    event('session_meta', { id: 'late-skill', cwd: project, source: 'cli' }, 0),
    event('event_msg', { type: 'task_started', turn_id: 'turn', root_turn_id: 'turn' }, 1),
    event('response_item', { type: 'message', id: 'user', role: 'user', content: 'Keep the project task.' }, 2),
    event('response_item', { type: 'function_call', id: sample.call_id, call_id: sample.call_id, name: 'exec_command', arguments: JSON.stringify({ cmd: sample.command.replace(/\/[^\s;|&"']*\/SKILL\.md/g, skillPath) }) }, 3),
  ];
  const path = join(sources, 'rollout-late-skill.jsonl');
  await writeFile(path, first.map(row => JSON.stringify(row)).join('\n') + '\n');
  await service.captureCodex(true);
  assert.equal(service.store.batches().length, 0, 'the task has not completed');
  assert.match(JSON.stringify(service.store.rows('SELECT raw,message FROM traces')), /SKILL\.md/);
  assert.match(JSON.stringify(service.store.rows('SELECT state FROM codex_sources')), /SKILL\.md/);

  service.close();
  service = new PluginService(data, { home, codexRoots: [sources] });
  service.cloud.call = call;
  const rest = [
    event('response_item', { type: 'function_call_output', id: `${sample.call_id}-result`, call_id: sample.call_id, output: sample.output_prefix + suite.skill.text + sample.output_suffix }, 4),
    event('response_item', { type: 'message', id: 'answer', role: 'assistant', content: 'LATE_RESULT_PROJECT_FINISHED', phase: 'final_answer' }, 5),
    event('event_msg', { type: 'task_complete', turn_id: 'turn' }, 6),
  ];
  await appendFile(path, rest.map(row => JSON.stringify(row)).join('\n') + '\n');
  const original = await readFile(path, 'utf8');
  await service.event(await normalizeHook('codex-cli', { session_id: 'late-skill', turn_id: 'turn', cwd: project, transcript_path: path, hook_event_name: 'Stop' }));
  await service.sync();
  assert.equal(service.store.batches().length, 1);
  assert.equal(service.store.batches()[0]!.status, 'completed');
  assert.equal(uploads.length, 1);
  assert.deepEqual(uploads[0]!.messages.map(message => message.content), ['Keep the project task.', 'LATE_RESULT_PROJECT_FINISHED']);
  assert.doesNotMatch(JSON.stringify(uploads), new RegExp(sample.call_id));
  assert.match(JSON.stringify(service.store.rows('SELECT raw,message FROM traces')), /# Search Project Memory/);
  assert.match(JSON.stringify(service.store.rows('SELECT state FROM codex_sources')), /# Search Project Memory/);
  await service.captureCodex(true);
  await service.sync();
  assert.equal(uploads.length, 1, 're-reading the source does not upload duplicate task messages');
  assert.equal(await readFile(path, 'utf8'), original, 'the native agent log is never rewritten');
});
