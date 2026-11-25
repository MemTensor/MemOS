import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../src/storage/store.ts';
import { Deliveries } from '../../src/storage/deliveries.ts';
import { repairRejectedMessageIds } from '../../src/storage/repair-message-ids.ts';
import { filterUploadTraces } from '../../src/storage/upload-filter.ts';
import { repairMessageIds } from '../../src/cli/repair-message-ids.ts';

const error = 'MemOS add/message HTTP 409: message IDs must be unique in a request';
function fixture(t: import('node:test').TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'pm-repair-ids-')), path = join(directory, 'memory.sqlite');
  const store = new Store(path); new Deliveries(store);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const session = store.registerSession({ agentType: 'codex-cli', nativeSessionId: 'native', cwd: '/project' });
  store.startTurn(session.id, 'turn');
  store.capture(session.id, [
    { sourceId: 'codex:native:turn:tool-call:execution', raw: { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'execution' } } }, message: { role: 'assistant', content: '', tool_calls: [{ id: 'execution', type: 'function', function: { name: 'exec_command', arguments: '{"command":"pwd"}' } }] } },
    { sourceId: 'codex:native:turn:tool-result:execution', raw: { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'execution' } } }, message: { role: 'tool', content: '/project', tool_call_id: 'execution' } },
  ]);
  store.finalizeTurn(session.id, 'turn');
  const batch = store.batches()[0]!;
  // Reconstruct the old frozen request and canonical rows, before the fix.
  const messages = batch.messages.map(message => ({ ...message, id: 'execution' }));
  store.db.prepare("UPDATE batches SET messages=?,status='failed',attempts=1,error=? WHERE id=?").run(JSON.stringify(messages), error, batch.id);
  for (const row of store.rows('SELECT id,message FROM traces')) {
    store.db.prepare('UPDATE traces SET message=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(String(row.message)), id: 'execution' }), Number(row.id));
    store.db.prepare('INSERT INTO batch_traces VALUES(?,?)').run(batch.id, Number(row.id));
  }
  store.db.prepare("INSERT INTO batch_deliveries(batchId,baseUrl,connectionId,spaceId,kind,status,attempts,error) VALUES(?,?,?,?,?,'failed',1,?)")
    .run(batch.id, 'http://fixture', batch.connectionId, 'space', 'live', error);
  return { store, path, batch, messages };
}

test('409 repair previews without writes; applying backs up and preserves evidence without queueing an upload', t => {
  const { store, path, batch, messages } = fixture(t);
  const raw = store.rows('SELECT id,sourceId,raw FROM traces');
  const readonly = new DatabaseSync(path, { readOnly: true });
  const preview = repairRejectedMessageIds(readonly); readonly.close();
  assert.equal(preview.repairs.length, 1); assert.equal(preview.backup, null);
  assert.deepEqual(store.batches()[0]!.messages, messages);
  const repaired = repairRejectedMessageIds(store.db, { apply: true });
  assert.equal(repaired.applied, true); assert.ok(repaired.backup && existsSync(repaired.backup));
  assert.equal(statSync(repaired.backup).mode & 0o777, 0o600);
  const backup = new DatabaseSync(repaired.backup, { readOnly: true });
  assert.equal(backup.prepare('SELECT messages FROM batches WHERE id=?').get(batch.id)!.messages, JSON.stringify(messages)); backup.close();
  const current = store.batches()[0]!;
  assert.equal(current.status, 'blocked'); assert.equal(current.attempts, 1); assert.equal(current.taskId, null);
  assert.equal(new Set(current.messages.map(message => message.id)).size, current.messages.length);
  const bodies = (rows: typeof messages) => rows.map(({ id: _id, ...body }) => body);
  assert.deepEqual(bodies(current.messages as typeof messages), bodies(messages));
  assert.deepEqual(store.rows('SELECT id,sourceId,raw FROM traces'), raw);
  const replay = filterUploadTraces(store.rows('SELECT * FROM traces').map(row => ({ ...row, message: JSON.parse(String(row.message)) }))).map(row => row.message);
  assert.deepEqual(replay, current.messages);
  assert.equal(store.row('SELECT status FROM batch_deliveries')!.status, 'blocked');
  assert.equal(store.row('SELECT count(*) n FROM diagnostics')!.n, 1);
  assert.equal(repairRejectedMessageIds(store.db, { apply: true }).repairs.length, 0);
});

