import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adapterInstalled, installAdapter, uninstallAdapter } from '../../../src/adapters/installer.ts';
import { getProfile } from '../../../src/adapters/registry.ts';

const exec = promisify(execFile);

test('Doubao installs its query-only Skill, preserves user edits, and detects missing or edited files', async t => {
  const home = await mkdtemp(join(tmpdir(), "memos-doubao's home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const profile = getProfile('doubao-work');
  const options = { home, cwd: home };
  assert.equal(await adapterInstalled(profile, options), false);
  const installed = await installAdapter(profile.id, options);
  const skill = join(home, 'DoubaoWork/skills/memos-doubao-project-memory/SKILL.md');
  assert.deepEqual(installed.files, [skill]);
  assert.doesNotMatch(await readFile(skill, 'utf8'), /--session-id|--conversation-id|--project|ANSWER_MESSAGE_ID/);
  assert.equal(await adapterInstalled(profile, options), true);
  assert.deepEqual((await installAdapter(profile.id, options)).files, [skill]);
  await rm(skill);
  assert.equal(await adapterInstalled(profile, options), false);
  await installAdapter(profile.id, options);
  await writeFile(skill, 'user-owned');
  assert.equal(await adapterInstalled(profile, options), false);
  await assert.rejects(installAdapter(profile.id, options), /not owned/);
  await uninstallAdapter(profile.id, options);
  assert.equal(await readFile(skill, 'utf8'), 'user-owned');
});

test('installed Doubao command sends only host IDs and the literal question to the local service', async t => {
  const home = await mkdtemp(join(tmpdir(), "memos-doubao's home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const requests: unknown[] = [];
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/health') { res.end(JSON.stringify({ service: 'memos-project-memory-plugin' })); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, body: JSON.parse(body) });
    res.end(JSON.stringify({ ok: true, data: { content: 'matched fact' } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const installed = await installAdapter('doubao-work', { home, cwd: home });
  const text = await readFile(installed.files[0]!, 'utf8');
  const example = /```sh\n([^\n]+)\n```/.exec(text)![1]!;
  const command = example.replace("'<question>'", '"$@"');
  assert.notEqual(command, example);
  const query = "How did we handle 'quotes', \n$HOME and spaces?";
  const env = { ...process.env, MEMOS_PM_URL: 'http://127.0.0.1:' + (server.address() as { port: number }).port,
    MEMOS_PM_DATA_DIR: home, MCP_VM_CONVERSATION_ID: '90071992547409931', DOUBAO_OFFICE_ANSWER_MESSAGE_ID: '90071992547409932' };
  const run = (args: string[], environment = env) => exec('/bin/sh', ['-c', command, 'skill', ...args], { env: environment, cwd: home });
  assert.equal(JSON.parse((await run([query])).stdout).data.content, 'matched fact');
  const expectStatus = (status: string) => (error: Error & { stdout?: string }) => JSON.parse(error.stdout!).status === status;
  await assert.rejects(run(['--session-id', 'another', query]), expectStatus('INVALID_QUERY'));
  await assert.rejects(run([query], { ...env, DOUBAO_OFFICE_ANSWER_MESSAGE_ID: '' }), expectStatus('CONTEXT_MISSING'));
  assert.deepEqual(requests, [{ method: 'POST', url: '/api/doubao/search',
    body: { nativeSessionId: env.MCP_VM_CONVERSATION_ID, answerId: env.DOUBAO_OFFICE_ANSWER_MESSAGE_ID, query } }]);
});
