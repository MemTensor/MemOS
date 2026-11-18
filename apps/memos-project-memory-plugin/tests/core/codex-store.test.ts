import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/storage/store.ts';
import type { CodexRecord, CodexSnapshot, CodexTurn } from '../../src/adapters/codex-cli/types.ts';

const time = (second: number) => `2026-11-18T01:00:${String(second).padStart(2, '0')}.000Z`;
function record(id: string, session: string, turn: string, second: number, role = 'assistant', content = id): CodexRecord {
    return { sourceId: id, nativeTurnId: turn, rootTurnId: turn, originSessionId: session, sourceOrdinal: second, occurredAt: time(second), raw: { id, role, content }, message: { role, content } };
}
function turn(id: string, records: CodexRecord[], overrides: Partial<CodexTurn> = {}): CodexTurn {
    return { nativeTurnId: id, rootTurnId: id, startedAt: records[0]?.occurredAt, completedAt: records.at(-1)?.occurredAt, status: 'completed', records, expectedChildren: [], gaps: [], ...overrides };
}
function snapshot(id: string, turns: CodexTurn[], overrides: Partial<CodexSnapshot> = {}): CodexSnapshot {
    return { nativeSessionId: id, cwd: '/project', sourceKind: 'user', startedAt: turns[0]?.startedAt, sourcePath: `/rollouts/${id}.jsonl`, turns, gaps: [], ...overrides };
}
function native(store: Store, id: string) { return store.row('SELECT id FROM sessions WHERE nativeSessionId=?', id)!.id as string; }

test('trusted Codex metadata corrects legacy directory without moving identity, spaces or uploaded payloads', () => {
    const store = new Store(':memory:');
    try {
        const session = store.registerSession({ agentType: 'codex-cli', nativeSessionId: 'main', cwd: '/wrong' });
        store.bind(session.objectId, 'space', 'http://cloud');
        const source = snapshot('main', [turn('r', [record('u', 'main', 'r', 1, 'user'), record('a', 'main', 'r', 2)])]);
        store.applyCodexSnapshots([source]); store.prepareCodexUploads();
        store.updateBatch(store.batches()[0]!.id, { uploaded: true, attempts: 1, status: 'completed' });
        // Model a database written by the old registration path.
        store.db.prepare('UPDATE sessions SET cwd=? WHERE id=?').run('/wrong', session.id);
        store.db.prepare('UPDATE tasks SET name=? WHERE id=?').run('wrong', session.taskId);
        const tables = ['turns', 'traces', 'batches', 'bindings'];
        const before = tables.map(table => store.rows(`SELECT * FROM ${table} ORDER BY rowid`));
        store.applyCodexSnapshots([]);
        const corrected = store.session(session.id)!;
        assert.equal(corrected.cwd, '/project');
        assert.equal(corrected.objectId, session.objectId);
        assert.equal(corrected.taskId, session.taskId);
        assert.equal(store.row('SELECT name FROM tasks WHERE id=?', session.taskId)!.name, 'project');
        assert.deepEqual(tables.map(table => store.rows(`SELECT * FROM ${table} ORDER BY rowid`)), before);
        store.applyCodexSnapshots([]);
        assert.deepEqual(store.session(session.id), corrected);
        assert.deepEqual(tables.map(table => store.rows(`SELECT * FROM ${table} ORDER BY rowid`)), before);
    } finally { store.close(); }
});

