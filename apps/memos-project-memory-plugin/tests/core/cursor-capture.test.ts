import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, appendFile, stat, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { PluginService } from '../../src/server/service.ts';
import { processHook } from '../../src/adapters/_shared/hooks.ts';
import { captureUploads } from '../helpers/capture-uploads.ts';

const line = (row: unknown) => JSON.stringify(row) + '\n';
const native = (role: string, text: string) => ({ role, message: { content: [{ type: 'text', text }] } });

async function fixture(t: import('node:test').TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'pm-cursor-completion-'));
  const { uploads, call } = captureUploads();
  let service = new PluginService(join(home, 'data'), { home, codexRoots: [] });
  t.after(async () => { service.close(); await rm(home, { recursive: true, force: true }); });
  service.cloud.call = call;
  service.configure({ authMode: 'none' });
  service.store.bindProject('Cursor', home, 'space', service.config.value.baseUrl, 'cursor-cli');
  const path = join(home, 'transcript.jsonl');
  await writeFile(path, line(native('user', 'old task')) + line(native('assistant', 'old answer')) + line({ type: 'turn_ended', status: 'success' }));
  const hook = (name: string, extra: Record<string, unknown> = {}, generation = 'turn-1') => processHook('cursor-cli', {
    conversation_id: 'cursor-session', generation_id: generation, workspace_roots: [home], hook_event_name: name, transcript_path: path, ...extra,
  }, { env: { HOME: home }, request: event => service.event(event) });
  return { path, hook, uploads, get service() { return service; }, restart() { service.close(); service = new PluginService(join(home, 'data'), { home, codexRoots: [] }); service.cloud.call = call; } };
}

test('Cursor stop before answer flush never uploads a partial turn; long native answer completes without a timed wait', async t => {
  const f = await fixture(t);
  await f.hook('beforeSubmitPrompt', { prompt: 'new task' });
  await appendFile(f.path, line(native('user', 'new task')));
  await f.hook('stop', { status: 'completed' });
  await f.service.sync();
  assert.equal(f.uploads.length, 0);
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
  assert.deepEqual(f.uploads.map(upload => upload.space_ids), [['space']]);
  assert.equal(f.service.store.rows("SELECT * FROM traces WHERE json_extract(message,'$.role')='assistant'").length, 1);
});

test('Cursor splits an identified native answer and multiple tool results without reusing its message id', async t => {
  const f = await fixture(t);
  await f.hook('beforeSubmitPrompt', { prompt: 'new task' });
  await appendFile(f.path, [native('user', 'new task'), {
    type: 'assistant', message: { id: 'native-answer', role: 'assistant', content: [
      { type: 'text', text: 'checking' },
      { type: 'tool_use', id: 'call-a', name: 'bash', input: { command: 'pwd' } },
      { type: 'tool_use', id: 'call-b', name: 'bash', input: { command: 'ls' } },
    ] },
  }, { type: 'user', message: { id: 'native-results', role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'call-a', content: 'a' },
    { type: 'tool_result', tool_use_id: 'call-b', content: 'b' },
  ] } }, native('assistant', 'done'), { type: 'turn_ended', status: 'success' }].map(line).join(''));
  await f.hook('stop', { status: 'completed' }); await f.service.sync();
  const batch = f.service.store.batches()[0]!;
  assert.equal(batch.status, 'completed');
  assert.equal(new Set(batch.messages.map(message => message.id)).size, batch.messages.length);
  assert.deepEqual(batch.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id), ['call-a', 'call-b']);
  const frozen = JSON.stringify(batch.messages);
  f.restart(); await f.service.sync();
  assert.equal(JSON.stringify(f.service.store.batches()[0]!.messages), frozen);
  assert.deepEqual(f.uploads.map(upload => upload.space_ids), [['space']]);
});

