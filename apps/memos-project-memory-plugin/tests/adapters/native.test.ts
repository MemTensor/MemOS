import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHooks } from '../../src/adapters/opencode-v1/extension/index.ts';
import piExtension from '../../src/adapters/pi/extension/index.ts';
import { PrimeController } from '../../src/adapters/prime-agent/rpc/index.ts';
import type { AgentEvent, EventResult } from '../../src/adapters/types.ts';
const response = (e: AgentEvent): EventResult => ({ overviewDelivered:false, sessionId: `local-${e.nativeSessionId}`, conversationId: e.turnKey ?? null, identifiers: `session=${e.nativeSessionId};turn=${e.turnKey}`, overview: 'overview', context: `session=${e.nativeSessionId};turn=${e.turnKey}` });
test('OpenCode user message IDs establish turns; tool continuation keeps identity and request view retains context', async () => {
 const events: AgentEvent[] = [];
 const hooks = await createHooks({ directory: '/project' }, async e => { events.push(e); return response(e); });
 await hooks['chat.message']({sessionID:'s'}, {message:{id:'u1',role:'user'},parts:[{type:'text',text:'hello'}]});
 const a={system:[] as string[]}; await hooks['experimental.chat.system.transform']({sessionID:'s'},a);
 const b={system:[] as string[]}; await hooks['experimental.chat.system.transform']({sessionID:'s'},b);
 assert.deepEqual(a,b); assert.match(a.system.join(''),/u1/);
 await hooks['tool.execute.after']({sessionID:'s',callID:'tool1',tool:'bash',args:{command:'pwd'}},{output:'/project'});
 assert.equal(events.at(-1)?.turnKey,'u1');
 await hooks['chat.message']({sessionID:'s'}, {message:{id:'u2',role:'user'},parts:[]});
 assert.deepEqual(events.filter(e=>e.event==='turn-start').map(e=>e.turnKey),['u1','u2']);
});
test('Pi uses input boundary, persists context message, captures tools without new turns',async()=>{
 const callbacks=new Map<string,(event:any,ctx:any)=>Promise<any>>(); const events:AgentEvent[]=[];
 piExtension({on:(name,fn)=>{callbacks.set(name,fn);}},async e=>{events.push(e);return response(e);});
 const ctx={cwd:'/p',sessionManager:{getSessionId:()=> 'pi1',getEntries:()=>[]}};
 await callbacks.get('input')!({text:'hello',source:'interactive'},ctx);
 const first=await callbacks.get('before_agent_start')!({messageType:'user',prompt:'hello'},ctx);
 assert.match(first.message.content,/session=pi1/);
 await callbacks.get('tool_execution_end')!({toolCallId:'t1',result:'ok'},ctx);
 assert.equal(events.filter(e=>e.event==='turn-start').length,1);
 await callbacks.get('input')!({text:'hello',source:'interactive'},ctx);
 await callbacks.get('before_agent_start')!({messageType:'user',prompt:'hello'},ctx);
 const ids=events.filter(e=>e.event==='turn-start').map(e=>e.turnKey);assert.notEqual(ids[0],ids[1]);
});
test('Prime prepares IDs before controlled prompt; model turn_start never allocates user turn',async()=>{
 const events:AgentEvent[]=[];const calls:Record<string,unknown>[]=[];
 const rpc={request:async(type:string,payload:Record<string,unknown>={})=>{calls.push({type,...payload});return type==='get_state'?{sessionId:'persistent',activeSessionId:'runtime'}:{};}};
 const controller=new PrimeController(rpc,'/p',async e=>{events.push(e);return response(e);});
 await controller.initialize();await controller.submit('hello','input-1');
 assert.match(String(calls.at(-1)?.message),/input-1/);
 await controller.handleEvent({type:'turn_start'});await controller.handleEvent({type:'tool_execution_end',toolCallId:'t1',result:{content:'ok'}});
 assert.equal(events.filter(e=>e.event==='turn-start').length,1);
 assert.ok(events.every(e=>e.nativeSessionId==='persistent'));
 assert.equal(events.at(-1)?.turnKey,'input-1');
});

