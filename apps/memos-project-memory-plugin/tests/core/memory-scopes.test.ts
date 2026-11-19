import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/storage/store.ts';
import { Deliveries } from '../../src/storage/deliveries.ts';

test('binding activates only the selected Agent and preserves records after the last unbind', () => {
    const store = new Store(':memory:');
    try {
        const project = store.bindProject('project', '/project', 'space-a', 'http://cloud', 'codex-cli');
        const scope = store.memory.resolve('codex-cli', '/project/subdir')!;
        assert.equal(scope.projectId, project.id);
        assert.deepEqual(scope.spaceIds, ['space-a']);
        assert.equal(store.memory.resolve('deepseek-harness', '/project'), undefined);
        const session = store.registerSession({ agentType: 'codex-cli', nativeSessionId: 'main', cwd: '/project' });
        assert.equal(session.objectId, scope.id);
        assert.equal(store.memory.forSession(session)?.id, scope.id);
        store.unbind(scope.id, 'space-a');
        assert.equal(store.memory.resolve('codex-cli', '/project'), undefined);
        assert.equal(store.memory.forSession(session), undefined);
        assert.ok(store.session(session.id));
        assert.deepEqual(store.memory.get(scope.id)?.spaceIds, []);
    } finally { store.close(); }
});

test('capture windows exclude pre-binding records and disabled intervals', () => {
    const store = new Store(':memory:');
    try {
        store.bindProject('project', '/project', 'space-a', 'http://cloud', 'codex-cli');
        const scope = store.memory.resolve('codex-cli', '/project')!;
        store.db.prepare('UPDATE capture_windows SET startedAt=? WHERE scopeId=?').run('2026-01-01T00:00:10.000Z', scope.id);
        assert.equal(store.memory.allows(scope.id, '2026-01-01T00:00:09.000Z'), false);
        assert.equal(store.memory.allows(scope.id, '2026-01-01T00:00:11.000Z'), true);
        store.unbind(scope.id, 'space-a');
        store.db.prepare('UPDATE capture_windows SET endedAt=? WHERE scopeId=?').run('2026-01-01T00:00:20.000Z', scope.id);
        store.bind(scope.id, 'space-b', 'http://cloud');
        store.db.prepare('UPDATE capture_windows SET startedAt=? WHERE scopeId=? AND endedAt IS NULL').run('2026-01-01T00:00:30.000Z', scope.id);
        assert.equal(store.memory.allows(scope.id, '2026-01-01T00:00:15.000Z'), false);
        assert.equal(store.memory.allows(scope.id, '2026-01-01T00:00:25.000Z'), false);
        assert.equal(store.memory.allows(scope.id, '2026-01-01T00:00:35.000Z'), true);
        store.bind(scope.id, 'space-c', 'http://cloud');
        assert.equal(store.rows('SELECT * FROM capture_windows WHERE scopeId=? AND endedAt IS NULL', scope.id).length, 1);
        store.unbind(scope.id, 'space-b');
        assert.deepEqual(store.memory.resolve('codex-cli', '/project')?.spaceIds, ['space-c']);
    } finally { store.close(); }
});

test('a nested project without an Agent binding does not inherit a parent project binding', () => {
    const store = new Store(':memory:');
    try {
        store.bindProject('parent', '/project', 'space', 'http://cloud', 'codex-cli');
        store.createProject('child', '/project/child');
        assert.equal(store.memory.resolve('codex-cli', '/project/child/work'), undefined);
    } finally { store.close(); }
});

test('a same-Agent child inherits its bound parent scope across working directories', () => {
 const store=new Store(':memory:');
 try {
  const project=store.bindProject('Parent','/parent','space','http://cloud','claude-code');
  const parent=store.registerSession({agentType:'claude-code',nativeSessionId:'parent',cwd:'/parent'});
  const child=store.registerSession({agentType:'claude-code',nativeSessionId:'child',cwd:'/temporary',parentNativeSessionId:'parent'});
  assert.equal(child.objectId,project.scopeId);
  assert.equal(store.row('SELECT projectId FROM tasks WHERE id=?',child.taskId)?.projectId,project.id);
  assert.equal(child.cwd,'/temporary');
  const unrelated=store.registerSession({agentType:'pi',nativeSessionId:'other',cwd:'/temporary',parentNativeSessionId:'parent'});
  assert.equal(store.memory.forSession(unrelated),undefined);
  store.startTurn(child.id,'turn');
  assert.equal(store.capture(child.id,[{sourceId:'record',raw:{timestamp:new Date().toISOString(),role:'assistant',content:'child result'}}]),1);
  store.unbind(parent.objectId,'space');
  assert.equal(store.memory.forSession(child),undefined);
  assert.equal(store.capture(child.id,[{sourceId:'disabled',raw:{timestamp:new Date().toISOString(),role:'assistant',content:'disabled'}}]),0);
 } finally {store.close();}
});

