import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/storage/store.ts';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('project sessions share a space list; user turns and source records remain distinct', () => {
  const store = new Store(':memory:');
  try {
    const project = store.createProject('Example', '/work/app');
    const first = store.registerSession({ agentType: 'claude-code', nativeSessionId: 'same', cwd: '/work/app/src' });
    const other = store.registerSession({ agentType: 'codex', nativeSessionId: 'same', cwd: '/work/app' });
    assert.notEqual(first.id, other.id);
    assert.equal(first.objectId, project.id);
    assert.equal(other.objectId, project.id);
    store.bind(project.id, 'space_1', 'http://cloud');
    assert.deepEqual(store.binding(first.objectId)?.spaceIds, ['space_1']);
    store.bind(project.id, 'space_2', 'http://cloud');
    assert.deepEqual(store.binding(other.objectId)?.spaceIds, ['space_1', 'space_2']);
    const one = store.startTurn(first.id, 'native-user-1');
    assert.equal(store.startTurn(first.id, 'native-user-1').id, one.id);
    store.capture(first.id, [{ sourceId:'r1',raw:{text:'继续'},message:{role:'user',content:'继续'} }]);
    store.capture(first.id, [{ sourceId:'r1',raw:{text:'继续'},message:{role:'user',content:'继续'} }]);
    store.capture(first.id, [{ sourceId:'r2',raw:{text:'继续'},message:{role:'user',content:'继续'} }]);
    assert.equal(store.sessionDetail(first.id).total, 2);
    const two = store.startTurn(first.id, 'native-user-2');
    assert.notEqual(one.id,two.id);
    assert.equal(store.validContext(first.id,one.id),false);
    assert.equal(store.validContext(first.id,two.id),true);
    assert.equal(store.registerSession({ agentType:'claude-code',nativeSessionId:'same',cwd:'/different' }).id, first.id);
  } finally { store.close(); }
});

test('historical native turn records get their own mapping without replacing the active user turn',()=>{
 const store=new Store(':memory:');try{
  const session=store.registerSession({agentType:'test',nativeSessionId:'history',cwd:'/history'});
  const active=store.startTurn(session.id,'latest');
  store.capture(session.id,[{sourceId:'old-record',nativeTurnId:'earlier',raw:{role:'user',content:'before'}}]);
  const detail=store.sessionDetail(session.id);
  assert.ok(detail.traces[0]!.conversationId);
  assert.notEqual(detail.traces[0]!.conversationId,active.id);
  assert.equal(store.session(session.id)?.currentTurnId,active.id);
 }finally{store.close();}
});

test('task traces exclude runtime metadata and injected prompts, deduplicate native user IDs and recover nested replies', () => {
 const store=new Store(':memory:');
 try {
  const session=store.registerSession({agentType:'deepseek-harness',nativeSessionId:'dsh-task',cwd:'/task'});
  store.startTurn(session.id,'user-1');
  const user={id:'user-1',role:'user',source:{kind:'user'},content:[{type:'text',text:'检查项目'}]};
  const runtime=['permission/preset','sandbox/mode','approval/policy','agent/inbox/spliced','turn/start','step/start','request/header','request/context','session/title','session/title-llm-request','session-log-deepseek/delivery-accepted','step/end','turn/end'];
  const records=runtime.map((type,i)=>({sourceId:`event:${i}`,raw:{type,seq:i,data:{}}}));
  const messages=[user,...['runtime-context','memos-project-memory','skill-catalog','time-context'].map(kind=>({id:kind,role:'user',source:{kind},content:[{type:'text',text:'临时提示'}]}))];
  store.capture(session.id,[...records,{sourceId:'message:user-1',raw:user},...messages.map((data,i)=>({sourceId:`event:user:${i}`,raw:{type:'user/message',data}})),
   {sourceId:'event:system',raw:{type:'system/message',data:{message:{role:'system',content:'系统提示'}}}},
   {sourceId:'event:reply',raw:{type:'assistant/message',data:{message:{id:'answer-1',role:'assistant',content:'完成检查'}}},message:{role:'system',content:'旧版错误归类'}}]);
  const traces=store.sessionDetail(session.id).traces;
  assert.equal(traces.length,2);
  assert.deepEqual(traces.map(t=>(t.message as any).role),['user','assistant']);
  assert.equal((traces[1]!.message as any).content,'完成检查');
  assert.equal(store.batches().length,0);
  store.finalizeTurn(session.id);
  assert.deepEqual(store.batches().flatMap(b=>b.messages).map(m=>m.role),['user','assistant']);
 } finally {store.close();}
});

