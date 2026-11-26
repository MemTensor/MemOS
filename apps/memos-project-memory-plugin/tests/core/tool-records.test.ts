import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Message, TraceInput } from '../../src/adapters/types.ts';
import { filterBindRecords, filterToolRecords, isBindControl, isTraceControl } from '../../src/adapters/_shared/bind-records.ts';

const owned = (tool: string, args: unknown) => tool === 'read' && (args as { path?: string })?.path === '/installed/SKILL.md';
const call = (id: string, path = '/installed/SKILL.md') => ({ id, type: 'function', function: { name: 'read', arguments: { path } } });
const record = (sourceId: string, message: Message, session = 'session', turn = 'turn'): TraceInput & { originSessionId: string } => ({
  sourceId, nativeTurnId: turn, originSessionId: session, raw: { timestamp: '2026-01-01T00:00:00Z', privateBody: 'RAW_PRIVATE', message }, message,
});
const filter = <T extends TraceInput>(records: T[]) => filterToolRecords(records, owned, 'memos-skill-read');

test('owned tool reads and results become body-free controls while sibling task content survives', () => {
  const rows = [
    record('call', { role: 'assistant', content: 'KEEP_TEXT', tool_calls: [call('owned'), call('other', '/project/file')] }),
    record('result', { role: 'tool', tool_call_id: 'owned', content: 'SKILL_BODY' }),
    record('other-result', { role: 'tool', tool_call_id: 'other', content: 'KEEP_RESULT' }),
  ];
  const filtered = filter(rows);
  assert.equal(filtered.length, rows.length);
  assert.equal(filtered[0]!.message!.content, 'KEEP_TEXT');
  assert.deepEqual(filtered[0]!.message!.tool_calls, [call('other', '/project/file')]);
  assert.deepEqual((filtered[0]!.raw as any).skillCallIds, ['owned']);
  assert.ok(isTraceControl(filtered[1]!));
  assert.equal(isBindControl(filtered[1]!), false);
  assert.deepEqual(filtered[1]!.message, { role: 'system', content: '' });
  assert.doesNotMatch(JSON.stringify(filtered.slice(0, 2)), /SKILL_BODY|RAW_PRIVATE/);
  assert.deepEqual(filtered[2], rows[2]);
  assert.deepEqual(filter(filtered), filtered);
});

test('persisted controls pair late results only inside the same session and turn', () => {
  const prior = JSON.parse(JSON.stringify(filter([record('call', { role: 'assistant', content: '', tool_calls: [call('same')] })])));
  const rows = [
    ...prior,
    record('late', { role: 'tool', tool_call_id: 'same', content: 'PRIVATE' }),
    record('other-session', { role: 'tool', tool_call_id: 'same', content: 'OTHER_SESSION' }, 'another'),
    record('other-turn', { role: 'tool', tool_call_id: 'same', content: 'OTHER_TURN' }, 'session', 'another'),
  ];
  const filtered = filter(rows);
  assert.ok(isTraceControl(filtered[1]!));
  assert.equal(filtered[2]!.message!.content, 'OTHER_SESSION');
  assert.equal(filtered[3]!.message!.content, 'OTHER_TURN');
  assert.deepEqual(filterBindRecords(filtered), filtered, 'Skill controls do not become bind decisions');
});

test('partial bind and Skill exclusion metadata survives either filter order', () => {
  const bind = { id: 'bind', type: 'function', function: { name: 'exec_command', arguments: { cmd: 'memos-pm bind --space-id private' } } };
  const rows = [record('mixed', { role: 'assistant', content: 'KEEP', tool_calls: [bind, call('owned'), call('other', '/project/file')] })];
  for (const filtered of [filter(filterBindRecords(rows)), filterBindRecords(filter(rows))]) {
    const raw = filtered[0]!.raw as any;
    assert.deepEqual(raw.bindCallIds, ['bind']);
    assert.deepEqual(raw.skillCallIds, ['owned']);
    assert.deepEqual(filtered[0]!.message!.tool_calls, [call('other', '/project/file')]);
    assert.doesNotMatch(JSON.stringify(filtered), /RAW_PRIVATE|private|\/installed\/SKILL/);
  }
});

test('conflicting owned and unrelated invocations with the same scoped call ID are rejected', () => {
  const rows = [
    record('one', { role: 'assistant', content: '', tool_calls: [call('same')] }),
    record('two', { role: 'assistant', content: '', tool_calls: [call('same', '/project/file')] }),
  ];
  assert.throws(() => filter(rows), /conflict/i);
  const prior = filter([rows[0]!]);
  assert.throws(() => filter([...prior, rows[1]!]), /conflict/i);
});

test('tool blocks are removed individually without deleting text or unrelated results', () => {
  const rows = [
    record('calls', { role: 'assistant', content: [{ type: 'text', text: 'KEEP' }, { type: 'tool_use', id: 'owned', name: 'read', input: { path: '/installed/SKILL.md' } }, { type: 'tool_use', id: 'other', name: 'read', input: { path: '/project/file' } }] }),
    record('results', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'owned', content: 'SKILL_BODY' }, { type: 'tool_result', tool_use_id: 'other', content: 'KEEP_RESULT' }] }),
  ];
  const filtered = filter(rows);
  assert.equal((filtered[0]!.message!.content as unknown[]).length, 2);
  assert.equal((filtered[1]!.message!.content as unknown[]).length, 1);
  assert.match(JSON.stringify(filtered), /KEEP_RESULT/);
  assert.doesNotMatch(JSON.stringify(filtered), /SKILL_BODY|RAW_PRIVATE/);
});
