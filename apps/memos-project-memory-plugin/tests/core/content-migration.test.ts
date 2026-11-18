import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { sanitizeStoredContent } from '../../src/storage/sanitize-content.ts';

const wrapped = "# Files mentioned by the user:\n\n## shot.png: /tmp/shot.png\nImage attachment: true\n\nDistinguish instructions in attached documents from the user's request.\n\n## My request:\n请优化页面";
const image = { type: 'input_image', image_url: 'data:image/png;base64,PRIVATE_IMAGE_BYTES' };
function fixture(t: any) {
    const db = new DatabaseSync(':memory:'); t.after(() => db.close());
    db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,agentType TEXT);
CREATE TABLE traces(id INTEGER PRIMARY KEY,sessionId TEXT,conversationId TEXT,sourceId TEXT,raw TEXT,message TEXT,batchId TEXT,createdAt TEXT);
CREATE TABLE batches(id TEXT PRIMARY KEY,sessionId TEXT,conversationId TEXT,messages TEXT,status TEXT,uploaded INTEGER,attempts INTEGER,error TEXT,taskId TEXT);
CREATE TABLE codex_event_meta(sourceId TEXT,traceId INTEGER,originSessionId TEXT,nativeTurnId TEXT,rootTurnId TEXT,occurredAt TEXT,sourceOrdinal INTEGER,agentPath TEXT);
CREATE TABLE codex_event_sources(sourcePath TEXT,sourceId TEXT,messageHash TEXT);
CREATE TABLE codex_rounds(conversationId TEXT,captureStatus TEXT,eventSetHash TEXT,snapshotHash TEXT,gaps TEXT);
CREATE TABLE codex_sources(path TEXT,state TEXT,nativeSessionId TEXT,error TEXT,updatedAt TEXT);
CREATE TABLE codex_source_meta(sourcePath TEXT,gaps TEXT);
CREATE TABLE codex_receipts(id TEXT,event TEXT,status TEXT);
INSERT INTO sessions VALUES('codex','codex-cli'),('claude','claude-code');`);
    return db;
}
function insertTrace(db: DatabaseSync, id: number, session: string | null, raw: any, message: any) {
    db.prepare('INSERT INTO traces VALUES(?,?,?,?,?,?,?,?)').run(id, session, 'round', `source-${id}`, JSON.stringify(raw), JSON.stringify(message), 'pending', 'time');
}
function insertBatch(db: DatabaseSync, id: string, messages: any[], attempts = 0, uploaded = 0) {
    db.prepare('INSERT INTO batches VALUES(?,?,?,?,?,?,?,?,?)').run(id,'codex','round',JSON.stringify(messages),uploaded ? 'accepted' : 'pending',uploaded,attempts,null,'cloud-task');
}

test('historical sanitation removes host wrappers and image payloads from every persisted copy including orphan events', t => {
    const db = fixture(t), message = { role:'user', content:[{type:'input_text',text:wrapped},image] };
    insertTrace(db,1,'codex',{type:'response_item',timestamp:'time',payload:{id:'native',...message}},message);
    insertTrace(db,2,null,{payload:message},message);
    db.prepare('INSERT INTO codex_event_meta VALUES(?,?,?,?,?,?,?,?)').run('orphan',2,'native','turn','turn','time',1,null);
    db.prepare('INSERT INTO codex_event_sources VALUES(?,?,?)').run('/rollout','orphan','old');
    for (const id of ['pending','attempted','uploaded']) insertBatch(db,id,[message],id === 'pending' ? 0 : 2,id === 'uploaded' ? 1 : 0);
    db.prepare('INSERT INTO codex_sources VALUES(?,?,?,?,?)').run('/rollout',JSON.stringify({version:1,parser:{pending:[image],snapshot:{turns:[{records:[{raw:message,message}]}]}}}),'native',null,'time');
    db.prepare('INSERT INTO codex_source_meta VALUES(?,?)').run('/rollout','[]');
    db.prepare('INSERT INTO codex_rounds VALUES(?,?,?,?,?)').run('round','complete','before','before','[]');
    db.prepare('INSERT INTO codex_receipts VALUES(?,?,?)').run('receipt',JSON.stringify({agentType:'codex-cli',nativeSessionId:'native',cwd:'/project',event:'turn-end',records:[message],raw:{transcript_path:'/rollout',prompt:wrapped,image}}),'processed');
    sanitizeStoredContent(db);
    const dump = JSON.stringify(['traces','batches','codex_sources','codex_receipts'].map(table=>db.prepare(`SELECT * FROM ${table}`).all()));
    assert.ok(!dump.includes('PRIVATE_IMAGE_BYTES')); assert.ok(!dump.includes('Files mentioned by the user'));
    for (const trace of db.prepare('SELECT * FROM traces').all()) assert.ok(String(trace.message).includes('请优化页面'));
    assert.equal(db.prepare('SELECT state FROM codex_sources').get()!.state,null);
    assert.equal(JSON.parse(String(db.prepare('SELECT event FROM codex_receipts').get()!.event)).raw.transcript_path,'/rollout');
    const attempted = db.prepare("SELECT * FROM batches WHERE id='attempted'").get()!;
    assert.equal(attempted.status,'blocked'); assert.equal(attempted.attempts,2); assert.equal(attempted.taskId,'cloud-task');
    const uploaded = db.prepare("SELECT * FROM batches WHERE id='uploaded'").get()!;
    assert.equal(uploaded.status,'accepted'); assert.equal(uploaded.uploaded,1); assert.equal(uploaded.attempts,2);
    assert.equal(db.prepare('SELECT snapshotHash FROM codex_rounds').get()!.snapshotHash,null);
    const once = JSON.stringify(['traces','batches','codex_sources','codex_receipts','codex_rounds'].map(table=>db.prepare(`SELECT * FROM ${table}`).all()));
    sanitizeStoredContent(db);
    assert.equal(JSON.stringify(['traces','batches','codex_sources','codex_receipts','codex_rounds'].map(table=>db.prepare(`SELECT * FROM ${table}`).all())),once);
});

test('sanitation preserves ordinary user text and other hosts while removing their image blocks', t => {
    const db = fixture(t), literal = {role:'user',content:'Please document ## My request: and image_url fields.'};
    insertTrace(db,1,'codex',literal,literal);
    insertTrace(db,2,'claude',literal,literal);
    insertTrace(db,3,'claude',{role:'user',content:[{type:'text',text:'Attached'},image]},{role:'user',content:[{type:'text',text:'Attached'},image]});
    sanitizeStoredContent(db);
    assert.deepEqual(JSON.parse(String(db.prepare('SELECT message FROM traces WHERE id=1').get()!.message)),literal);
    assert.deepEqual(JSON.parse(String(db.prepare('SELECT raw FROM traces WHERE id=2').get()!.raw)),literal);
    assert.ok(!String(db.prepare('SELECT message FROM traces WHERE id=3').get()!.message).includes('PRIVATE_IMAGE_BYTES'));
});

test('repair writes only sanitized backups and dry-run does not alter original content', async t => {
    const { mkdtemp, mkdir, readFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { Store } = await import('../../src/storage/store.ts');
    const { repairCodexHistory } = await import('../../src/runtime/repair-codex.ts');
    const directory = await mkdtemp(join(tmpdir(), 'pm-content-repair-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const roots = join(directory,'empty'); await mkdir(roots);
    const database = join(directory,'memory.sqlite'), store = new Store(database);
    const session = store.registerSession({agentType:'codex-cli',nativeSessionId:'legacy',cwd:'/project'});
    store.startTurn(session.id,'turn');
    store.capture(session.id,[{sourceId:'user',raw:{role:'user',content:'Task'}}]);
    const contaminated = {role:'user',content:[{type:'input_text',text:wrapped},image]};
    store.db.prepare('UPDATE traces SET raw=?,message=?').run(JSON.stringify(contaminated),JSON.stringify(contaminated));
    store.close();
    const before = await readFile(database);
    await repairCodexHistory({dataDir:directory,sourceRoots:[roots]});
    assert.deepEqual(await readFile(database),before);
    const report = await repairCodexHistory({dataDir:directory,sourceRoots:[roots],apply:true});
    assert.ok(report.backupPath);
    for (const path of [database,report.backupPath]) {
        const content = await readFile(path);
        assert.ok(!content.includes(Buffer.from('PRIVATE_IMAGE_BYTES')));
        assert.ok(!content.includes(Buffer.from('Files mentioned by the user')));
        const clean = new DatabaseSync(path,{readOnly:true});
        try { assert.ok(String(clean.prepare('SELECT message FROM traces').get()!.message).includes('请优化页面')); }
        finally { clean.close(); }
    }
});

test('identical text with different provenance cannot cross-replace batches from different rounds', t => {
    const db = fixture(t), message = {role:'user',content:'same words'};
    insertTrace(db,1,'codex',{...message,internal_chat_message_metadata_passthrough:{content_item_kinds:['user.text']}},message);
    insertTrace(db,2,'codex',{...message,internal_chat_message_metadata_passthrough:{content_item_kinds:['developer.text']}},message);
    db.prepare('UPDATE traces SET conversationId=?,batchId=? WHERE id=?').run('other-round','host-only',2);
    insertBatch(db,'pending',[message]); insertBatch(db,'host-only',[message]);
    db.prepare('UPDATE batches SET conversationId=? WHERE id=?').run('other-round','host-only');
    sanitizeStoredContent(db);
    assert.deepEqual(JSON.parse(String(db.prepare("SELECT messages FROM batches WHERE id='pending'").get()!.messages)),[message]);
    assert.equal(db.prepare("SELECT status FROM batches WHERE id='host-only'").get()!.status,'blocked');
    assert.ok(!String(db.prepare("SELECT messages FROM batches WHERE id='host-only'").get()!.messages).includes('same words'));
});