async function writeChat(home: string, rows: unknown[]) {
  const folder = join(home, '.cursor/chats', createHash('md5').update(home).digest('hex'), 'cursor-session');
  await mkdir(folder, { recursive: true });
  const db = new DatabaseSync(join(folder, 'store.db'));
  db.exec('CREATE TABLE blobs(id TEXT PRIMARY KEY,data BLOB); CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT)');
  const blob = (data: Buffer) => {
    const hash = createHash('sha256').update(data).digest();
    db.prepare('INSERT INTO blobs VALUES(?,?)').run(hash.toString('hex'), data);
    return hash;
  };
  const root = blob(Buffer.concat(rows.flatMap(row => [Buffer.from([10, 32]), blob(Buffer.from(JSON.stringify(row)))])));
  db.prepare('INSERT INTO meta VALUES(?,?)').run('0', Buffer.from(JSON.stringify({ agentId: 'cursor-session', latestRootBlobId: root.toString('hex') })).toString('hex'));
  db.close();
}

test('Cursor joins anonymous skill reads and restores a hookless discovery result from its own generation', async t => {
  const f = await fixture(t), home = dirname(f.path);
  const reads = [{ path: '/one/SKILL.md' }, { path: '/two/SKILL.md', limit: 8 }];
  const discovery = { pattern: 'memos' };
  const call = (toolCallId: string, toolName: string, args: unknown) => ({ type: 'tool-call', toolCallId, toolName, args });
  const result = (id: string, body: string) => ({ role: 'tool', id, content: [{ type: 'tool-result', toolCallId: id, toolName: 'GetDynamicTools', result: body }] });
  const user = (requestId: string) => ({ role: 'user', providerOptions: { cursor: { requestId } } });
  const rows = [user('previous'), { role: 'assistant', content: [call('other', 'GetDynamicTools', discovery)] }, result('other', 'wrong turn'),
    user('turn-1'), { role: 'assistant', content: [call('read1', 'Read', reads[0]), call('read2', 'Read', reads[1]), call('dynamic', 'GetDynamicTools', discovery)] },
    result('dynamic', 'native discovery result')];
  await writeChat(home, rows);
  await f.hook('beforeSubmitPrompt', { prompt: 'task' });
  for (const [i, input] of reads.entries()) {
    await f.hook('postToolUse', { tool_name: 'Read', tool_use_id: 'read' + (i + 1), tool_input: input, tool_output: 'private skill body' });
  }
  await appendFile(f.path, [native('user', 'task'), { role: 'assistant', message: { content: [
    ...reads.map(input => ({ type: 'tool_use', name: 'Read', input })), { type: 'tool_use', name: 'GetDynamicTools', input: discovery },
  ] } }, native('assistant', 'done'), { type: 'turn_ended', status: 'success' }].map(line).join(''));
  await f.hook('stop'); await f.service.sync();
  const batch = f.service.store.batches()[0]!;
  assert.equal(batch.status, 'completed');
  assert.deepEqual(batch.messages.flatMap(m => m.tool_calls ?? []).map(c => (c as {id: string}).id), ['read1', 'read2', 'dynamic']);
  assert.deepEqual(batch.messages.filter(m => m.role === 'tool').map(m => m.tool_call_id).sort(), ['dynamic', 'read1', 'read2']);
  assert.equal(batch.messages.find(m => m.tool_call_id === 'dynamic')?.content, 'native discovery result');
  assert.doesNotMatch(JSON.stringify(batch.messages), /private skill body|wrong turn|SKILL\.md/);
});

