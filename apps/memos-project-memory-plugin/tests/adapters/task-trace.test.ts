import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTaskTrace } from '../../src/adapters/_shared/task-trace.ts';
import type { TraceInput } from '../../src/adapters/types.ts';
const normalize=(raw:unknown,message?:TraceInput['message'],sourceId='event:1')=>normalizeTaskTrace('deepseek-harness',{sourceId,raw,message});

test('DSH keeps real tasks once by native ID and rejects injected user contexts and runtime logs',()=>{
 const user={id:'u1',role:'user',source:{kind:'user'},content:[{type:'text',text:'same question'}]};
 const direct=normalize(user,undefined,'message:u1');
 const event=normalize({type:'user/message',seq:8,data:user});
 assert.equal(direct?.sourceId,event?.sourceId);assert.equal(event?.sourceId,'message:u1');
 assert.equal(normalize({...user,id:'u2'})?.sourceId,'message:u2');
 for(const kind of ['runtime-context','memos-project-memory','skill-catalog','time-context'])assert.equal(normalize({type:'user/message',data:{...user,source:{kind}}}),undefined);
 for(const type of ['permission/preset','sandbox/mode','approval/policy','turn/start','turn/end','step/start','step/end','request/header','request/context','session/title','session-log-deepseek/delivery-accepted'])assert.equal(normalize({type,data:{role:'user',content:'not a task'}}),undefined);
});
test('DSH repairs nested assistant messages even when historical message was mislabelled system',()=>{
 const content=[{type:'text',text:'complete answer'}];
 const fixed=normalize({type:'assistant/message',data:{message:{id:'a1',role:'assistant',source:{kind:'model'},content},usage:{total:30}}},{role:'system',content:'old event envelope'});
 assert.equal(fixed?.message?.role,'assistant');assert.deepEqual(fixed?.message?.content,content);assert.equal(fixed?.sourceId,'message:a1');
});
test('DSH tool call arguments and full tool result survive normalization',()=>{
 const call=normalize({type:'tool/call',seq:10,data:{turn:1,step:1,callId:'c1',name:'bash',arguments:{command:'pwd'}}});
 assert.deepEqual(call?.message?.tool_calls,[{id:'c1',type:'function',function:{name:'bash',arguments:'{"command":"pwd"}'}}]);
 const result=normalize({type:'tool/result',seq:11,data:{message:{id:'t1',role:'tool',source:{kind:'tool',callId:'c1'},toolCallId:'c1',content:[{type:'text',text:'/project\n'}],isError:false}}});
 assert.equal(result?.message?.tool_call_id,'c1');assert.deepEqual(result?.message?.content,[{type:'text',text:'/project\n'}]);
});
test('all hosts discard system, injected custom messages and unknown metadata',()=>{
 for(const agent of ['claude-code','codex-cli','pi','prime-agent','opencode-v1']){
  assert.equal(normalizeTaskTrace(agent,{sourceId:'s',raw:{type:'metadata'}}),undefined);
  assert.equal(normalizeTaskTrace(agent,{sourceId:'s',raw:{role:'system',content:'secret context'},message:{role:'system',content:'secret context'}}),undefined);
  assert.equal(normalizeTaskTrace(agent,{sourceId:'s',raw:{message:{role:'user',customType:'memos-project-memory',content:'ids'}}}),undefined);
 }
 assert.equal(normalizeTaskTrace('claude-code',{sourceId:'s',raw:{isMeta:true,message:{role:'user',content:'runtime'}}}),undefined);
});
test('Prime replay strips only the explicit MemOS injected block',()=>{
 const content='Actual task\n\n<memos-project-memory-context>\nprivate context\n</memos-project-memory-context>';
 const record=normalizeTaskTrace('prime-agent',{sourceId:'entry:1',raw:{id:'1',message:{role:'user',content}},message:{role:'user',content}});
 assert.equal(record?.message?.content,'Actual task');
 const ordinary='Explain memos-project-memory-context tags';
 assert.equal(normalizeTaskTrace('prime-agent',{sourceId:'entry:2',raw:{role:'user',content:ordinary}})?.message?.content,ordinary);
});
test('Pi and Prime tool events preserve call IDs, arguments and execution results',()=>{
 for(const agent of ['pi','prime-agent']){
  const start=normalizeTaskTrace(agent,{sourceId:'start',raw:{type:'tool_execution_start',toolCallId:'c1',toolName:'bash',args:{command:'pwd'}}});
  assert.equal(start?.message?.role,'assistant');assert.deepEqual(start?.message?.tool_calls,[{id:'c1',type:'function',function:{name:'bash',arguments:'{"command":"pwd"}'}}]);
  const end=normalizeTaskTrace(agent,{sourceId:'end',raw:{type:'tool_execution_end',toolCallId:'c1',toolName:'bash',args:{command:'pwd'},result:{content:[{type:'text',text:'/project'}]},isError:false}});
  assert.equal(end?.message?.role,'tool');assert.equal(end?.message?.tool_call_id,'c1');assert.deepEqual(end?.message?.content,[{type:'text',text:'/project'}]);assert.deepEqual(end?.message?.tool_input,{command:'pwd'});
 }
});
test('tool message content stays exact and empty assistant calls remain valid',()=>{
 const value={role:'tool',content:'exact\noutput',name:'bash',tool_input:{command:'pwd'},tool_call_id:'c1'};
 assert.deepEqual(normalizeTaskTrace('claude-code',{sourceId:'tool',raw:{},message:value})?.message,value);
 assert.ok(normalizeTaskTrace('codex-cli',{sourceId:'call',raw:{},message:{role:'assistant',content:'',tool_calls:[{id:'c1'}]}}));
});
