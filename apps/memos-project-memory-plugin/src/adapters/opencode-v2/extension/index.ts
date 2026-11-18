import { Bridge, message, type Data, type Send } from '../../opencode-v1/extension/bridge.ts';
interface Registration {dispose():Promise<void>}
interface Context {
 location:{directory:string};
 session:{hook(name:string,callback:(input:Data)=>Promise<void>|void):Promise<Registration>};
 event:{subscribe(options:{signal:AbortSignal}):AsyncIterable<Data>};
}
/** Plugin.define is an identity function at the pinned v2 commit; structural export avoids runtime SDK dependency. */
export function createPlugin(send?:Send){return {id:'memos-project-memory',async setup(ctx:Context){
 const bridge=new Bridge('opencode-v2',ctx.location.directory,send);const controller=new AbortController();
 const prompt=await ctx.session.hook('prompt',async input=>{
  await bridge.turn(input.sessionID,input.messageID,[{sourceId:`message:${input.messageID}`,raw:input,message:{role:'user',content:input.prompt}}]);
 });
 const context=await ctx.session.hook('context',input=>{
  const text=bridge.context(input.sessionID);if(text)input.system.push({type:'text',text});
 });
 const stream=(async()=>{for await(const event of ctx.event.subscribe({signal:controller.signal})){
  const data=event.data??{};const sid=data.sessionID??data.session?.id??(event.durable?.aggregateID?.startsWith('ses_')?event.durable.aggregateID:undefined);
  if(!sid)continue;
  const key=bridge.turns.get(sid);
  await bridge.trace(sid,event,event.id,message(data.message??{}),key);
  const terminal=['session.execution.succeeded','session.execution.failed','session.execution.interrupted'].includes(event.type);
  if(terminal&&!(event.type==='session.execution.interrupted'&&data.reason==='shutdown'))await bridge.dispatch(sid,'turn-end',undefined,key);
  if(event.type==='session.deleted')await bridge.dispatch(sid,'session-end');
 }})();
 // The async iterator is managed by this plugin's cleanup, never an unowned subscription.
 stream.catch(error=>{if(!controller.signal.aborted)process.stderr.write(`MemOS OpenCode v2 events: ${String(error)}\n`);});
 return async()=>{controller.abort();await Promise.all([prompt.dispose(),context.dispose()]);await stream.catch(()=>{});};
 }};}
export default createPlugin();