test('legacy migration scopes known Agents without altering traces or sent batch targets', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pm-agent-bindings-')), path = join(directory, 'memory.sqlite');
    let store = new Store(path);
    try {
        const project = store.createProject('project', '/project');
        const unknown = store.createProject('unknown', '/unknown');
        const session = store.registerSession({ agentType: 'deepseek-harness', nativeSessionId: 'main', cwd: '/project' });
        store.bind(project.id, 'space', 'http://cloud'); store.bind(unknown.id, 'unknown-space', 'http://cloud');
        const turn = store.startTurn(session.id, 't');
        store.capture(session.id, [{ sourceId: 'u', nativeTurnId: 't', raw: { role: 'user', content: 'task', source: { kind: 'user' } }, message: { role: 'user', content: 'task' } }]);
        store.finalizeTurn(session.id, 't');
        store.updateBatch(store.batches()[0]!.id, { uploaded: true, attempts: 1, status: 'completed', spaceIds: ['space'], taskId: 'remote-task' });
        const trace = store.rows('SELECT * FROM traces'), batch = store.batches()[0]!;
        store.close();
        const legacy = new DatabaseSync(path);
        legacy.exec('DROP INDEX project_agent_scope; ALTER TABLE project_agents DROP COLUMN id; ALTER TABLE bindings DROP COLUMN boundAt; DROP TABLE capture_windows;');
        legacy.close();
        store = new Store(path);
        const scope = store.memory.resolve('deepseek-harness', '/project')!;
        assert.ok(scope);
        assert.equal(store.memory.resolve('codex-cli', '/project'), undefined);
        assert.equal(store.memory.resolve('deepseek-harness', '/unknown'), undefined);
        assert.equal(store.session(session.id)!.objectId, scope.id);
        assert.equal(store.session(session.id)!.currentTurnId, turn.id);
        assert.deepEqual(store.rows('SELECT * FROM traces'), trace);
        assert.deepEqual(store.batches()[0], { ...batch, objectId: scope.id });
        assert.equal(store.memory.allows(scope.id, '2020-01-01T00:00:00Z'), false);
        assert.ok(readdirSync(directory).some(file => file.includes('before-agent-bindings')));
        store.close(); store = new Store(path);
        assert.equal(store.memory.resolve('deepseek-harness', '/project')!.id, scope.id);
        assert.equal(store.rows('SELECT * FROM capture_windows').length, 1);
    } finally { if (store.db.isOpen) store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('capture rejects old timestamps and stops at last unbind without deleting saved content', () => {
    const store = new Store(':memory:');
    try {
        store.bindProject('project', '/project', 'space', 'http://cloud', 'deepseek-harness');
        const scope = store.memory.resolve('deepseek-harness', '/project')!;
        store.db.prepare('UPDATE capture_windows SET startedAt=? WHERE scopeId=?').run('2026-01-01T00:00:10.000Z', scope.id);
        const session = store.registerSession({ agentType: 'deepseek-harness', nativeSessionId: 'main', cwd: '/project' });
        store.startTurn(session.id, 't');
        const record = (id: string, timestamp: string) => ({ sourceId: id, nativeTurnId: 't', raw: { role: 'user', content: id, timestamp, source: { kind: 'user' } }, message: { role: 'user', content: id } });
        assert.equal(store.capture(session.id, [record('old', '2026-01-01T00:00:09Z'), record('new', '2026-01-01T00:00:11Z')]), 1);
        assert.equal(store.capture(session.id, [{ sourceId: 'unknown-time', nativeTurnId: 't', raw: { role: 'assistant', content: 'undated replay' } }]), 0);
        store.unbind(scope.id, 'space');
        assert.equal(store.capture(session.id, [record('disabled', '2026-01-01T00:00:12Z')]), 0);
        assert.deepEqual(store.rows('SELECT sourceId FROM traces').map(row => row.sourceId), ['new']);
    } finally { store.close(); }
});

test('unbind cancels queued Space deliveries and rebind requires new admission without erasing receipts', () => {
 const store=new Store(':memory:');
 try {
  const project=store.bindProject('Project','/project','pending','http://cloud','test');
  for(const space of ['sending','accepted'])store.bind(project.scopeId,space,'http://cloud');
  const deliveries=new Deliveries(store),session=store.registerSession({agentType:'test',nativeSessionId:'session',cwd:'/project'});
  store.startTurn(session.id,'turn');store.capture(session.id,[{sourceId:'record',raw:{timestamp:new Date().toISOString(),role:'user',content:'task'}}]);store.finalizeTurn(session.id);
  deliveries.queueLive();
  store.db.prepare("UPDATE batch_deliveries SET status=spaceId WHERE spaceId IN ('sending','accepted')").run();
  store.setOverview(session.id,'previous');store.markContextDelivered(session.id);
  for(const space of ['pending','sending','accepted'])store.unbind(project.scopeId,space);
  assert.deepEqual(store.rows('SELECT spaceId,status FROM batch_deliveries ORDER BY spaceId').map(row=>[row.spaceId,row.status]),[['accepted','accepted'],['pending','cancelled'],['sending','cancelled']]);
  store.bind(project.scopeId,'pending','http://cloud');
  assert.equal(store.session(session.id)?.overview,null);assert.equal(store.session(session.id)?.overviewDelivered,0);
  assert.equal(deliveries.pending().length,0);
 } finally {store.close();}
});