test('OpenCode v2 registers actual promise hooks, consumes event iterator and disposes registrations',async()=>{
 const {createPlugin}=await import('../../src/adapters/opencode-v2/extension/index.ts');
 const hooks=new Map<string,(input:any)=>Promise<void>|void>();let disposed=0;
 const events:AgentEvent[]=[];
 const plugin=createPlugin(async e=>{events.push(e);return response(e);});
 const cleanup=await plugin.setup({location:{directory:'/p'},session:{hook:async(name,fn)=>{hooks.set(name,fn);return {dispose:async()=>{disposed++;}};}},event:{subscribe:async function*(){yield {id:'event-1',type:'session.message.updated',data:{sessionID:'v2',message:{role:'assistant',content:'answer'}}};}}});
 await hooks.get('prompt')!({sessionID:'v2',messageID:'u1',prompt:[{type:'text',text:'hello'}]});
 const request={sessionID:'v2',system:[] as unknown[]};await hooks.get('context')!(request);
 assert.deepEqual(request.system,[{type:'text',text:'overview\n\nsession=v2;turn=u1'}]);
 await cleanup();assert.equal(disposed,2);assert.ok(events.some(e=>e.records?.[0]?.sourceId==='event-1'));
});
test('Cline core session and run identity remain distinct from transcript identity',async()=>{
 const {createPlugin}=await import('../../src/adapters/cline-cli/extension/index.ts');
 const events:AgentEvent[]=[];const plugin=createPlugin(async e=>{events.push(e);return response(e);});
 plugin.setup({}, {session:{sessionId:'core-1'},workspaceInfo:{rootPath:'/project'}});
 const snapshot={agentId:'agent-1',conversationId:'transcript-1',runId:'run-1',messages:[]};
 const context=await plugin.hooks.beforeRun({snapshot});assert.match(context.appendContext,/turn=run-1/);
 await plugin.hooks.afterTool({snapshot,toolCall:{toolCallId:'t1'},result:{content:'ok'}});
 assert.equal(events.at(-1)?.nativeSessionId,'core-1');assert.equal(events.at(-1)?.turnKey,'run-1');
 await plugin.hooks.beforeRun({snapshot:{...snapshot,runId:'run-2'}});
 assert.equal(events.at(-1)?.turnKey,'run-2');
});
test('DeepSeek pre-step awaits local identity and does not reinject persisted context on tool continuation',async()=>{
 const {apply}=await import('../../src/adapters/deepseek-harness/extension/index.ts');
 const callbacks=new Map<string,(...args:any[])=>unknown>();const events:AgentEvent[]=[];
 let context: any;
 apply({on:(name,fn)=>{callbacks.set(name,fn);return ()=>{};},systemPrompt:{context:provider=>{context=provider;return ()=>{};}},effect:setup=>setup()},{},async e=>{events.push(e);return response(e);});
 const session={id:'dsh-1',header:{cwd:'/p'}};const user={id:'user-1',role:'user',source:{kind:'user'},content:[{type:'text',text:'hi'}]};
 const agent={session};
 const result=await callbacks.get('agent/pre-step')!({agent,messages:[user],turn:1,step:1},async()=>({kind:'enter',messages:[user]})) as any;
 assert.equal(result.messages.length,2);assert.match(result.messages[1].content[0].text,/overview/);
 assert.match(context.text({agent}),/user-1/);
 callbacks.get('session/event')!(session,{seq:0,type:'user/message',data:result.messages[1]});await callbacks.get('session/flush')!(session);
 const second=await callbacks.get('agent/pre-step')!({agent,messages:[],turn:1,step:2},async()=>({kind:'enter',messages:[]})) as any;
 assert.equal(second.messages.length,0);
 callbacks.get('session/event')!(session,{seq:1,type:'tool/result',data:{role:'tool',content:'output'}});
 await callbacks.get('session/flush')!(session);
 assert.equal(events.at(-1)?.turnKey,'user-1');assert.equal(events.at(-1)?.records?.[0]?.sourceId,'event:1');
});
test('Kilo exports documented server plugin module',async()=>{
 const {default:plugin}=await import('../../src/adapters/kilo-cli/extension/index.ts');
 assert.equal(plugin.id,'memos-project-memory');assert.equal(typeof plugin.server,'function');
});
test('history hosts acknowledge overview delivery and update IDs without repeating overview',async()=>{
 let delivered=false;const submitted:string[]=[];
 const send=Object.assign(async(e:AgentEvent)=>({...response(e),overviewDelivered:delivered,context:`OVERVIEW\n${e.turnKey}`,identifiers:`IDS ${e.turnKey}`}),{delivered:async()=>{delivered=true;}});
 const controller=new PrimeController({request:async(type,payload)=>{if(type==='get_state')return {sessionId:'s'};submitted.push(String(payload?.message));return {};}},'/p',send);
 await controller.submit('one','u1');await controller.handleEvent({type:'agent_end'});await controller.submit('two','u2');
 assert.match(submitted[0]!,/OVERVIEW/);assert.doesNotMatch(submitted[1]!,/OVERVIEW/);assert.match(submitted[1]!,/IDS u2/);
});
test('Prime stdio transport uses real JSONL subprocess request/response correlation',async()=>{
 const {PrimeStdio}=await import('../../src/adapters/prime-agent/rpc/index.ts');
 const code=`const r=require('node:readline').createInterface({input:process.stdin});r.on('line',line=>{const m=JSON.parse(line);console.log(JSON.stringify({id:m.id,type:'response',command:m.type,success:true,data:{sessionId:'persistent',request:m}}));});`;
 const rpc=new PrimeStdio(process.cwd(),process.execPath,['-e',code]);
 try{const state=await rpc.request('get_state');assert.equal(state.sessionId,'persistent');assert.equal(state.request.type,'get_state');assert.equal(state.request.jsonrpc,undefined);}finally{await rpc.close();}
});