test('directory correction preserves explicit projects and diagnoses conflicting source directories', () => {
    const store = new Store(':memory:');
    try {
        const project = store.createProject('Named project', '/registered');
        const bound = store.registerSession({ agentType: 'codex-cli', nativeSessionId: 'bound', cwd: '/registered' });
        store.bind(bound.objectId, 'space', 'http://cloud');
        const work = (id: string) => [turn('t', [record(`${id}-user`, id, 't', 1, 'user')])];
        store.applyCodexSnapshots([snapshot('bound', work('bound'), { cwd: '/elsewhere' })]);
        assert.equal(store.session(bound.id)!.cwd, '/registered');
        assert.equal(store.row('SELECT projectId,name FROM tasks WHERE id=?', bound.taskId)!.projectId, project.id);
        assert.equal(store.row('SELECT name FROM tasks WHERE id=?', bound.taskId)!.name, 'Named project');
        assert.deepEqual(store.binding(bound.objectId)?.spaceIds, ['space']);
        assert.ok(store.rows('SELECT message FROM diagnostics').some(row => String(row.message).includes('bound')));
        const known = store.registerSession({ agentType: 'codex-cli', nativeSessionId: 'conflict', cwd: '/original' });
        store.applyCodexSnapshots([snapshot('conflict', work('conflict'), { cwd: '/one' }), snapshot('conflict', work('conflict'), { cwd: '/two', sourcePath: '/other.jsonl' })]);
        assert.equal(store.session(known.id)!.cwd, '/original');
        assert.ok(store.rows('SELECT message FROM diagnostics').some(row => String(row.message).includes('conflict')));
        const count = store.rows('SELECT * FROM diagnostics').length;
        store.applyCodexSnapshots([]);
        assert.equal(store.rows('SELECT * FROM diagnostics').length, count);
        store.applyCodexSnapshots([snapshot('bound', work('bound'), { cwd: '/registered/subdir' })]);
        assert.equal(store.session(bound.id)!.cwd, '/registered/subdir');
        assert.equal(store.row('SELECT name FROM tasks WHERE id=?', bound.taskId)!.name, 'Named project');
    } finally { store.close(); }
});

test('Codex keeps an entire main/child interaction in one round in source order and waits for children', () => {
    const store = new Store(':memory:');
    try {
        store.createProject('project', '/project');
        const parent = snapshot('main', [turn('r1', [record('u', 'main', 'r1', 1, 'user'), record('spawn', 'main', 'r1', 2), record('answer', 'main', 'r1', 9)], {
            expectedChildren: [{ callId: 'spawn-call', agentId: 'child', kind: 'spawn', status: 'started' }],
        })]);
        const child = snapshot('child', [turn('c1', [record('cu', 'child', 'c1', 3, 'user'), record('ct', 'child', 'c1', 4, 'tool'), record('ca', 'child', 'c1', 8)], { rootTurnId: 'r1', parentTurnId: 'r1' })], { sourceKind: 'subagent', parentNativeSessionId: 'main', agentPath: '/root/child', cwd: '/temporary-worktree' });
        store.applyCodexSnapshots([parent]);
        store.prepareCodexUploads();
        assert.equal(store.batches().length, 0);
        assert.equal(store.sessionDetail(native(store, 'main'), 1, 10, 'turn').groups?.[0]?.captureStatus, 'awaiting_children');
        store.applyCodexSnapshots([parent, child]);
        store.prepareCodexUploads();
        const detail = store.sessionDetail(native(store, 'main'), 1, 10, 'turn');
        assert.equal(detail.total, 1);
        assert.deepEqual(detail.traces.map(row => (row.message as any).content), ['u', 'spawn', 'cu', 'ct', 'ca', 'answer']);
        assert.equal(new Set(detail.traces.map(row => row.conversationId)).size, 1);
        assert.equal(store.batches().length, 1);
        assert.deepEqual(store.batches()[0]!.messages.map(row => row.content), ['u', 'spawn', 'cu', 'ct', 'ca', 'answer']);
        assert.equal(store.session(native(store, 'child'))!.objectId, store.session(native(store, 'main'))!.objectId);
        assert.deepEqual(store.state().sessions.map(row => row.nativeSessionId), ['main']);
        store.applyCodexSnapshots([child, parent]); store.prepareCodexUploads();
        assert.equal(store.sessionDetail(native(store, 'main')).traces.length, 6);
        assert.equal(store.batches().length, 1);
    } finally { store.close(); }
});

test('Codex history arrives in reverse order but rounds and event timestamps stay chronological', () => {
    const store = new Store(':memory:');
    try {
        const newer = turn('r2', [record('u2', 'main', 'r2', 20, 'user'), record('a2', 'main', 'r2', 25)]);
        const older = turn('r1', [record('u1', 'main', 'r1', 1, 'user'), record('a1', 'main', 'r1', 5)]);
        store.applyCodexSnapshots([snapshot('main', [newer])]);
        const newerContext = store.contextForCodex('main', 'r2')!;
        store.applyCodexSnapshots([snapshot('main', [older, newer])]);
        const detail = store.sessionDetail(newerContext.sessionId, 1, 1, 'turn');
        assert.equal(detail.total, 2);
        assert.deepEqual(detail.traces.map(row => (row.message as any).content), ['u1', 'a1']);
        assert.equal(detail.traces[0]!.occurredAt, time(1));
        assert.equal(store.contextForCodex('main', 'r2')!.conversationId, newerContext.conversationId);
        assert.equal(store.state().sessions[0]!.sourceStartedAt, time(1));
    } finally { store.close(); }
});