test('Cursor reconciles a unique Skill read without a chat store and leaves repeated reads blocked', async t => {
  for (const [count, limit] of [[1, 7], [2, 7], [1, 9]]) {
    const f = await fixture(t);
    const input = { path: '/same/SKILL.md', limit: 7 };
    await f.hook('beforeSubmitPrompt', { prompt: 'read task' });
    await f.hook('postToolUse', { tool_name: 'Read', tool_use_id: 'known', tool_input: input, tool_output: 'private' });
    await appendFile(f.path, [native('user', 'read task'), { role: 'assistant', message: { content:
      Array.from({ length: count }, () => ({ type: 'tool_use', name: 'Read', input: { ...input, limit } })) } },
      native('assistant', 'done'), { type: 'turn_ended', status: 'success' }].map(line).join(''));
    await f.hook('stop'); await f.service.sync();
    const batch = f.service.store.batches()[0]!;
    const matched = count === 1 && limit === input.limit;
    assert.equal(batch.status, matched ? 'completed' : 'blocked');
    assert.equal(f.uploads.length, matched ? 1 : 0);
    if (!matched) assert.match(batch.error ?? '', /工具调用缺少可靠 id.*skill/);
    assert.doesNotMatch(JSON.stringify(batch.messages), /private|SKILL\.md/);
    const stored = f.service.store.rows('SELECT sourceId,message FROM traces').map(row => ({ sourceId: String(row.sourceId), message: JSON.parse(String(row.message)) }));
    const hookCall = stored.find(row => row.sourceId === 'hook:cursor-session:tool-call:known')?.message.tool_calls?.[0];
    assert.equal(hookCall?.function.name, 'Read');
    assert.deepEqual(JSON.parse(hookCall?.function.arguments), input);
    assert.equal(stored.find(row => row.message.tool_call_id === 'known')?.message.content, 'private');
  }
});

test('Cursor retains overlapping rounds for manual history across restart and delayed transcript completion', async t => {
  const f = await fixture(t);
  const submit = async (key: string) => {
    await f.hook('beforeSubmitPrompt', { prompt: key }, key);
    await appendFile(f.path, line(native('user', key)));
  };
  const finish = async (key: string) => {
    await appendFile(f.path, line(native('assistant', key + ' answer')) + line({ type: 'turn_ended', status: 'success' }));
    await f.hook('stop', { status: 'completed' }, key);
  };
  await submit('crossing');
  f.service.configure({ paused: true });
  await finish('crossing');
  await submit('paused');
  await f.hook('stop', { status: 'completed' }, 'paused');
  await f.service.sync();
  f.restart();
  f.service.configure({ paused: false });
  await appendFile(f.path, line(native('assistant', 'paused answer')) + line({ type: 'turn_ended', status: 'success' }));
  await f.service.sync();
  assert.equal(f.uploads.length, 0);
  await submit('resumed');
  await finish('resumed');
  await f.service.sync();
  assert.deepEqual(f.uploads.flatMap(body => body.messages.map(m => m.content)), ['resumed', 'resumed answer']);
  const scope = f.service.store.memory.all()[0]!;
  await f.service.history.scan(scope.id);
  assert.equal(f.service.deliveries.historyPending(scope.id, f.service.history.catalog(scope.id)), 4);
  await f.service.uploadHistory(scope.id);
  await f.service.uploadHistory(scope.id);
  const history = f.uploads.slice(1).flatMap(body => body.messages.map(m => m.content));
  assert.deepEqual(history, ['crossing', 'crossing answer', 'paused', 'paused answer']);
  assert.equal(f.service.deliveries.historyPending(scope.id, f.service.history.catalog(scope.id)), 0);
});

