import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, TraceInput } from '../../src/adapters/types.ts';
import { Store } from '../../src/storage/store.ts';
const call = (id: string, command: string): Message => ({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'exec_command', arguments: JSON.stringify({ cmd: command }) } }] });
const result = (id: string, content = 'BOUND_PRIVATE'): Message => ({ role: 'tool', tool_call_id: id, content });
const row = (sourceId: string, message: Message, nativeTurnId = 'one'): TraceInput => ({ sourceId, nativeTurnId, raw: { timestamp: '2026-11-23T00:00:00Z', message }, message });

test('capture keeps operation bodies private and correlates delayed results after restart', () => {
  for (const operation of ['bind', 'unbind']) {
    const directory = mkdtempSync(join(tmpdir(), 'pm-operation-records-')), file = join(directory, 'memory.sqlite');
    let store = new Store(file);
    try {
      const session = store.registerSession({ agentType: 'test', nativeSessionId: 'dialog', cwd: directory });
      store.startTurn(session.id, 'one');
      store.capture(session.id, [row('user', { role: 'user', content: '保留业务' }), row('call', call('operation', `memos-pm ${operation} --space-id secret-space`))]);
      assert.doesNotMatch(JSON.stringify(store.rows('SELECT raw,message FROM traces')), /secret-space/);
      assert.deepEqual(store.sessionDetail(session.id).traces.map((trace: any) => trace.message.content), ['保留业务']);
      store.close(); store = new Store(file);
      store.capture(session.id, [row('result', result('operation')), row('answer', { role: 'assistant', content: '业务继续' })]);
      assert.doesNotMatch(JSON.stringify(store.rows('SELECT raw,message FROM traces')), /BOUND_PRIVATE/);
      store.finalizeTurn(session.id, 'one');
      assert.deepEqual(store.batches()[0]!.messages.map(message => message.content), ['保留业务', '业务继续']);
      store.startTurn(session.id, 'two');
      store.capture(session.id, [row('business', result('operation', 'OTHER_TURN'), 'two')]);
      assert.match(JSON.stringify(store.sessionDetail(session.id)), /OTHER_TURN/);
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  }
});
