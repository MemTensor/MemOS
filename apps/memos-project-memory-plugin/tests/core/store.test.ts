import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/storage/store.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('one completed trajectory creates one immutable upload task, never during capture', () => {
 const dir=mkdtempSync(join(tmpdir(),'memos-round-batch-')),path=join(dir,'memory.sqlite');
 let store=new Store(path);
 try {
  const session=store.registerSession({agentType:'test',nativeSessionId:'round',cwd:'/round'});
  const turn=store.startTurn(session.id,'u1');
  const messages=[{role:'user',content:'task'},{role:'assistant',content:'',tool_calls:[{id:'c1',type:'function',function:{name:'shell',arguments:'pwd'}}]},{role:'tool',content:'/round',tool_call_id:'c1'},{role:'assistant',content:[{type:'reasoning',text:'thinking'},{type:'text',text:'answer'}]}];
  for(const [i,message] of messages.entries()) { store.capture(session.id,[{sourceId:`m${i}`,raw:message}]); assert.equal(store.batches().length,0); }
  store.finalizeTurn(session.id,'u1');
  const batch=store.batches()[0]!;
 const expected=[...messages.slice(0,3),{role:'assistant',content:'thinking\nanswer'}].map((message,index)=>({...message,id:batch.messages[index]!.id}));
  assert.ok(expected.every(message=>typeof message.id==='string' && message.id.startsWith('memos:')));
  assert.equal(store.batches().length,1);assert.equal(batch.conversationId,turn.id);assert.deepEqual(batch.messages,expected);
  store.finalizeTurn(session.id,'u1');assert.equal(store.batches().length,1);
  store.close();store=new Store(path);
  store.capture(session.id,[{sourceId:'m3',raw:messages[3]}]);store.finalizeTurn(session.id,'u1');
  assert.equal(store.batches()[0]!.id,batch.id);assert.deepEqual(store.batches()[0]!.messages,expected);
  store.startTurn(session.id,'u2');store.capture(session.id,[{sourceId:'next',raw:{role:'user',content:'next'}}]);
  assert.equal(store.batches().length,1);store.finalizeTurn(session.id,'u2');assert.equal(store.batches().length,2);
 } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});