test('Cursor joins Glob reported as Grep and three separate Grep calls by native ID', async t => {
  const f = await fixture(t);
  const calls = ['Glob', 'Grep', 'Grep', 'Grep'].map((toolName, index) => ({
    type: 'tool-call', toolName, args: index ? { pattern: 'query-' + index } : { glob_pattern: '**/*.ts' }, toolCallId: 'id-' + index,
  }));
  await writeChat(dirname(f.path), [
    { role: 'user', providerOptions: { cursor: { requestId: 'previous' } } },
    { role: 'assistant', content: [{ ...calls[0], toolCallId: 'previous-id' }] },
    { role: 'user', providerOptions: { cursor: { requestId: 'turn-1' } } },
    { role: 'assistant', content: calls },
  ]);
  await f.hook('beforeSubmitPrompt', { prompt: 'search' });
  for (const call of calls) await f.hook('postToolUse', { tool_name: 'Grep', tool_use_id: call.toolCallId,
    tool_input: { ...call.args, output_mode: 'files' }, tool_output: 'result-' + call.toolCallId });
  await appendFile(f.path, [native('user', 'search'), { role: 'assistant', message: { content:
    calls.map(call => ({ type: 'tool_use', name: call.toolName, input: call.args })) } },
    native('assistant', 'done'), { type: 'turn_ended', status: 'success' }].map(line).join(''));
  await f.hook('stop'); await f.service.sync();
  const batch = f.service.store.batches()[0]!;
  assert.equal(batch.status, 'completed');
  assert.deepEqual(batch.messages.flatMap(m => m.tool_calls ?? []).map(value => {
    const c = value as { id: string; function: { name: string; arguments: string } };
    return [c.id, c.function.name, JSON.parse(c.function.arguments)];
  }), calls.map(c => [c.toolCallId, c.toolName, c.args]));
  assert.deepEqual(batch.messages.filter(m => m.role === 'tool').map(m => [m.tool_call_id, m.content]),
    calls.map(c => [c.toolCallId, 'result-' + c.toolCallId]));
});

test('Cursor keeps ambiguous native calls and calls found only in other turns blocked', async t => {
  for (const repeated of [true, false]) {
    const f = await fixture(t), args = { pattern: 'same' };
    const user = (requestId: string) => ({ role: 'user', providerOptions: { cursor: { requestId } } });
    const assistant = (ids: string[]) => ({ role: 'assistant', content: ids.map(toolCallId =>
      ({ type: 'tool-call', toolName: 'Grep', toolCallId, args })) });
    await writeChat(dirname(f.path), [user('previous'), assistant(['previous-id']), user('turn-1'), assistant(repeated ? ['a', 'b'] : [])]);
    await f.hook('beforeSubmitPrompt', { prompt: 'check' });
    for (const id of repeated ? ['a', 'b'] : []) await f.hook('postToolUse', { tool_use_id: id, tool_name: 'Grep', tool_input: args, tool_output: id });
    await appendFile(f.path, [native('user', 'check'), { role: 'assistant', message: { content:
      Array.from({ length: repeated ? 2 : 1 }, () => ({ type: 'tool_use', name: 'Grep', input: args })) } },
      native('assistant', 'done'), { type: 'turn_ended', status: 'success' }].map(line).join(''));
    await f.hook('stop'); await f.service.sync();
    assert.match(f.service.store.batches()[0]!.error ?? '', /工具调用缺少可靠 id.*Grep/);
    assert.equal(f.uploads.length, 0);
  }
});

test('Cursor checkpoints a recovered native boundary while waiting for the end and reuses it after restart', async t => {
  const f = await fixture(t);
  const oldEnd = line({ type: 'turn_ended', status: 'success' });
  const offset = (await stat(f.path)).size - Buffer.byteLength(oldEnd);
  await f.hook('beforeSubmitPrompt', { prompt: 'recovered task' });
  // A receipt from a submission without file evidence must recover its boundary from the native generation.
  f.service.store.db.exec("UPDATE cursor_receipts SET event=json_remove(event,'$.source','$.observed')");
  await appendFile(f.path, line({ ...native('user', 'recovered task'), generation_id: 'turn-1' }));
  await f.hook('stop');
  const receipt = () => f.service.store.row("SELECT json_extract(event,'$.source.offset') AS offset,json_extract(event,'$.source.terminal') AS terminal,error FROM cursor_receipts");
  assert.equal(receipt()?.offset, offset);
  assert.equal(receipt()?.terminal, oldEnd);
  assert.equal(receipt()?.error, 'Cursor 等待本轮 turn_ended 完整落盘');
  assert.equal(f.service.store.batches().length, 0);

  f.restart();
  assert.equal(receipt()?.offset, offset);
  await appendFile(f.path, line(native('assistant', 'recovered answer')) + line({ type: 'turn_ended', status: 'success' }));
  await f.service.sync();
  assert.deepEqual(f.uploads.flatMap(upload => upload.messages.map(message => message.content)), ['recovered task', 'recovered answer']);
  assert.equal(receipt(), undefined);
});

