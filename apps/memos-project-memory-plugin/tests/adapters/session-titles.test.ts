import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSessionTitles } from '../../src/adapters/session-titles.ts';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'memos-session-titles-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const entry = (id: string, thread_name: string, updated_at: string) => JSON.stringify({ id, thread_name, updated_at }) + '\n';

test('Codex uses latest native index title and observes rename without rollout changes', async t => {
  const directory = await fixture(t), index = join(directory, 'session_index.jsonl');
  await writeFile(index, entry('one', 'Greeting', '2026-11-18T10:00:00Z')
    + entry('one', 'older append', '2026-11-18T09:00:00Z')
    + entry('two', 'Independent title', '2026-11-18T10:00:00Z')
    + entry('one', '', '2026-11-18T12:00:00Z') + '{incomplete\n');
  assert.deepEqual([...await readSessionTitles('codex-cli', directory)], [['one', { title: 'Greeting', titleRevision: Date.parse('2026-11-18T10:00:00Z') }], ['two', { title: 'Independent title', titleRevision: Date.parse('2026-11-18T10:00:00Z') }]]);
  await appendFile(index, entry('one', 'Manual rename', '2026-11-18T13:00:00Z'));
  assert.deepEqual((await readSessionTitles('codex-cli', directory)).get('one'), { title: 'Manual rename', titleRevision: Date.parse('2026-11-18T13:00:00Z') });
  await assert.rejects(access(join(directory, 'sessions')));
});

test('Codex does not invent titles from malformed records or prompt-like fields', async t => {
  const directory = await fixture(t);
  await writeFile(join(directory, 'session_index.jsonl'), [
    { id: 'missing-name', title: 'wrong field', updated_at: '2026-11-18T10:00:00Z' },
    { id: 'bad-date', thread_name: 'Unordered', updated_at: 'bad' },
    { id: '', thread_name: 'No identity', updated_at: '2026-11-18T10:00:00Z' },
    { id: 'empty', thread_name: '  ', updated_at: '2026-11-18T10:00:00Z' },
  ].map(value => JSON.stringify(value)).join('\n'));
  assert.equal((await readSessionTitles('codex-cli', directory)).size, 0);
});

test('DSH reads native title projection keyed by session ID and ignores unrelated or invalid files', async t => {
  const directory = await fixture(t), sessions = join(directory, 'storages/session_projcache/sessions');
  await mkdir(sessions, { recursive: true });
  const value = { version: 7, record: { identity: { cwd: '/project', createdAt: 1, formatVersion: 4 }, rows: { title: { ver: 1, seq: 22, val: 'Greeting' } } } };
  await writeFile(join(sessions, 'session-one.json'), JSON.stringify(value));
  await writeFile(join(sessions, 'session-bad.json'), JSON.stringify({ ...value, record: { ...value.record, rows: { title: { ver: 1, seq: 2, val: { title: 'guessing forbidden' } } } } }));
  await writeFile(join(sessions, 'session-future.json'), JSON.stringify({ ...value, version: 99 }));
  await writeFile(join(directory, 'outside.json'), JSON.stringify(value));
  await symlink(join(directory, 'outside.json'), join(sessions, 'session-link.json'));
  assert.deepEqual([...await readSessionTitles('deepseek-harness', directory)], [['session-one', { title: 'Greeting', titleRevision: 22 }]]);
  value.record.rows.title = { ver: 1, seq: 24, val: 'Renamed greeting' };
  await writeFile(join(sessions, 'session-one.json'), JSON.stringify(value));
  assert.deepEqual((await readSessionTitles('deepseek-harness', directory)).get('session-one'), { title: 'Renamed greeting', titleRevision: 24 });
});

test('missing or unsupported host stores return no titles without creating files', async t => {
  const directory = await fixture(t);
  assert.equal((await readSessionTitles('codex-cli', directory)).size, 0);
  assert.equal((await readSessionTitles('deepseek-harness', directory)).size, 0);
  assert.equal((await readSessionTitles('unknown', directory)).size, 0);
  await assert.rejects(access(join(directory, 'session_index.jsonl')));
  await assert.rejects(access(join(directory, 'storages')));
});
