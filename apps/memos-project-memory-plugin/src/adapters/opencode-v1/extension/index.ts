import { observed } from '../../_shared/transcript.ts';
import { Bridge, message, type Data, type Send } from './bridge.ts';
interface Input { directory:string; client?: { session:{messages(input:Data):Promise<{data?:Data[]}>} } }
export async function createHooks(input: Input, send?: Send, agent='opencode-v1') {
 const bridge=new Bridge(agent,input.directory,send);
 async function replay(sessionID:string,key=bridge.turns.get(sessionID)) {
  if(!await bridge.active(sessionID))return;
  const result=await input.client?.session.messages({path:{id:sessionID}});
  for(const record of result?.data??[]) {
   if(record.info?.id) await bridge.trace(sessionID,record,`message:${record.info.id}`,message({...record.info,content:record.parts}),key);
  }
 }
 return {
  async 'chat.message'(event:{sessionID:string;messageID?:string},output:{message:Data;parts:Data[]}) {
   const id=output.message.id??event.messageID;
   if(typeof id!=='string') throw new Error('OpenCode user message ID missing');
   await bridge.turn(event.sessionID,id,[{sourceId:`message:${id}`,raw:observed(output),message:message({...output.message,content:output.parts})}]);
  },
  async 'experimental.chat.system.transform'(event:{sessionID?:string},output:{system:string[]}) {
   if(event.sessionID&&await bridge.active(event.sessionID)) { const context=bridge.context(event.sessionID); if(context&&!output.system.includes(context))output.system.push(context); }
  },
  async 'tool.execute.after'(event:{sessionID:string;callID:string;tool:string;args:unknown},output:Data) {
   await bridge.trace(event.sessionID,observed({event,output}),`tool:${event.callID}`,{role:'tool',content:output.output??'',tool_call_id:event.callID,name:event.tool,tool_input:event.args});
  },
  async event({event}:{event:Data}) {
   const p=event.properties??{};const sid=p.sessionID??p.info?.sessionID??p.part?.sessionID??(event.type?.startsWith('session.')?p.info?.id:undefined);
   if(!sid)return;
   const key=bridge.turns.get(sid);
   if(event.type==='session.created')await bridge.start(sid);
   await bridge.trace(sid,observed(event));
   if(event.type==='session.idle'||(event.type==='session.status'&&p.status?.type==='idle')){await replay(sid,key);await bridge.dispatch(sid,'turn-end',undefined,key);}
   if(event.type==='session.deleted')await bridge.dispatch(sid,'session-end');
  },
 };
}
export default async function plugin(input:Input) { return createHooks(input); }
