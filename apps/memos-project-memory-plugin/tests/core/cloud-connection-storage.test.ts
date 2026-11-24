import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Configuration } from '../../src/config/config.ts';
import { Store } from '../../src/storage/store.ts';
import { Deliveries } from '../../src/storage/deliveries.ts';
import { DatabaseSync } from 'node:sqlite';

function setup(t: any) {
    const dir = mkdtempSync(join(tmpdir(), 'pm-cloud-storage-'));
    const config = new Configuration(dir);
    config.update({ baseUrl: 'http://localhost:9999/product', apiKey: 'fixture-key' });
    const store = new Store(join(dir, 'memory.sqlite'), config);
    t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
    const project = store.bindProject('demo', '/demo', 'A', config.value.baseUrl, 'codex-cli');
    return { config, store, project };
}

test('changing protocol or cloud project stops admission without deleting bindings; switching back restores it', t => {
    const { config, store, project } = setup(t);
    const original = store.binding(project.scopeId)!;
    assert.equal(typeof (original as any).connectionId, 'string');
    assert.ok(store.memory.resolve('codex-cli', '/demo'));
    Object.assign(config.value, { apiMode: 'algorithm', cloudProjectId: 'test1', authMode: 'none' });
    assert.equal(store.memory.resolve('codex-cli', '/demo'), undefined);
    assert.throws(() => store.bind(project.scopeId, 'B', config.value.baseUrl), /云连接/);
    assert.deepEqual(store.binding(project.scopeId)!.spaceIds, ['A']);
    Object.assign(config.value, { apiMode: 'engineering', cloudProjectId: '' });
    assert.ok(store.memory.resolve('codex-cli', '/demo'));
});

test('domain cache is isolated by protocol and algorithm project on the same URL', t => {
    const { config, store } = setup(t);
    store.setSpaceDomains(config.value.baseUrl, 'A', ['工程']);
    Object.assign(config.value, { apiMode: 'algorithm', cloudProjectId: 'test1', authMode: 'none' });
    assert.equal(store.spaceDomains(config.value.baseUrl, 'A'), undefined);
    store.setSpaceDomains(config.value.baseUrl, 'A', ['算法']);
    Object.assign(config.value, { cloudProjectId: 'test2' });
    assert.equal(store.spaceDomains(config.value.baseUrl, 'A'), undefined);
    Object.assign(config.value, { apiMode: 'engineering', cloudProjectId: '' });
    assert.deepEqual(store.spaceDomains(config.value.baseUrl, 'A'), ['工程']);
});

test('delivery progress keeps accepted receipts while persisting open messages and topic IDs', t => {
    const { config, store, project } = setup(t);
    const deliveries = new Deliveries(store);
    const session = store.registerSession({ agentType: 'codex-cli', nativeSessionId: 'native', cwd: '/demo' });
    store.db.prepare("INSERT INTO batches(id,sessionId,objectId,messages,status,createdAt) VALUES(?,?,?,?,?,?)")
        .run('batch', session.id, project.scopeId, '[]', 'pending', new Date().toISOString());
    store.db.prepare("INSERT INTO batch_deliveries(batchId,baseUrl,spaceId,kind,status,connectionId) VALUES(?,?,?,?,?,?)")
        .run('batch', config.value.baseUrl, 'A', 'live', 'accepted', (store.binding(project.scopeId) as any).connectionId);
    const delivery = deliveries.accepted()[0]!;
    deliveries.update(delivery, { processingStatus: 'accumulating', openEpisodeMessages: 2, memoryIds: ['topic'] });
    const saved = deliveries.accepted()[0]!;
    assert.equal(saved.openEpisodeMessages, 2);
    assert.deepEqual(JSON.parse(saved.memoryIds), ['topic']);
    assert.equal(store.batches()[0]!.uploaded, true);
    assert.equal(store.batches()[0]!.processingStatus, 'accumulating');
});

test('explicitly rebinding after full unbind keeps old receipts and batch identity separate on the same URL', t => {
    const { config, store, project } = setup(t);
    const deliveries = new Deliveries(store), oldIdentity = store.binding(project.scopeId)!.connectionId;
    const session = store.registerSession({ agentType: 'codex-cli', nativeSessionId: 'receipt-session', cwd: '/demo' });
    store.db.prepare('INSERT INTO batches(id,sessionId,objectId,messages,status,createdAt) VALUES(?,?,?,?,?,?)')
        .run('old-batch', session.id, project.scopeId, '[]', 'completed', new Date().toISOString());
    store.db.prepare('INSERT INTO batch_deliveries(batchId,baseUrl,connectionId,spaceId,kind,status,taskId) VALUES(?,?,?,?,?,?,?)')
        .run('old-batch', config.value.baseUrl, oldIdentity, 'A', 'live', 'completed', 'old-task');
    store.creation.markBinding(project.scopeId, 'A', config.value.baseUrl);
    store.unbind(project.scopeId, 'A');
    Object.assign(config.value, { apiMode: 'algorithm', authMode: 'none', cloudProjectId: 'test1' });
    store.bind(project.scopeId, 'A', config.value.baseUrl, '', true);
    const nextIdentity = store.binding(project.scopeId)!.connectionId;
    assert.notEqual(nextIdentity, oldIdentity);
    assert.equal(store.row('SELECT connectionId FROM batches WHERE id=?', 'old-batch')!.connectionId, oldIdentity);
    assert.equal(store.row('SELECT connectionId FROM batch_deliveries WHERE batchId=?', 'old-batch')!.connectionId, oldIdentity);
    assert.equal(store.rows('SELECT * FROM create_space_boundaries').length, 2);
    const original = store.row('SELECT * FROM batch_deliveries WHERE batchId=?', 'old-batch');
    deliveries.queueLive();
    assert.deepEqual(store.row('SELECT * FROM batch_deliveries WHERE batchId=?', 'old-batch'), original);
});


