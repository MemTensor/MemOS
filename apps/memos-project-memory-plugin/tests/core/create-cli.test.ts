import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { run } from '../../src/cli/run.ts';

const execute = promisify(execFile);
const entry = fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url));
async function fixture(t: test.TestContext, response: unknown) {
  const requests: Array<{ path: string; body: unknown }> = [];
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/health') return void res.end(JSON.stringify({ service: 'memos-project-memory-plugin' }));
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ path: req.url!, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
    res.end(JSON.stringify(response));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const env = { ...process.env, MEMOS_PM_URL: `http://127.0.0.1:${address.port}` };
  const cli = async (args: string[]) => {
    try { const result = await execute(process.execPath, [entry, ...args], { env }); return { ...result, code: 0 }; }
    catch (error) { const result = error as Error & { stdout: string; stderr: string; code: number }; return { stdout: result.stdout, stderr: result.stderr, code: result.code }; }
  };
  return { requests, cli };
}

test('create CLI sends only the current host context and confirmed name/domain', async t => {
  const created = { ok: true, status: 'CREATED', data: { spaceId: 'new-space', spaceName: '项目空间', agentType: 'codex-cli', root: '/session-project', projectId: 'p', scopeId: 'scope', uploadStartsNextTurn: true }, error: null };
  const { cli, requests } = await fixture(t, created);
  const result = await cli(['create', '--context', 'host-context', '--name', '项目空间', '--domain', '编程']);
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), created);
  assert.deepEqual(requests, [{ path: '/api/create', body: { context: 'host-context', name: '项目空间', domain: '编程' } }]);
});

test('create validates confirmed inputs without accepting a model-supplied project or Agent', async t => {
  const { cli, requests } = await fixture(t, {});
  const invalid = [
    ['--context', 'c', '--domain', '编程'],
    ['--context', 'c', '--name', '空间'],
    ['--context', 'c', '--name', ' ', '--domain', '编程'],
    ['--context', 'c', '--name', '空间', '--domain', '字'.repeat(25)],
    ['--context', 'c', '--name', '空间', '--domain', '编程', '--project-root', '/other'],
    ['--context', 'c', '--name', '空间', '--domain', '编程', '--agent-type', 'claude-code'],
    ['--context', 'c', '--name', '空间', '--domain', '编程', '--name', '另一个'],
  ];
  for (const args of invalid) {
    const result = await run(['create', ...args], async () => { throw new Error('invalid input reached transport'); });
    assert.equal(result.status, 'INVALID_INPUT', JSON.stringify(args));
  }
  const invalidProcess = await cli(['create', '--name', '空间']);
  assert.equal(invalidProcess.code, 1);
  assert.equal(JSON.parse(invalidProcess.stdout).status, 'INVALID_INPUT');
  const missing = await cli(['create', '--name', '空间', '--domain', '编程']);
  assert.equal(JSON.parse(missing.stdout).status, 'CONTEXT_MISSING');
  assert.equal(requests.length, 0);
});

test('create preserves uncertain and partially successful results without retrying', async t => {
  for (const failure of [
    { ok: false, status: 'CREATE_UNCERTAIN', data: null, error: { message: '请核对云端结果' } },
    { ok: false, status: 'BINDING_FAILED', data: null, error: { message: '已创建，绑定失败', spaceId: 'created-space' } },
  ]) {
    const { cli, requests } = await fixture(t, failure);
    const result = await cli(['create', '--context', 'c', '--name', '空间', '--domain', '编程']);
    assert.equal(result.code, 1);
    assert.deepEqual(JSON.parse(result.stdout), failure);
    assert.equal(requests.length, 1);
  }
});

test('existing search command keeps its route, identifiers and output contract', async t => {
  const found = { ok: true, status: 'FOUND', data: { topics: [{ title: '约定' }] }, error: null };
  const { cli, requests } = await fixture(t, found);
  const result = await cli(['search', '--session-id', 's', '--conversation-id', 'turn', '--query', '约定']);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), found);
  assert.deepEqual(requests, [{ path: '/api/search', body: { sessionId: 's', conversationId: 'turn', query: '约定' } }]);
});

test('create transport loss is uncertain and never retried', async () => {
  let calls = 0;
  const request = async <T>(): Promise<T> => { calls++; throw new Error('connection lost after submit'); };
  const result = await run(['create', '--context', 'c', '--name', '空间', '--domain', '编程'], request);
  assert.equal(result.status, 'CREATE_UNCERTAIN');
  assert.equal(calls, 1);
});
