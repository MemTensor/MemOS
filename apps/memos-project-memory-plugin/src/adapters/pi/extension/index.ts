import { randomUUID } from 'node:crypto';
import { Bridge, message, type Data, type Send } from '../../opencode-v1/extension/bridge.ts';
interface Context {cwd:string;sessionManager:{getSessionId():string;getEntries():Data[]}}
interface API {on(name:string,callback:(event:Data,ctx:Context)=>Promise<unknown>):void}
export default function extension(pi:API, send?:Send) {
 const bridges=new Map<string,Bridge>(); const inputs=new Map<string,string>(); const seen=new Map<string,Set<string>>();
 const get=(ctx:Context)=>{const id=ctx.sessionManager.getSessionId();let b=bridges.get(id);if(!b){b=new Bridge('pi',ctx.cwd,send);bridges.set(id,b);}return b;};
 const replay=async(ctx:Context,key=get(ctx).turns.get(ctx.sessionManager.getSessionId()))=>{
  const b=get(ctx),sid=ctx.sessionManager.getSessionId(),ids=seen.get(sid)??new Set<string>();seen.set(sid,ids);
  if(!await b.active(sid))return;
  for(const entry of ctx.sessionManager.getEntries())if(entry.id&&!ids.has(entry.id)){
   await b.trace(sid,entry,`entry:${entry.id}`,message(entry.message??{}),key);ids.add(entry.id);
  }
 };
 pi.on('session_start',async(_event,ctx)=>{await get(ctx).start(ctx.sessionManager.getSessionId());});
 pi.on('input',async(event,ctx)=>{if(event.source!=='extension')inputs.set(ctx.sessionManager.getSessionId(),randomUUID());return {action:'continue'};});
 pi.on('before_agent_start',async(event,ctx)=>{
  const sid=ctx.sessionManager.getSessionId();const b=get(ctx);const key=inputs.get(sid);
  if(!key)return;
  inputs.delete(sid);
  await b.turn(sid,key);
  const content=b.historyContext(sid);if(!content)return;await b.delivered(sid);
  return {message:{customType:'memos-project-memory',content,display:false}};
 });
 // message_end precedes SessionManager persistence. Replay existing durable rows now;
 // agent_settled catches the final persisted row. Never store streaming snapshots twice.
 for(const name of ['message_end','tool_execution_start','tool_execution_end']) {
  pi.on(name,async(_event,ctx)=>{await replay(ctx);});
 }
 pi.on('agent_settled',async(_event,ctx)=>{
  const b=get(ctx),sid=ctx.sessionManager.getSessionId(),key=b.turns.get(sid);
  await replay(ctx,key);
  await b.dispatch(sid,'turn-end',undefined,key);
 });
 pi.on('session_shutdown',async(_event,ctx)=>{await get(ctx).dispatch(ctx.sessionManager.getSessionId(),'session-end');});
}
