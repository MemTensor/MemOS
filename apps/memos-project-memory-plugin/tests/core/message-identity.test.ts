import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTaskTrace } from '../../src/adapters/_shared/task-trace.ts';
import { messageMetadata } from '../../src/adapters/_shared/transcript.ts';
import { uploadValidationError } from '../../src/adapters/_shared/message-content.ts';
import { parseCodexRollout } from '../../src/adapters/codex-cli/rollout.ts';
import { captureRecords } from '../../src/adapters/opencode-v1/extension/capture.ts';
import { filterUploadTraces } from '../../src/storage/upload-filter.ts';
import type { Message, TraceInput } from '../../src/adapters/types.ts';

const timestamp = '2026-01-01T00:00:00.000Z';
const project = (agent: string, records: TraceInput[]) => filterUploadTraces(records
  .map(record => normalizeTaskTrace(agent, record)).filter(record => record !== undefined)
  .map(record => ({ ...record, nativeSessionId: 'native' }))).map(row => row.message!);
function unique(messages: Message[]) {
  assert.ok(messages.every(message => typeof message.id === 'string' && message.id.length));
  assert.equal(new Set(messages.map(message => message.id)).size, messages.length);
  assert.equal(uploadValidationError(messages), null);
}

test('Codex completed execution becomes two stable messages with one shared call identity', () => {
  for (const type of ['CommandExecution', 'McpToolCall', 'FileChange', 'ImageView', 'WebSearch']) {
    const rows = [
      { type: 'session_meta', payload: { id: 'native', cwd: '/project', source: 'cli' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
      { type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn', item: {
        type, id: 'execution', command: 'pwd', server: 'server', tool: 'tool', arguments: {},
        aggregated_output: 'ok', exit_code: 0, status: 'completed',
      } } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn' } },
    ].map(row => JSON.stringify({ ...row, timestamp })).join('\n') + '\n';
    const records = parseCodexRollout(rows).turns.flatMap(turn => turn.records);
    const messages = project('codex-cli', records);
    assert.equal(messages.length, 2); unique(messages);
    assert.equal((messages[0]!.tool_calls![0] as { id: string }).id, 'execution');
    assert.equal(messages[1]!.tool_call_id, 'execution');
    assert.deepEqual(project('codex-cli', parseCodexRollout(rows).turns.flatMap(turn => turn.records)), messages);
    assert.deepEqual(project('codex-cli', records.map(record => normalizeTaskTrace('codex-cli', record)!)), messages);
  }
});

test('message metadata never promotes a role-bearing execution event id to a message id', () => {
  const raw = { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'execution', role: 'tool' } } };
  assert.equal(messageMetadata({ role: 'tool', content: 'ok', tool_call_id: 'execution' }, raw).id, undefined);
  assert.equal(messageMetadata({ role: 'assistant', content: 'answer' }, { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'native-message' } }).id, 'native-message');
});

for (const agent of ['opencode-v1', 'opencode-v2', 'kilo-cli']) test(`${agent} text parts and tool events retain unique stable message ids`, () => {
  const info = { id: 'answer', role: 'assistant', timestamp };
  const parts = [
    { type: 'text', id: 'first', text: 'checking' },
    { type: 'tool', callID: 'call', tool: 'bash', state: { status: 'completed', input: { command: 'pwd' }, output: 'ok' } },
    { type: 'text', id: 'last', text: 'done' },
  ];
  const messages = project(agent, captureRecords(info, parts, 'turn'));
  unique(messages); assert.equal(messages.length, 4);
  assert.deepEqual(project(agent, captureRecords(info, parts, 'turn')), messages);
  // A new block does not rename a previously observed text block.
  assert.equal(project(agent, captureRecords(info, parts.slice(0, 1), 'turn'))[0]!.id, messages[0]!.id);
});

test('upload validation rejects duplicate message ids but permits shared tool associations', () => {
  const messages: Message[] = [
    { id: 'call-message', role: 'assistant', content: '', tool_calls: [{ id: 'execution', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
    { id: 'result-message', role: 'tool', content: 'ok', tool_call_id: 'execution' },
  ];
  unique(messages);
  assert.match(uploadValidationError([messages[0]!, { ...messages[1]!, id: 'call-message' }]) ?? '', /重复|duplicate/i);
});

test('the remaining adapter message and execution formats preserve unique ids and tool association', () => {
  const normal: TraceInput[] = [
    { sourceId: 'answer', raw: { type: 'assistant', uuid: 'native-answer', message: { role: 'assistant', content: [
      { type: 'text', text: 'checking' }, { type: 'tool_use', id: 'call', name: 'bash', input: { command: 'pwd' } },
    ] } } },
    { sourceId: 'result', raw: { type: 'user', uuid: 'native-result', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'ok' }] } } },
  ];
  const fixtures: Record<string, TraceInput[]> = {};
  for (const agent of ['claude-code', 'grok-build', 'qwen-code', 'factory-droid', 'zcode', 'trae', 'antigravity-cli', 'devin-cli', 'deepagents-dcode', 'codebuddy-cli', 'cline-cli']) fixtures[agent] = normal;
  for (const agent of ['pi', 'prime-agent']) fixtures[agent] = [
    { sourceId: 'entry:a', raw: { type: 'message', id: 'entry-a', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: 'bash', arguments: {} }] } } },
    { sourceId: 'entry:r', raw: { type: 'message', id: 'entry-r', message: { role: 'toolResult', toolCallId: 'call', content: 'ok' } } },
  ];
  fixtures.workbuddy = [
    { sourceId: 'start', raw: { type: 'function_call', id: 'source-call', callId: 'call', name: 'bash', arguments: {} } },
    { sourceId: 'end', raw: { type: 'function_call_result', id: 'source-result', callId: 'call', output: 'ok' } },
  ];
  fixtures['kimi-code'] = [
    { sourceId: 'start', raw: { type: 'tool.call.started', toolCallId: 'call', name: 'bash', arguments: {} } },
    { sourceId: 'end', raw: { type: 'tool.result', toolCallId: 'call', result: 'ok' } },
  ];
  fixtures['deepseek-harness'] = [
    { sourceId: 'event:1', raw: { type: 'tool/call', data: { callId: 'call', name: 'bash', arguments: {} } } },
    { sourceId: 'event:2', raw: { type: 'tool/result', data: { message: { id: 'native-result', role: 'tool', tool_call_id: 'call', content: 'ok' } } } },
  ];
  assert.equal(Object.keys(fixtures).length, 16);
  for (const [agent, records] of Object.entries(fixtures)) {
    const messages = project(agent, records); assert.ok(messages.length >= 2, agent); unique(messages);
    assert.equal(messages.find(message => message.role === 'tool')!.tool_call_id, 'call', agent);
    assert.deepEqual(project(agent, records), messages, agent);
  }
});
