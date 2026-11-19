import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bridge, type Send } from '../../src/adapters/opencode-v1/extension/bridge.ts';
import { processHook } from '../../src/adapters/_shared/hooks.ts';
import { createHooks } from '../../src/adapters/opencode-v1/extension/index.ts';
import piExtension from '../../src/adapters/pi/extension/index.ts';
import { PrimeController } from '../../src/adapters/prime-agent/rpc/index.ts';
import { apply } from '../../src/adapters/deepseek-harness/extension/index.ts';
import type { AgentEvent, EventResult } from '../../src/adapters/types.ts';

function transport() {
 const events: AgentEvent[] = [], probes: unknown[][] = [], deliveries: string[] = [];
 let active = false;
 const send: Send = Object.assign(async(event:AgentEvent):Promise<EventResult> => {
  events.push(event);
  return {sessionId:'local',conversationId:event.turnKey??null,context:'overview and IDs',overview:'overview',identifiers:'current IDs'};
 }, {activation:async(...args:unknown[])=>{probes.push(args);return active;},delivered:async(id:string)=>{deliveries.push(id);}});
 return {send,events,probes,deliveries,setActive:(value:boolean)=>{active=value;}};
}

test('Bridge gates each dispatch and delivery, discards cached identifiers after unbinding',async()=>{
 const t=transport(),bridge=new Bridge('pi','/project',t.send);
 assert.equal((await bridge.turn('native','u1')).sessionId,'');
 assert.equal(t.events.length,0);
 t.setActive(true);await bridge.turn('native','u2');assert.equal(bridge.context('native'),'overview\n\ncurrent IDs');
 t.setActive(false);await bridge.trace('native',{secret:'not sent'});await bridge.delivered('native');
 assert.equal(t.events.length,1);assert.equal(t.deliveries.length,0);assert.equal(bridge.context('native'),'');assert.equal(bridge.turns.size,0);
 t.setActive(true);await bridge.turn('native','u3');await bridge.delivered('native');
 assert.equal(t.events.at(-1)?.turnKey,'u3');assert.deepEqual(t.deliveries,['local']);
 assert.deepEqual(t.probes[0],['pi','/project','native']);
});

test('unbound hook returns before opening a transcript or emitting context',async()=>{
 const t=transport();let emitted=false;
 // A directory would fail readFile with EISDIR if transcript normalization ran.
 const result=await processHook('claude-code',{session_id:'native',cwd:'/project',hook_event_name:'UserPromptSubmit',transcript_path:process.cwd()},
  {request:t.send,emit:()=>{emitted=true;},markDelivered:async()=>{throw new Error('unexpected delivery');}});
 assert.equal(result,'');assert.equal(emitted,false);assert.equal(t.events.length,0);
});

test('child transcript requires its own activation and passes parent identity',async()=>{
 const t=transport();t.setActive(true);const calls:unknown[][]=[];
 t.send.activation=async(...args)=>{calls.push(args);return args[2]==='parent';};
 await processHook('claude-code',{session_id:'parent',cwd:'/project',hook_event_name:'SubagentStop',agent_id:'child',agent_transcript_path:process.cwd()},{request:t.send});
 assert.equal(t.events.length,1);assert.deepEqual(calls.at(-1),['claude-code','/project','child','parent']);
});

test('OpenCode stops replay and drops request context after unbinding',async()=>{
 const t=transport();let historyReads=0;
 const hooks=await createHooks({directory:'/project',client:{session:{messages:async()=>{historyReads++;return {data:[]};}}}},t.send);
 await hooks.event({event:{type:'session.idle',properties:{sessionID:'native'}}});
 assert.equal(historyReads,0);assert.equal(t.events.length,0);
 t.setActive(true);await hooks['chat.message']({sessionID:'native'},{message:{id:'u1',role:'user'},parts:[]});
 t.setActive(false);const output={system:[] as string[]};await hooks['experimental.chat.system.transform']({sessionID:'native'},output);
 assert.deepEqual(output.system,[]);
});

test('Pi does not read session entries or emit an empty custom message while unbound',async()=>{
 const t=transport(),callbacks=new Map<string,(event:any,ctx:any)=>Promise<any>>();
 piExtension({on:(name,fn)=>{callbacks.set(name,fn);}},t.send);
 const ctx={cwd:'/project',sessionManager:{getSessionId:()=> 'native',getEntries:()=>{throw new Error('unexpected history read');}}};
 await callbacks.get('input')!({source:'interactive'},ctx);
 assert.equal(await callbacks.get('before_agent_start')!({},ctx),undefined);
 await callbacks.get('agent_settled')!({},ctx);
 assert.equal(t.events.length,0);assert.equal(t.deliveries.length,0);
});

