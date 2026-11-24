import { observed, object } from '../../_shared/transcript.ts';
import type { AgentEvent, TraceInput } from '../../types.ts';
import { filterPrimeSkills } from '../skill-filter.ts';
import { readFile } from 'node:fs/promises';
import { executionMessage } from '../../_shared/task-trace.ts';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { Bridge, message, sendEvent, type Data, type Send } from '../../opencode-v1/extension/bridge.ts';
export interface RPC {request(type:string,payload?:Data):Promise<Data>}
/** One controller owns one stdio session. All user prompts must pass submit(). */
export class PrimeController {
 readonly rpc:RPC; readonly bridge:Bridge; sessionId=''; sessionFile:string|undefined; busy=false; private readonly seenEntries=new Set<string>();
 private skillCalls:TraceInput[]=[];
 constructor(rpc:RPC,cwd:string,send:Send=sendEvent){
  this.rpc=rpc;
  const transport=Object.assign(async(event:AgentEvent)=>{
   const records=filterPrimeSkills([...this.skillCalls,...event.records??[]]);
   const projected=records.slice(this.skillCalls.length);
   // Only already projected invocation metadata survives between RPC events.
   this.skillCalls=[...new Map(records.filter(record=>record.message?.tool_calls?.some(call=>object(object(call).function).name==='skill')
    ||Array.isArray(record.message?.content)&&record.message.content.some(part=>object(part).name==='skill'&&typeof object(object(part).arguments).skill_name==='string'))
    .map(record=>[`${record.nativeTurnId??''}\0${record.sourceId}`,record])).values()];
   const result=await send({...event,...(event.records?{records:projected}:{})});
   if(event.event==='turn-end'||event.event==='session-end')this.skillCalls=[];
   return result;
  },{activation:send.activation,delivered:send.delivered,createContext:send.createContext});
  this.bridge=new Bridge('prime-agent',cwd,transport);
 }
 async initialize(){const state=await this.rpc.request('get_state');if(typeof state.sessionId!=='string')throw new Error('Prime get_state missing persistent sessionId');this.sessionId=state.sessionId;this.sessionFile=typeof state.sessionFile==='string'?state.sessionFile:undefined;await this.bridge.start(this.sessionId);await this.replay();return state;}
 async submit(text:string,inputId:string=randomUUID(),images?:unknown[]) {
  if(this.busy)throw new Error('Prime is processing an input; wait for agent_end before submitting another');
  if(!this.sessionId)await this.initialize();this.busy=true;
  try {
   await this.bridge.turn(this.sessionId,inputId,this.sessionFile?[]:[{sourceId:`input:${inputId}`,raw:observed({text,images}),message:{role:'user',content:text}}]);
   const context=this.bridge.historyContext(this.sessionId);
   const submitted=context?`${text}\n\n<memos-project-memory-context>\n${context}\n</memos-project-memory-context>`:text;
   await this.bridge.trace(this.sessionId,{original:text,injected:context,submitted},`submission:${inputId}`);
   const accepted=await this.rpc.request('prompt',{message:submitted,...(images?{images}:{})});await this.bridge.delivered(this.sessionId);return accepted;
  }catch(error){this.busy=false;throw error;}
 }
 async replay(key=this.bridge.turns.get(this.sessionId)){
  if(!this.sessionFile||!await this.bridge.active(this.sessionId))return;
  let content:string;try{content=await readFile(this.sessionFile,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  for(const line of content.split('\n')){if(!line.trim())continue;let record:Data;try{record=JSON.parse(line);}catch{continue;}
   if(typeof record.id==='string'&&!this.seenEntries.has(record.id)){await this.bridge.trace(this.sessionId,record,`entry:${record.id}`,message(record.message??{}),key);this.seenEntries.add(record.id);}
  }
 }
 async handleEvent(event:Data){
  if(!this.sessionId||event.type==='message_start'||event.type==='message_update'||event.type==='tool_execution_update')return;
  const key=this.bridge.turns.get(this.sessionId);
  if(['message_end','tool_execution_start','tool_execution_end'].includes(event.type)){
   if(this.sessionFile)await this.replay(key);
   else if(event.type==='message_end'&&typeof event.message?.id==='string')await this.bridge.trace(this.sessionId,observed(event),`message:${event.message.id}`,message(event.message),key);
   else if(event.type!=='message_end'&&typeof event.toolCallId==='string')await this.bridge.trace(this.sessionId,observed(event),`tool:${event.toolCallId}:${event.type}`,executionMessage(event),key);
   return;
  }
  if(event.type==='agent_end'){await this.replay(key);await this.bridge.dispatch(this.sessionId,'turn-end',undefined,key);this.busy=false;}
  else await this.bridge.trace(this.sessionId,observed(event),undefined,undefined,key);
 }

}
/** Official --mode rpc JSONL wire protocol. No JSON-RPC 2.0 envelope. */
export class PrimeStdio implements RPC {
 readonly child:ChildProcessWithoutNullStreams;
 readonly pending=new Map<string,{resolve:(data:Data)=>void;reject:(error:Error)=>void}>();
 onEvent:(event:Data)=>Promise<void>=async()=>{};
 onError:(error:Error)=>void=error=>process.stderr.write(`${error.message}\n`);
 private queue=Promise.resolve();
 constructor(cwd:string,command='prime-agent',args:string[]=['--mode','rpc']) {
  this.child=spawn(command,args,{cwd,stdio:'pipe'});
  this.child.stderr.on('data',chunk=>process.stderr.write(chunk));
  const lines=createInterface({input:this.child.stdout});
  lines.on('line',line=>{let event:Data;try{event=JSON.parse(line);}catch{return;}
   if(event.type==='response'&&typeof event.id==='string') {const call=this.pending.get(event.id);if(call){this.pending.delete(event.id);event.success?call.resolve(event.data??{}):call.reject(new Error(event.error??'Prime request failed'));}return;}
   this.queue=this.queue.then(()=>this.onEvent(event)).catch(error=>this.onError(error));
  });
  const reject=(error:Error)=>{for(const call of this.pending.values())call.reject(error);this.pending.clear();};
  this.child.on('error',reject);this.child.on('exit',()=>reject(new Error('Prime RPC exited')));
 }
 request(type:string,payload:Data={}) {const id=randomUUID();return new Promise<Data>((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.child.stdin.write(`${JSON.stringify({id,type,...payload})}\n`);});}
 async close(){const closed=this.child.exitCode!==null||this.child.signalCode!==null?Promise.resolve():once(this.child,'close');this.child.stdin.end();await closed;await this.queue;}
}