test('DSH completion follows all captured records and carries the native user turn',async()=>{
 const {apply}=await import('../../src/adapters/deepseek-harness/extension/index.ts');
 const callbacks=new Map<string,(...args:any[])=>unknown>(); const events:AgentEvent[]=[];
 apply({on:(name,fn)=>{callbacks.set(name,fn);return ()=>{};},systemPrompt:{context:()=>()=>{}},effect:setup=>setup()},{},async e=>{await new Promise(r=>setTimeout(r,1));events.push(e);return response(e);});
 const session={id:'dsh-end',header:{cwd:'/p'}},user={id:'u1',role:'user',source:{kind:'user'},content:'task'};
 await callbacks.get('agent/pre-step')!({agent:{session},messages:[user]},async()=>({kind:'enter',messages:[user]}));
 callbacks.get('session/event')!(session,{seq:1,type:'assistant/message',data:{message:{id:'a1',role:'assistant',content:'done'}}});
 callbacks.get('session/event')!(session,{seq:2,type:'step/end',data:{}});
 callbacks.get('session/event')!(session,{seq:3,type:'turn/end',data:{}});
 await callbacks.get('session/flush')!(session);
 assert.deepEqual(events.map(e=>e.event),['turn-start','trace-available','turn-end']);
 assert.equal(events.at(-1)?.turnKey,'u1');
 assert.equal(events.at(-2)?.records?.[0]?.sourceId,'message:a1');
});