test('Prime leaves prompts untouched and avoids reading an unbound session file',async()=>{
 const t=transport(),prompts:string[]=[];
 const controller=new PrimeController({request:async(type,payload)=>{
  if(type==='get_state')return {sessionId:'native',sessionFile:process.cwd()};
  prompts.push(payload?.message);return {};
 }},'/project',t.send);
 await controller.submit('original prompt','u1');await controller.handleEvent({type:'agent_end'});
 assert.deepEqual(prompts,['original prompt']);assert.equal(t.events.length,0);assert.equal(t.deliveries.length,0);assert.equal(controller.busy,false);
});

test('DSH treats unbound sessions as inactive and clears context without warning',async()=>{
 const t=transport(),callbacks=new Map<string,(...args:any[])=>any>(),warnings:string[]=[];let context:any;
 apply({on:(name,fn)=>{callbacks.set(name,fn);return ()=>{};},effect:fn=>fn(),systemPrompt:{context:value=>{context=value;return ()=>{};}},logger:{warn:message=>{warnings.push(message);}}},{},t.send);
 const session={id:'native',header:{cwd:'/project'}},agent={session},user={id:'u1',role:'user',source:{kind:'user'},content:'hello'};
 const step=()=>callbacks.get('agent/pre-step')!({agent,messages:[user]},async()=>({kind:'enter',messages:[user]}));
 assert.equal((await step()).messages.length,1);assert.equal(context.text({agent}),'');assert.equal(t.events.length,0);
 t.setActive(true);assert.equal((await step()).messages.length,2);assert.match(context.text({agent}),/session-id: local/);
 t.setActive(false);assert.equal((await step()).messages.length,1);assert.equal(context.text({agent}),'');
 assert.deepEqual(warnings,[]);assert.equal(t.deliveries.length,0);
});

test('OpenCode v2 refreshes activation before injecting cached request context',async()=>{
 const {createPlugin}=await import('../../src/adapters/opencode-v2/extension/index.ts');
 const t=transport(),hooks=new Map<string,(input:any)=>Promise<void>|void>();
 const cleanup=await createPlugin(t.send).setup({location:{directory:'/project'},session:{hook:async(name,fn)=>{hooks.set(name,fn);return {dispose:async()=>{}};}},event:{subscribe:async function*(){}}});
 t.setActive(true);await hooks.get('prompt')!({sessionID:'native',messageID:'u1',prompt:'hello'});
 t.setActive(false);const request={sessionID:'native',system:[]};await hooks.get('context')!(request);
 assert.deepEqual(request.system,[]);await cleanup();
});

test('Cline skips supplied history and model context when the project is unbound',async()=>{
 const {createPlugin}=await import('../../src/adapters/cline-cli/extension/index.ts');
 const t=transport(),plugin=createPlugin(t.send);
 plugin.setup({}, {session:{sessionId:'native'},cwd:'/project'});
 const snapshot={agentId:'agent',runId:'u1',get messages(){throw new Error('unexpected history access');}};
 assert.deepEqual(await plugin.hooks.beforeRun({snapshot}),{});
 await plugin.hooks.afterRun({snapshot,get result(){throw new Error('unexpected result access');}});
 assert.equal(t.events.length,0);assert.equal(t.deliveries.length,0);
});

test('live hook receipt gets an occurrence time while timestamp-less replay remains undated',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const directory=await mkdtemp(join(tmpdir(),'memos-live-time-')),path=join(directory,'history.jsonl'),t=transport();t.setActive(true);
 try {
  await writeFile(path,JSON.stringify({id:'old',message:{role:'user',content:'old history'}})+'\n');
  const before=Date.now();
  await processHook('claude-code',{session_id:'native',cwd:'/project',hook_event_name:'UserPromptSubmit',prompt:'new input',transcript_path:path},{request:t.send});
  const records=t.events[0].records!;
  assert.equal((records[0].raw as any).occurredAt,undefined);
  assert.ok(Date.parse((records.at(-1)!.raw as any).occurredAt)>=before);
 } finally {await rm(directory,{recursive:true,force:true});}
});

test('native live messages retain source timestamps and replay never receives a current timestamp',async()=>{
 const t=transport();t.setActive(true);
 const originalTime='2024-01-01T00:00:00.000Z';
 const hooks=await createHooks({directory:'/project',client:{session:{messages:async()=>({data:[{info:{id:'old',role:'assistant'},parts:[{type:'text',text:'old'}]}]})}}},t.send);
 await hooks['chat.message']({sessionID:'native'},{message:{id:'u1',role:'user',timestamp:originalTime},parts:[]});
 await hooks['tool.execute.after']({sessionID:'native',callID:'tool',tool:'shell',args:{}},{output:'new output'});
 await hooks.event({event:{type:'session.idle',properties:{sessionID:'native'}}});
 const records=t.events.flatMap(event=>event.records??[]);
 const input=records.find(record=>record.sourceId==='message:u1')!;
 assert.equal((input.raw as any).occurredAt,undefined);assert.equal((input.raw as any).message.timestamp,originalTime);
 assert.ok(Number.isFinite(Date.parse((records.find(record=>record.sourceId==='tool:tool')!.raw as any).occurredAt)));
 assert.equal((records.find(record=>record.sourceId==='message:old')!.raw as any).occurredAt,undefined);
});
