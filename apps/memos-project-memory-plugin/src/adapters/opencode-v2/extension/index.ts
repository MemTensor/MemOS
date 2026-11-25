import { observed } from '../../_shared/transcript.ts';
import type { Data, Send } from '../../opencode-v1/extension/bridge.ts';
import { captureBridge, captureRecords } from '../../opencode-v1/extension/capture.ts';
interface Registration {dispose():Promise<void>}
interface Context {
 location:{directory:string};
 session:{hook(name:string,callback:(input:Data)=>Promise<void>|void):Promise<Registration>};
 event:{subscribe(options:{signal:AbortSignal}):AsyncIterable<Data>};
}
/** Plugin.define is an identity function at the pinned v2 commit; structural export avoids runtime SDK dependency. */
export function createPlugin(send?:Send){return {id:'memos-project-memory',async setup(ctx:Context){
 const {bridge,parents}=captureBridge('opencode-v2',ctx.location.directory,send);const controller=new AbortController();
 const messages=new Map<string,Map<string,{info:Data;parts:string|Data[];key:string}>>();
 const prompt=await ctx.session.hook('prompt',async input=>{
  await bridge.turn(input.sessionID,input.messageID,captureRecords(observed({id:input.messageID,role:'user'}),input.prompt,input.messageID));
 });
 const context=await ctx.session.hook('context',async input=>{
  const active=await bridge.active(input.sessionID);
  const text=active?bridge.context(input.sessionID):bridge.creationContext(input.sessionID);if(text){if(!input.system.some((part:Data)=>part.type==='text'&&part.text===text))input.system.push({type:'text',text});if(active)await bridge.delivered(input.sessionID);}
 });
 const stream=(async()=>{for await(const event of ctx.event.subscribe({signal:controller.signal})){
  const data=event.data??{};const sid=data.sessionID??data.session?.id??(event.durable?.aggregateID?.startsWith('ses_')?event.durable.aggregateID:undefined);
  if(!sid)continue;
  if(typeof data.session?.parentID==='string')parents.set(sid,data.session.parentID);
  const key=bridge.turns.get(sid);
  if(key&&data.message){
   const info=data.message;const id=info.id??event.id;
   if(id&&(info.role==='user'?id===key:!info.parentID||info.parentID===key)){
    const pending=messages.get(sid)??new Map();
    pending.set(id,{info:observed({...info,id,...(event.timestamp!==undefined?{timestamp:event.timestamp}:{})}),parts:info.content??info.parts??'',key});messages.set(sid,pending);
   }
  }
  const terminal=['session.execution.succeeded','session.execution.failed','session.execution.interrupted'].includes(event.type);
  if(terminal){
   for(const snapshot of messages.get(sid)?.values()??[])
    for(const row of captureRecords(snapshot.info,snapshot.parts,snapshot.key))await bridge.trace(sid,row.raw,row.sourceId,row.message,snapshot.key);
   messages.delete(sid);
   if(key&&!(event.type==='session.execution.interrupted'&&data.reason==='shutdown'))await bridge.dispatch(sid,'turn-end',undefined,key);
  }
  if(event.type==='session.deleted'){await bridge.dispatch(sid,'session-end');messages.delete(sid);parents.delete(sid);}
 }})();
 // The async iterator is managed by this plugin's cleanup, never an unowned subscription.
 stream.catch(error=>{if(!controller.signal.aborted)process.stderr.write(`MemOS OpenCode v2 events: ${String(error)}\n`);});
 return async()=>{controller.abort();await Promise.all([prompt.dispose(),context.dispose()]);await stream.catch(()=>{});};
 }};}
export default createPlugin();
