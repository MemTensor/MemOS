import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../src/storage/store.ts';
import { repairCodexHistory, runRepair } from '../../src/runtime/repair-codex.ts';

async function fixture(t: any) {
    const directory = await mkdtemp(join(tmpdir(), 'pm-codex-repair-'));
    const dataDir = join(directory, 'data'), sourceRoot = join(directory, 'sources'), project = join(directory, 'project');
    await Promise.all([mkdir(dataDir), mkdir(sourceRoot), mkdir(project)]);
    t.after(() => rm(directory, { recursive: true, force: true }));
    const store = new Store(join(dataDir, 'memory.sqlite'));
    store.bindProject('Fixture',project,'space','http://cloud','codex-cli');
    store.db.exec("UPDATE capture_windows SET startedAt='2025-01-01T00:00:00.000Z'");
    const session = store.registerSession({agentType:'codex-cli',nativeSessionId:'fixture-session',cwd:project});
    store.startTurn(session.id, 'transcript:old-input');
    store.capture(session.id, [{sourceId:'old-user',raw:{role:'user',content:'Task',timestamp:'2026-11-18T01:00:02.000Z'}}]);
    store.startTurn(session.id, 'native-turn');
    store.capture(session.id, [{sourceId:'old-answer',raw:{role:'assistant',content:'Answer',timestamp:'2026-11-18T01:00:05.000Z'}}]);
    store.finalizeTurn(session.id,'native-turn');
    const sent = store.batches()[0]!;
    store.updateBatch(sent.id,{attempts:1,uploaded:true,status:'accepted',taskId:'existing-cloud-task'});
    store.close();
    const row = (type: string, payload: object, ordinal: number) => ({type,payload,ordinal,timestamp:`2026-11-18T01:00:0${ordinal}.000Z`});
    const rows = [
        row('session_meta',{id:'fixture-session',cwd:project,source:'cli'},0),
        row('event_msg',{type:'task_started',turn_id:'native-turn',root_turn_id:'native-turn'},1),
        row('response_item',{type:'message',id:'user',role:'user',content:'Task'},2),
        row('response_item',{type:'function_call',id:'call-item',call_id:'call',name:'shell',arguments:'{"command":"pwd"}'},3),
        row('response_item',{type:'function_call_output',id:'result-item',call_id:'call',output:project},4),
        row('response_item',{type:'message',id:'answer',role:'assistant',content:'Answer',phase:'final_answer'},5),
        row('event_msg',{type:'task_complete',turn_id:'native-turn'},6),
    ];
    await writeFile(join(sourceRoot,'rollout-fixture.jsonl'),rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
    // This file must never be parsed by the repair path.
    await writeFile(join(dataDir,'config.json'),'not JSON; repair must not read credentials');
    return {dataDir,sourceRoot,sessionId:session.id,sent};
}
function databaseRows(path: string) {
    const db = new DatabaseSync(path,{readOnly:true});
    try { return Object.fromEntries(['sessions','turns','traces','batches'].map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])); }
    finally {db.close();}
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('Codex repair defaults to a consistent temporary dry-run without changing the original database', async t => {
    const {dataDir,sourceRoot}=await fixture(t),database=join(dataDir,'memory.sqlite');
    const original=hash(await readFile(database)),beforeRows=databaseRows(database);
    const originalFetch=globalThis.fetch;
    globalThis.fetch=async()=>{ throw new Error('repair must never use the network'); };
    t.after(()=>{globalThis.fetch=originalFetch;});
    const report=await runRepair(['--data-dir',dataDir,'--source-root',sourceRoot]);
    assert.equal(report.mode,'dry-run');
    assert.equal(report.before.rounds,2);
    assert.equal(report.after.rounds,1);
    assert.equal(report.after.events,4);
    assert.equal(report.backupPath,undefined);
    assert.equal(hash(await readFile(database)),original);
    assert.deepEqual(databaseRows(database),beforeRows);
    const names=await readdir(dataDir);
    assert.ok(!names.includes('repair.lock'));
    assert.ok(!names.some(name=>name.includes('before-codex-repair')));
});

test('Codex repair applies only with explicit opt-in, keeps a private backup and restores one complete round', async t => {
    const {dataDir,sourceRoot,sessionId,sent}=await fixture(t);
    const report=await repairCodexHistory({dataDir,sourceRoots:[sourceRoot],apply:true});
    assert.equal(report.mode,'apply');assert.ok(report.backupPath);
    assert.equal((await stat(report.backupPath)).mode & 0o777,0o600);
    const backup = new Store(report.backupPath);
    try { assert.equal(backup.sessionDetail(sessionId,1,10,'turn').total,2); } finally {backup.close();}
    const repaired=new Store(join(dataDir,'memory.sqlite'));
    try {
        const detail=repaired.sessionDetail(sessionId,1,10,'turn');
        assert.equal(detail.total,1);assert.equal(detail.traces.length,4);
        assert.deepEqual(detail.traces.map(trace=>(trace.message as any).role),['user','assistant','tool','assistant']);
        const preserved=repaired.batches().find(batch=>batch.id===sent.id)!;
        assert.deepEqual(preserved.messages,sent.messages);assert.equal(preserved.attempts,1);assert.equal(preserved.uploaded,true);
    } finally {repaired.close();}
    assert.ok(!(await readdir(dataDir)).includes('repair.lock'));
});

