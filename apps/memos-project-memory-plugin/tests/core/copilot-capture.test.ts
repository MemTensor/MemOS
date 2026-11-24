import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { PluginService } from '../../src/server/service.ts';
import { processHook } from '../../src/adapters/_shared/hooks.ts';
import { createMockServer, getMockState } from '../../dev/memos-mock/server.ts';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'pm-copilot-'));
  const mock = createMockServer(); mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const address = mock.address(); assert.ok(address && typeof address !== 'string');
  let service = new PluginService(join(dir, 'data'), { home: dir, codexRoots: [] });
  t.after(async () => { service.close(); await new Promise<void>(resolve => mock.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  service.configure({ baseUrl: `http://127.0.0.1:${address.port}/api/openmem/v1`, apiKey: 'mock-key' });
  const space = await service.cloud.call<{ space_id: string }>('create/space', { space_name: 'Copilot', domains: [{ domain: '编程' }] });
  service.store.bindProject('project', dir, space.space_id, service.config.value.baseUrl, 'copilot-cli');
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
  return { get service() { return service; }, restart() { service.close(); service = new PluginService(join(dir, 'data'), { home: dir, codexRoots: [] }); }, rows, add, save, path, hook, prompt, answer, stop, uploads: () => getMockState(mock).uploads.get(space.space_id) ?? [] };
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
  const messages = f.uploads()[0]!.body.messages;
  assert.deepEqual(messages.map((m: { role: string }) => m.role), ['user', 'assistant', 'assistant', 'tool', 'assistant']);
  assert.equal(messages.filter((m: { tool_calls?: unknown[] }) => m.tool_calls?.length).length, 1);
  assert.deepEqual(JSON.parse(messages[3].content), result);
  assert.ok(!JSON.stringify(messages).includes('not-readable'));
  assert.equal(f.service.store.rows('SELECT * FROM turns').length, 1);
});