test('Codex child-first ingestion resolves after parent arrives without creating a child user round', () => {
    const store = new Store(':memory:');
    try {
        const child = snapshot('child', [turn('c1', [record('cu', 'child', 'c1', 3, 'user'), record('ca', 'child', 'c1', 4)], { rootTurnId: 'r1', parentTurnId: 'r1' })], { sourceKind: 'subagent', parentNativeSessionId: 'main' });
        store.applyCodexSnapshots([child]); store.prepareCodexUploads();
        assert.equal(store.state().sessions.length, 0);
        assert.equal(store.batches().length, 0);
        store.applyCodexSnapshots([snapshot('main', [turn('r1', [record('u', 'main', 'r1', 1, 'user'), record('a', 'main', 'r1', 5)])])]);
        store.prepareCodexUploads();
        assert.equal(store.sessionDetail(native(store, 'main'), 1, 10, 'turn').total, 1);
        assert.equal(store.sessionDetail(native(store, 'main')).traces.length, 4);
    } finally { store.close(); }
});

test('Codex updates unsent snapshots but never changes an attempted payload when late content arrives', () => {
    const store = new Store(':memory:');
    try {
        const input = record('u', 'main', 'r1', 1, 'user'), answer = record('a', 'main', 'r1', 9);
        store.applyCodexSnapshots([snapshot('main', [turn('r1', [input, answer])])]); store.prepareCodexUploads();
        const batchId = store.batches()[0]!.id;
        const late = record('late', 'main', 'r1', 4, 'tool');
        store.applyCodexSnapshots([snapshot('main', [turn('r1', [input, late, answer])])]); store.prepareCodexUploads();
        assert.equal(store.batches()[0]!.id, batchId);
        assert.deepEqual(store.batches()[0]!.messages.map(row => row.content), ['u', 'late', 'a']);
        store.updateBatch(batchId, { attempts: 1 });
        const later = record('later', 'main', 'r1', 6, 'tool');
        store.applyCodexSnapshots([snapshot('main', [turn('r1', [input, late, later, answer])])]); store.prepareCodexUploads();
        assert.deepEqual(store.batches()[0]!.messages.map(row => row.content), ['u', 'late', 'a']);
        const detail = store.sessionDetail(native(store, 'main'), 1, 10, 'turn');
        assert.equal(detail.traces.length, 4);
        assert.equal(detail.groups?.[0]?.uploadOutOfDate, true);
    } finally { store.close(); }
});