test('Cursor rolls back a failed finalization including Hook replacement and retries the same receipt once', async t => {
  const f = await fixture(t);
  await f.hook('beforeSubmitPrompt', { prompt: 'retry task' });
  await f.hook('afterAgentResponse', { text: 'retry answer' });
  const store = f.service.store;
  const traces = () => store.rows('SELECT id,sourceId,message,raw,batchId FROM traces ORDER BY id');
  const before = traces();
  assert.ok(before.some(row => JSON.parse(String(row.raw)).hook_event_name === 'afterAgentResponse'));
  await appendFile(f.path, [native('user', 'retry task'), native('assistant', 'retry answer'), { type: 'turn_ended', status: 'success' }].map(line).join(''));
  store.db.exec("CREATE TEMP TRIGGER reject_cursor_commit BEFORE DELETE ON cursor_receipts BEGIN SELECT RAISE(ABORT, 'injected commit failure'); END");
  await f.hook('stop');
  assert.deepEqual(traces(), before);
  assert.equal(store.row('SELECT completedAt FROM turns')?.completedAt, null);
  assert.equal(store.row('SELECT error FROM cursor_receipts')?.error, 'injected commit failure');
  assert.equal(store.batches().length, 0);
  assert.equal(f.uploads.length, 0);

  store.db.exec('DROP TRIGGER reject_cursor_commit');
  await f.service.sync();
  await f.service.sync();
  assert.deepEqual(f.uploads.map(upload => upload.messages.map(message => message.content)), [['retry task', 'retry answer']]);
  assert.equal(store.batches().length, 1);
  assert.equal(store.row('SELECT id FROM cursor_receipts'), undefined);
  assert.equal(traces().filter(row => JSON.parse(String(row.raw)).hook_event_name === 'afterAgentResponse').length, 0);
});

for (const [scenario, expectedError] of [
  ['missing', 'Cursor 尚未定位本轮原生文件'],
  ['ambiguous', 'Cursor 会话文件存在多个候选路径，无法唯一定位'],
] as const) {
  test(`Cursor persists the ${scenario} transcript lookup error before a queued shutdown`, async t => {
    const f = await fixture(t), home = dirname(f.path);
    const identity = { agentType: 'cursor-cli', nativeSessionId: 'cursor-session', nativeTurnId: 'turn-1', cwd: home };
    if (scenario === 'ambiguous') {
      for (const name of ['one', 'two']) {
        const folder = join(home, '.cursor/projects', name);
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, '.workspace-trusted'), JSON.stringify({ workspacePath: home }));
      }
    }
    const raw = { timestamp: new Date().toISOString() };
    const turn = await f.service.cursor.context({ ...identity, event: 'turn-start', raw });
    assert.ok(turn?.conversationId);
    const stop = f.service.cursor.context({ ...identity, event: 'turn-end', raw });
    // The queued stop gets one synchronous turn to locate its transcript before shutdown.
    queueMicrotask(() => f.restart());
    await stop;

    const receiptError = () => f.service.store.row('SELECT error FROM cursor_receipts WHERE id=?', turn.conversationId)?.error;
    const diagnostics = () => f.service.store.rows('SELECT id FROM diagnostics WHERE message=?', `Cursor 轨迹补读: ${expectedError}`);
    assert.equal(receiptError(), expectedError);
    assert.equal(diagnostics().length, 1);
    await f.service.cursor.flush();
    assert.equal(receiptError(), expectedError);
    assert.equal(diagnostics().length, 1);
  });
}
