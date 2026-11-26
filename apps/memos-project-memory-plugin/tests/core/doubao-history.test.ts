import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installAdapter, uninstallAdapter } from '../../src/adapters/installer.ts';
import { doubaoSessionsPath } from '../../src/adapters/doubao-work/capture.ts';
import { HistoryService } from '../../src/server/history.ts';
import { Store } from '../../src/storage/store.ts';
import { ack, lifecycle, logName, metadata } from '../helpers/doubao-log.ts';

async function fixture(t: TestContext) {
    const home = await mkdtemp(join(tmpdir(), 'memos-doubao-history-'));
    const store = new Store(':memory:'), history = new HistoryService(store, {home});
    t.after(async () => { history.close(); store.close(); await rm(home, {recursive:true, force:true}); });
    const root = join(home, 'explicit'), started = Date.now()-5000, ended = started+1500;
    const dir = join(home, 'Library/Application Support/DoubaoWork/sdk_storage/log');
    await mkdir(dir, {recursive:true});
    const path = join(dir, logName(ended));
    async function session(sid: string, cwd: string, q: string, a: string, complete = true) {
        const system = join(doubaoSessionsPath(home),sid,'agents','m_test','system');
        await mkdir(system, {recursive:true});
        await writeFile(join(system,'assignment.md'), '# Assignment\n- Role: main\n\n## ['+new Date(started).toISOString()+'] 需求\nrequest '+q+'\n');
        const journal = join(system,'trajectory.jsonl');
        await writeFile(journal, JSON.stringify({role:'assistant',content:'final '+a})+'\n');
        await appendFile(path,ack(sid,q,1)+metadata(sid,cwd,a,started)+lifecycle(sid,q,a)+(complete ? lifecycle(sid,q,a,true,{},ended) : ''));
        return journal;
    }
    const journal = await session('100',root,'201','301');
    await session('101', join(root,'nested'), '202','302');
    await session('102', root, '203','303', false);
    const {scopeId} = store.bindProject('explicit',root,'test-space','http://localhost','doubao-work');
    return {home, store, root, path, journal, ended, started, history, scopeId};
}

test('explicit history import requires the installed adapter, exact project and a verified terminal signal', async t => {
    const {home,store,history,scopeId,ended} = await fixture(t);
    await history.scan(scopeId); assert.equal(history.status(scopeId).status,'failed');
    await installAdapter('doubao-work',{home});
    await history.scan(scopeId);
    assert.equal(history.status(scopeId).status,'ready');
    assert.deepEqual(history.catalog(scopeId),[
        {nativeSessionId:'100',sourceId:'doubao:201:0'}, {nativeSessionId:'100',sourceId:'doubao:201:1'}
    ]);
    assert.equal(store.row('SELECT COUNT(*) n FROM traces')?.n,0);
    await history.materialize(scopeId);
    await history.materialize(scopeId);
    assert.equal(store.row('SELECT COUNT(*) n FROM traces')?.n,2);
    assert.equal(store.row('SELECT completedAt FROM turns')?.completedAt,new Date(ended).toISOString());
    assert.equal(store.batches().length,0);
    await uninstallAdapter('doubao-work',{home});
    await assert.rejects(history.materialize(scopeId), /尚未安装/);
});

test('history import rejects changed bodies with stable native IDs or changed project membership', async t => {
    const {home,store,history,scopeId,journal,path,started} = await fixture(t);
    await installAdapter('doubao-work',{home}); await history.scan(scopeId);
    await writeFile(journal,JSON.stringify({role:'assistant',content:'replaced'})+'\n');
    await assert.rejects(history.materialize(scopeId), /轨迹已变化/);
    await history.scan(scopeId);
    await writeFile(journal,'');
    await assert.rejects(history.materialize(scopeId), /轨迹已变化/);
    await appendFile(path,metadata('100','/other','301',started));
    await assert.rejects(history.materialize(scopeId), /归属或源身份已变化/);
    assert.equal(store.row('SELECT COUNT(*) n FROM sessions')?.n,0);
});

test('a known session assigned to another project cannot be materialized into it', async t => {
    const {home,store,history,scopeId} = await fixture(t);
    await installAdapter('doubao-work',{home}); await history.scan(scopeId);
    store.registerSession({agentType:'doubao-work',nativeSessionId:'100',cwd:'/other'});
    await assert.rejects(history.materialize(scopeId), /归属或源身份已变化/);
    await history.scan(scopeId); assert.deepEqual(history.catalog(scopeId), []);
    assert.equal(store.row('SELECT COUNT(*) n FROM traces')?.n,0);
});

test('existing records with the same native ID and different content abort the full import', async t => {
    const {home,store,root,history,scopeId} = await fixture(t);
    await installAdapter('doubao-work',{home}); await history.scan(scopeId);
    const session = store.registerSession({agentType:'doubao-work',nativeSessionId:'100',cwd:root});
    const turn = store.startTurn(session.id,'201',false);
    store.db.prepare('INSERT INTO traces(sessionId,conversationId,sourceId,raw,message,createdAt) VALUES(?,?,?,?,?,?)')
        .run(session.id,turn.id,'doubao:201:1','{}',JSON.stringify({role:'assistant',content:'other content'}),new Date().toISOString());
    await assert.rejects(history.materialize(scopeId), /冲突/);
    assert.equal(store.row('SELECT COUNT(*) n FROM traces')?.n,1);
    assert.equal(store.row('SELECT completedAt FROM turns')?.completedAt,null);
});
