import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { PluginService } from '../../src/server/service.ts';
import { createMockServer, getMockState } from '../../dev/memos-mock/server.ts';

test('capture to HTTP upload and search use bound spaces without cloud session fields', async t => {
 const dir=mkdtempSync(join(tmpdir(),'memos-test-')),mock=createMockServer();mock.listen(0,'127.0.0.1');await once(mock,'listening');
 const addr=mock.address();assert.ok(addr&&typeof addr!=='string');
 const service=new PluginService(dir);t.after(async()=>{service.close();rmSync(dir,{recursive:true});await new Promise<void>(r=>mock.close(()=>r()));});
 service.configure({baseUrl:`http://127.0.0.1:${addr.port}/api/openmem/v1`,apiKey:'mock-key'});
 const inactive=await service.event({agentType:'claude-code',nativeSessionId:'n1',cwd:'/project',event:'turn-start',turnKey:'user1'});
 assert.equal(inactive.sessionId,'');assert.equal(service.store.state().sessions.length,0);
 assert.equal(getMockState(mock).requests.length,0);
 const space=await service.cloud.call<{space_id:string}>('create/space',{space_name:'Bound Space'});
 const project=service.store.bindProject('Demo','/project',space.space_id,service.config.value.baseUrl,'claude-code');
 const identity=await service.event({agentType:'claude-code',nativeSessionId:'n1',cwd:'/project',event:'turn-start',turnKey:'user1'});
 assert.ok(identity.conversationId);assert.match(identity.identifiers,/conversation-id/);
 await service.event({agentType:'claude-code',nativeSessionId:'n1',cwd:'/project',event:'trace-available',records:[{sourceId:'r1',raw:{timestamp:new Date().toISOString(),role:'user',content:'hello'},message:{role:'user',content:'hello'}}]});
 await service.sync();assert.equal(getMockState(mock).uploads.length,0);assert.equal(service.store.batches().length,0);
 await service.event({agentType:'claude-code',nativeSessionId:'n1',cwd:'/project',event:'turn-end',turnKey:'user1'});
 await service.sync();
 const batch=service.store.batches()[0]!;assert.equal(batch.uploaded,true);assert.equal(batch.processingStatus,'completed');
 assert.deepEqual(service.store.binding(project.scopeId)?.spaceIds,batch.spaceIds);
 const upload=getMockState(mock).uploads[0]!;assert.deepEqual(upload.allow_memory_view,['project']);assert.equal(upload.domains,undefined);assert.equal(upload.conversation_id,undefined);assert.equal(upload.session_id,undefined);
 const result=await service.search({sessionId:identity.sessionId,conversationId:identity.conversationId!,query:'接口'});
 assert.equal(result.status,'FOUND');assert.ok(!JSON.stringify(result).includes(batch.spaceIds![0]!));
 const next=await service.event({agentType:'claude-code',nativeSessionId:'n1',cwd:'/project',event:'turn-start',turnKey:'user2'});
 assert.notEqual(next.conversationId,identity.conversationId);
 assert.equal((await service.search({sessionId:identity.sessionId,conversationId:identity.conversationId!,query:'接口'})).status,'CONTEXT_MISSING');
 assert.equal((await service.search({sessionId:next.sessionId,conversationId:next.conversationId!,query:' '})).status,'INVALID_QUERY');
});