test('Pi settles only after replay while Prime and Cline end their completed user run',async()=>{
 const callbacks=new Map<string,(event:any,ctx:any)=>Promise<any>>(),events:AgentEvent[]=[];
 const send=async(e:AgentEvent)=>{events.push(e);return response(e);};
 piExtension({on:(name,fn)=>{callbacks.set(name,fn);}},send);
 const ctx={cwd:'/p',sessionManager:{getSessionId:()=> 'pi-end',getEntries:()=>[{id:'a1',message:{role:'assistant',content:'done'}}]}};
 await callbacks.get('input')!({source:'interactive'},ctx);await callbacks.get('before_agent_start')!({prompt:'task'},ctx);
 assert.equal(callbacks.has('agent_end'),false);
 await callbacks.get('agent_settled')!({},ctx);
 assert.equal(events.at(-1)?.event,'turn-end');
 assert.ok(events.slice(0,-1).some(e=>e.records?.[0]?.sourceId==='entry:a1'));
 const prime=new PrimeController({request:async type=>type==='get_state'?{sessionId:'prime-end'}:{}},'/p',send);
 await prime.submit('task','prime-user');await prime.handleEvent({type:'turn_end'});
 assert.equal(events.at(-1)?.event,'trace-available');
 await prime.handleEvent({type:'agent_end'});assert.equal(events.at(-1)?.event,'turn-end');assert.equal(events.at(-1)?.turnKey,'prime-user');
 const {createPlugin}=await import('../../src/adapters/cline-cli/extension/index.ts');const cline=createPlugin(send);
 cline.setup({}, {session:{sessionId:'cline-end'},cwd:'/p'});const snapshot={agentId:'a',runId:'run1'};
 await cline.hooks.beforeRun({snapshot});await cline.hooks.afterRun({snapshot,result:{messages:[{id:'answer',role:'assistant',content:'done'}]}});
 assert.equal(events.at(-1)?.event,'turn-end');assert.equal(events.at(-1)?.turnKey,'run1');assert.equal(events.at(-2)?.records?.[0]?.sourceId,'message:answer');
});

test('OpenCode idle finalizes after transcript replay',async()=>{
 const events:AgentEvent[]=[];
 const hooks=await createHooks({directory:'/p',client:{session:{messages:async()=>({data:[{info:{id:'answer',role:'assistant'},parts:[{type:'text',text:'done'}]}]})}}},async e=>{events.push(e);return response(e);});
 await hooks['chat.message']({sessionID:'open-end'},{message:{id:'u1',role:'user'},parts:[]});
 await hooks.event({event:{type:'session.idle',properties:{sessionID:'open-end'}}});
 assert.equal(events.at(-1)?.event,'turn-end');assert.equal(events.at(-1)?.turnKey,'u1');assert.equal(events.at(-2)?.records?.[0]?.sourceId,'message:answer');
});

test('Bridge serializes captures before completion even for fire-and-forget host observers',async()=>{
 const {Bridge}=await import('../../src/adapters/opencode-v1/extension/bridge.ts');
 const events:AgentEvent[]=[];let release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const bridge=new Bridge('test','/p',async e=>{if(e.event==='trace-available')await gate;events.push(e);return response(e);});
 await bridge.turn('session','u1');
 const capture=bridge.trace('session',{role:'assistant',content:'done'},'answer');
 const finish=bridge.dispatch('session','turn-end');
 await Promise.resolve();assert.equal(events.length,1);
 release();await Promise.all([capture,finish]);
 assert.deepEqual(events.map(e=>e.event),['turn-start','trace-available','turn-end']);
 assert.equal(events.at(-1)?.turnKey,'u1');
});

