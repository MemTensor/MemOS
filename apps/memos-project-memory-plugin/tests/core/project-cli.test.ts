import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../src/cli/run.ts';

const commands = [
  { args: ['bind', '--space-id', ' space '], path: '/api/bind-project', body: { spaceId: 'space' }, statuses: ['BOUND'] },
  { args: ['spaces'], path: '/api/project-spaces', body: {}, statuses: ['FOUND', 'EMPTY'] },
  { args: ['unbind', '--space-id', ' space '], path: '/api/unbind-project', body: { spaceId: 'space' }, statuses: ['UNBOUND', 'NOT_BOUND'] },
];

test('project commands send only their own arguments with host identity and preserve returned results', async () => {
  for (const command of commands) for (const status of command.statuses) {
    const calls: unknown[] = [];
    const response = { ok: true, status, data: { agentType: 'qwen-code', root: '/project', ...command.body, spaces: [] }, error: null };
    const request = async <T>(path: string, body: unknown): Promise<T> => { calls.push({ path, body }); return response as T; };
    assert.deepEqual(await run(command.args, request, { MEMOS_PM_BIND_CONTEXT: 'current' }), response);
    assert.deepEqual(calls, [{ path: command.path, body: { context: 'current', ...command.body } }]);
  }
});

test('project commands reject routing overrides, duplicate or missing IDs, and spaces rejects all arguments', async () => {
  let calls = 0;
  const request = async <T>(): Promise<T> => { calls++; return {} as T; };
  for (const name of ['bind', 'unbind']) {
    for (const args of [[], ['--space-id', ' '], ['--space-id', 'x', '--space-id', 'y'], ['--space-id', 'x', '--context', 'old'], ['--space-id', 'x', '--project-root', '/other']])
      assert.equal((await run([name, ...args], request, {})).status, 'INVALID_INPUT', `${name}: ${args}`);
  }
  for (const args of [['--context', 'old'], ['--agent-type', 'codex-cli'], ['--project-root', '/other'], ['--space-id', 'x'], ['extra']])
    assert.equal((await run(['spaces', ...args], request, {})).status, 'INVALID_INPUT', String(args));
  for (const command of commands) assert.equal((await run(command.args, request, {})).status, 'CONTEXT_MISSING', command.args[0]);
  assert.equal(calls, 0);
});

test('conflicting, absent and inherited parent identities cannot reach a project operation', async () => {
  const paths: string[] = [];
  const request = async <T>(path: string): Promise<T> => { paths.push(path); return { context: path === '/api/bind-context' ? 'child-round' : '' } as T; };
  assert.equal((await run(['spaces'], request, { CODEX_THREAD_ID: 'one', COPILOT_AGENT_SESSION_ID: 'two' })).status, 'CONTEXT_MISSING');
  assert.deepEqual(paths, []);
  assert.equal((await run(['spaces'], async <T>() => ({ context: '' } as T), { DSH_SESSION_ID: 'native' })).status, 'CONTEXT_MISSING');
  assert.equal((await run(['unbind', '--space-id', 'space'], request, { MEMOS_PM_BIND_CONTEXT: 'parent-round', CODEX_THREAD_ID: 'child-session' })).status, 'CONTEXT_MISSING');
  assert.deepEqual(paths, ['/api/bind-context']);
});

test('project commands report transport loss without retrying', async () => {
  for (const command of commands) {
    let calls = 0;
    const result = await run(command.args, async () => { calls++; throw new Error('response lost'); }, { MEMOS_PM_BIND_CONTEXT: 'current' });
    assert.equal(result.status, 'UNAVAILABLE', command.args[0]);
    assert.equal(calls, 1);
  }
});
