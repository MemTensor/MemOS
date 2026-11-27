import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '../../src/adapters/types.ts';
import { filterUploadTraces } from '../../src/storage/upload-filter.ts';

const skillPath = '/fixture/.agents/skills/memos-project-memory/SKILL.md';
const skills = new Set([skillPath, 'memos-project-memory']);
type Row = { sourceId: string; sessionId: string; conversationId: string; raw: unknown; message: Message };
function call(id: string, command: string) {
  return { id, type: 'function', function: { name: 'exec_command', arguments: JSON.stringify({ cmd: command }) } };
}
function row(sourceId: string, message: Message, sessionId = 'session', conversationId = 'turn', raw: unknown = {}): Row {
  return { sourceId, sessionId, conversationId, raw, message };
}
function pair(id: string, command: string, output: string, sessionId = 'session', conversationId = 'turn'): Row[] {
  return [row(`${id}-call`, { role: 'assistant', content: '', tool_calls: [call(id, command)] }, sessionId, conversationId),
    row(`${id}-result`, { role: 'tool', content: output, tool_call_id: id }, sessionId, conversationId)];
}

test('upload excludes owned Skill pairs while source rows, sibling tools and independent search stay complete', () => {
  const search = pair('search', 'memos-pm search --query "SKILL.md"', 'SEARCH_RESULT');
  const rows = [
    row('calls', { role: 'assistant', content: 'Checking the task.', tool_calls: [call('skill', `cat ${skillPath}`), call('business', 'pwd')] }),
    row('skill-result', { role: 'tool', tool_call_id: 'skill', content: 'FULL_SKILL_BODY' }),
    row('business-result', { role: 'tool', tool_call_id: 'business', content: '/project' }),
    ...search,
  ];
  const original = structuredClone(rows);
  const projected = filterUploadTraces(rows, 'codex-cli', skills);
  assert.deepEqual(rows, original, 'upload projection never redacts the stored/viewer input');
  assert.equal(projected.length, 4);
  assert.equal(projected[0]!.message.content, 'Checking the task.');
  assert.deepEqual(projected[0]!.message.tool_calls, [call('business', 'pwd')]);
  assert.equal(projected[1]!.message.content, '/project');
  assert.deepEqual(projected[2]!.message.tool_calls, search[0]!.message.tool_calls);
  assert.equal(projected[3]!.message.content, 'SEARCH_RESULT');
  assert.doesNotMatch(JSON.stringify(projected.map(item => item.message)), /FULL_SKILL_BODY|memos-project-memory\/SKILL/);
});

test('the whole mixed shell pair is excluded even when it includes search, without changing source output', () => {
  const rows = [...pair('mixed', `cat '${skillPath}'; memos-pm search --query backup`, 'FULL_SKILL_BODY\nMIXED_SEARCH_RESULT'),
    ...pair('business', 'cat README.md', 'PROJECT_README')];
  const original = structuredClone(rows);
  const projected = filterUploadTraces(rows, 'codex-cli', skills);
  assert.deepEqual(rows, original);
  assert.deepEqual(projected.map(item => item.sourceId), ['business-call', 'business-result']);
  assert.equal(projected[1]!.message.content, 'PROJECT_README');
});

test('reused call IDs remain isolated by local session and turn even without native metadata', () => {
  const rows = [...pair('same', `cat ${skillPath}`, 'FULL_SKILL_BODY', 'one'),
    ...pair('same', 'pwd', '/other-session', 'two'),
    ...pair('same', 'git status', 'clean', 'one', 'next-turn')];
  const projected = filterUploadTraces(rows, 'codex-cli', skills);
  assert.equal(projected.length, 4);
  assert.deepEqual(projected.filter(item => item.message.role === 'tool').map(item => item.message.content), ['/other-session', 'clean']);
});

test('third-party Skill summarization remains upload-only and uses parsed raw execution evidence', () => {
  const rows = pair('external', 'cat /external/third-party/SKILL.md', 'THIRD_PARTY_BODY');
  rows[1]!.raw = JSON.stringify({ type: 'function_call_output', exit_code: 0 });
  const original = structuredClone(rows);
  const projected = filterUploadTraces(rows, 'codex-cli', skills);
  assert.deepEqual(rows, original);
  assert.equal(projected.length, 2);
  assert.deepEqual(projected[0]!.message.tool_calls, [{ id: 'external', type: 'function', function: { name: 'skill', arguments: '{"skill_name":"third-party"}' } }]);
  assert.deepEqual(JSON.parse(String(projected[1]!.message.content)), { skill_name: 'third-party', call_id: 'external', status: 'completed' });
  assert.doesNotMatch(JSON.stringify(projected.map(item => item.message)), /THIRD_PARTY_BODY/);
});