test('session lifecycle metadata never becomes task traces or upload messages',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'memos-empty-')),mock=createMockServer();mock.listen(0,'127.0.0.1');await once(mock,'listening');
 const addr=mock.address();assert.ok(addr&&typeof addr!=='string');
 const service=new PluginService(dir);t.after(async()=>{service.close();rmSync(dir,{recursive:true});await new Promise<void>(r=>mock.close(()=>r()));});
 service.configure({baseUrl:`http://127.0.0.1:${addr.port}/api/openmem/v1`,apiKey:'mock-key'});
 const input={agentType:'claude-code',nativeSessionId:'empty',cwd:'/empty'};
 await service.event({...input,event:'session-start',records:[{sourceId:'lifecycle',raw:{timestamp:new Date().toISOString(),event:'SessionStart'}}]});
 await service.event({...input,event:'trace-available',title:'Unused title',titleRevision:1});
 await service.event({...input,event:'session-end'});
 await service.sync();assert.equal(getMockState(mock).requests.length,0);assert.equal(service.store.batches().length,0);
 for(const table of ['sessions','tasks','turns','traces','recalls'])assert.equal(service.store.rows(`SELECT * FROM ${table}`).length,0);
 assert.equal(service.store.state().sessions.length,0);
 const space=await service.cloud.call<{space_id:string}>('create/space',{space_name:'Empty'});
 service.store.bindProject('Empty','/empty',space.space_id,service.config.value.baseUrl,input.agentType);
 await assert.rejects(service.event({...input,event:'turn-start',turnKey:'   '}),/用户轮边界/);
 await service.event({...input,event:'turn-start',turnKey:'first-input',records:[{sourceId:'input',raw:{timestamp:new Date().toISOString(),role:'user',content:'hello'}}]});
 await service.sync();assert.equal(getMockState(mock).uploads.length,0);
 await service.event({...input,event:'turn-end',turnKey:'first-input'});
 await service.sync();assert.equal(getMockState(mock).spaces.size,1);assert.equal(getMockState(mock).uploads.length,1);
});

test('HTTP upload contains only the user task, tool execution and assistant reply', async t => {
 const dir=mkdtempSync(join(tmpdir(),'memos-task-only-')),mock=createMockServer();mock.listen(0,'127.0.0.1');await once(mock,'listening');
 const addr=mock.address();assert.ok(addr&&typeof addr!=='string');
 const service=new PluginService(dir);t.after(async()=>{service.close();rmSync(dir,{recursive:true});await new Promise<void>(r=>mock.close(()=>r()));});
 service.configure({baseUrl:`http://127.0.0.1:${addr.port}/api/openmem/v1`,apiKey:'mock-key'});
 const space=await service.cloud.call<{space_id:string}>('create/space',{space_name:'Task'});
 service.store.bindProject('Task','/project',space.space_id,service.config.value.baseUrl,'test');
 const records=[
  {sourceId:'runtime',raw:{timestamp:new Date().toISOString(),type:'session-log-deepseek/delivery-accepted',data:{throughSeq:10}}},
  {sourceId:'system',raw:{timestamp:new Date().toISOString(),role:'system',content:'临时系统提示'}},
  {sourceId:'injected',raw:{timestamp:new Date().toISOString(),role:'user',source:{kind:'memos-project-memory'},content:'自动注入'}},
  {sourceId:'user',raw:{timestamp:new Date().toISOString(),role:'user',content:'检查工作目录'}},
  {sourceId:'call',raw:{timestamp:new Date().toISOString(),role:'assistant',content:'',tool_calls:[{id:'tool1',type:'function',function:{name:'bash',arguments:'{"command":"pwd"}'}}]}},
  {sourceId:'result',raw:{timestamp:new Date().toISOString(),role:'tool',tool_call_id:'tool1',content:'/project'}},
  {sourceId:'answer',raw:{timestamp:new Date().toISOString(),role:'assistant',content:'当前目录是 /project'}}
 ];
 const result=await service.event({agentType:'test',nativeSessionId:'task-only',cwd:'/project',event:'turn-start',turnKey:'u1',records});
 await service.sync();assert.equal(getMockState(mock).uploads.length,0);
 await service.event({agentType:'test',nativeSessionId:'task-only',cwd:'/project',event:'turn-end',turnKey:'u1'});
 await service.sync();
 assert.equal(getMockState(mock).uploads.length,1);
 const messages=getMockState(mock).uploads.flatMap(u=>u.messages as any[]);
 assert.deepEqual(messages.map(m=>m.role),['user','assistant','tool','assistant']);
 assert.equal(messages[1].tool_calls[0].function.arguments,'{"command":"pwd"}');
 assert.equal(messages[2].content,'/project');
 assert.doesNotMatch(JSON.stringify(messages),/自动注入|临时系统提示|delivery-accepted/);
 assert.equal(service.store.sessionDetail(result.sessionId).total,4);
});

