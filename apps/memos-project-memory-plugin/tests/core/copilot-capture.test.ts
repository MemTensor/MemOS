import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginService } from '../../src/server/service.ts';
import { copilotEvent } from '../../src/adapters/copilot-cli/capture.ts';
import { processHook } from '../../src/adapters/_shared/hooks.ts';
import { captureUploads } from '../helpers/capture-uploads.ts';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'pm-copilot-'));
  const { uploads, call } = captureUploads();
  let service = new PluginService(join(dir, 'data'), { home: dir, codexRoots: [] });
  t.after(async () => { service.close(); await rm(dir, { recursive: true, force: true }); });
  service.cloud.call = call;
  service.configure({ authMode: 'none' });
  service.store.bindProject('project', dir, 'space', service.config.value.baseUrl, 'copilot-cli');
  const rows: Record<string, unknown>[] = [], path = join(dir, 'events.jsonl');
  let time = Date.now() + 10, id = 0;
  const add = (type: string, data: unknown) => rows.push({ type, data, id: `event-${++id}`, timestamp: new Date(++time).toISOString() });
  add('session.start', { sessionId: 'native', context: { cwd: dir } });
  const save = () => writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const request = Object.assign((event: import('../../src/adapters/types.ts').AgentEvent) => service.event(event), { activation: async () => true });
  const hook = async (name: string, input: Record<string, unknown>) => { const result = await processHook('copilot-cli', { sessionId: 'native', cwd: dir, ...input }, { event: name, request }); await service.copilot.flush(); return result; };
  async function prompt(label: string, content = 'hello') {
    const input = { sessionId: 'native', cwd: dir, timestamp: ++time, prompt: content, transformedPrompt: `HOST ${content}` };
    add('hook.start', { hookType: 'userPromptTransformed', hookInvocationId: label, input });
    const output = await hook('userPromptTransformed', input);
    add('hook.end', { hookType: 'userPromptTransformed', hookInvocationId: label, success: true, output });
    add('user.message', { content, transformedContent: (output as { modifiedTransformedPrompt: string }).modifiedTransformedPrompt, messageId: label, interactionId: label, turnId: label });
    add('system.message', { role: 'system', content: 'HOST SECRET' });
    await save(); return label;
  }
  function answer(label: string, content = '你好。有什么可以帮你？') {
    add('assistant.turn_start', { turnId: label, interactionId: label });
    add('assistant.message', { content, messageId: `answer-${label}`, originatingMessageId: label, interactionId: label, turnId: label, toolRequests: [] });
    add('assistant.turn_end', { turnId: label });
  }
  async function stop() {
    const input = { sessionId: 'native', cwd: dir, timestamp: ++time, transcriptPath: path, stopReason: 'end_turn' };
    const invocation = `stop-${id}`;
    add('hook.start', { hookType: 'agentStop', hookInvocationId: invocation, input });
    add('hook.end', { hookType: 'agentStop', hookInvocationId: invocation, success: true });
    await save(); return input;
  }
  const replay = (raw: Awaited<ReturnType<typeof stop>>) => copilotEvent({
    agentType: 'copilot-cli', nativeSessionId: 'native', cwd: dir, event: 'trace-available', raw,
  }, 'agentStop', {});
  return { replay, get service() { return service; }, restart() { service.close(); service = new PluginService(join(dir, 'data'), { home: dir, codexRoots: [] }); service.cloud.call = call; }, rows, add, save, path, hook, prompt, answer, stop, uploads };
}

test('Copilot tool cycles remain in one user round with complete tool results and readable reasoning', async t => {
  const f = await fixture(t); await f.prompt('one');
  f.add('assistant.turn_start', { turnId: '0' });
  f.add('assistant.message', { messageId: 'call-message', originatingMessageId: 'one', turnId: '0', content: 'checking', reasoningText: 'readable thought', reasoningOpaque: 'not-readable', toolRequests: [{ toolCallId: 'call', name: 'bash', arguments: { command: 'pwd' } }] });
  f.add('tool.execution_start', { toolCallId: 'call', toolName: 'bash', arguments: { command: 'pwd' }, turnId: '0' });
  const result = { content: 'short', detailedContent: 'full result', structuredContent: { directory: '/project' } };
  f.add('tool.execution_complete', { toolCallId: 'call', success: true, result });
  f.add('assistant.turn_end', { turnId: '0' });
  f.answer('one', 'done'); await f.hook('agentStop', await f.stop()); await f.service.sync();
  assert.deepEqual(f.uploads[0]?.space_ids, ['space']);
  const messages = f.uploads[0]!.messages;
  assert.deepEqual(messages.map((m: { role: string }) => m.role), ['user', 'assistant', 'assistant', 'tool', 'assistant']);
  assert.equal(messages.filter((m: { tool_calls?: unknown[] }) => m.tool_calls?.length).length, 1);
  assert.deepEqual(JSON.parse(String(messages[3]!.content)), result);
  assert.ok(!JSON.stringify(messages).includes('not-readable'));
  assert.equal(new Set(messages.map(message => message.id)).size, messages.length);
  const frozen = JSON.stringify(messages);
  f.restart(); await f.service.sync();
  assert.equal(JSON.stringify(f.service.store.batches()[0]!.messages), frozen);
  assert.equal(f.service.store.rows('SELECT * FROM turns').length, 1);
});

test('a delayed Copilot stop reads only its own submitted turn and ignores later malformed lines', async t => {
  const f = await fixture(t);
  await f.prompt('one', 'first');
  f.answer('one', 'old answer');
  const firstStop = await f.stop();
  await f.prompt('two', 'second');
  f.answer('two', 'new answer');
  await f.stop();
  await appendFile(f.path, '{unfinished');

  const event = await f.replay(firstStop);
  assert.equal(event.event, 'turn-end');
  assert.deepEqual(event.records?.map(record => record.message?.content), ['first', 'old answer']);
});

test('Copilot waits for the matching stop acknowledgement and all tool results', async t => {
  const f = await fixture(t);
  await f.prompt('one');
  f.add('tool.execution_start', { toolCallId: 'call', toolName: 'inspect' });
  f.answer('one');
  const stop = await f.stop();
  const acknowledgement = f.rows.pop()!;
  await f.save();
  await assert.rejects(f.replay(stop), /等待结束 Hook 完成记录落盘/);
  f.rows.push(acknowledgement);
  await f.save();
  await assert.rejects(f.replay(stop), /轮次正文或执行完成证据不完整/);

  // A late tool result belongs before the stop callback in the native stream.
  const stopEvents = f.rows.splice(-2);
  f.add('tool.execution_complete', { toolCallId: 'call', success: true, result: 'ok' });
  f.rows.push(...stopEvents);
  await f.save();
  assert.equal((await f.replay(stop)).event, 'turn-end');
});

test('Copilot ignores identical event IDs on replay and rejects conflicting content', async t => {
  const f = await fixture(t);
  await f.prompt('one');
  f.answer('one', 'answer');
  const answer = f.rows.find(row => row.type === 'assistant.message')!;
  const duplicate = { ...answer };
  f.rows.push(duplicate);
  const stop = await f.stop();
  assert.deepEqual((await f.replay(stop)).records?.map(record => record.message?.content), ['hello', 'answer']);

  duplicate.data = { ...(answer.data as object), content: 'conflict' };
  await f.save();
  await assert.rejects(f.replay(stop), /原生事件 ID 内容冲突/);
});