test('native execution evidence deduplicates wrappers before owned Skill filtering removes their nested pair', () => {
  const read = `cat ${skillPath}`;
  const code = `await Promise.all([tools.exec_command(${JSON.stringify({ cmd: read })}),tools.exec_command(${JSON.stringify({ cmd: 'pwd' })})]);`;
  const wrapped = row('wrapper-call', { role: 'assistant', content: '', tool_calls: [{ id: 'wrapper', type: 'function', function: { name: 'exec', arguments: code } }] });
  const nested = [...pair('read', read, 'FULL_SKILL_BODY'), ...pair('business', 'pwd', '/project')];
  for (const item of nested) item.raw = JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution' } } });
  const result = row('wrapper-result', { role: 'tool', tool_call_id: 'wrapper', content: [
    { type: 'text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
    { type: 'text', text: JSON.stringify({ wall_time_seconds: 0.01, exit_code: 0, output: 'FULL_SKILL_BODY' }) },
    { type: 'text', text: JSON.stringify({ wall_time_seconds: 0.01, exit_code: 0, output: '/project' }) },
  ] });
  const rows = [wrapped, ...nested, result], original = structuredClone(rows);
  const projected = filterUploadTraces(rows, 'codex-cli', skills);
  assert.deepEqual(rows, original);
  assert.deepEqual(projected.map(item => item.sourceId), ['business-call', 'business-result']);
  assert.equal(projected[1]!.message.content, '/project');

  result.message.content = [...result.message.content as unknown[], { type: 'text', text: 'BUSINESS_WRAPPER_OUTPUT' }];
  const partial = filterUploadTraces(rows, 'codex-cli', skills);
  assert.ok(partial.some(item => item.sourceId === 'wrapper-call'));
  assert.match(String(partial.find(item => item.sourceId === 'wrapper-result')!.message.content), /BUSINESS_WRAPPER_OUTPUT/);
  assert.doesNotMatch(JSON.stringify(partial.map(item => item.message)), /FULL_SKILL_BODY/);
});

test('a proven duplicate wrapper never removes the independent search execution it contains', () => {
  const read = `cat ${skillPath}`, search = 'memos-pm search --query backup';
  const rows = [row('wrapper-call', { role: 'assistant', content: '', tool_calls: [{ id: 'wrapper', type: 'function', function: {
    name: 'exec', arguments: `await Promise.all([tools.exec_command(${JSON.stringify({ cmd: read })}),tools.exec_command(${JSON.stringify({ cmd: search })})]);`,
  } }] }), ...pair('read', read, 'FULL_SKILL_BODY'), ...pair('search', search, 'SEARCH_RESULT')];
  for (const item of rows.slice(1)) item.raw = JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution' } } });
  rows.push(row('wrapper-result', { role: 'tool', tool_call_id: 'wrapper', content: ['FULL_SKILL_BODY', 'SEARCH_RESULT'].map(output => ({
    type: 'text', text: JSON.stringify({ wall_time_seconds: 0.01, exit_code: 0, output }),
  })) }));
  const original = structuredClone(rows), projected = filterUploadTraces(rows, 'codex-cli', skills);
  assert.deepEqual(rows, original);
  assert.deepEqual(projected.map(item => item.sourceId), ['search-call', 'search-result']);
  assert.deepEqual(projected[0]!.message.tool_calls, [call('search', search)]);
  assert.equal(projected[1]!.message.content, 'SEARCH_RESULT');
});

test('unknown wrapper output or an unpaired aliased search prevents removing the wrapper pair', () => {
  for (const aliasSearch of [false, true]) {
    const read = `cat ${skillPath}`;
    const code = `const result = await tools.exec_command(${JSON.stringify({ cmd: read })}); text(result);` +
      (aliasSearch ? 'const search = tools.exec_command; text(await search({"cmd":"memos-pm search --query backup"}));' : 'text("extra business output");');
    const rows = [row('wrapper-call', { role: 'assistant', content: '', tool_calls: [{ id: 'wrapper', type: 'function', function: { name: 'exec', arguments: code } }] }),
      ...pair('read', read, 'FULL_SKILL_BODY')];
    for (const item of rows.slice(1)) item.raw = JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution' } } });
    rows.push(row('wrapper-result', { role: 'tool', tool_call_id: 'wrapper', content: [
      { type: 'text', text: JSON.stringify({ wall_time_seconds: 0.01, exit_code: 0, output: aliasSearch ? 'FULL_SKILL_BODY' : 'UNPROVEN_OUTPUT' }) },
      { type: 'text', text: aliasSearch ? 'SEARCH_RESULT' : 'EXTRA_BUSINESS_OUTPUT' },
    ] }));
    const original = structuredClone(rows), projected = filterUploadTraces(rows, 'codex-cli', skills);
    assert.deepEqual(rows, original);
    assert.deepEqual(projected.map(item => item.sourceId), ['wrapper-call', 'wrapper-result']);
    assert.match(String(projected[1]!.message.content), aliasSearch ? /SEARCH_RESULT/ : /UNPROVEN_OUTPUT.*EXTRA_BUSINESS_OUTPUT/);
  }
});

test('a turn containing only an owned Skill read has no upload messages', () => {
  assert.deepEqual(filterUploadTraces(pair('only', `head -60 ${skillPath}`, 'FULL_SKILL_BODY'), 'codex-cli', skills), []);
});

test('DSH stored raw strings retain native Skill correlation during upload projection', () => {
  const rows = [
    row('native-call', { role: 'assistant', content: '', tool_calls: [{ id: 'native', type: 'function', function: { name: 'skill', arguments: '{"name":"memos-project-memory"}' } }] }),
    row('native-result', { role: 'tool', tool_call_id: 'native', content: 'FULL_SKILL_BODY' }),
  ];
  for (const item of rows) item.raw = JSON.stringify({ type: 'message', message: item.message });
  const original = structuredClone(rows);
  assert.deepEqual(filterUploadTraces(rows, 'deepseek-harness', skills), []);
  assert.deepEqual(rows, original);
});