test('OpenCode v2 finalizes execution terminal events but not resumable shutdown interruption',async()=>{
 const {createPlugin}=await import('../../src/adapters/opencode-v2/extension/index.ts');
 const hooks=new Map<string,(input:any)=>Promise<void>|void>(),events:AgentEvent[]=[];
 let start!:()=>void;const gate=new Promise<void>(resolve=>{start=resolve;});
 const plugin=createPlugin(async e=>{events.push(e);return response(e);});
 const cleanup=await plugin.setup({location:{directory:'/p'},session:{hook:async(name,fn)=>{hooks.set(name,fn);return {dispose:async()=>{}};}},event:{subscribe:async function*(){
  await gate;
  yield {id:'shutdown',type:'session.execution.interrupted',data:{sessionID:'v2-end',reason:'shutdown'}};
  yield {id:'answer',type:'session.message.updated',data:{sessionID:'v2-end',message:{role:'assistant',content:'done'}}};
  yield {id:'finished',type:'session.execution.succeeded',data:{sessionID:'v2-end'}};
 }}});
 await hooks.get('prompt')!({sessionID:'v2-end',messageID:'u1',prompt:'task'});start();await cleanup();
 assert.equal(events.filter(e=>e.event==='turn-end').length,1);
 assert.equal(events.at(-1)?.event,'turn-end');assert.equal(events.at(-1)?.turnKey,'u1');
 assert.ok(events.findIndex(e=>e.records?.[0]?.sourceId==='answer')<events.findIndex(e=>e.event==='turn-end'));
});

test('Pi persists only durable final entries once across stream callbacks and multiple rounds',async()=>{
 const callbacks=new Map<string,(event:any,ctx:any)=>Promise<any>>(),events:AgentEvent[]=[],entries:any[]=[];
 piExtension({on:(name,fn)=>{callbacks.set(name,fn);}},async e=>{events.push(e);return response(e);});
 const ctx={cwd:'/p',sessionManager:{getSessionId:()=> 'pi-durable',getEntries:()=>entries}};
 await callbacks.get('input')!({source:'interactive'},ctx);await callbacks.get('before_agent_start')!({prompt:'same'},ctx);
 const firstKey=events[0]!.turnKey;
 assert.equal(callbacks.has('message_start'),false);assert.equal(callbacks.has('message_update'),false);
 await callbacks.get('message_end')!({message:{role:'user',content:'same'}},ctx);
 entries.push({id:'u1',type:'message',message:{role:'user',content:'same'}});
 await callbacks.get('message_end')!({message:{role:'assistant',content:'done'}},ctx);
 entries.push({id:'a1',type:'message',message:{role:'assistant',content:'done'}});
 await callbacks.get('agent_settled')!({},ctx);
 await callbacks.get('input')!({source:'interactive'},ctx);await callbacks.get('before_agent_start')!({prompt:'same'},ctx);
 const secondKey=events.filter(e=>e.event==='turn-start').at(-1)!.turnKey;
 entries.push({id:'u2',type:'message',message:{role:'user',content:'same'}},{id:'a2',type:'message',message:{role:'assistant',content:'done again'}});
 await callbacks.get('agent_settled')!({},ctx);
 const records=events.flatMap(e=>e.records??[]);
 assert.deepEqual(records.map(r=>r.sourceId),['entry:u1','entry:a1','entry:u2','entry:a2']);
 assert.deepEqual(records.map(r=>r.nativeTurnId),[firstKey,firstKey,secondKey,secondKey]);
 assert.equal(events.filter(e=>e.event==='turn-end').length,2);
});

