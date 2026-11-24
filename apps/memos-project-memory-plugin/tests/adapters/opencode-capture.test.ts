import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHooks } from '../../src/adapters/opencode-v1/extension/index.ts';
import { Store } from '../../src/storage/store.ts';
import type { AgentEvent, EventResult } from '../../src/adapters/types.ts';

function transport() {
  const delivered: string[] = [];
  const send = Object.assign(async (event: AgentEvent): Promise<EventResult> => {
    return { sessionId: event.nativeSessionId, conversationId: event.turnKey ?? null,
      overview: '项目资料', identifiers: `IDS ${event.turnKey}`, context: `项目资料\nIDS ${event.turnKey}`,
      overviewDelivered: delivered.includes(event.nativeSessionId) };
  }, { activation: async () => true, delivered: async (session: string) => { delivered.push(session); } });
  return { send };
}

test('OpenCode V1 filters before SQLite and uploads task content with source metadata', async () => {
  const store = new Store(':memory:');
  try {
    const session = store.registerSession({ agentType: 'opencode-v1', nativeSessionId: 's', cwd: '/test' });
    const t = transport();
    const send = Object.assign(async (event: AgentEvent) => {
      if (event.event === 'turn-start') store.startTurn(session.id, event.turnKey!);
      store.capture(session.id, event.records ?? []);
      if (event.event === 'turn-end') store.finalizeTurn(session.id, event.turnKey);
      return t.send(event);
    }, { activation: t.send.activation, delivered: t.send.delivered });
    const user = { info: { id: 'u', role: 'user', time: { created: 1000 } }, parts: [
      { type: 'text', text: '问题中正常提到 system prompt，不能误删' },
      { type: 'text', text: 'INJECTED CONTEXT', synthetic: true },
      { type: 'tool-catalog', content: 'TOOL CATALOG' },
    ] };
    const records = [user, { info: { id: 'a', parentID: 'u', role: 'assistant', tokens: { total: 123 }, system: 'SYSTEM SECRET', time: { created: 2000, completed: 3000 } }, parts: [
      { type: 'step-start', snapshot: 'SNAPSHOT' },
      { type: 'tool', callID: 'call', tool: 'bash', state: { status: 'completed', input: { command: 'pwd' }, output: 'tool-catalog is legitimate tool output', metadata: { secret: 'TOOL METADATA' } } },
      { id: 'text', type: 'text', text: 'answer' },
      { type: 'step-finish', tokens: { total: 123 } },
    ] }];
    const hooks = await createHooks({ directory: '/test', client: { session: { messages: async () => ({ data: records }) } } }, send);
    await hooks['chat.message']({ sessionID: 's' }, { message: user.info, parts: user.parts });
    await hooks.event({ event: { type: 'message.updated', properties: { info: records[1]!.info } } });
    await hooks['tool.execute.after']({ sessionID: 's', callID: 'call', tool: 'bash', args: { command: 'pwd' } }, { output: 'tool-catalog is legitimate tool output', metadata: { secret: 'TOOL METADATA' } });
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 's' } } });
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 's' } } });
    const rows = store.rows('SELECT raw,message FROM traces ORDER BY id');
    const messages = rows.map(row => JSON.parse(String(row.message)));
    const taskFields = (message: any) => ({ role: message.role, content: message.content, ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}), ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}) });
    assert.deepEqual(messages.map(taskFields), [
      { role: 'user', content: user.parts[0]!.text },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call', type: 'function', function: { name: 'bash', arguments: '{"command":"pwd"}' } }] },
      { role: 'tool', content: 'tool-catalog is legitimate tool output', tool_call_id: 'call' },
      { role: 'assistant', content: 'answer' },
    ]);
    assert.equal(messages[0].id, 'u'); assert.equal(messages[3].id, 'a');
    assert.equal(messages[0].chat_time, '1970-01-01T00:16:40.000Z');
    assert.equal(messages[3].chat_time, '1970-01-01T00:33:20.000Z');
    for (const message of messages) assert.ok(Number.isFinite(Date.parse(message.chat_time)));
    const uploaded = store.batches()[0]!.messages;
    assert.deepEqual(uploaded.map(taskFields), messages.map(taskFields));
    assert.deepEqual(uploaded.map(message => message.chat_time), messages.map(message => message.chat_time));
    for (const message of uploaded) assert.equal(typeof message.id, 'string');
    assert.doesNotMatch(JSON.stringify(rows), /INJECTED CONTEXT|TOOL CATALOG|SYSTEM SECRET|SNAPSHOT|step-start|step-finish|tokens|TOOL METADATA/);
    assert.deepEqual(store.rows('SELECT raw,message FROM traces ORDER BY id'), rows);
  } finally { store.close(); }
});