test('Codex repair refuses apply while the service owns a live lock and does not leave a repair lock', async t => {
    const {dataDir,sourceRoot}=await fixture(t);
    await writeFile(join(dataDir,'service.lock'),String(process.pid));
    const original=hash(await readFile(join(dataDir,'memory.sqlite')));
    await assert.rejects(repairCodexHistory({dataDir,sourceRoots:[sourceRoot],apply:true}),/服务.*运行/);
    assert.equal(hash(await readFile(join(dataDir,'memory.sqlite'))),original);
    assert.ok(!(await readdir(dataDir)).includes('repair.lock'));
});

test('Codex repair requires an explicit data directory and rejects unknown arguments', async () => {
    await assert.rejects(runRepair([]),/--data-dir/);
    await assert.rejects(runRepair(['--data-dir','/tmp','--unknown']),/参数/);
});

test('Codex repair respects another repair lock without deleting it or making a backup', async t => {
    const {dataDir,sourceRoot}=await fixture(t),lock=join(dataDir,'repair.lock');
    await writeFile(lock,String(process.pid));
    await assert.rejects(repairCodexHistory({dataDir,sourceRoots:[sourceRoot],apply:true}),/repair.lock/);
    assert.equal(await readFile(lock,'utf8'),String(process.pid));
    assert.ok(!(await readdir(dataDir)).some(name=>name.includes('before-codex-repair')));
});

test('failed replay keeps its backup, reports its location and releases only the owned repair lock', async t => {
    const {dataDir}=await fixture(t);
    await assert.rejects(repairCodexHistory({dataDir,sourceRoots:[join(dataDir,'config.json')],apply:true}),/备份保留于/);
    const names=await readdir(dataDir),backups=names.filter(name=>name.includes('before-codex-repair'));
    assert.equal(backups.length,1);assert.ok(!names.includes('repair.lock'));
    assert.equal(databaseRows(join(dataDir,backups[0]!)).turns.length,2);
});

test('repair preserves other agents and does not import unrelated sessions from a custom source root', async t => {
    const {dataDir,sourceRoot}=await fixture(t),database=join(dataDir,'memory.sqlite');
    const store=new Store(database);
    const other=store.registerSession({agentType:'claude-code',nativeSessionId:'other-agent',cwd:'/other'});
    store.startTurn(other.id,'other-turn');
    store.capture(other.id,[{sourceId:'other-input',raw:{role:'user',content:'Other task'}}]);
    store.finalizeTurn(other.id,'other-turn');
    const before=databaseRows(database);store.close();
    await writeFile(join(sourceRoot,'rollout-unrelated.jsonl'),JSON.stringify({type:'session_meta',payload:{id:'unrelated',cwd:'/unregistered-project',source:'cli'}})+'\n');
    await repairCodexHistory({dataDir,sourceRoots:[sourceRoot],apply:true});
    const after=databaseRows(database);
    assert.deepEqual(after.sessions.filter(row=>row.agentType==='claude-code'),before.sessions.filter(row=>row.agentType==='claude-code'));
    for(const table of ['turns','traces','batches'])assert.deepEqual(after[table].filter(row=>row.sessionId===other.id),before[table].filter(row=>row.sessionId===other.id));
    assert.ok(!after.sessions.some(row=>row.nativeSessionId==='unrelated'));
});

test('repair preview reports child executions without a confirmed parent round', async t => {
    const {dataDir,sourceRoot}=await fixture(t);
    const rows=[
        {type:'session_meta',payload:{id:'orphan-child',cwd:'/child-worktree',source:{subagent:{thread_spawn:{parent_thread_id:'fixture-session'}}}}},
        {type:'event_msg',payload:{type:'task_started',turn_id:'child-turn',root_turn_id:'missing-root'}},
        {type:'response_item',payload:{type:'message',id:'child-user',role:'user',content:'Delegation'}},
        {type:'event_msg',payload:{type:'task_complete',turn_id:'child-turn'}},
    ].map((row,index)=>({...row,timestamp:new Date(Date.UTC(2026,10,18,2,0,index)).toISOString()}));
    await writeFile(join(sourceRoot,'rollout-child.jsonl'),rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
    const report=await repairCodexHistory({dataDir,sourceRoots:[sourceRoot]});
    assert.equal(report.after.unresolved.executions,1);
    assert.equal(report.after.rounds,1);
});