test('legacy connection migration backs up data, assigns engineering identity and preserves accepted snapshots', t => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-legacy-cloud-'));
    const config = new Configuration(dir), path = join(dir, 'memory.sqlite');
    config.update({ baseUrl: 'http://localhost:9999/product', apiKey: 'fixture-key' });
    let store = new Store(path, config);
    const project = store.bindProject('demo', '/demo', 'A', config.value.baseUrl, 'codex-cli');
    const session = store.registerSession({ agentType: 'codex-cli', nativeSessionId: 'legacy', cwd: '/demo' });
    store.setSpaceDomains(config.value.baseUrl, 'A', ['原领域']);
    const deliveries = new Deliveries(store);
    store.db.prepare('INSERT INTO batches(id,sessionId,objectId,messages,status,uploaded,attempts,createdAt) VALUES(?,?,?,?,?,?,?,?)')
        .run('legacy-batch', session.id, project.scopeId, '[{"role":"user","content":"original"}]', 'completed', 1, 1, '2020-01-01T00:00:00Z');
    store.db.prepare('INSERT INTO batch_deliveries(batchId,baseUrl,connectionId,spaceId,kind,status,attempts,taskId) VALUES(?,?,?,?,?,?,?,?)')
        .run('legacy-batch', config.value.baseUrl, store.connectionId(), 'A', 'live', 'completed', 1, 'original-task');
    const before = store.row('SELECT messages,status,uploaded,attempts FROM batches WHERE id=?', 'legacy-batch');
    store.close();
    const db = new DatabaseSync(path);
    db.exec(`DROP TRIGGER batch_connection;
ALTER TABLE bindings DROP COLUMN connectionId;
ALTER TABLE batches DROP COLUMN connectionId;
CREATE TABLE domains_old(baseUrl TEXT NOT NULL,spaceId TEXT NOT NULL,domains TEXT NOT NULL,PRIMARY KEY(baseUrl,spaceId));
INSERT INTO domains_old SELECT baseUrl,spaceId,domains FROM space_domains;
DROP TABLE space_domains; ALTER TABLE domains_old RENAME TO space_domains;
DROP TABLE create_space_boundaries;
CREATE TABLE create_space_boundaries(scopeId TEXT NOT NULL,spaceId TEXT NOT NULL,baseUrl TEXT NOT NULL,startedAfter TEXT NOT NULL,PRIMARY KEY(scopeId,spaceId,baseUrl));
CREATE TABLE delivery_old(batchId TEXT NOT NULL REFERENCES batches(id),baseUrl TEXT NOT NULL,spaceId TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,taskId TEXT,processingStatus TEXT,error TEXT,PRIMARY KEY(batchId,baseUrl,spaceId));
INSERT INTO delivery_old SELECT batchId,baseUrl,spaceId,kind,status,attempts,taskId,processingStatus,error FROM batch_deliveries;
DROP TABLE batch_deliveries; ALTER TABLE delivery_old RENAME TO batch_deliveries;`);
    db.close();
    Object.assign(config.value, { apiMode: 'algorithm', authMode: 'none', cloudProjectId: 'test1' });
    store = new Store(path, config); new Deliveries(store);
    t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
    const legacyIdentity = JSON.stringify(['engineering', config.value.baseUrl, '']);
    assert.equal(store.binding(project.scopeId)!.connectionId, legacyIdentity);
    assert.equal(store.row('SELECT connectionId FROM batch_deliveries')!.connectionId, legacyIdentity);
    assert.equal(store.row('SELECT taskId FROM batch_deliveries')!.taskId, 'original-task');
    assert.deepEqual(store.row('SELECT messages,status,uploaded,attempts FROM batches WHERE id=?', 'legacy-batch'), before);
    assert.deepEqual(store.spaceDomains(config.value.baseUrl, 'A', legacyIdentity), ['原领域']);
    assert.equal(store.spaceDomains(config.value.baseUrl, 'A'), undefined);
    assert.ok(readdirSync(dir).some(name => name.includes('before-cloud-connections')));
    assert.ok(readdirSync(dir).some(name => name.includes('before-delivery-connections')));
});
