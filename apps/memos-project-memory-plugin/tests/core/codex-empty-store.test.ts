import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/storage/store.ts';
import type { CodexSnapshot } from '../../src/adapters/codex-cli/types.ts';

const empty = (id = 'empty'): CodexSnapshot => ({ nativeSessionId: id, cwd: '/project', sourceKind: 'user', sourcePath: `/source/${id}.jsonl`, turns: [], gaps: [] });
const active = (id = 'empty'): CodexSnapshot => ({ ...empty(id), turns: [{ nativeTurnId: 'turn', rootTurnId: 'turn', status: 'running', startedAt: '2026-01-01T00:00:00Z', expectedChildren: [], gaps: [], records: [{ sourceId: 'user', originSessionId: id, sourceOrdinal: 1, nativeTurnId: 'turn', rootTurnId: 'turn', occurredAt: '2026-01-01T00:00:00Z', raw: { role: 'user', content: 'task' }, message: { role: 'user', content: 'task' } }] }] });
function legacy(store: Store, id = 'empty') {
 const source = empty(id), session = store.registerSession({ agentType: 'codex-cli', nativeSessionId: id, cwd: source.cwd });
 store.db.prepare('INSERT INTO codex_source_meta VALUES(?,?,?,?,?,?,?,?)').run(source.sourcePath, id, source.cwd, null, null, 'user', null, '[]');
 return session;
}

test('initialization-only Codex source never creates SQLite session, task or source rows', t => {
 const store = new Store(':memory:'); t.after(() => store.close());
 store.applyCodexSnapshots([empty()]);
 for (const table of ['sessions', 'tasks', 'codex_source_meta', 'codex_execution_sources', 'traces', 'turns', 'batches']) assert.equal(store.rows(`SELECT * FROM ${table}`).length, 0, table);
 store.applyCodexSnapshots([active()]);
 assert.equal(store.state().sessions.length, 1);
 assert.equal(store.state().sessions[0]!.nativeSessionId, 'empty');
 assert.equal(store.rows('SELECT * FROM traces').length, 1);
});

test('legacy metadata-only entries are removed with empty recalls, reader state and receipts', t => {
 const store = new Store(':memory:'); t.after(() => store.close());
 const session = legacy(store);
 store.db.exec('CREATE TABLE codex_sources(path TEXT,state TEXT,nativeSessionId TEXT,error TEXT,updatedAt TEXT); CREATE TABLE codex_receipts(id TEXT,event TEXT,status TEXT,createdAt TEXT,error TEXT)');
 store.db.prepare('INSERT INTO codex_sources VALUES(?,?,?,?,?)').run('/source/empty.jsonl', JSON.stringify({ parser: { snapshot: empty(), pending: [] } }), 'empty', null, 'now');
 store.db.prepare('INSERT INTO codex_receipts VALUES(?,?,?,?,?)').run('receipt', JSON.stringify({ nativeSessionId: 'empty', event: 'session-start' }), 'processed', 'now', null);
 store.recall(session.id, null, 'initial', null, null, '', 'prepared');
 store.codex.pruneEmptySessions();
 for (const table of ['sessions', 'tasks', 'codex_source_meta', 'codex_sources', 'codex_receipts', 'recalls']) assert.equal(store.rows(`SELECT * FROM ${table}`).length, 0, table);
 store.codex.pruneEmptySessions();
 assert.deepEqual(store.state().sessions, []);
});

test('cleanup preserves real work, missing-source evidence, bindings and submitted reservations', t => {
 const store = new Store(':memory:'); t.after(() => store.close());
 const bound = legacy(store, 'bound'); store.bind(bound.objectId, 'space', 'https://example.invalid');
 const missing = legacy(store, 'missing'); store.db.prepare('UPDATE codex_source_meta SET gaps=? WHERE nativeSessionId=?').run('["source_unavailable"]', 'missing');
 const reserved = legacy(store, 'reserved'); store.codex.reserveContext('reserved', 'pending');
 const orphan = legacy(store, 'orphan');
 const result = store.db.prepare('INSERT INTO traces(sessionId,conversationId,sourceId,raw,message,createdAt) VALUES(NULL,NULL,?,?,?,?)').run('orphan-event', '{}', '{"role":"user","content":"task"}', 'now');
 store.db.prepare('INSERT INTO codex_event_meta VALUES(?,?,?,?,?,?,?,?)').run('orphan-event', Number(result.lastInsertRowid), 'orphan', 'turn', 'turn', 'now', 1, null);
 store.applyCodexSnapshots([active('working')]);
 store.codex.pruneEmptySessions();
 for (const session of [bound, missing, reserved, orphan]) assert.ok(store.session(session.id));
 assert.ok(store.row("SELECT id FROM sessions WHERE nativeSessionId='working'"));
});

test('a formerly populated source becoming empty cannot erase its captured history', t => {
 const store = new Store(':memory:'); t.after(() => store.close());
 store.applyCodexSnapshots([active()]);
 const session = store.state().sessions[0]!, trace = store.rows('SELECT * FROM traces')[0]!;
 store.applyCodexSnapshots([empty()]);
 assert.equal(store.rows('SELECT * FROM traces')[0]!.id, trace.id);
 assert.ok(store.session(String(session.id)));
 assert.ok(String(store.row('SELECT gaps FROM codex_source_meta')!.gaps).includes('source_became_empty'));
 assert.equal(store.row('SELECT captureStatus FROM codex_rounds')!.captureStatus, 'incomplete');
});
