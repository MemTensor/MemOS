import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/storage/store.ts';
import { Deliveries } from '../../src/storage/deliveries.ts';

for (const receiptId of ['execution', 'unrelated']) test(`legacy receipt ${receiptId} covers only its proven source identity after normalization`, () => {
    const store = new Store(':memory:');
    try {
        const deliveries = new Deliveries(store), baseUrl = 'http://fixture';
        const project = store.bindProject('Project', '/project', 'space', baseUrl, 'codex-cli');
        const session = store.registerSession({ agentType: 'codex-cli', nativeSessionId: 'native', cwd: '/project' });
        store.startTurn(session.id, 'turn');
        const message = { role: 'assistant', id: 'execution', content: '', chat_time: new Date(Date.now() + 1000).toISOString(),
            tool_calls: [{ id: 'execution', type: 'function', function: { name: 'bash', arguments: '{}' } }] };
        const raw = { type: 'event_msg', timestamp: message.chat_time,
            payload: { type: 'item_completed', item: { type: 'CommandExecution' } }, message };
        const sourceId = 'codex:native:turn:tool-call:execution';
        store.capture(session.id, [{ sourceId, raw, message }]); store.finalizeTurn(session.id, 'turn');
        const batch = store.batches()[0]!, trace = store.row('SELECT id FROM traces')!;
        store.db.prepare('UPDATE traces SET raw=?,message=? WHERE id=?').run(JSON.stringify(raw), JSON.stringify(message), Number(trace.id));
        store.db.prepare("UPDATE batches SET messages=?,status='completed',uploaded=1,attempts=1,taskId='accepted' WHERE id=?").run(JSON.stringify([{ ...message, id: receiptId }]), batch.id);
        store.db.prepare('INSERT INTO batch_traces VALUES(?,?)').run(batch.id, Number(trace.id));
        store.db.prepare("INSERT INTO batch_deliveries(batchId,baseUrl,connectionId,spaceId,kind,status,attempts,taskId) VALUES(?,?,?,?,?,'completed',1,'accepted')")
            .run(batch.id, baseUrl, batch.connectionId, 'space', 'live');
        const before = store.rows('SELECT * FROM batches');
        deliveries.queueHistory(project.scopeId, ['space'], [{ nativeSessionId: 'native', sourceId }]);
        if (receiptId === 'execution') assert.deepEqual(store.rows('SELECT * FROM batches'), before);
        else assert.equal(store.batches().length, 2);
        assert.equal(deliveries.historyPending(project.scopeId, [{ nativeSessionId: 'native', sourceId }]), receiptId === 'execution' ? 0 : 1);
    } finally { store.close(); }
});
