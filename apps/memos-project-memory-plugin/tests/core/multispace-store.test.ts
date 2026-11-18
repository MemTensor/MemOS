import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/storage/store.ts';

test('space bindings append idempotently and remove just the selected SQLite relation, including the last one', () => {
  const store = new Store(':memory:');
  try {
    const project = store.createProject('用户的项目名称', '/workspace/project');
    assert.equal(store.binding(project.id), undefined);
    store.bind(project.id, 'space-a', 'http://cloud', '空间甲');
    store.bind(project.id, 'space-b', 'http://cloud', '空间乙');
    store.bind(project.id, 'space-a', 'http://cloud', '空间甲');
    assert.deepEqual(store.binding(project.id)?.spaceIds, ['space-a', 'space-b']);
    assert.deepEqual(store.spaces(project.id), [{ spaceId: 'space-a', name: '空间甲' }, { spaceId: 'space-b', name: '空间乙' }]);
    assert.equal(store.rows('SELECT * FROM bindings WHERE objectId=? AND spaceId IS NOT NULL', project.id).length, 2);
    store.unbind(project.id, 'space-a');
    assert.deepEqual(store.binding(project.id)?.spaceIds, ['space-b']);
    assert.equal(store.row('SELECT * FROM bindings WHERE objectId=? AND spaceId=?', project.id, 'space-a'), undefined);
    store.unbind(project.id, 'space-b');
    assert.deepEqual(store.binding(project.id)?.spaceIds, []);
    assert.equal(store.binding(project.id)?.status, 'unbound');
    assert.equal(store.rows('SELECT * FROM projects').length, 1);
    assert.deepEqual(store.unbind(project.id, 'space-b').spaceIds, []);
    store.bind(project.id, 'space-c', 'http://cloud', '空间丙');
    assert.deepEqual(store.binding(project.id)?.spaceIds, ['space-c']);
    assert.equal(store.rows('SELECT * FROM bindings WHERE objectId=?', project.id).length, 1);
  } finally { store.close(); }
});

test('project binding records the selected Agent before any session and shares a directory across Agents', () => {
  const store = new Store(':memory:');
  try {
    const project = store.bindProject('我的业务项目', '/workspace/shared', 'one', 'http://cloud', 'claude-code', '团队空间');
    const same = store.bindProject('Ignored replacement name', '/workspace/shared/', 'two', 'http://cloud', 'codex-cli', '个人空间');
    assert.equal(same.id, project.id);
    const state = store.state().projects[0]!;
    assert.equal(state.name, '我的业务项目');
    assert.deepEqual(state.agentTypes, ['claude-code', 'codex-cli']);
    assert.deepEqual(state.spaceIds, ['one', 'two']);
    assert.equal(state.spaceId, undefined);
    store.registerSession({ agentType: 'pi', nativeSessionId: 'new', cwd: '/workspace/shared/src' });
    assert.deepEqual(store.state().projects[0]!.agentTypes, ['claude-code', 'codex-cli', 'pi']);
  } finally { store.close(); }
});

test('removing a shared Space only unbinds the selected project', () => {
  const store = new Store(':memory:');
  try {
    const first = store.bindProject('项目甲', '/workspace/first', 'shared', 'http://cloud');
    const other = store.bindProject('项目乙', '/workspace/other', 'shared', 'http://cloud');
    store.unbind(first.id, 'shared');
    assert.deepEqual(store.binding(first.id)?.spaceIds, []);
    assert.deepEqual(store.binding(other.id)?.spaceIds, ['shared']);
    assert.equal(store.rows('SELECT * FROM bindings WHERE spaceId=?', 'shared').length, 1);
  } finally { store.close(); }
});