test('Codex restart preserves task identity and hides background snapshots', () => {
    const directory = mkdtempSync(join(tmpdir(), 'memos-codex-store-')), path = join(directory, 'db.sqlite');
    let store = new Store(path);
    try {
        const source = snapshot('main', [turn('r1', [record('u', 'main', 'r1', 1, 'user'), record('a', 'main', 'r1', 3)])]);
        store.applyCodexSnapshots([source]); store.prepareCodexUploads();
        const context = store.contextForCodex('main', 'r1'); const batch = store.batches()[0]!.id;
        store.close(); store = new Store(path);
        store.applyCodexSnapshots([source, snapshot('background', [], { sourceKind: 'background' })]); store.prepareCodexUploads();
        assert.deepEqual(store.contextForCodex('main', 'r1'), context);
        assert.equal(store.batches()[0]!.id, batch);
        assert.equal(store.state().sessions.length, 1);
        assert.equal(store.row('SELECT id FROM sessions WHERE nativeSessionId=?', 'background'), undefined);
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Codex merges multiple files for one native session and retains groups when a sibling file is reread', () => {
    const store = new Store(':memory:');
    try {
        const first = snapshot('main', [turn('r1', [record('u1', 'main', 'r1', 1, 'user'), record('a1', 'main', 'r1', 5)])]);
        const second = snapshot('main', [turn('r2', [record('u2', 'main', 'r2', 11, 'user'), record('a2', 'main', 'r2', 15)])], { sourcePath: '/rollouts/main-resumed.jsonl' });
        store.applyCodexSnapshots([second, first]);
        store.applyCodexSnapshots([second]);
        const detail = store.sessionDetail(native(store, 'main'), 1, 10, 'turn');
        assert.equal(detail.total, 2);
        assert.deepEqual(detail.traces.map(row => (row.message as any).content), ['u1', 'a1', 'u2', 'a2']);
    } finally { store.close(); }
});

test('an unlinked child turn remains pending and never becomes a synthetic parent round', () => {
    const store = new Store(':memory:');
    try {
        const parent = snapshot('main', [turn('r1', [record('u', 'main', 'r1', 1, 'user'), record('a', 'main', 'r1', 8)], { expectedChildren: [{ callId: 'spawn', agentId: 'child', kind: 'spawn', status: 'started' }] })]);
        const child = snapshot('child', [turn('c1', [record('cu', 'child', 'c1', 3, 'user'), record('ca', 'child', 'c1', 5)])], { sourceKind: 'subagent', parentNativeSessionId: 'main' });
        store.applyCodexSnapshots([parent, child]); store.prepareCodexUploads();
        assert.equal(store.sessionDetail(native(store, 'main'), 1, 10, 'turn').total, 1);
        assert.equal(store.batches().length, 0);
        assert.equal(store.contextForCodex('child', 'c1'), undefined);
    } finally { store.close(); }
});

test('same item disagreement across source files is visible and blocks completed upload', () => {
    const store = new Store(':memory:');
    try {
        const first = snapshot('main', [turn('r1', [record('u', 'main', 'r1', 1, 'user'), record('a', 'main', 'r1', 8)])]);
        const second = snapshot('main', [turn('r1', [record('u', 'main', 'r1', 1, 'user'), record('a', 'main', 'r1', 8, 'assistant', 'different')])], { sourcePath: '/rollouts/second.jsonl' });
        store.applyCodexSnapshots([first, second]); store.prepareCodexUploads();
        const group = store.sessionDetail(native(store, 'main'), 1, 10, 'turn').groups![0]!;
        assert.equal(group.captureStatus, 'incomplete');
        assert.equal(store.batches().length, 0);
    } finally { store.close(); }
});

test('followup to an already running child does not reorder its earlier events or finish from an older result', () => {
    const store = new Store(':memory:');
    try {
        const spawn = record('spawn', 'main', 'r1', 2); spawn.message.tool_calls = [{ id: 'spawn', function: { name: 'spawn_agent', arguments: '{}' } }];
        const followup = record('followup', 'main', 'r1', 6); followup.message.tool_calls = [{ id: 'followup', function: { name: 'send_message', arguments: '{}' } }];
        const parent = snapshot('main', [turn('r1', [record('u', 'main', 'r1', 1, 'user'), spawn, followup, record('a', 'main', 'r1', 12)], { expectedChildren: [
            { callId: 'spawn', agentId: 'child', kind: 'spawn', status: 'started', occurredAt: time(2) },
            { callId: 'followup', agentId: 'child', kind: 'followup', status: 'started', occurredAt: time(6) },
        ] })]);
        const child = snapshot('child', [turn('c1', [record('cu', 'child', 'c1', 3, 'user'), record('early', 'child', 'c1', 5)], { rootTurnId: 'r1', parentTurnId: 'r1' })], { sourceKind: 'subagent', parentNativeSessionId: 'main' });
        store.applyCodexSnapshots([parent, child]); store.prepareCodexUploads();
        assert.equal(store.batches().length, 0);
        child.turns[0]!.records.push(record('late', 'child', 'c1', 9)); child.turns[0]!.completedAt = time(9);
        store.applyCodexSnapshots([child]); store.prepareCodexUploads();
        assert.equal(store.batches().length, 1);
        assert.deepEqual(store.sessionDetail(native(store, 'main')).traces.map(row => (row.message as any).content), ['u', 'spawn', 'cu', 'early', 'followup', 'late', 'a']);
    } finally { store.close(); }
});

test('Codex database initialization quarantines unclassified legacy sessions and pending uploads without deleting them', () => {
    const directory = mkdtempSync(join(tmpdir(), 'memos-codex-legacy-')), path = join(directory, 'db.sqlite');
    let store = new Store(path);
    try {
        const session = store.registerSession({ agentType: 'codex-cli', nativeSessionId: 'legacy', cwd: '/project' });
        store.startTurn(session.id, 'r1'); store.capture(session.id, [{ sourceId: 'old', raw: { role: 'user', content: 'legacy input' } }]); store.finalizeTurn(session.id);
        const batch = store.batches()[0]!, original = batch.messages;
        store.close(); store = new Store(path);
        assert.equal(store.batches()[0]!.status, 'blocked');
        assert.deepEqual(store.batches()[0]!.messages, original);
        assert.equal(store.state().sessions.length, 0);
        assert.equal(store.state().quarantinedSessions.length, 1);
        assert.equal(store.rows('SELECT * FROM traces').length, 1);
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a legacy attempted payload remains frozen and its difference from the canonical round is visible', () => {
    const store = new Store(':memory:');
    try {
        const session = store.registerSession({ agentType: 'codex-cli', nativeSessionId: 'main', cwd: '/project' });
        store.startTurn(session.id, 'r1');
        store.capture(session.id, [{ sourceId: 'legacy', raw: { role: 'user', content: 'old incomplete input' } }]);
        store.finalizeTurn(session.id);
        const existing = store.batches()[0]!; store.updateBatch(existing.id, { attempts: 1 });
        store.applyCodexSnapshots([snapshot('main', [turn('r1', [record('u', 'main', 'r1', 1, 'user'), record('a', 'main', 'r1', 3)])])]); store.prepareCodexUploads();
        assert.deepEqual(store.batches()[0]!.messages, existing.messages);
        assert.equal(store.batches()[0]!.attempts, 1);
        assert.equal(store.sessionDetail(session.id, 1, 10, 'turn').groups![0]!.uploadOutOfDate, true);
        assert.equal(store.sessionDetail(session.id, 1, 10, 'turn').traces.length, 2);
        assert.equal(store.rows('SELECT * FROM traces').length, 3);
    } finally { store.close(); }
});

test('equal-timestamp rounds use the original input ordinal rather than lexical turn ID or insertion order', () => {
    const store = new Store(':memory:');
    try {
        const firstUser = record('first-user', 'main', 'z-first', 1, 'user'), secondUser = record('second-user', 'main', 'a-second', 2, 'user');
        secondUser.occurredAt = firstUser.occurredAt;
        const first = turn('z-first', [firstUser, record('first-answer', 'main', 'z-first', 3)], { startedAt: time(1) });
        const second = turn('a-second', [secondUser, record('second-answer', 'main', 'a-second', 4)], { startedAt: time(1) });
        store.applyCodexSnapshots([snapshot('main', [second])]); store.prepareCodexUploads();
        store.applyCodexSnapshots([snapshot('main', [second, first])]); store.prepareCodexUploads();
        const detail = store.sessionDetail(native(store, 'main'), 1, 10, 'turn');
        assert.deepEqual(detail.groups!.map(group => (group.traces[0]!.message as any).content), ['first-user', 'second-user']);
        assert.deepEqual(store.batches().map(batch => batch.messages[0]!.content), ['first-user', 'second-user']);
    } finally { store.close(); }
});

test('capture lookups use indexed source and execution identities instead of per-event full scans', () => {
    const store = new Store(':memory:');
    try {
        for (const sql of [
            "SELECT count(DISTINCT messageHash) FROM codex_event_sources WHERE sourceId='event'",
            "SELECT 1 FROM codex_event_sources WHERE sourceId='event'",
            "SELECT traceId FROM codex_event_meta WHERE originSessionId='session' AND nativeTurnId='turn'",
        ]) {
            const plan = store.rows('EXPLAIN QUERY PLAN ' + sql).map(row => row.detail).join('\n');
            assert.match(plan, /SEARCH/, plan);
            assert.doesNotMatch(plan, /SCAN codex_/, plan);
        }
    } finally { store.close(); }
});

test('preparing uploads reads batch payloads once and leaves unchanged snapshots untouched', () => {
    const store = new Store(':memory:');
    try {
        store.applyCodexSnapshots([snapshot('main', [turn('a', [record('ua','main','a',1,'user')]), turn('b', [record('ub','main','b',2,'user')])])]);
        let reads = 0;
        const batches = store.batches.bind(store);
        store.batches = (...args) => { reads++; return batches(...args); };
        store.prepareCodexUploads();
        assert.equal(reads, 1);
        const writes = store.row('SELECT total_changes() AS n')!.n;
        reads = 0; store.prepareCodexUploads();
        assert.equal(reads, 1);
        assert.equal(store.row('SELECT total_changes() AS n')!.n, writes);
    } finally { store.close(); }
});
