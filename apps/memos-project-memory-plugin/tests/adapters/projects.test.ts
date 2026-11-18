import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync } from 'node:zlib';
import { discoverProjects } from '../../src/adapters/projects.ts';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const home = await mkdtemp(join(tmpdir(), 'memos-projects-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const save = async (path: string, content: string | Buffer) => {
    const file = join(home, path);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, content);
  };
  return { home, save };
}

test('Claude projects use exact recorded cwd, deduplicate roots and ignore malformed records', async t => {
  const { home, save } = await fixture(t);
  await save('.claude/projects/encoded/session.jsonl', '{bad}\n' + JSON.stringify({ cwd: '/work/my-project' }) + '\n');
  await save('.claude/projects/other/session.jsonl', JSON.stringify({ cwd: '/work/my-project/' }) + '\n');
  await save('.claude/projects/invalid/session.jsonl', JSON.stringify({ cwd: 'relative' }) + '\n');
  assert.deepEqual(await discoverProjects('claude-code', { home }), [{ name: 'my-project', root: '/work/my-project' }]);
  assert.deepEqual(await discoverProjects('codex-cli', { home }), []);
});

test('Codex metadata discovers dated and archived sessions without interpreting user message cwd', async t => {
  const { home, save } = await fixture(t);
  await save('.codex/sessions/2026/11/18/rollout-one.jsonl', JSON.stringify({ type: 'session_meta', payload: { cwd: '/work/codex' } }) + '\n');
  await save('.codex/archived_sessions/rollout-two.jsonl', JSON.stringify({ type: 'session_meta', payload: { cwd: '/work/archive' } }) + '\n');
  await save('.codex/sessions/2026/11/18/rollout-fake.jsonl', JSON.stringify({ type: 'response_item', payload: { cwd: '/not-a-project' } }) + '\n');
  assert.deepEqual(await discoverProjects('codex-cli', { home }), [{ name: 'archive', root: '/work/archive' }, { name: 'codex', root: '/work/codex' }]);
});

test('DeepSeek reads session headers in current zstd generations without decoding lossy directory names', async t => {
  const { home, save } = await fixture(t);
  await save('.dsh/sessions/--encoded--/one/session.v3.jsonl.zstd', zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', id: 'one', cwd: '/work/项目-with-hyphen' }) + '\n')));
  await save('.dsh/sessions/--encoded--/one/session.v1.jsonl', JSON.stringify({ type: 'session', cwd: '/obsolete' }) + '\n');
  await save('.dsh/sessions/--second--/two/session.jsonl', JSON.stringify({ type: 'session', cwd: '/work/second' }) + '\n');
  assert.deepEqual(await discoverProjects('deepseek-harness', { home }), [{ name: 'second', root: '/work/second' }, { name: '项目-with-hyphen', root: '/work/项目-with-hyphen' }]);
});

test('Kimi discovers projects directly from session index and WorkBuddy uses sidecar metadata', async t => {
  const { home, save } = await fixture(t);
  await save('.kimi-code/session_index.jsonl', '{bad}\n' + JSON.stringify({ sessionId: 'one', workDir: '/work/kimi' }) + '\n');
  await save('.workbuddy/projects/key/session.meta.json', JSON.stringify({ cwd: '/work/buddy' }));
  assert.deepEqual(await discoverProjects('kimi-code', { home }), [{ name: 'kimi', root: '/work/kimi' }]);
  assert.deepEqual(await discoverProjects('workbuddy', { home }), [{ name: 'buddy', root: '/work/buddy' }]);
});

test('OpenCode reads existing databases without creating databases for missing hosts', async t => {
  const { home } = await fixture(t);
  const path = join(home, '.local/share/opencode/opencode.db');
  assert.deepEqual(await discoverProjects('opencode-v1', { home }), []);
  await assert.rejects(access(path));
  await mkdir(join(path, '..'), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE session(id TEXT, directory TEXT); INSERT INTO session VALUES('one','/work/open'),('two','/work/open');");
  db.close();
  assert.deepEqual(await discoverProjects('opencode-v1', { home }), [{ name: 'open', root: '/work/open' }]);
  assert.deepEqual(await discoverProjects('opencode-v2', { home }), [{ name: 'open', root: '/work/open' }]);
  const upgraded = new DatabaseSync(path);
  upgraded.exec("CREATE TABLE session_v2(id TEXT, directory TEXT); INSERT INTO session_v2 VALUES('three','/work/open-v2');");
  upgraded.close();
  assert.deepEqual(await discoverProjects('opencode-v2', { home }), [{ name: 'open-v2', root: '/work/open-v2' }]);
});

test('project discovery ignores external symlinks and unsupported hosts', async t => {
  const { home, save } = await fixture(t);
  await save('outside/session.jsonl', JSON.stringify({ cwd: '/outside' }) + '\n');
  await mkdir(join(home, '.claude/projects'), { recursive: true });
  await symlink(join(home, 'outside'), join(home, '.claude/projects/linked'));
  assert.deepEqual(await discoverProjects('claude-code', { home }), []);
  assert.deepEqual(await discoverProjects('unknown', { home }), []);
  assert.deepEqual(await discoverProjects('kimi-code', { home }), []);
});

test('DeepSeek honors DSH_HOME and Pi reads session metadata rather than encoded paths', async t => {
  const { home, save } = await fixture(t);
  await save('custom-dsh/sessions/project/session/session.jsonl', JSON.stringify({ type: 'session', cwd: '/work/custom' }) + '\n');
  await save('.pi/agent/sessions/--encoded--/session.jsonl', JSON.stringify({ type: 'session', cwd: '/work/pi' }) + '\n');
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = join(home, 'custom-dsh');
  try {
    assert.deepEqual(await discoverProjects('deepseek-harness'), [{ name: 'custom', root: '/work/custom' }]);
    // Explicit fixture home isolates discovery from ambient host overrides.
    assert.deepEqual(await discoverProjects('deepseek-harness', { home }), []);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
  assert.deepEqual(await discoverProjects('pi', { home }), [{ name: 'pi', root: '/work/pi' }]);
});