test('existing unsent traces are cleaned once with a recovery snapshot and rebuilt upload payloads', () => {
 const dir=mkdtempSync(join(tmpdir(),'memos-trace-migration-')),path=join(dir,'memory.sqlite');
 let store=new Store(path);
 try {
  const session=store.registerSession({agentType:'deepseek-harness',nativeSessionId:'legacy',cwd:'/legacy'});
  store.startTurn(session.id,'user-1');
  const user={id:'user-1',role:'user',source:{kind:'user'},content:'任务'};
  const rows=[
   {source:'event:0',raw:{type:'permission/preset',data:{}},message:{role:'system',content:'权限事件'}},
   {source:'message:user-1',raw:user,message:user},
   {source:'event:8',raw:{type:'user/message',data:user},message:user},
   {source:'event:20',raw:{type:'assistant/message',data:{message:{id:'answer-1',role:'assistant',content:'完成'}}},message:{role:'system',content:'旧版封装'}}
  ];
  rows.forEach((r,i)=>{
   store.db.prepare('INSERT INTO batches(id,sessionId,objectId,messages,status,createdAt) VALUES(?,?,?,?,?,?)').run(`b${i}`,session.id,session.objectId,JSON.stringify([r.message]),'pending','2026-11-18');
   store.db.prepare('INSERT INTO traces(sessionId,conversationId,sourceId,raw,message,batchId,createdAt) VALUES(?,?,?,?,?,?,?)').run(session.id,store.session(session.id)!.currentTurnId,r.source,JSON.stringify(r.raw),JSON.stringify(r.message),`b${i}`,'2026-11-18');
  });
  store.db.exec('PRAGMA user_version=0');
  store.close();store=new Store(path);
  assert.equal(store.sessionDetail(session.id).total,2);
  assert.equal(store.batches().length,0);
  store.finalizeTurn(session.id);
  assert.deepEqual(store.batches().flatMap(b=>b.messages).map(m=>m.role),['user','assistant']);
  assert.equal(store.batches().length,1);
  const backups=readdirSync(dir).filter(n=>n.includes('before-task-traces'));
  assert.equal(backups.length,1);
  store.close();store=new Store(path);
  assert.equal(store.sessionDetail(session.id).total,2);
  assert.deepEqual(readdirSync(dir).filter(n=>n.includes('before-task-traces')),backups);
 } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('turn pagination keeps a long round intact and isolates records without a turn', () => {
 const store = new Store(':memory:');
 try {
  const session = store.registerSession({agentType:'test',nativeSessionId:'round-pages',cwd:'/rounds'});
  store.capture(session.id,[{sourceId:'orphan',raw:{role:'assistant',content:'no turn'}}]);
  store.startTurn(session.id,'round-1');
  store.capture(session.id,Array.from({length:30},(_,i)=>({sourceId:`first-${i}`,raw:{role:i===0?'user':'assistant',content:`step ${i}`}})));
  store.startTurn(session.id,'round-2');
  store.capture(session.id,[{sourceId:'second',raw:{role:'user',content:'next task'}}]);
  const first = store.sessionDetail(session.id,1,1,'turn');
  assert.equal(first.total,3);
  assert.equal(first.traces.length,1);
  const second = store.sessionDetail(session.id,2,1,'turn');
  assert.equal(second.groups?.length,1);
  assert.equal(second.traces.length,30);
  assert.equal(new Set(second.traces.map(t=>t.conversationId)).size,1);
  assert.equal(store.sessionDetail(session.id,3,1,'turn').traces[0]?.sourceId,'second');
  assert.equal(store.sessionDetail(session.id).total,32);
  assert.equal(store.sessionDetail(session.id,4,1,'turn').traces.length,0);
 } finally {store.close();}
});

test('one completed trajectory creates one immutable upload task, never during capture', () => {
 const dir=mkdtempSync(join(tmpdir(),'memos-round-batch-')),path=join(dir,'memory.sqlite');
 let store=new Store(path);
 try {
  const session=store.registerSession({agentType:'test',nativeSessionId:'round',cwd:'/round'});
  const turn=store.startTurn(session.id,'u1');
  const messages=[{role:'user',content:'task'},{role:'assistant',content:'',tool_calls:[{id:'c1',function:{name:'shell',arguments:'pwd'}}]},{role:'tool',content:'/round',tool_call_id:'c1'},{role:'assistant',content:[{type:'reasoning',text:'thinking'},{type:'text',text:'answer'}]}];
  for(const [i,message] of messages.entries()) { store.capture(session.id,[{sourceId:`m${i}`,raw:message}]); assert.equal(store.batches().length,0); }
  store.finalizeTurn(session.id,'u1');
  const batch=store.batches()[0]!;
  assert.equal(store.batches().length,1);assert.equal(batch.conversationId,turn.id);assert.deepEqual(batch.messages,messages);
  store.finalizeTurn(session.id,'u1');assert.equal(store.batches().length,1);
  store.close();store=new Store(path);
  store.capture(session.id,[{sourceId:'m3',raw:messages[3]}]);store.finalizeTurn(session.id,'u1');
  assert.equal(store.batches()[0]!.id,batch.id);assert.deepEqual(store.batches()[0]!.messages,messages);
  store.startTurn(session.id,'u2');store.capture(session.id,[{sourceId:'next',raw:{role:'user',content:'next'}}]);
  assert.equal(store.batches().length,1);store.finalizeTurn(session.id,'u2');assert.equal(store.batches().length,2);
 } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('oversized completed trajectory is retained as one blocked upload task without splitting', () => {
 const store=new Store(':memory:');
 try {
  const session=store.registerSession({agentType:'test',nativeSessionId:'large',cwd:'/large'});store.startTurn(session.id,'u1');
  const messages=[{role:'user',content:'任务'.repeat(10000)},{role:'assistant',content:'完整回答'}];
  store.capture(session.id,messages.map((raw,i)=>({sourceId:String(i),raw})));assert.equal(store.batches().length,0);
  store.finalizeTurn(session.id);assert.equal(store.batches().length,1);assert.equal(store.batches()[0]!.status,'blocked');assert.deepEqual(store.batches()[0]!.messages,messages);
 } finally {store.close();}
});

test('migration preserves all legacy fragments when a round already has a send attempt', () => {
 const dir=mkdtempSync(join(tmpdir(),'memos-legacy-sent-')),path=join(dir,'memory.sqlite');let store=new Store(path);
 try {
  const session=store.registerSession({agentType:'test',nativeSessionId:'legacy-sent',cwd:'/legacy'});const turn=store.startTurn(session.id,'u1');
  for(let i=0;i<2;i++) {
   const message={role:i?'assistant':'user',content:String(i)};
   store.db.prepare('INSERT INTO batches(id,sessionId,objectId,messages,status,attempts,createdAt) VALUES(?,?,?,?,?,?,?)').run(`old${i}`,session.id,session.objectId,JSON.stringify([message]),'pending',i===0?1:0,'2026-11-18');
   store.db.prepare('INSERT INTO traces(sessionId,conversationId,sourceId,raw,message,batchId,createdAt) VALUES(?,?,?,?,?,?,?)').run(session.id,turn.id,`old${i}`,JSON.stringify(message),JSON.stringify(message),`old${i}`,'2026-11-18');
  }
  store.db.exec('PRAGMA user_version=1');store.close();store=new Store(path);
  assert.equal(store.batches().length,2);assert.equal(store.batches()[0]!.attempts,1);
  store.finalizeTurn(session.id);assert.equal(store.batches().length,2);
  assert.deepEqual(store.sessionDetail(session.id).traces.map(t=>t.batchId),['old0','old1']);
 } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});