for (const protectedCase of ['completed', 'accepted-target', 'timeout', 'unproven-409', 'missing-source', 'missing-source-id', 'shared-accepted-trace']) {
  test(`409 repair leaves ${protectedCase} untouched`, t => {
    const { store, batch } = fixture(t);
    if (protectedCase === 'completed') store.db.prepare("UPDATE batches SET status='completed',uploaded=1,taskId='accepted' WHERE id=?").run(batch.id);
    if (protectedCase === 'accepted-target') store.db.exec("UPDATE batch_deliveries SET status='accepted',taskId='accepted'");
    if (protectedCase === 'timeout') store.db.exec("UPDATE batches SET error='connection reset'; UPDATE batch_deliveries SET error='connection reset'");
    if (protectedCase === 'unproven-409') store.db.exec("UPDATE batches SET error='MemOS HTTP 409: conflict'; UPDATE batch_deliveries SET error='MemOS HTTP 409: conflict'");
    if (protectedCase === 'missing-source') store.db.exec("UPDATE traces SET message=json_set(message,'$.content','different')");
    if (protectedCase === 'missing-source-id') store.db.exec("UPDATE traces SET sourceId='' WHERE id=(SELECT min(id) FROM traces)");
    if (protectedCase === 'shared-accepted-trace') {
      store.db.prepare("INSERT INTO batches(id,sessionId,objectId,conversationId,messages,status,uploaded,attempts,taskId,createdAt) SELECT 'accepted',sessionId,objectId,NULL,messages,'completed',1,1,'accepted',createdAt FROM batches WHERE id=?").run(batch.id);
      store.db.prepare("INSERT INTO batch_traces SELECT 'accepted',traceId FROM batch_traces WHERE batchId=?").run(batch.id);
    }
    const before = store.rows('SELECT * FROM batches'), traces = store.rows('SELECT * FROM traces'), deliveries = store.rows('SELECT * FROM batch_deliveries');
    assert.equal(repairRejectedMessageIds(store.db, { apply: true }).repairs.length, 0);
    assert.deepEqual(store.rows('SELECT * FROM batches'), before);
    assert.deepEqual(store.rows('SELECT * FROM traces'), traces);
    assert.deepEqual(store.rows('SELECT * FROM batch_deliveries'), deliveries);
  });
}

for (const agent of ['cursor-cli', 'copilot-cli', 'opencode-v1', 'opencode-v2', 'kilo-cli']) {
  test(`409 repair reprojects legacy ${agent} split messages and keeps source bodies intact`, t => {
    const { store, batch } = fixture(t);
    store.db.prepare('UPDATE sessions SET agentType=?').run(agent);
    const messages = ['one', 'two'].map(content => ({ id: 'native-answer', role: 'assistant', content }));
    for (const [index, row] of store.rows('SELECT id FROM traces ORDER BY id').entries()) {
      const raw = { id: 'native-answer', message: messages[index], ...(agent === 'cursor-cli' ? { sourcePart: index } : {}) };
      store.db.prepare('UPDATE traces SET sourceId=?,raw=?,message=? WHERE id=?')
        .run(`message:native-answer:text:${index}`, JSON.stringify(raw), JSON.stringify(messages[index]), Number(row.id));
    }
    store.db.prepare('UPDATE batches SET messages=? WHERE id=?').run(JSON.stringify(messages), batch.id);
    const evidence = store.rows('SELECT raw,sourceId FROM traces');
    const result = repairRejectedMessageIds(store.db, { apply: true }); assert.equal(result.repairs.length, 1);
    assert.deepEqual(store.batches()[0]!.messages.map(message => message.content), ['one', 'two']);
    assert.deepEqual(store.rows('SELECT raw,sourceId FROM traces'), evidence);
    assert.equal(new Set(store.batches()[0]!.messages.map(message => message.id)).size, 2);
  });
}

test('repair rolls back canonical rows and snapshots together when a write fails', t => {
  const { store } = fixture(t);
  const before = store.rows('SELECT * FROM traces'), batches = store.rows('SELECT * FROM batches');
  store.db.exec("CREATE TRIGGER fail_repair BEFORE UPDATE ON batches WHEN NEW.status='blocked' BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  assert.throws(() => repairRejectedMessageIds(store.db, { apply: true }), /fixture failure/);
  assert.deepEqual(store.rows('SELECT * FROM traces'), before);
  assert.deepEqual(store.rows('SELECT * FROM batches'), batches);
  assert.equal(store.row('SELECT count(*) n FROM diagnostics')!.n, 0);
});

test('maintenance CLI previews an explicit batch and rejects unknown options', t => {
  const { store, path, batch } = fixture(t);
  assert.equal(repairMessageIds(['--db', path, '--batch-id', batch.id]).repairs.length, 1);
  assert.equal(repairMessageIds(['--db', path, '--batch-id', 'missing']).repairs.length, 0);
  assert.equal(store.batches()[0]!.status, 'failed');
  assert.throws(() => repairMessageIds(['--db', path, '--force']), /用法/);
  assert.throws(() => repairMessageIds(['--apply']), /--db/);
});