test('Prime durable replay replaces streaming snapshots and synthetic prompt duplicates',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=await mkdtemp(join(tmpdir(),'pm-prime-final-')),file=join(dir,'session.jsonl'),events:AgentEvent[]=[];
 const rows:any[]=[];const save=()=>writeFile(file,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
 try{
  await save();
  const controller=new PrimeController({request:async type=>type==='get_state'?{sessionId:'prime-durable',sessionFile:file}:{}},'/p',async e=>{events.push(e);return response(e);});
  await controller.submit('same','round1');
  rows.push({id:'u1',message:{role:'user',content:'same'}});await save();
  await controller.handleEvent({type:'message_start',message:{role:'assistant',content:'partial'}});
  await controller.handleEvent({type:'message_update',message:{role:'assistant',content:'partial reply'}});
  await controller.handleEvent({type:'message_end',message:{role:'user',content:'same'}});
  rows.push({id:'a1',message:{role:'assistant',content:'done'}});await save();
  await controller.handleEvent({type:'message_end',message:{role:'assistant',content:'done'}});await controller.handleEvent({type:'agent_end'});
  await controller.submit('same','round2');rows.push({id:'u2',message:{role:'user',content:'same'}},{id:'a2',message:{role:'assistant',content:'done again'}});await save();
  await controller.handleEvent({type:'agent_end'});
  const records=events.flatMap(e=>e.records??[]).filter(r=>r.message);
  assert.deepEqual(records.map(r=>r.sourceId),['entry:u1','entry:a1','entry:u2','entry:a2']);
  assert.deepEqual(records.map(r=>r.nativeTurnId),['round1','round1','round2','round2']);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('OpenCode replay completion keeps its original turn even if a new prompt arrives during replay',async()=>{
 const events:AgentEvent[]=[];let release!:(value:any)=>void,started!:()=>void;
 const startedReplay=new Promise<void>(resolve=>{started=resolve;});
 const responseRows=new Promise<any>(resolve=>{release=resolve;});
 const hooks=await createHooks({directory:'/p',client:{session:{messages:async()=>{started();return responseRows;}}}},async e=>{events.push(e);return response(e);});
 await hooks['chat.message']({sessionID:'s'},{message:{id:'u1',role:'user'},parts:[]});
 const completing=hooks.event({event:{type:'session.idle',properties:{sessionID:'s'}}});
 await startedReplay;
 await hooks['chat.message']({sessionID:'s'},{message:{id:'u2',role:'user'},parts:[]});
 release({data:[{info:{id:'a1',role:'assistant'},parts:[{type:'text',text:'first answer'}]}]});await completing;
 assert.equal(events.at(-1)?.event,'turn-end');assert.equal(events.at(-1)?.turnKey,'u1');
 assert.equal(events.at(-2)?.records?.[0]?.nativeTurnId,'u1');
});

test('Prime without a session file retains stable tool calls and results without streaming snapshots',async()=>{
 const events:AgentEvent[]=[];
 const controller=new PrimeController({request:async type=>type==='get_state'?{sessionId:'prime-nofile'}:{}},'/p',async e=>{events.push(e);return response(e);});
 await controller.submit('inspect','u1');
 await controller.handleEvent({type:'message_start',message:{role:'assistant',content:'partial'}});
 await controller.handleEvent({type:'message_update',message:{role:'assistant',content:'partial reply'}});
 await controller.handleEvent({type:'tool_execution_start',toolCallId:'call1',toolName:'shell',args:{command:'pwd'}});
 await controller.handleEvent({type:'tool_execution_end',toolCallId:'call1',toolName:'shell',args:{command:'pwd'},result:{content:[{type:'text',text:'/project'}]},isError:false});
 await controller.handleEvent({type:'agent_end'});
 const records=events.flatMap(e=>e.records??[]),tools=records.filter(r=>r.sourceId.startsWith('tool:'));
 assert.deepEqual(tools.map(r=>r.sourceId),['tool:call1:tool_execution_start','tool:call1:tool_execution_end']);
 assert.equal((tools[0]?.message?.tool_calls?.[0] as any)?.function.name,'shell');
 assert.equal((tools[0]?.message?.tool_calls?.[0] as any)?.function.arguments,'{"command":"pwd"}');
 assert.equal(tools[1]?.message?.tool_call_id,'call1');
 assert.deepEqual(tools[1]?.message?.content,[{type:'text',text:'/project'}]);
 assert.ok(tools.every(r=>r.nativeTurnId==='u1'));
 assert.ok(!records.some(r=>JSON.stringify(r.message??null).includes('partial')));
 assert.equal(events.at(-1)?.event,'turn-end');
});