test('child session transcript uploads even when no child prompt hook was observed',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'memos-child-')),mock=createMockServer();mock.listen(0,'127.0.0.1');await once(mock,'listening');
 const addr=mock.address();assert.ok(addr&&typeof addr!=='string');
 const service=new PluginService(dir);t.after(async()=>{service.close();rmSync(dir,{recursive:true});await new Promise<void>(r=>mock.close(()=>r()));});
 service.configure({baseUrl:`http://127.0.0.1:${addr.port}/api/openmem/v1`,apiKey:'mock-key'});
 const space=await service.cloud.call<{space_id:string}>('create/space',{space_name:'Child'});
 service.store.bindProject('Child','/child',space.space_id,service.config.value.baseUrl,'claude-code');
 const child=await service.event({agentType:'claude-code',nativeSessionId:'child',parentNativeSessionId:'parent',cwd:'/child',event:'session-end',records:[{sourceId:'child-user',raw:{timestamp:new Date().toISOString(),role:'user',content:'delegated'},message:{role:'user',content:'delegated'}},{sourceId:'child-answer',raw:{timestamp:new Date().toISOString(),role:'assistant',content:'done'},message:{role:'assistant',content:'done'}}]});
 assert.equal(child.conversationId,null);await service.sync();assert.equal(getMockState(mock).uploads.length,1);assert.equal(service.store.batches()[0]!.uploaded,true);
});

test('a completed round uploads once after split captures; repeated or late completion cannot finish another round', async t => {
 const dir=mkdtempSync(join(tmpdir(),'memos-complete-')),mock=createMockServer();mock.listen(0,'127.0.0.1');await once(mock,'listening');
 const addr=mock.address();assert.ok(addr&&typeof addr!=='string');
 const service=new PluginService(dir);t.after(async()=>{service.close();rmSync(dir,{recursive:true});await new Promise<void>(r=>mock.close(()=>r()));});
 service.configure({baseUrl:`http://127.0.0.1:${addr.port}/api/openmem/v1`,apiKey:'mock-key'});
 const input={agentType:'test',nativeSessionId:'round-upload',cwd:'/project'};
 const space=await service.cloud.call<{space_id:string}>('create/space',{space_name:'Rounds'});
 service.store.bindProject('Rounds','/project',space.space_id,service.config.value.baseUrl,input.agentType);
 const first=await service.event({...input,event:'turn-start',turnKey:'u1',records:[{sourceId:'user1',raw:{timestamp:new Date().toISOString(),role:'user',content:'task1'}}]});
 await service.event({...input,event:'trace-available',turnKey:'u1',records:[{sourceId:'answer1',raw:{timestamp:new Date().toISOString(),role:'assistant',content:'answer1'}}]});
 await service.sync();assert.equal(service.store.batches().length,0);assert.equal(getMockState(mock).uploads.length,0);
 const second=await service.event({...input,event:'turn-start',turnKey:'u2',records:[{sourceId:'user2',raw:{timestamp:new Date().toISOString(),role:'user',content:'task2'}}]});
 await service.event({...input,event:'turn-end',turnKey:'u1'});
 await service.event({...input,event:'turn-end',turnKey:'u1'});
 assert.equal(service.store.batches().length,1);assert.equal(service.store.batches()[0]!.conversationId,first.conversationId);
 assert.equal(service.store.row('SELECT completedAt FROM turns WHERE id=?',second.conversationId!)?.completedAt,null);
 await service.sync();assert.equal(getMockState(mock).uploads.length,1);
 assert.deepEqual((getMockState(mock).uploads[0]!.messages as any[]).map(m=>m.content),['task1','answer1']);
 await service.event({...input,event:'turn-end',turnKey:'u1'});await service.sync();assert.equal(getMockState(mock).uploads.length,1);
 await service.event({...input,event:'turn-end',turnKey:'u2',records:[{sourceId:'answer2',raw:{timestamp:new Date().toISOString(),role:'assistant',content:'answer2'}}]});await service.sync();
 assert.equal(getMockState(mock).uploads.length,2);
 assert.deepEqual((getMockState(mock).uploads[1]!.messages as any[]).map(m=>m.content),['task2','answer2']);
});
