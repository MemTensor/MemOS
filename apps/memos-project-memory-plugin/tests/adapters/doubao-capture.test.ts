import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serialize } from 'node:v8';
import { cacheWrite, checksum, varint } from '../helpers/doubao-project-cache.ts';
import { Store } from '../../src/storage/store.ts';
import { captureDoubaoTurn, doubaoSessionsPath, doubaoChatCachePath } from '../../src/adapters/doubao-work/capture.ts';

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'doubao-capture-')), root = join(home, 'project');
  const store = new Store(':memory:');
  t.after(async () => { store.close(); await rm(home, { recursive: true, force: true }); });
  store.bindProject('project', root, 'test-space', 'http://localhost', 'doubao-work');
  const startedAt = Date.now() + 5;
  const first = { sessionId: '100', answerId: '201', questionId: '200', root, startedAt };
  const second = { ...first, questionId: '300', answerId: '301', startedAt: startedAt + 5000 };
  const system = join(doubaoSessionsPath(home), first.sessionId, 'agents', 'm_test', 'system');
  await mkdir(system, { recursive: true });
  const section = (time: number, prompt: string) => '## [' + new Date(time).toISOString() + '] 需求\n' + prompt + '\n';
  await writeFile(join(system, 'assignment.md'), '# Assignment\n- Agent ID: m_test\n- Role: main\n- Assigned by: user\n\n' + section(startedAt, 'first request') + section(second.startedAt, 'second request'));
  const save = (rows: unknown[]) => writeFile(join(system, 'trajectory.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  return { home, store, first, second, save };
}
const call = { role: 'assistant', tool_calls: [{ id: 'shared', type: 'function', function: { name: 'Read', arguments: { file_path: '/skills/example/SKILL.md' } } }] };
const result = { role: 'tool', content: 'private skill body', tool_call_id: 'shared' };
const boundary = { role: 'user', content: '\n\nsecond request' };
const answer = (content: string) => ({ role: 'assistant', content });

test('late completion seals its own turn once and removes the skill body from storage', async t => {
  const { home, store, first, second, save } = await fixture(t);
  await save([call, result, answer('first answer'), boundary, answer('second answer')]);
  assert.equal(await captureDoubaoTurn(store, second, home), 'complete');
  const endedAt = first.startedAt + 1000;
  assert.equal(await captureDoubaoTurn(store, { ...first, endedAt }, home), 'complete');
  assert.equal(await captureDoubaoTurn(store, first, home), 'complete');
  const batches = store.batches();
  assert.equal(batches.length, 2);
  assert.deepEqual(batches.find(batch => batch.messages.length === 2)?.messages.map(m => m.content), ['second request', 'second answer']);
  const rows = batches.find(batch => batch.messages.length === 4)!.messages;
  assert.deepEqual(rows.map(m => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(rows[0]!.content, 'first request');
  assert.deepEqual(rows.map(m => m.chat_time), [new Date(first.startedAt).toISOString(), undefined, undefined, new Date(endedAt).toISOString()]);
  assert.equal(rows.at(-1)!.content, 'first answer');
  assert.equal(JSON.parse(String(rows[2]!.content)).skill_name, 'example');
  assert.ok(!JSON.stringify(store.rows('SELECT * FROM traces')).includes('private skill body'));
});

function wal(messages: object[]) {
  return cacheWrite(Buffer.from([0, 1, 1, 1, 3, 1]), {messages});
}

test('caches a final reply only when all three IDs, completion state and complete tool results agree', async t => {
  const { home, store, first, save } = await fixture(t);
  const dir = doubaoChatCachePath(home);
  await mkdir(dir, { recursive: true });
  const reply = { conversation_id: first.sessionId, message_id: first.answerId, reply_id: first.questionId,
    ext: { finish_reason_chat: 'succeed:completion' },
    content_blocks_v2: [{ is_finish: true, content: { text_block: { text: 'cached final' } } }] };
  const other = { ...reply, reply_id: 'other', content_blocks_v2: [{ is_finish: true, content: { text_block: { text: 'wrong answer' } } }] };
  const path = join(dir, '000001.log');
  await save([call, result, boundary]);
  await writeFile(path, wal([other, { role: 'tool', content: reply }, { reasoning_content: reply }]));
  assert.equal(await captureDoubaoTurn(store, first, home), 'pending');
  const conflict = { ...reply, content_blocks_v2: other.content_blocks_v2 };
  await writeFile(path, wal([reply, conflict]));
  assert.equal(await captureDoubaoTurn(store, first, home), 'pending');
  const corrupt = wal([reply]); corrupt[0] ^= 1;
  await writeFile(path, corrupt);
  assert.equal(await captureDoubaoTurn(store, first, home), 'pending');
  await writeFile(path, wal([other, reply]));
  await save([call, boundary]);
  assert.equal(await captureDoubaoTurn(store, first, home), 'pending');
  await save([call, result, boundary]);
  assert.equal(await captureDoubaoTurn(store, first, home), 'complete');
  assert.equal(store.batches()[0]!.messages.at(-1)!.content, 'cached final');
});

test('project selection requires an exact bound root and remains valid through the final commit', async t => {
  const { store, first, home, save } = await fixture(t);
  await save([answer('finished')]);
  assert.equal(await captureDoubaoTurn(store, { ...first, root: join(first.root, 'nested') }, home), 'inactive');
  assert.equal(await captureDoubaoTurn(store, first, home, async () => false), 'inactive');
  assert.deepEqual(store.batches(), []);
  assert.equal(store.rows('SELECT id FROM sessions').length, 0);
});

// A single-entry restart block. Splitting the value into small literal runs makes
// the Snappy stream easy to verify by inspection.
function tableFile(message: object) {
  const snappy = (data: Buffer) => {
    const parts = [varint(data.length)];
    for (let i = 0; i < data.length; i += 40) {
      const run = data.subarray(i, i + 40);
      parts.push(Buffer.from([(run.length - 1) * 4]), run);
    }
    return Buffer.concat(parts);
  };
  const block = (key: Buffer, value: Buffer) => {
    const restarts = Buffer.alloc(8); restarts.writeUInt32LE(1, 4);
    const body = snappy(Buffer.concat([Buffer.from([0]), varint(key.length), varint(value.length), key, value, restarts]));
    const trailer = Buffer.alloc(5); trailer[0] = 1;
    trailer.writeUInt32LE(checksum(Buffer.concat([body, trailer.subarray(0, 1)])), 1);
    return Buffer.concat([body, trailer]);
  };
  const key = Buffer.concat([Buffer.from([0, 1, 1, 1, 3, 1]), Buffer.alloc(8)]);
  key.writeBigUInt64LE(257n, key.length - 8);
  const value = Buffer.concat([Buffer.from([1, 255, 17, 2]), snappy(serialize({ messages: [message] }))]);
  const data = block(key, value), index = block(key, Buffer.concat([Buffer.from([0]), varint(data.length - 5)]));
  const footer = Buffer.alloc(48);
  Buffer.concat([Buffer.from([0, 0]), varint(data.length), varint(index.length - 5)]).copy(footer);
  footer.writeBigUInt64LE(0xdb4775248b80fb57n, 40);
  return Buffer.concat([data, index, footer]);
}

test('recovers a correlated final from a compacted Snappy SSTable and compressed Blink value', async t => {
  const { home, store, first, save } = await fixture(t);
  const dir = doubaoChatCachePath(home);
  await mkdir(dir, { recursive: true });
  await save([call, result, boundary]);
  await writeFile(join(dir, '000002.ldb'), tableFile({ conversation_id: first.sessionId, message_id: first.answerId, reply_id: first.questionId,
    ext: { finish_reason_chat: 'succeed:completion' }, content_blocks_v2: [{ is_finish: true, content: { text_block: { text: 'compacted final' } } }] }));
  assert.equal(await captureDoubaoTurn(store, first, home), 'complete');
  assert.equal(store.batches()[0]!.messages.at(-1)!.content, 'compacted final');
});

test('conflicting native and cache finals remain pending even with a successful end signal', async t => {
  const { home, store, first, save } = await fixture(t);
  const dir = doubaoChatCachePath(home);
  await mkdir(dir, { recursive: true });
  await save([answer('native final')]);
  const cached = (text: string) => ({ conversation_id: first.sessionId, message_id: first.answerId, reply_id: first.questionId,
    ext: { finish_reason_chat: 'succeed:completion' }, content_blocks_v2: [{ is_finish: true, content: { text_block: { text } } }] });
  const path = join(dir, '000003.log');
  await writeFile(path, wal([cached('different final')]));
  assert.equal(await captureDoubaoTurn(store, first, home), 'pending');
  await writeFile(path, wal([cached('native final'), cached('different final')]));
  assert.equal(await captureDoubaoTurn(store, first, home), 'pending');
  await writeFile(path, wal([cached('native final')]));
  assert.equal(await captureDoubaoTurn(store, first, home), 'complete');
});