test('adopting standalone sessions preserves their spaces as a union without orphaning old binding rows', () => {
  const store = new Store(':memory:');
  try {
    const first = store.registerSession({ agentType: 'claude-code', nativeSessionId: 'one', cwd: '/workspace/shared' });
    const other = store.registerSession({ agentType: 'codex-cli', nativeSessionId: 'two', cwd: '/workspace/shared/src' });
    store.bind(first.objectId, 'one', 'http://cloud', '空间一');
    store.bind(other.objectId, 'two', 'http://cloud', '空间二');
    const project = store.bindProject('Shared', '/workspace/shared', 'three', 'http://cloud', 'pi', '空间三');
    assert.deepEqual(store.binding(project.id)?.spaceIds, ['one', 'two', 'three']);
    assert.equal(store.binding(first.objectId), undefined);
    assert.equal(store.binding(other.objectId), undefined);
    assert.equal(store.session(first.id)?.objectId, project.id);
    assert.equal(store.session(other.id)?.objectId, project.id);
    store.unbind(project.id, 'one');
    assert.equal(store.rows('SELECT * FROM bindings WHERE spaceId=?', 'one').length, 0);
    assert.deepEqual(store.state().projects[0]!.agentTypes, ['claude-code', 'codex-cli', 'pi']);
  } finally { store.close(); }
});

test('multi-space migration backs up real legacy SQLite and retains single bindings and attempted payload targets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pm-multi-migration-')), path = join(directory, 'memory.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,root TEXT NOT NULL,createdAt TEXT NOT NULL);
    CREATE TABLE bindings(objectId TEXT PRIMARY KEY,spaceId TEXT,baseUrl TEXT NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL);
    CREATE TABLE batches(id TEXT PRIMARY KEY,sessionId TEXT,objectId TEXT,spaceId TEXT,messages TEXT,status TEXT,uploaded INTEGER,attempts INTEGER,error TEXT,taskId TEXT,processingStatus TEXT,createdAt TEXT,conversationId TEXT);
    CREATE TABLE turns(id TEXT PRIMARY KEY,sessionId TEXT,nativeKey TEXT,createdAt TEXT,completedAt TEXT);
    INSERT INTO projects VALUES('project','用户项目','/legacy','2026-11-18');
    INSERT INTO bindings VALUES('project','legacy-space','http://cloud','用户项目','bound');
    INSERT INTO batches VALUES('accepted','session','project','legacy-space','[]','accepted',1,1,NULL,'cloud-task','running','2026-11-18',NULL);
    PRAGMA user_version=2;
  `);
  legacy.close();
  let store = new Store(path);
  try {
    assert.deepEqual(store.binding('project')?.spaceIds, ['legacy-space']);
    assert.deepEqual(store.batches()[0]?.spaceIds, ['legacy-space']);
    assert.equal(store.batches()[0]?.uploaded, true);
    assert.equal(store.batches()[0]?.attempts, 1);
    assert.equal(store.batches()[0]?.taskId, 'cloud-task');
    assert.ok(!store.rows('PRAGMA table_info(batches)').some(column => column.name === 'spaceId'));
    const backups = readdirSync(directory).filter(name => name.includes('before-multi-space'));
    assert.equal(backups.length, 1);
    store.bind('project', 'second', 'http://cloud', '第二个空间');
    store.unbind('project', 'legacy-space');
    store.close(); store = new Store(path);
    assert.deepEqual(store.binding('project')?.spaceIds, ['second']);
    assert.deepEqual(store.batches()[0]?.spaceIds, ['legacy-space']);
    assert.deepEqual(readdirSync(directory).filter(name => name.includes('before-multi-space')), backups);
    store.unbind('project', 'second');
    store.close(); store = new Store(path);
    assert.deepEqual(store.binding('project')?.spaceIds, []);
    assert.equal(store.binding('project')?.status, 'unbound');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('cross-connection and uncertain bindings still roll back project adoption', () => {
  const store = new Store(':memory:');
  try {
    const session = store.registerSession({ agentType: 'pi', nativeSessionId: 'old', cwd: '/workspace/project' });
    store.bind(session.objectId, 'old-space', 'http://old');
    assert.throws(() => store.bindProject('Project', '/workspace/project', 'new-space', 'http://new'), /连接|绑定不可更改/);
    assert.equal(store.state().projects.length, 0);
    assert.equal(store.session(session.id)?.objectId, session.objectId);
    store.setCreating('creating-object', 'http://cloud', 'uncertain');
    assert.throws(() => store.unbind('creating-object', 'any'), /尚待确认|不存在/);
  } finally { store.close(); }
});
